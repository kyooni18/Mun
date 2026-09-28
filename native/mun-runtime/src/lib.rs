//! Mün's native semantic runtime.
//!
//! This crate consumes backend-neutral UI IR. It owns state, transactions,
//! motion channels, layout adaptation, and retained scene construction. GPU,
//! window-system, and accessibility adapters live outside these semantics.

pub mod accessibility;
pub mod input;
pub mod ir;
pub mod motion;
pub mod runtime;
pub mod scene;
pub mod timeline;

pub use accessibility::{AccessibilityBounds, AccessibilityNode, AccessibilityTree};
pub use input::{
    ButtonState, InputEvent, InputOutcome, InputPoint, KeyState, LogicalKey, Modifiers,
    PhysicalKey, PointerButton, PointerId, ScrollDelta,
};
pub use runtime::{
    Runtime, RuntimeFrame, RuntimeLoadError, SEMANTIC_UI_IR_VERSION, StateMutation, Transaction,
};
pub use scene::{Color, Rect, Scene};
