use mun_runtime::Runtime;

const PROGRAM: &str = include_str!("../../generated/NativeDemo.json");

fn panel_width(runtime: &Runtime) -> f32 {
    runtime
        .build_scene(640.0, 420.0)
        .expect("build scene")
        .rects
        .iter()
        .find(|item| item.id == "panel-3")
        .expect("animated panel")
        .rect
        .width
}

#[test]
fn state_transaction_drives_motion_layout_and_scene() {
    let mut runtime = Runtime::from_json(PROGRAM).expect("load compiler UI IR");
    assert!((panel_width(&runtime) - 160.0).abs() < 0.01);

    let transaction = runtime
        .activate_action("action-2")
        .expect("activate semantic action");
    assert_eq!(transaction.mutations.len(), 1);
    let program: serde_json::Value = serde_json::from_str(PROGRAM).expect("parse compiler UI IR");
    let expanded_state = program["states"][0]["name"]
        .as_str()
        .expect("compiled state identity");
    assert_eq!(transaction.mutations[0].state, expanded_state);
    assert!(runtime.has_active_motion());

    runtime.step(0.08);
    let in_flight = panel_width(&runtime);
    assert!(in_flight > 160.0 && in_flight < 320.0);

    for _ in 0..360 {
        runtime.step(1.0 / 120.0);
    }

    assert!((panel_width(&runtime) - 320.0).abs() < 0.05);
}

#[test]
fn accessibility_tree_tracks_semantics_focus_and_animated_layout() {
    use mun_runtime::ir::AccessibilityRole;

    let mut runtime = Runtime::from_json(PROGRAM).expect("load compiler UI IR");
    let initial = runtime
        .build_accessibility_tree(640.0, 420.0)
        .expect("build accessibility tree");
    assert_eq!(initial.root_id, "window-root");
    assert_eq!(initial.focus_id, None);
    assert_eq!(
        initial.node("window-root").unwrap().role,
        AccessibilityRole::Window
    );
    assert_eq!(
        initial.node("text-1").unwrap().label.as_deref(),
        Some("Mün")
    );
    let action = initial.node("action-2").expect("accessible action");
    assert_eq!(action.role, AccessibilityRole::Button);
    assert_eq!(action.label.as_deref(), Some("Toggle"));
    assert!(action.enabled);
    assert_eq!(action.action_id.as_deref(), Some("action-2"));
    assert!((initial.node("panel-3").unwrap().bounds.width - 160.0).abs() < 0.01);

    assert!(runtime.focus_action("action-2"));
    runtime
        .activate_focused()
        .expect("activate accessible action");
    runtime.step(0.08);

    let animated = runtime
        .build_accessibility_tree(640.0, 420.0)
        .expect("build animated accessibility tree");
    assert_eq!(animated.focus_id.as_deref(), Some("action-2"));
    assert!(animated.node("action-2").unwrap().focused);
    let width = animated.node("panel-3").unwrap().bounds.width;
    assert!(width > 160.0 && width < 320.0);
}

#[test]
fn disabled_semantic_action_cannot_activate_from_any_backend() {
    let mut value: serde_json::Value = serde_json::from_str(PROGRAM).expect("parse demo IR");
    value["root"]["child"]["children"][1]["accessibility"]["enabled"] = serde_json::json!({
        "kind": "literal",
        "value": false
    });
    let json = serde_json::to_string(&value).expect("serialize disabled IR");
    let mut runtime = Runtime::from_json(&json).expect("load disabled compiler UI IR");

    let tree = runtime
        .build_accessibility_tree(640.0, 420.0)
        .expect("build disabled accessibility tree");
    assert!(!tree.node("action-2").expect("action node").enabled);
    assert!(runtime.activate_action("action-2").is_none());
    assert!((panel_width(&runtime) - 160.0).abs() < 0.01);
}

#[test]
fn animation_value_trigger_must_change_before_target_motion_starts() {
    let mut value: serde_json::Value = serde_json::from_str(PROGRAM).expect("parse demo IR");
    value["root"]["child"]["children"][2]["motion"][0]["trigger"] = serde_json::json!({
        "kind": "literal",
        "value": false
    });
    let json = serde_json::to_string(&value).expect("serialize fixed-trigger IR");
    let mut runtime = Runtime::from_json(&json).expect("load fixed-trigger compiler UI IR");

    runtime
        .activate_action("action-2")
        .expect("toggle width state");
    assert!(!runtime.has_active_motion());
    assert!((panel_width(&runtime) - 320.0).abs() < 0.01);
}

#[test]
fn semantic_focus_traversal_skips_disabled_actions_and_wraps() {
    let mut value: serde_json::Value = serde_json::from_str(PROGRAM).expect("parse demo IR");
    let first = value["root"]["child"]["children"][1].clone();

    let mut disabled = first.clone();
    disabled["id"] = serde_json::json!("action-disabled");
    disabled["label"] = serde_json::json!("Disabled");
    disabled["accessibility"]["enabled"] = serde_json::json!({
        "kind": "literal",
        "value": false
    });

    let mut second = first.clone();
    second["id"] = serde_json::json!("action-second");
    second["label"] = serde_json::json!("Second");

    let children = value["root"]["child"]["children"]
        .as_array_mut()
        .expect("column children");
    children.insert(2, disabled);
    children.insert(3, second);

    let json = serde_json::to_string(&value).expect("serialize focus IR");
    let mut runtime = Runtime::from_json(&json).expect("load focus compiler UI IR");

    assert_eq!(
        runtime.focus_next_action(false).as_deref(),
        Some("action-2")
    );
    assert_eq!(
        runtime.focus_next_action(false).as_deref(),
        Some("action-second")
    );
    assert_eq!(
        runtime.focus_next_action(false).as_deref(),
        Some("action-2")
    );
    assert_eq!(
        runtime.focus_next_action(true).as_deref(),
        Some("action-second")
    );
    assert!(!runtime.focus_action("action-disabled"));
    assert_eq!(runtime.focused_action(), Some("action-second"));
}

#[test]
fn transaction_animation_is_fallback_for_dynamic_property_without_local_plan() {
    let mut value: serde_json::Value = serde_json::from_str(PROGRAM).expect("parse demo IR");
    let panel_binding = &mut value["root"]["child"]["children"][2]["motion"][0];
    let plan = panel_binding["plan"].take();
    panel_binding
        .as_object_mut()
        .expect("motion binding")
        .remove("plan");
    value["root"]["child"]["children"][1]["action"]["transaction"] = serde_json::json!({
        "animation": plan,
        "disablesAnimations": false,
        "isContinuous": false
    });

    let json = serde_json::to_string(&value).expect("serialize transaction IR");
    let mut runtime = Runtime::from_json(&json).expect("load transaction IR");
    let transaction = runtime
        .activate_action("action-2")
        .expect("activate transaction action");
    assert!(transaction.animation.is_some());
    assert!(runtime.has_active_motion());

    runtime.step(0.08);
    let width = panel_width(&runtime);
    assert!(width > 160.0 && width < 320.0);
}

#[test]
fn local_animation_override_wins_over_surrounding_transaction() {
    let mut value: serde_json::Value = serde_json::from_str(PROGRAM).expect("parse demo IR");
    let mut delayed = value["root"]["child"]["children"][2]["motion"][0]["plan"].clone();
    delayed["delayMs"] = serde_json::json!(1000.0);
    value["root"]["child"]["children"][1]["action"]["transaction"] = serde_json::json!({
        "animation": delayed,
        "disablesAnimations": false,
        "isContinuous": false
    });

    let json = serde_json::to_string(&value).expect("serialize override IR");
    let mut runtime = Runtime::from_json(&json).expect("load override IR");
    runtime
        .activate_action("action-2")
        .expect("activate override action");
    runtime.step(0.08);

    assert!(
        panel_width(&runtime) > 160.0,
        "local spring must not inherit transaction delay"
    );
}

#[test]
fn null_transaction_animation_snaps_property_without_local_override() {
    let mut value: serde_json::Value = serde_json::from_str(PROGRAM).expect("parse demo IR");
    value["root"]["child"]["children"][2]["motion"][0]
        .as_object_mut()
        .expect("motion binding")
        .remove("plan");
    value["root"]["child"]["children"][1]["action"]["transaction"] = serde_json::json!({
        "animation": null,
        "disablesAnimations": false,
        "isContinuous": false
    });

    let json = serde_json::to_string(&value).expect("serialize null transaction IR");
    let mut runtime = Runtime::from_json(&json).expect("load null transaction IR");
    let transaction = runtime
        .activate_action("action-2")
        .expect("activate null transaction action");
    assert!(transaction.animation.is_none());
    assert!(!runtime.has_active_motion());
    assert!((panel_width(&runtime) - 320.0).abs() < 0.01);
}

#[test]
fn disabling_transaction_suppresses_even_property_local_animation() {
    let mut value: serde_json::Value = serde_json::from_str(PROGRAM).expect("parse demo IR");
    value["root"]["child"]["children"][1]["action"]["transaction"] = serde_json::json!({
        "animation": value["root"]["child"]["children"][2]["motion"][0]["plan"].clone(),
        "disablesAnimations": true,
        "isContinuous": true
    });

    let json = serde_json::to_string(&value).expect("serialize disabled transaction IR");
    let mut runtime = Runtime::from_json(&json).expect("load disabled transaction IR");
    let transaction = runtime
        .activate_action("action-2")
        .expect("activate disabled transaction action");
    assert!(transaction.disables_animations);
    assert!(transaction.is_continuous);
    assert!(!runtime.has_active_motion());
    assert!((panel_width(&runtime) - 320.0).abs() < 0.01);
}
