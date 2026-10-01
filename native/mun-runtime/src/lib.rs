//! Mün's native semantic runtime.
//!
//! This crate consumes backend-neutral UI IR. It owns state, transactions,
//! motion channels, layout adaptation, and retained scene construction. GPU,
//! window-system, and accessibility adapters live outside these semantics.

pub mod accessibility;
pub mod collection;
pub mod gesture;
pub mod input;
pub mod ir;
pub mod layout;
pub mod motion;
pub mod retained;
pub mod runtime;
pub mod scene;
pub mod scroll;
pub mod scroll_view;
pub mod text_edit;
pub mod timeline;

pub use accessibility::{AccessibilityBounds, AccessibilityNode, AccessibilityTree};
pub use gesture::{
    DragAxis, DragAxisConstraint, DragCancelPlan, DragRecognizer, DragRecognizerConfig,
    DragReleaseOptions, DragReleasePlan, DragSettleSpec, DragState, GestureAxisRelease,
    GesturePhase, VelocityTracker, VelocityTrackerConfig, constrain_with_rubber_band,
    constrained_drag_axis_value, nearest_snap, plan_drag_axis_cancel, plan_drag_axis_release,
    rubber_band_distance,
};
pub use input::{
    ButtonState, InputEvent, InputOutcome, InputPoint, KeyState, LogicalKey, Modifiers,
    PhysicalKey, PointerButton, PointerId, ScrollDelta, ScrollPhase,
};
pub use layout::{FallbackIntrinsicMeasurer, IntrinsicMeasurer, IntrinsicSize, TextLineLayout};
pub use retained::{
    RetainedIdentityKey, RetainedNode, RetainedNodeKind, RetainedNumberKey, RetainedReconciliation,
    RetainedTree, RetainedTreeError,
};
pub use runtime::{
    ImeRequest, PlatformConventions, Runtime, RuntimeDiagnostic, RuntimeFrame, RuntimeLoadError,
    SEMANTIC_UI_IR_VERSION, StateMutation, Transaction,
};
pub use scene::{Color, Rect, Scene};
pub use scroll::{
    NestedScrollRouteResult, ScrollAxis, ScrollContainerState, ScrollMetrics, ScrollRange,
    ScrollRouteResult, ScrollState, ScrollTracker, route_nested_content_delta,
};
