use std::{env, fs};

use mun_runtime::{Runtime, SEMANTIC_UI_IR_VERSION};
use serde_json::Value;

#[test]
#[ignore = "run through scripts/test-native-contract.sh after compiling canonical .mun source"]
fn compiler_output_deserializes_into_native_runtime() {
    let path = env::var("MUN_COMPILER_CONTRACT_IR")
        .expect("MUN_COMPILER_CONTRACT_IR must point at compiler-produced Semantic UI IR");
    let source = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read compiler-produced Semantic UI IR at {path}: {error}"));

    let value: Value =
        serde_json::from_str(&source).expect("compiler-produced Semantic UI IR must be valid JSON");
    assert_eq!(
        value.get("version").and_then(Value::as_u64),
        Some(u64::from(SEMANTIC_UI_IR_VERSION)),
        "TypeScript compiler and Rust runtime must agree on the Semantic UI IR version",
    );
    assert_eq!(
        value.get("sourceLanguage").and_then(Value::as_str),
        Some("mun"),
        "native runtime contract only accepts canonical Mün semantic programs here",
    );

    Runtime::from_json(&source)
        .expect("compiler-produced Semantic UI IR must deserialize into the native runtime");
}

/// Compiler-produced keyed rows (NativeProductionSmoke `TaskRow`) keep per-key
/// View state through insertion, reordering and removal of neighbors.
#[test]
#[ignore = "run through scripts/verify-native-contracts.mjs with compiled NativeProductionSmoke"]
fn compiled_keyed_rows_keep_state_by_key() {
    use mun_runtime::InputEvent;
    use mun_runtime::text_edit::TextEdit;
    let path = env::var("MUN_KEYED_CONTRACT_IR").expect("MUN_KEYED_CONTRACT_IR");
    let mut runtime = Runtime::from_json(&fs::read_to_string(path).unwrap()).unwrap();
    let (width, height) = (640.0, 900.0);
    let nodes = |runtime: &Runtime| {
        runtime
            .build_accessibility_tree(width, height)
            .unwrap()
            .nodes
    };
    let find = |runtime: &Runtime, key: &str, label: &str| {
        nodes(runtime)
            .into_iter()
            .find(|node| {
                node.id.ends_with(&format!("[s:{key}]")) && node.label.as_deref() == Some(label)
            })
            .unwrap_or_else(|| panic!("row {key} control {label}"))
            .id
    };
    let note_of = |runtime: &Runtime, key: &str| {
        nodes(runtime)
            .into_iter()
            .find(|node| {
                node.id.ends_with(&format!("[s:{key}]"))
                    && node.label.as_deref() == Some("Note for this row")
            })
            .and_then(|node| node.value)
    };
    let order = |runtime: &Runtime| -> Vec<String> {
        nodes(runtime)
            .into_iter()
            .filter(|node| node.label.as_deref() == Some("Remove"))
            .map(|node| {
                node.id
                    .rsplit("[s:")
                    .next()
                    .unwrap()
                    .trim_end_matches(']')
                    .to_owned()
            })
            .collect()
    };
    assert_eq!(order(&runtime), ["draft", "review", "ship"]);
    for key in ["draft", "ship"] {
        assert!(runtime.focus_action(&find(&runtime, key, "Note for this row")));
        runtime
            .handle_input(
                InputEvent::TextEdit(TextEdit::Insert(format!("{key} 메모"))),
                width,
                height,
            )
            .unwrap();
    }
    runtime.activate_action(&find(&runtime, "ship", "Done"));
    let add = nodes(&runtime)
        .into_iter()
        .find(|node| node.label.as_deref() == Some("Add task"))
        .unwrap()
        .id;
    runtime.activate_action(&add);
    runtime.activate_action(&find(&runtime, "ship", "Up"));
    runtime.activate_action(&find(&runtime, "draft", "Remove"));
    assert_eq!(order(&runtime), ["task1", "ship", "review"]);
    assert_eq!(note_of(&runtime, "ship").as_deref(), Some("ship 메모"));
    assert_eq!(note_of(&runtime, "task1").as_deref(), Some(""));
    assert_eq!(note_of(&runtime, "review").as_deref(), Some(""));
    let done_marks: Vec<_> = nodes(&runtime)
        .into_iter()
        .filter(|node| node.label.as_deref() == Some("✓"))
        .map(|node| node.id)
        .collect();
    assert_eq!(done_marks.len(), 1);
    assert!(done_marks[0].ends_with("[s:ship]"), "{done_marks:?}");
}
