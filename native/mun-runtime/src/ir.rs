use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum UiBinaryOperator {
    Add,
    Subtract,
    Multiply,
    Divide,
    Modulo,
    Equal,
    NotEqual,
    Less,
    LessOrEqual,
    Greater,
    GreaterOrEqual,
    And,
    Or,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind")]
pub enum UiExpression {
    #[serde(rename = "literal")]
    Literal { value: Value },
    #[serde(rename = "state")]
    State { state: String },
    #[serde(rename = "not")]
    Not { value: Box<UiExpression> },
    #[serde(rename = "stringify")]
    Stringify { value: Box<UiExpression> },
    #[serde(rename = "binary")]
    Binary {
        operator: UiBinaryOperator,
        left: Box<UiExpression>,
        right: Box<UiExpression>,
    },
    #[serde(rename = "conditional")]
    Conditional {
        condition: Box<UiExpression>,
        #[serde(rename = "then")]
        then_value: Box<UiExpression>,
        otherwise: Box<UiExpression>,
    },
    /// Current item (or field path inside it) of the enclosing `forEach`.
    #[serde(rename = "item")]
    Item {
        #[serde(rename = "forEach")]
        for_each: String,
        #[serde(default)]
        path: Vec<String>,
    },
    #[serde(rename = "record")]
    Record {
        fields: std::collections::BTreeMap<String, UiExpression>,
    },
    #[serde(rename = "count")]
    Count { collection: Box<UiExpression> },
    #[serde(rename = "filter")]
    Filter {
        collection: Box<UiExpression>,
        path: Vec<String>,
        operator: UiFilterOperator,
        value: Box<UiExpression>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum UiFilterOperator {
    Equal,
    NotEqual,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
    pub name: String,
    pub initial: Value,
    /// `forEach` template whose items each own an instance of this state.
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AccessibilityRole {
    Window,
    Group,
    Text,
    Button,
    TextField,
    RadioGroup,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilitySemantics {
    pub role: AccessibilityRole,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub enabled: Option<UiExpression>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UiAlignment {
    Leading,
    Center,
    Trailing,
    Stretch,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UiOverlayAlignment {
    Center,
    Leading,
    Trailing,
    Top,
    Bottom,
    TopLeading,
    TopTrailing,
    BottomLeading,
    BottomTrailing,
}

#[derive(Clone, Debug)]
pub enum UiPaint {
    Solid {
        color: String,
    },
    LinearGradient {
        start: String,
        end: String,
        start_point: UiOverlayAlignment,
        end_point: UiOverlayAlignment,
    },
}

impl<'de> Deserialize<'de> for UiPaint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(tag = "kind")]
        enum StructuredPaint {
            #[serde(rename = "solid")]
            Solid { color: String },
            #[serde(rename = "linearGradient")]
            LinearGradient {
                start: String,
                end: String,
                #[serde(rename = "startPoint")]
                start_point: UiOverlayAlignment,
                #[serde(rename = "endPoint")]
                end_point: UiOverlayAlignment,
            },
        }

        #[derive(Deserialize)]
        #[serde(untagged)]
        enum PaintWire {
            LegacySolid(String),
            Structured(StructuredPaint),
        }

        Ok(match PaintWire::deserialize(deserializer)? {
            PaintWire::LegacySolid(color) => Self::Solid { color },
            PaintWire::Structured(StructuredPaint::Solid { color }) => Self::Solid { color },
            PaintWire::Structured(StructuredPaint::LinearGradient {
                start,
                end,
                start_point,
                end_point,
            }) => Self::LinearGradient {
                start,
                end,
                start_point,
                end_point,
            },
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum UiShapeKind {
    Rectangle,
    RoundedRectangle,
    Circle,
    Capsule,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSelectionOption {
    pub label: String,
    pub value: Value,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiLayout {
    #[serde(default)]
    pub width: Option<UiExpression>,
    #[serde(default)]
    pub height: Option<UiExpression>,
    #[serde(default)]
    pub padding: Option<f32>,
    #[serde(default)]
    pub spacing: Option<f32>,
    #[serde(default)]
    pub alignment: Option<UiAlignment>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiVisual {
    #[serde(default)]
    pub background: Option<UiPaint>,
    #[serde(default)]
    pub foreground: Option<UiPaint>,
    #[serde(default)]
    pub corner_radius: Option<f32>,
    #[serde(default)]
    pub opacity: Option<UiExpression>,
    #[serde(default)]
    pub translation_x: Option<UiExpression>,
    #[serde(default)]
    pub translation_y: Option<UiExpression>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MotionProperty {
    Opacity,
    TranslationX,
    TranslationY,
    ScaleX,
    ScaleY,
    Rotation,
    ForegroundColor,
    BackgroundColor,
    BorderColor,
    Width,
    Height,
    MinWidth,
    MinHeight,
    MaxWidth,
    MaxHeight,
    PaddingTop,
    PaddingRight,
    PaddingBottom,
    PaddingLeft,
    MarginTop,
    MarginRight,
    MarginBottom,
    MarginLeft,
    RowGap,
    ColumnGap,
    FontSize,
    LineHeight,
    LetterSpacing,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind")]
pub enum MotionExecutionPlan {
    #[serde(rename = "spring")]
    Spring {
        omega: f32,
        #[serde(rename = "dampingRatio")]
        damping_ratio: f32,
        #[serde(rename = "blendDuration")]
        blend_duration: f32,
        #[serde(rename = "delayMs")]
        delay_ms: f32,
        #[serde(rename = "repeatCount")]
        repeat_count: Value,
        autoreverses: bool,
    },
    #[serde(rename = "timing")]
    Timing {
        duration: f32,
        curve: [f32; 4],
        #[serde(rename = "delayMs")]
        delay_ms: f32,
        #[serde(rename = "repeatCount")]
        repeat_count: Value,
        autoreverses: bool,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TransitionEdge {
    Top,
    Bottom,
    Leading,
    Trailing,
    Left,
    Right,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind")]
pub enum TransitionEffect {
    #[serde(rename = "opacity")]
    Opacity,
    #[serde(rename = "scale")]
    Scale { scale: f32 },
    #[serde(rename = "move")]
    Move { edge: TransitionEdge, distance: f32 },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiTransition {
    #[serde(default)]
    pub insertion: Vec<TransitionEffect>,
    #[serde(default)]
    pub removal: Vec<TransitionEffect>,
    #[serde(default)]
    pub animation: Option<MotionExecutionPlan>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiMotionBinding {
    pub property: MotionProperty,
    pub property_mask: u32,
    pub value: UiExpression,
    #[serde(default)]
    pub trigger: Option<UiExpression>,
    #[serde(default)]
    pub plan: Option<MotionExecutionPlan>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiTransaction {
    #[serde(default)]
    pub animation: Option<MotionExecutionPlan>,
    #[serde(default)]
    pub disables_animations: bool,
    #[serde(default)]
    pub is_continuous: bool,
}

/// Keyed collection mutation; items are addressed by key, never by index.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
pub enum UiCollectionOperation {
    Insert {
        index: UiExpression,
        value: UiExpression,
    },
    Append {
        value: UiExpression,
    },
    Remove {
        key: UiExpression,
    },
    Move {
        key: UiExpression,
        offset: UiExpression,
    },
    Update {
        key: UiExpression,
        path: Vec<String>,
        value: UiExpression,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind")]
pub enum UiAction {
    #[serde(rename = "toggle-state")]
    ToggleState {
        state: String,
        #[serde(default)]
        transaction: Option<UiTransaction>,
    },
    #[serde(rename = "set-state")]
    SetState {
        state: String,
        value: UiExpression,
        #[serde(default)]
        transaction: Option<UiTransaction>,
    },
    #[serde(rename = "collection")]
    Collection {
        state: String,
        #[serde(rename = "keyPath")]
        key_path: Vec<String>,
        #[serde(flatten)]
        operation: UiCollectionOperation,
        #[serde(default)]
        transaction: Option<UiTransaction>,
    },
    #[serde(rename = "sequence")]
    Sequence {
        actions: Vec<UiAction>,
        #[serde(default)]
        transaction: Option<UiTransaction>,
    },
}

impl UiAction {
    pub fn transaction(&self) -> Option<&UiTransaction> {
        match self {
            Self::ToggleState { transaction, .. }
            | Self::SetState { transaction, .. }
            | Self::Collection { transaction, .. }
            | Self::Sequence { transaction, .. } => transaction.as_ref(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeBase {
    pub id: String,
    #[serde(default)]
    pub identity_key: Option<UiExpression>,
    #[serde(default)]
    pub layout: Option<UiLayout>,
    #[serde(default)]
    pub visual: Option<UiVisual>,
    #[serde(default)]
    pub accessibility: Option<AccessibilitySemantics>,
    #[serde(default)]
    pub motion: Vec<UiMotionBinding>,
    #[serde(default)]
    pub transition: Option<UiTransition>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UiScrollAxis {
    Vertical,
    Horizontal,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind")]
pub enum UiNode {
    #[serde(rename = "scroll")]
    Scroll {
        #[serde(flatten)]
        base: NodeBase,
        axis: UiScrollAxis,
        children: Vec<UiNode>,
    },
    #[serde(rename = "column")]
    Column {
        #[serde(flatten)]
        base: NodeBase,
        children: Vec<UiNode>,
    },
    #[serde(rename = "row")]
    Row {
        #[serde(flatten)]
        base: NodeBase,
        children: Vec<UiNode>,
    },
    #[serde(rename = "overlay")]
    Overlay {
        #[serde(flatten)]
        base: NodeBase,
        #[serde(default)]
        alignment: Option<UiOverlayAlignment>,
        children: Vec<UiNode>,
    },
    #[serde(rename = "conditional")]
    Conditional {
        #[serde(flatten)]
        base: NodeBase,
        condition: UiExpression,
        #[serde(rename = "then")]
        then_nodes: Vec<UiNode>,
        #[serde(default)]
        otherwise: Vec<UiNode>,
    },
    /// Keyed dynamic children: `children` is instantiated per collection item.
    /// The runtime materializes each instance (identity = template identity +
    /// item key) before layout; materialized trees never contain this variant.
    #[serde(rename = "forEach")]
    ForEach {
        #[serde(flatten)]
        base: NodeBase,
        collection: UiExpression,
        #[serde(rename = "keyPath")]
        key_path: Vec<String>,
        children: Vec<UiNode>,
    },
    #[serde(rename = "text")]
    Text {
        #[serde(flatten)]
        base: NodeBase,
        value: UiExpression,
    },
    #[serde(rename = "panel")]
    Panel {
        #[serde(flatten)]
        base: NodeBase,
        #[serde(default)]
        shape: Option<UiShapeKind>,
    },
    #[serde(rename = "textField")]
    TextField {
        #[serde(flatten)]
        base: NodeBase,
        state: String,
        #[serde(default)]
        placeholder: Option<String>,
    },
    #[serde(rename = "radioGroup")]
    RadioGroup {
        #[serde(flatten)]
        base: NodeBase,
        state: String,
        options: Vec<UiSelectionOption>,
    },
    #[serde(rename = "action")]
    Action {
        #[serde(flatten)]
        base: NodeBase,
        label: String,
        action: UiAction,
    },
}

impl UiNode {
    pub fn base(&self) -> &NodeBase {
        match self {
            Self::Column { base, .. }
            | Self::Row { base, .. }
            | Self::Overlay { base, .. }
            | Self::Conditional { base, .. }
            | Self::ForEach { base, .. }
            | Self::Text { base, .. }
            | Self::Panel { base, .. }
            | Self::Scroll { base, .. }
            | Self::TextField { base, .. }
            | Self::RadioGroup { base, .. }
            | Self::Action { base, .. } => base,
        }
    }

    pub fn children(&self) -> &[UiNode] {
        match self {
            Self::Column { children, .. }
            | Self::Row { children, .. }
            | Self::Overlay { children, .. }
            | Self::Scroll { children, .. }
            | Self::ForEach { children, .. } => children,
            _ => &[],
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiWindow {
    pub kind: String,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub identity_key: Option<UiExpression>,
    #[serde(default)]
    pub layout: Option<UiLayout>,
    #[serde(default)]
    pub visual: Option<UiVisual>,
    #[serde(default)]
    pub accessibility: Option<AccessibilitySemantics>,
    #[serde(default)]
    pub motion: Vec<UiMotionBinding>,
    #[serde(default)]
    pub transition: Option<UiTransition>,
    pub child: UiNode,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiProgram {
    pub version: u32,
    pub source_language: String,
    pub entry: String,
    pub states: Vec<UiState>,
    pub root: UiWindow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_base_preserves_semantic_identity_key() {
        let node: UiNode = serde_json::from_value(serde_json::json!({
            "kind": "text",
            "id": "@node/entry/App/body/kind/text",
            "identityKey": { "kind": "literal", "value": "hero" },
            "value": { "kind": "literal", "value": "Hello" }
        }))
        .expect("semantic node");

        match node.base().identity_key.as_ref() {
            Some(UiExpression::Literal { value }) => assert_eq!(value, "hero"),
            other => panic!("expected literal semantic identity key, received {other:?}"),
        }
    }

    #[test]
    fn window_preserves_full_semantic_node_base_metadata() {
        let program: UiProgram = serde_json::from_value(serde_json::json!({
            "version": 1,
            "sourceLanguage": "mun",
            "entry": "App",
            "states": [],
            "root": {
                "kind": "window",
                "id": "window-root",
                "identityKey": { "kind": "state", "state": "window-key" },
                "title": "Mün",
                "visual": {
                    "opacity": { "kind": "literal", "value": 0.75 }
                },
                "motion": [{
                    "property": "opacity",
                    "propertyMask": 1,
                    "value": { "kind": "state", "state": "window-opacity" }
                }],
                "transition": {
                    "insertion": [{ "kind": "opacity" }],
                    "removal": [{ "kind": "opacity" }]
                },
                "child": {
                    "kind": "text",
                    "id": "label",
                    "value": { "kind": "literal", "value": "Hello" }
                }
            }
        }))
        .expect("semantic program");

        assert!(matches!(
            program.root.identity_key,
            Some(UiExpression::State { ref state }) if state == "window-key"
        ));
        assert!(program.root.visual.is_some());
        assert_eq!(program.root.motion.len(), 1);
        assert!(program.root.transition.is_some());
    }
}
