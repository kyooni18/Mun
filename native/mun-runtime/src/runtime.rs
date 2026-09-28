use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
};

use serde_json::Value;
use taffy::prelude::*;
use thiserror::Error;

use crate::{
    accessibility::{AccessibilityBounds, AccessibilityNode, AccessibilityTree},
    ir::{
        AccessibilityRole, MotionExecutionPlan, MotionProperty, TransitionEdge, TransitionEffect,
        UiAction, UiAlignment, UiBinaryOperator, UiExpression, UiNode, UiProgram, UiTransition,
    },
    motion::{MotionChannelKey, MotionScheduler},
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
        UiBinaryOperator::LessOrEqual => ordered_comparison(&left, &right, |a, b| a <= b, |a, b| a <= b),
        UiBinaryOperator::Greater => ordered_comparison(&left, &right, |a, b| a > b, |a, b| a > b),
        UiBinaryOperator::GreaterOrEqual => ordered_comparison(&left, &right, |a, b| a >= b, |a, b| a >= b),
        UiBinaryOperator::And => Value::Bool(left.as_bool().unwrap_or(false) && right.as_bool().unwrap_or(false)),
        UiBinaryOperator::Or => Value::Bool(left.as_bool().unwrap_or(false) || right.as_bool().unwrap_or(false)),
    }
}
pub struct Runtime {
    pub program: UiProgram,
    state: HashMap<String, Value>,
    motion: MotionScheduler,
    revision: u64,
    focused_action: Option<String>,
    entering: HashMap<String, EnterPresence>,
    exiting: HashMap<String, ExitPresence>,
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
        let state = program
            .states
            .iter()
            .map(|item| (item.name.clone(), item.initial.clone()))
            .collect();
        Ok(Self {
            program,
            state,
            motion: MotionScheduler::default(),
            revision: 0,
            focused_action: None,
            entering: HashMap::new(),
            exiting: HashMap::new(),
            last_live_scene: RefCell::new(None),
            last_live_accessibility: RefCell::new(None),
        })
    }

    pub fn title(&self) -> &str {
        &self.program.root.title
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
        self.has_active_motion()
    }

    pub fn has_active_motion(&self) -> bool {
        self.motion.is_active() || !self.entering.is_empty() || !self.exiting.is_empty()
    }

    pub fn focused_action(&self) -> Option<&str> {
        self.focused_action.as_deref()
    }

    pub fn clear_focus(&mut self) {
        self.focused_action = None;
    }

    fn reconcile_focus(&mut self) {
        let focus_is_invalid = match self.focused_action.as_deref() {
            Some(id) => find_action(&self.program.root.child, self, id)
                .map(|(_, base)| !self.node_enabled(base))
                .unwrap_or(true),
            None => false,
        };
        if focus_is_invalid {
            self.focused_action = None;
        }
    }

    pub fn focus_action(&mut self, id: &str) -> bool {
        let Some((_, base)) = find_action(&self.program.root.child, self, id) else {
            return false;
        };
        if !self.node_enabled(base) {
            return false;
        }
        self.focused_action = Some(id.to_owned());
        true
    }

    pub fn focus_next_action(&mut self, backwards: bool) -> Option<String> {
        let mut actions = Vec::new();
        collect_focusable_actions(&self.program.root.child, self, &mut actions);
        if actions.is_empty() {
            self.focused_action = None;
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
        let before_presence = self.active_transition_roots();
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

        // State mutations can change the focused action's enabled semantics.
        // Never expose a disabled/stale action as keyboard or accessibility focus.
        self.reconcile_focus();

        self.revision = transaction.revision;
        let after = self.motion_targets();
        for (key, next) in after {
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

        Some(transaction)
    }

    pub fn build_frame(&self, width: f32, height: f32) -> Result<RuntimeFrame, taffy::TaffyError> {
        let (taffy, nodes) = self.build_layout_tree(width, height)?;
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

    pub fn build_accessibility_tree(
        &self,
        width: f32,
        height: f32,
    ) -> Result<AccessibilityTree, taffy::TaffyError> {
        let (taffy, nodes) = self.build_layout_tree(width, height)?;
        let mut accessibility = self.accessibility_from_layout(&taffy, &nodes, width, height)?;
        let mut empty_scene = Scene::default();
        self.apply_enter_presence(&mut empty_scene, &mut accessibility);
        Ok(accessibility)
    }

    fn accessibility_from_layout(
        &self,
        taffy: &TaffyTree<()>,
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
    ) -> Result<(TaffyTree<()>, HashMap<String, NodeId>), taffy::TaffyError> {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let mut nodes = HashMap::new();
        let children = self.build_layout_nodes(&mut taffy, &self.program.root.child, &mut nodes)?;
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
        taffy.compute_layout(
            wrapper,
            Size {
                width: AvailableSpace::Definite(width),
                height: AvailableSpace::Definite(height),
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
        taffy: &mut TaffyTree<()>,
        node: &UiNode,
        nodes: &mut HashMap<String, NodeId>,
    ) -> Result<Vec<NodeId>, taffy::TaffyError> {
        if matches!(node, UiNode::Conditional { .. }) {
            let mut output = Vec::new();
            for child in self.active_children(node) {
                output.extend(self.build_layout_nodes(taffy, child, nodes)?);
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
            UiNode::Text { .. } => {
                if width.is_none() {
                    style.size.width = Dimension::length(240.0);
                }
                if height.is_none() {
                    style.size.height = Dimension::length(32.0);
                }
            }
            UiNode::Action { label, .. } => {
                if width.is_none() {
                    style.size.width =
                        Dimension::length((label.chars().count() as f32 * 9.0 + 34.0).max(92.0));
                }
                if height.is_none() {
                    style.size.height = Dimension::length(38.0);
                }
            }
            UiNode::Panel { .. } => {
                if width.is_none() {
                    style.size.width = Dimension::length(160.0);
                }
                if height.is_none() {
                    style.size.height = Dimension::length(96.0);
                }
            }
            UiNode::Conditional { .. } => unreachable!("conditional fragments are flattened above"),
        }

        let mut children = Vec::new();
        for child in self.active_children(node) {
            children.extend(self.build_layout_nodes(taffy, child, nodes)?);
        }
        let id = if children.is_empty() {
            taffy.new_leaf(style)?
        } else {
            taffy.new_with_children(style, &children)?
        };
        nodes.insert(base.id.clone(), id);
        Ok(vec![id])
    }

    fn collect_scene(
        &self,
        taffy: &TaffyTree<()>,
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
        taffy: &TaffyTree<()>,
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

    const CONDITIONAL_BRANCH: &str = r#"{"version":1,"sourceLanguage":"mun","entry":"ConditionalTest","states":[{"name":"expanded","initial":false}],"root":{"kind":"window","id":"root","title":"Conditional","child":{"kind":"conditional","id":"branch","condition":{"kind":"state","state":"expanded"},"then":[{"kind":"action","id":"expanded-action","label":"Expanded","action":{"kind":"toggle-state","state":"expanded"}}],"otherwise":[{"kind":"action","id":"collapsed-action","label":"Collapsed","action":{"kind":"toggle-state","state":"expanded"}}]}}}"#;

    #[test]
    fn conditional_fragments_expose_only_the_active_branch() {
        let mut runtime =
            Runtime::from_json(CONDITIONAL_BRANCH).expect("valid conditional UI program");

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
        assert_eq!(runtime.focused_action(), None);

        let expanded = runtime.build_frame(320.0, 200.0).expect("expanded frame");
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
