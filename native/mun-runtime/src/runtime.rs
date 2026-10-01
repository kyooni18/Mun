use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    rc::Rc,
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
        UiAction, UiAlignment, UiBinaryOperator, UiExpression, UiNode, UiOverlayAlignment, UiPaint,
        UiProgram, UiShapeKind, UiTransition,
    },
    layout::{FallbackIntrinsicMeasurer, IntrinsicMeasurer, IntrinsicSize},
    motion::{MotionChannelKey, MotionScheduler},
    retained::{
        RetainedIdentityKey, RetainedNodeKind, RetainedNodeSpec, RetainedReconciliation,
        RetainedTree,
    },
    scene::{
        ActionHit, Color, LinearGradient as SceneLinearGradient, Rect as SceneBounds, Scene,
        SceneGradient, SceneRect, SceneText,
    },
};

pub const SEMANTIC_UI_IR_VERSION: u32 = 1;

const TEXT_FIELD_FONT_SIZE: f32 = 16.0;
const TEXT_FIELD_INSET_X: f32 = 12.0;
const TEXT_FIELD_INSET_Y: f32 = 7.0;
const TEXT_CARET_WIDTH: f32 = 1.5;

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
    #[error("invalid Mün keyed collection: {0}")]
    Collection(crate::collection::CollectionError),
    #[error("Mün Semantic UI IR violates the v1 contract: {0}")]
    Invalid(#[from] crate::validate::IrValidationError),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GeometryStamp {
    revision: u64,
    width: u32,
    height: u32,
    offsets: u64,
}

/// Runtime-detected contract violations that were rejected without effect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeDiagnostic {
    /// A transaction would have produced an invalid keyed collection (duplicate
    /// or invalid keys); all of its mutations were rolled back.
    RejectedTransaction {
        action: Option<String>,
        error: crate::collection::CollectionError,
    },
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
    /// Caret rectangle of the focused editable field in window logical
    /// coordinates, for platform IME candidate/preedit placement.
    pub ime_cursor_area: Option<SceneBounds>,
}

#[derive(Clone, Copy, Debug)]
enum ScrollCommand {
    Lines(f32),
    Pages(f32),
    ToStart,
    ToEnd,
}

/// Platform-adapter requests about text input services.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImeRequest {
    /// The runtime deliberately finished (committed or cancelled) the active
    /// composition, e.g. on pointer relocation or focus change. The platform
    /// input context must discard its own marked text so the IME does not keep
    /// composing a syllable that no longer exists in the application.
    DiscardComposition,
}

/// Editing key conventions supplied by the platform adapter. Semantics stay in
/// the runtime; only the modifier that selects word/line granularity differs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlatformConventions {
    /// macOS: Option+Arrow moves by word, Command+Arrow to line edges.
    /// Windows/Linux: Control+Arrow moves by word.
    pub apple_text_navigation: bool,
}

impl PlatformConventions {
    /// Conventions of the platform this binary was compiled for.
    pub fn native() -> Self {
        Self {
            apple_text_navigation: cfg!(target_os = "macos"),
        }
    }
}

impl Default for PlatformConventions {
    fn default() -> Self {
        Self {
            apple_text_navigation: false,
        }
    }
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

/// Canonical number text shared with the web adapter (ECMAScript `String(n)`
/// for the finite range Mün produces): integral values print without a
/// fractional part, so `10 + 1` renders as "11", never "11.0".
pub(crate) fn number_string(value: &serde_json::Number) -> String {
    match value.as_f64() {
        Some(number) if number.is_finite() && number.fract() == 0.0 && number.abs() < 1e21 => {
            format!("{:.0}", if number == 0.0 { 0.0 } else { number })
        }
        Some(number) if number.is_finite() => number.to_string(),
        _ => value.to_string(),
    }
}

pub(crate) fn scalar_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => number_string(value),
        other => other.to_string(),
    }
}

fn numeric_result(value: f64) -> Value {
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn paint_start_color(paint: &UiPaint) -> Option<Color> {
    match paint {
        UiPaint::Solid { color } => Color::parse(color),
        UiPaint::LinearGradient { start, .. } => Color::parse(start),
    }
}

fn unit_point(point: UiOverlayAlignment) -> [f32; 2] {
    match point {
        UiOverlayAlignment::Center => [0.5, 0.5],
        UiOverlayAlignment::Leading => [0.0, 0.5],
        UiOverlayAlignment::Trailing => [1.0, 0.5],
        UiOverlayAlignment::Top => [0.5, 0.0],
        UiOverlayAlignment::Bottom => [0.5, 1.0],
        UiOverlayAlignment::TopLeading => [0.0, 0.0],
        UiOverlayAlignment::TopTrailing => [1.0, 0.0],
        UiOverlayAlignment::BottomLeading => [0.0, 1.0],
        UiOverlayAlignment::BottomTrailing => [1.0, 1.0],
    }
}

fn scene_gradient(paint: &UiPaint, opacity: f32) -> Option<SceneLinearGradient> {
    let UiPaint::LinearGradient {
        start,
        end,
        start_point,
        end_point,
    } = paint
    else {
        return None;
    };
    Some(SceneLinearGradient {
        start: Color::parse(start)?.with_opacity(opacity),
        end: Color::parse(end)?.with_opacity(opacity),
        start_point: unit_point(*start_point),
        end_point: unit_point(*end_point),
    })
}

fn push_painted_rect(
    scene: &mut Scene,
    id: String,
    rect: SceneBounds,
    paint: Option<&UiPaint>,
    fallback: Option<Color>,
    corner_radius: f32,
    opacity: f32,
) {
    let Some(color) = paint
        .and_then(paint_start_color)
        .or(fallback)
        .map(|color| color.with_opacity(opacity))
    else {
        return;
    };
    scene.rects.push(SceneRect {
        id: id.clone(),
        rect,
        color,
        corner_radius,
    });
    if let Some(gradient) = paint.and_then(|paint| scene_gradient(paint, opacity)) {
        scene.gradients.push(SceneGradient { id, gradient });
    }
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

pub(crate) fn evaluate_binary(operator: UiBinaryOperator, left: Value, right: Value) -> Value {
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
    /// Materialized program: `root.child` has every `forEach` instantiated per
    /// item key. The authored template is kept separately in `template`.
    pub program: UiProgram,
    template: UiNode,
    scope_model: crate::collection::ScopeModel,
    diagnostics: Vec<RuntimeDiagnostic>,
    state: HashMap<String, Value>,
    motion: MotionScheduler,
    revision: u64,
    focused_action: Option<String>,
    reveal_focus: Cell<bool>,
    /// Explicit reveal request (assistive technology ScrollIntoView); takes
    /// precedence over focus reveal on the next layout.
    reveal_request: RefCell<Option<String>>,
    /// Inputs of the last layout that refreshed scroll viewport geometry.
    geometry_stamp: Cell<Option<GeometryStamp>>,
    /// Flexible-frame intent ([width, height]) of layout nodes in the tree
    /// being built; consumed by each node's parent.
    flexible_frames: RefCell<HashMap<NodeId, [bool; 2]>>,
    scroll_views: RefCell<HashMap<String, crate::scroll_view::ScrollViewport>>,
    text_editor: Option<(String, crate::text_edit::TextEditor)>,
    text_scroll: RefCell<HashMap<String, f32>>,
    ime_requests: Vec<ImeRequest>,
    conventions: PlatformConventions,
    measurer: Rc<dyn IntrinsicMeasurer>,
    clipboard_requests: Vec<crate::input::ClipboardRequest>,
    pending_cut: Option<(u64, String, crate::text_edit::TextEditor)>,
    pending_paste: Option<(u64, String)>,
    /// Active scrollbar thumb drag: pointer, scroll view id, grab offset.
    scrollbar_drag: Option<(crate::input::PointerId, String, f32)>,
    clipboard_revision: u64,
    input: InputState,
    entering: HashMap<String, EnterPresence>,
    exiting: HashMap<String, ExitPresence>,
    layout_flips: HashMap<String, LayoutFlip>,
    retained: RetainedTree,
    last_reconciliation: RetainedReconciliation,
    last_live_scene: RefCell<Option<Scene>>,
    /// Shared so transactions can keep the pre-mutation geometry without a deep copy.
    last_live_accessibility: RefCell<Option<Rc<AccessibilityTree>>>,
}

impl Runtime {
    pub fn from_json(source: &str) -> Result<Self, RuntimeLoadError> {
        let raw: Value = serde_json::from_str(source)?;
        // Version and language gate everything else: a future version must be
        // reported as such, not as a pile of unknown fields.
        if let Some(found) = raw.get("version").and_then(Value::as_u64) {
            if found != u64::from(SEMANTIC_UI_IR_VERSION) {
                return Err(RuntimeLoadError::UnsupportedVersion {
                    found: u32::try_from(found).unwrap_or(u32::MAX),
                    supported: SEMANTIC_UI_IR_VERSION,
                });
            }
        }
        if let Some(found) = raw.get("sourceLanguage").and_then(Value::as_str) {
            if found != "mun" {
                return Err(RuntimeLoadError::UnsupportedSourceLanguage {
                    found: found.to_owned(),
                });
            }
        }
        crate::validate::validate_program(&raw)?;
        let program: UiProgram = serde_json::from_value(raw)?;
        validate_native_transitions(&program.root.child)?;
        validate_node_identities(&program)?;
        let mut scope_model =
            crate::collection::ScopeModel::new(&program.states, &program.root.child);
        if let Some(key) = &program.root.identity_key {
            scope_model.add_structure_expression(key);
        }
        // Item-scoped state has no global instance; materialization creates one
        // per live key.
        let state = program
            .states
            .iter()
            .filter(|item| item.scope.is_none())
            .map(|item| (item.name.clone(), item.initial.clone()))
            .collect();
        let template = program.root.child.clone();
        let mut runtime = Self {
            program,
            template,
            scope_model,
            diagnostics: Vec::new(),
            state,
            motion: MotionScheduler::default(),
            revision: 0,
            focused_action: None,
            reveal_focus: Cell::new(false),
            reveal_request: RefCell::new(None),
            geometry_stamp: Cell::new(None),
            flexible_frames: RefCell::new(HashMap::new()),
            scroll_views: RefCell::new(HashMap::new()),
            text_editor: None,
            text_scroll: RefCell::new(HashMap::new()),
            ime_requests: Vec::new(),
            conventions: PlatformConventions::default(),
            measurer: Rc::new(FallbackIntrinsicMeasurer),
            clipboard_requests: Vec::new(),
            pending_cut: None,
            pending_paste: None,
            scrollbar_drag: None,
            clipboard_revision: 0,
            input: InputState::default(),
            entering: HashMap::new(),
            exiting: HashMap::new(),
            layout_flips: HashMap::new(),
            retained: RetainedTree::default(),
            last_reconciliation: RetainedReconciliation::default(),
            last_live_scene: RefCell::new(None),
            last_live_accessibility: RefCell::new(None),
        };
        runtime
            .materialize()
            .map_err(RuntimeLoadError::Collection)?;
        runtime.reconcile_retained_tree();
        Ok(runtime)
    }

    /// Re-instantiate keyed collections from the template and current state.
    fn materialize(&mut self) -> Result<(), crate::collection::CollectionError> {
        if !self.scope_model.has_collections() {
            return Ok(());
        }
        let materialized =
            crate::collection::materialize(&self.template, &self.scope_model, &mut self.state)?;
        self.program.root.child = materialized.root;
        Ok(())
    }

    /// Diagnostics for rejected transactions since the last call.
    pub fn take_diagnostics(&mut self) -> Vec<RuntimeDiagnostic> {
        std::mem::take(&mut self.diagnostics)
    }

    /// Number of live item-scoped state instances (runtime-owned state scopes).
    pub fn scoped_state_count(&self) -> usize {
        self.state
            .keys()
            .filter(|name| self.scope_model.is_instance(name))
            .count()
    }

    /// Install backend-derived text/control metrics (shaped glyph geometry).
    /// Layout, scene construction, pointer-to-text mapping and accessibility all
    /// use the same measurer so their coordinates stay coherent.
    pub fn set_intrinsic_measurer(&mut self, measurer: Rc<dyn IntrinsicMeasurer>) {
        self.measurer = measurer;
    }

    pub fn set_platform_conventions(&mut self, conventions: PlatformConventions) {
        self.conventions = conventions;
    }

    pub fn take_ime_requests(&mut self) -> Vec<ImeRequest> {
        std::mem::take(&mut self.ime_requests)
    }

    /// Whether the platform should route text through its input method: true
    /// only while an enabled editable field owns semantic focus.
    pub fn wants_text_input(&self) -> bool {
        self.focused_action.as_deref().is_some_and(|id| {
            find_text_field(&self.program.root.child, self, id)
                .is_some_and(|(_, base)| self.node_enabled(base))
        })
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
                if let Some((_, view_id, grab)) = self
                    .scrollbar_drag
                    .clone()
                    .filter(|(drag_pointer, _, _)| *drag_pointer == pointer)
                {
                    let mut views = self.scroll_views.borrow_mut();
                    if let Some(view) = views.get_mut(&view_id) {
                        let axis = if view.horizontal {
                            position.x
                        } else {
                            position.y
                        };
                        if let Some(offset) = view.offset_for_thumb_position(axis, grab) {
                            let before = view.axis_offset();
                            view.set_axis_offset(offset);
                            view.update_scrollbar();
                            outcome.handled = true;
                            outcome.needs_redraw = view.axis_offset() != before;
                        }
                    }
                    return Ok(outcome);
                }
                let dragging_text = self
                    .input
                    .primary_capture(pointer)
                    .filter(|captured| self.focused_action.as_deref() == Some(*captured))
                    .filter(|captured| {
                        find_text_field(&self.program.root.child, self, captured).is_some()
                    })
                    .map(str::to_owned);
                if let Some(field) = dragging_text {
                    let scene = self.build_scene(width, height)?;
                    if let Some(offset) = self.text_offset_at(&scene, &field, position) {
                        outcome.handled = true;
                        let before = self.focused_text_editor().cloned();
                        self.edit_focused_text(crate::text_edit::TextEdit::PlaceCursor {
                            offset,
                            select: true,
                        });
                        outcome.needs_redraw |= self.focused_text_editor() != before.as_ref();
                    }
                }
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
                    if let Some(bar_outcome) = self.press_scrollbar(pointer, position) {
                        return Ok(bar_outcome);
                    }
                    let target = scene.action_at(position.x, position.y).map(str::to_owned);
                    // Any primary press deliberately ends an active composition: the
                    // preedit is committed where it is displayed before the caret or
                    // focus moves, matching native text-view behavior.
                    if self.finish_composition() {
                        outcome.needs_redraw = true;
                    }
                    if let Some(id) = target {
                        let text_offset = self.text_offset_at(&scene, &id, position);
                        let extend = self.input.modifiers().shift
                            && self.focused_action.as_deref() == Some(id.as_str());
                        if self.focus_action(&id) {
                            outcome.handled = true;
                            if let Some(offset) = text_offset {
                                self.edit_focused_text(crate::text_edit::TextEdit::PlaceCursor {
                                    offset,
                                    select: extend,
                                });
                                outcome.needs_redraw = true;
                            }
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
                if self
                    .scrollbar_drag
                    .as_ref()
                    .is_some_and(|(drag_pointer, _, _)| *drag_pointer == pointer)
                {
                    self.scrollbar_drag = None;
                    outcome.handled = true;
                    return Ok(outcome);
                }
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
                        outcome.activated = self.activate_interactive(&captured).is_some();
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
                LogicalKey::ArrowLeft
                | LogicalKey::ArrowRight
                | LogicalKey::ArrowUp
                | LogicalKey::ArrowDown
                | LogicalKey::Home
                | LogicalKey::End
                | LogicalKey::Delete
                | LogicalKey::Backspace
                    if self.focused_is_text_field() =>
                {
                    if let Some(edit) = self.text_key_edit(&logical) {
                        outcome.handled = true;
                        let before = self.focused_text_editor().cloned();
                        outcome.activated = self.edit_focused_text(edit).is_some();
                        outcome.needs_redraw |= self.focused_text_editor() != before.as_ref();
                    }
                }
                LogicalKey::Character(ref key)
                    if self.shortcut_modifier() && key.eq_ignore_ascii_case("a") =>
                {
                    outcome.handled = self.focused_is_text_field();
                    self.edit_focused_text(crate::text_edit::TextEdit::SelectAll);
                }
                LogicalKey::Character(ref key)
                    if self.shortcut_modifier()
                        && (key.eq_ignore_ascii_case("z") || key.eq_ignore_ascii_case("y")) =>
                {
                    outcome.handled = self.focused_is_text_field();
                    // Cmd+Z / Cmd+Shift+Z (Ctrl+Z / Ctrl+Y elsewhere).
                    let redo = key.eq_ignore_ascii_case("y") || self.input.modifiers().shift;
                    outcome.activated = self
                        .edit_focused_text(if redo {
                            crate::text_edit::TextEdit::Redo
                        } else {
                            crate::text_edit::TextEdit::Undo
                        })
                        .is_some();
                }
                LogicalKey::Character(ref key)
                    if self.shortcut_modifier()
                        && ["c", "x", "v"]
                            .iter()
                            .any(|shortcut| key.eq_ignore_ascii_case(shortcut)) =>
                {
                    if let Some(id) = self
                        .focused_action
                        .clone()
                        .filter(|id| find_text_field(&self.program.root.child, self, id).is_some())
                    {
                        outcome.handled = true;
                        // A clipboard command finalizes composition like a native text
                        // view, then acts on the committed text and selection.
                        self.finish_composition();
                        self.ensure_focused_text_editor();
                        if key.eq_ignore_ascii_case("v") {
                            self.clipboard_revision += 1;
                            let request = self.clipboard_revision;
                            self.pending_paste = Some((request, id.clone()));
                            self.clipboard_requests
                                .push(crate::input::ClipboardRequest::Read {
                                    request,
                                    target: id,
                                });
                        } else if let Some(editor) = self.focused_text_editor() {
                            let selected = editor.selected_text().to_owned();
                            if !selected.is_empty() {
                                if key.eq_ignore_ascii_case("x") {
                                    self.clipboard_revision += 1;
                                    let request = self.clipboard_revision;
                                    let editor =
                                        self.focused_text_editor().expect("active editor").clone();
                                    self.pending_cut = Some((request, id, editor));
                                    self.clipboard_requests.push(
                                        crate::input::ClipboardRequest::Cut {
                                            request,
                                            text: selected,
                                        },
                                    );
                                } else {
                                    self.clipboard_requests
                                        .push(crate::input::ClipboardRequest::Write(selected));
                                }
                            }
                        }
                    }
                }
                LogicalKey::Tab => {
                    outcome.handled = self
                        .focus_next_action(self.input.modifiers().shift)
                        .is_some();
                }
                LogicalKey::Enter
                    if !repeat
                        && !self.focused_action.as_deref().is_some_and(|id| {
                            find_text_field(&self.program.root.child, self, id).is_some()
                        }) =>
                {
                    if self.focused_action().is_none() {
                        self.focus_next_action(false);
                    }
                    outcome.activated = self.activate_focused().is_some();
                    outcome.handled = outcome.activated || self.focused_action().is_some();
                }
                LogicalKey::ArrowDown | LogicalKey::ArrowRight => {
                    let focused_is_radio = self.focused_action.as_deref().is_some_and(|id| {
                        find_radio_group(&self.program.root.child, self, id).is_some()
                    });
                    if focused_is_radio {
                        outcome.handled = true;
                        outcome.activated = self.select_adjacent_radio(true).is_some();
                    } else {
                        let horizontal = logical == LogicalKey::ArrowRight;
                        outcome.handled = self.keyboard_scroll(
                            ScrollCommand::Lines(1.0),
                            Some(horizontal),
                            width,
                            height,
                        )?;
                        outcome.needs_redraw |= outcome.handled;
                    }
                }
                LogicalKey::ArrowUp | LogicalKey::ArrowLeft => {
                    let focused_is_radio = self.focused_action.as_deref().is_some_and(|id| {
                        find_radio_group(&self.program.root.child, self, id).is_some()
                    });
                    if focused_is_radio {
                        outcome.handled = true;
                        outcome.activated = self.select_adjacent_radio(false).is_some();
                    } else {
                        let horizontal = logical == LogicalKey::ArrowLeft;
                        outcome.handled = self.keyboard_scroll(
                            ScrollCommand::Lines(-1.0),
                            Some(horizontal),
                            width,
                            height,
                        )?;
                        outcome.needs_redraw |= outcome.handled;
                    }
                }
                LogicalKey::PageUp | LogicalKey::PageDown => {
                    let direction = if logical == LogicalKey::PageDown {
                        1.0
                    } else {
                        -1.0
                    };
                    outcome.handled =
                        self.keyboard_scroll(ScrollCommand::Pages(direction), None, width, height)?;
                    outcome.needs_redraw |= outcome.handled;
                }
                LogicalKey::Home | LogicalKey::End => {
                    // Reached only when no editable field owns Home/End.
                    let command = if logical == LogicalKey::Home {
                        ScrollCommand::ToStart
                    } else {
                        ScrollCommand::ToEnd
                    };
                    outcome.handled = self.keyboard_scroll(command, None, width, height)?;
                    outcome.needs_redraw |= outcome.handled;
                }
                LogicalKey::Space | LogicalKey::Enter
                    if self.focused_action.as_deref().is_some_and(|id| {
                        find_text_field(&self.program.root.child, self, id).is_some()
                    }) =>
                {
                    outcome.handled = true;
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
                    outcome.activated = self.activate_interactive(&captured).is_some();
                }
            }
            InputEvent::ClipboardWriteCompleted { request, success } => {
                if self
                    .pending_cut
                    .as_ref()
                    .is_some_and(|(id, _, _)| *id == request)
                {
                    let (_, target, editor) = self.pending_cut.take().expect("pending cut");
                    let binding_unchanged =
                        find_text_field(&self.program.root.child, self, &target)
                            .and_then(|(state, _)| self.state.get(state))
                            .and_then(Value::as_str)
                            == Some(editor.text());
                    if success
                        && binding_unchanged
                        && self.focused_action.as_ref() == Some(&target)
                        && self.focused_text_editor() == Some(&editor)
                    {
                        outcome.handled = true;
                        outcome.activated = self
                            .edit_focused_text(crate::text_edit::TextEdit::Delete)
                            .is_some();
                    }
                }
            }
            InputEvent::ClipboardReadCompleted { request, text } => {
                // Only the latest paste request for the still-focused field applies.
                // Unavailable/non-text content, stale requests, focus changes and an
                // active composition all leave committed text untouched.
                let Some((pending, target)) = self.pending_paste.take() else {
                    return Ok(outcome);
                };
                if pending != request {
                    self.pending_paste = Some((pending, target));
                    return Ok(outcome);
                }
                let text = text.map(|text| sanitize_single_line(&text));
                let composing = self
                    .focused_text_editor()
                    .is_some_and(|editor| editor.composition().is_some());
                if let Some(text) = text.filter(|text| !text.is_empty()) {
                    if self.focused_action.as_ref() == Some(&target) && !composing {
                        outcome.handled = true;
                        outcome.activated = self
                            .edit_focused_text(crate::text_edit::TextEdit::Insert(text))
                            .is_some();
                    }
                }
            }
            InputEvent::TextEdit(edit) => {
                outcome.handled = self.focused_action.as_deref().is_some_and(|id| {
                    find_text_field(&self.program.root.child, self, id).is_some()
                });
                outcome.activated = self.edit_focused_text(edit).is_some();
            }
            InputEvent::TextInput { text } => {
                let focused_is_text = self.focused_action.as_deref().is_some_and(|id| {
                    find_text_field(&self.program.root.child, self, id).is_some()
                });
                if focused_is_text {
                    outcome.handled = true;
                    outcome.activated = self
                        .edit_focused_text(crate::text_edit::TextEdit::Insert(text))
                        .is_some();
                }
            }
            InputEvent::Scroll { pointer, delta, .. } => {
                self.ensure_scroll_geometry(width, height)?;
                let position = pointer.and_then(|pointer| self.input.pointer_position(pointer));
                if let Some(position) = position {
                    let mut route = Vec::new();
                    fn visit(
                        runtime: &Runtime,
                        node: &UiNode,
                        position: crate::input::InputPoint,
                        clip: Option<SceneBounds>,
                        route: &mut Vec<String>,
                    ) {
                        let viewport = runtime.scroll_views.borrow().get(&node.base().id).cloned();
                        let clip = viewport
                            .as_ref()
                            .map(|view| {
                                clip.map(|clip| clip.intersection(view.bounds))
                                    .unwrap_or(view.bounds)
                            })
                            .or(clip);
                        if clip.is_some_and(|clip| {
                            clip.width <= 0.0
                                || clip.height <= 0.0
                                || !clip.contains(position.x, position.y)
                        }) {
                            return;
                        }
                        for child in runtime.active_children(node) {
                            visit(runtime, child, position, clip, route);
                        }
                        if viewport.is_some() {
                            route.push(node.base().id.clone());
                        }
                    }
                    visit(self, &self.program.root.child, position, None, &mut route);
                    let mut delta = match delta {
                        crate::input::ScrollDelta::Lines { x, y } => [x * 32.0, y * 32.0],
                        crate::input::ScrollDelta::Pixels { x, y } => [x, y],
                    };
                    for id in route {
                        let mut views = self.scroll_views.borrow_mut();
                        let view = views.get_mut(&id).expect("active viewport");
                        let before = view.offset;
                        delta = view.scroll(delta);
                        outcome.handled |= view.offset != before;
                    }
                    outcome.needs_redraw |= outcome.handled;
                }
            }
            InputEvent::Key { .. } => {}
            InputEvent::Cancel { pointer } => {
                if pointer.is_none()
                    || self
                        .scrollbar_drag
                        .as_ref()
                        .is_some_and(|(drag_pointer, _, _)| Some(*drag_pointer) == pointer)
                {
                    self.scrollbar_drag = None;
                }
                outcome.pressed_changed = self.input.cancel_pointer(pointer);
                outcome.handled = outcome.pressed_changed;
            }
            InputEvent::WindowFocusChanged(false) => {
                if let Some((_, editor)) = &mut self.text_editor {
                    editor.cancel_composition();
                }
                self.input.set_modifiers(Default::default());
                self.scrollbar_drag = None;
                let pointer_changed = self.input.cancel_pointer(None);
                let keyboard_changed = self.input.clear_keyboard_capture();
                outcome.pressed_changed = pointer_changed || keyboard_changed;
                outcome.handled = outcome.pressed_changed;
            }
            InputEvent::WindowFocusChanged(true) => {}
        }

        if self
            .text_editor
            .as_ref()
            .is_some_and(|(id, _)| self.focused_action.as_ref() != Some(id))
        {
            self.text_editor = None;
        }
        outcome.focus_changed = self.focused_action != focus_before;
        outcome.needs_redraw |= outcome.focus_changed
            || outcome.pressed_changed
            || outcome.activated
            || (outcome.handled && focus_before.is_some());
        Ok(outcome)
    }

    pub fn focused_action(&self) -> Option<&str> {
        self.focused_action.as_deref()
    }

    pub fn state_value(&self, state: &str) -> Option<&Value> {
        self.state.get(state)
    }

    pub fn primary_pressed_action(&self, pointer: crate::input::PointerId) -> Option<&str> {
        self.input.primary_capture(pointer)
    }

    pub fn keyboard_pressed_action(&self) -> Option<&str> {
        self.input.keyboard_capture()
    }

    pub fn clear_focus(&mut self) {
        self.finish_composition();
        self.focused_action = None;
        self.text_editor = None;
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
            self.scroll_views.borrow_mut().remove(id);
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
        let focus_id = radio_option_target(id)
            .map(|(group, _)| group)
            .unwrap_or(id);
        let Some(base) = find_focusable_base(&self.program.root.child, self, focus_id) else {
            return false;
        };
        if !self.node_enabled(base) {
            return false;
        }
        if self.focused_action.as_deref() != Some(focus_id) {
            self.finish_composition();
            self.text_editor = None;
            self.reveal_focus.set(true);
            self.input.clear_keyboard_capture();
        }
        self.focused_action = Some(focus_id.to_owned());
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
            self.finish_composition();
            self.text_editor = None;
            self.reveal_focus.set(true);
            self.input.clear_keyboard_capture();
        }
        self.focused_action = Some(id.clone());
        Some(id)
    }

    pub fn activate_focused(&mut self) -> Option<Transaction> {
        let id = self.focused_action.clone()?;
        self.activate_interactive(&id)
    }

    pub(crate) fn activate_interactive(&mut self, id: &str) -> Option<Transaction> {
        if let Some((group_id, index)) = radio_option_target(id) {
            let (state, options, base) =
                find_radio_group(&self.program.root.child, self, group_id)?;
            if !self.node_enabled(base) {
                return None;
            }
            let state = state.to_owned();
            let option = options.get(index)?;
            if option.disabled {
                return None;
            }
            return self.set_control_state(state, option.value.clone());
        }
        self.activate_action(id)
    }

    fn select_adjacent_radio(&mut self, forward: bool) -> Option<Transaction> {
        let focused = self.focused_action.clone()?;
        let (state, options, base) = find_radio_group(&self.program.root.child, self, &focused)?;
        if !self.node_enabled(base) || options.is_empty() {
            return None;
        }
        let state = state.to_owned();
        let options = options.to_vec();
        let current = self.state.get(&state).cloned().unwrap_or(Value::Null);
        let current_index = options
            .iter()
            .position(|option| option.value == current)
            .unwrap_or(if forward { options.len() - 1 } else { 0 });
        for offset in 1..=options.len() {
            let index = if forward {
                (current_index + offset) % options.len()
            } else {
                (current_index + options.len() - (offset % options.len())) % options.len()
            };
            if !options[index].disabled {
                return self.set_control_state(state, options[index].value.clone());
            }
        }
        None
    }

    /// Scroll views enclosing `id`, innermost first.
    fn scroll_ancestors(&self, id: &str) -> Vec<String> {
        fn visit(runtime: &Runtime, node: &UiNode, id: &str, path: &mut Vec<String>) -> bool {
            let is_scroll = matches!(node, UiNode::Scroll { .. });
            if is_scroll {
                path.push(node.base().id.clone());
            }
            if node.base().id == id
                || runtime
                    .active_children(node)
                    .iter()
                    .any(|child| visit(runtime, child, id, path))
            {
                return true;
            }
            if is_scroll {
                path.pop();
            }
            false
        }
        let mut path = Vec::new();
        visit(self, &self.program.root.child, id, &mut path);
        // A focused scroll view itself is excluded only when it is the target
        // node; its own viewport is the nearest container for keyboard scrolling.
        path.reverse();
        path
    }

    /// Scroll views under a window point, innermost first.
    fn current_geometry_stamp(&self, width: f32, height: f32) -> GeometryStamp {
        use std::hash::{Hash, Hasher};
        // Order-independent digest of every viewport offset: a parent's offset
        // moves its nested viewports' window-space bounds.
        let offsets = self
            .scroll_views
            .borrow()
            .iter()
            .fold(0u64, |digest, (id, view)| {
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                id.hash(&mut hasher);
                view.offset[0].to_bits().hash(&mut hasher);
                view.offset[1].to_bits().hash(&mut hasher);
                digest ^ hasher.finish()
            });
        GeometryStamp {
            revision: self.revision,
            width: width.to_bits(),
            height: height.to_bits(),
            offsets,
        }
    }

    /// Scroll routing needs current viewport geometry. Rebuild the frame only
    /// when something that moves geometry changed since the last layout: state,
    /// window size, any scroll offset, active motion/transitions or a reveal.
    fn ensure_scroll_geometry(&self, width: f32, height: f32) -> Result<(), taffy::TaffyError> {
        let fresh = self.geometry_stamp.get() == Some(self.current_geometry_stamp(width, height))
            && !self.has_active_motion()
            && self.entering.is_empty()
            && self.exiting.is_empty()
            && self.layout_flips.is_empty()
            && !self.reveal_focus.get()
            && self.reveal_request.borrow().is_none();
        if !fresh {
            self.build_frame(width, height)?;
        }
        Ok(())
    }

    fn scroll_views_at(&self, position: crate::input::InputPoint) -> Vec<String> {
        let views = self.scroll_views.borrow();
        let mut hits = views
            .iter()
            .filter(|(_, view)| view.bounds.contains(position.x, position.y))
            .map(|(id, view)| (id.clone(), view.bounds.width * view.bounds.height))
            .collect::<Vec<_>>();
        hits.sort_by(|a, b| a.1.total_cmp(&b.1));
        hits.into_iter().map(|(id, _)| id).collect()
    }

    /// Keyboard scrolling owned by the nearest scroll container of semantic
    /// focus (or the hovered viewport when nothing is focused). Movement the
    /// inner container cannot absorb routes to its ancestors; focus never moves.
    fn keyboard_scroll(
        &mut self,
        command: ScrollCommand,
        horizontal: Option<bool>,
        width: f32,
        height: f32,
    ) -> Result<bool, taffy::TaffyError> {
        self.ensure_scroll_geometry(width, height)?;
        let chain = match self.focused_action.clone() {
            Some(focused) => self.scroll_ancestors(&focused),
            None => self
                .input
                .pointer_position(crate::input::PointerId::MOUSE)
                .map(|position| self.scroll_views_at(position))
                .unwrap_or_default(),
        };
        let mut views = self.scroll_views.borrow_mut();
        for id in chain {
            let Some(view) = views.get_mut(&id) else {
                continue;
            };
            if horizontal.is_some_and(|horizontal| horizontal != view.horizontal)
                || !view.is_scrollable()
            {
                continue;
            }
            let before = view.axis_offset();
            let target = match command {
                ScrollCommand::Lines(lines) => before + lines * crate::scroll_view::SCROLL_LINE,
                ScrollCommand::Pages(pages) => before + pages * view.page(),
                ScrollCommand::ToStart => 0.0,
                ScrollCommand::ToEnd => view.max_offset(),
            };
            view.set_axis_offset(target);
            view.update_scrollbar();
            if (view.axis_offset() - before).abs() > f32::EPSILON {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Scrollbar press: thumb starts a drag, track pages toward the pointer.
    fn press_scrollbar(
        &mut self,
        pointer: crate::input::PointerId,
        position: crate::input::InputPoint,
    ) -> Option<InputOutcome> {
        let mut views = self.scroll_views.borrow_mut();
        let (id, view) = views
            .iter_mut()
            .filter(|(_, view)| {
                view.scrollbar
                    .is_some_and(|bar| bar.track.contains(position.x, position.y))
            })
            .min_by(|a, b| {
                (a.1.bounds.width * a.1.bounds.height)
                    .total_cmp(&(b.1.bounds.width * b.1.bounds.height))
            })?;
        let bar = view.scrollbar?;
        let (axis, thumb_start, thumb_length) = if view.horizontal {
            (position.x, bar.thumb.x, bar.thumb.width)
        } else {
            (position.y, bar.thumb.y, bar.thumb.height)
        };
        let mut outcome = InputOutcome {
            handled: true,
            ..Default::default()
        };
        if axis >= thumb_start && axis <= thumb_start + thumb_length {
            self.scrollbar_drag = Some((pointer, id.clone(), axis - thumb_start));
        } else {
            let before = view.axis_offset();
            let direction = if axis < thumb_start { -1.0 } else { 1.0 };
            view.set_axis_offset(before + direction * view.page());
            view.update_scrollbar();
            outcome.needs_redraw = view.axis_offset() != before;
        }
        Some(outcome)
    }

    fn focused_is_text_field(&self) -> bool {
        self.focused_action
            .as_deref()
            .is_some_and(|id| find_text_field(&self.program.root.child, self, id).is_some())
    }

    fn shortcut_modifier(&self) -> bool {
        let modifiers = self.input.modifiers();
        if self.conventions.apple_text_navigation {
            modifiers.meta
        } else {
            modifiers.control
        }
    }

    /// Platform-convention key to semantic edit. Granularity (grapheme, word,
    /// line) is chosen here; the editor never interprets modifiers itself.
    fn text_key_edit(&self, key: &LogicalKey) -> Option<crate::text_edit::TextEdit> {
        use crate::text_edit::TextEdit;
        let modifiers = self.input.modifiers();
        let select = modifiers.shift;
        let apple = self.conventions.apple_text_navigation;
        let word = if apple {
            modifiers.alt
        } else {
            modifiers.control
        };
        let line = apple && modifiers.meta;
        Some(match key {
            LogicalKey::ArrowLeft if line => TextEdit::Home { select },
            LogicalKey::ArrowRight if line => TextEdit::End { select },
            LogicalKey::ArrowLeft if word => TextEdit::WordLeft { select },
            LogicalKey::ArrowRight if word => TextEdit::WordRight { select },
            LogicalKey::ArrowLeft => TextEdit::Left { select },
            LogicalKey::ArrowRight => TextEdit::Right { select },
            // Single-line Apple fields move to the edges on vertical arrows.
            LogicalKey::ArrowUp if apple => TextEdit::Home { select },
            LogicalKey::ArrowDown if apple => TextEdit::End { select },
            LogicalKey::Home => TextEdit::Home { select },
            LogicalKey::End => TextEdit::End { select },
            LogicalKey::Backspace if line => TextEdit::DeleteToStart,
            LogicalKey::Backspace if word => TextEdit::DeleteWordBackward,
            LogicalKey::Backspace => TextEdit::Backspace,
            LogicalKey::Delete if word => TextEdit::DeleteWordForward,
            LogicalKey::Delete => TextEdit::Delete,
            _ => return None,
        })
    }

    /// Create/synchronize the focused field's editor without editing it.
    fn ensure_focused_text_editor(&mut self) {
        let Some(focused) = self.focused_action.clone() else {
            return;
        };
        let Some((state, _)) = find_text_field(&self.program.root.child, self, &focused) else {
            return;
        };
        let value = self
            .state
            .get(state)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        match &mut self.text_editor {
            Some((id, editor)) if *id == focused => editor.synchronize(&value),
            _ => {
                self.text_editor = Some((focused, crate::text_edit::TextEditor::new(value)));
            }
        }
    }

    /// Deliberately end the active composition: a non-empty preedit is committed
    /// into the field that owns it, an empty one is cancelled, and the platform is
    /// asked to discard its marked text. Returns whether a composition existed.
    fn finish_composition(&mut self) -> bool {
        let Some((owner, composition)) = self
            .text_editor
            .as_ref()
            .and_then(|(id, editor)| Some((id.clone(), editor.composition()?.clone())))
        else {
            return false;
        };
        self.ime_requests.push(ImeRequest::DiscardComposition);
        let field = find_text_field(&self.program.root.child, self, &owner)
            .filter(|(_, base)| self.node_enabled(base))
            .map(|(state, _)| state.to_owned());
        let (_, editor) = self.text_editor.as_mut().expect("composition editor");
        let Some(state) = field.filter(|_| !composition.text.is_empty()) else {
            editor.cancel_composition();
            return true;
        };
        let binding = self.state.get(&state).and_then(Value::as_str).unwrap_or("");
        if editor.text() != binding {
            // The binding changed underneath the preedit; its anchor is stale.
            editor.synchronize(binding);
            return true;
        }
        editor.apply(crate::text_edit::TextEdit::CompositionCommit(
            composition.text,
        ));
        let value = editor.text().to_owned();
        self.set_control_state(state, Value::String(value));
        true
    }

    /// Map a window point to the nearest grapheme boundary of a text field using
    /// the presented scene geometry and the backend's shaped line layout.
    fn text_offset_at(
        &self,
        scene: &Scene,
        field: &str,
        position: crate::input::InputPoint,
    ) -> Option<usize> {
        let (state, _) = find_text_field(&self.program.root.child, self, field)?;
        let text_id = format!("{field}:text");
        let text = scene.texts.iter().find(|text| text.id == text_id)?;
        let value = self
            .focused_text_editor()
            .filter(|_| self.focused_action.as_deref() == Some(field))
            .map(|editor| editor.presentation_text())
            .unwrap_or_else(|| {
                self.state
                    .get(state)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            });
        if value.is_empty() {
            return Some(0);
        }
        let inverse = scene.presentation.transform_for(&text_id).inverse()?;
        let (local_x, _) = inverse.transform_point(position.x, position.y);
        let scale = text.font_size / TEXT_FIELD_FONT_SIZE;
        if !scale.is_finite() || scale <= f32::EPSILON {
            return None;
        }
        let line = self.measurer.text_line(&value, TEXT_FIELD_FONT_SIZE);
        Some(line.offset_for_x((local_x - text.x) / scale))
    }

    /// Assistive-technology text selection, in grapheme indices of the
    /// committed value. Commits any composition first, like a pointer press.
    pub(crate) fn accessible_select_text(
        &mut self,
        target: &str,
        anchor: usize,
        focus: usize,
    ) -> bool {
        let Some((state, _)) = find_text_field(&self.program.root.child, self, target) else {
            return false;
        };
        let state = state.to_owned();
        if !self.focus_action(target) {
            return false;
        }
        self.finish_composition();
        let value = self.state.get(&state).and_then(Value::as_str).unwrap_or("");
        let boundaries = crate::text_edit::grapheme_boundaries(value);
        let (Some(&anchor), Some(&focus)) = (boundaries.get(anchor), boundaries.get(focus)) else {
            return false;
        };
        use crate::text_edit::TextEdit;
        self.edit_focused_text(TextEdit::PlaceCursor {
            offset: anchor,
            select: false,
        });
        self.edit_focused_text(TextEdit::PlaceCursor {
            offset: focus,
            select: true,
        });
        true
    }

    /// Assistive-technology text replacement through the same editor path as
    /// typing (`whole` replaces the entire value, i.e. SetValue).
    pub(crate) fn accessible_replace_text(
        &mut self,
        target: &str,
        text: &str,
        whole: bool,
    ) -> bool {
        if find_text_field(&self.program.root.child, self, target).is_none()
            || !self.focus_action(target)
        {
            return false;
        }
        self.finish_composition();
        use crate::text_edit::TextEdit;
        if whole {
            self.edit_focused_text(TextEdit::SelectAll);
        }
        let text = sanitize_single_line(text);
        if text.is_empty() {
            if self
                .focused_text_editor()
                .is_some_and(|editor| !editor.selection().is_empty())
            {
                self.edit_focused_text(TextEdit::Backspace);
            }
        } else {
            self.edit_focused_text(TextEdit::Insert(text));
        }
        true
    }

    /// Move a scroll viewport to `offset(view)` on its axis. Returns false for
    /// unknown or non-scrollable targets.
    pub(crate) fn accessible_scroll(
        &mut self,
        target: &str,
        offset: impl FnOnce(&crate::scroll_view::ScrollViewport) -> f32,
    ) -> bool {
        let mut views = self.scroll_views.borrow_mut();
        let Some(view) = views.get_mut(target).filter(|view| view.is_scrollable()) else {
            return false;
        };
        let value = offset(view);
        view.set_axis_offset(value);
        view.update_scrollbar();
        true
    }

    /// Reveal `target` through its scrolling ancestors on the next layout.
    pub(crate) fn request_reveal(&mut self, target: &str) -> bool {
        let target = radio_option_target(target).map_or(target, |(group, _)| group);
        if !active_node_exists(&self.program.root.child, self, target) {
            return false;
        }
        *self.reveal_request.borrow_mut() = Some(target.to_owned());
        true
    }

    pub fn take_clipboard_requests(&mut self) -> Vec<crate::input::ClipboardRequest> {
        std::mem::take(&mut self.clipboard_requests)
    }

    /// Editing state belongs to the authoritative focused semantic identity.
    pub fn focused_text_editor(&self) -> Option<&crate::text_edit::TextEditor> {
        self.text_editor
            .as_ref()
            .filter(|(id, _)| self.focused_action.as_ref() == Some(id))
            .map(|(_, editor)| editor)
    }

    fn edit_focused_text(&mut self, edit: crate::text_edit::TextEdit) -> Option<Transaction> {
        let focused = self.focused_action.clone()?;
        let (state, base) = find_text_field(&self.program.root.child, self, &focused)?;
        if !self.node_enabled(base) {
            return None;
        }
        let state = state.to_owned();
        let value = self.state.get(&state).and_then(Value::as_str).unwrap_or("");
        if self.text_editor.as_ref().map(|(id, _)| id) != Some(&focused) {
            self.text_editor = Some((focused, crate::text_edit::TextEditor::new(value.to_owned())));
        }
        let editor = &mut self.text_editor.as_mut()?.1;
        editor.synchronize(value);
        if !editor.apply(edit) {
            return None;
        }
        let value = editor.text().to_owned();
        self.set_control_state(state, Value::String(value))
    }

    fn may_reject(&self, action: &crate::ir::UiAction) -> bool {
        use crate::ir::UiAction;
        match action {
            UiAction::Collection { .. } => true,
            UiAction::ToggleState { state, .. } | UiAction::SetState { state, .. } => {
                self.scope_model.structural_states.contains(state)
            }
            UiAction::Sequence { actions, .. } => {
                actions.iter().any(|action| self.may_reject(action))
            }
        }
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

        // Only collection operations and structural states can be rejected;
        // other actions skip the full-state snapshot.
        let snapshot = self.may_reject(&action).then(|| self.state.clone());
        let applied =
            self.apply_action_mutations(&action, &mut transaction.mutations)
                .and_then(|()| {
                    let structural = transaction.mutations.iter().any(|mutation| {
                        self.scope_model.structural_states.contains(&mutation.state)
                    });
                    if structural {
                        self.materialize()
                    } else {
                        Ok(())
                    }
                });
        if let Err(error) = applied {
            // Reject the whole transaction: no partial, aliased or index-shifted
            // state survives. The previous materialization is still current.
            debug_assert!(snapshot.is_some(), "unexpected rejection of {id}");
            if let Some(snapshot) = snapshot {
                self.state = snapshot;
            }
            self.diagnostics
                .push(RuntimeDiagnostic::RejectedTransaction {
                    action: Some(id.to_owned()),
                    error,
                });
            return None;
        }

        if transaction
            .mutations
            .iter()
            .any(|mutation| self.scope_model.affects_structure(&mutation.state))
        {
            self.reconcile_retained_tree();
        } else {
            self.last_reconciliation = RetainedReconciliation::default();
        }
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
            before_layout_geometry.as_deref(),
            &replaced_nodes,
            &transaction,
        );

        Some(transaction)
    }

    /// Apply an action's state mutations in order; later mutations observe
    /// earlier ones. Any collection error aborts; the caller rolls back.
    fn apply_action_mutations(
        &mut self,
        action: &UiAction,
        mutations: &mut Vec<StateMutation>,
    ) -> Result<(), crate::collection::CollectionError> {
        match action {
            UiAction::ToggleState { state, .. } => {
                let old = self.state.get(state).cloned().unwrap_or(Value::Bool(false));
                let new = Value::Bool(!old.as_bool().unwrap_or(false));
                self.state.insert(state.clone(), new.clone());
                mutations.push(StateMutation {
                    state: state.clone(),
                    old,
                    new,
                });
            }
            UiAction::SetState { state, value, .. } => {
                let old = self.state.get(state).cloned().unwrap_or(Value::Null);
                let new = self.eval(value);
                self.state.insert(state.clone(), new.clone());
                mutations.push(StateMutation {
                    state: state.clone(),
                    old,
                    new,
                });
            }
            UiAction::Collection {
                state,
                key_path,
                operation,
                ..
            } => {
                let old = self.state.get(state).cloned().unwrap_or(Value::Null);
                let operation =
                    crate::collection::EvaluatedOperation::evaluate(operation, &self.state);
                let new = crate::collection::apply_operation(state, &old, key_path, &operation)?;
                self.state.insert(state.clone(), new.clone());
                mutations.push(StateMutation {
                    state: state.clone(),
                    old,
                    new,
                });
            }
            UiAction::Sequence { actions, .. } => {
                for action in actions {
                    self.apply_action_mutations(action, mutations)?;
                }
            }
        }
        Ok(())
    }

    fn set_control_state(&mut self, state: String, new: Value) -> Option<Transaction> {
        let old = self.state.get(&state).cloned().unwrap_or(Value::Null);
        if old == new {
            return None;
        }
        if self.scope_model.structural_states.contains(&state) {
            let snapshot = self.state.clone();
            self.state.insert(state.clone(), new.clone());
            if let Err(error) = self.materialize() {
                self.state = snapshot;
                self.diagnostics
                    .push(RuntimeDiagnostic::RejectedTransaction {
                        action: None,
                        error,
                    });
                return None;
            }
            // Materialization may have created/released item scopes; restore
            // only the edited binding's prior value so the transaction below
            // records the mutation normally.
            self.state.insert(state.clone(), old.clone());
        }

        let mut focus_order_before = Vec::new();
        collect_focusable_actions(&self.program.root.child, self, &mut focus_order_before);
        let before_presence = self.active_transition_roots();
        let before_layout_neighborhoods = self.layout_neighborhoods();
        let before_layout_geometry = self.last_live_accessibility.borrow().clone();
        let before = self.motion_targets();

        let transaction = Transaction {
            revision: self.revision + 1,
            mutations: vec![StateMutation {
                state: state.clone(),
                old,
                new: new.clone(),
            }],
            ..Default::default()
        };
        let structural = self.scope_model.affects_structure(&state);
        self.state.insert(state, new);

        if structural {
            self.reconcile_retained_tree();
        } else {
            self.last_reconciliation = RetainedReconciliation::default();
        }
        let replaced_nodes = self.reset_replaced_runtime_state();
        self.reconcile_focus(&focus_order_before);
        self.reconcile_pointer_captures();
        self.revision = transaction.revision;

        let after = self.motion_targets();
        for (key, next) in after {
            if replaced_nodes.contains(&key.node_id) {
                continue;
            }
            let current = self
                .motion
                .value(&key)
                .or_else(|| before.get(&key).map(|target| target.target))
                .unwrap_or(next.target);
            self.motion.snap(&key, current);
            self.motion.snap(&key, next.target);
        }

        let after_presence = self.active_transition_roots();
        self.reconcile_presence(before_presence, after_presence, &transaction);
        let after_layout_neighborhoods = self.layout_neighborhoods();
        self.reconcile_layout_flips(
            before_layout_neighborhoods,
            after_layout_neighborhoods,
            before_layout_geometry.as_deref(),
            &replaced_nodes,
            &transaction,
        );

        Some(transaction)
    }

    pub fn build_frame(&self, width: f32, height: f32) -> Result<RuntimeFrame, taffy::TaffyError> {
        let measurer = self.measurer.clone();
        self.build_frame_with_measurer(width, height, measurer.as_ref())
    }

    pub fn build_frame_with_measurer(
        &self,
        width: f32,
        height: f32,
        measurer: &dyn IntrinsicMeasurer,
    ) -> Result<RuntimeFrame, taffy::TaffyError> {
        let (taffy, nodes) = self.build_layout_tree_with_measurer(width, height, measurer)?;
        self.reconcile_scroll_layout(&taffy, &nodes)?;
        self.reveal_focused_layout(&taffy, &nodes)?;
        let mut scene = Scene::default();
        self.collect_scene(
            &taffy,
            &self.program.root.child,
            &nodes,
            0.0,
            0.0,
            1.0,
            measurer,
            &mut scene,
        )?;
        let mut accessibility =
            self.accessibility_from_layout(&taffy, &nodes, width, height, measurer)?;
        self.apply_enter_presence(&mut scene, &mut accessibility);
        self.apply_layout_flips(&mut scene, &mut accessibility);
        *self.last_live_scene.borrow_mut() = Some(scene.clone());
        *self.last_live_accessibility.borrow_mut() = Some(Rc::new(accessibility.clone()));
        self.geometry_stamp
            .set(Some(self.current_geometry_stamp(width, height)));
        self.append_exit_overlays(&mut scene);
        let ime_cursor_area = self.focused_action.as_ref().and_then(|id| {
            let caret = format!("{id}:caret");
            let item = scene.rects.iter().find(|item| item.id == caret)?;
            let rect = scene.presentation.transformed_rect(&caret, item.rect);
            Some(match scene.presentation.clip_for(&caret) {
                // Keep the candidate window anchored inside the visible field even
                // when the caret itself is scrolled out of a clipped container.
                Some(clip) if clip.width > 0.0 && clip.height > 0.0 => SceneBounds {
                    x: rect.x.clamp(clip.x, clip.x + clip.width),
                    y: rect.y.clamp(clip.y, clip.y + clip.height),
                    width: rect.width,
                    height: rect.height,
                },
                _ => rect,
            })
        });
        Ok(RuntimeFrame {
            scene,
            accessibility,
            ime_cursor_area,
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
        let measurer = self.measurer.clone();
        self.build_accessibility_tree_with_measurer(width, height, measurer.as_ref())
    }

    pub fn build_accessibility_tree_with_measurer(
        &self,
        width: f32,
        height: f32,
        measurer: &dyn IntrinsicMeasurer,
    ) -> Result<AccessibilityTree, taffy::TaffyError> {
        let (taffy, nodes) = self.build_layout_tree_with_measurer(width, height, measurer)?;
        self.reconcile_scroll_layout(&taffy, &nodes)?;
        self.reveal_focused_layout(&taffy, &nodes)?;
        let mut accessibility =
            self.accessibility_from_layout(&taffy, &nodes, width, height, measurer)?;
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
        measurer: &dyn IntrinsicMeasurer,
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
            value: None,
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
            checked: None,
            text: None,
            scroll: None,
        }];
        for child in root_children {
            self.collect_accessibility(taffy, child, nodes, 0.0, 0.0, measurer, &mut output)?;
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
        let measurer = self.measurer.clone();
        self.build_layout_tree_with_measurer(width, height, measurer.as_ref())
    }

    fn build_layout_tree_with_measurer(
        &self,
        width: f32,
        height: f32,
        measurer: &dyn IntrinsicMeasurer,
    ) -> Result<(LayoutTree, HashMap<String, NodeId>), taffy::TaffyError> {
        let mut taffy: LayoutTree = TaffyTree::new();
        let mut nodes = HashMap::new();
        self.flexible_frames.borrow_mut().clear();
        let children =
            self.build_layout_nodes(&mut taffy, &self.program.root.child, &mut nodes, measurer)?;
        // The window's content fills the window on both axes (it already
        // stretched vertically as the wrapper's cross axis), so resizing the
        // window resizes the root view, not just the area around it.
        for child in &children {
            let mut style = taffy.style(*child)?.clone();
            if style.size.width == Dimension::auto() {
                style.flex_grow = 1.0;
                style.flex_shrink = 1.0;
                style.flex_basis = Dimension::length(0.0);
                // The window bounds its content; overflowing content is
                // clipped like any oversized view instead of widening it.
                if style.min_size.width == LengthPercentageAuto::auto() {
                    style.min_size.width = LengthPercentageAuto::length(0.0);
                }
                taffy.set_style(*child, style)?;
            }
        }
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
        crate::collection::evaluate(expression, &self.state)
    }

    fn eval_number(&self, expression: &UiExpression) -> Option<f32> {
        self.eval(expression).as_f64().map(|value| value as f32)
    }

    fn eval_bool(&self, expression: &UiExpression) -> bool {
        self.eval(expression).as_bool().unwrap_or(false)
    }

    fn active_children<'a>(&self, node: &'a UiNode) -> &'a [UiNode] {
        match node {
            UiNode::Column { children, .. }
            | UiNode::Row { children, .. }
            | UiNode::Overlay { children, .. }
            | UiNode::Scroll { children, .. } => children,
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
            UiNode::Overlay { .. } => RetainedNodeKind::Overlay,
            UiNode::Scroll { .. } => RetainedNodeKind::Scroll,
            // Materialized trees contain no forEach; keep the fragment kind.
            UiNode::Conditional { .. } | UiNode::ForEach { .. } => RetainedNodeKind::Conditional,
            UiNode::Text { .. } => RetainedNodeKind::Text,
            UiNode::Panel { .. } => RetainedNodeKind::Panel,
            UiNode::TextField { .. } => RetainedNodeKind::TextField,
            UiNode::RadioGroup { .. } => RetainedNodeKind::RadioGroup,
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
            UiNode::Overlay { .. } | UiNode::Scroll { .. } | UiNode::Conditional { .. } => {
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
        let measurer = self.measurer.clone();
        let Ok(after_geometry) = self.accessibility_from_layout(
            &taffy,
            &nodes,
            root.bounds.width,
            root.bounds.height,
            measurer.as_ref(),
        ) else {
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
            for id in overlay
                .rects
                .iter()
                .map(|item| &item.id)
                .chain(overlay.texts.iter().map(|item| &item.id))
            {
                if let Some(clip) = overlay.presentation.clip_for(id) {
                    let clip = scene.presentation.push_clip(None, clip, None);
                    scene.presentation.bind_clip(id.clone(), clip);
                }
            }
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
            Value::Number(value) => number_string(&value),
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
        // Flexible frames: a max bound on an axis without a fixed size makes the
        // view take what its parent offers on that axis (applied by the parent,
        // which knows its main axis), clamped to [min, max].
        let mut flexible = [
            width.is_none() && layout.and_then(|layout| layout.max_width).is_some(),
            height.is_none() && layout.and_then(|layout| layout.max_height).is_some(),
        ];
        let bound = |value: Option<f32>| {
            value
                .filter(|value| value.is_finite())
                .map(LengthPercentageAuto::length)
                .unwrap_or(LengthPercentageAuto::auto())
        };
        let min_size = Size {
            width: bound(layout.and_then(|layout| layout.min_width)),
            height: bound(layout.and_then(|layout| layout.min_height)),
        };
        let max_size = Size {
            width: bound(
                layout
                    .and_then(|layout| layout.max_width)
                    .and_then(|bound| bound.length()),
            ),
            height: bound(
                layout
                    .and_then(|layout| layout.max_height)
                    .and_then(|bound| bound.length()),
            ),
        };

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
            min_size,
            max_size,
            ..Default::default()
        };

        match node {
            UiNode::Scroll { axis, .. } => {
                let horizontal = matches!(axis, crate::ir::UiScrollAxis::Horizontal);
                style.display = Display::Flex;
                style.flex_direction = if horizontal {
                    FlexDirection::Row
                } else {
                    FlexDirection::Column
                };
                style.overflow = taffy::geometry::Point {
                    x: if horizontal {
                        taffy::style::Overflow::Scroll
                    } else {
                        taffy::style::Overflow::Hidden
                    },
                    y: if horizontal {
                        taffy::style::Overflow::Hidden
                    } else {
                        taffy::style::Overflow::Scroll
                    },
                };
                // Viewports never take their content's size as a minimum;
                // an authored minWidth/minHeight still applies.
                if style.min_size.width == LengthPercentageAuto::auto() {
                    style.min_size.width = LengthPercentageAuto::length(0.0);
                }
                if style.min_size.height == LengthPercentageAuto::auto() {
                    style.min_size.height = LengthPercentageAuto::length(0.0);
                }
                style.align_items = Some(AlignItems::FLEX_START);
            }
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
                    Some(UiAlignment::Leading) => AlignItems::FLEX_START,
                    Some(UiAlignment::Trailing) => AlignItems::FLEX_END,
                    Some(UiAlignment::Stretch) => AlignItems::STRETCH,
                    Some(UiAlignment::Center) | None => AlignItems::CENTER,
                });
            }
            UiNode::Overlay { alignment, .. } => {
                style.display = Display::Grid;
                let (vertical, horizontal) = match alignment.unwrap_or(UiOverlayAlignment::Center) {
                    UiOverlayAlignment::Center => (AlignItems::CENTER, AlignItems::CENTER),
                    UiOverlayAlignment::Leading => (AlignItems::CENTER, AlignItems::FLEX_START),
                    UiOverlayAlignment::Trailing => (AlignItems::CENTER, AlignItems::FLEX_END),
                    UiOverlayAlignment::Top => (AlignItems::FLEX_START, AlignItems::CENTER),
                    UiOverlayAlignment::Bottom => (AlignItems::FLEX_END, AlignItems::CENTER),
                    UiOverlayAlignment::TopLeading => {
                        (AlignItems::FLEX_START, AlignItems::FLEX_START)
                    }
                    UiOverlayAlignment::TopTrailing => {
                        (AlignItems::FLEX_START, AlignItems::FLEX_END)
                    }
                    UiOverlayAlignment::BottomLeading => {
                        (AlignItems::FLEX_END, AlignItems::FLEX_START)
                    }
                    UiOverlayAlignment::BottomTrailing => {
                        (AlignItems::FLEX_END, AlignItems::FLEX_END)
                    }
                };
                style.align_items = Some(vertical);
                style.justify_items = Some(horizontal);
            }
            UiNode::Text { .. }
            | UiNode::Action { .. }
            | UiNode::Panel { .. }
            | UiNode::TextField { .. }
            | UiNode::RadioGroup { .. } => {}
            UiNode::Conditional { .. } | UiNode::ForEach { .. } => {
                unreachable!("fragments are flattened above and forEach is materialized")
            }
        }

        let intrinsic = match node {
            UiNode::Text { value, .. } => Some(measurer.measure_text(&self.eval_text(value))),
            UiNode::Action { label, .. } => Some(measurer.measure_action(label)),
            UiNode::Panel { .. } => Some(measurer.measure_panel()),
            UiNode::TextField {
                state, placeholder, ..
            } => {
                let value = self.state.get(state).and_then(Value::as_str).unwrap_or("");
                Some(measurer.measure_text_field(value, placeholder.as_deref()))
            }
            UiNode::RadioGroup { options, .. } => {
                let labels = options
                    .iter()
                    .map(|option| option.label.clone())
                    .collect::<Vec<_>>();
                Some(measurer.measure_radio_group(&labels))
            }
            _ => None,
        };

        let mut children = Vec::new();
        // Main axis of this container for children's flexible frames.
        let main_axis_horizontal = match node {
            UiNode::Row { .. } => Some(true),
            UiNode::Column { .. } => Some(false),
            UiNode::Scroll { axis, .. } => {
                Some(matches!(axis, crate::ir::UiScrollAxis::Horizontal))
            }
            _ => None,
        };
        for child in self.active_children(node) {
            let child_nodes = self.build_layout_nodes(taffy, child, nodes, measurer)?;
            for child_id in &child_nodes {
                let Some(child_flex) = self.flexible_frames.borrow().get(child_id).copied() else {
                    continue;
                };
                let mut child_style = taffy.style(*child_id)?.clone();
                for (axis, wants) in [(true, child_flex[0]), (false, child_flex[1])] {
                    if !wants {
                        continue;
                    }
                    match main_axis_horizontal {
                        // A scroll view's main axis is unbounded: nothing to fill.
                        Some(main) if main == axis && matches!(node, UiNode::Scroll { .. }) => {}
                        Some(main) if main == axis => {
                            child_style.flex_grow = 1.0;
                            child_style.flex_basis = Dimension::length(0.0);
                        }
                        // Cross axis of a flex container stretches.
                        Some(_) => child_style.align_self = Some(AlignItems::STRETCH),
                        None => {}
                    }
                }
                // Like SwiftUI, a stack/overlay containing a flexible child is
                // itself flexible on that axis unless it has a fixed size; a
                // scroll view's content does not flex the viewport.
                if !matches!(node, UiNode::Scroll { .. }) {
                    flexible[0] |= width.is_none() && child_flex[0];
                    flexible[1] |= height.is_none() && child_flex[1];
                }
                // Grid (overlay) uses justify_self for width, align_self for height.
                if main_axis_horizontal.is_none() {
                    child_style.justify_self = child_flex[0].then_some(AlignItems::STRETCH);
                    child_style.align_self = child_flex[1].then_some(AlignItems::STRETCH);
                }
                taffy.set_style(*child_id, child_style)?;
            }
            if matches!(node, UiNode::Scroll { .. }) {
                for child_id in &child_nodes {
                    let mut child_style = taffy.style(*child_id)?.clone();
                    child_style.flex_shrink = 0.0;
                    taffy.set_style(*child_id, child_style)?;
                }
            }
            if matches!(node, UiNode::Overlay { .. }) {
                for child_id in &child_nodes {
                    let mut child_style = taffy.style(*child_id)?.clone();
                    child_style.grid_row = Line {
                        start: line(1),
                        end: line(2),
                    };
                    child_style.grid_column = Line {
                        start: line(1),
                        end: line(2),
                    };
                    taffy.set_style(*child_id, child_style)?;
                }
            }
            children.extend(child_nodes);
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
        if flexible[0] || flexible[1] {
            self.flexible_frames.borrow_mut().insert(id, flexible);
        }
        Ok(vec![id])
    }

    pub fn scroll_view(&self, id: &str) -> Option<crate::scroll_view::ScrollViewport> {
        self.scroll_views.borrow().get(id).cloned()
    }

    fn reveal_focused_layout(
        &self,
        taffy: &LayoutTree,
        nodes: &HashMap<String, NodeId>,
    ) -> Result<(), taffy::TaffyError> {
        let requested = self.reveal_request.borrow_mut().take();
        let target = match requested {
            Some(target) => target,
            None => {
                if !self.reveal_focus.replace(false) {
                    return Ok(());
                }
                let Some(focused) = &self.focused_action else {
                    return Ok(());
                };
                focused.clone()
            }
        };
        let focused = target.as_str();
        fn visit(
            runtime: &Runtime,
            node: &UiNode,
            focused: &str,
            taffy: &LayoutTree,
            nodes: &HashMap<String, NodeId>,
            x: f32,
            y: f32,
        ) -> Result<Option<SceneBounds>, taffy::TaffyError> {
            let layout = nodes
                .get(&node.base().id)
                .map(|id| taffy.layout(*id))
                .transpose()?;
            let x = x + layout.map_or(0.0, |layout| layout.location.x);
            let y = y + layout.map_or(0.0, |layout| layout.location.y);
            if node.base().id == focused {
                return Ok(layout.map(|layout| SceneBounds {
                    x,
                    y,
                    width: layout.size.width,
                    height: layout.size.height,
                }));
            }
            let offset = runtime
                .scroll_views
                .borrow()
                .get(&node.base().id)
                .map(|view| view.offset)
                .unwrap_or([0.0; 2]);
            for child in runtime.active_children(node) {
                if let Some(mut target) = visit(
                    runtime,
                    child,
                    focused,
                    taffy,
                    nodes,
                    x - offset[0],
                    y - offset[1],
                )? {
                    if let Some(view) = runtime.scroll_views.borrow_mut().get_mut(&node.base().id) {
                        let layout = layout.expect("scroll layout");
                        let axis = usize::from(!view.horizontal);
                        let (start, end, origin, viewport) = if axis == 0 {
                            (target.x, target.x + target.width, x, layout.size.width)
                        } else {
                            (target.y, target.y + target.height, y, layout.size.height)
                        };
                        let movement = if start < origin {
                            origin - start
                        } else if end > origin + viewport {
                            origin + viewport - end
                        } else {
                            0.0
                        };
                        let before = view.offset;
                        let mut delta = [0.0; 2];
                        delta[axis] = movement;
                        view.scroll(delta);
                        target.x -= view.offset[0] - before[0];
                        target.y -= view.offset[1] - before[1];
                    }
                    return Ok(Some(target));
                }
            }
            Ok(None)
        }
        visit(
            self,
            &self.program.root.child,
            focused,
            taffy,
            nodes,
            0.0,
            0.0,
        )?;
        Ok(())
    }

    fn reconcile_scroll_layout(
        &self,
        taffy: &LayoutTree,
        nodes: &HashMap<String, NodeId>,
    ) -> Result<(), taffy::TaffyError> {
        fn visit(
            runtime: &Runtime,
            node: &UiNode,
            taffy: &LayoutTree,
            nodes: &HashMap<String, NodeId>,
            active: &mut HashSet<String>,
        ) -> Result<(), taffy::TaffyError> {
            if let UiNode::Scroll { base, axis, .. } = node {
                let layout = taffy.layout(nodes[&base.id])?;
                let overflow = layout.scrollable_overflow_rect;
                active.insert(base.id.clone());
                runtime
                    .scroll_views
                    .borrow_mut()
                    .entry(base.id.clone())
                    .or_default()
                    .reconcile(
                        SceneBounds {
                            x: 0.0,
                            y: 0.0,
                            width: layout.size.width,
                            height: layout.size.height,
                        },
                        [
                            overflow.right.max(layout.size.width),
                            overflow.bottom.max(layout.size.height),
                        ],
                        matches!(axis, crate::ir::UiScrollAxis::Horizontal),
                    );
            }
            for child in runtime.active_children(node) {
                visit(runtime, child, taffy, nodes, active)?;
            }
            Ok(())
        }
        let mut active = HashSet::new();
        visit(self, &self.program.root.child, taffy, nodes, &mut active)?;
        self.scroll_views
            .borrow_mut()
            .retain(|id, _| active.contains(id));
        Ok(())
    }

    fn collect_scene(
        &self,
        taffy: &LayoutTree,
        node: &UiNode,
        nodes: &HashMap<String, NodeId>,
        parent_x: f32,
        parent_y: f32,
        inherited_opacity: f32,
        measurer: &dyn IntrinsicMeasurer,
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
                    measurer,
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

        let generic_paint = match node {
            UiNode::Panel { .. } => {
                visual.and_then(|visual| visual.background.as_ref().or(visual.foreground.as_ref()))
            }
            UiNode::Action { .. } | UiNode::TextField { .. } | UiNode::RadioGroup { .. } => None,
            _ => visual.and_then(|visual| visual.background.as_ref()),
        };
        if let Some(paint) = generic_paint {
            let corner_radius = match node {
                UiNode::Panel {
                    shape: Some(UiShapeKind::Circle | UiShapeKind::Capsule),
                    ..
                } => rect.width.min(rect.height) * 0.5,
                _ => visual
                    .and_then(|visual| visual.corner_radius)
                    .unwrap_or(0.0),
            };
            push_painted_rect(
                scene,
                node.base().id.clone(),
                rect,
                Some(paint),
                None,
                corner_radius,
                opacity,
            );
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
                        .and_then(|visual| visual.foreground.as_ref())
                        .and_then(paint_start_color)
                        .unwrap_or(Color::TEXT)
                        .with_opacity(opacity),
                });
            }
            UiNode::Action { base, label, .. } => {
                let focused = self.focused_action.as_deref() == Some(base.id.as_str());
                let paint = base
                    .visual
                    .as_ref()
                    .and_then(|visual| visual.background.as_ref());
                let fallback = if focused {
                    Color::ACTION_FOCUSED
                } else {
                    Color::ACTION
                };
                let background_id = format!("{}:background", base.id);
                push_painted_rect(
                    scene,
                    background_id,
                    rect,
                    paint,
                    Some(fallback),
                    base.visual
                        .as_ref()
                        .and_then(|visual| visual.corner_radius)
                        .unwrap_or(9.0),
                    opacity,
                );
                scene.texts.push(SceneText {
                    id: format!("{}:label", base.id),
                    text: label.clone(),
                    x: x + 16.0,
                    y: y + 8.0,
                    font_size: 16.0,
                    color: base
                        .visual
                        .as_ref()
                        .and_then(|visual| visual.foreground.as_ref())
                        .and_then(paint_start_color)
                        .unwrap_or(Color::TEXT)
                        .with_opacity(opacity),
                });
                scene.actions.push(ActionHit {
                    id: base.id.clone(),
                    rect,
                });
            }
            UiNode::TextField {
                base,
                state,
                placeholder,
            } => {
                let paint = base
                    .visual
                    .as_ref()
                    .and_then(|visual| visual.background.as_ref());
                push_painted_rect(
                    scene,
                    format!("{}:background", base.id),
                    rect,
                    paint,
                    Some(Color::ACTION),
                    base.visual
                        .as_ref()
                        .and_then(|visual| visual.corner_radius)
                        .unwrap_or(7.0),
                    opacity,
                );
                let value = self.state.get(state).and_then(Value::as_str).unwrap_or("");
                let editor = self
                    .focused_text_editor()
                    .filter(|_| self.focused_action.as_deref() == Some(base.id.as_str()))
                    .filter(|editor| editor.text() == value);
                let presentation = editor.map(|editor| editor.presentation_text());
                let value = presentation.as_deref().unwrap_or(value);
                let (text, text_opacity) = if value.is_empty() {
                    (placeholder.as_deref().unwrap_or(""), 0.55)
                } else {
                    (value, 1.0)
                };
                let foreground = base
                    .visual
                    .as_ref()
                    .and_then(|visual| visual.foreground.as_ref())
                    .and_then(paint_start_color)
                    .unwrap_or(Color::TEXT);
                let origin_x = x + TEXT_FIELD_INSET_X;
                let origin_y = y + TEXT_FIELD_INSET_Y;
                let visible_width = (rect.width - TEXT_FIELD_INSET_X * 2.0).max(0.0);
                let line = measurer.text_line(value, TEXT_FIELD_FONT_SIZE);
                let ranges = editor.map(|editor| editor.presentation_ranges());

                // Runtime-owned horizontal text scroll keeps the caret visible in
                // a fixed-width field; it is presentation state, not editing state.
                let scroll = match &ranges {
                    Some(ranges) => {
                        let caret = line.x_for_offset(ranges.caret);
                        let mut scroll = self
                            .text_scroll
                            .borrow()
                            .get(&base.id)
                            .copied()
                            .unwrap_or(0.0);
                        if caret - scroll > visible_width {
                            scroll = caret - visible_width;
                        }
                        if caret < scroll {
                            scroll = caret;
                        }
                        let scroll = scroll.clamp(0.0, (line.width - visible_width).max(0.0));
                        self.text_scroll
                            .borrow_mut()
                            .insert(base.id.clone(), scroll);
                        scroll
                    }
                    None => {
                        self.text_scroll.borrow_mut().remove(&base.id);
                        0.0
                    }
                };
                let text_x = origin_x - scroll;
                let mut decorations = Vec::new();
                if let Some(ranges) = &ranges {
                    if let Some((start, end)) = line.span(ranges.selection.clone()) {
                        decorations.push(SceneRect {
                            id: format!("{}:selection", base.id),
                            rect: SceneBounds {
                                x: text_x + start,
                                y: origin_y,
                                width: end - start,
                                height: line.line_height,
                            },
                            color: Color::SELECTION.with_opacity(opacity),
                            corner_radius: 0.0,
                        });
                    }
                    if let Some((start, end)) = ranges.preedit.clone().and_then(|r| line.span(r)) {
                        decorations.push(SceneRect {
                            id: format!("{}:preedit", base.id),
                            rect: SceneBounds {
                                x: text_x + start,
                                y: origin_y + line.line_height - 1.0,
                                width: end - start,
                                height: 1.0,
                            },
                            color: foreground.with_opacity(opacity * 0.8),
                            corner_radius: 0.0,
                        });
                    }
                    if let Some((start, end)) =
                        ranges.preedit_selection.clone().and_then(|r| line.span(r))
                    {
                        decorations.push(SceneRect {
                            id: format!("{}:preedit-selection", base.id),
                            rect: SceneBounds {
                                x: text_x + start,
                                y: origin_y + line.line_height - 2.0,
                                width: end - start,
                                height: 2.0,
                            },
                            color: foreground.with_opacity(opacity),
                            corner_radius: 0.0,
                        });
                    }
                    decorations.push(SceneRect {
                        id: format!("{}:caret", base.id),
                        rect: SceneBounds {
                            x: text_x + line.x_for_offset(ranges.caret) - TEXT_CARET_WIDTH * 0.5,
                            y: origin_y,
                            width: TEXT_CARET_WIDTH,
                            height: line.line_height,
                        },
                        color: foreground.with_opacity(opacity),
                        corner_radius: 0.0,
                    });
                }
                let text_id = format!("{}:text", base.id);
                let clip = scene.presentation.push_clip(
                    None,
                    SceneBounds {
                        x: x + TEXT_FIELD_INSET_X * 0.5,
                        y,
                        width: (rect.width - TEXT_FIELD_INSET_X).max(0.0),
                        height: rect.height,
                    },
                    None,
                );
                for decoration in decorations {
                    scene.presentation.bind_clip(decoration.id.clone(), clip);
                    scene.rects.push(decoration);
                }
                scene.presentation.bind_clip(text_id.clone(), clip);
                scene.texts.push(SceneText {
                    id: text_id,
                    text: text.to_owned(),
                    x: text_x,
                    y: origin_y,
                    font_size: TEXT_FIELD_FONT_SIZE,
                    color: foreground.with_opacity(opacity * text_opacity),
                });
                scene.actions.push(ActionHit {
                    id: base.id.clone(),
                    rect,
                });
            }
            UiNode::RadioGroup {
                base,
                state,
                options,
            } => {
                if let Some(paint) = base
                    .visual
                    .as_ref()
                    .and_then(|visual| visual.background.as_ref())
                {
                    push_painted_rect(
                        scene,
                        format!("{}:background", base.id),
                        rect,
                        Some(paint),
                        None,
                        base.visual
                            .as_ref()
                            .and_then(|visual| visual.corner_radius)
                            .unwrap_or(0.0),
                        opacity,
                    );
                }
                let selected = self.state.get(state).cloned().unwrap_or(Value::Null);
                let foreground = base
                    .visual
                    .as_ref()
                    .and_then(|visual| visual.foreground.as_ref())
                    .and_then(paint_start_color)
                    .unwrap_or(Color::TEXT);
                for (index, option) in options.iter().enumerate() {
                    let row_y = y + index as f32 * 30.0;
                    let row_rect = SceneBounds {
                        x,
                        y: row_y,
                        width: rect.width,
                        height: 30.0,
                    };
                    let selected_here = selected == option.value;
                    scene.rects.push(SceneRect {
                        id: format!("{}:option:{}:indicator", base.id, index),
                        rect: SceneBounds {
                            x: x + 4.0,
                            y: row_y + 7.0,
                            width: 16.0,
                            height: 16.0,
                        },
                        color: if selected_here {
                            Color([0.36, 0.62, 1.0, opacity])
                        } else {
                            Color([0.30, 0.30, 0.36, opacity])
                        },
                        corner_radius: 8.0,
                    });
                    scene.texts.push(SceneText {
                        id: format!("{}:option:{}:label", base.id, index),
                        text: option.label.clone(),
                        x: x + 28.0,
                        y: row_y + 5.0,
                        font_size: 16.0,
                        color: foreground.with_opacity(if option.disabled {
                            opacity * 0.45
                        } else {
                            opacity
                        }),
                    });
                    if !option.disabled {
                        scene.actions.push(ActionHit {
                            id: format!("{}:option:{}", base.id, index),
                            rect: row_rect,
                        });
                    }
                }
            }
            _ => {}
        }

        let start = (scene.rects.len(), scene.texts.len(), scene.actions.len());
        let offset = self
            .scroll_views
            .borrow()
            .get(&node.base().id)
            .map(|view| view.offset)
            .unwrap_or([0.0; 2]);
        for child in self.active_children(node) {
            self.collect_scene(
                taffy,
                child,
                nodes,
                x - offset[0],
                y - offset[1],
                opacity,
                measurer,
                scene,
            )?;
        }
        if matches!(node, UiNode::Scroll { .. }) {
            let viewport = SceneBounds {
                x,
                y,
                width: layout.size.width,
                height: layout.size.height,
            };
            let scrollbar = self
                .scroll_views
                .borrow_mut()
                .get_mut(&node.base().id)
                .and_then(|view| {
                    view.bounds = viewport;
                    view.update_scrollbar();
                    view.scrollbar
                });
            let ids = scene.rects[start.0..]
                .iter()
                .map(|item| item.id.clone())
                .chain(scene.texts[start.1..].iter().map(|item| item.id.clone()))
                .chain(scene.actions[start.2..].iter().map(|item| item.id.clone()))
                .collect::<Vec<_>>();
            for id in ids {
                let clip = scene
                    .presentation
                    .clip_for(&id)
                    .map(|clip| clip.intersection(viewport))
                    .unwrap_or(viewport);
                let clip = scene.presentation.push_clip(None, clip, None);
                scene.presentation.bind_clip(id, clip);
            }
            // Scrollbars are presentation of runtime scroll state; they sit above
            // content inside the viewport and are clipped only by ancestors.
            if let Some(bar) = scrollbar {
                let id = &node.base().id;
                for (suffix, rect, color) in [
                    ("scrollbar-track", bar.track, Color::SCROLLBAR_TRACK),
                    ("scrollbar-thumb", bar.thumb, Color::SCROLLBAR_THUMB),
                ] {
                    scene.rects.push(SceneRect {
                        id: format!("{id}:{suffix}"),
                        rect,
                        color: color.with_opacity(opacity),
                        corner_radius: crate::scroll_view::SCROLLBAR_THICKNESS * 0.5,
                    });
                }
            }
        }
        Ok(())
    }

    /// Committed text of a field as assistive-technology characters, positioned
    /// with the same shaped line layout and text scroll as the presented text.
    fn accessible_text(
        &self,
        base: &crate::ir::NodeBase,
        value: &str,
        x: f32,
        y: f32,
        measurer: &dyn IntrinsicMeasurer,
    ) -> crate::accessibility::AccessibleText {
        use unicode_segmentation::UnicodeSegmentation;
        let line = measurer.text_line(value, TEXT_FIELD_FONT_SIZE);
        let boundaries = crate::text_edit::grapheme_boundaries(value);
        let index_of = |scalar: usize| match boundaries.binary_search(&scalar) {
            Ok(index) | Err(index) => index,
        };
        let mut positions = Vec::with_capacity(boundaries.len());
        let mut widths = Vec::with_capacity(boundaries.len());
        for pair in boundaries.windows(2) {
            let (start, end) = (line.x_for_offset(pair[0]), line.x_for_offset(pair[1]));
            positions.push(start.min(end));
            widths.push((end - start).abs());
        }
        let editor = self
            .focused_text_editor()
            .filter(|_| self.focused_action.as_deref() == Some(base.id.as_str()))
            .filter(|editor| editor.text() == value);
        let scroll = editor
            .and_then(|_| self.text_scroll.borrow().get(&base.id).copied())
            .unwrap_or(0.0);
        crate::accessibility::AccessibleText {
            id: format!("{}:text-run", base.id),
            value: value.to_owned(),
            character_lengths: value.graphemes(true).map(str::len).collect(),
            character_positions: positions,
            character_widths: widths,
            word_starts: crate::text_edit::word_ranges(value)
                .into_iter()
                .map(|range| index_of(range.start))
                .collect(),
            bounds: AccessibilityBounds {
                x: x + TEXT_FIELD_INSET_X - scroll,
                y: y + TEXT_FIELD_INSET_Y,
                width: line.width,
                height: line.line_height,
            },
            selection: editor.map(|editor| (index_of(editor.anchor()), index_of(editor.cursor()))),
        }
    }

    fn collect_accessibility(
        &self,
        taffy: &LayoutTree,
        node: &UiNode,
        nodes: &HashMap<String, NodeId>,
        parent_x: f32,
        parent_y: f32,
        measurer: &dyn IntrinsicMeasurer,
        output: &mut Vec<AccessibilityNode>,
    ) -> Result<(), taffy::TaffyError> {
        if matches!(node, UiNode::Conditional { .. }) {
            for child in self.active_children(node) {
                self.collect_accessibility(
                    taffy, child, nodes, parent_x, parent_y, measurer, output,
                )?;
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
                UiNode::TextField { .. } => AccessibilityRole::TextField,
                UiNode::RadioGroup { .. } => AccessibilityRole::RadioGroup,
                _ => AccessibilityRole::Group,
            });
        let label = semantics
            .and_then(|semantics| semantics.label.clone())
            .or_else(|| match node {
                UiNode::Text { value, .. } => Some(self.eval_text(value)),
                UiNode::Action { label, .. } => Some(label.clone()),
                UiNode::TextField { placeholder, .. } => placeholder.clone(),
                _ => None,
            });
        let enabled = self.node_enabled(base);
        let mut children: Vec<String> = self
            .active_semantic_children(node)
            .into_iter()
            .map(|child| child.base().id.clone())
            .collect();
        let action_id = matches!(
            node,
            UiNode::Action { .. } | UiNode::TextField { .. } | UiNode::RadioGroup { .. }
        )
        .then(|| base.id.clone());
        let mut options = Vec::new();
        if let UiNode::RadioGroup {
            state,
            options: items,
            ..
        } = node
        {
            // Same row geometry as the presented options and pointer targets.
            let selected = self.state.get(state).cloned().unwrap_or(Value::Null);
            for (index, option) in items.iter().enumerate() {
                let id = format!("{}:option:{}", base.id, index);
                children.push(id.clone());
                let option_enabled = enabled && !option.disabled;
                options.push(AccessibilityNode {
                    id: id.clone(),
                    role: AccessibilityRole::RadioButton,
                    label: Some(option.label.clone()),
                    value: None,
                    enabled: option_enabled,
                    focused: false,
                    bounds: AccessibilityBounds {
                        x,
                        y: y + index as f32 * 30.0,
                        width: layout.size.width,
                        height: 30.0,
                    },
                    children: Vec::new(),
                    action_id: option_enabled.then_some(id),
                    checked: Some(selected == option.value),
                    text: None,
                    scroll: None,
                });
            }
        }
        let text = match node {
            UiNode::TextField { state, .. } => {
                let value = self.state.get(state).and_then(Value::as_str).unwrap_or("");
                Some(self.accessible_text(base, value, x, y, measurer))
            }
            _ => None,
        };
        let scroll = matches!(node, UiNode::Scroll { .. })
            .then(|| self.scroll_views.borrow().get(&base.id).cloned())
            .flatten()
            .filter(|view| view.is_scrollable())
            .map(|view| crate::accessibility::AccessibleScroll {
                horizontal: view.horizontal,
                offset: view.axis_offset(),
                max: view.max_offset(),
            });
        output.push(AccessibilityNode {
            id: base.id.clone(),
            role,
            label,
            value: match node {
                UiNode::TextField { state, .. } => Some(
                    self.state
                        .get(state)
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                ),
                _ => None,
            },
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
            checked: None,
            text,
            scroll,
        });
        output.extend(options);

        let start = output.len();
        let offset = self
            .scroll_views
            .borrow()
            .get(&base.id)
            .map(|view| view.offset)
            .unwrap_or([0.0; 2]);
        for child in self.active_children(node) {
            self.collect_accessibility(
                taffy,
                child,
                nodes,
                x - offset[0],
                y - offset[1],
                measurer,
                output,
            )?;
        }
        if matches!(node, UiNode::Scroll { .. }) {
            let clip = SceneBounds {
                x,
                y,
                width: layout.size.width,
                height: layout.size.height,
            };
            for child in &mut output[start..] {
                let bounds = child.bounds;
                let visible = SceneBounds {
                    x: bounds.x,
                    y: bounds.y,
                    width: bounds.width,
                    height: bounds.height,
                }
                .intersection(clip);
                child.bounds = AccessibilityBounds {
                    x: visible.x,
                    y: visible.y,
                    width: visible.width,
                    height: visible.height,
                };
            }
        }
        Ok(())
    }
}

/// Single-line fields keep pasted line breaks/tabs as spaces and drop other
/// control characters instead of inserting invisible or layout-breaking text.
fn sanitize_single_line(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n");
    normalized
        .chars()
        .filter_map(|ch| match ch {
            '\n' | '\r' | '\t' => Some(' '),
            ch if ch.is_control() => None,
            ch => Some(ch),
        })
        .collect()
}

fn collect_focusable_actions(node: &UiNode, runtime: &Runtime, output: &mut Vec<String>) {
    if matches!(
        node,
        UiNode::Action { .. } | UiNode::TextField { .. } | UiNode::RadioGroup { .. }
    ) && runtime.node_enabled(node.base())
    {
        output.push(node.base().id.clone());
    }
    for child in runtime.active_children(node) {
        collect_focusable_actions(child, runtime, output);
    }
}

fn active_node_exists(node: &UiNode, runtime: &Runtime, id: &str) -> bool {
    node.base().id == id
        || runtime
            .active_children(node)
            .iter()
            .any(|child| active_node_exists(child, runtime, id))
}

fn radio_option_target(id: &str) -> Option<(&str, usize)> {
    let (group, index) = id.rsplit_once(":option:")?;
    Some((group, index.parse().ok()?))
}

fn find_focusable_base<'a>(
    node: &'a UiNode,
    runtime: &Runtime,
    id: &str,
) -> Option<&'a crate::ir::NodeBase> {
    match node {
        UiNode::Action { base, .. }
        | UiNode::TextField { base, .. }
        | UiNode::RadioGroup { base, .. }
            if base.id == id =>
        {
            Some(base)
        }
        _ => runtime
            .active_children(node)
            .iter()
            .find_map(|child| find_focusable_base(child, runtime, id)),
    }
}

fn find_text_field<'a>(
    node: &'a UiNode,
    runtime: &Runtime,
    id: &str,
) -> Option<(&'a str, &'a crate::ir::NodeBase)> {
    match node {
        UiNode::TextField { base, state, .. } if base.id == id => Some((state, base)),
        _ => runtime
            .active_children(node)
            .iter()
            .find_map(|child| find_text_field(child, runtime, id)),
    }
}

fn find_radio_group<'a>(
    node: &'a UiNode,
    runtime: &Runtime,
    id: &str,
) -> Option<(
    &'a str,
    &'a [crate::ir::UiSelectionOption],
    &'a crate::ir::NodeBase,
)> {
    match node {
        UiNode::RadioGroup {
            base,
            state,
            options,
        } if base.id == id => Some((state, options, base)),
        _ => runtime
            .active_children(node)
            .iter()
            .find_map(|child| find_radio_group(child, runtime, id)),
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
        gradients: scene
            .gradients
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
        presentation: scene.presentation.clone(),
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
        UiNode::Column { children, .. }
        | UiNode::Row { children, .. }
        | UiNode::Overlay { children, .. }
        | UiNode::Scroll { children, .. }
        | UiNode::ForEach { children, .. } => {
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
        UiNode::Column { children, .. }
        | UiNode::Row { children, .. }
        | UiNode::Overlay { children, .. }
        | UiNode::Scroll { children, .. }
        | UiNode::ForEach { children, .. } => {
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
    fn number_text_matches_ecmascript_for_integral_results() {
        let number = |value: f64| number_string(&serde_json::Number::from_f64(value).unwrap());
        assert_eq!(number(11.0), "11");
        assert_eq!(number(-0.0), "0");
        assert_eq!(number(0.5), "0.5");
        assert_eq!(number(-3.0), "-3");
        assert_eq!(number_string(&serde_json::Number::from(7)), "7");
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
        assert!(
            runtime
                .motion
                .value(&MotionChannelKey {
                    node_id: "__layout-flip:change".to_owned(),
                    property: MotionProperty::TranslationX,
                })
                .is_some()
        );
        assert!(
            runtime
                .motion
                .value(&MotionChannelKey {
                    node_id: "__layout-flip:keyed-child".to_owned(),
                    property: MotionProperty::TranslationX,
                })
                .is_none()
        );
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
