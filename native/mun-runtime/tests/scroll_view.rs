use mun_runtime::{InputEvent, InputPoint, PointerId, Runtime, ScrollDelta, ScrollPhase};
use serde_json::{Value, json};
fn literal(value: impl Into<Value>) -> Value {
    json!({"kind":"literal","value":value.into()})
}
fn action(id: &str) -> Value {
    json!({"kind":"action","id":id,"label":id,"layout":{"width":literal(100),"height":literal(40)},"action":{"kind":"toggle-state","state":"flag"}})
}
fn scroll(id: &str, height: i32, children: Vec<Value>) -> Value {
    json!({"kind":"scroll","id":id,"axis":"vertical","layout":{"width":literal(100),"height":literal(height)},"children":children})
}
fn runtime(child: Value) -> Runtime {
    Runtime::from_json(&json!({"version":1,"sourceLanguage":"mun","entry":"Test","states":[{"name":"flag","initial":false}],"root":{"kind":"window","id":"window","title":"Test","child":child}}).to_string()).unwrap()
}
fn wheel(r: &mut Runtime, x: f32, y: f32, delta: f32) {
    r.handle_input(
        InputEvent::PointerMoved {
            pointer: PointerId::MOUSE,
            position: InputPoint::new(x, y),
        },
        300.0,
        300.0,
    )
    .unwrap();
    let outcome = r
        .handle_input(
            InputEvent::Scroll {
                pointer: Some(PointerId::MOUSE),
                delta: ScrollDelta::Pixels { x: 0.0, y: delta },
                phase: ScrollPhase::Changed,
            },
            300.0,
            300.0,
        )
        .unwrap();
    assert!(outcome.needs_redraw);
}
#[test]
fn viewport_layout_extent_clipping_hit_test_and_accessibility_agree() {
    let mut r = runtime(scroll(
        "scroll",
        60,
        vec![action("a"), action("b"), action("c")],
    ));
    let frame = r.build_frame(300.0, 300.0).unwrap();
    assert_eq!(r.scroll_view("scroll").unwrap().extent[1], 120.0);
    assert_eq!(frame.scene.action_at(20.0, 20.0), Some("a"));
    assert_eq!(frame.scene.action_at(20.0, 70.0), None);
    wheel(&mut r, 20.0, 20.0, -40.0);
    let frame = r.build_frame(300.0, 300.0).unwrap();
    assert_eq!(r.scroll_view("scroll").unwrap().offset[1], 40.0);
    assert_eq!(frame.scene.action_at(20.0, 20.0), Some("b"));
    assert_eq!(frame.accessibility.node("b").unwrap().bounds.y, 0.0);
    assert_eq!(frame.accessibility.node("c").unwrap().bounds.height, 20.0);
    assert_eq!(frame.scene.action_at(20.0, 70.0), None);
}
#[test]
fn nested_scroll_consumes_inner_then_routes_residual_to_outer() {
    let mut r = runtime(scroll(
        "outer",
        60,
        vec![
            scroll("inner", 40, vec![action("a"), action("b"), action("c")]),
            action("d"),
            action("e"),
        ],
    ));
    wheel(&mut r, 20.0, 20.0, -90.0);
    assert_eq!(r.scroll_view("inner").unwrap().offset[1], 80.0);
    assert_eq!(r.scroll_view("outer").unwrap().offset[1], 10.0);
    let frame = r.build_frame(300.0, 300.0).unwrap();
    assert_eq!(frame.scene.action_at(20.0, 20.0), Some("c"));
    assert_eq!(frame.scene.action_at(20.0, 35.0), Some("d"));
}
#[test]
fn conditional_removal_clamps_extent_and_resize_preserves_valid_offset() {
    let branch = json!({"kind":"conditional","id":"branch","condition":{"kind":"state","state":"flag"},"then":[action("extra")],"otherwise":[]});
    let mut r = runtime(scroll("scroll", 60, vec![action("a"), action("b"), branch]));
    r.activate_action("a");
    wheel(&mut r, 20.0, 20.0, -60.0);
    assert_eq!(r.scroll_view("scroll").unwrap().offset[1], 60.0);
    r.activate_action("a");
    r.build_frame(300.0, 200.0).unwrap();
    assert_eq!(r.scroll_view("scroll").unwrap().offset[1], 20.0);
    assert!(
        r.build_accessibility_tree(300.0, 200.0)
            .unwrap()
            .node("extra")
            .is_none()
    );
}

#[test]
fn keyboard_focus_reveals_offscreen_control_and_pointer_activates_scrolled_control() {
    let mut r = runtime(scroll(
        "scroll",
        60,
        vec![action("a"), action("b"), action("c")],
    ));
    r.build_frame(300.0, 300.0).unwrap();
    r.focus_next_action(false);
    r.focus_next_action(false);
    r.focus_next_action(false);
    let frame = r.build_frame(300.0, 300.0).unwrap();
    assert_eq!(r.scroll_view("scroll").unwrap().offset[1], 60.0);
    assert_eq!(frame.accessibility.node("c").unwrap().bounds.height, 40.0);
    assert_eq!(frame.scene.action_at(20.0, 30.0), Some("c"));
    for event in [
        InputEvent::PointerMoved {
            pointer: PointerId::MOUSE,
            position: InputPoint::new(20.0, 30.0),
        },
        InputEvent::PointerButton {
            pointer: PointerId::MOUSE,
            button: mun_runtime::PointerButton::Primary,
            state: mun_runtime::ButtonState::Pressed,
        },
        InputEvent::PointerButton {
            pointer: PointerId::MOUSE,
            button: mun_runtime::PointerButton::Primary,
            state: mun_runtime::ButtonState::Released,
        },
    ] {
        r.handle_input(event, 300.0, 300.0).unwrap();
    }
    assert_eq!(r.state_value("flag").unwrap(), true);
}

#[test]
fn scroll_inside_stack_keeps_following_sibling_at_viewport_edge() {
    let child = json!({"kind":"column","id":"stack","children":[scroll("scroll",60,vec![action("a"),action("b"),action("c")]),action("after")]});
    let mut r = runtime(child);
    wheel(&mut r, 20.0, 20.0, -40.0);
    let frame = r.build_frame(300.0, 300.0).unwrap();
    assert_eq!(frame.accessibility.node("after").unwrap().bounds.y, 60.0);
    assert_eq!(frame.scene.action_at(20.0, 75.0), Some("after"));
}

#[test]
fn resize_viewport_clamps_offsets_and_removal_discards_scroll_scope() {
    let mut view = scroll("scroll", 60, vec![action("a"), action("b"), action("c")]);
    view["layout"]["height"] = json!({"kind":"conditional","condition":{"kind":"state","state":"flag"},"then":literal(100),"otherwise":literal(60)});
    let mut r = runtime(view);
    wheel(&mut r, 20.0, 20.0, -60.0);
    r.activate_action("a");
    r.build_frame(300.0, 300.0).unwrap();
    assert_eq!(r.scroll_view("scroll").unwrap().bounds.height, 100.0);
    assert_eq!(r.scroll_view("scroll").unwrap().offset[1], 20.0);
    let branch = json!({"kind":"conditional","id":"branch","condition":{"kind":"state","state":"flag"},"then":[],"otherwise":[scroll("gone",60,vec![action("x"),action("y")])]});
    let mut r = runtime(branch);
    r.build_frame(300.0, 300.0).unwrap();
    assert!(r.scroll_view("gone").is_some());
    r.activate_action("x");
    r.build_frame(300.0, 300.0).unwrap();
    assert!(r.scroll_view("gone").is_none());
    assert!(r.focus_next_action(false).is_none());
}

#[test]
fn horizontal_scroll_and_line_input_use_logical_coordinates() {
    let mut view = scroll("scroll", 40, vec![action("a"), action("b"), action("c")]);
    view["axis"] = json!("horizontal");
    let mut r = runtime(view);
    r.handle_input(
        InputEvent::PointerMoved {
            pointer: PointerId::MOUSE,
            position: InputPoint::new(20.0, 20.0),
        },
        300.0,
        300.0,
    )
    .unwrap();
    r.handle_input(
        InputEvent::Scroll {
            pointer: Some(PointerId::MOUSE),
            delta: ScrollDelta::Lines { x: -2.0, y: 0.0 },
            phase: ScrollPhase::Changed,
        },
        300.0,
        300.0,
    )
    .unwrap();
    let frame = r.build_frame(300.0, 300.0).unwrap();
    assert_eq!(r.scroll_view("scroll").unwrap().offset[0], 64.0);
    assert_eq!(frame.scene.action_at(70.0, 20.0), Some("b"));
    assert_eq!(frame.scene.action_at(110.0, 20.0), None);
}

#[test]
fn duplicate_ids_inside_scroll_fail_before_layout() {
    let program = json!({"version":1,"sourceLanguage":"mun","entry":"Test","states":[],"root":{"kind":"window","id":"window","title":"Test","child":scroll("scroll",60,vec![action("same"),action("same")])}});
    assert!(
        Runtime::from_json(&program.to_string())
            .err()
            .expect("duplicate rejected")
            .to_string()
            .contains("same")
    );
}
