//! Compiler-produced `examples/NativeSettingsPane.mun`: Toggle, Spacer,
//! Divider, SecureField, ProgressView and onAppear/onDisappear end to end.

use std::{env, fs};

use mun_runtime::{Runtime, ir::AccessibilityRole};
use serde_json::Value;

const WIDTH: f32 = 640.0;
const HEIGHT: f32 = 480.0;

fn approx(actual: f32, expected: f32) {
    assert!(
        (actual - expected).abs() < 0.01,
        "expected {expected}, got {actual}"
    );
}

fn state<'a>(program: &'a Value, suffix: &str) -> &'a str {
    program["states"]
        .as_array()
        .expect("states")
        .iter()
        .find_map(|state| {
            let name = state["name"].as_str()?;
            name.ends_with(suffix).then_some(name)
        })
        .unwrap_or_else(|| panic!("state ending in {suffix}"))
}

#[test]
#[ignore = "run through scripts/verify-native-contracts.mjs after compiling canonical .mun source"]
fn settings_pane_controls_layout_and_lifecycle() {
    let path = env::var("MUN_NATIVE_SETTINGS_IR")
        .expect("MUN_NATIVE_SETTINGS_IR must point at compiler-produced IR");
    let source = fs::read_to_string(&path).expect("read compiler-produced UI IR");
    let program: Value = serde_json::from_str(&source).expect("parse UI IR");
    let column = &program["root"]["child"]["children"][0];
    let id = |node: &Value| node["id"].as_str().expect("id").to_owned();
    let wifi_row = &column["children"][0];
    let (wifi, wifi_spacer, wifi_value) = (
        id(&wifi_row["children"][0]),
        id(&wifi_row["children"][1]),
        id(&wifi_row["children"][2]),
    );
    let divider = id(&column["children"][2]);
    let password = id(&column["children"][3]);
    let progress = id(&column["children"][4]);
    let wifi_state = state(&program, "/wifi");
    let visits = state(&program, "/visits");

    let mut runtime = Runtime::from_json(&source).expect("load compiled IR");
    let frame = runtime.build_frame(WIDTH, HEIGHT).expect("frame");
    let bounds = |id: &str| {
        frame
            .accessibility
            .nodes
            .iter()
            .find(|node| node.id == id)
            .unwrap_or_else(|| panic!("accessibility node {id}"))
            .clone()
    };

    // A Spacer makes its HStack fill the 420pt column and pushes the value
    // text to the trailing edge; the Divider is a 1pt rule across the column.
    let column_bounds = bounds(&id(column)).bounds;
    approx(column_bounds.width, 420.0);
    let row = bounds(&id(wifi_row)).bounds;
    approx(row.width, 420.0);
    let value = bounds(&wifi_value).bounds;
    approx(value.x + value.width, row.x + row.width);
    let spacer = bounds(&wifi_spacer).bounds;
    assert!(spacer.width >= 8.0, "spacer keeps its minimum length");
    let rule = bounds(&divider).bounds;
    approx(rule.height, 1.0);
    approx(rule.width, 420.0);

    // Toggle: checkbox semantics, activation flips the bound Bool.
    let toggle = bounds(&wifi);
    assert_eq!(toggle.role, AccessibilityRole::CheckBox);
    assert_eq!(toggle.checked, Some(false));
    assert_eq!(toggle.action_id.as_deref(), Some(wifi.as_str()));

    // SecureField: masked presentation; nothing of the value reaches AT.
    let secure = bounds(&password);
    assert_eq!(secure.role, AccessibilityRole::SecureTextField);
    assert!(secure.value.is_none() && secure.text.is_none());
    let presented = frame
        .scene
        .texts
        .iter()
        .find(|text| text.id == format!("{password}:text"))
        .expect("secure text");
    assert_eq!(presented.text, "\u{2022}".repeat(4));

    // ProgressView: value 3 of total 4.
    let bar = bounds(&progress);
    assert_eq!(bar.role, AccessibilityRole::ProgressIndicator);
    assert_eq!(bar.value.as_deref(), Some("75%"));
    let rect = |suffix: &str| {
        frame
            .scene
            .rects
            .iter()
            .find(|rect| rect.id == format!("{progress}:{suffix}"))
            .unwrap_or_else(|| panic!("progress {suffix}"))
            .rect
    };
    approx(rect("fill").width, rect("track").width * 0.75);

    // Lifecycle runs once per presence change, never per frame.
    let count = |runtime: &Runtime| {
        runtime
            .state_value(visits)
            .and_then(Value::as_f64)
            .expect("visits")
    };
    assert_eq!(count(&runtime), 0.0);
    let transaction = runtime.activate_interactive(&wifi).expect("toggle on");
    assert_eq!(runtime.state_value(wifi_state), Some(&Value::Bool(true)));
    assert!(
        transaction
            .mutations
            .iter()
            .any(|mutation| mutation.state == visits),
        "onAppear mutations belong to the transaction that caused the appearance"
    );
    for _ in 0..3 {
        runtime.build_frame(WIDTH, HEIGHT).expect("frame");
        runtime.step(1.0 / 60.0);
    }
    assert_eq!(count(&runtime), 1.0);
    runtime.activate_interactive(&wifi).expect("toggle off");
    assert_eq!(count(&runtime), 11.0);
    let frame = runtime.build_frame(WIDTH, HEIGHT).expect("frame");
    let toggle = frame
        .accessibility
        .nodes
        .iter()
        .find(|node| node.id == wifi)
        .expect("toggle");
    assert_eq!(toggle.checked, Some(false));
}
