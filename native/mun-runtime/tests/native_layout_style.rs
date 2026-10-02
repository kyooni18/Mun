use std::{env, fs};

use mun_runtime::Runtime;
use serde_json::Value;

fn approx(actual: f32, expected: f32) {
    assert!(
        (actual - expected).abs() < 0.01,
        "expected {expected}, got {actual}"
    );
}

fn color_approx(actual: [f32; 4], expected: [f32; 4]) {
    for (actual, expected) in actual.into_iter().zip(expected) {
        assert!(
            (actual - expected).abs() < 0.001,
            "expected color channel {expected}, got {actual}"
        );
    }
}

fn child(node: &Value, index: usize) -> &Value {
    &node["children"][index]
}

#[test]
#[ignore = "run through scripts/test-native-ui.sh after compiling canonical .mun source"]
fn canonical_source_renders_stack_geometry_and_styles() {
    let path =
        env::var("MUN_NATIVE_UI_IR").expect("MUN_NATIVE_UI_IR must point at compiler-produced IR");
    let source = fs::read_to_string(&path).expect("read compiler-produced UI IR");
    let program: Value = serde_json::from_str(&source).expect("parse compiler-produced UI IR");

    // SwiftUI layering: `.frame(240, 220).padding(10).background(c)` is a
    // padding view (with the background) around a 240×220 frame around the
    // VStack, which the frame centers.
    let padded = &program["root"]["child"];
    assert_eq!(padded["kind"], "overlay");
    let framed = child(padded, 0);
    assert_eq!(framed["kind"], "overlay");
    let stack = child(framed, 0);
    assert_eq!(stack["kind"], "column");
    let row = child(stack, 0);
    let overlay = child(stack, 1);
    let text = child(stack, 2);
    assert_eq!(row["kind"], "row");
    assert_eq!(overlay["kind"], "overlay");
    assert_eq!(text["kind"], "text");

    let padded_id = padded["id"].as_str().expect("padding id");
    let framed_id = framed["id"].as_str().expect("frame id");
    let stack_id = stack["id"].as_str().expect("stack id");
    let row_id = row["id"].as_str().expect("row id");
    let red_id = child(row, 0)["id"].as_str().expect("red id");
    let green_id = child(row, 1)["id"].as_str().expect("green id");
    let overlay_id = overlay["id"].as_str().expect("overlay id");
    let blue_id = child(overlay, 0)["id"].as_str().expect("blue id");
    let small_id = child(overlay, 1)["id"].as_str().expect("small id");

    let runtime = Runtime::from_json(&source).expect("load compiler-produced UI IR");
    let accessibility = runtime
        .build_accessibility_tree(640.0, 420.0)
        .expect("build native layout/accessibility tree");
    let bounds = |id: &str| accessibility.node(id).expect("node bounds").bounds;

    // The fixed-size root is centered in the 640×420 window.
    let padded_bounds = bounds(padded_id);
    approx(padded_bounds.width, 260.0);
    approx(padded_bounds.height, 240.0);
    approx(padded_bounds.x, 190.0);
    approx(padded_bounds.y, 90.0);
    let framed_bounds = bounds(framed_id);
    approx(framed_bounds.width, 240.0);
    approx(framed_bounds.height, 220.0);
    approx(framed_bounds.x, padded_bounds.x + 10.0);
    approx(framed_bounds.y, padded_bounds.y + 10.0);

    // The frame centers the VStack vertically.
    let stack_bounds = bounds(stack_id);
    approx(
        stack_bounds.y - framed_bounds.y,
        framed_bounds.y + framed_bounds.height - (stack_bounds.y + stack_bounds.height),
    );

    let row_bounds = bounds(row_id);
    let red_bounds = bounds(red_id);
    let green_bounds = bounds(green_id);
    approx(row_bounds.width, 110.0);
    approx(row_bounds.height, 30.0);
    approx(
        row_bounds.x - stack_bounds.x,
        (stack_bounds.width - 110.0) / 2.0,
    );
    approx(row_bounds.y, stack_bounds.y);
    approx(red_bounds.width, 40.0);
    approx(red_bounds.height, 20.0);
    approx(green_bounds.width, 60.0);
    approx(green_bounds.height, 30.0);
    approx(green_bounds.x - red_bounds.x, 50.0);
    approx(
        red_bounds.y + red_bounds.height,
        green_bounds.y + green_bounds.height,
    );

    let overlay_bounds = bounds(overlay_id);
    let blue_bounds = bounds(blue_id);
    let small_bounds = bounds(small_id);
    approx(overlay_bounds.width, 120.0);
    approx(overlay_bounds.height, 80.0);
    approx(
        overlay_bounds.x - stack_bounds.x,
        (stack_bounds.width - 120.0) / 2.0,
    );
    approx(overlay_bounds.y, row_bounds.y + row_bounds.height + 12.0);
    approx(blue_bounds.x, overlay_bounds.x);
    approx(blue_bounds.y, overlay_bounds.y);
    approx(small_bounds.width, 40.0);
    approx(small_bounds.height, 20.0);
    approx(small_bounds.x, overlay_bounds.x + 40.0);
    approx(small_bounds.y, overlay_bounds.y + 30.0);

    let scene = runtime
        .build_scene(640.0, 420.0)
        .expect("build native scene");
    let rect = |id: &str| {
        scene
            .rects
            .iter()
            .find(|item| item.id == id)
            .unwrap_or_else(|| panic!("scene rect {id}"))
    };

    // The background was applied after the padding, so it covers it.
    let padded_rect = rect(padded_id);
    color_approx(
        padded_rect.color.0,
        [1.0 / 255.0, 2.0 / 255.0, 3.0 / 255.0, 1.0],
    );
    approx(padded_rect.rect.width, 260.0);
    approx(padded_rect.rect.height, 240.0);

    let red = rect(red_id);
    color_approx(red.color.0, [1.0, 0.0, 0.0, 1.0]);
    approx(red.corner_radius, 5.0);

    let green = rect(green_id);
    color_approx(green.color.0, [0.0, 1.0, 0.0, 0.5]);

    let blue = rect(blue_id);
    color_approx(
        blue.color.0,
        [
            0x11 as f32 / 255.0,
            0x22 as f32 / 255.0,
            0x33 as f32 / 255.0,
            1.0,
        ],
    );
    approx(blue.corner_radius, 12.0);

    let styled = scene
        .texts
        .iter()
        .find(|item| item.text == "Styled")
        .expect("styled text");
    color_approx(
        styled.color.0,
        [
            0xAB as f32 / 255.0,
            0xCD as f32 / 255.0,
            0xEF as f32 / 255.0,
            1.0,
        ],
    );
}
