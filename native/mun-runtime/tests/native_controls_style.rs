use std::{env, fs};

use mun_runtime::{
    Runtime,
    input::{
        ButtonState, InputEvent, InputPoint, KeyState, LogicalKey, PhysicalKey, PointerButton,
        PointerId,
    },
};
use serde_json::Value;

const WIDTH: f32 = 640.0;
const HEIGHT: f32 = 480.0;

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

fn state_name<'a>(program: &'a Value, suffix: &str) -> &'a str {
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

fn child(node: &Value, index: usize) -> &Value {
    &node["children"][index]
}

fn click(runtime: &mut Runtime, x: f32, y: f32) {
    let pointer = PointerId::MOUSE;
    runtime
        .handle_input(
            InputEvent::PointerMoved {
                pointer,
                position: InputPoint::new(x, y),
            },
            WIDTH,
            HEIGHT,
        )
        .expect("pointer move");
    runtime
        .handle_input(
            InputEvent::PointerButton {
                pointer,
                button: PointerButton::Primary,
                state: ButtonState::Pressed,
            },
            WIDTH,
            HEIGHT,
        )
        .expect("pointer press");
    runtime
        .handle_input(
            InputEvent::PointerButton {
                pointer,
                button: PointerButton::Primary,
                state: ButtonState::Released,
            },
            WIDTH,
            HEIGHT,
        )
        .expect("pointer release");
}

fn key(runtime: &mut Runtime, logical: LogicalKey, physical: PhysicalKey) {
    runtime
        .handle_input(
            InputEvent::Key {
                logical,
                physical,
                state: KeyState::Pressed,
                repeat: false,
            },
            WIDTH,
            HEIGHT,
        )
        .expect("key press");
}

#[test]
#[ignore = "run through scripts/test-native-controls.sh after compiling canonical .mun source"]
fn canonical_controls_mutate_state_relayout_and_render_styles() {
    let path = env::var("MUN_NATIVE_CONTROLS_IR")
        .expect("MUN_NATIVE_CONTROLS_IR must point at compiler-produced IR");
    let source = fs::read_to_string(&path).expect("read compiler-produced UI IR");
    let program: Value = serde_json::from_str(&source).expect("parse compiler-produced UI IR");

    let root = &program["root"]["child"];
    assert_eq!(root["kind"], "column");
    let text_field = child(root, 0);
    let radio = child(root, 1);
    let button = child(root, 2);
    let conditional = child(root, 3);
    let tail = child(root, 4);
    assert_eq!(text_field["kind"], "textField");
    assert_eq!(radio["kind"], "radioGroup");
    assert_eq!(button["kind"], "action");
    assert_eq!(conditional["kind"], "conditional");
    assert_eq!(tail["kind"], "text");

    let root_id = root["id"].as_str().expect("root id");
    let text_field_id = text_field["id"].as_str().expect("textfield id");
    let radio_id = radio["id"].as_str().expect("radio id");
    let button_id = button["id"].as_str().expect("button id");
    let tail_id = tail["id"].as_str().expect("tail id");
    let strip = &conditional["then"][0];
    assert_eq!(strip["kind"], "row");
    let strip_id = strip["id"].as_str().expect("strip id");
    let circle = child(strip, 0);
    let capsule = child(strip, 1);
    let circle_id = circle["id"].as_str().expect("circle id");
    let capsule_id = capsule["id"].as_str().expect("capsule id");

    let name_state = state_name(&program, "/name");
    let choice_state = state_name(&program, "/choice");
    let expanded_state = state_name(&program, "/expanded");

    let mut runtime = Runtime::from_json(&source).expect("load compiler-produced UI IR");
    assert_eq!(
        runtime.state_value(name_state),
        Some(&Value::String("Ada".into()))
    );
    assert_eq!(
        runtime.state_value(choice_state),
        Some(&Value::String("b".into()))
    );
    assert_eq!(
        runtime.state_value(expanded_state),
        Some(&Value::Bool(false))
    );

    let initial_accessibility = runtime
        .build_accessibility_tree(WIDTH, HEIGHT)
        .expect("initial accessibility/layout");
    let root_bounds = initial_accessibility
        .node(root_id)
        .expect("root bounds")
        .bounds;
    let field_bounds = initial_accessibility
        .node(text_field_id)
        .expect("field bounds")
        .bounds;
    let radio_bounds = initial_accessibility
        .node(radio_id)
        .expect("radio bounds")
        .bounds;
    let button_bounds = initial_accessibility
        .node(button_id)
        .expect("button bounds")
        .bounds;
    let tail_before = initial_accessibility
        .node(tail_id)
        .expect("tail bounds")
        .bounds;

    approx(root_bounds.width, 300.0);
    approx(root_bounds.height, 360.0);
    approx(field_bounds.width, 220.0);
    approx(field_bounds.height, 40.0);
    approx(field_bounds.x, root_bounds.x + 40.0);
    approx(field_bounds.y, root_bounds.y + 12.0);
    approx(radio_bounds.width, 220.0);
    approx(radio_bounds.height, 90.0);
    approx(radio_bounds.y, field_bounds.y + field_bounds.height + 8.0);
    approx(button_bounds.width, 160.0);
    approx(button_bounds.height, 40.0);
    approx(button_bounds.y, radio_bounds.y + radio_bounds.height + 8.0);
    approx(tail_before.y, button_bounds.y + button_bounds.height + 8.0);

    let initial_scene = runtime.build_scene(WIDTH, HEIGHT).expect("initial scene");
    let root_rect = initial_scene
        .rects
        .iter()
        .find(|rect| rect.id == root_id)
        .expect("composed root background");
    color_approx(
        root_rect.color.0,
        [8.0 / 255.0, 9.0 / 255.0, 10.0 / 255.0, 1.0],
    );
    approx(root_rect.corner_radius, 20.0);

    let field_background = initial_scene
        .rects
        .iter()
        .find(|rect| rect.id == format!("{text_field_id}:background"))
        .expect("textfield background");
    color_approx(
        field_background.color.0,
        [32.0 / 255.0, 32.0 / 255.0, 48.0 / 255.0, 1.0],
    );
    approx(field_background.corner_radius, 8.0);
    let field_text = initial_scene
        .texts
        .iter()
        .find(|text| text.id == format!("{text_field_id}:text"))
        .expect("textfield text");
    assert_eq!(field_text.text, "Ada");
    color_approx(
        field_text.color.0,
        [240.0 / 255.0, 240.0 / 255.0, 255.0 / 255.0, 1.0],
    );

    let button_background_id = format!("{button_id}:background");
    let button_background = initial_scene
        .rects
        .iter()
        .find(|rect| rect.id == button_background_id)
        .expect("button background");
    approx(button_background.corner_radius, 14.0);
    color_approx(button_background.color.0, [1.0, 0.0, 0.0, 1.0]);
    let button_gradient = initial_scene
        .gradient_for(&button_background_id)
        .expect("button gradient");
    color_approx(button_gradient.start.0, [1.0, 0.0, 0.0, 1.0]);
    color_approx(button_gradient.end.0, [0.0, 0.0, 1.0, 1.0]);
    assert_eq!(button_gradient.start_point, [0.0, 0.5]);
    assert_eq!(button_gradient.end_point, [1.0, 0.5]);
    let button_label = initial_scene
        .texts
        .iter()
        .find(|text| text.id == format!("{button_id}:label"))
        .expect("button label");
    color_approx(button_label.color.0, [1.0, 1.0, 1.0, 1.0]);

    let tail_text = initial_scene
        .texts
        .iter()
        .find(|text| text.id == tail_id)
        .expect("tail text");
    assert_eq!(tail_text.text, "Ada");
    color_approx(
        tail_text.color.0,
        [171.0 / 255.0, 205.0 / 255.0, 239.0 / 255.0, 1.0],
    );
    let tail_background = initial_scene
        .rects
        .iter()
        .find(|rect| rect.id == tail_id)
        .expect("text background");
    color_approx(
        tail_background.color.0,
        [17.0 / 255.0, 18.0 / 255.0, 19.0 / 255.0, 1.0],
    );
    approx(tail_background.corner_radius, 4.0);

    assert!(initial_scene.rects.iter().all(|rect| rect.id != circle_id));
    assert!(initial_scene.rects.iter().all(|rect| rect.id != capsule_id));

    // Pointer focus + real text input mutates the bound @State and redraws text.
    click(
        &mut runtime,
        field_bounds.x + field_bounds.width * 0.5,
        field_bounds.y + field_bounds.height * 0.5,
    );
    assert_eq!(runtime.focused_action(), Some(text_field_id));
    runtime
        .handle_input(
            InputEvent::TextInput {
                text: " Lovelace".into(),
            },
            WIDTH,
            HEIGHT,
        )
        .expect("text input");
    assert_eq!(
        runtime.state_value(name_state),
        Some(&Value::String("Ada Lovelace".into()))
    );
    key(&mut runtime, LogicalKey::Backspace, PhysicalKey::Backspace);
    assert_eq!(
        runtime.state_value(name_state),
        Some(&Value::String("Ada Lovelac".into()))
    );

    let edited_scene = runtime.build_scene(WIDTH, HEIGHT).expect("edited scene");
    assert_eq!(
        edited_scene
            .texts
            .iter()
            .find(|text| text.id == format!("{text_field_id}:text"))
            .expect("edited field text")
            .text,
        "Ada Lovelac"
    );
    assert_eq!(
        edited_scene
            .texts
            .iter()
            .find(|text| text.id == tail_id)
            .expect("edited bound Text")
            .text,
        "Ada Lovelac"
    );

    // Radio selection is a real interactive state mutation. Disabled options have no hit target.
    assert!(
        edited_scene
            .actions
            .iter()
            .all(|action| action.id != format!("{radio_id}:option:2"))
    );
    let alpha_hit = edited_scene
        .actions
        .iter()
        .find(|action| action.id == format!("{radio_id}:option:0"))
        .expect("alpha radio hit");
    click(
        &mut runtime,
        alpha_hit.rect.x + 5.0,
        alpha_hit.rect.y + alpha_hit.rect.height * 0.5,
    );
    assert_eq!(runtime.focused_action(), Some(radio_id));
    assert_eq!(
        runtime.state_value(choice_state),
        Some(&Value::String("a".into()))
    );

    key(
        &mut runtime,
        LogicalKey::ArrowRight,
        PhysicalKey::ArrowRight,
    );
    assert_eq!(
        runtime.state_value(choice_state),
        Some(&Value::String("b".into()))
    );
    key(
        &mut runtime,
        LogicalKey::ArrowRight,
        PhysicalKey::ArrowRight,
    );
    assert_eq!(
        runtime.state_value(choice_state),
        Some(&Value::String("a".into())),
        "disabled radio option must be skipped"
    );

    // Activating the styled Button inserts a composed View and forces live re-layout.
    let before_expand = runtime
        .build_accessibility_tree(WIDTH, HEIGHT)
        .expect("layout before expand");
    let tail_y_before_expand = before_expand.node(tail_id).expect("tail").bounds.y;
    let button_hit = runtime
        .build_scene(WIDTH, HEIGHT)
        .expect("scene before expand")
        .actions
        .into_iter()
        .find(|action| action.id == button_id)
        .expect("button hit");
    click(
        &mut runtime,
        button_hit.rect.x + button_hit.rect.width * 0.5,
        button_hit.rect.y + button_hit.rect.height * 0.5,
    );
    assert_eq!(
        runtime.state_value(expanded_state),
        Some(&Value::Bool(true))
    );

    let expanded_accessibility = runtime
        .build_accessibility_tree(WIDTH, HEIGHT)
        .expect("expanded layout");
    let strip_bounds = expanded_accessibility
        .node(strip_id)
        .expect("shape strip")
        .bounds;
    let circle_bounds = expanded_accessibility
        .node(circle_id)
        .expect("circle bounds")
        .bounds;
    let capsule_bounds = expanded_accessibility
        .node(capsule_id)
        .expect("capsule bounds")
        .bounds;
    let tail_after = expanded_accessibility
        .node(tail_id)
        .expect("tail after")
        .bounds;

    assert!(tail_after.y > tail_y_before_expand + 30.0);
    approx(circle_bounds.width, 30.0);
    approx(circle_bounds.height, 30.0);
    approx(capsule_bounds.width, 60.0);
    approx(capsule_bounds.height, 20.0);
    approx(
        capsule_bounds.x - (circle_bounds.x + circle_bounds.width),
        8.0,
    );
    approx(
        circle_bounds.y + circle_bounds.height,
        capsule_bounds.y + capsule_bounds.height,
    );
    approx(circle_bounds.x, strip_bounds.x + 4.0);

    let expanded_scene = runtime.build_scene(WIDTH, HEIGHT).expect("expanded scene");
    let strip_background = expanded_scene
        .rects
        .iter()
        .find(|rect| rect.id == strip_id)
        .expect("composed view modifier background");
    color_approx(
        strip_background.color.0,
        [12.0 / 255.0, 13.0 / 255.0, 14.0 / 255.0, 1.0],
    );
    approx(strip_background.corner_radius, 6.0);

    let circle_rect = expanded_scene
        .rects
        .iter()
        .find(|rect| rect.id == circle_id)
        .expect("circle rect");
    color_approx(circle_rect.color.0, [0.0, 1.0, 0.0, 1.0]);
    approx(circle_rect.corner_radius, 15.0);

    let capsule_rect = expanded_scene
        .rects
        .iter()
        .find(|rect| rect.id == capsule_id)
        .expect("capsule rect");
    approx(capsule_rect.corner_radius, 10.0);
    let capsule_gradient = expanded_scene
        .gradient_for(capsule_id)
        .expect("capsule foreground gradient");
    color_approx(capsule_gradient.start.0, [0.0, 1.0, 1.0, 1.0]);
    color_approx(capsule_gradient.end.0, [1.0, 0.0, 1.0, 1.0]);
}
