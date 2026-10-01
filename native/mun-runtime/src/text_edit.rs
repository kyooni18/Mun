//! Platform-neutral single-line editing.
//!
//! All public offsets count Unicode scalar values, never UTF-8 bytes or UTF-16
//! units; platform adapters normalize their offsets before reaching this layer.
//! Every committed cursor/anchor position additionally lies on an extended
//! grapheme cluster boundary, so ordinary movement and deletion never split a
//! combining sequence, decomposed Hangul syllable, emoji modifier/ZWJ sequence
//! or regional-indicator flag. Word navigation is a separate operation over
//! Unicode word boundaries and never redefines character movement.
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Composition {
    pub text: String,
    /// Selection inside the preedit, in Unicode scalar offsets.
    pub selection: Option<(usize, usize)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TextEdit {
    Insert(String),
    /// Previous/next extended grapheme cluster.
    Left {
        select: bool,
    },
    Right {
        select: bool,
    },
    /// Previous word start / next word end (Unicode word boundaries).
    WordLeft {
        select: bool,
    },
    WordRight {
        select: bool,
    },
    Home {
        select: bool,
    },
    End {
        select: bool,
    },
    SelectAll,
    /// Delete the selection, otherwise the previous grapheme cluster.
    Backspace,
    /// Delete the selection, otherwise the next grapheme cluster.
    Delete,
    DeleteWordBackward,
    DeleteWordForward,
    DeleteToStart,
    /// Pointer placement. The offset is snapped to the nearest grapheme boundary;
    /// `select` keeps the anchor (drag or shift-click extension).
    PlaceCursor {
        offset: usize,
        select: bool,
    },
    CompositionStart,
    CompositionUpdate(Composition),
    CompositionCommit(String),
    CompositionCancel,
}

/// Scalar offsets of every extended grapheme cluster boundary, including 0 and
/// the scalar length.
pub fn grapheme_boundaries(text: &str) -> Vec<usize> {
    let mut boundaries = Vec::with_capacity(text.len() + 1);
    let mut scalar = 0;
    boundaries.push(0);
    for grapheme in text.graphemes(true) {
        scalar += grapheme.chars().count();
        boundaries.push(scalar);
    }
    boundaries
}

/// Scalar ranges of Unicode words (letters/numbers/ideographs; separators excluded).
pub fn word_ranges(text: &str) -> Vec<std::ops::Range<usize>> {
    let mut output = Vec::new();
    let mut byte_cursor = 0;
    let mut scalar_cursor = 0;
    for (byte, word) in text.unicode_word_indices() {
        scalar_cursor += text[byte_cursor..byte].chars().count();
        let len = word.chars().count();
        output.push(scalar_cursor..scalar_cursor + len);
        scalar_cursor += len;
        byte_cursor = byte + word.len();
    }
    output
}

pub fn scalar_to_byte(text: &str, scalar: usize) -> usize {
    text.char_indices()
        .nth(scalar)
        .map_or(text.len(), |(byte, _)| byte)
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TextEditor {
    text: String,
    boundaries: Vec<usize>,
    anchor: usize,
    cursor: usize,
    composition: Option<Composition>,
}

impl TextEditor {
    pub fn new(text: String) -> Self {
        let boundaries = grapheme_boundaries(&text);
        let cursor = *boundaries.last().expect("boundary list always contains 0");
        Self {
            text,
            boundaries,
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
    fn len(&self) -> usize {
        *self
            .boundaries
            .last()
            .expect("boundary list always contains 0")
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
    /// Text shown to the user: committed text with the active preedit replacing
    /// the selection. Never written to the binding or accessibility value.
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
    /// Caret, selection and preedit ranges in presentation-text scalar offsets.
    pub fn presentation_ranges(&self) -> PresentationRanges {
        match &self.composition {
            None => PresentationRanges {
                caret: self.cursor,
                selection: self.selection(),
                preedit: None,
                preedit_selection: None,
            },
            Some(composition) => {
                let start = self.selection().start;
                let len = composition.text.chars().count();
                let (selection_start, selection_end) = composition.selection.unwrap_or((len, len));
                let (a, b) = (
                    selection_start.min(selection_end).min(len),
                    selection_start.max(selection_end).min(len),
                );
                PresentationRanges {
                    caret: start + selection_end.min(len),
                    selection: start..start,
                    preedit: Some(start..start + len),
                    preedit_selection: (a != b).then(|| start + a..start + b),
                }
            }
        }
    }
    fn byte(&self, scalar: usize) -> usize {
        scalar_to_byte(&self.text, scalar)
    }
    fn previous_boundary(&self, offset: usize) -> usize {
        self.boundaries
            .iter()
            .rev()
            .copied()
            .find(|boundary| *boundary < offset)
            .unwrap_or(0)
    }
    fn next_boundary(&self, offset: usize) -> usize {
        self.boundaries
            .iter()
            .copied()
            .find(|boundary| *boundary > offset)
            .unwrap_or(self.len())
    }
    fn nearest_boundary(&self, offset: usize) -> usize {
        let previous = self
            .boundaries
            .iter()
            .rev()
            .copied()
            .find(|boundary| *boundary <= offset)
            .unwrap_or(0);
        let next = self.next_boundary(previous);
        if offset - previous <= next.saturating_sub(offset) {
            previous
        } else {
            next
        }
    }
    fn previous_word_start(&self, offset: usize) -> usize {
        word_ranges(&self.text)
            .into_iter()
            .rev()
            .map(|range| range.start)
            .find(|start| *start < offset)
            .unwrap_or(0)
    }
    fn next_word_end(&self, offset: usize) -> usize {
        word_ranges(&self.text)
            .into_iter()
            .map(|range| range.end)
            .find(|end| *end > offset)
            .unwrap_or(self.len())
    }
    fn replace(&mut self, text: &str) {
        let range = self.selection();
        let start = self.byte(range.start);
        let end = self.byte(range.end);
        self.text.replace_range(start..end, text);
        self.boundaries = grapheme_boundaries(&self.text);
        // Inserted combining marks can merge with the preceding cluster; the end of
        // the inserted text is still a cluster boundary in the new text or snaps to it.
        let cursor = self.text[..start + text.len()].chars().count();
        self.cursor = self.nearest_boundary(cursor);
        self.anchor = self.cursor;
    }
    fn move_to(&mut self, cursor: usize, select: bool) {
        self.cursor = cursor.min(self.len());
        if !select {
            self.anchor = self.cursor;
        }
    }
    fn delete_to(&mut self, target: usize) {
        if self.selection().is_empty() {
            self.anchor = target;
        }
        self.replace("");
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
                    self.previous_boundary(self.cursor)
                };
                self.move_to(cursor, select);
            }
            TextEdit::Right { select } => {
                let cursor = if !select && !self.selection().is_empty() {
                    self.selection().end
                } else {
                    self.next_boundary(self.cursor)
                };
                self.move_to(cursor, select);
            }
            TextEdit::WordLeft { select } => {
                let cursor = self.previous_word_start(self.cursor);
                self.move_to(cursor, select);
            }
            TextEdit::WordRight { select } => {
                let cursor = self.next_word_end(self.cursor);
                self.move_to(cursor, select);
            }
            TextEdit::Home { select } => self.move_to(0, select),
            TextEdit::End { select } => self.move_to(self.len(), select),
            TextEdit::SelectAll => {
                self.anchor = 0;
                self.cursor = self.len();
            }
            TextEdit::Backspace => self.delete_to(self.previous_boundary(self.cursor)),
            TextEdit::Delete => self.delete_to(self.next_boundary(self.cursor)),
            TextEdit::DeleteWordBackward => self.delete_to(self.previous_word_start(self.cursor)),
            TextEdit::DeleteWordForward => self.delete_to(self.next_word_end(self.cursor)),
            TextEdit::DeleteToStart => self.delete_to(0),
            TextEdit::PlaceCursor { offset, select } => {
                let cursor = self.nearest_boundary(offset.min(self.len()));
                self.move_to(cursor, select);
            }
        }
        self.text != before
    }
}

/// Presentation-space editing ranges (scalar offsets into `presentation_text`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PresentationRanges {
    pub caret: usize,
    pub selection: std::ops::Range<usize>,
    pub preedit: Option<std::ops::Range<usize>>,
    pub preedit_selection: Option<std::ops::Range<usize>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(text: &str, edits: impl IntoIterator<Item = TextEdit>) -> TextEditor {
        let mut editor = TextEditor::new(text.into());
        for item in edits {
            editor.apply(item);
        }
        editor
    }

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
    fn extended_grapheme_clusters_are_never_split() {
        // Each case: text, expected cluster count. Left/Right/Backspace/Delete must
        // treat every cluster as one visible character.
        let cases = [
            ("한국어", 3),                                           // Hangul syllables
            ("\u{1112}\u{1161}\u{11AB}\u{1100}\u{1173}\u{11AF}", 2), // decomposed Hangul 한글
            ("e\u{301}a\u{308}", 2),                                 // combining accents é ä
            ("😀🎉", 2),                                             // emoji
            ("👍🏽👋🏿", 2),                                             // skin-tone modifiers
            ("👩‍👩‍👧‍👦🧑‍💻", 2),                                             // ZWJ sequences
            ("🇰🇷🇯🇵", 2),                                             // regional-indicator flags
            ("❤️☺️", 2),                                             // emoji variation selectors
            ("ab한😀\u{1112}\u{1161}e\u{301}", 6),                   // mixed ASCII/Korean/emoji
        ];
        for (text, clusters) in cases {
            assert_eq!(grapheme_boundaries(text).len() - 1, clusters, "{text:?}");
            let mut editor = TextEditor::new(text.into());
            let mut positions = vec![editor.cursor()];
            for _ in 0..clusters {
                editor.apply(TextEdit::Left { select: false });
                positions.push(editor.cursor());
            }
            assert_eq!(editor.cursor(), 0, "{text:?}");
            positions.reverse();
            assert_eq!(positions, grapheme_boundaries(text), "{text:?}");
            for _ in 0..clusters {
                editor.apply(TextEdit::Right { select: false });
            }
            assert_eq!(editor.cursor(), text.chars().count(), "{text:?}");

            // Backspace from the end removes exactly one cluster at a time.
            let mut remaining = text.to_owned();
            for step in 0..clusters {
                editor.apply(TextEdit::Backspace);
                let graphemes = remaining.graphemes(true).collect::<Vec<_>>();
                remaining = graphemes[..graphemes.len() - 1].concat();
                assert_eq!(editor.text(), remaining, "{text:?} step {step}");
            }
            // Forward delete from the start likewise.
            let mut editor = TextEditor::new(text.into());
            editor.apply(TextEdit::Home { select: false });
            editor.apply(TextEdit::Delete);
            assert_eq!(
                editor.text(),
                text.graphemes(true).skip(1).collect::<String>(),
                "{text:?}"
            );
        }
    }

    #[test]
    fn selection_replacement_across_non_ascii_content() {
        let mut editor = edit(
            "ab👩‍👩‍👧한\u{1112}\u{1161}z",
            [
                TextEdit::Home { select: false },
                TextEdit::Right { select: false },
                TextEdit::Right { select: true },
                TextEdit::Right { select: true },
                TextEdit::Right { select: true },
                TextEdit::Right { select: true },
            ],
        );
        assert_eq!(editor.selected_text(), "b👩‍👩‍👧한\u{1112}\u{1161}");
        editor.apply(TextEdit::Insert("🇰🇷".into()));
        assert_eq!(editor.text(), "a🇰🇷z");
        assert_eq!(editor.cursor(), 3);
        editor.apply(TextEdit::Left { select: true });
        assert_eq!(editor.selected_text(), "🇰🇷");
    }

    #[test]
    fn pointer_placement_snaps_inside_clusters_to_nearest_boundary() {
        // "e\u{301}" occupies scalars 0..2; "👍🏽" occupies 2..4.
        let mut editor = TextEditor::new("e\u{301}👍🏽x".into());
        editor.apply(TextEdit::PlaceCursor {
            offset: 1,
            select: false,
        });
        assert_eq!(editor.cursor(), 0);
        editor.apply(TextEdit::PlaceCursor {
            offset: 3,
            select: true,
        });
        assert!(editor.cursor() == 2 || editor.cursor() == 4);
        assert_eq!(editor.anchor(), 0);
        editor.apply(TextEdit::PlaceCursor {
            offset: 99,
            select: true,
        });
        assert_eq!(editor.selected_text(), "e\u{301}👍🏽x");
    }

    #[test]
    fn combining_mark_insertion_keeps_cursor_on_cluster_boundary() {
        let mut editor = TextEditor::new("ab".into());
        editor.apply(TextEdit::Left { select: false });
        editor.apply(TextEdit::Insert("\u{301}".into()));
        assert_eq!(editor.text(), "a\u{301}b");
        assert_eq!(editor.cursor(), 2);
        editor.apply(TextEdit::Backspace);
        assert_eq!(editor.text(), "b");
    }

    #[test]
    fn word_navigation_is_distinct_from_grapheme_navigation() {
        let mut editor = TextEditor::new("hello 세계 😀 wörld".into());
        editor.apply(TextEdit::WordLeft { select: false });
        assert_eq!(editor.cursor(), 11);
        editor.apply(TextEdit::WordLeft { select: false });
        assert_eq!(editor.cursor(), 6);
        editor.apply(TextEdit::WordRight { select: true });
        assert_eq!(editor.selected_text(), "세계");
        editor.apply(TextEdit::End { select: false });
        editor.apply(TextEdit::DeleteWordBackward);
        assert_eq!(editor.text(), "hello 세계 😀 ");
        editor.apply(TextEdit::DeleteToStart);
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
    fn presentation_ranges_follow_preedit_and_its_selection() {
        let mut editor = TextEditor::new("ab".into());
        editor.apply(TextEdit::Left { select: false });
        assert_eq!(editor.presentation_ranges().caret, 1);
        editor.apply(TextEdit::CompositionUpdate(Composition {
            text: "にほん".into(),
            selection: Some((0, 2)),
        }));
        let ranges = editor.presentation_ranges();
        assert_eq!(editor.presentation_text(), "aにほんb");
        assert_eq!(ranges.preedit, Some(1..4));
        assert_eq!(ranges.preedit_selection, Some(1..3));
        assert_eq!(ranges.caret, 3);
        assert_eq!(ranges.selection, 1..1);
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
