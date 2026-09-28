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
    pub activated: bool,
}

#[derive(Debug, Default)]
pub(crate) struct InputState {
    pointer_positions: HashMap<PointerId, InputPoint>,
    modifiers: Modifiers,
}

impl InputState {
    pub(crate) fn set_pointer_position(&mut self, pointer: PointerId, position: InputPoint) {
        self.pointer_positions.insert(pointer, position);
    }

    pub(crate) fn pointer_position(&self, pointer: PointerId) -> Option<InputPoint> {
        self.pointer_positions.get(&pointer).copied()
    }

    pub(crate) fn set_modifiers(&mut self, modifiers: Modifiers) {
        self.modifiers = modifiers;
    }

    pub(crate) fn modifiers(&self) -> Modifiers {
        self.modifiers
    }

    pub(crate) fn cancel_pointer(&mut self, pointer: Option<PointerId>) {
        if let Some(pointer) = pointer {
            self.pointer_positions.remove(&pointer);
        } else {
            self.pointer_positions.clear();
        }
    }
}
