//! Shaped text metrics shared by layout, editing geometry and rendering.
//!
//! One cosmic-text `FontSystem` serves both the runtime's measurement boundary
//! and glyphon realization, so caret stops, pointer mapping and drawn glyphs come
//! from the same shaping. This module exposes geometry only; editing state stays
//! in `mun-runtime`.
use std::{
    cell::{Cell, RefCell, RefMut},
    collections::HashMap,
};

use glyphon::{Attrs, Buffer, Family, FontSystem, Metrics, Shaping, Wrap};
use mun_runtime::{IntrinsicMeasurer, IntrinsicSize, TextLineLayout};
use unicode_segmentation::UnicodeSegmentation;

/// Line height factor shared with the renderer's glyphon buffers.
pub const LINE_HEIGHT_FACTOR: f32 = 1.25;
const TEXT_FONT_SIZE: f32 = 24.0;
const CONTROL_FONT_SIZE: f32 = 16.0;
/// Bounded memo of shaped lines; cleared wholesale when full to cap memory.
const LINE_CACHE_LIMIT: usize = 1024;

pub fn text_attrs() -> Attrs<'static> {
    Attrs::new().family(Family::SansSerif)
}

pub struct TextShaping {
    font_system: RefCell<FontSystem>,
    lines: RefCell<HashMap<(String, u32), TextLineLayout>>,
    shaped_lines: Cell<u64>,
}

impl TextShaping {
    pub fn new(font_system: FontSystem) -> Self {
        Self {
            font_system: RefCell::new(font_system),
            lines: RefCell::new(HashMap::new()),
            shaped_lines: Cell::new(0),
        }
    }

    pub fn font_system(&self) -> RefMut<'_, FontSystem> {
        self.font_system.borrow_mut()
    }

    /// Number of line shapings performed for measurement (cache misses).
    pub fn shaped_line_count(&self) -> u64 {
        self.shaped_lines.get()
    }

    pub fn cached_line_count(&self) -> usize {
        self.lines.borrow().len()
    }

    fn shape_line(&self, text: &str, font_size: f32) -> TextLineLayout {
        let key = (text.to_owned(), font_size.to_bits());
        if let Some(line) = self.lines.borrow().get(&key) {
            return line.clone();
        }
        let line = shape_line(&mut self.font_system.borrow_mut(), text, font_size);
        self.shaped_lines.set(self.shaped_lines.get() + 1);
        let mut lines = self.lines.borrow_mut();
        if lines.len() >= LINE_CACHE_LIMIT {
            lines.clear();
        }
        lines.insert(key, line.clone());
        line
    }
}

/// Shape one unwrapped line and derive a caret stop for every grapheme boundary.
///
/// Glyph clusters come from cosmic-text (`start..end` UTF-8 ranges in logical
/// order, `x/w` in visual space, bidi level per glyph). A boundary at a cluster
/// start maps to the cluster's leading edge (left for LTR, right for RTL);
/// boundaries inside a multi-grapheme cluster (ligatures) are interpolated across
/// the cluster's graphemes; the end of text maps to the last cluster's trailing edge.
pub fn shape_line(font_system: &mut FontSystem, text: &str, font_size: f32) -> TextLineLayout {
    let line_height = font_size * LINE_HEIGHT_FACTOR;
    let mut buffer = Buffer::new(font_system, Metrics::new(font_size, line_height));
    buffer.set_wrap(Wrap::None);
    buffer.set_size(None, None);
    buffer.set_text(text, &text_attrs(), Shaping::Advanced, None);
    buffer.shape_until_scroll(font_system, false);

    // Merge glyphs that share a cluster range (e.g. base + combining mark glyphs).
    let mut clusters: Vec<(usize, usize, f32, f32, bool)> = Vec::new();
    let mut width = 0.0_f32;
    for run in buffer.layout_runs() {
        width = width.max(run.line_w);
        for glyph in run.glyphs {
            let (left, right) = (glyph.x, glyph.x + glyph.w);
            if let Some(cluster) = clusters
                .iter_mut()
                .find(|cluster| cluster.0 == glyph.start && cluster.1 == glyph.end)
            {
                cluster.2 = cluster.2.min(left);
                cluster.3 = cluster.3.max(right);
            } else {
                clusters.push((glyph.start, glyph.end, left, right, glyph.level.is_rtl()));
            }
        }
    }
    clusters.sort_by_key(|cluster| cluster.0);

    let mut carets = Vec::new();
    let mut scalar = 0;
    let mut byte = 0;
    let mut previous_x = 0.0;
    let mut boundaries = text
        .grapheme_indices(true)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    boundaries.push(text.len());
    for boundary in boundaries {
        scalar += text[byte..boundary].chars().count();
        byte = boundary;
        let x = if boundary == text.len() {
            clusters
                .last()
                .map(|cluster| if cluster.4 { cluster.2 } else { cluster.3 })
        } else {
            clusters
                .iter()
                .find(|cluster| cluster.0 <= boundary && boundary < cluster.1)
                .map(|cluster| {
                    let cluster_text = &text[cluster.0..cluster.1];
                    let total = cluster_text.graphemes(true).count().max(1) as f32;
                    let before = text[cluster.0..boundary].graphemes(true).count() as f32;
                    let fraction = before / total;
                    if cluster.4 {
                        cluster.3 - fraction * (cluster.3 - cluster.2)
                    } else {
                        cluster.2 + fraction * (cluster.3 - cluster.2)
                    }
                })
        }
        .unwrap_or(previous_x);
        previous_x = x;
        carets.push((scalar, x));
    }
    TextLineLayout {
        carets,
        width,
        line_height,
    }
}

impl IntrinsicMeasurer for TextShaping {
    fn measure_text(&self, text: &str) -> IntrinsicSize {
        let line = self.shape_line(text, TEXT_FONT_SIZE);
        // 3pt top inset used by the retained scene plus the shaped line box.
        IntrinsicSize::new(line.width.ceil(), (line.line_height + 2.0).ceil())
    }

    fn measure_action(&self, label: &str) -> IntrinsicSize {
        let line = self.shape_line(label, CONTROL_FONT_SIZE);
        IntrinsicSize::new((line.width + 34.0).ceil().max(92.0), 38.0)
    }

    fn measure_panel(&self) -> IntrinsicSize {
        IntrinsicSize::new(160.0, 96.0)
    }

    fn text_line(&self, text: &str, font_size: f32) -> TextLineLayout {
        self.shape_line(text, font_size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn font_system() -> std::sync::MutexGuard<'static, FontSystem> {
        static FONTS: OnceLock<Mutex<FontSystem>> = OnceLock::new();
        FONTS
            .get_or_init(|| Mutex::new(FontSystem::new()))
            .lock()
            .expect("font system")
    }

    fn assert_monotonic(line: &TextLineLayout, text: &str) {
        let boundaries = mun_runtime::text_edit::grapheme_boundaries(text);
        assert_eq!(
            line.carets
                .iter()
                .map(|(offset, _)| *offset)
                .collect::<Vec<_>>(),
            boundaries,
            "one caret stop per grapheme boundary for {text:?}"
        );
        for pair in line.carets.windows(2) {
            assert!(
                pair[1].1 >= pair[0].1,
                "LTR stops advance for {text:?}: {line:?}"
            );
        }
        assert!(
            (line.carets.last().unwrap().1 - line.width).abs() < 0.5,
            "{text:?}"
        );
    }

    #[test]
    fn shaped_caret_stops_follow_real_glyph_advances() {
        let mut fonts = font_system();
        // Proportional shaping: "i" is narrower than "W" in any sans-serif face,
        // so a uniform per-character estimate cannot satisfy this.
        let line = shape_line(&mut fonts, "iW", 16.0);
        assert_monotonic(&line, "iW");
        let narrow = line.carets[1].1 - line.carets[0].1;
        let wide = line.carets[2].1 - line.carets[1].1;
        assert!(narrow < wide, "{line:?}");

        for text in [
            "한국어 Mixed 😀",
            "e\u{301}a\u{308}",
            "\u{1112}\u{1161}\u{11AB}\u{1100}\u{1173}\u{11AF}",
            "👩‍👩‍👧‍👦👍🏽🇰🇷",
        ] {
            let line = shape_line(&mut fonts, text, 16.0);
            assert_monotonic(&line, text);
        }
        let empty = shape_line(&mut fonts, "", 16.0);
        assert_eq!(empty.carets, vec![(0, 0.0)]);
    }

    #[test]
    fn measurement_cache_avoids_reshaping_identical_lines() {
        let shaping = TextShaping::new(FontSystem::new());
        let first = shaping.text_line("반복 shaping", 16.0);
        let second = shaping.text_line("반복 shaping", 16.0);
        assert_eq!(first, second);
        assert_eq!(shaping.shaped_line_count(), 1);
        shaping.text_line("반복 shaping", 18.0);
        assert_eq!(shaping.shaped_line_count(), 2);
    }
}
