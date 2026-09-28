//! Mün's native semantic runtime.
//!
//! This crate consumes backend-neutral UI IR. It owns state, transactions,
//! motion channels, layout adaptation, and retained scene construction. GPU,
//! window-system, and accessibility adapters live outside these semantics.

pub mod accessibility;
pub mod gesture;
pub mod input;
pub mod ir;
pub mod layout;
pub mod motion;
pub mod retained;
pub mod runtime;
pub mod scene;
pub mod scroll;
pub mod timeline;

pub use accessibility::{AccessibilityBounds, AccessibilityNode, AccessibilityTree};
pub use gesture::{
    DragAxis, DragRecognizer, DragRecognizerConfig, DragState, GestureAxisRelease, GesturePhase,
    VelocityTracker, VelocityTrackerConfig, constrain_with_rubber_band, rubber_band_distance,
};
pub use input::{
    ButtonState, InputEvent, InputOutcome, InputPoint, KeyState, LogicalKey, Modifiers,
    PhysicalKey, PointerButton, PointerId, ScrollDelta,
};
pub use layout::{FallbackIntrinsicMeasurer, IntrinsicMeasurer, IntrinsicSize};
pub use retained::{
    RetainedNode, RetainedNodeKind, RetainedReconciliation, RetainedTree, RetainedTreeError,
};
pub use runtime::{
    Runtime, RuntimeFrame, RuntimeLoadError, SEMANTIC_UI_IR_VERSION, StateMutation, Transaction,
};
pub use scene::{Color, Rect, Scene};
pub use scroll::{
    NestedScrollRouteResult, ScrollAxis, ScrollContainerState, ScrollMetrics, ScrollRange,
    ScrollRouteResult, ScrollState, ScrollTracker, route_nested_content_delta,
};
