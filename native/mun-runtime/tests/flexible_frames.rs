//! `.frame(minWidth:maxWidth:minHeight:maxHeight:)`: flexible views take what
//! their parent offers (grow on its main axis, stretch across it), clamped to
//! their bounds; containers holding a flexible child become flexible.
use mun_runtime::Runtime;
use serde_json::json;

fn rect(r: &Runtime, id: &str, w: f32, h: f32) -> mun_runtime::AccessibilityBounds {
    r.build_accessibility_tree(w, h)
        .unwrap()
        .node(id)
        .unwrap()
        .bounds
}

#[test]
fn flexible_frames_follow_the_window_within_their_bounds() {
    let lit = |v: f32| json!({"kind": "literal", "value": v});
    let program = json!({
        "version": 1, "sourceLanguage": "mun", "entry": "Flex", "states": [{"name": "s", "initial": ""}],
        "root": {"kind": "window", "id": "w", "title": "Flex", "child": {
            "kind": "column", "id": "col", "layout": {"alignment": "leading"}, "children": [
                {"kind": "row", "id": "row", "children": [
                    {"kind": "textField", "id": "field", "state": "s",
                     "layout": {"height": lit(30.0), "minWidth": 100, "maxWidth": "infinity"}},
                    {"kind": "action", "id": "fixed", "label": "Go", "action": {"kind": "toggle-state", "state": "s"},
                     "layout": {"width": lit(50.0), "height": lit(30.0)}}
                ]},
                {"kind": "panel", "id": "capped", "layout": {"maxWidth": 300, "maxHeight": "infinity", "minHeight": 20}},
                {"kind": "text", "id": "label", "value": {"kind": "literal", "value": "hug"}}
            ]
        }}
    });
    let r = Runtime::from_json(&program.to_string()).unwrap();
    for (w, h) in [(400.0, 300.0), (800.0, 600.0)] {
        // The row became flexible through its field: it spans the window and the
        // field takes everything the fixed button leaves.
        assert_eq!(rect(&r, "row", w, h).width, w);
        assert_eq!(rect(&r, "field", w, h).width, w - 50.0);
        // Stretches across the column up to its max; grows down the column.
        assert_eq!(rect(&r, "capped", w, h).width, 300.0_f32.min(w));
        assert!(rect(&r, "capped", w, h).height > h * 0.5);
        // Non-flexible content keeps its intrinsic size.
        assert_eq!(rect(&r, "label", w, h).width, 240.0);
    }
    // Below minWidth the field keeps its minimum.
    assert_eq!(rect(&r, "field", 120.0, 300.0).width, 100.0);
}
