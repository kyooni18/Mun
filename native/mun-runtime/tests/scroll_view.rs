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
/// Pins the content to the window's top-leading corner (SwiftUI centers a
/// fixed-size root), so the fixtures can use window coordinates directly.
fn top_leading(child: Value) -> Value {
    json!({"kind":"overlay","id":"frame","alignment":"topLeading","layout":{"maxWidth":"infinity","maxHeight":"infinity"},"children":[child]})
}
fn runtime(child: Value) -> Runtime {
    Runtime::from_json(&json!({"version":1,"sourceLanguage":"mun","entry":"Test","states":[{"name":"flag","initial":false}],"root":{"kind":"window","id":"window","title":"Test","child":top_leading(child)}}).to_string()).unwrap()
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
    let child = json!({"kind":"column","id":"stack","layout":{"maxWidth":"infinity"},"children":[scroll("scroll",60,vec![action("a"),action("b"),action("c")]),action("after")]});
    let mut r = runtime(child);
    // The flexible root column fills the 300pt window width and centers its 100pt children.
    wheel(&mut r, 120.0, 20.0, -40.0);
    let frame = r.build_frame(300.0, 300.0).unwrap();
    assert_eq!(frame.accessibility.node("after").unwrap().bounds.x, 100.0);
    assert_eq!(frame.accessibility.node("after").unwrap().bounds.y, 60.0);
    assert_eq!(frame.scene.action_at(120.0, 75.0), Some("after"));
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
    let program = json!({"version":1,"sourceLanguage":"mun","entry":"Test","states":[],"root":{"kind":"window","id":"window","title":"Test","child":top_leading(scroll("scroll",60,vec![action("same"),action("same")]))}});
    assert!(
        Runtime::from_json(&program.to_string())
            .err()
            .expect("duplicate rejected")
            .to_string()
            .contains("same")
    );
}

fn press_key(r: &mut Runtime, logical: mun_runtime::LogicalKey) -> mun_runtime::InputOutcome {
    r.handle_input(
        InputEvent::Key {
            logical,
            physical: mun_runtime::PhysicalKey::Other,
            state: mun_runtime::KeyState::Pressed,
            repeat: false,
        },
        300.0,
        300.0,
    )
    .unwrap()
}

fn offset(r: &Runtime, id: &str) -> f32 {
    r.scroll_view(id).unwrap().offset[1]
}

fn pointer(r: &mut Runtime, event: InputEvent) {
    r.handle_input(event, 300.0, 300.0).unwrap();
}

fn primary(state: mun_runtime::ButtonState) -> InputEvent {
    InputEvent::PointerButton {
        pointer: PointerId::MOUSE,
        button: mun_runtime::PointerButton::Primary,
        state,
    }
}

fn moved(x: f32, y: f32) -> InputEvent {
    InputEvent::PointerMoved {
        pointer: PointerId::MOUSE,
        position: InputPoint::new(x, y),
    }
}

fn tall(id: &str, count: usize) -> Value {
    scroll(
        id,
        200,
        (0..count)
            .map(|index| action(&format!("{id}-{index}")))
            .collect(),
    )
}

#[test]
fn keyboard_scrolling_is_owned_by_the_focused_scroll_container() {
    use mun_runtime::LogicalKey;
    // 10 x 40pt actions in a 200pt viewport: max offset 200.
    let mut r = runtime(tall("list", 10));
    r.build_frame(300.0, 300.0).unwrap();
    r.focus_action("list-0");
    r.build_frame(300.0, 300.0).unwrap();
    assert!(press_key(&mut r, LogicalKey::ArrowDown).needs_redraw);
    assert_eq!(offset(&r, "list"), 40.0);
    press_key(&mut r, LogicalKey::PageDown);
    assert_eq!(
        offset(&r, "list"),
        200.0,
        "page = viewport - one line, clamped"
    );
    press_key(&mut r, LogicalKey::Home);
    assert_eq!(offset(&r, "list"), 0.0);
    press_key(&mut r, LogicalKey::End);
    assert_eq!(offset(&r, "list"), 200.0);
    assert!(
        !press_key(&mut r, LogicalKey::PageDown).handled,
        "already at end"
    );
    // Scrolling never moves semantic focus.
    assert_eq!(r.focused_action(), Some("list-0"));
    press_key(&mut r, LogicalKey::PageUp);
    assert_eq!(offset(&r, "list"), 40.0);
}

#[test]
fn unfocused_keyboard_scrolling_targets_the_hovered_viewport() {
    use mun_runtime::LogicalKey;
    let mut r = runtime(tall("list", 10));
    r.build_frame(300.0, 300.0).unwrap();
    assert!(
        !press_key(&mut r, LogicalKey::PageDown).handled,
        "no focus, no hover"
    );
    pointer(&mut r, moved(20.0, 20.0));
    press_key(&mut r, LogicalKey::PageDown);
    assert_eq!(offset(&r, "list"), 160.0);
    assert_eq!(r.focused_action(), None);
}

#[test]
fn nested_keyboard_scroll_routes_to_ancestor_when_inner_is_exhausted() {
    use mun_runtime::LogicalKey;
    let outer = json!({"kind":"scroll","id":"outer","axis":"vertical","layout":{"width":literal(120),"height":literal(150)},"children":[
        tall("inner", 6), action("after-0"), action("after-1"), action("after-2")
    ]});
    let mut r = runtime(outer);
    r.build_frame(300.0, 300.0).unwrap();
    r.focus_action("inner-0");
    r.build_frame(300.0, 300.0).unwrap();
    press_key(&mut r, LogicalKey::End);
    assert_eq!(offset(&r, "inner"), 40.0);
    assert_eq!(offset(&r, "outer"), 0.0, "inner absorbed the movement");
    press_key(&mut r, LogicalKey::ArrowDown);
    assert_eq!(offset(&r, "outer"), 40.0, "residual routed to the ancestor");
}

#[test]
fn focus_reveal_through_nested_ancestors_is_minimal() {
    let outer = json!({"kind":"scroll","id":"outer","axis":"vertical","layout":{"width":literal(120),"height":literal(150)},"children":[
        action("before-0"), action("before-1"), tall("inner", 8)
    ]});
    let mut r = runtime(outer);
    r.build_frame(300.0, 300.0).unwrap();
    // inner viewport occupies outer content 80..280; target inner-6 sits at
    // inner content 240..280.
    r.focus_action("inner-6");
    let frame = r.build_frame(300.0, 300.0).unwrap();
    assert_eq!(offset(&r, "inner"), 80.0, "inner scrolls just enough");
    assert_eq!(offset(&r, "outer"), 130.0, "outer scrolls just enough");
    let bounds = frame.accessibility.node("inner-6").unwrap().bounds;
    assert_eq!(
        bounds.y + bounds.height,
        150.0,
        "target touches the visible edge"
    );
    // Revealing an already visible control does not move anything.
    r.focus_action("inner-5");
    r.build_frame(300.0, 300.0).unwrap();
    assert_eq!((offset(&r, "inner"), offset(&r, "outer")), (80.0, 130.0));
}

#[test]
fn scrollbar_presentation_drag_and_track_paging_are_semantic_scroll_operations() {
    let mut r = runtime(
        json!({"kind":"row","id":"stack","layout":{"alignment":"leading"},"children":[tall("list", 10), tall("short", 2)]}),
    );
    let scene = r.build_scene(300.0, 300.0).unwrap();
    let thumb = scene
        .rects
        .iter()
        .find(|item| item.id == "list:scrollbar-thumb")
        .expect("overflowing viewport shows a thumb")
        .rect;
    assert!(
        !scene
            .rects
            .iter()
            .any(|item| item.id.starts_with("short:scrollbar")),
        "content that fits has no scrollbar"
    );
    // Thumb ratio: 200/400 of a 196pt track.
    assert!((thumb.height - 98.0).abs() < 0.01);

    // Drag the thumb by half its travel -> half the offset range.
    let (x, y) = (thumb.x + 3.0, thumb.y + 10.0);
    pointer(&mut r, moved(x, y));
    pointer(&mut r, primary(mun_runtime::ButtonState::Pressed));
    assert_eq!(
        r.focused_action(),
        None,
        "scrollbar presses never take focus"
    );
    pointer(&mut r, moved(x, y + 49.0));
    assert!((offset(&r, "list") - 100.0).abs() < 0.01);
    pointer(&mut r, primary(mun_runtime::ButtonState::Released));
    assert_eq!(
        r.state_value("flag").unwrap(),
        false,
        "no activation under the bar"
    );

    // Track press below the thumb pages forward.
    let scene = r.build_scene(300.0, 300.0).unwrap();
    let track = scene
        .rects
        .iter()
        .find(|item| item.id == "list:scrollbar-track")
        .unwrap()
        .rect;
    pointer(&mut r, moved(track.x + 3.0, track.y + track.height - 2.0));
    pointer(&mut r, primary(mun_runtime::ButtonState::Pressed));
    pointer(&mut r, primary(mun_runtime::ButtonState::Released));
    assert_eq!(offset(&r, "list"), 200.0);
    let thumb = r
        .build_scene(300.0, 300.0)
        .unwrap()
        .rects
        .into_iter()
        .find(|item| item.id == "list:scrollbar-thumb")
        .unwrap()
        .rect;
    assert!((thumb.y + thumb.height - (track.y + track.height)).abs() < 0.01);
}
