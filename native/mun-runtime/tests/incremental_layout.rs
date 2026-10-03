#![recursion_limit = "512"]
//! The layout tree is retained across frames and hot updates. It must always
//! produce exactly the geometry a from-scratch layout produces, and an
//! unchanged frame must not invalidate anything.
use std::rc::Rc;

use mun_runtime::scene::Scene;
use mun_runtime::text_edit::TextEdit;
use mun_runtime::{InputEvent, IntrinsicMeasurer, IntrinsicSize, Runtime};
use serde_json::{Value, json};

/// Content-dependent metrics, so text edits change intrinsic sizes.
struct CharMeasurer;

impl IntrinsicMeasurer for CharMeasurer {
    fn measure_text(&self, text: &str) -> IntrinsicSize {
        IntrinsicSize::new(text.chars().count() as f32 * 11.0, 30.0)
    }

    fn measure_action(&self, label: &str) -> IntrinsicSize {
        IntrinsicSize::new(label.chars().count() as f32 * 9.0 + 34.0, 38.0)
    }

    fn measure_panel(&self) -> IntrinsicSize {
        IntrinsicSize::new(160.0, 96.0)
    }
}

fn runtime(header: &str) -> Runtime {
    let mut runtime = Runtime::from_json(&program(header)).unwrap();
    runtime.set_intrinsic_measurer(Rc::new(CharMeasurer));
    runtime
}

/// Order-independent rendering of everything a scene draws, with each
/// primitive's effective transform and clip.
fn describe(scene: &Scene) -> Vec<String> {
    let presented = |id: &str| {
        format!(
            "{:?} {:?}",
            scene.presentation.transform_for(id),
            scene.presentation.clip_for(id)
        )
    };
    let mut lines = Vec::new();
    lines.extend(
        scene
            .rects
            .iter()
            .map(|item| format!("{item:?} {}", presented(&item.id))),
    );
    lines.extend(
        scene
            .texts
            .iter()
            .map(|item| format!("{item:?} {}", presented(&item.id))),
    );
    lines.extend(scene.gradients.iter().map(|item| format!("{item:?}")));
    lines.extend(
        scene
            .actions
            .iter()
            .map(|item| format!("{item:?} {}", presented(&item.id))),
    );
    lines
}

const NOTE: &str = "@component/row/note";

fn item(path: &[&str]) -> Value {
    json!({"kind": "item", "forEach": "list", "path": path})
}

fn row_action(id: &str, operation: Value) -> Value {
    let mut action = json!({"kind": "collection", "state": "rows", "keyPath": ["id"]});
    action
        .as_object_mut()
        .unwrap()
        .extend(operation.as_object().unwrap().clone());
    json!({"kind": "action", "id": id, "label": id, "action": action})
}

fn program(header: &str) -> String {
    let collection = json!({
        "kind": "conditional",
        "condition": {"kind": "state", "state": "onlyPinned"},
        "then": {"kind": "filter", "collection": {"kind": "state", "state": "rows"}, "path": ["pinned"], "operator": "equal", "value": {"kind": "literal", "value": true}},
        "otherwise": {"kind": "state", "state": "rows"}
    });
    json!({
        "version": 1, "sourceLanguage": "mun", "entry": "Retained",
        "states": [
            {"name": "rows", "initial": [
                {"id": "a", "title": "Alpha", "pinned": true},
                {"id": "b", "title": "Beta", "pinned": false},
                {"id": "c", "title": "Gamma", "pinned": true}
            ]},
            {"name": "onlyPinned", "initial": false},
            {"name": "visible", "initial": true},
            {"name": "next", "initial": 10},
            {"name": NOTE, "initial": "", "scope": "list"}
        ],
        "root": {"kind": "window", "id": "window", "title": "Retained", "child": {
            "kind": "column", "id": "stack", "layout": {"maxWidth": "infinity", "maxHeight": "infinity", "spacing": 4}, "children": [
                {"kind": "text", "id": "header", "value": {"kind": "literal", "value": header}},
                {"kind": "scroll", "id": "scroll", "axis": "vertical", "layout": {"maxWidth": "infinity", "maxHeight": "infinity"}, "children": [
                    {"kind": "conditional", "id": "gate", "condition": {"kind": "state", "state": "visible"}, "then": [
                        {"kind": "forEach", "id": "list", "collection": collection, "keyPath": ["id"], "children": [
                            {"kind": "row", "id": "row", "layout": {"spacing": 6}, "children": [
                                {"kind": "text", "id": "title", "value": item(&["title"])},
                                {"kind": "spacer", "id": "gap"},
                                {"kind": "textField", "id": "note", "state": NOTE},
                                {"kind": "divider", "id": "rule"},
                                row_action("remove", json!({"operation": "remove", "key": item(&["id"])})),
                                row_action("up", json!({"operation": "move", "key": item(&["id"]), "offset": {"kind": "literal", "value": -1}})),
                                row_action("pin", json!({"operation": "update", "key": item(&["id"]), "path": ["pinned"], "value": {"kind": "not", "value": item(&["pinned"])}}))
                            ]}
                        ]}
                    ], "otherwise": [
                        {"kind": "panel", "id": "empty", "layout": {"maxWidth": 300, "minHeight": 20}}
                    ]}
                ]},
                {"kind": "action", "id": "append", "label": "Append", "action": {"kind": "sequence", "actions": [
                    {"kind": "collection", "state": "rows", "keyPath": ["id"], "operation": "append",
                     "value": {"kind": "record", "fields": {
                        "id": {"kind": "binary", "operator": "add", "left": {"kind": "literal", "value": "r"}, "right": {"kind": "stringify", "value": {"kind": "state", "state": "next"}}},
                        "title": {"kind": "literal", "value": "Appended with a longer title"},
                        "pinned": {"kind": "literal", "value": false}}}},
                    {"kind": "set-state", "state": "next", "value": {"kind": "binary", "operator": "add", "left": {"kind": "state", "state": "next"}, "right": {"kind": "literal", "value": 1}}}
                ]}},
                {"kind": "action", "id": "filter", "label": "Filter", "action": {"kind": "toggle-state", "state": "onlyPinned"}},
                {"kind": "action", "id": "hide", "label": "Hide", "action": {"kind": "toggle-state", "state": "visible"}}
            ]
        }}
    })
    .to_string()
}

fn keyed(key: &str, template: &str) -> String {
    format!("{template}[s:{key}]")
}

/// Retained layout of this frame equals a from-scratch layout of it.
fn assert_matches_fresh(runtime: &Runtime, width: f32, height: f32, step: &str) {
    let retained = runtime.build_frame(width, height).unwrap();
    runtime.discard_retained_layout();
    let fresh = runtime.build_frame(width, height).unwrap();
    let (retained_scene, fresh_scene) = (describe(&retained.scene), describe(&fresh.scene));
    assert_eq!(
        retained_scene.len(),
        fresh_scene.len(),
        "primitives after {step}"
    );
    for (retained, fresh) in retained_scene.iter().zip(&fresh_scene) {
        assert_eq!(retained, fresh, "scene after {step}");
    }
    assert_eq!(
        retained.accessibility, fresh.accessibility,
        "accessibility after {step}"
    );
}

#[test]
fn retained_layout_matches_fresh_layout_through_structural_changes() {
    let mut r = runtime("Header");
    let (w, h) = (420.0, 360.0);
    assert_matches_fresh(&r, w, h, "launch");

    type Step = (&'static str, Box<dyn Fn(&mut Runtime)>);
    let steps: Vec<Step> = vec![
        ("append", Box::new(|r| drop(r.activate_action("append")))),
        (
            "append again",
            Box::new(|r| drop(r.activate_action("append"))),
        ),
        (
            "move up",
            Box::new(|r| drop(r.activate_action(&keyed("c", "up")))),
        ),
        (
            "remove",
            Box::new(|r| drop(r.activate_action(&keyed("b", "remove")))),
        ),
        (
            "type",
            Box::new(|r| {
                assert!(r.focus_action(&keyed("a", "note")));
                r.handle_input(
                    InputEvent::TextEdit(TextEdit::Insert("a note that widens the field".into())),
                    420.0,
                    360.0,
                )
                .unwrap();
            }),
        ),
        ("filter", Box::new(|r| drop(r.activate_action("filter")))),
        ("unfilter", Box::new(|r| drop(r.activate_action("filter")))),
        ("hide", Box::new(|r| drop(r.activate_action("hide")))),
        ("show", Box::new(|r| drop(r.activate_action("hide")))),
        (
            "pin",
            Box::new(|r| drop(r.activate_action(&keyed("r10", "pin")))),
        ),
        (
            "hot update",
            Box::new(|r| {
                r.hot_update(&program("A different header"), &[]).unwrap();
            }),
        ),
    ];
    for (step, apply) in steps {
        r.build_frame(w, h).unwrap();
        apply(&mut r);
        assert_matches_fresh(&r, w, h, step);
    }
    // Window resizes reuse the tree too.
    for (width, height) in [(300.0, 200.0), (800.0, 640.0), (420.0, 360.0)] {
        r.build_frame(w, h).unwrap();
        assert_matches_fresh(&r, width, height, "resize");
    }
}

#[test]
fn unchanged_frames_and_hot_updates_invalidate_only_what_changed() {
    let mut r = runtime("Header");
    r.build_frame(420.0, 360.0).unwrap();
    let first = r.last_layout_sync();
    assert_eq!(
        first.created, first.live,
        "the first frame builds every node"
    );

    r.build_frame(420.0, 360.0).unwrap();
    let idle = r.last_layout_sync();
    assert_eq!(idle.live, first.live);
    assert_eq!(idle.invalidated(), 0, "an unchanged frame touches nothing");

    // A compatible hot update that changes one Text keeps every node and
    // remeasures exactly that Text.
    r.hot_update(&program("A different header"), &[]).unwrap();
    r.build_frame(420.0, 360.0).unwrap();
    let update = r.last_layout_sync();
    assert_eq!(update.created + update.removed, 0, "{update:?}");
    assert_eq!(update.remeasured, 1, "{update:?}");
    assert!(update.invalidated() <= 2, "{update:?}");

    // Appending a row creates only that row's nodes.
    r.activate_action("append");
    r.build_frame(420.0, 360.0).unwrap();
    let append = r.last_layout_sync();
    assert_eq!(append.removed, 0, "{append:?}");
    assert_eq!(
        append.created, 8,
        "one row and its seven children: {append:?}"
    );
}
