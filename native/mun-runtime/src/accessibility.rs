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
    /// Committed semantic value, separate from accessible name and preedit.
    pub value: Option<String>,
    pub enabled: bool,
    pub focused: bool,
    pub bounds: AccessibilityBounds,
    pub children: Vec<String>,
    pub action_id: Option<String>,
    /// Radio option state; `None` for nodes that are not checkable.
    pub checked: Option<bool>,
    /// Editable single-line text geometry and selection (text fields only).
    pub text: Option<AccessibleText>,
    /// Scroll position of a scrollable viewport whose content overflows.
    pub scroll: Option<AccessibleScroll>,
}

/// One line of committed text inside a text field, in assistive-technology
/// units. A "character" is an extended grapheme cluster: exactly one caret step
/// of the runtime editor, so screen-reader navigation never splits what the
/// editor treats as one character. Preedit text is never included.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AccessibleText {
    pub id: String,
    pub value: String,
    /// UTF-8 byte length of each grapheme.
    pub character_lengths: Vec<usize>,
    /// Start of each grapheme along the line, relative to `bounds.x`.
    pub character_positions: Vec<f32>,
    pub character_widths: Vec<f32>,
    /// Grapheme index at which each word starts.
    pub word_starts: Vec<usize>,
    /// Unclipped line box (scrolled with the field's horizontal text scroll).
    pub bounds: AccessibilityBounds,
    /// `(anchor, focus)` grapheme indices; present while the field is focused.
    pub selection: Option<(usize, usize)>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AccessibleScroll {
    pub horizontal: bool,
    pub offset: f32,
    pub max: f32,
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

#[derive(Clone, Debug, PartialEq)]
pub enum AccessibilityAction {
    Activate,
    Focus,
    Blur,
    /// Grapheme indices into the target field's committed text.
    SetTextSelection {
        anchor: usize,
        focus: usize,
    },
    ReplaceSelectedText(String),
    SetValue(String),
    /// Scroll the target viewport by pages (negative = toward the start).
    ScrollByPages(f32),
    SetScrollOffset(f32),
    /// Reveal the target node through every scrolling ancestor.
    ScrollIntoView,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AccessibilityActionOutcome {
    pub handled: bool,
    pub needs_redraw: bool,
    pub focus_changed: bool,
    pub activated: bool,
    /// Text content or selection changed (IME state must be resynchronized).
    pub edited: bool,
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
                    outcome.activated = self.activate_interactive(target).is_some();
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
            AccessibilityAction::SetTextSelection { anchor, focus } => {
                outcome.handled = self.accessible_select_text(target, anchor, focus);
                outcome.edited = outcome.handled;
            }
            AccessibilityAction::ReplaceSelectedText(text) => {
                outcome.handled = self.accessible_replace_text(target, &text, false);
                outcome.edited = outcome.handled;
            }
            AccessibilityAction::SetValue(text) => {
                outcome.handled = self.accessible_replace_text(target, &text, true);
                outcome.edited = outcome.handled;
            }
            AccessibilityAction::ScrollByPages(pages) => {
                outcome.handled =
                    self.accessible_scroll(target, |view| view.axis_offset() + pages * view.page());
            }
            AccessibilityAction::SetScrollOffset(offset) => {
                outcome.handled = self.accessible_scroll(target, |_| offset);
            }
            AccessibilityAction::ScrollIntoView => {
                outcome.handled = self.request_reveal(target);
            }
        }

        outcome.focus_changed = self.focused_action() != focus_before.as_deref();
        outcome.needs_redraw =
            outcome.focus_changed || outcome.activated || outcome.edited || outcome.handled;
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
