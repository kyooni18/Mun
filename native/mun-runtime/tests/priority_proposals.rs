//! Priority-based compression and ideal sizes in unbounded proposals.
use mun_runtime::{IntrinsicMeasurer, IntrinsicSize, Runtime};
use serde_json::json;
struct Measure;
impl IntrinsicMeasurer for Measure {
    fn measure_text(&self, _: &str) -> IntrinsicSize { IntrinsicSize::new(100.0, 20.0) }
    fn measure_text_for_width(&self, _: &str, width: Option<f32>) -> IntrinsicSize {
        IntrinsicSize::new(width.unwrap_or(100.0).min(100.0), 20.0)
    }
    fn measure_action(&self, _: &str) -> IntrinsicSize { IntrinsicSize::new(50.0, 30.0) }
    fn measure_panel(&self) -> IntrinsicSize { IntrinsicSize::new(50.0, 40.0) }
}
fn program(child: serde_json::Value) -> Runtime {
    Runtime::from_json(&json!({
        "version": 1, "sourceLanguage": "mun", "entry": "Test", "states": [],
        "root": { "kind": "window", "id": "window", "title": "Test", "child": child }
    }).to_string()).unwrap()
}
#[test]
fn higher_priority_children_resist_compression_first() {
    let text = |id: &str, priority: f32| json!({
        "kind": "text", "id": id,
        "value": { "kind": "literal", "value": id },
        "layout": { "layoutPriority": priority }
    });
    let runtime = program(json!({
        "kind": "row", "id": "row", "layout": { "width": { "kind": "literal", "value": 140 } },
        "children": [text("first", 1.0), text("second", 0.0)]
    }));
    let layout = runtime.build_frame_with_measurer(300.0, 200.0, &Measure).unwrap();
    let first = layout.accessibility.node("first").unwrap().bounds;
    let second = layout.accessibility.node("second").unwrap().bounds;
    assert!(first.width > second.width, "higher-priority Text should receive more width: first={first:?}, second={second:?}");
    assert!((first.width + second.width - 140.0).abs() < 0.01);
}

#[test]
fn ideal_width_is_used_for_scroll_axes_with_no_definite_proposal() {
    let runtime = program(json!({
        "kind": "scroll", "id": "scroller", "axis": "horizontal",
        "layout": { "width": { "kind": "literal", "value": 220 }, "height": { "kind": "literal", "value": 60 } },
        "children": [{
            "kind": "text", "id": "ideal", "layout": { "idealWidth": 160 },
            "value": { "kind": "literal", "value": "x" }
        }]
    }));
    let layout = runtime.build_frame_with_measurer(400.0, 200.0, &Measure).unwrap();
    let rect = layout.accessibility.node("ideal").unwrap().bounds;
    assert_eq!(rect.width, 160.0);
}
