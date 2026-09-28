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
