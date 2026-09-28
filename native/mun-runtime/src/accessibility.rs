use crate::{ir::AccessibilityRole, runtime::Runtime};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccessibilityAction {
    Activate,
    Focus,
    Blur,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AccessibilityActionOutcome {
    pub handled: bool,
    pub needs_redraw: bool,
    pub focus_changed: bool,
    pub activated: bool,
}

impl Runtime {
    pub fn handle_accessibility_action(
        &mut self,
        target: &str,
        action: AccessibilityAction,
    ) -> AccessibilityActionOutcome {
        let focus_before = self.focused_action().map(str::to_owned);
        let mut outcome = AccessibilityActionOutcome::default();

        match action {
            AccessibilityAction::Activate => {
                if self.focus_action(target) {
                    outcome.handled = true;
                    outcome.activated = self.activate_action(target).is_some();
                }
            }
            AccessibilityAction::Focus => {
                outcome.handled = self.focus_action(target);
            }
            AccessibilityAction::Blur => {
                if self.focused_action() == Some(target) {
                    self.clear_focus();
                    outcome.handled = true;
                }
            }
        }

        outcome.focus_changed = self.focused_action() != focus_before.as_deref();
        outcome.needs_redraw = outcome.focus_changed || outcome.activated;
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ACCESSIBLE_ACTION: &str = r#"{"version":1,"sourceLanguage":"mun","entry":"AccessibilityActionTest","states":[{"name":"armed","initial":false}],"root":{"kind":"window","id":"root","title":"Accessibility","child":{"kind":"action","id":"primary","label":"Primary","action":{"kind":"toggle-state","state":"armed"}}}}"#;

    #[test]
    fn accessibility_activate_focuses_and_activates_semantic_action() {
        let mut runtime = Runtime::from_json(ACCESSIBLE_ACTION).expect("valid accessible action");
        let outcome = runtime.handle_accessibility_action("primary", AccessibilityAction::Activate);

        assert!(outcome.handled);
        assert!(outcome.focus_changed);
        assert!(outcome.activated);
        assert!(outcome.needs_redraw);
        assert_eq!(runtime.focused_action(), Some("primary"));
    }

    #[test]
    fn accessibility_focus_and_blur_share_runtime_focus_semantics() {
        let mut runtime = Runtime::from_json(ACCESSIBLE_ACTION).expect("valid accessible action");

        let focus = runtime.handle_accessibility_action("primary", AccessibilityAction::Focus);
        assert!(focus.handled);
        assert!(focus.focus_changed);
        assert!(!focus.activated);

        let blur = runtime.handle_accessibility_action("primary", AccessibilityAction::Blur);
        assert!(blur.handled);
        assert!(blur.focus_changed);
        assert_eq!(runtime.focused_action(), None);

        let stale = runtime.handle_accessibility_action("missing", AccessibilityAction::Focus);
        assert!(!stale.handled);
        assert!(!stale.focus_changed);
        assert!(!stale.needs_redraw);
    }
}
