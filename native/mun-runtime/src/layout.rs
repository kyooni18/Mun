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

/// Supplies backend-derived intrinsic sizes for semantic leaf content.
///
/// Measurements are intentionally unconstrained content sizes. Explicit Mün
/// width/height constraints and container alignment remain authoritative in
/// the Taffy adapter.
pub trait IntrinsicMeasurer {
    fn measure_text(&self, text: &str) -> IntrinsicSize;
    fn measure_action(&self, label: &str) -> IntrinsicSize;
    fn measure_panel(&self) -> IntrinsicSize;
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
