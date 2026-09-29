use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
};

use serde_json::Value;
use taffy::prelude::*;
use thiserror::Error;

use crate::{
    accessibility::{AccessibilityBounds, AccessibilityNode, AccessibilityTree},
    input::{
        ButtonState, InputEvent, InputOutcome, InputState, KeyState, LogicalKey, PointerButton,
    },
    ir::{
        AccessibilityRole, MotionExecutionPlan, MotionProperty, TransitionEdge, TransitionEffect,
        UiAction, UiAlignment, UiBinaryOperator, UiExpression, UiNode, UiProgram, UiTransition,
    },
    layout::{FallbackIntrinsicMeasurer, IntrinsicMeasurer, IntrinsicSize},
    motion::{MotionChannelKey, MotionScheduler},
    retained::{
        RetainedIdentityKey, RetainedNodeKind, RetainedNodeSpec, RetainedReconciliation,
        RetainedTree,
    },
    scene::{ActionHit, Color, Rect as SceneBounds, Scene, SceneRect, SceneText},
};

pub const SEMANTIC_UI_IR_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum RuntimeLoadError {
    #[error("invalid Mün Semantic UI IR: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("unsupported Mün Semantic UI IR version {found}; runtime supports version {supported}")]
    UnsupportedVersion { found: u32, supported: u32 },
    #[error("unsupported Mün Semantic UI IR source language '{found}'; expected 'mun'")]
    UnsupportedSourceLanguage { found: String },
    #[error("duplicate Mün semantic node identity '{id}'")]
    DuplicateNodeIdentity { id: String },
}

#[derive(Clone, Debug)]
pub struct StateMutation {
    pub state: String,
    pub old: Value,
    pub new: Value,
}

#[derive(Clone, Debug, Default)]
pub struct Transaction {
    pub revision: u64,
    pub mutations: Vec<StateMutation>,
    pub animation: Option<MotionExecutionPlan>,
    pub disables_animations: bool,
    pub is_continuous: bool,
}

#[derive(Clone, Debug)]
pub struct RuntimeFrame {
    pub scene: Scene,
    pub accessibility: AccessibilityTree,
}

#[derive(Clone, Debug)]
struct EnterPresence {
    effects: Vec<TransitionEffect>,
    progress: MotionChannelKey,
}

#[derive(Clone, Debug)]
struct ExitPresence {
    scene: Scene,
    root_bounds: AccessibilityBounds,
    effects: Vec<TransitionEffect>,
    progress: MotionChannelKey,
}

#[derive(Clone, Debug)]
struct ActiveTransition {
    transition: UiTransition,
    descendants: HashSet<String>,
}

#[derive(Clone, Debug)]
struct LayoutFlip {
    descendants: HashSet<String>,
    progress: MotionChannelKey,
    delta_x: f32,
    delta_y: f32,
}

type LayoutTree = TaffyTree<IntrinsicSize>;

#[derive(Clone, Copy, Debug)]
struct PresenceValues {
    opacity: f32,
    scale: f32,
    translation_x: f32,
    translation_y: f32,
}

impl Default for PresenceValues {
    fn default() -> Self {
        Self {
            opacity: 1.0,
            scale: 1.0,
            translation_x: 0.0,
            translation_y: 0.0,
        }
    }
}

fn scalar_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        other => other.to_string(),
    }
}

fn numeric_result(value: f64) -> Value {
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn ordered_comparison(
    left: &Value,
    right: &Value,
    number: impl FnOnce(f64, f64) -> bool,
    string: impl FnOnce(&str, &str) -> bool,
) -> Value {
    if let (Some(left), Some(right)) = (left.as_f64(), right.as_f64()) {
        return Value::Bool(number(left, right));
    }
    if let (Some(left), Some(right)) = (left.as_str(), right.as_str()) {
        return Value::Bool(string(left, right));
    }
    Value::Bool(false)
}

fn evaluate_binary(operator: UiBinaryOperator, left: Value, right: Value) -> Value {
    match operator {
        UiBinaryOperator::Add => {
            if let (Some(left), Some(right)) = (left.as_f64(), right.as_f64()) {
                numeric_result(left + right)
            } else if let (Some(left), Some(right)) = (left.as_str(), right.as_str()) {
                Value::String(format!("{left}{right}"))
            } else {
                Value::Null
            }
        }
        UiBinaryOperator::Subtract => left
            .as_f64()
            .zip(right.as_f64())
            .map(|(left, right)| numeric_result(left - right))
            .unwrap_or(Value::Null),
        UiBinaryOperator::Multiply => left
            .as_f64()
            .zip(right.as_f64())
            .map(|(left, right)| numeric_result(left * right))
            .unwrap_or(Value::Null),
        UiBinaryOperator::Divide => left
            .as_f64()
            .zip(right.as_f64())
            .map(|(left, right)| numeric_result(left / right))
            .unwrap_or(Value::Null),
        UiBinaryOperator::Modulo => left
            .as_f64()
            .zip(right.as_f64())
            .map(|(left, right)| numeric_result(left % right))
            .unwrap_or(Value::Null),
        UiBinaryOperator::Equal => Value::Bool(left == right),
        UiBinaryOperator::NotEqual => Value::Bool(left != right),
        UiBinaryOperator::Less => ordered_comparison(&left, &right, |a, b| a < b, |a, b| a < b),
        UiBinaryOperator::LessOrEqual => {
            ordered_comparison(&left, &right, |a, b| a <= b, |a, b| a <= b)
        }
        UiBinaryOperator::Greater => ordered_comparison(&left, &right, |a, b| a > b, |a, b| a > b),
        UiBinaryOperator::GreaterOrEqual => {
            ordered_comparison(&left, &right, |a, b| a >= b, |a, b| a >= b)
        }
        UiBinaryOperator::And => {
            Value::Bool(left.as_bool().unwrap_or(false) && right.as_bool().unwrap_or(false))
        }
        UiBinaryOperator::Or => {
            Value::Bool(left.as_bool().unwrap_or(false) || right.as_bool().unwrap_or(false))
        }
    }
}
pub struct Runtime {
    pub program: UiProgram,
    state: HashMap<String, Value>,
    motion: MotionScheduler,
    revision: u64,
    focused_action: Option<String>,
    input: InputState,
    entering: HashMap<String, EnterPresence>,
    exiting: HashMap<String, ExitPresence>,
    layout_flips: HashMap<String, LayoutFlip>,
    retained: RetainedTree,
    last_reconciliation: RetainedReconciliation,
    last_live_scene: RefCell<Option<Scene>>,
    last_live_accessibility: RefCell<Option<AccessibilityTree>>,
}

impl Runtime {
    pub fn from_json(source: &str) -> Result<Self, RuntimeLoadError> {
        let program: UiProgram = serde_json::from_str(source)?;
        if program.version != SEMANTIC_UI_IR_VERSION {
            return Err(RuntimeLoadError::UnsupportedVersion {
                found: program.version,
                supported: SEMANTIC_UI_IR_VERSION,
            });
        }
        if program.source_language != "mun" {
            return Err(RuntimeLoadError::UnsupportedSourceLanguage {
                found: program.source_language,
            });
        }
        validate_native_transitions(&program.root.child)?;
        validate_node_identities(&program)?;
        let state = program
            .states
            .iter()
            .map(|item| (item.name.clone(), item.initial.clone()))
            .collect();
        let mut runtime = Self {
            program,
            state,
            motion: MotionScheduler::default(),
            revision: 0,
            focused_action: None,
            input: InputState::default(),
            entering: HashMap::new(),
            exiting: HashMap::new(),
            layout_flips: HashMap::new(),
            retained: RetainedTree::default(),
            last_reconciliation: RetainedReconciliation::default(),
            last_live_scene: RefCell::new(None),
            last_live_accessibility: RefCell::new(None),
        };
        runtime.reconcile_retained_tree();
        Ok(runtime)
    }

    pub fn title(&self) -> &str {
        &self.program.root.title
    }

    pub fn retained_tree(&self) -> &RetainedTree {
        &self.retained
    }

    pub fn last_reconciliation(&self) -> &RetainedReconciliation {
        &self.last_reconciliation
    }

    pub fn initial_window_size(&self) -> (f32, f32) {
        let width = self
            .program
            .root
            .layout
            .as_ref()
            .and_then(|layout| layout.width.as_ref())
            .and_then(|value| self.eval_number(value))
            .unwrap_or(640.0);
        let height = self
            .program
            .root
            .layout
            .as_ref()
            .and_then(|layout| layout.height.as_ref())
            .and_then(|value| self.eval_number(value))
            .unwrap_or(420.0);
        (width, height)
    }

    pub fn step(&mut self, dt_seconds: f32) -> bool {
        self.motion.step(dt_seconds);
        self.entering
            .retain(|_, presence| self.motion.is_key_active(&presence.progress));
        self.exiting
            .retain(|_, presence| self.motion.is_key_active(&presence.progress));
        self.layout_flips
            .retain(|_, flip| self.motion.is_key_active(&flip.progress));
        self.has_active_motion()
    }

    pub fn has_active_motion(&self) -> bool {
        self.motion.is_active()
            || !self.entering.is_empty()
            || !self.exiting.is_empty()
            || !self.layout_flips.is_empty()
    }

    pub fn handle_input(
        &mut self,
        event: InputEvent,
        width: f32,
        height: f32,
    ) -> Result<InputOutcome, taffy::TaffyError> {
        let focus_before = self.focused_action.clone();
        let mut outcome = InputOutcome::default();

        match event {
            InputEvent::PointerMoved { pointer, position } => {
                self.input.set_pointer_position(pointer, position);
            }
            InputEvent::PointerButton {
                pointer,
                button: PointerButton::Primary,
                state: ButtonState::Pressed,
            } => {
                if self.input.primary_capture(pointer).is_some() {
                    // Pointer capture is established by the first primary press and
                    // remains stable until release/cancel. Duplicate platform press
                    // events must not retarget focus or pressed identity.
                    outcome.handled = true;
                } else {
                    let Some(position) = self.input.pointer_position(pointer) else {
                        return Ok(outcome);
                    };
                    let scene = self.build_scene(width, height)?;
                    let target = scene.action_at(position.x, position.y).map(str::to_owned);
                    if let Some(id) = target {
                        if self.focus_action(&id) {
                            outcome.handled = true;
                            outcome.pressed_changed = self.input.capture_primary(pointer, id);
                        }
                    } else if self.focused_action.is_some() {
                        self.clear_focus();
                        outcome.handled = true;
                    }
                }
            }
            InputEvent::PointerButton {
                pointer,
                button: PointerButton::Primary,
                state: ButtonState::Released,
            } => {
                let Some(captured) = self.input.take_primary_capture(pointer) else {
                    return Ok(outcome);
                };
                outcome.handled = true;
                outcome.pressed_changed = true;

                if let Some(position) = self.input.pointer_position(pointer) {
                    let scene = self.build_scene(width, height)?;
                    let released_over_capture =
                        scene.action_at(position.x, position.y) == Some(captured.as_str());
                    if released_over_capture && self.focus_action(&captured) {
                        outcome.activated = self.activate_action(&captured).is_some();
                    }
                }
            }
            InputEvent::PointerButton { .. } => {}
            InputEvent::ModifiersChanged(modifiers) => {
                self.input.set_modifiers(modifiers);
            }
            InputEvent::Key {
                logical,
                state: KeyState::Pressed,
                repeat,
                ..
            } => match logical {
                LogicalKey::Tab => {
                    outcome.handled = self
                        .focus_next_action(self.input.modifiers().shift)
                        .is_some();
                }
                LogicalKey::Enter if !repeat => {
                    if self.focused_action().is_none() {
                        self.focus_next_action(false);
                    }
                    outcome.activated = self.activate_focused().is_some();
                    outcome.handled = outcome.activated || self.focused_action().is_some();
                }
                LogicalKey::Space if !repeat => {
                    if self.focused_action().is_none() {
                        self.focus_next_action(false);
                    }
                    if let Some(id) = self.focused_action().map(str::to_owned) {
                        outcome.handled = true;
                        outcome.pressed_changed = self.input.capture_keyboard(id);
                    }
                }
                LogicalKey::Space => {
                    outcome.handled = self.input.keyboard_capture().is_some();
                }
                LogicalKey::Escape => {
                    outcome.pressed_changed = self.input.clear_keyboard_capture();
                    outcome.handled = self.focused_action().is_some() || outcome.pressed_changed;
                    self.clear_focus();
                }
                _ => {}
            },
            InputEvent::Key {
                logical: LogicalKey::Space,
                state: KeyState::Released,
                ..
            } => {
                let Some(captured) = self.input.take_keyboard_capture() else {
                    return Ok(outcome);
                };
                outcome.handled = true;
                outcome.pressed_changed = true;
                if self.focused_action() == Some(captured.as_str()) && self.focus_action(&captured)
                {
                    outcome.activated = self.activate_action(&captured).is_some();
                }
            }
            InputEvent::Key { .. } | InputEvent::TextInput { .. } | InputEvent::Scroll { .. } => {}
            InputEvent::Cancel { pointer } => {
                outcome.pressed_changed = self.input.cancel_pointer(pointer);
                outcome.handled = outcome.pressed_changed;
            }
            InputEvent::WindowFocusChanged(false) => {
                let pointer_changed = self.input.cancel_pointer(None);
                let keyboard_changed = self.input.clear_keyboard_capture();
                outcome.pressed_changed = pointer_changed || keyboard_changed;
                outcome.handled = outcome.pressed_changed;
            }
            InputEvent::WindowFocusChanged(true) => {}
        }

        outcome.focus_changed = self.focused_action != focus_before;
        outcome.needs_redraw = outcome.focus_changed
            || outcome.pressed_changed
            || outcome.activated
            || (outcome.handled && focus_before.is_some());
        Ok(outcome)
    }

    pub fn focused_action(&self) -> Option<&str> {
        self.focused_action.as_deref()
    }

    pub fn primary_pressed_action(&self, pointer: crate::input::PointerId) -> Option<&str> {
        self.input.primary_capture(pointer)
    }

    pub fn keyboard_pressed_action(&self) -> Option<&str> {
        self.input.keyboard_capture()
    }

    pub fn clear_focus(&mut self) {
        self.focused_action = None;
        self.input.clear_keyboard_capture();
    }

    fn reconcile_pointer_captures(&mut self) {
        let mut actions = Vec::new();
        collect_focusable_actions(&self.program.root.child, self, &mut actions);
        let valid_actions = actions.into_iter().collect::<HashSet<_>>();
        self.input.retain_primary_captures(&valid_actions);
    }

    fn reset_replaced_runtime_state(&mut self) -> HashSet<String> {
        let replaced = self
            .last_reconciliation
            .replaced
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        if replaced.is_empty() {
            return replaced;
        }

        let mut motion_nodes = replaced.clone();
        for id in &replaced {
            if let Some(presence) = self.entering.remove(id) {
                motion_nodes.insert(presence.progress.node_id);
            }
            if let Some(presence) = self.exiting.remove(id) {
                motion_nodes.insert(presence.progress.node_id);
            }
            if let Some(flip) = self.layout_flips.remove(id) {
                motion_nodes.insert(flip.progress.node_id);
            }
        }
        self.motion
            .remove_nodes(motion_nodes.iter().map(String::as_str));
        self.input.remove_captures_for_actions(&replaced);
        if self
            .focused_action
            .as_ref()
            .is_some_and(|action| replaced.contains(action))
        {
            self.focused_action = None;
            self.input.clear_keyboard_capture();
        }

        replaced
    }

    fn reconcile_focus(&mut self, previous_order: &[String]) {
        let Some(focused) = self.focused_action.clone() else {
            return;
        };

        let mut actions = Vec::new();
        collect_focusable_actions(&self.program.root.child, self, &mut actions);
        if actions.iter().any(|id| id == &focused) {
            return;
        }

        if actions.is_empty() {
            self.focused_action = None;
            self.input.clear_keyboard_capture();
            return;
        }

        // If the focused semantic identity disappears or becomes disabled, preserve
        // its traversal position: prefer the action that moved into the same slot,
        // otherwise fall back to the preceding final slot. If the prior identity was
        // already stale, clear focus instead of guessing.
        self.focused_action = previous_order
            .iter()
            .position(|id| id == &focused)
            .and_then(|index| actions.get(index.min(actions.len() - 1)))
            .cloned();
        self.input.clear_keyboard_capture();
    }

    pub fn focus_action(&mut self, id: &str) -> bool {
        let Some((_, base)) = find_action(&self.program.root.child, self, id) else {
            return false;
        };
        if !self.node_enabled(base) {
            return false;
        }
        if self.focused_action.as_deref() != Some(id) {
            self.input.clear_keyboard_capture();
        }
        self.focused_action = Some(id.to_owned());
        true
    }

    pub fn focus_next_action(&mut self, backwards: bool) -> Option<String> {
        let mut actions = Vec::new();
        collect_focusable_actions(&self.program.root.child, self, &mut actions);
        if actions.is_empty() {
            self.focused_action = None;
            self.input.clear_keyboard_capture();
            return None;
        }

        let index = self
            .focused_action
            .as_ref()
            .and_then(|focused| actions.iter().position(|id| id == focused));
        let next = if backwards {
            match index {
                Some(0) | None => actions.len() - 1,
                Some(index) => index - 1,
            }
        } else {
            match index {
                Some(index) => (index + 1) % actions.len(),
                None => 0,
            }
        };
        let id = actions[next].clone();
        if self.focused_action.as_deref() != Some(id.as_str()) {
            self.input.clear_keyboard_capture();
        }
        self.focused_action = Some(id.clone());
        Some(id)
    }

    pub fn activate_focused(&mut self) -> Option<Transaction> {
        let id = self.focused_action.clone()?;
        self.activate_action(&id)
    }

    pub fn activate_action(&mut self, id: &str) -> Option<Transaction> {
        let (action, base) = find_action(&self.program.root.child, self, id)?;
        if !self.node_enabled(base) {
            return None;
        }
        let action = action.clone();
        let action_transaction = action.transaction().cloned().unwrap_or_default();
        let mut focus_order_before = Vec::new();
        collect_focusable_actions(&self.program.root.child, self, &mut focus_order_before);
        let before_presence = self.active_transition_roots();
        let before_layout_neighborhoods = self.layout_neighborhoods();
        let before_layout_geometry = self.last_live_accessibility.borrow().clone();
        let before = self.motion_targets();
        let mut transaction = Transaction {
            revision: self.revision + 1,
            mutations: Vec::new(),
            animation: action_transaction.animation,
            disables_animations: action_transaction.disables_animations,
            is_continuous: action_transaction.is_continuous,
        };

        match action {
            UiAction::ToggleState { state, .. } => {
                let old = self
                    .state
                    .get(&state)
                    .cloned()
                    .unwrap_or(Value::Bool(false));
                let new = Value::Bool(!old.as_bool().unwrap_or(false));
                self.state.insert(state.clone(), new.clone());
                transaction
                    .mutations
                    .push(StateMutation { state, old, new });
            }
            UiAction::SetState { state, value, .. } => {
                let old = self.state.get(&state).cloned().unwrap_or(Value::Null);
                let new = self.eval(&value);
                self.state.insert(state.clone(), new.clone());
                transaction
                    .mutations
                    .push(StateMutation { state, old, new });
            }
        }

        self.reconcile_retained_tree();
        let replaced_nodes = self.reset_replaced_runtime_state();

        // State mutations can remove or disable the focused semantic node.
        // Reconcile by stable identity first, then by deterministic traversal position.
        self.reconcile_focus(&focus_order_before);
        self.reconcile_pointer_captures();

        self.revision = transaction.revision;
        let after = self.motion_targets();
        for (key, next) in after {
            if replaced_nodes.contains(&key.node_id) {
                continue;
            }
            let Some(previous) = before.get(&key) else {
                // Re-entering conditional content must not revive an old presentation
                // value from a motion channel that outlived the inactive branch.
                // New nodes have no channel, so snap remains a no-op for them.
                self.motion.snap(&key, next.target);
                continue;
            };
            if (next.target - previous.target).abs() <= f32::EPSILON {
                continue;
            }
            if transaction.disables_animations {
                self.motion.snap(&key, next.target);
                continue;
            }

            let selected_plan = if let Some(local_plan) = next.plan.as_ref() {
                let trigger_changed = match (&previous.trigger, &next.trigger) {
                    (Some(previous), Some(next)) => previous != next,
                    (None, None) => true,
                    _ => true,
                };
                if !trigger_changed {
                    self.motion.snap(&key, next.target);
                    continue;
                }
                Some(local_plan)
            } else {
                transaction.animation.as_ref()
            };

            let Some(plan) = selected_plan else {
                self.motion.snap(&key, next.target);
                continue;
            };
            let current = self.motion.value(&key).unwrap_or(previous.target);
            self.motion.retarget(key, current, next.target, plan);
        }

        let after_presence = self.active_transition_roots();
        self.reconcile_presence(before_presence, after_presence, &transaction);
        let after_layout_neighborhoods = self.layout_neighborhoods();
        self.reconcile_layout_flips(
            before_layout_neighborhoods,
            after_layout_neighborhoods,
            before_layout_geometry.as_ref(),
            &replaced_nodes,
            &transaction,
        );

        Some(transaction)
    }

    pub fn build_frame(&self, width: f32, height: f32) -> Result<RuntimeFrame, taffy::TaffyError> {
        self.build_frame_with_measurer(width, height, &FallbackIntrinsicMeasurer)
    }

    pub fn build_frame_with_measurer(
        &self,
        width: f32,
        height: f32,
        measurer: &dyn IntrinsicMeasurer,
    ) -> Result<RuntimeFrame, taffy::TaffyError> {
        let (taffy, nodes) = self.build_layout_tree_with_measurer(width, height, measurer)?;
        let mut scene = Scene::default();
        self.collect_scene(
            &taffy,
            &self.program.root.child,
            &nodes,
            0.0,
            0.0,
            1.0,
            &mut scene,
        )?;
        let mut accessibility = self.accessibility_from_layout(&taffy, &nodes, width, height)?;
        self.apply_enter_presence(&mut scene, &mut accessibility);
        self.apply_layout_flips(&mut scene, &mut accessibility);
        *self.last_live_scene.borrow_mut() = Some(scene.clone());
        *self.last_live_accessibility.borrow_mut() = Some(accessibility.clone());
        self.append_exit_overlays(&mut scene);
        Ok(RuntimeFrame {
            scene,
            accessibility,
        })
    }

    pub fn build_scene(&self, width: f32, height: f32) -> Result<Scene, taffy::TaffyError> {
        self.build_frame(width, height).map(|frame| frame.scene)
    }

    pub fn build_scene_with_measurer(
        &self,
        width: f32,
        height: f32,
        measurer: &dyn IntrinsicMeasurer,
    ) -> Result<Scene, taffy::TaffyError> {
        self.build_frame_with_measurer(width, height, measurer)
            .map(|frame| frame.scene)
    }

    pub fn build_accessibility_tree(
        &self,
        width: f32,
        height: f32,
    ) -> Result<AccessibilityTree, taffy::TaffyError> {
        self.build_accessibility_tree_with_measurer(width, height, &FallbackIntrinsicMeasurer)
    }

    pub fn build_accessibility_tree_with_measurer(
        &self,
        width: f32,
        height: f32,
        measurer: &dyn IntrinsicMeasurer,
    ) -> Result<AccessibilityTree, taffy::TaffyError> {
        let (taffy, nodes) = self.build_layout_tree_with_measurer(width, height, measurer)?;
        let mut accessibility = self.accessibility_from_layout(&taffy, &nodes, width, height)?;
        let mut empty_scene = Scene::default();
        self.apply_enter_presence(&mut empty_scene, &mut accessibility);
        self.apply_layout_flips(&mut empty_scene, &mut accessibility);
        Ok(accessibility)
    }

    fn accessibility_from_layout(
        &self,
        taffy: &LayoutTree,
        nodes: &HashMap<String, NodeId>,
        width: f32,
        height: f32,
    ) -> Result<AccessibilityTree, taffy::TaffyError> {
        let root_semantics = self.program.root.accessibility.as_ref();
        let root_id = self.program.root.id.clone();
        let mut root_children = Vec::new();
        self.flatten_active_nodes(&self.program.root.child, &mut root_children);
        let root_child_ids = root_children
            .iter()
            .map(|node| node.base().id.clone())
            .collect::<Vec<_>>();
        let mut output = vec![AccessibilityNode {
            id: root_id.clone(),
            role: root_semantics
                .map(|semantics| semantics.role)
                .unwrap_or(AccessibilityRole::Window),
            label: root_semantics
                .and_then(|semantics| semantics.label.clone())
                .or_else(|| Some(self.program.root.title.clone())),
            enabled: root_semantics
                .and_then(|semantics| semantics.enabled.as_ref())
                .map(|value| self.eval_bool(value))
                .unwrap_or(true),
            focused: self.focused_action.is_none(),
            bounds: AccessibilityBounds {
                x: 0.0,
                y: 0.0,
                width,
                height,
            },
            children: root_child_ids,
            action_id: None,
        }];
        for child in root_children {
            self.collect_accessibility(taffy, child, nodes, 0.0, 0.0, &mut output)?;
        }
        let focus_id = self
            .focused_action
            .as_ref()
            .filter(|id| output.iter().any(|node| node.id == **id))
            .cloned();
        Ok(AccessibilityTree {
            root_id,
            focus_id,
            nodes: output,
        })
    }

    fn build_layout_tree(
        &self,
        width: f32,
        height: f32,
    ) -> Result<(LayoutTree, HashMap<String, NodeId>), taffy::TaffyError> {
        self.build_layout_tree_with_measurer(width, height, &FallbackIntrinsicMeasurer)
    }

    fn build_layout_tree_with_measurer(
        &self,
        width: f32,
        height: f32,
        measurer: &dyn IntrinsicMeasurer,
    ) -> Result<(LayoutTree, HashMap<String, NodeId>), taffy::TaffyError> {
        let mut taffy: LayoutTree = TaffyTree::new();
        let mut nodes = HashMap::new();
        let children =
            self.build_layout_nodes(&mut taffy, &self.program.root.child, &mut nodes, measurer)?;
        let wrapper = taffy.new_with_children(
            Style {
                size: Size {
                    width: Dimension::length(width),
                    height: Dimension::length(height),
                },
                ..Default::default()
            },
            &children,
        )?;
        taffy.compute_layout_with_measure(
            wrapper,
            Size {
                width: AvailableSpace::Definite(width),
                height: AvailableSpace::Definite(height),
            },
            |inputs, _, context, style| {
                let intrinsic = context.copied().unwrap_or_default();
                taffy::compute_leaf_layout(
                    inputs,
                    style,
                    |_, _| 0.0,
                    |known_dimensions, _| Size {
                        width: known_dimensions.width.unwrap_or(intrinsic.width),
                        height: known_dimensions.height.unwrap_or(intrinsic.height),
                    },
                )
            },
        )?;
        Ok((taffy, nodes))
    }

    fn eval(&self, expression: &UiExpression) -> Value {
        match expression {
            UiExpression::Literal { value } => value.clone(),
            UiExpression::State { state } => self.state.get(state).cloned().unwrap_or(Value::Null),
            UiExpression::Not { value } => {
                Value::Bool(!self.eval(value).as_bool().unwrap_or(false))
            }
            UiExpression::Stringify { value } => Value::String(scalar_string(&self.eval(value))),
            UiExpression::Binary {
                operator,
                left,
                right,
            } => evaluate_binary(*operator, self.eval(left), self.eval(right)),
            UiExpression::Conditional {
                condition,
                then_value,
                otherwise,
            } => {
                if self.eval(condition).as_bool().unwrap_or(false) {
                    self.eval(then_value)
                } else {
                    self.eval(otherwise)
                }
            }
        }
    }

    fn eval_number(&self, expression: &UiExpression) -> Option<f32> {
        self.eval(expression).as_f64().map(|value| value as f32)
    }

    fn eval_bool(&self, expression: &UiExpression) -> bool {
        self.eval(expression).as_bool().unwrap_or(false)
    }

    fn active_children<'a>(&self, node: &'a UiNode) -> &'a [UiNode] {
        match node {
            UiNode::Column { children, .. } | UiNode::Row { children, .. } => children,
            UiNode::Conditional {
                condition,
                then_nodes,
                otherwise,
                ..
            } => {
                if self.eval_bool(condition) {
                    then_nodes
                } else {
                    otherwise
                }
            }
            _ => &[],
        }
    }

    fn reconcile_retained_tree(&mut self) {
        let root_id = self.program.root.id.clone();
        let child_id = self.program.root.child.base().id.clone();
        let mut root_spec = RetainedNodeSpec::new(
            root_id.clone(),
            RetainedNodeKind::Window,
            None,
            vec![child_id],
        );
        root_spec.identity_key =
            self.retained_identity_key(self.program.root.identity_key.as_ref());
        let mut specs = vec![root_spec];
        self.collect_retained_specs(&self.program.root.child, Some(root_id), &mut specs);
        self.last_reconciliation = self
            .retained
            .reconcile(specs)
            .expect("validated semantic identities must reconcile");
    }

    fn collect_retained_specs(
        &self,
        node: &UiNode,
        parent: Option<String>,
        output: &mut Vec<RetainedNodeSpec>,
    ) {
        let kind = match node {
            UiNode::Column { .. } => RetainedNodeKind::Column,
            UiNode::Row { .. } => RetainedNodeKind::Row,
            UiNode::Conditional { .. } => RetainedNodeKind::Conditional,
            UiNode::Text { .. } => RetainedNodeKind::Text,
            UiNode::Panel { .. } => RetainedNodeKind::Panel,
            UiNode::Action { .. } => RetainedNodeKind::Action,
        };
        let active_children = self.active_children(node);
        let children = active_children
            .iter()
            .map(|child| child.base().id.clone())
            .collect();
        let base = node.base();
        let id = base.id.clone();
        let mut spec = RetainedNodeSpec::new(id.clone(), kind, parent, children);
        spec.identity_key = self.retained_identity_key(base.identity_key.as_ref());
        output.push(spec);
        for child in active_children {
            self.collect_retained_specs(child, Some(id.clone()), output);
        }
    }

    fn retained_identity_key(
        &self,
        expression: Option<&UiExpression>,
    ) -> Option<RetainedIdentityKey> {
        expression.map(|expression| {
            RetainedIdentityKey::from_value(&self.eval(expression))
                .expect("Mün semantic identity key must evaluate to a string or finite number")
        })
    }

    fn layout_neighborhoods(&self) -> HashMap<String, Vec<String>> {
        let mut output = HashMap::new();
        self.collect_layout_neighborhoods(&self.program.root.child, &mut output);
        output
    }

    fn collect_layout_neighborhoods(
        &self,
        node: &UiNode,
        output: &mut HashMap<String, Vec<String>>,
    ) {
        match node {
            UiNode::Column { base, children } | UiNode::Row { base, children } => {
                let mut rendered = Vec::new();
                for child in children {
                    self.collect_rendered_child_roots(child, &mut rendered);
                }
                output.insert(base.id.clone(), rendered);
                for child in self.active_children(node) {
                    self.collect_layout_neighborhoods(child, output);
                }
            }
            UiNode::Conditional { .. } => {
                for child in self.active_children(node) {
                    self.collect_layout_neighborhoods(child, output);
                }
            }
            _ => {}
        }
    }

    fn collect_rendered_child_roots(&self, node: &UiNode, output: &mut Vec<String>) {
        if matches!(node, UiNode::Conditional { .. }) {
            for child in self.active_children(node) {
                self.collect_rendered_child_roots(child, output);
            }
            return;
        }
        output.push(node.base().id.clone());
    }

    fn find_active_node_by_id<'a>(&'a self, node: &'a UiNode, id: &str) -> Option<&'a UiNode> {
        if !matches!(node, UiNode::Conditional { .. }) && node.base().id == id {
            return Some(node);
        }
        self.active_children(node)
            .iter()
            .find_map(|child| self.find_active_node_by_id(child, id))
    }

    fn reconcile_layout_flips(
        &mut self,
        before_neighborhoods: HashMap<String, Vec<String>>,
        after_neighborhoods: HashMap<String, Vec<String>>,
        before_geometry: Option<&AccessibilityTree>,
        replaced_nodes: &HashSet<String>,
        transaction: &Transaction,
    ) {
        let mut candidates = HashSet::new();
        for (parent, before_children) in &before_neighborhoods {
            let Some(after_children) = after_neighborhoods.get(parent) else {
                continue;
            };
            if before_children == after_children {
                continue;
            }
            let after_ids = after_children.iter().collect::<HashSet<_>>();
            for id in before_children {
                if after_ids.contains(id) {
                    candidates.insert(id.clone());
                }
            }
        }
        candidates.retain(|id| !replaced_nodes.contains(id));
        if candidates.is_empty() {
            return;
        }

        let Some(plan) = transaction
            .animation
            .as_ref()
            .filter(|_| !transaction.disables_animations)
        else {
            for id in candidates {
                if let Some(previous) = self.layout_flips.remove(&id) {
                    settle_layout_flip_progress(&mut self.motion, &previous.progress);
                }
            }
            return;
        };
        let Some(before_geometry) = before_geometry else {
            return;
        };
        let Some(root) = before_geometry.node(&before_geometry.root_id) else {
            return;
        };
        let Ok((taffy, nodes)) = self.build_layout_tree(root.bounds.width, root.bounds.height)
        else {
            return;
        };
        let Ok(after_geometry) =
            self.accessibility_from_layout(&taffy, &nodes, root.bounds.width, root.bounds.height)
        else {
            return;
        };

        for id in candidates {
            let Some(before_node) = before_geometry.node(&id) else {
                continue;
            };
            let Some(after_node) = after_geometry.node(&id) else {
                continue;
            };
            let before_center_x = before_node.bounds.x + before_node.bounds.width * 0.5;
            let before_center_y = before_node.bounds.y + before_node.bounds.height * 0.5;
            let after_center_x = after_node.bounds.x + after_node.bounds.width * 0.5;
            let after_center_y = after_node.bounds.y + after_node.bounds.height * 0.5;
            let delta_x = before_center_x - after_center_x;
            let delta_y = before_center_y - after_center_y;

            if delta_x.abs() < 0.01 && delta_y.abs() < 0.01 {
                if let Some(previous) = self.layout_flips.remove(&id) {
                    settle_layout_flip_progress(&mut self.motion, &previous.progress);
                }
                continue;
            }

            if let Some(previous) = self.layout_flips.remove(&id) {
                settle_layout_flip_progress(&mut self.motion, &previous.progress);
            }
            let Some(node) = self.find_active_node_by_id(&self.program.root.child, &id) else {
                continue;
            };
            let mut descendants = HashSet::new();
            self.collect_active_descendant_ids(node, &mut descendants);
            let progress = start_layout_flip_progress(&mut self.motion, &id, plan);
            self.layout_flips.insert(
                id,
                LayoutFlip {
                    descendants,
                    progress,
                    delta_x,
                    delta_y,
                },
            );
        }
    }

    fn apply_layout_flips(&self, scene: &mut Scene, accessibility: &mut AccessibilityTree) {
        let mut flips = self.layout_flips.iter().collect::<Vec<_>>();
        flips.sort_by(|(_, left), (_, right)| right.descendants.len().cmp(&left.descendants.len()));
        let mut covered = HashSet::new();

        for (id, flip) in flips {
            if covered.contains(id) {
                continue;
            }
            let progress = self.motion.value(&flip.progress).unwrap_or(1.0);
            let remaining = 1.0 - progress;
            let dx = flip.delta_x * remaining;
            let dy = flip.delta_y * remaining;
            if dx.abs() < 0.001 && dy.abs() < 0.001 {
                continue;
            }
            apply_scene_translation(scene, &flip.descendants, dx, dy);
            apply_accessibility_translation(accessibility, &flip.descendants, dx, dy);
            covered.extend(flip.descendants.iter().cloned());
        }
    }

    fn active_transition_roots(&self) -> HashMap<String, ActiveTransition> {
        let mut output = HashMap::new();
        self.collect_active_transition_roots(&self.program.root.child, &mut output);
        output
    }

    fn collect_active_transition_roots(
        &self,
        node: &UiNode,
        output: &mut HashMap<String, ActiveTransition>,
    ) {
        if matches!(node, UiNode::Conditional { .. }) {
            for child in self.active_children(node) {
                self.collect_active_transition_roots(child, output);
            }
            return;
        }

        if let Some(transition) = node.base().transition.as_ref() {
            let mut descendants = HashSet::new();
            self.collect_active_descendant_ids(node, &mut descendants);
            output.insert(
                node.base().id.clone(),
                ActiveTransition {
                    transition: transition.clone(),
                    descendants,
                },
            );
        }
        for child in self.active_children(node) {
            self.collect_active_transition_roots(child, output);
        }
    }

    fn collect_active_descendant_ids(&self, node: &UiNode, output: &mut HashSet<String>) {
        if matches!(node, UiNode::Conditional { .. }) {
            for child in self.active_children(node) {
                self.collect_active_descendant_ids(child, output);
            }
            return;
        }
        output.insert(node.base().id.clone());
        for child in self.active_children(node) {
            self.collect_active_descendant_ids(child, output);
        }
    }

    fn reconcile_presence(
        &mut self,
        before: HashMap<String, ActiveTransition>,
        after: HashMap<String, ActiveTransition>,
        transaction: &Transaction,
    ) {
        if transaction.disables_animations {
            for presence in self.entering.values() {
                settle_presence_progress(&mut self.motion, &presence.progress);
            }
            for presence in self.exiting.values() {
                settle_presence_progress(&mut self.motion, &presence.progress);
            }
            self.entering.clear();
            self.exiting.clear();
            return;
        }

        for (id, old) in &before {
            if after.contains_key(id) {
                continue;
            }
            let plan = old
                .transition
                .animation
                .as_ref()
                .or(transaction.animation.as_ref())
                .cloned()
                .unwrap_or_else(default_transition_plan);
            if old.transition.removal.is_empty() {
                continue;
            }
            let Some(snapshot) = self
                .last_live_scene
                .borrow()
                .as_ref()
                .map(|scene| snapshot_scene_subtree(scene, &old.descendants))
                .filter(|scene| !scene.rects.is_empty() || !scene.texts.is_empty())
            else {
                continue;
            };
            let root_bounds = {
                let cached = self.last_live_accessibility.borrow();
                cached
                    .as_ref()
                    .and_then(|tree| tree.node(id))
                    .map(|node| node.bounds)
            };
            let Some(root_bounds) = root_bounds else {
                continue;
            };
            if let Some(previous) = self.entering.remove(id) {
                settle_presence_progress(&mut self.motion, &previous.progress);
            }
            if let Some(previous) = self.exiting.remove(id) {
                settle_presence_progress(&mut self.motion, &previous.progress);
            }
            let progress = start_presence_progress(&mut self.motion, id, "exit", &plan, false);
            self.exiting.insert(
                id.clone(),
                ExitPresence {
                    scene: snapshot,
                    root_bounds,
                    effects: old.transition.removal.clone(),
                    progress,
                },
            );
        }

        for (id, new) in &after {
            if before.contains_key(id) {
                continue;
            }
            let plan = new
                .transition
                .animation
                .as_ref()
                .or(transaction.animation.as_ref())
                .cloned()
                .unwrap_or_else(default_transition_plan);
            if new.transition.insertion.is_empty() {
                continue;
            }
            if let Some(previous) = self.exiting.remove(id) {
                settle_presence_progress(&mut self.motion, &previous.progress);
            }
            if let Some(previous) = self.entering.remove(id) {
                settle_presence_progress(&mut self.motion, &previous.progress);
            }
            let progress = start_presence_progress(&mut self.motion, id, "enter", &plan, true);
            self.entering.insert(
                id.clone(),
                EnterPresence {
                    effects: new.transition.insertion.clone(),
                    progress,
                },
            );
        }
    }

    fn presence_values(
        &self,
        effects: &[TransitionEffect],
        progress: &MotionChannelKey,
    ) -> PresenceValues {
        let progress = self.motion.value(progress).unwrap_or(1.0);
        transition_presence_values(effects, progress)
    }

    fn apply_enter_presence(&self, scene: &mut Scene, accessibility: &mut AccessibilityTree) {
        let active = self.active_transition_roots();
        let mut ids = self
            .entering
            .keys()
            .filter(|id| active.contains_key(*id))
            .cloned()
            .collect::<Vec<_>>();
        ids.sort_by(|a, b| {
            active[b]
                .descendants
                .len()
                .cmp(&active[a].descendants.len())
        });

        for id in ids {
            let Some(presence) = self.entering.get(&id) else {
                continue;
            };
            let Some(transition) = active.get(&id) else {
                continue;
            };
            let Some(root_bounds) = accessibility.node(&id).map(|node| node.bounds) else {
                continue;
            };
            let values = self.presence_values(&presence.effects, &presence.progress);
            apply_scene_presence(scene, &transition.descendants, root_bounds, values);
            apply_accessibility_presence(
                accessibility,
                &transition.descendants,
                root_bounds,
                values,
            );
        }
    }

    fn append_exit_overlays(&self, scene: &mut Scene) {
        for presence in self.exiting.values() {
            let mut overlay = presence.scene.clone();
            let values = self.presence_values(&presence.effects, &presence.progress);
            apply_scene_presence_all(&mut overlay, presence.root_bounds, values);
            scene.rects.extend(overlay.rects);
            scene.texts.extend(overlay.texts);
        }
    }

    fn flatten_active_nodes<'a>(&self, node: &'a UiNode, output: &mut Vec<&'a UiNode>) {
        if matches!(node, UiNode::Conditional { .. }) {
            for child in self.active_children(node) {
                self.flatten_active_nodes(child, output);
            }
        } else {
            output.push(node);
        }
    }

    fn active_semantic_children<'a>(&self, node: &'a UiNode) -> Vec<&'a UiNode> {
        let mut output = Vec::new();
        for child in self.active_children(node) {
            self.flatten_active_nodes(child, &mut output);
        }
        output
    }

    fn node_enabled(&self, base: &crate::ir::NodeBase) -> bool {
        base.accessibility
            .as_ref()
            .and_then(|semantics| semantics.enabled.as_ref())
            .map(|enabled| self.eval_bool(enabled))
            .unwrap_or(true)
    }

    fn eval_text(&self, expression: &UiExpression) -> String {
        let value = self.eval(expression);
        match value {
            Value::String(value) => value,
            Value::Bool(value) => value.to_string(),
            Value::Number(value) => value.to_string(),
            Value::Null => String::new(),
            other => other.to_string(),
        }
    }

    fn presentation_number(
        &self,
        node: &UiNode,
        property: MotionProperty,
        expression: &UiExpression,
    ) -> Option<f32> {
        let key = MotionChannelKey {
            node_id: node.base().id.clone(),
            property,
        };
        self.motion
            .value(&key)
            .or_else(|| self.eval_number(expression))
    }

    fn motion_targets(&self) -> HashMap<MotionChannelKey, MotionTarget> {
        let mut output = HashMap::new();
        collect_motion_targets(&self.program.root.child, self, &mut output);
        output
    }

    fn build_layout_nodes(
        &self,
        taffy: &mut LayoutTree,
        node: &UiNode,
        nodes: &mut HashMap<String, NodeId>,
        measurer: &dyn IntrinsicMeasurer,
    ) -> Result<Vec<NodeId>, taffy::TaffyError> {
        if matches!(node, UiNode::Conditional { .. }) {
            let mut output = Vec::new();
            for child in self.active_children(node) {
                output.extend(self.build_layout_nodes(taffy, child, nodes, measurer)?);
            }
            return Ok(output);
        }

        let base = node.base();
        let layout = base.layout.as_ref();
        let width = layout
            .and_then(|layout| layout.width.as_ref())
            .and_then(|value| self.presentation_number(node, MotionProperty::Width, value));
        let height = layout
            .and_then(|layout| layout.height.as_ref())
            .and_then(|value| self.presentation_number(node, MotionProperty::Height, value));
        let padding = layout.and_then(|layout| layout.padding).unwrap_or(0.0);
        let spacing = layout.and_then(|layout| layout.spacing).unwrap_or(0.0);

        let mut style = Style {
            size: Size {
                width: width.map(Dimension::length).unwrap_or(Dimension::auto()),
                height: height.map(Dimension::length).unwrap_or(Dimension::auto()),
            },
            padding: Rect {
                left: LengthPercentage::length(padding),
                right: LengthPercentage::length(padding),
                top: LengthPercentage::length(padding),
                bottom: LengthPercentage::length(padding),
            },
            ..Default::default()
        };

        match node {
            UiNode::Column { .. } | UiNode::Row { .. } => {
                style.display = Display::Flex;
                style.flex_direction = if matches!(node, UiNode::Column { .. }) {
                    FlexDirection::Column
                } else {
                    FlexDirection::Row
                };
                style.gap = Size {
                    width: LengthPercentage::length(spacing),
                    height: LengthPercentage::length(spacing),
                };
                style.align_items = Some(match layout.and_then(|layout| layout.alignment) {
                    Some(UiAlignment::Center) => AlignItems::CENTER,
                    Some(UiAlignment::Trailing) => AlignItems::FLEX_END,
                    Some(UiAlignment::Stretch) => AlignItems::STRETCH,
                    _ => AlignItems::FLEX_START,
                });
            }
            UiNode::Text { .. } | UiNode::Action { .. } | UiNode::Panel { .. } => {}
            UiNode::Conditional { .. } => {
                unreachable!("conditional fragments are flattened above")
            }
        }

        let intrinsic = match node {
            UiNode::Text { value, .. } => Some(measurer.measure_text(&self.eval_text(value))),
            UiNode::Action { label, .. } => Some(measurer.measure_action(label)),
            UiNode::Panel { .. } => Some(measurer.measure_panel()),
            _ => None,
        };

        let mut children = Vec::new();
        for child in self.active_children(node) {
            children.extend(self.build_layout_nodes(taffy, child, nodes, measurer)?);
        }
        let id = if children.is_empty() {
            match intrinsic {
                Some(intrinsic) => taffy.new_leaf_with_context(style, intrinsic)?,
                None => taffy.new_leaf(style)?,
            }
        } else {
            taffy.new_with_children(style, &children)?
        };
        nodes.insert(base.id.clone(), id);
        Ok(vec![id])
    }

    fn collect_scene(
        &self,
        taffy: &LayoutTree,
        node: &UiNode,
        nodes: &HashMap<String, NodeId>,
        parent_x: f32,
        parent_y: f32,
        inherited_opacity: f32,
        scene: &mut Scene,
    ) -> Result<(), taffy::TaffyError> {
        if matches!(node, UiNode::Conditional { .. }) {
            for child in self.active_children(node) {
                self.collect_scene(
                    taffy,
                    child,
                    nodes,
                    parent_x,
                    parent_y,
                    inherited_opacity,
                    scene,
                )?;
            }
            return Ok(());
        }

        let layout = taffy.layout(*nodes.get(&node.base().id).expect("layout node"))?;
        let visual = node.base().visual.as_ref();
        let translation_x = visual
            .and_then(|visual| visual.translation_x.as_ref())
            .and_then(|value| self.presentation_number(node, MotionProperty::TranslationX, value))
            .unwrap_or(0.0);
        let translation_y = visual
            .and_then(|visual| visual.translation_y.as_ref())
            .and_then(|value| self.presentation_number(node, MotionProperty::TranslationY, value))
            .unwrap_or(0.0);
        let local_opacity = visual
            .and_then(|visual| visual.opacity.as_ref())
            .and_then(|value| self.presentation_number(node, MotionProperty::Opacity, value))
            .unwrap_or(1.0)
            .clamp(0.0, 1.0);
        let opacity = (inherited_opacity * local_opacity).clamp(0.0, 1.0);
        let x = parent_x + layout.location.x + translation_x;
        let y = parent_y + layout.location.y + translation_y;
        let rect = SceneBounds {
            x,
            y,
            width: layout.size.width,
            height: layout.size.height,
        };

        if let Some(background) = visual
            .and_then(|visual| visual.background.as_deref())
            .and_then(Color::parse)
        {
            scene.rects.push(SceneRect {
                id: node.base().id.clone(),
                rect,
                color: background.with_opacity(opacity),
                corner_radius: visual
                    .and_then(|visual| visual.corner_radius)
                    .unwrap_or(0.0),
            });
        }

        match node {
            UiNode::Text { base, value } => {
                scene.texts.push(SceneText {
                    id: base.id.clone(),
                    text: self.eval_text(value),
                    x,
                    y: y + 3.0,
                    font_size: 24.0,
                    color: base
                        .visual
                        .as_ref()
                        .and_then(|visual| visual.foreground.as_deref())
                        .and_then(Color::parse)
                        .unwrap_or(Color::TEXT)
                        .with_opacity(opacity),
                });
            }
            UiNode::Action { base, label, .. } => {
                let focused = self.focused_action.as_deref() == Some(base.id.as_str());
                scene.rects.push(SceneRect {
                    id: format!("{}:background", base.id),
                    rect,
                    color: if focused {
                        Color::ACTION_FOCUSED
                    } else {
                        Color::ACTION
                    }
                    .with_opacity(opacity),
                    corner_radius: 9.0,
                });
                scene.texts.push(SceneText {
                    id: format!("{}:label", base.id),
                    text: label.clone(),
                    x: x + 16.0,
                    y: y + 8.0,
                    font_size: 16.0,
                    color: Color::TEXT.with_opacity(opacity),
                });
                scene.actions.push(ActionHit {
                    id: base.id.clone(),
                    rect,
                });
            }
            _ => {}
        }

        for child in self.active_children(node) {
            self.collect_scene(taffy, child, nodes, x, y, opacity, scene)?;
        }
        Ok(())
    }

    fn collect_accessibility(
        &self,
        taffy: &LayoutTree,
        node: &UiNode,
        nodes: &HashMap<String, NodeId>,
        parent_x: f32,
        parent_y: f32,
        output: &mut Vec<AccessibilityNode>,
    ) -> Result<(), taffy::TaffyError> {
        if matches!(node, UiNode::Conditional { .. }) {
            for child in self.active_children(node) {
                self.collect_accessibility(taffy, child, nodes, parent_x, parent_y, output)?;
            }
            return Ok(());
        }
        let base = node.base();
        let layout = taffy.layout(*nodes.get(&base.id).expect("layout node"))?;
        let visual = base.visual.as_ref();
        let translation_x = visual
            .and_then(|visual| visual.translation_x.as_ref())
            .and_then(|value| self.presentation_number(node, MotionProperty::TranslationX, value))
            .unwrap_or(0.0);
        let translation_y = visual
            .and_then(|visual| visual.translation_y.as_ref())
            .and_then(|value| self.presentation_number(node, MotionProperty::TranslationY, value))
            .unwrap_or(0.0);
        let x = parent_x + layout.location.x + translation_x;
        let y = parent_y + layout.location.y + translation_y;
        let semantics = base.accessibility.as_ref();
        let role = semantics
            .map(|semantics| semantics.role)
            .unwrap_or_else(|| match node {
                UiNode::Text { .. } => AccessibilityRole::Text,
                UiNode::Action { .. } => AccessibilityRole::Button,
                _ => AccessibilityRole::Group,
            });
        let label = semantics
            .and_then(|semantics| semantics.label.clone())
            .or_else(|| match node {
                UiNode::Text { value, .. } => Some(self.eval_text(value)),
                UiNode::Action { label, .. } => Some(label.clone()),
                _ => None,
            });
        let enabled = self.node_enabled(base);
        let children = self
            .active_semantic_children(node)
            .into_iter()
            .map(|child| child.base().id.clone())
            .collect();
        let action_id = matches!(node, UiNode::Action { .. }).then(|| base.id.clone());
        output.push(AccessibilityNode {
            id: base.id.clone(),
            role,
            label,
            enabled,
            focused: self.focused_action.as_deref() == Some(base.id.as_str()),
            bounds: AccessibilityBounds {
                x,
                y,
                width: layout.size.width,
                height: layout.size.height,
            },
            children,
            action_id,
        });

        for child in self.active_children(node) {
            self.collect_accessibility(taffy, child, nodes, x, y, output)?;
        }
        Ok(())
    }
}

fn collect_focusable_actions(node: &UiNode, runtime: &Runtime, output: &mut Vec<String>) {
    if matches!(node, UiNode::Action { .. }) && runtime.node_enabled(node.base()) {
        output.push(node.base().id.clone());
    }
    for child in runtime.active_children(node) {
        collect_focusable_actions(child, runtime, output);
    }
}

fn find_action<'a>(
    node: &'a UiNode,
    runtime: &Runtime,
    id: &str,
) -> Option<(&'a UiAction, &'a crate::ir::NodeBase)> {
    match node {
        UiNode::Action { base, action, .. } if base.id == id => Some((action, base)),
        _ => runtime
            .active_children(node)
            .iter()
            .find_map(|child| find_action(child, runtime, id)),
    }
}

#[derive(Clone, Debug)]
struct MotionTarget {
    target: f32,
    trigger: Option<Value>,
    plan: Option<crate::ir::MotionExecutionPlan>,
}

fn collect_motion_targets(
    node: &UiNode,
    runtime: &Runtime,
    output: &mut HashMap<MotionChannelKey, MotionTarget>,
) {
    for binding in &node.base().motion {
        let Some(target) = runtime.eval_number(&binding.value) else {
            continue;
        };
        output.insert(
            MotionChannelKey {
                node_id: node.base().id.clone(),
                property: binding.property,
            },
            MotionTarget {
                target,
                trigger: binding
                    .trigger
                    .as_ref()
                    .map(|trigger| runtime.eval(trigger)),
                plan: binding.plan.clone(),
            },
        );
    }
    for child in runtime.active_children(node) {
        collect_motion_targets(child, runtime, output);
    }
}

fn start_layout_flip_progress(
    motion: &mut MotionScheduler,
    node_id: &str,
    plan: &MotionExecutionPlan,
) -> MotionChannelKey {
    let key = MotionChannelKey {
        node_id: format!("__layout-flip:{node_id}"),
        property: MotionProperty::TranslationX,
    };
    // A FLIP retarget captures the current rendered geometry before replacing
    // the old inverse projection. The new inverse delta is therefore already
    // expressed from that presentation state and must start at fresh progress
    // zero, matching the inherited LayoutTransition MotionValue(0) lifecycle.
    motion.snap(&key, 0.0);
    motion.retarget(key.clone(), 0.0, 1.0, plan);
    key
}

fn settle_layout_flip_progress(motion: &mut MotionScheduler, progress: &MotionChannelKey) {
    if let Some(value) = motion.value(progress) {
        motion.snap(progress, value);
    }
}

fn apply_scene_translation(scene: &mut Scene, descendants: &HashSet<String>, dx: f32, dy: f32) {
    for item in &mut scene.rects {
        if scene_item_belongs(&item.id, descendants) {
            item.rect.x += dx;
            item.rect.y += dy;
        }
    }
    for item in &mut scene.texts {
        if scene_item_belongs(&item.id, descendants) {
            item.x += dx;
            item.y += dy;
        }
    }
    for item in &mut scene.actions {
        if scene_item_belongs(&item.id, descendants) {
            item.rect.x += dx;
            item.rect.y += dy;
        }
    }
}

fn apply_accessibility_translation(
    tree: &mut AccessibilityTree,
    descendants: &HashSet<String>,
    dx: f32,
    dy: f32,
) {
    for node in &mut tree.nodes {
        if descendants.contains(&node.id) {
            node.bounds.x += dx;
            node.bounds.y += dy;
        }
    }
}

fn default_transition_plan() -> MotionExecutionPlan {
    MotionExecutionPlan::Spring {
        omega: std::f32::consts::TAU / 0.55,
        damping_ratio: 0.825,
        blend_duration: 0.0,
        delay_ms: 0.0,
        repeat_count: Value::from(1),
        autoreverses: true,
    }
}

fn start_presence_progress(
    motion: &mut MotionScheduler,
    node_id: &str,
    phase: &str,
    plan: &MotionExecutionPlan,
    insertion: bool,
) -> MotionChannelKey {
    let key = MotionChannelKey {
        node_id: format!("__presence:{phase}:{node_id}"),
        property: MotionProperty::Opacity,
    };
    let (from, to) = if insertion { (0.0, 1.0) } else { (1.0, 0.0) };
    motion.retarget(key.clone(), from, to, plan);
    key
}

fn settle_presence_progress(motion: &mut MotionScheduler, progress: &MotionChannelKey) {
    if let Some(value) = motion.value(progress) {
        motion.snap(progress, value);
    }
}

fn transition_presence_values(effects: &[TransitionEffect], progress: f32) -> PresenceValues {
    let inactive = 1.0 - progress;
    let mut values = PresenceValues::default();
    if effects
        .iter()
        .any(|effect| matches!(effect, TransitionEffect::Opacity))
    {
        values.opacity = progress.clamp(0.0, 1.0);
    }

    // CSS/Web preserves the descriptor order in the transform function list.
    // Compose the same uniform-scale/translation affine matrix here: M = M * effect.
    for effect in effects {
        match effect {
            TransitionEffect::Opacity => {}
            TransitionEffect::Scale { scale } => {
                let current = 1.0 + (*scale - 1.0) * inactive;
                values.scale *= current;
            }
            TransitionEffect::Move { edge, distance } => {
                let distance = *distance * inactive;
                let (dx, dy) = match edge {
                    TransitionEdge::Top => (0.0, -distance),
                    TransitionEdge::Bottom => (0.0, distance),
                    TransitionEdge::Leading | TransitionEdge::Left => (-distance, 0.0),
                    TransitionEdge::Trailing | TransitionEdge::Right => (distance, 0.0),
                };
                values.translation_x += values.scale * dx;
                values.translation_y += values.scale * dy;
            }
        }
    }
    values.scale = values.scale.max(0.0);
    values
}

fn transform_point(
    x: f32,
    y: f32,
    pivot: AccessibilityBounds,
    values: PresenceValues,
) -> (f32, f32) {
    let center_x = pivot.x + pivot.width * 0.5;
    let center_y = pivot.y + pivot.height * 0.5;
    (
        center_x + (x - center_x) * values.scale + values.translation_x,
        center_y + (y - center_y) * values.scale + values.translation_y,
    )
}

fn transform_scene_rect(
    rect: &mut SceneBounds,
    pivot: AccessibilityBounds,
    values: PresenceValues,
) {
    let (x, y) = transform_point(rect.x, rect.y, pivot, values);
    rect.x = x;
    rect.y = y;
    rect.width *= values.scale;
    rect.height *= values.scale;
}

fn transform_accessibility_bounds(
    bounds: &mut AccessibilityBounds,
    pivot: AccessibilityBounds,
    values: PresenceValues,
) {
    let (x, y) = transform_point(bounds.x, bounds.y, pivot, values);
    bounds.x = x;
    bounds.y = y;
    bounds.width *= values.scale;
    bounds.height *= values.scale;
}

fn apply_scene_presence(
    scene: &mut Scene,
    descendants: &HashSet<String>,
    pivot: AccessibilityBounds,
    values: PresenceValues,
) {
    for item in &mut scene.rects {
        if !scene_item_belongs(&item.id, descendants) {
            continue;
        }
        transform_scene_rect(&mut item.rect, pivot, values);
        item.corner_radius *= values.scale;
        item.color = item.color.with_opacity(values.opacity);
    }
    for item in &mut scene.texts {
        if !scene_item_belongs(&item.id, descendants) {
            continue;
        }
        (item.x, item.y) = transform_point(item.x, item.y, pivot, values);
        item.font_size *= values.scale;
        item.color = item.color.with_opacity(values.opacity);
    }
    for item in &mut scene.actions {
        if !scene_item_belongs(&item.id, descendants) {
            continue;
        }
        transform_scene_rect(&mut item.rect, pivot, values);
    }
}

fn apply_scene_presence_all(scene: &mut Scene, pivot: AccessibilityBounds, values: PresenceValues) {
    for item in &mut scene.rects {
        transform_scene_rect(&mut item.rect, pivot, values);
        item.corner_radius *= values.scale;
        item.color = item.color.with_opacity(values.opacity);
    }
    for item in &mut scene.texts {
        (item.x, item.y) = transform_point(item.x, item.y, pivot, values);
        item.font_size *= values.scale;
        item.color = item.color.with_opacity(values.opacity);
    }
    for item in &mut scene.actions {
        transform_scene_rect(&mut item.rect, pivot, values);
    }
}

fn apply_accessibility_presence(
    tree: &mut AccessibilityTree,
    descendants: &HashSet<String>,
    pivot: AccessibilityBounds,
    values: PresenceValues,
) {
    for node in &mut tree.nodes {
        if descendants.contains(&node.id) {
            transform_accessibility_bounds(&mut node.bounds, pivot, values);
        }
    }
}

fn scene_item_belongs(id: &str, descendants: &HashSet<String>) -> bool {
    descendants.iter().any(|node_id| {
        id == node_id
            || id
                .strip_prefix(node_id)
                .is_some_and(|rest| rest.starts_with(':'))
    })
}

fn snapshot_scene_subtree(scene: &Scene, descendants: &HashSet<String>) -> Scene {
    Scene {
        rects: scene
            .rects
            .iter()
            .filter(|item| scene_item_belongs(&item.id, descendants))
            .cloned()
            .collect(),
        texts: scene
            .texts
            .iter()
            .filter(|item| scene_item_belongs(&item.id, descendants))
            .cloned()
            .collect(),
        actions: Vec::new(),
    }
}

fn validate_node_identities(program: &UiProgram) -> Result<(), RuntimeLoadError> {
    let mut identities = HashSet::new();
    if !identities.insert(program.root.id.clone()) {
        return Err(RuntimeLoadError::DuplicateNodeIdentity {
            id: program.root.id.clone(),
        });
    }
    validate_node_identity(&program.root.child, &mut identities)
}

fn validate_node_identity(
    node: &UiNode,
    identities: &mut HashSet<String>,
) -> Result<(), RuntimeLoadError> {
    let id = node.base().id.clone();
    if !identities.insert(id.clone()) {
        return Err(RuntimeLoadError::DuplicateNodeIdentity { id });
    }

    match node {
        UiNode::Column { children, .. } | UiNode::Row { children, .. } => {
            for child in children {
                validate_node_identity(child, identities)?;
            }
        }
        UiNode::Conditional {
            then_nodes,
            otherwise,
            ..
        } => {
            for child in then_nodes.iter().chain(otherwise) {
                validate_node_identity(child, identities)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_native_transitions(node: &UiNode) -> Result<(), RuntimeLoadError> {
    match node {
        UiNode::Column { children, .. } | UiNode::Row { children, .. } => {
            for child in children {
                validate_native_transitions(child)?;
            }
        }
        UiNode::Conditional {
            then_nodes,
            otherwise,
            ..
        } => {
            for child in then_nodes.iter().chain(otherwise) {
                validate_native_transitions(child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SELF_DISABLING_ACTION: &str = r#"
    {
      "version": 1,
      "sourceLanguage": "mun",
      "entry": "FocusTest",
      "states": [
        { "name": "enabled", "initial": true }
      ],
      "root": {
        "kind": "window",
        "id": "root",
        "title": "Focus Test",
        "child": {
          "kind": "action",
          "id": "toggle",
          "accessibility": {
            "role": "button",
            "enabled": { "kind": "state", "state": "enabled" }
          },
          "label": "Disable",
          "action": { "kind": "toggle-state", "state": "enabled" }
        }
      }
    }
    "#;

    #[test]
    fn activation_clears_focus_when_action_disables_itself() {
        let mut runtime = Runtime::from_json(SELF_DISABLING_ACTION).expect("valid UI program");
        assert!(runtime.focus_action("toggle"));
        assert_eq!(runtime.focused_action(), Some("toggle"));

        let transaction = runtime
            .activate_focused()
            .expect("focused action activates");
        assert_eq!(transaction.mutations.len(), 1);
        assert_eq!(runtime.focused_action(), None);

        let tree = runtime
            .build_accessibility_tree(320.0, 200.0)
            .expect("accessibility tree");
        let action = tree.node("toggle").expect("action accessibility node");
        assert!(!action.enabled);
        assert!(!action.focused);
        assert_eq!(tree.focus_id, None);
        assert!(tree.node("root").expect("root accessibility node").focused);
    }

    #[test]
    fn rejects_unsupported_semantic_ui_ir_version() {
        let source = SELF_DISABLING_ACTION.replacen("\"version\": 1", "\"version\": 2", 1);
        let error = match Runtime::from_json(&source) {
            Ok(_) => panic!("future IR version must fail"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            RuntimeLoadError::UnsupportedVersion {
                found: 2,
                supported: SEMANTIC_UI_IR_VERSION,
            }
        ));
    }

    #[test]
    fn rejects_non_mun_semantic_ui_ir_source_language() {
        let source = SELF_DISABLING_ACTION.replacen(
            "\"sourceLanguage\": \"mun\"",
            "\"sourceLanguage\": \"html\"",
            1,
        );
        let error = match Runtime::from_json(&source) {
            Ok(_) => panic!("foreign source language must fail"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            RuntimeLoadError::UnsupportedSourceLanguage { ref found } if found == "html"
        ));
    }

    const DUPLICATE_NODE_IDENTITY: &str = r#"
    {
      "version": 1,
      "sourceLanguage": "mun",
      "entry": "DuplicateIdentity",
      "states": [],
      "root": {
        "kind": "window",
        "id": "root",
        "title": "Duplicate",
        "child": {
          "kind": "row",
          "id": "same",
          "children": [
            {
              "kind": "text",
              "id": "same",
              "value": { "kind": "literal", "value": "duplicate" }
            }
          ]
        }
      }
    }
    "#;

    #[test]
    fn rejects_duplicate_semantic_node_identity() {
        let error = match Runtime::from_json(DUPLICATE_NODE_IDENTITY) {
            Ok(_) => panic!("duplicate semantic identity must fail"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            RuntimeLoadError::DuplicateNodeIdentity { ref id } if id == "same"
        ));
    }

    const DYNAMIC_IDENTITY_KEY: &str = r#"
    {
      "version": 1,
      "sourceLanguage": "mun",
      "entry": "DynamicIdentityKey",
      "states": [{ "name": "selection", "initial": "alpha" }],
      "root": {
        "kind": "window",
        "id": "root",
        "title": "Dynamic Identity",
        "child": {
          "kind": "column",
          "id": "stack",
          "children": [
            {
              "kind": "column",
              "id": "keyed",
              "identityKey": { "kind": "state", "state": "selection" },
              "children": [
                {
                  "kind": "action",
                  "id": "keyed-child",
                  "label": "Keyed Child",
                  "action": {
                    "kind": "set-state",
                    "state": "selection",
                    "value": { "kind": "literal", "value": "alpha" }
                  }
                }
              ]
            },
            {
              "kind": "action",
              "id": "change",
              "label": "Change",
              "action": {
                "kind": "set-state",
                "state": "selection",
                "value": { "kind": "literal", "value": "beta" }
              }
            },
            {
              "kind": "text",
              "id": "stable-sibling",
              "value": { "kind": "literal", "value": "Stable" }
            }
          ]
        }
      }
    }
    "#;

    #[test]
    fn dynamic_identity_key_replaces_only_the_keyed_retained_subtree() {
        let mut runtime =
            Runtime::from_json(DYNAMIC_IDENTITY_KEY).expect("valid dynamic identity program");
        let keyed_instance = runtime
            .retained_tree()
            .node("keyed")
            .expect("keyed retained node")
            .instance_id;
        let child_instance = runtime
            .retained_tree()
            .node("keyed-child")
            .expect("keyed child")
            .instance_id;
        let action_instance = runtime
            .retained_tree()
            .node("change")
            .expect("change action")
            .instance_id;
        let sibling_instance = runtime
            .retained_tree()
            .node("stable-sibling")
            .expect("stable sibling")
            .instance_id;

        runtime
            .activate_action("change")
            .expect("identity-changing action");

        assert_ne!(
            runtime
                .retained_tree()
                .node("keyed")
                .expect("keyed retained node")
                .instance_id,
            keyed_instance
        );
        assert_ne!(
            runtime
                .retained_tree()
                .node("keyed-child")
                .expect("keyed child")
                .instance_id,
            child_instance
        );
        assert_eq!(
            runtime
                .retained_tree()
                .node("change")
                .expect("change action")
                .instance_id,
            action_instance
        );
        assert_eq!(
            runtime
                .retained_tree()
                .node("stable-sibling")
                .expect("stable sibling")
                .instance_id,
            sibling_instance
        );
        assert_eq!(
            runtime.last_reconciliation().replaced,
            vec!["keyed", "keyed-child"]
        );
    }

    #[test]
    fn semantic_identity_replacement_clears_transient_runtime_state() {
        let mut runtime =
            Runtime::from_json(DYNAMIC_IDENTITY_KEY).expect("valid dynamic identity program");
        assert!(runtime.focus_action("keyed-child"));

        let pointer = crate::input::PointerId(77);
        runtime
            .input
            .capture_primary(pointer, "keyed-child".to_owned());
        runtime.input.capture_keyboard("keyed-child".to_owned());

        let replaced_motion = MotionChannelKey {
            node_id: "keyed-child".to_owned(),
            property: MotionProperty::Opacity,
        };
        let stable_motion = MotionChannelKey {
            node_id: "change".to_owned(),
            property: MotionProperty::Opacity,
        };
        let plan = MotionExecutionPlan::Timing {
            duration: 0.4,
            curve: [0.42, 0.0, 0.58, 1.0],
            delay_ms: 0.0,
            repeat_count: serde_json::json!(1),
            autoreverses: false,
        };
        runtime
            .motion
            .retarget(replaced_motion.clone(), 0.25, 1.0, &plan);
        runtime
            .motion
            .retarget(stable_motion.clone(), 0.5, 1.0, &plan);
        let enter_progress = MotionChannelKey {
            node_id: "__presence:enter:keyed-child".to_owned(),
            property: MotionProperty::Opacity,
        };
        let exit_progress = MotionChannelKey {
            node_id: "__presence:exit:keyed-child".to_owned(),
            property: MotionProperty::Opacity,
        };
        let flip_progress = MotionChannelKey {
            node_id: "__layout-flip:keyed-child".to_owned(),
            property: MotionProperty::TranslationX,
        };
        runtime
            .motion
            .retarget(enter_progress.clone(), 0.0, 1.0, &plan);
        runtime
            .motion
            .retarget(exit_progress.clone(), 1.0, 0.0, &plan);
        runtime
            .motion
            .retarget(flip_progress.clone(), 0.0, 1.0, &plan);
        runtime.entering.insert(
            "keyed-child".to_owned(),
            EnterPresence {
                effects: vec![TransitionEffect::Opacity],
                progress: enter_progress.clone(),
            },
        );
        runtime.exiting.insert(
            "keyed-child".to_owned(),
            ExitPresence {
                scene: Scene::default(),
                root_bounds: AccessibilityBounds {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                effects: vec![TransitionEffect::Opacity],
                progress: exit_progress.clone(),
            },
        );
        runtime.layout_flips.insert(
            "keyed-child".to_owned(),
            LayoutFlip {
                descendants: HashSet::from(["keyed-child".to_owned()]),
                progress: flip_progress.clone(),
                delta_x: 10.0,
                delta_y: 0.0,
            },
        );


        runtime
            .activate_action("change")
            .expect("identity-changing action");

        assert_eq!(runtime.focused_action(), None);
        assert_eq!(runtime.primary_pressed_action(pointer), None);
        assert_eq!(runtime.keyboard_pressed_action(), None);
        assert!(runtime.motion.value(&replaced_motion).is_none());
        assert!(!runtime.motion.is_key_active(&replaced_motion));
        assert!(runtime.motion.value(&stable_motion).is_some());
        assert!(!runtime.entering.contains_key("keyed-child"));
        assert!(!runtime.exiting.contains_key("keyed-child"));
        assert!(!runtime.layout_flips.contains_key("keyed-child"));
        assert!(runtime.motion.value(&enter_progress).is_none());
        assert!(runtime.motion.value(&exit_progress).is_none());
        assert!(runtime.motion.value(&flip_progress).is_none());
    }

    #[test]
    fn replaced_semantic_instances_are_not_structural_flip_candidates() {
        let mut runtime =
            Runtime::from_json(DYNAMIC_IDENTITY_KEY).expect("valid dynamic identity program");
        let mut before_geometry = runtime
            .build_accessibility_tree(320.0, 240.0)
            .expect("before geometry");
        for node in &mut before_geometry.nodes {
            if node.id == "keyed-child" || node.id == "change" {
                node.bounds.y -= 20.0;
            }
        }

        let before_neighborhoods = HashMap::from([(
            "synthetic-parent".to_owned(),
            vec![
                "keyed-child".to_owned(),
                "change".to_owned(),
                "removed".to_owned(),
            ],
        )]);
        let after_neighborhoods = HashMap::from([(
            "synthetic-parent".to_owned(),
            vec!["keyed-child".to_owned(), "change".to_owned()],
        )]);
        let replaced = HashSet::from(["keyed-child".to_owned()]);
        let transaction = Transaction {
            revision: 1,
            mutations: Vec::new(),
            animation: Some(MotionExecutionPlan::Timing {
                duration: 0.2,
                curve: [0.0, 0.0, 1.0, 1.0],
                delay_ms: 0.0,
                repeat_count: serde_json::json!(1),
                autoreverses: false,
            }),
            disables_animations: false,
            is_continuous: false,
        };

        runtime.reconcile_layout_flips(
            before_neighborhoods,
            after_neighborhoods,
            Some(&before_geometry),
            &replaced,
            &transaction,
        );

        assert!(!runtime.layout_flips.contains_key("keyed-child"));
        assert!(runtime.layout_flips.contains_key("change"));
        assert!(runtime.motion.value(&MotionChannelKey {
            node_id: "__layout-flip:change".to_owned(),
            property: MotionProperty::TranslationX,
        }).is_some());
        assert!(runtime.motion.value(&MotionChannelKey {
            node_id: "__layout-flip:keyed-child".to_owned(),
            property: MotionProperty::TranslationX,
        }).is_none());
    }

    const DYNAMIC_ROOT_IDENTITY_KEY: &str = r#"
    {
      "version": 1,
      "sourceLanguage": "mun",
      "entry": "DynamicRootIdentityKey",
      "states": [{ "name": "selection", "initial": "alpha" }],
      "root": {
        "kind": "window",
        "id": "root",
        "identityKey": { "kind": "state", "state": "selection" },
        "title": "Dynamic Root Identity",
        "child": {
          "kind": "column",
          "id": "stack",
          "children": [
            {
              "kind": "action",
              "id": "change",
              "label": "Change",
              "action": {
                "kind": "set-state",
                "state": "selection",
                "value": { "kind": "literal", "value": "beta" }
              }
            },
            {
              "kind": "text",
              "id": "leaf",
              "value": { "kind": "literal", "value": "Leaf" }
            }
          ]
        }
      }
    }
    "#;

    #[test]
    fn dynamic_root_identity_key_replaces_the_entire_retained_tree() {
        let mut runtime = Runtime::from_json(DYNAMIC_ROOT_IDENTITY_KEY)
            .expect("valid dynamic root identity program");
        let root_instance = runtime
            .retained_tree()
            .node("root")
            .expect("root retained node")
            .instance_id;
        let stack_instance = runtime
            .retained_tree()
            .node("stack")
            .expect("stack retained node")
            .instance_id;
        let action_instance = runtime
            .retained_tree()
            .node("change")
            .expect("change action")
            .instance_id;
        let leaf_instance = runtime
            .retained_tree()
            .node("leaf")
            .expect("leaf retained node")
            .instance_id;

        runtime
            .activate_action("change")
            .expect("root identity-changing action");

        assert_ne!(
            runtime
                .retained_tree()
                .node("root")
                .expect("root retained node")
                .instance_id,
            root_instance
        );
        assert_ne!(
            runtime
                .retained_tree()
                .node("stack")
                .expect("stack retained node")
                .instance_id,
            stack_instance
        );
        assert_ne!(
            runtime
                .retained_tree()
                .node("change")
                .expect("change action")
                .instance_id,
            action_instance
        );
        assert_ne!(
            runtime
                .retained_tree()
                .node("leaf")
                .expect("leaf retained node")
                .instance_id,
            leaf_instance
        );
        assert_eq!(
            runtime.last_reconciliation().replaced,
            vec!["root", "stack", "change", "leaf"]
        );
    }

    const STRETCH_INTRINSIC_LAYOUT: &str = r#"
    {
      "version": 1,
      "sourceLanguage": "mun",
      "entry": "StretchIntrinsicLayout",
      "states": [{ "name": "armed", "initial": false }],
      "root": {
        "kind": "window",
        "id": "root",
        "title": "Layout",
        "child": {
          "kind": "column",
          "id": "stack",
          "layout": {
            "width": { "kind": "literal", "value": 200 },
            "height": { "kind": "literal", "value": 180 },
            "alignment": "stretch"
          },
          "children": [
            {
              "kind": "text",
              "id": "stretched",
              "value": { "kind": "literal", "value": "Intrinsic" }
            },
            {
              "kind": "text",
              "id": "explicit",
              "layout": {
                "width": { "kind": "literal", "value": 80 }
              },
              "value": { "kind": "literal", "value": "Explicit" }
            },
            {
              "kind": "action",
              "id": "button",
              "label": "Go",
              "action": { "kind": "toggle-state", "state": "armed" }
            }
          ]
        }
      }
    }
    "#;

    #[test]
    fn stretch_overrides_intrinsic_width_but_preserves_explicit_width() {
        let runtime =
            Runtime::from_json(STRETCH_INTRINSIC_LAYOUT).expect("valid intrinsic layout program");
        let (taffy, nodes) = runtime.build_layout_tree(400.0, 240.0).expect("layout");

        let stretched = taffy
            .layout(*nodes.get("stretched").expect("stretched layout node"))
            .expect("stretched layout");
        let explicit = taffy
            .layout(*nodes.get("explicit").expect("explicit layout node"))
            .expect("explicit layout");
        let button = taffy
            .layout(*nodes.get("button").expect("button layout node"))
            .expect("button layout");

        assert_eq!(stretched.size.width, 200.0);
        assert_eq!(explicit.size.width, 80.0);
        assert_eq!(
            stretched.size.height,
            FallbackIntrinsicMeasurer.measure_text("Intrinsic").height
        );
        assert_eq!(
            explicit.size.height,
            FallbackIntrinsicMeasurer.measure_text("Explicit").height
        );
        assert_eq!(button.size.width, 200.0);
        assert_eq!(
            button.size.height,
            FallbackIntrinsicMeasurer.measure_action("Go").height
        );
    }

    const CUSTOM_INTRINSIC_MEASUREMENT: &str = r##"
    {
      "version": 1,
      "sourceLanguage": "mun",
      "entry": "CustomIntrinsicMeasurement",
      "states": [{ "name": "armed", "initial": false }],
      "root": {
        "kind": "window",
        "id": "root",
        "title": "Measurement",
        "child": {
          "kind": "column",
          "id": "stack",
          "children": [
            {
              "kind": "text",
              "id": "measured-text",
              "value": { "kind": "literal", "value": "abc" }
            },
            {
              "kind": "action",
              "id": "measured-action",
              "label": "Go",
              "action": { "kind": "toggle-state", "state": "armed" }
            },
            {
              "kind": "panel",
              "id": "measured-panel",
              "visual": { "background": "#000000" }
            }
          ]
        }
      }
    }
    "##;

    struct ExactTestMeasurer;

    impl IntrinsicMeasurer for ExactTestMeasurer {
        fn measure_text(&self, text: &str) -> IntrinsicSize {
            IntrinsicSize::new(text.chars().count() as f32 * 10.0, 11.0)
        }

        fn measure_action(&self, label: &str) -> IntrinsicSize {
            IntrinsicSize::new(label.chars().count() as f32 * 20.0, 22.0)
        }

        fn measure_panel(&self) -> IntrinsicSize {
            IntrinsicSize::new(33.0, 44.0)
        }
    }

    #[test]
    fn backend_intrinsic_measurer_drives_scene_and_accessibility_geometry() {
        let runtime = Runtime::from_json(CUSTOM_INTRINSIC_MEASUREMENT)
            .expect("valid custom intrinsic measurement program");
        let frame = runtime
            .build_frame_with_measurer(300.0, 240.0, &ExactTestMeasurer)
            .expect("measured frame");

        let text = frame
            .accessibility
            .node("measured-text")
            .expect("measured text node");
        let action = frame
            .accessibility
            .node("measured-action")
            .expect("measured action node");
        let panel = frame
            .accessibility
            .node("measured-panel")
            .expect("measured panel node");

        assert_eq!(text.bounds.width, 30.0);
        assert_eq!(text.bounds.height, 11.0);
        assert_eq!(action.bounds.width, 40.0);
        assert_eq!(action.bounds.height, 22.0);
        assert_eq!(panel.bounds.width, 33.0);
        assert_eq!(panel.bounds.height, 44.0);

        let action_hit = frame
            .scene
            .actions
            .iter()
            .find(|hit| hit.id == "measured-action")
            .expect("measured action hit region");
        let panel_rect = frame
            .scene
            .rects
            .iter()
            .find(|rect| rect.id == "measured-panel")
            .expect("measured panel rect");
        assert_eq!(action_hit.rect.width, 40.0);
        assert_eq!(action_hit.rect.height, 22.0);
        assert_eq!(panel_rect.rect.width, 33.0);
        assert_eq!(panel_rect.rect.height, 44.0);
    }

    const CONTAINER_LAYOUT_SEMANTICS: &str = r#"
    {
      "version": 1,
      "sourceLanguage": "mun",
      "entry": "ContainerLayoutSemantics",
      "states": [],
      "root": {
        "kind": "window",
        "id": "root",
        "title": "Layout Semantics",
        "child": {
          "kind": "column",
          "id": "root-stack",
          "children": [
            {
              "kind": "column",
              "id": "column",
              "layout": {
                "width": { "kind": "literal", "value": 200 },
                "height": { "kind": "literal", "value": 160 },
                "padding": 10,
                "spacing": 6,
                "alignment": "center"
              },
              "children": [
                {
                  "kind": "panel",
                  "id": "column-a",
                  "layout": {
                    "width": { "kind": "literal", "value": 50 },
                    "height": { "kind": "literal", "value": 20 }
                  }
                },
                {
                  "kind": "panel",
                  "id": "column-b",
                  "layout": {
                    "width": { "kind": "literal", "value": 70 },
                    "height": { "kind": "literal", "value": 30 }
                  }
                }
              ]
            },
            {
              "kind": "row",
              "id": "row",
              "layout": {
                "width": { "kind": "literal", "value": 160 },
                "height": { "kind": "literal", "value": 50 },
                "padding": 8,
                "spacing": 5,
                "alignment": "trailing"
              },
              "children": [
                {
                  "kind": "panel",
                  "id": "row-a",
                  "layout": {
                    "width": { "kind": "literal", "value": 20 },
                    "height": { "kind": "literal", "value": 10 }
                  }
                },
                {
                  "kind": "panel",
                  "id": "row-b",
                  "layout": {
                    "width": { "kind": "literal", "value": 30 },
                    "height": { "kind": "literal", "value": 20 }
                  }
                }
              ]
            }
          ]
        }
      }
    }
    "#;

    #[test]
    fn column_padding_spacing_and_center_alignment_are_semantic() {
        let runtime =
            Runtime::from_json(CONTAINER_LAYOUT_SEMANTICS).expect("valid container layout program");
        let (taffy, nodes) = runtime.build_layout_tree(400.0, 320.0).expect("layout");
        let first = taffy
            .layout(*nodes.get("column-a").expect("first column child"))
            .expect("first column layout");
        let second = taffy
            .layout(*nodes.get("column-b").expect("second column child"))
            .expect("second column layout");

        assert_eq!(first.location.x, 75.0);
        assert_eq!(first.location.y, 10.0);
        assert_eq!(second.location.x, 65.0);
        assert_eq!(second.location.y, 36.0);
    }

    #[test]
    fn row_padding_spacing_and_trailing_alignment_are_semantic() {
        let runtime =
            Runtime::from_json(CONTAINER_LAYOUT_SEMANTICS).expect("valid container layout program");
        let (taffy, nodes) = runtime.build_layout_tree(400.0, 320.0).expect("layout");
        let first = taffy
            .layout(*nodes.get("row-a").expect("first row child"))
            .expect("first row layout");
        let second = taffy
            .layout(*nodes.get("row-b").expect("second row child"))
            .expect("second row layout");

        assert_eq!(first.location.x, 8.0);
        assert_eq!(first.location.y, 32.0);
        assert_eq!(second.location.x, 33.0);
        assert_eq!(second.location.y, 22.0);
    }

    const CONDITIONAL_BRANCH: &str = r#"{"version":1,"sourceLanguage":"mun","entry":"ConditionalTest","states":[{"name":"expanded","initial":false}],"root":{"kind":"window","id":"root","title":"Conditional","child":{"kind":"conditional","id":"branch","condition":{"kind":"state","state":"expanded"},"then":[{"kind":"action","id":"expanded-action","label":"Expanded","action":{"kind":"toggle-state","state":"expanded"}}],"otherwise":[{"kind":"action","id":"collapsed-action","label":"Collapsed","action":{"kind":"toggle-state","state":"expanded"}}]}}}"#;

    const TWO_ACTIONS: &str = r#"{"version":1,"sourceLanguage":"mun","entry":"InputTest","states":[{"name":"armed","initial":false}],"root":{"kind":"window","id":"root","title":"Input","child":{"kind":"column","id":"actions","children":[{"kind":"action","id":"first","label":"First","action":{"kind":"toggle-state","state":"armed"}},{"kind":"action","id":"second","label":"Second","action":{"kind":"toggle-state","state":"armed"}}]}}}"#;

    const REMOVE_LAST_FOCUSED_ACTION: &str = r#"{"version":1,"sourceLanguage":"mun","entry":"FocusRemoval","states":[{"name":"visible","initial":true}],"root":{"kind":"window","id":"root","title":"Focus Removal","child":{"kind":"column","id":"actions","children":[{"kind":"action","id":"stable","label":"Stable","action":{"kind":"toggle-state","state":"visible"}},{"kind":"conditional","id":"branch","condition":{"kind":"state","state":"visible"},"then":[{"kind":"action","id":"remove","label":"Remove","action":{"kind":"toggle-state","state":"visible"}}],"otherwise":[]}]}}}"#;

    fn pressed_key(logical: LogicalKey) -> InputEvent {
        InputEvent::Key {
            logical,
            physical: crate::input::PhysicalKey::Other,
            state: KeyState::Pressed,
            repeat: false,
        }
    }

    fn key_event(logical: LogicalKey, state: KeyState, repeat: bool) -> InputEvent {
        InputEvent::Key {
            logical,
            physical: crate::input::PhysicalKey::Other,
            state,
            repeat,
        }
    }

    #[test]
    fn semantic_keyboard_input_owns_focus_traversal_and_activation() {
        let mut runtime = Runtime::from_json(TWO_ACTIONS).expect("valid input UI program");

        let outcome = runtime
            .handle_input(pressed_key(LogicalKey::Tab), 320.0, 200.0)
            .expect("tab input");
        assert!(outcome.handled);
        assert!(outcome.focus_changed);
        assert_eq!(runtime.focused_action(), Some("first"));

        runtime
            .handle_input(pressed_key(LogicalKey::Tab), 320.0, 200.0)
            .expect("second tab");
        assert_eq!(runtime.focused_action(), Some("second"));

        runtime
            .handle_input(
                InputEvent::ModifiersChanged(crate::input::Modifiers {
                    shift: true,
                    ..Default::default()
                }),
                320.0,
                200.0,
            )
            .expect("modifier input");
        runtime
            .handle_input(pressed_key(LogicalKey::Tab), 320.0, 200.0)
            .expect("reverse tab");
        assert_eq!(runtime.focused_action(), Some("first"));

        runtime.clear_focus();
        let outcome = runtime
            .handle_input(pressed_key(LogicalKey::Enter), 320.0, 200.0)
            .expect("enter input");
        assert!(outcome.activated);
        assert_eq!(runtime.focused_action(), Some("first"));
        assert_eq!(runtime.state.get("armed"), Some(&Value::Bool(true)));
    }

    #[test]
    fn space_key_uses_press_release_capture_without_repeat_activation() {
        let mut runtime = Runtime::from_json(TWO_ACTIONS).expect("valid input UI program");

        let pressed = runtime
            .handle_input(pressed_key(LogicalKey::Space), 320.0, 200.0)
            .expect("space press");
        assert!(pressed.handled);
        assert!(pressed.pressed_changed);
        assert!(!pressed.activated);
        assert_eq!(runtime.focused_action(), Some("first"));
        assert_eq!(runtime.keyboard_pressed_action(), Some("first"));
        assert_eq!(runtime.state.get("armed"), Some(&Value::Bool(false)));

        let repeated = runtime
            .handle_input(
                key_event(LogicalKey::Space, KeyState::Pressed, true),
                320.0,
                200.0,
            )
            .expect("space repeat");
        assert!(repeated.handled);
        assert!(!repeated.pressed_changed);
        assert!(!repeated.activated);

        let released = runtime
            .handle_input(
                key_event(LogicalKey::Space, KeyState::Released, false),
                320.0,
                200.0,
            )
            .expect("space release");
        assert!(released.handled);
        assert!(released.pressed_changed);
        assert!(released.activated);
        assert_eq!(runtime.keyboard_pressed_action(), None);
        assert_eq!(runtime.state.get("armed"), Some(&Value::Bool(true)));

        let duplicate_release = runtime
            .handle_input(
                key_event(LogicalKey::Space, KeyState::Released, false),
                320.0,
                200.0,
            )
            .expect("duplicate release");
        assert!(!duplicate_release.handled);
        assert!(!duplicate_release.activated);
    }

    #[test]
    fn escape_and_window_focus_loss_cancel_keyboard_press() {
        let mut runtime = Runtime::from_json(TWO_ACTIONS).expect("valid input UI program");
        runtime
            .handle_input(pressed_key(LogicalKey::Space), 320.0, 200.0)
            .expect("space press");
        assert_eq!(runtime.keyboard_pressed_action(), Some("first"));

        let escaped = runtime
            .handle_input(pressed_key(LogicalKey::Escape), 320.0, 200.0)
            .expect("escape");
        assert!(escaped.handled);
        assert!(escaped.pressed_changed);
        assert_eq!(runtime.keyboard_pressed_action(), None);
        assert_eq!(runtime.focused_action(), None);

        runtime
            .handle_input(pressed_key(LogicalKey::Space), 320.0, 200.0)
            .expect("second space press");
        assert_eq!(runtime.keyboard_pressed_action(), Some("first"));

        let blurred = runtime
            .handle_input(InputEvent::WindowFocusChanged(false), 320.0, 200.0)
            .expect("window blur");
        assert!(blurred.handled);
        assert!(blurred.pressed_changed);
        assert_eq!(runtime.keyboard_pressed_action(), None);

        let release = runtime
            .handle_input(
                key_event(LogicalKey::Space, KeyState::Released, false),
                320.0,
                200.0,
            )
            .expect("release after blur");
        assert!(!release.activated);
        assert_eq!(runtime.state.get("armed"), Some(&Value::Bool(false)));
    }

    #[test]
    fn focus_change_clears_keyboard_pressed_identity() {
        let mut runtime = Runtime::from_json(TWO_ACTIONS).expect("valid input UI program");
        runtime
            .handle_input(pressed_key(LogicalKey::Space), 320.0, 200.0)
            .expect("space press");
        assert_eq!(runtime.keyboard_pressed_action(), Some("first"));

        assert!(runtime.focus_action("second"));
        assert_eq!(runtime.focused_action(), Some("second"));
        assert_eq!(runtime.keyboard_pressed_action(), None);

        runtime
            .handle_input(pressed_key(LogicalKey::Space), 320.0, 200.0)
            .expect("space press on second");
        assert_eq!(runtime.keyboard_pressed_action(), Some("second"));

        runtime.focus_next_action(false);
        assert_eq!(runtime.focused_action(), Some("first"));
        assert_eq!(runtime.keyboard_pressed_action(), None);
    }

    #[test]
    fn focus_reconciliation_clears_keyboard_pressed_identity() {
        let mut runtime =
            Runtime::from_json(REMOVE_LAST_FOCUSED_ACTION).expect("valid focus removal program");
        assert!(runtime.focus_action("remove"));
        runtime
            .handle_input(pressed_key(LogicalKey::Space), 320.0, 200.0)
            .expect("space press");
        assert_eq!(runtime.keyboard_pressed_action(), Some("remove"));

        runtime
            .activate_action("stable")
            .expect("stable action removes focused peer");

        assert_eq!(runtime.focused_action(), Some("stable"));
        assert_eq!(runtime.keyboard_pressed_action(), None);
    }

    #[test]
    fn semantic_pointer_input_uses_presentation_scene_for_hit_testing() {
        let mut runtime = Runtime::from_json(TWO_ACTIONS).expect("valid input UI program");
        let scene = runtime.build_scene(320.0, 200.0).expect("input scene");
        let first = scene
            .actions
            .iter()
            .find(|action| action.id == "first")
            .expect("first action");
        let point = crate::input::InputPoint::new(
            first.rect.x + first.rect.width * 0.5,
            first.rect.y + first.rect.height * 0.5,
        );

        runtime
            .handle_input(
                InputEvent::PointerMoved {
                    pointer: crate::input::PointerId::MOUSE,
                    position: point,
                },
                320.0,
                200.0,
            )
            .expect("pointer move");
        let outcome = runtime
            .handle_input(
                InputEvent::PointerButton {
                    pointer: crate::input::PointerId::MOUSE,
                    button: PointerButton::Primary,
                    state: ButtonState::Pressed,
                },
                320.0,
                200.0,
            )
            .expect("pointer press");
        assert!(!outcome.activated);
        assert!(outcome.pressed_changed);
        assert_eq!(runtime.focused_action(), Some("first"));
        assert_eq!(
            runtime.primary_pressed_action(crate::input::PointerId::MOUSE),
            Some("first")
        );

        let outcome = runtime
            .handle_input(
                InputEvent::PointerButton {
                    pointer: crate::input::PointerId::MOUSE,
                    button: PointerButton::Primary,
                    state: ButtonState::Released,
                },
                320.0,
                200.0,
            )
            .expect("pointer release");
        assert!(outcome.activated);
        assert!(outcome.pressed_changed);
        assert_eq!(
            runtime.primary_pressed_action(crate::input::PointerId::MOUSE),
            None
        );

        runtime
            .handle_input(
                InputEvent::PointerMoved {
                    pointer: crate::input::PointerId::MOUSE,
                    position: crate::input::InputPoint::new(-10.0, -10.0),
                },
                320.0,
                200.0,
            )
            .expect("background pointer move");
        let outcome = runtime
            .handle_input(
                InputEvent::PointerButton {
                    pointer: crate::input::PointerId::MOUSE,
                    button: PointerButton::Primary,
                    state: ButtonState::Pressed,
                },
                320.0,
                200.0,
            )
            .expect("background press");
        assert!(outcome.focus_changed);
        assert_eq!(runtime.focused_action(), None);
    }

    #[test]
    fn duplicate_primary_press_does_not_retarget_pointer_capture_or_focus() {
        let mut runtime = Runtime::from_json(TWO_ACTIONS).expect("valid input UI program");
        let scene = runtime.build_scene(320.0, 200.0).expect("input scene");
        let first = scene
            .actions
            .iter()
            .find(|action| action.id == "first")
            .expect("first action");
        let second = scene
            .actions
            .iter()
            .find(|action| action.id == "second")
            .expect("second action");
        let pointer = crate::input::PointerId(31);
        let center = |action: &crate::scene::ActionHit| {
            crate::input::InputPoint::new(
                action.rect.x + action.rect.width * 0.5,
                action.rect.y + action.rect.height * 0.5,
            )
        };

        runtime
            .handle_input(
                InputEvent::PointerMoved {
                    pointer,
                    position: center(first),
                },
                320.0,
                200.0,
            )
            .expect("move to first");
        runtime
            .handle_input(
                InputEvent::PointerButton {
                    pointer,
                    button: PointerButton::Primary,
                    state: ButtonState::Pressed,
                },
                320.0,
                200.0,
            )
            .expect("first press");
        assert_eq!(runtime.primary_pressed_action(pointer), Some("first"));
        assert_eq!(runtime.focused_action(), Some("first"));

        runtime
            .handle_input(
                InputEvent::PointerMoved {
                    pointer,
                    position: center(second),
                },
                320.0,
                200.0,
            )
            .expect("move to second");
        let duplicate = runtime
            .handle_input(
                InputEvent::PointerButton {
                    pointer,
                    button: PointerButton::Primary,
                    state: ButtonState::Pressed,
                },
                320.0,
                200.0,
            )
            .expect("duplicate press");

        assert!(duplicate.handled);
        assert!(!duplicate.pressed_changed);
        assert_eq!(runtime.primary_pressed_action(pointer), Some("first"));
        assert_eq!(runtime.focused_action(), Some("first"));

        let release = runtime
            .handle_input(
                InputEvent::PointerButton {
                    pointer,
                    button: PointerButton::Primary,
                    state: ButtonState::Released,
                },
                320.0,
                200.0,
            )
            .expect("release over second");
        assert!(release.handled);
        assert!(!release.activated);
        assert_eq!(runtime.primary_pressed_action(pointer), None);
    }

    #[test]
    fn pointer_capture_activates_only_when_released_over_the_pressed_action() {
        let mut runtime = Runtime::from_json(TWO_ACTIONS).expect("valid input UI program");
        let scene = runtime.build_scene(320.0, 200.0).expect("input scene");
        let first = scene
            .actions
            .iter()
            .find(|action| action.id == "first")
            .expect("first action");
        let point = crate::input::InputPoint::new(
            first.rect.x + first.rect.width * 0.5,
            first.rect.y + first.rect.height * 0.5,
        );
        let pointer = crate::input::PointerId(9);

        runtime
            .handle_input(
                InputEvent::PointerMoved {
                    pointer,
                    position: point,
                },
                320.0,
                200.0,
            )
            .expect("pointer move");
        runtime
            .handle_input(
                InputEvent::PointerButton {
                    pointer,
                    button: PointerButton::Primary,
                    state: ButtonState::Pressed,
                },
                320.0,
                200.0,
            )
            .expect("pointer press");
        assert_eq!(runtime.primary_pressed_action(pointer), Some("first"));

        runtime
            .handle_input(
                InputEvent::PointerMoved {
                    pointer,
                    position: crate::input::InputPoint::new(-20.0, -20.0),
                },
                320.0,
                200.0,
            )
            .expect("drag outside");
        let outcome = runtime
            .handle_input(
                InputEvent::PointerButton {
                    pointer,
                    button: PointerButton::Primary,
                    state: ButtonState::Released,
                },
                320.0,
                200.0,
            )
            .expect("release outside");
        assert!(outcome.handled);
        assert!(!outcome.activated);
        assert!(outcome.pressed_changed);
        assert_eq!(runtime.state.get("armed"), Some(&Value::Bool(false)));
        assert_eq!(runtime.primary_pressed_action(pointer), None);
    }

    #[test]
    fn pointer_cancel_clears_capture_without_activation() {
        let mut runtime = Runtime::from_json(TWO_ACTIONS).expect("valid input UI program");
        let scene = runtime.build_scene(320.0, 200.0).expect("input scene");
        let first = scene
            .actions
            .iter()
            .find(|action| action.id == "first")
            .expect("first action");
        let point = crate::input::InputPoint::new(
            first.rect.x + first.rect.width * 0.5,
            first.rect.y + first.rect.height * 0.5,
        );
        let pointer = crate::input::PointerId(11);

        runtime
            .handle_input(
                InputEvent::PointerMoved {
                    pointer,
                    position: point,
                },
                320.0,
                200.0,
            )
            .expect("pointer move");
        runtime
            .handle_input(
                InputEvent::PointerButton {
                    pointer,
                    button: PointerButton::Primary,
                    state: ButtonState::Pressed,
                },
                320.0,
                200.0,
            )
            .expect("pointer press");

        let outcome = runtime
            .handle_input(
                InputEvent::Cancel {
                    pointer: Some(pointer),
                },
                320.0,
                200.0,
            )
            .expect("pointer cancel");
        assert!(outcome.handled);
        assert!(outcome.pressed_changed);
        assert!(!outcome.activated);
        assert_eq!(runtime.primary_pressed_action(pointer), None);
        assert_eq!(runtime.state.get("armed"), Some(&Value::Bool(false)));
    }

    #[test]
    fn state_mutation_prunes_pointer_capture_for_removed_action() {
        let mut runtime =
            Runtime::from_json(REMOVE_LAST_FOCUSED_ACTION).expect("valid focus removal program");
        let scene = runtime.build_scene(320.0, 200.0).expect("input scene");
        let remove = scene
            .actions
            .iter()
            .find(|action| action.id == "remove")
            .expect("remove action");
        let point = crate::input::InputPoint::new(
            remove.rect.x + remove.rect.width * 0.5,
            remove.rect.y + remove.rect.height * 0.5,
        );
        let pointer = crate::input::PointerId(23);

        runtime
            .handle_input(
                InputEvent::PointerMoved {
                    pointer,
                    position: point,
                },
                320.0,
                200.0,
            )
            .expect("pointer move");
        runtime
            .handle_input(
                InputEvent::PointerButton {
                    pointer,
                    button: PointerButton::Primary,
                    state: ButtonState::Pressed,
                },
                320.0,
                200.0,
            )
            .expect("pointer press");
        assert_eq!(runtime.primary_pressed_action(pointer), Some("remove"));

        runtime
            .activate_action("stable")
            .expect("stable action removes captured peer");

        assert_eq!(runtime.focused_action(), Some("stable"));
        assert_eq!(runtime.primary_pressed_action(pointer), None);

        let release = runtime
            .handle_input(
                InputEvent::PointerButton {
                    pointer,
                    button: PointerButton::Primary,
                    state: ButtonState::Released,
                },
                320.0,
                200.0,
            )
            .expect("release after semantic removal");
        assert!(!release.handled);
        assert!(!release.activated);
    }

    #[test]
    fn conditional_fragments_expose_only_the_active_branch() {
        let mut runtime =
            Runtime::from_json(CONDITIONAL_BRANCH).expect("valid conditional UI program");
        let branch_instance = runtime
            .retained_tree()
            .node("branch")
            .expect("retained conditional")
            .instance_id;
        assert!(
            !runtime
                .retained_tree()
                .node("branch")
                .expect("retained conditional")
                .has_layout_box()
        );
        assert_eq!(
            runtime
                .retained_tree()
                .node("branch")
                .expect("retained conditional")
                .children,
            vec!["collapsed-action"]
        );

        let collapsed = runtime.build_frame(320.0, 200.0).expect("collapsed frame");
        assert_eq!(
            collapsed.accessibility.node("root").unwrap().children,
            vec!["collapsed-action"]
        );
        assert!(collapsed.accessibility.node("branch").is_none());
        assert_eq!(
            collapsed
                .scene
                .actions
                .iter()
                .map(|action| action.id.as_str())
                .collect::<Vec<_>>(),
            vec!["collapsed-action"]
        );
        assert!(!runtime.focus_action("expanded-action"));
        assert!(runtime.focus_action("collapsed-action"));

        runtime
            .activate_focused()
            .expect("collapsed action toggles state");
        assert_eq!(runtime.focused_action(), Some("expanded-action"));
        assert_eq!(
            runtime
                .retained_tree()
                .node("branch")
                .expect("retained conditional")
                .instance_id,
            branch_instance
        );
        assert!(runtime.retained_tree().node("collapsed-action").is_none());
        assert!(runtime.retained_tree().node("expanded-action").is_some());
        assert_eq!(
            runtime.last_reconciliation().inserted,
            vec!["expanded-action"]
        );
        assert_eq!(
            runtime.last_reconciliation().removed,
            vec!["collapsed-action"]
        );
        assert_eq!(
            runtime.last_reconciliation().children_changed,
            vec!["branch"]
        );

        let expanded = runtime.build_frame(320.0, 200.0).expect("expanded frame");
        assert_eq!(
            expanded.accessibility.focus_id.as_deref(),
            Some("expanded-action")
        );
        assert_eq!(
            expanded.accessibility.node("root").unwrap().children,
            vec!["expanded-action"]
        );
        assert_eq!(
            expanded
                .scene
                .actions
                .iter()
                .map(|action| action.id.as_str())
                .collect::<Vec<_>>(),
            vec!["expanded-action"]
        );
        assert!(runtime.focus_action("expanded-action"));
        assert!(!runtime.focus_action("collapsed-action"));
    }

    #[test]
    fn focused_removal_falls_back_to_previous_action_when_no_same_slot_remains() {
        let mut runtime =
            Runtime::from_json(REMOVE_LAST_FOCUSED_ACTION).expect("valid focus removal program");
        assert!(runtime.focus_action("remove"));

        runtime
            .activate_focused()
            .expect("focused removal action toggles state");

        assert_eq!(runtime.focused_action(), Some("stable"));
        let tree = runtime
            .build_accessibility_tree(320.0, 200.0)
            .expect("accessibility tree after focus removal");
        assert_eq!(tree.focus_id.as_deref(), Some("stable"));
        assert!(tree.node("remove").is_none());
        assert!(tree.node("stable").expect("stable action").focused);
    }

    const STRUCTURAL_FLIP: &str = r##"{
      "version":1,
      "sourceLanguage":"mun",
      "entry":"StructuralFlip",
      "states":[{"name":"visible","initial":true}],
      "root":{"kind":"window","id":"root","title":"Structural FLIP","child":{
        "kind":"column","id":"stack","layout":{"spacing":10},"children":[
          {"kind":"action","id":"toggle","label":"Toggle","action":{"kind":"toggle-state","state":"visible","transaction":{"animation":{"kind":"timing","duration":0.2,"curve":[0.0,0.0,1.0,1.0],"delayMs":0.0,"repeatCount":1,"autoreverses":false},"disablesAnimations":false,"isContinuous":false}}},
          {"kind":"conditional","id":"branch","condition":{"kind":"state","state":"visible"},"then":[
            {"kind":"panel","id":"inserted","layout":{"width":{"kind":"literal","value":120},"height":{"kind":"literal","value":60}},"visual":{"background":"#6750A4"}}
          ],"otherwise":[]},
          {"kind":"action","id":"stable","label":"Stable","action":{"kind":"toggle-state","state":"visible"}}
        ]
      }}
    }"##;

    #[test]
    fn animated_structural_mutation_flip_preserves_stable_sibling_presentation() {
        let mut runtime =
            Runtime::from_json(STRUCTURAL_FLIP).expect("valid structural FLIP program");
        let initial = runtime.build_frame(320.0, 240.0).expect("initial frame");
        let before_hit = initial
            .scene
            .actions
            .iter()
            .find(|item| item.id == "stable")
            .expect("stable action before mutation")
            .rect;
        let before_accessible = initial
            .accessibility
            .node("stable")
            .expect("stable accessible node before mutation")
            .bounds;
        assert!((before_hit.y - before_accessible.y).abs() < 0.01);

        let transaction = runtime
            .activate_action("toggle")
            .expect("toggle structural branch");
        assert!(transaction.animation.is_some());
        assert!(runtime.has_active_motion());

        let first = runtime.build_frame(320.0, 240.0).expect("first FLIP frame");
        let first_hit = first
            .scene
            .actions
            .iter()
            .find(|item| item.id == "stable")
            .expect("stable action during FLIP")
            .rect;
        let first_accessible = first
            .accessibility
            .node("stable")
            .expect("stable accessible node during FLIP")
            .bounds;
        assert!((first_hit.y - before_hit.y).abs() < 0.01);
        assert!((first_accessible.y - before_accessible.y).abs() < 0.01);

        runtime.step(0.1);
        let middle = runtime
            .build_frame(320.0, 240.0)
            .expect("middle FLIP frame");
        let middle_hit = middle
            .scene
            .actions
            .iter()
            .find(|item| item.id == "stable")
            .expect("stable action mid-flight")
            .rect;
        assert!(middle_hit.y < before_hit.y);

        runtime.step(0.2);
        let final_frame = runtime
            .build_frame(320.0, 240.0)
            .expect("settled FLIP frame");
        let final_hit = final_frame
            .scene
            .actions
            .iter()
            .find(|item| item.id == "stable")
            .expect("stable action after FLIP")
            .rect;
        let final_accessible = final_frame
            .accessibility
            .node("stable")
            .expect("stable accessible node after FLIP")
            .bounds;
        assert!(final_hit.y < middle_hit.y);
        assert!(final_hit.y < before_hit.y - 50.0);
        assert!((final_hit.y - final_accessible.y).abs() < 0.01);
    }

    #[test]
    fn interrupted_structural_flip_retargets_from_current_presentation_geometry() {
        let mut runtime =
            Runtime::from_json(STRUCTURAL_FLIP).expect("valid structural FLIP program");
        let initial = runtime.build_frame(320.0, 240.0).expect("initial frame");
        let initial_y = initial
            .scene
            .actions
            .iter()
            .find(|item| item.id == "stable")
            .expect("stable action initially")
            .rect
            .y;

        runtime
            .activate_action("toggle")
            .expect("start removal FLIP");
        runtime.step(0.08);
        let interrupted = runtime
            .build_frame(320.0, 240.0)
            .expect("interrupted frame");
        let interrupted_y = interrupted
            .scene
            .actions
            .iter()
            .find(|item| item.id == "stable")
            .expect("stable action during first FLIP")
            .rect
            .y;
        assert!(interrupted_y < initial_y);

        runtime
            .activate_action("toggle")
            .expect("reverse structural FLIP");
        let retargeted = runtime.build_frame(320.0, 240.0).expect("retargeted frame");
        let retargeted_y = retargeted
            .scene
            .actions
            .iter()
            .find(|item| item.id == "stable")
            .expect("stable action after retarget")
            .rect
            .y;
        assert!(
            (retargeted_y - interrupted_y).abs() < 0.01,
            "retarget jumped: interrupted={interrupted_y}, retargeted={retargeted_y}, initial={initial_y}"
        );

        runtime.step(0.1);
        let returning = runtime.build_frame(320.0, 240.0).expect("returning frame");
        let returning_y = returning
            .scene
            .actions
            .iter()
            .find(|item| item.id == "stable")
            .expect("stable action while returning")
            .rect
            .y;
        assert!(returning_y > interrupted_y && returning_y < initial_y);

        runtime.step(0.2);
        let settled = runtime
            .build_frame(320.0, 240.0)
            .expect("settled reverse frame");
        let settled_y = settled
            .scene
            .actions
            .iter()
            .find(|item| item.id == "stable")
            .expect("stable action after reverse")
            .rect
            .y;
        assert!((settled_y - initial_y).abs() < 0.01);
    }

    #[test]
    fn structural_mutation_without_animation_snaps_instead_of_starting_flip() {
        let mut value: Value = serde_json::from_str(STRUCTURAL_FLIP).expect("parse FLIP fixture");
        value["root"]["child"]["children"][0]["action"]
            .as_object_mut()
            .expect("toggle action")
            .remove("transaction");
        let source = serde_json::to_string(&value).expect("serialize unanimated FLIP fixture");
        let mut runtime = Runtime::from_json(&source).expect("valid unanimated FLIP program");
        let initial = runtime.build_frame(320.0, 240.0).expect("initial frame");
        let before_y = initial
            .scene
            .actions
            .iter()
            .find(|item| item.id == "stable")
            .expect("stable action before mutation")
            .rect
            .y;

        let transaction = runtime
            .activate_action("toggle")
            .expect("toggle structural branch without animation");
        assert!(transaction.animation.is_none());
        assert!(!runtime.has_active_motion());

        let snapped = runtime.build_frame(320.0, 240.0).expect("snapped frame");
        let snapped_y = snapped
            .scene
            .actions
            .iter()
            .find(|item| item.id == "stable")
            .expect("stable action after snap")
            .rect
            .y;
        assert!(snapped_y < before_y - 50.0);
    }

    const TRANSITION_PRESENCE: &str = r#"{
      "version":1,
      "sourceLanguage":"mun",
      "entry":"TransitionPresence",
      "states":[{"name":"visible","initial":true}],
      "root":{"kind":"window","id":"root","title":"Transition Presence","child":{
        "kind":"conditional","id":"branch","condition":{"kind":"state","state":"visible"},
        "then":[{"kind":"action","id":"transient","label":"Hide","action":{"kind":"toggle-state","state":"visible"},
          "transition":{"insertion":[{"kind":"opacity"},{"kind":"scale","scale":0.8},{"kind":"move","edge":"bottom","distance":20}],
                        "removal":[{"kind":"opacity"},{"kind":"scale","scale":0.8},{"kind":"move","edge":"bottom","distance":20}],
                        "animation":{"kind":"timing","duration":0.2,"curve":[0.0,0.0,1.0,1.0],"delayMs":100.0,"repeatCount":1,"autoreverses":false}}}],
        "otherwise":[{"kind":"action","id":"show","label":"Show","action":{"kind":"toggle-state","state":"visible"}}]
      }}
    }"#;

    #[test]
    fn transition_presence_keeps_only_visual_exit_authority_and_animates_reentry() {
        let mut runtime =
            Runtime::from_json(TRANSITION_PRESENCE).expect("valid transition program");
        let initial = runtime.build_frame(320.0, 200.0).expect("initial frame");
        let initial_action = initial
            .scene
            .actions
            .iter()
            .find(|action| action.id == "transient")
            .expect("initial transition action");
        let initial_rect = initial_action.rect;
        assert!(initial.accessibility.node("transient").is_some());

        runtime
            .activate_action("transient")
            .expect("hide transient view");
        let removed = runtime
            .build_frame(320.0, 200.0)
            .expect("exit overlay frame");
        assert!(removed.accessibility.node("transient").is_none());
        assert!(
            removed
                .scene
                .actions
                .iter()
                .all(|action| action.id != "transient")
        );
        let outgoing = removed
            .scene
            .rects
            .iter()
            .find(|item| item.id == "transient:background")
            .expect("visual-only exit snapshot");
        assert!((outgoing.rect.y - initial_rect.y).abs() < 0.01);
        assert!((outgoing.rect.width - initial_rect.width).abs() < 0.01);
        assert!((outgoing.color.0[3] - 1.0).abs() < 0.01);

        runtime.step(0.2);
        let leaving = runtime
            .build_frame(320.0, 200.0)
            .expect("in-flight exit overlay");
        let outgoing = leaving
            .scene
            .rects
            .iter()
            .find(|item| item.id == "transient:background")
            .expect("still leaving");
        assert!(outgoing.rect.y > initial_rect.y && outgoing.rect.y < initial_rect.y + 20.0);
        assert!(
            outgoing.rect.width > initial_rect.width * 0.8
                && outgoing.rect.width < initial_rect.width
        );
        assert!(outgoing.color.0[3] > 0.0 && outgoing.color.0[3] < 1.0);

        runtime.step(0.2);
        let gone = runtime.build_frame(320.0, 200.0).expect("exit complete");
        assert!(
            gone.scene
                .rects
                .iter()
                .all(|item| item.id != "transient:background")
        );

        runtime
            .activate_action("show")
            .expect("show transient view");
        let entering = runtime.build_frame(320.0, 200.0).expect("entry start");
        let incoming = entering
            .scene
            .rects
            .iter()
            .find(|item| item.id == "transient:background")
            .expect("entering live view");
        let expected_entry_y = initial_rect.y + initial_rect.height * 0.1 + 16.0;
        assert!((incoming.rect.y - expected_entry_y).abs() < 0.01);
        assert!((incoming.rect.width - initial_rect.width * 0.8).abs() < 0.01);
        assert!(incoming.color.0[3].abs() < 0.01);
        let hit = entering
            .scene
            .actions
            .iter()
            .find(|action| action.id == "transient")
            .expect("entering hit target");
        assert!((hit.rect.x - incoming.rect.x).abs() < 0.01);
        assert!((hit.rect.y - incoming.rect.y).abs() < 0.01);
        assert!((hit.rect.width - incoming.rect.width).abs() < 0.01);
        assert!((hit.rect.height - incoming.rect.height).abs() < 0.01);
        let accessible = entering
            .accessibility
            .node("transient")
            .expect("entering semantic node");
        assert!((accessible.bounds.x - incoming.rect.x).abs() < 0.01);
        assert!((accessible.bounds.y - incoming.rect.y).abs() < 0.01);
        assert!((accessible.bounds.width - incoming.rect.width).abs() < 0.01);
        assert!((accessible.bounds.height - incoming.rect.height).abs() < 0.01);

        runtime.step(0.4);
        let entered = runtime.build_frame(320.0, 200.0).expect("entry complete");
        let incoming = entered
            .scene
            .rects
            .iter()
            .find(|item| item.id == "transient:background")
            .expect("entered live view");
        assert!((incoming.rect.y - initial_rect.y).abs() < 0.01);
        assert!((incoming.rect.width - initial_rect.width).abs() < 0.01);
        assert!((incoming.color.0[3] - 1.0).abs() < 0.01);
    }

    #[test]
    fn transition_effect_order_matches_web_transform_composition() {
        let scale_then_move = transition_presence_values(
            &[
                TransitionEffect::Scale { scale: 0.5 },
                TransitionEffect::Move {
                    edge: TransitionEdge::Right,
                    distance: 20.0,
                },
            ],
            0.0,
        );
        let move_then_scale = transition_presence_values(
            &[
                TransitionEffect::Move {
                    edge: TransitionEdge::Right,
                    distance: 20.0,
                },
                TransitionEffect::Scale { scale: 0.5 },
            ],
            0.0,
        );
        assert!((scale_then_move.scale - 0.5).abs() < 1e-5);
        assert!((scale_then_move.translation_x - 10.0).abs() < 1e-5);
        assert!((move_then_scale.scale - 0.5).abs() < 1e-5);
        assert!((move_then_scale.translation_x - 20.0).abs() < 1e-5);
    }

    const DEFAULT_TRANSITION_PRESENCE: &str = r#"{
      "version":1,
      "sourceLanguage":"mun",
      "entry":"DefaultTransitionPresence",
      "states":[{"name":"visible","initial":true}],
      "root":{"kind":"window","id":"root","title":"Default Transition","child":{
        "kind":"conditional","id":"branch","condition":{"kind":"state","state":"visible"},
        "then":[{"kind":"action","id":"default-hide","label":"Hide","action":{"kind":"toggle-state","state":"visible"},
          "transition":{"insertion":[{"kind":"opacity"}],"removal":[{"kind":"opacity"}]}}],
        "otherwise":[]
      }}
    }"#;

    #[test]
    fn transition_without_explicit_animation_uses_core_default_spring() {
        let mut runtime = Runtime::from_json(DEFAULT_TRANSITION_PRESENCE)
            .expect("valid default transition program");
        runtime
            .build_frame(320.0, 200.0)
            .expect("prime live snapshot");
        runtime
            .activate_action("default-hide")
            .expect("remove default transition view");
        assert!(runtime.has_active_motion());

        runtime.step(0.05);
        let leaving = runtime
            .build_frame(320.0, 200.0)
            .expect("default spring exit");
        let outgoing = leaving
            .scene
            .rects
            .iter()
            .find(|item| item.id == "default-hide:background")
            .expect("default transition keeps visual exit snapshot");
        assert!(outgoing.color.0[3] < 1.0);

        for _ in 0..360 {
            if !runtime.step(1.0 / 120.0) {
                break;
            }
        }
        let gone = runtime
            .build_frame(320.0, 200.0)
            .expect("default transition settled");
        assert!(
            gone.scene
                .rects
                .iter()
                .all(|item| item.id != "default-hide:background")
        );
    }

    const CONDITIONAL_MOTION_REENTRY: &str = r#"{"version":1,"sourceLanguage":"mun","entry":"MotionBranch","states":[{"name":"visible","initial":true},{"name":"wide","initial":false}],"root":{"kind":"window","id":"root","title":"Motion Branch","child":{"kind":"column","id":"content","children":[{"kind":"action","id":"toggle-wide","label":"Wide","action":{"kind":"toggle-state","state":"wide"}},{"kind":"action","id":"toggle-visible","label":"Visible","action":{"kind":"toggle-state","state":"visible"}},{"kind":"conditional","id":"branch","condition":{"kind":"state","state":"visible"},"then":[{"kind":"panel","id":"panel","layout":{"width":{"kind":"conditional","condition":{"kind":"state","state":"wide"},"then":{"kind":"literal","value":200},"otherwise":{"kind":"literal","value":100}},"height":{"kind":"literal","value":40}},"motion":[{"property":"width","propertyMask":512,"value":{"kind":"conditional","condition":{"kind":"state","state":"wide"},"then":{"kind":"literal","value":200},"otherwise":{"kind":"literal","value":100}},"plan":{"kind":"timing","duration":1.0,"curve":[0.0,0.0,1.0,1.0],"delayMs":0.0,"repeatCount":1,"autoreverses":false}}]}],"otherwise":[]}]}}}"#;

    #[test]
    fn conditional_reentry_does_not_revive_stale_motion_presentation() {
        let mut runtime = Runtime::from_json(CONDITIONAL_MOTION_REENTRY)
            .expect("valid conditional motion program");

        runtime
            .activate_action("toggle-wide")
            .expect("width action starts motion");
        let animating = runtime.build_frame(480.0, 320.0).expect("animating frame");
        assert_eq!(
            animating
                .accessibility
                .node("panel")
                .expect("visible panel")
                .bounds
                .width,
            100.0
        );

        runtime
            .activate_action("toggle-visible")
            .expect("hide branch");
        assert!(
            runtime
                .build_frame(480.0, 320.0)
                .expect("hidden frame")
                .accessibility
                .node("panel")
                .is_none()
        );

        runtime
            .activate_action("toggle-visible")
            .expect("show branch");
        let restored = runtime.build_frame(480.0, 320.0).expect("restored frame");
        assert_eq!(
            restored
                .accessibility
                .node("panel")
                .expect("restored panel")
                .bounds
                .width,
            200.0
        );
    }
}
