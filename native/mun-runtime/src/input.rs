use std::collections::HashMap;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct InputPoint {
    pub x: f32,
    pub y: f32,
}

impl InputPoint {
    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PointerId(pub u64);

impl PointerId {
    pub const MOUSE: Self = Self(0);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointerButton {
    Primary,
    Secondary,
    Middle,
    Back,
    Forward,
    Other(u16),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonState {
    Pressed,
    Released,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub shift: bool,
    pub control: bool,
    pub alt: bool,
    pub meta: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LogicalKey {
    Tab,
    Enter,
    Space,
    Escape,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    Home,
    End,
    Backspace,
    Delete,
    Character(String),
    Unidentified,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhysicalKey {
    Tab,
    Enter,
    Space,
    Escape,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    Home,
    End,
    Backspace,
    Delete,
    Other,
    Unidentified,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyState {
    Pressed,
    Released,
}

/// Canonical scroll content movement.
///
/// Positive X/Y moves content right/down. Line deltas remain device-scale-neutral
/// until a semantic scroll container resolves its line extent. Pixel deltas are
/// logical points after platform-adapter normalization.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ScrollDelta {
    Lines { x: f32, y: f32 },
    Pixels { x: f32, y: f32 },
}

#[derive(Clone, Debug, PartialEq)]
pub enum InputEvent {
    PointerMoved {
        pointer: PointerId,
        position: InputPoint,
    },
    PointerButton {
        pointer: PointerId,
        button: PointerButton,
        state: ButtonState,
    },
    ModifiersChanged(Modifiers),
    Key {
        logical: LogicalKey,
        physical: PhysicalKey,
        state: KeyState,
        repeat: bool,
    },
    TextInput {
        text: String,
    },
    Scroll {
        pointer: Option<PointerId>,
        delta: ScrollDelta,
    },
    Cancel {
        pointer: Option<PointerId>,
    },
    WindowFocusChanged(bool),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputOutcome {
    pub handled: bool,
    pub needs_redraw: bool,
    pub focus_changed: bool,
    pub pressed_changed: bool,
    pub activated: bool,
}

#[derive(Debug, Default)]
pub(crate) struct InputState {
    pointer_positions: HashMap<PointerId, InputPoint>,
    primary_captures: HashMap<PointerId, String>,
    keyboard_capture: Option<String>,
    modifiers: Modifiers,
}

impl InputState {
    pub(crate) fn set_pointer_position(&mut self, pointer: PointerId, position: InputPoint) {
        self.pointer_positions.insert(pointer, position);
    }

    pub(crate) fn pointer_position(&self, pointer: PointerId) -> Option<InputPoint> {
        self.pointer_positions.get(&pointer).copied()
    }

    pub(crate) fn primary_capture(&self, pointer: PointerId) -> Option<&str> {
        self.primary_captures.get(&pointer).map(String::as_str)
    }

    pub(crate) fn capture_primary(&mut self, pointer: PointerId, action: String) -> bool {
        self.primary_captures.insert(pointer, action).is_none()
    }

    pub(crate) fn take_primary_capture(&mut self, pointer: PointerId) -> Option<String> {
        self.primary_captures.remove(&pointer)
    }

    pub(crate) fn clear_primary_capture(&mut self, pointer: PointerId) -> bool {
        self.primary_captures.remove(&pointer).is_some()
    }

    pub(crate) fn keyboard_capture(&self) -> Option<&str> {
        self.keyboard_capture.as_deref()
    }

    pub(crate) fn capture_keyboard(&mut self, action: String) -> bool {
        let changed = self.keyboard_capture.as_deref() != Some(action.as_str());
        self.keyboard_capture = Some(action);
        changed
    }

    pub(crate) fn take_keyboard_capture(&mut self) -> Option<String> {
        self.keyboard_capture.take()
    }

    pub(crate) fn clear_keyboard_capture(&mut self) -> bool {
        self.keyboard_capture.take().is_some()
    }

    pub(crate) fn set_modifiers(&mut self, modifiers: Modifiers) {
        self.modifiers = modifiers;
    }

    pub(crate) fn modifiers(&self) -> Modifiers {
        self.modifiers
    }

    pub(crate) fn cancel_pointer(&mut self, pointer: Option<PointerId>) -> bool {
        if let Some(pointer) = pointer {
            self.pointer_positions.remove(&pointer);
            self.primary_captures.remove(&pointer).is_some()
        } else {
            self.pointer_positions.clear();
            let had_capture = !self.primary_captures.is_empty();
            self.primary_captures.clear();
            had_capture
        }
    }
}
