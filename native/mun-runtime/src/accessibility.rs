use crate::ir::AccessibilityRole;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AccessibilityBounds {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AccessibilityNode {
    pub id: String,
    pub role: AccessibilityRole,
    pub label: Option<String>,
    pub enabled: bool,
    pub focused: bool,
    pub bounds: AccessibilityBounds,
    pub children: Vec<String>,
    pub action_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AccessibilityTree {
    pub root_id: String,
    pub focus_id: Option<String>,
    pub nodes: Vec<AccessibilityNode>,
}

impl AccessibilityTree {
    pub fn node(&self, id: &str) -> Option<&AccessibilityNode> {
        self.nodes.iter().find(|node| node.id == id)
    }
}
