//! Platform-neutral single-line editing. All public offsets count Unicode scalar
//! values, never UTF-8 bytes. Grapheme/word navigation can be layered on this
//! explicit contract without exposing platform offsets to controls.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Composition {
    pub text: String,
    /// Selection inside the preedit, in Unicode scalar offsets.
    pub selection: Option<(usize, usize)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TextEdit {
    Insert(String),
    Left { select: bool },
    Right { select: bool },
    Home { select: bool },
    End { select: bool },
    SelectAll,
    Backspace,
    Delete,
    CompositionStart,
    CompositionUpdate(Composition),
    CompositionCommit(String),
    CompositionCancel,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TextEditor {
    text: String,
    anchor: usize,
    cursor: usize,
    composition: Option<Composition>,
}

impl TextEditor {
    pub fn new(text: String) -> Self {
        let cursor = text.chars().count();
        Self {
            text,
            anchor: cursor,
            cursor,
            composition: None,
        }
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn cursor(&self) -> usize {
        self.cursor
    }
    pub fn anchor(&self) -> usize {
        self.anchor
    }
    pub fn selection(&self) -> std::ops::Range<usize> {
        self.anchor.min(self.cursor)..self.anchor.max(self.cursor)
    }
    pub fn composition(&self) -> Option<&Composition> {
        self.composition.as_ref()
    }
    pub fn selected_text(&self) -> &str {
        let range = self.selection();
        &self.text[self.byte(range.start)..self.byte(range.end)]
    }
    /// An external binding change invalidates preedit and collapses selection.
    pub fn synchronize(&mut self, text: &str) {
        if self.text != text {
            *self = Self::new(text.to_owned());
        }
    }
    pub fn cancel_composition(&mut self) {
        self.composition = None;
    }
    pub fn presentation_text(&self) -> String {
        let Some(composition) = &self.composition else {
            return self.text.clone();
        };
        let range = self.selection();
        format!(
            "{}{}{}",
            &self.text[..self.byte(range.start)],
            composition.text,
            &self.text[self.byte(range.end)..]
        )
    }
    fn byte(&self, scalar: usize) -> usize {
        self.text
            .char_indices()
            .nth(scalar)
            .map_or(self.text.len(), |(byte, _)| byte)
    }
    fn replace(&mut self, text: &str) {
        let range = self.selection();
        self.text
            .replace_range(self.byte(range.start)..self.byte(range.end), text);
        self.cursor = range.start + text.chars().count();
        self.anchor = self.cursor;
    }
    fn move_to(&mut self, cursor: usize, select: bool) {
        self.cursor = cursor.min(self.text.chars().count());
        if !select {
            self.anchor = self.cursor;
        }
    }
    /// Returns whether committed text changed. Preedit never mutates the binding.
    pub fn apply(&mut self, edit: TextEdit) -> bool {
        let before = self.text.clone();
        match edit {
            TextEdit::CompositionStart => {
                self.composition = Some(Composition {
                    text: String::new(),
                    selection: None,
                })
            }
            TextEdit::CompositionUpdate(mut composition) => {
                let len = composition.text.chars().count();
                composition.selection =
                    composition.selection.map(|(a, b)| (a.min(len), b.min(len)));
                self.composition = Some(composition);
            }
            TextEdit::CompositionCancel => self.cancel_composition(),
            TextEdit::CompositionCommit(text) => {
                self.cancel_composition();
                self.replace(&text);
            }
            // A composing IME owns editing keys; the host forwards its eventual
            // commit/cancel rather than letting arrows/backspace corrupt preedit.
            _ if self.composition.is_some() => {}
            TextEdit::Insert(text) => self.replace(&text),
            TextEdit::Left { select } => {
                let cursor = if !select && !self.selection().is_empty() {
                    self.selection().start
                } else {
                    self.cursor.saturating_sub(1)
                };
                self.move_to(cursor, select);
            }
            TextEdit::Right { select } => {
                let cursor = if !select && !self.selection().is_empty() {
                    self.selection().end
                } else {
                    self.cursor.saturating_add(1)
                };
                self.move_to(cursor, select);
            }
            TextEdit::Home { select } => self.move_to(0, select),
            TextEdit::End { select } => self.move_to(self.text.chars().count(), select),
            TextEdit::SelectAll => {
                self.anchor = 0;
                self.cursor = self.text.chars().count();
            }
            TextEdit::Backspace => {
                if self.selection().is_empty() {
                    self.anchor = self.cursor.saturating_sub(1);
                }
                self.replace("");
            }
            TextEdit::Delete => {
                if self.selection().is_empty() {
                    self.anchor = (self.cursor + 1).min(self.text.chars().count());
                }
                self.replace("");
            }
        }
        self.text != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_selection_replacement_and_deletion() {
        let mut editor = TextEditor::new("A한😀Z".into());
        editor.apply(TextEdit::Left { select: false });
        editor.apply(TextEdit::Left { select: true });
        assert_eq!(editor.selected_text(), "😀");
        editor.apply(TextEdit::Insert("글".into()));
        assert_eq!(editor.text(), "A한글Z");
        editor.apply(TextEdit::Backspace);
        editor.apply(TextEdit::Delete);
        assert_eq!(editor.text(), "A한");
        editor.apply(TextEdit::Home { select: true });
        assert_eq!(editor.selected_text(), "A한");
        editor.apply(TextEdit::Delete);
        assert_eq!(editor.text(), "");
    }
    #[test]
    fn hangul_preedit_does_not_commit_and_cancel_preserves_selection() {
        let mut editor = TextEditor::new("old".into());
        editor.apply(TextEdit::SelectAll);
        for text in ["ㅎ", "하", "한"] {
            assert!(!editor.apply(TextEdit::CompositionUpdate(Composition {
                text: text.into(),
                selection: Some((1, 1))
            })));
            assert_eq!(editor.text(), "old");
            assert_eq!(editor.presentation_text(), text);
        }
        editor.apply(TextEdit::Backspace);
        assert_eq!(editor.text(), "old");
        editor.apply(TextEdit::CompositionCancel);
        assert_eq!(editor.selected_text(), "old");
        assert!(editor.apply(TextEdit::CompositionCommit("한".into())));
        assert_eq!(editor.text(), "한");
        assert_eq!(editor.cursor(), 1);
    }
    #[test]
    fn japanese_chinese_composition_and_external_change() {
        let mut editor = TextEditor::new("".into());
        for text in ["にほん", "日本", "中文"] {
            editor.apply(TextEdit::CompositionUpdate(Composition {
                text: text.into(),
                selection: None,
            }));
            assert_eq!(editor.text(), "");
        }
        editor.synchronize("external");
        assert!(editor.composition().is_none());
        assert_eq!(editor.cursor(), 8);
    }
}
