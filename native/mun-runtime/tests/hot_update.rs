#![recursion_limit = "512"]
//! Development hot update: atomic program replacement that carries runtime
//! state by semantic identity, replaces actions and keeps lifecycle honest.
use mun_runtime::text_edit::{Composition, TextEdit};
use mun_runtime::{InputEvent, Runtime};
use serde_json::{Value, json};

const COUNT: &str = "@component/entry/App/count";
const NAME: &str = "@component/entry/App/name";
const APPEARS: &str = "@component/entry/App/appears";
const NOTE: &str = "@component/row/note";

struct Edit {
    count_initial: Value,
    label: &'static str,
    step: i64,
    detail_branch: bool,
    padding: f64,
    extra_state: bool,
}

impl Default for Edit {
    fn default() -> Self {
        Self {
            count_initial: json!(0),
            label: "Count: ",
            step: 1,
            detail_branch: false,
            padding: 8.0,
            extra_state: false,
        }
    }
}

fn program(edit: &Edit) -> String {
    let mut states = vec![
        json!({"name": COUNT, "initial": edit.count_initial}),
        json!({"name": NAME, "initial": ""}),
        json!({"name": "@component/entry/App/secret", "initial": "hunter2"}),
        json!({"name": APPEARS, "initial": 0}),
        json!({"name": "@component/entry/App/rows", "initial": [{"id": "a"}, {"id": "b"}, {"id": "c"}]}),
        json!({"name": NOTE, "initial": "", "scope": "list"}),
    ];
    if edit.extra_state {
        states.push(json!({"name": "@component/entry/App/extra", "initial": true}));
    }
    let appear = json!({"appear": {"kind": "set-state", "state": APPEARS, "value": {"kind": "binary", "operator": "add",
        "left": {"kind": "state", "state": APPEARS}, "right": {"kind": "literal", "value": 1}}}});
    let detail = if edit.detail_branch {
        json!({"kind": "text", "id": "detail-b", "value": {"kind": "literal", "value": "B"}, "lifecycle": appear})
    } else {
        json!({"kind": "text", "id": "detail-a", "value": {"kind": "literal", "value": "A"}, "lifecycle": appear})
    };
    json!({
        "version": 1, "sourceLanguage": "mun", "entry": "App", "states": states,
        "root": {"kind": "window", "id": "window-root", "title": "Hot", "child": {
            "kind": "column", "id": "stack", "layout": {"padding": edit.padding}, "children": [
                {"kind": "text", "id": "label", "value": {"kind": "binary", "operator": "add",
                    "left": {"kind": "literal", "value": edit.label},
                    "right": {"kind": "stringify", "value": {"kind": "state", "state": COUNT}}}},
                {"kind": "action", "id": "add", "label": "Add", "action": {"kind": "set-state", "state": COUNT,
                    "value": {"kind": "binary", "operator": "add", "left": {"kind": "state", "state": COUNT},
                    "right": {"kind": "literal", "value": edit.step}}}},
                {"kind": "textField", "id": "name", "state": NAME},
                {"kind": "textField", "id": "secret", "state": "@component/entry/App/secret", "secure": true},
                detail,
                {"kind": "forEach", "id": "list", "collection": {"kind": "state", "state": "@component/entry/App/rows"},
                 "keyPath": ["id"], "children": [
                    {"kind": "row", "id": "row", "children": [
                        {"kind": "textField", "id": "note", "state": NOTE}
                    ]}
                ]},
                {"kind": "action", "id": "reverse", "label": "Reverse", "action": {"kind": "set-state",
                    "state": "@component/entry/App/rows",
                    "value": {"kind": "literal", "value": [{"id": "c"}, {"id": "b"}, {"id": "a"}]}}}
            ]
        }}
    })
    .to_string()
}

fn all_states(edit: &Edit) -> Vec<String> {
    let source: Value = serde_json::from_str(&program(edit)).unwrap();
    source["states"]
        .as_array()
        .unwrap()
        .iter()
        .map(|state| state["name"].as_str().unwrap().to_owned())
        .collect()
}

fn count(runtime: &Runtime) -> Option<f64> {
    runtime.state_value(COUNT).and_then(Value::as_f64)
}

fn appears(runtime: &Runtime) -> Option<f64> {
    runtime.state_value(APPEARS).and_then(Value::as_f64)
}

fn type_into(runtime: &mut Runtime, id: &str, text: &str) {
    assert!(runtime.focus_action(id));
    runtime
        .handle_input(
            InputEvent::TextEdit(TextEdit::Insert(text.into())),
            400.0,
            600.0,
        )
        .unwrap();
}

fn base() -> Runtime {
    let mut runtime = Runtime::from_json(&program(&Edit::default())).unwrap();
    runtime.activate_action("add");
    runtime.activate_action("add");
    runtime
}

#[test]
fn text_and_modifier_edits_preserve_state_without_relaunching_lifecycle() {
    let mut runtime = base();
    type_into(&mut runtime, "note[s:b]", "beta");
    assert_eq!(appears(&runtime), Some(1.0));
    let edit = Edit {
        label: "Current count: ",
        padding: 20.0,
        ..Edit::default()
    };
    let report = runtime
        .hot_update(&program(&edit), &all_states(&edit))
        .unwrap();
    assert_eq!(count(&runtime), Some(2.0));
    assert_eq!(
        runtime.state_value("@component/row/note[s:b]"),
        Some(&json!("beta"))
    );
    assert_eq!(report.reset_states, 0);
    // onAppear must not fire again for a View that never left.
    assert_eq!(appears(&runtime), Some(1.0));
    assert_eq!(report.lifecycle_mutations, 0);
    let tree = runtime.build_accessibility_tree(400.0, 600.0).unwrap();
    assert!(
        tree.nodes
            .iter()
            .any(|node| node.label.as_deref() == Some("Current count: 2"))
    );
}

#[test]
fn replaced_actions_execute_new_semantics() {
    let mut runtime = base();
    let edit = Edit {
        step: 10,
        ..Edit::default()
    };
    runtime
        .hot_update(&program(&edit), &all_states(&edit))
        .unwrap();
    runtime.activate_action("add");
    assert_eq!(count(&runtime), Some(12.0));
}

#[test]
fn incompatible_state_resets_only_that_scope() {
    let mut runtime = base();
    type_into(&mut runtime, "name", "Ada");
    let edit = Edit {
        count_initial: json!(""),
        ..Edit::default()
    };
    // Tooling excludes the retyped state from `preserve`.
    let preserve: Vec<String> = all_states(&edit)
        .into_iter()
        .filter(|name| name != COUNT)
        .collect();
    let report = runtime.hot_update(&program(&edit), &preserve).unwrap();
    assert_eq!(runtime.state_value(COUNT), Some(&json!("")));
    assert_eq!(runtime.state_value(NAME), Some(&json!("Ada")));
    assert_eq!(report.reset_states, 1);
}

#[test]
fn state_addition_and_removal_initialize_and_release() {
    let mut runtime = base();
    let added = Edit {
        extra_state: true,
        ..Edit::default()
    };
    runtime
        .hot_update(&program(&added), &all_states(&Edit::default()))
        .unwrap();
    assert_eq!(
        runtime.state_value("@component/entry/App/extra"),
        Some(&json!(true))
    );
    runtime
        .hot_update(&program(&Edit::default()), &all_states(&Edit::default()))
        .unwrap();
    assert_eq!(runtime.state_value("@component/entry/App/extra"), None);
    assert_eq!(count(&runtime), Some(2.0));
}

#[test]
fn conditional_branch_change_runs_real_presence_lifecycle() {
    let mut runtime = base();
    let edit = Edit {
        detail_branch: true,
        ..Edit::default()
    };
    let report = runtime
        .hot_update(&program(&edit), &all_states(&edit))
        .unwrap();
    // A different View became present: its onAppear runs exactly once.
    assert_eq!(appears(&runtime), Some(2.0));
    assert_eq!(report.lifecycle_mutations, 1);
}

#[test]
fn keyed_rows_keep_state_and_identity_through_reorder_and_body_edit() {
    let mut runtime = base();
    type_into(&mut runtime, "note[s:a]", "alpha");
    runtime.activate_action("reverse");
    let instance = runtime
        .retained_tree()
        .node("note[s:a]")
        .unwrap()
        .instance_id;
    let edit = Edit {
        padding: 4.0,
        ..Edit::default()
    };
    runtime
        .hot_update(&program(&edit), &all_states(&edit))
        .unwrap();
    assert_eq!(
        runtime.state_value("@component/row/note[s:a]"),
        Some(&json!("alpha"))
    );
    assert_eq!(
        runtime
            .retained_tree()
            .node("note[s:a]")
            .unwrap()
            .instance_id,
        instance
    );
    assert_eq!(runtime.scoped_state_count(), 3);
}

#[test]
fn rejected_update_leaves_program_state_and_focus_untouched() {
    let mut runtime = base();
    type_into(&mut runtime, "name", "Ada");
    assert!(
        runtime
            .hot_update("{\"version\": 1, \"states\": 3}", &[])
            .is_err()
    );
    assert!(runtime.hot_update("{", &[]).is_err());
    assert_eq!(count(&runtime), Some(2.0));
    assert_eq!(runtime.focused_action(), Some("name"));
    runtime.activate_action("add");
    assert_eq!(count(&runtime), Some(3.0));
}

#[test]
fn focused_text_field_survives_and_ime_composition_is_committed_once() {
    let mut runtime = base();
    type_into(&mut runtime, "name", "한");
    runtime
        .handle_input(
            InputEvent::TextEdit(TextEdit::CompositionUpdate(Composition {
                text: "글".into(),
                selection: None,
            })),
            400.0,
            600.0,
        )
        .unwrap();
    runtime.take_ime_requests();
    runtime
        .hot_update(&program(&Edit::default()), &all_states(&Edit::default()))
        .unwrap();
    let text = runtime
        .state_value(NAME)
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    assert!(
        text == "한글" || text == "한",
        "composition neither duplicated nor corrupted: {text:?}"
    );
    assert_eq!(runtime.focused_action(), Some("name"));
    assert!(
        runtime
            .focused_text_editor()
            .unwrap()
            .composition()
            .is_none()
    );
}

#[test]
fn removed_focus_target_clears_focus() {
    let mut runtime = base();
    type_into(&mut runtime, "note[s:c]", "x");
    let source: Value = serde_json::from_str(&program(&Edit::default())).unwrap();
    let mut source = source;
    source["states"][4]["initial"] = json!([{"id": "a"}]);
    // Collection membership comes from the preserved `rows` state, so drop it
    // from `preserve` to remove "c" by reset.
    let preserve: Vec<String> = all_states(&Edit::default())
        .into_iter()
        .filter(|name| !name.ends_with("/rows"))
        .collect();
    runtime.hot_update(&source.to_string(), &preserve).unwrap();
    assert_eq!(runtime.focused_action(), None);
    assert_eq!(runtime.scoped_state_count(), 1);
}

#[test]
fn inspection_redacts_secure_fields_and_omits_values_by_default() {
    let runtime = base();
    let snapshot = runtime.inspect(400.0, 600.0, false);
    let text = snapshot.to_string();
    assert!(!text.contains("hunter2"));
    assert!(
        snapshot["states"]
            .as_array()
            .unwrap()
            .iter()
            .all(|state| state.get("value").is_none())
    );
    let detailed = runtime.inspect(400.0, 600.0, true);
    assert!(!detailed.to_string().contains("hunter2"));
    assert!(detailed.to_string().contains("\"value\":2"));
    assert!(
        detailed["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| node["id"] == "label" && node.get("frame").is_some())
    );
}

#[test]
fn a_thousand_sequential_updates_do_not_leak_state_or_nodes() {
    let mut runtime = base();
    let nodes = runtime.retained_tree().len();
    for index in 0..1000 {
        let edit = Edit {
            padding: (index % 7) as f64,
            extra_state: index % 2 == 0,
            step: index % 3,
            ..Edit::default()
        };
        runtime
            .hot_update(&program(&edit), &all_states(&edit))
            .unwrap();
        if index % 100 == 0 {
            runtime.hot_update("{", &[]).unwrap_err();
        }
    }
    assert_eq!(count(&runtime), Some(2.0));
    assert_eq!(runtime.retained_tree().len(), nodes);
    assert_eq!(runtime.scoped_state_count(), 3);
    assert_eq!(appears(&runtime), Some(1.0));
}
