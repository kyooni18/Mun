#![recursion_limit = "512"]
//! Keyed dynamic collections: runtime-owned per-key state scopes.
use mun_runtime::text_edit::TextEdit;
use mun_runtime::{InputEvent, Runtime, RuntimeDiagnostic, RuntimeLoadError};
use serde_json::{Value, json};

const NOTE: &str = "@component/row/note";

fn item(path: &[&str]) -> Value {
    json!({"kind": "item", "forEach": "list", "path": path})
}

fn collection_action(id: &str, operation: Value) -> Value {
    let mut action = json!({"kind": "collection", "state": "rows", "keyPath": ["id"]});
    action
        .as_object_mut()
        .unwrap()
        .extend(operation.as_object().unwrap().clone());
    json!({"kind": "action", "id": id, "label": id, "action": action})
}

fn program(rows: Value) -> String {
    let collection = json!({
        "kind": "conditional",
        "condition": {"kind": "state", "state": "onlyPinned"},
        "then": {"kind": "filter", "collection": {"kind": "state", "state": "rows"}, "path": ["pinned"], "operator": "equal", "value": {"kind": "literal", "value": true}},
        "otherwise": {"kind": "state", "state": "rows"}
    });
    json!({
        "version": 1, "sourceLanguage": "mun", "entry": "Keyed",
        "states": [
            {"name": "rows", "initial": rows},
            {"name": "onlyPinned", "initial": false},
            {"name": "visible", "initial": true},
            {"name": "next", "initial": 10},
            {"name": NOTE, "initial": "", "scope": "list"}
        ],
        "root": {"kind": "window", "id": "window", "title": "Keyed", "child": {
            "kind": "column", "id": "stack", "children": [
                {"kind": "conditional", "id": "gate", "condition": {"kind": "state", "state": "visible"}, "then": [
                    {"kind": "forEach", "id": "list", "collection": collection, "keyPath": ["id"], "children": [
                        {"kind": "row", "id": "row", "children": [
                            {"kind": "text", "id": "title", "value": item(&["title"])},
                            {"kind": "textField", "id": "note", "state": NOTE},
                            collection_action("remove", json!({"operation": "remove", "key": item(&["id"])})),
                            collection_action("up", json!({"operation": "move", "key": item(&["id"]), "offset": {"kind": "literal", "value": -1}})),
                            collection_action("pin", json!({"operation": "update", "key": item(&["id"]), "path": ["pinned"], "value": {"kind": "not", "value": item(&["pinned"])}}))
                        ]}
                    ]}
                ], "otherwise": []},
                {"kind": "action", "id": "prepend", "label": "Prepend", "action": {"kind": "sequence", "actions": [
                    {"kind": "collection", "state": "rows", "keyPath": ["id"], "operation": "insert",
                     "index": {"kind": "literal", "value": 0},
                     "value": {"kind": "record", "fields": {
                        "id": {"kind": "binary", "operator": "add", "left": {"kind": "literal", "value": "r"}, "right": {"kind": "stringify", "value": {"kind": "state", "state": "next"}}},
                        "title": {"kind": "literal", "value": "New"},
                        "pinned": {"kind": "literal", "value": false}}}},
                    {"kind": "set-state", "state": "next", "value": {"kind": "binary", "operator": "add", "left": {"kind": "state", "state": "next"}, "right": {"kind": "literal", "value": 1}}}
                ]}},
                {"kind": "action", "id": "append", "label": "Append", "action": {"kind": "sequence", "actions": [
                    {"kind": "collection", "state": "rows", "keyPath": ["id"], "operation": "append",
                     "value": {"kind": "record", "fields": {
                        "id": {"kind": "binary", "operator": "add", "left": {"kind": "literal", "value": "r"}, "right": {"kind": "stringify", "value": {"kind": "state", "state": "next"}}},
                        "title": {"kind": "literal", "value": "Appended"},
                        "pinned": {"kind": "literal", "value": false}}}},
                    {"kind": "set-state", "state": "next", "value": {"kind": "binary", "operator": "add", "left": {"kind": "state", "state": "next"}, "right": {"kind": "literal", "value": 1}}}
                ]}},
                {"kind": "action", "id": "append-dup", "label": "Dup", "action": {"kind": "collection", "state": "rows", "keyPath": ["id"], "operation": "append",
                    "value": {"kind": "literal", "value": {"id": "a", "title": "Again", "pinned": false}}}},
                {"kind": "action", "id": "filter", "label": "Filter", "action": {"kind": "toggle-state", "state": "onlyPinned"}},
                {"kind": "action", "id": "hide", "label": "Hide", "action": {"kind": "toggle-state", "state": "visible"}}
            ]
        }}
    })
    .to_string()
}

fn abc() -> Runtime {
    Runtime::from_json(&program(json!([
        {"id": "a", "title": "Alpha", "pinned": true},
        {"id": "b", "title": "Beta", "pinned": false},
        {"id": "c", "title": "Gamma", "pinned": true}
    ])))
    .unwrap()
}

fn node(key: &str, template: &str) -> String {
    format!("{template}[s:{key}]")
}

fn note(r: &Runtime, key: &str) -> Option<String> {
    r.state_value(&node(key, NOTE))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn type_note(r: &mut Runtime, key: &str, text: &str) {
    assert!(r.focus_action(&node(key, "note")));
    r.handle_input(
        InputEvent::TextEdit(TextEdit::Insert(text.into())),
        400.0,
        600.0,
    )
    .unwrap();
}

fn order(r: &Runtime) -> Vec<String> {
    let tree = r.build_accessibility_tree(400.0, 600.0).unwrap();
    tree.nodes
        .iter()
        .filter(|node| node.id.starts_with("title["))
        .map(|node| {
            node.id
                .trim_start_matches("title[s:")
                .trim_end_matches(']')
                .to_owned()
        })
        .collect()
}

#[test]
fn per_key_state_survives_insertion_before_and_after_and_neighbor_deletion() {
    let mut r = abc();
    type_note(&mut r, "a", "first");
    type_note(&mut r, "b", "second");
    type_note(&mut r, "c", "third");
    assert_eq!(r.scoped_state_count(), 3);

    r.activate_action("prepend");
    assert_eq!(order(&r), ["r10", "a", "b", "c"]);
    assert_eq!(note(&r, "a").as_deref(), Some("first"));
    assert_eq!(
        note(&r, "r10").as_deref(),
        Some(""),
        "new item starts fresh"
    );

    // Insertion after existing items.
    r.activate_action("append");
    assert_eq!(order(&r), ["r10", "a", "b", "c", "r11"]);
    assert_eq!(note(&r, "c").as_deref(), Some("third"));
    r.activate_action(&node("c", "up"));
    r.activate_action(&node("c", "up"));
    assert_eq!(order(&r), ["r10", "c", "a", "b", "r11"]);

    r.activate_action(&node("a", "remove"));
    assert_eq!(order(&r), ["r10", "c", "b", "r11"]);
    assert_eq!(note(&r, "b").as_deref(), Some("second"));
    assert_eq!(note(&r, "c").as_deref(), Some("third"));
    assert_eq!(note(&r, "a"), None, "removed key released its state");
    assert_eq!(r.scoped_state_count(), 4);
}

#[test]
fn a_new_item_never_inherits_state_from_a_removed_item_at_the_same_index() {
    let mut r = abc();
    type_note(&mut r, "a", "owned by a");
    r.activate_action(&node("a", "remove"));
    r.activate_action("prepend");
    assert_eq!(order(&r)[0], "r10");
    assert_eq!(note(&r, "r10").as_deref(), Some(""));
    assert_eq!(note(&r, "a"), None);
}

#[test]
fn reordering_preserves_state_and_focus_by_key() {
    let mut r = abc();
    type_note(&mut r, "b", "beta note");
    let focused = node("b", "note");
    assert_eq!(r.focused_action(), Some(focused.as_str()));
    r.activate_action(&node("c", "up"));
    r.activate_action(&node("c", "up"));
    assert_eq!(order(&r), ["c", "a", "b"]);
    // Activation focuses the activated action; refocus the field and check the
    // editor continues with the same key-scoped binding.
    type_note(&mut r, "b", "!");
    assert_eq!(note(&r, "b").as_deref(), Some("beta note!"));
}

#[test]
fn filtering_keeps_visible_rows_state_and_releases_filtered_keys() {
    let mut r = abc();
    type_note(&mut r, "a", "pinned a");
    type_note(&mut r, "b", "unpinned b");
    r.activate_action("filter");
    assert_eq!(order(&r), ["a", "c"]);
    assert_eq!(note(&r, "a").as_deref(), Some("pinned a"));
    assert_eq!(note(&r, "b"), None, "filtered-out view scope is released");
    r.activate_action("filter");
    assert_eq!(order(&r), ["a", "b", "c"]);
    assert_eq!(
        note(&r, "b").as_deref(),
        Some(""),
        "returns as a new view instance"
    );

    // Updating an item field through its key participates in filtering.
    r.activate_action(&node("b", "pin"));
    r.activate_action("filter");
    assert_eq!(order(&r), ["a", "b", "c"]);
}

#[test]
fn hiding_the_conditional_parent_preserves_logical_item_scopes() {
    let mut r = abc();
    type_note(&mut r, "c", "kept");
    r.activate_action("hide");
    assert!(order(&r).is_empty());
    assert_eq!(note(&r, "c").as_deref(), Some("kept"));
    r.activate_action("hide");
    assert_eq!(note(&r, "c").as_deref(), Some("kept"));
    assert_eq!(order(&r), ["a", "b", "c"]);
}

#[test]
fn duplicate_keys_fail_explicitly_and_never_alias() {
    let error = Runtime::from_json(&program(json!([
        {"id": "a", "title": "One", "pinned": false},
        {"id": "a", "title": "Two", "pinned": false}
    ])))
    .err()
    .expect("duplicate initial keys are a load error");
    assert!(matches!(error, RuntimeLoadError::Collection(_)), "{error}");

    let mut r = abc();
    type_note(&mut r, "a", "safe");
    assert!(r.activate_action("append-dup").is_none());
    assert_eq!(order(&r), ["a", "b", "c"]);
    assert_eq!(note(&r, "a").as_deref(), Some("safe"));
    assert!(matches!(
        r.take_diagnostics().as_slice(),
        [RuntimeDiagnostic::RejectedTransaction { .. }]
    ));
    // A rejected sequence leaves earlier mutations unapplied as well.
    let next = r.state_value("next").cloned();
    assert_eq!(next, Some(json!(10)));
}

#[test]
fn removing_the_focused_row_moves_focus_deterministically_and_drops_its_editor() {
    let mut r = abc();
    type_note(&mut r, "b", "draft");
    assert!(r.focus_action(&node("b", "remove")));
    r.activate_action(&node("b", "remove"));
    assert_ne!(r.focused_action(), Some(node("b", "remove").as_str()));
    assert!(
        r.focused_action().is_some(),
        "focus falls back to a live control"
    );
    assert_eq!(note(&r, "b"), None);
}
