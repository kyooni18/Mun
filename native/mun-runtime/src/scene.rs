#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Rect {
    pub fn contains(self, x: f32, y: f32) -> bool {
        x >= self.x && y >= self.y && x <= self.x + self.width && y <= self.y + self.height
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Color(pub [f32; 4]);

impl Color {
    pub const WINDOW: Self = Self([0.075, 0.075, 0.09, 1.0]);
    pub const TEXT: Self = Self([0.94, 0.94, 0.97, 1.0]);
    pub const ACTION: Self = Self([0.18, 0.18, 0.22, 1.0]);
    pub const ACTION_FOCUSED: Self = Self([0.28, 0.28, 0.34, 1.0]);

    pub fn with_opacity(mut self, opacity: f32) -> Self {
        self.0[3] *= opacity.clamp(0.0, 1.0);
        self
    }

    pub fn parse(value: &str) -> Option<Self> {
        let hex = value.strip_prefix('#')?;
        let parse = |range: std::ops::Range<usize>| u8::from_str_radix(&hex[range], 16).ok();
        match hex.len() {
            6 => Some(Self([
                parse(0..2)? as f32 / 255.0,
                parse(2..4)? as f32 / 255.0,
                parse(4..6)? as f32 / 255.0,
                1.0,
            ])),
            8 => Some(Self([
                parse(0..2)? as f32 / 255.0,
                parse(2..4)? as f32 / 255.0,
                parse(4..6)? as f32 / 255.0,
                parse(6..8)? as f32 / 255.0,
            ])),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SceneRect {
    pub id: String,
    pub rect: Rect,
    pub color: Color,
    pub corner_radius: f32,
}

#[derive(Clone, Debug)]
pub struct SceneText {
    pub id: String,
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub font_size: f32,
    pub color: Color,
}

#[derive(Clone, Debug)]
pub struct ActionHit {
    pub id: String,
    pub rect: Rect,
}

#[derive(Clone, Debug, Default)]
pub struct Scene {
    pub rects: Vec<SceneRect>,
    pub texts: Vec<SceneText>,
    pub actions: Vec<ActionHit>,
}

impl Scene {
    pub fn action_at(&self, x: f32, y: f32) -> Option<&str> {
        self.actions
            .iter()
            .rev()
            .find(|action| action.rect.contains(x, y))
            .map(|action| action.id.as_str())
    }
}
