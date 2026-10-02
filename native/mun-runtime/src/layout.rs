//! Renderer-neutral intrinsic measurement boundary for native layout.
//!
//! Taffy remains an adapter below Mün semantics. Exact glyph/control metrics may
//! come from a native backend, but those backends expose only semantic intrinsic
//! sizes here rather than leaking shaping or renderer objects into the runtime.

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct IntrinsicSize {
    pub width: f32,
    pub height: f32,
}

impl IntrinsicSize {
    pub const fn new(width: f32, height: f32) -> Self {
        Self { width, height }
    }
}

/// Shaped geometry of one single-line text run, exposed by a text backend.
///
/// `carets` holds one `(scalar offset, x)` stop for every extended grapheme
/// boundary of the shaped text, sorted by offset, with `x` in unscaled logical
/// points from the run's origin. The runtime derives caret, selection, preedit
/// and pointer-to-offset mapping from these stops; backends never own editing state.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextLineLayout {
    pub carets: Vec<(usize, f32)>,
    pub width: f32,
    pub line_height: f32,
}

impl TextLineLayout {
    /// Caret x for a scalar offset, using the nearest stop at or before it.
    pub fn x_for_offset(&self, offset: usize) -> f32 {
        self.carets
            .iter()
            .rev()
            .find(|(stop, _)| *stop <= offset)
            .or(self.carets.first())
            .map_or(0.0, |(_, x)| *x)
    }

    /// The grapheme boundary whose caret position is visually nearest to `x`.
    pub fn offset_for_x(&self, x: f32) -> usize {
        self.carets
            .iter()
            .min_by(|(_, a), (_, b)| (a - x).abs().total_cmp(&(b - x).abs()))
            .map_or(0, |(offset, _)| *offset)
    }

    /// Visual horizontal extent covering every boundary inside `range`.
    pub fn span(&self, range: std::ops::Range<usize>) -> Option<(f32, f32)> {
        if range.is_empty() {
            return None;
        }
        let xs = self
            .carets
            .iter()
            .filter(|(offset, _)| range.contains(offset) || *offset == range.end)
            .map(|(_, x)| *x);
        let (min, max) = xs.fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), x| {
            (lo.min(x), hi.max(x))
        });
        (min.is_finite() && max > min).then_some((min, max))
    }
}

/// Supplies backend-derived intrinsic sizes for semantic leaf content.
///
/// Measurements are intentionally unconstrained content sizes. Explicit Mün
/// width/height constraints and container alignment remain authoritative in
/// the Taffy adapter.
pub trait IntrinsicMeasurer {
    fn measure_text(&self, text: &str) -> IntrinsicSize;
    fn measure_action(&self, label: &str) -> IntrinsicSize;
    fn measure_panel(&self) -> IntrinsicSize;

    fn measure_text_field(&self, value: &str, placeholder: Option<&str>) -> IntrinsicSize {
        let text = if value.is_empty() {
            placeholder.unwrap_or("")
        } else {
            value
        };
        let measured = self.measure_action(text);
        IntrinsicSize::new(measured.width.max(180.0), measured.height)
    }

    /// Single-line shaped geometry for editing presentation and pointer mapping.
    ///
    /// The default is a deterministic headless model (uniform advance per
    /// grapheme cluster) for tests and IR tooling without a font backend. Native
    /// renderers must override it with real shaping data.
    fn text_line(&self, text: &str, font_size: f32) -> TextLineLayout {
        let advance = font_size * 0.6;
        let carets = crate::text_edit::grapheme_boundaries(text)
            .into_iter()
            .enumerate()
            .map(|(index, offset)| (offset, index as f32 * advance))
            .collect::<Vec<_>>();
        TextLineLayout {
            width: carets.last().map_or(0.0, |(_, x)| *x),
            carets,
            line_height: font_size * 1.25,
        }
    }

    /// Checkbox-style toggle: a 14pt box, a 6pt gap and the label line.
    fn measure_toggle(&self, label: &str) -> IntrinsicSize {
        let line = self.text_line(label, 16.0);
        IntrinsicSize::new(
            (line.width + 20.0).ceil(),
            line.line_height.max(22.0).ceil(),
        )
    }

    /// Linear progress: an optional label line above a 6pt track.
    fn measure_progress(&self, label: Option<&str>) -> IntrinsicSize {
        let label = label.map_or(0.0, |label| self.text_line(label, 16.0).line_height + 4.0);
        IntrinsicSize::new(160.0, (label + 6.0).ceil())
    }

    fn measure_radio_group(&self, labels: &[String]) -> IntrinsicSize {
        let width = labels
            .iter()
            .map(|label| self.measure_action(label).width)
            .fold(120.0, f32::max);
        IntrinsicSize::new(width, (labels.len().max(1) as f32) * 30.0)
    }
}

/// Compatibility fallback used when no native backend measurer is supplied.
///
/// These preserve the pre-boundary runtime metrics exactly. Native backends may
/// replace them with glyph/control measurements through the runtime measurement API.
#[derive(Clone, Copy, Debug, Default)]
pub struct FallbackIntrinsicMeasurer;

impl IntrinsicMeasurer for FallbackIntrinsicMeasurer {
    fn measure_text(&self, _text: &str) -> IntrinsicSize {
        IntrinsicSize::new(240.0, 32.0)
    }

    fn measure_action(&self, label: &str) -> IntrinsicSize {
        IntrinsicSize::new((label.chars().count() as f32 * 9.0 + 34.0).max(92.0), 38.0)
    }

    fn measure_panel(&self) -> IntrinsicSize {
        IntrinsicSize::new(160.0, 96.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_metrics_preserve_existing_runtime_baselines() {
        let measurer = FallbackIntrinsicMeasurer;
        assert_eq!(
            measurer.measure_text("arbitrary"),
            IntrinsicSize::new(240.0, 32.0)
        );
        assert_eq!(
            measurer.measure_action("Go"),
            IntrinsicSize::new(92.0, 38.0)
        );
        assert_eq!(
            measurer.measure_action("Long action label"),
            IntrinsicSize::new(187.0, 38.0)
        );
        assert_eq!(measurer.measure_panel(), IntrinsicSize::new(160.0, 96.0));
    }
}
