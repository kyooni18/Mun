//! A Text leaf answers a bounded width proposal with its wrapped height.
use mun_runtime::{IntrinsicMeasurer, IntrinsicSize, Runtime};
use serde_json::json;

struct WrappingMeasurer;
impl IntrinsicMeasurer for WrappingMeasurer {
    fn measure_text(&self, text: &str) -> IntrinsicSize {
        IntrinsicSize::new(text.len() as f32 * 10.0, 20.0)
    }

    fn measure_text_for_width(&self, text: &str, width: Option<f32>) -> IntrinsicSize {
        let natural = self.measure_text(text);
        let proposed = width.unwrap_or(natural.width).max(1.0);
        let lines = (natural.width / proposed).ceil().max(1.0);
        IntrinsicSize::new(natural.width.min(proposed), lines * natural.height)
    }

    fn measure_action(&self, _: &str) -> IntrinsicSize {
        IntrinsicSize::new(50.0, 30.0)
    }
    fn measure_panel(&self) -> IntrinsicSize {
        IntrinsicSize::new(50.0, 40.0)
    }
}

#[test]
fn text_height_tracks_the_width_proposed_by_a_stack() {
    let value = json!({
        "version": 1, "sourceLanguage": "mun", "entry": "Wrap", "states": [],
        "root": { "kind": "window", "id": "window", "title": "Wrap",
          "child": { "kind": "column", "id": "stack", "layout": { "width": { "kind": "literal", "value": 100 } },
            "children": [{ "kind": "text", "id": "text", "value": { "kind": "literal", "value": "abcdefghijabcdefghij" } }] }
        }
    });
    let runtime = Runtime::from_json(&value.to_string()).unwrap();
    let frame = runtime
        .build_frame_with_measurer(300.0, 220.0, &WrappingMeasurer)
        .unwrap();
    let rect = frame.accessibility.node("text").unwrap().bounds;
    assert_eq!(rect.width, 100.0);
    assert_eq!(rect.height, 40.0);
}
