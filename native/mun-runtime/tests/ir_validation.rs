//! The runtime enforces the v1 Semantic UI IR contract strictly and names the
//! offending node and field.
use mun_runtime::{Runtime, RuntimeLoadError};
use serde_json::{Value, json};

fn base() -> Value {
    json!({
        "version": 1, "sourceLanguage": "mun", "entry": "V",
        "states": [{"name": "text", "initial": ""}, {"name": "count", "initial": 0}],
        "root": {"kind": "window", "id": "window", "title": "V", "child": {
            "kind": "column", "id": "stack", "children": [
                {"kind": "textField", "id": "field", "state": "text"},
                {"kind": "scroll", "id": "scroll", "axis": "vertical", "children": []},
                {"kind": "radioGroup", "id": "radio", "state": "text", "options": [{"label": "A", "value": "a"}]}
            ]
        }}
    })
}

fn rejected(case: usize, edit: impl FnOnce(&mut Value)) -> (Option<String>, String, String) {
    let mut program = base();
    edit(&mut program);
    match Runtime::from_json(&program.to_string()) {
        Err(RuntimeLoadError::Invalid(error)) => (error.node, error.path, error.message),
        Err(other) => panic!("case {case}: expected contract violation, got {other}"),
        Ok(_) => panic!("case {case}: accepted invalid IR"),
    }
}

fn child(program: &mut Value, index: usize) -> &mut Value {
    &mut program["root"]["child"]["children"][index]
}

#[test]
fn malformed_programs_are_rejected_with_node_and_field() {
    assert!(Runtime::from_json(&base().to_string()).is_ok());
    let cases: Vec<(Box<dyn FnOnce(&mut Value)>, Option<&str>, &str, &str)> = vec![
        (
            Box::new(|p| p["extra"] = json!(1)),
            None,
            "/extra",
            "unknown field",
        ),
        (
            Box::new(|p| p["root"]["child"]["colour"] = json!("red")),
            Some("stack"),
            "/root/child/colour",
            "unknown field",
        ),
        (
            Box::new(|p| child(p, 0)["visual"] = json!({"glow": 1})),
            Some("field"),
            "visual/glow",
            "unknown field",
        ),
        (
            Box::new(|p| child(p, 0)["layout"] = json!({"padding": "8"})),
            Some("field"),
            "layout/padding",
            "expected \"number\"",
        ),
        (
            Box::new(|p| child(p, 1)["axis"] = json!("diagonal")),
            Some("scroll"),
            "/axis",
            "not one of",
        ),
        (
            Box::new(|p| {
                child(p, 1).as_object_mut().unwrap().remove("axis");
            }),
            Some("scroll"),
            "",
            "missing required field 'axis'",
        ),
        (
            Box::new(|p| child(p, 0)["kind"] = json!("slider")),
            Some("field"),
            "/kind",
            "unsupported kind",
        ),
        (
            Box::new(
                |p| *child(p, 0) = json!({"kind": "window", "id": "w2", "title": "x", "child": {"kind": "column", "id": "c", "children": []}}),
            ),
            Some("w2"),
            "/kind",
            "unsupported kind",
        ),
        (
            Box::new(|p| child(p, 0)["accessibility"] = json!({"role": "slider"})),
            Some("field"),
            "accessibility/role",
            "not one of",
        ),
        (
            Box::new(|p| child(p, 0)["state"] = json!("count")),
            Some("field"),
            "/state",
            "must hold a string",
        ),
        (
            Box::new(|p| child(p, 0)["state"] = json!("missing")),
            Some("field"),
            "/state",
            "undeclared state",
        ),
        (
            Box::new(|p| {
                child(p, 2)["options"] =
                    json!([{"label": "A", "value": "a"}, {"label": "B", "value": "a"}])
            }),
            Some("radio"),
            "options/1/value",
            "duplicate",
        ),
        (
            Box::new(|p| {
                p["root"]["child"]["children"].as_array_mut().unwrap().push(json!({"kind": "text", "id": "t", "value": {"kind": "item", "forEach": "list", "path": []}}))
            }),
            Some("t"),
            "value/forEach",
            "outside its forEach",
        ),
        (
            Box::new(|p| {
                p["states"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"name": "row", "initial": "", "scope": "nowhere"}))
            }),
            None,
            "/states",
            "unknown forEach",
        ),
        (
            Box::new(|p| {
                p["states"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"name": "text", "initial": ""}))
            }),
            None,
            "/states/2/name",
            "duplicate state",
        ),
    ];
    for (case, (edit, node, path, message)) in cases.into_iter().enumerate() {
        let (found_node, found_path, found_message) = rejected(case, edit);
        let context = format!("case {case}: {found_node:?} {found_path}: {found_message}");
        assert_eq!(found_node.as_deref(), node, "{context}");
        assert!(found_path.contains(path), "{context}");
        assert!(found_message.contains(message), "{context}");
    }
}

#[test]
fn unsupported_versions_are_reported_before_field_validation() {
    let mut program = base();
    program["version"] = json!(2);
    program["futureField"] = json!(true);
    let error = Runtime::from_json(&program.to_string()).err().unwrap();
    assert!(
        matches!(error, RuntimeLoadError::UnsupportedVersion { found: 2, .. }),
        "{error}"
    );
}
