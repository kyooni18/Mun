use mun_runtime::input::ClipboardRequest;
use mun_runtime::text_edit::{Composition, TextEdit};
use mun_runtime::{
    ButtonState, ImeRequest, InputEvent, InputPoint, KeyState, LogicalKey, Modifiers, PhysicalKey,
    PointerButton, PointerId, Runtime,
};
fn runtime() -> Runtime {
    Runtime::from_json(r#"{"version":1,"sourceLanguage":"mun","entry":"Test","states":[{"name":"name","initial":"Ada"}],"root":{"kind":"window","id":"window","title":"Test","child":{"kind":"column","id":"stack","children":[{"kind":"textField","id":"field","state":"name"},{"kind":"textField","id":"other","state":"name"}]}}}"#).unwrap()
}
fn input(runtime: &mut Runtime, event: InputEvent) {
    runtime.handle_input(event, 400.0, 300.0).unwrap();
}
fn key(runtime: &mut Runtime, logical: LogicalKey) {
    input(
        runtime,
        InputEvent::Key {
            logical,
            physical: PhysicalKey::Other,
            state: KeyState::Pressed,
            repeat: false,
        },
    );
}
#[test]
fn composition_binding_scene_focus_and_commit_contract() {
    let mut r = runtime();
    assert!(r.focus_action("field"));
    input(&mut r, InputEvent::TextEdit(TextEdit::SelectAll));
    input(
        &mut r,
        InputEvent::TextEdit(TextEdit::CompositionUpdate(Composition {
            text: "한".into(),
            selection: Some((1, 1)),
        })),
    );
    // Bound views see a partial syllable immediately.
    assert_eq!(r.state_value("name").unwrap(), "한");
    assert_eq!(
        r.build_accessibility_tree(400.0, 300.0)
            .unwrap()
            .node("field")
            .unwrap()
            .value
            .as_deref(),
        Some("한")
    );
    assert_eq!(
        r.build_scene(400.0, 300.0)
            .unwrap()
            .texts
            .iter()
            .find(|text| text.id == "field:text")
            .unwrap()
            .text,
        "한"
    );
    // The IME owns editing keys while composing.
    key(&mut r, LogicalKey::Backspace);
    assert_eq!(r.state_value("name").unwrap(), "한");
    // Cancelling restores the committed text; re-composing then committing
    // replaces the still-selected text.
    input(&mut r, InputEvent::TextEdit(TextEdit::CompositionCancel));
    assert_eq!(r.state_value("name").unwrap(), "Ada");
    input(
        &mut r,
        InputEvent::TextEdit(TextEdit::CompositionCommit("한글".into())),
    );
    assert_eq!(r.state_value("name").unwrap(), "한글");
    key(&mut r, LogicalKey::ArrowLeft);
    input(
        &mut r,
        InputEvent::TextInput {
            text: "😀".into()
        },
    );
    assert_eq!(r.state_value("name").unwrap(), "한😀글");
    input(
        &mut r,
        InputEvent::TextEdit(TextEdit::CompositionUpdate(Composition {
            text: "ㅎ".into(),
            selection: None,
        })),
    );
    // Moving focus deliberately commits the visible preedit into the field that
    // owned it (native text-view semantics) and asks the platform to discard its
    // own marked text so the IME cannot continue the syllable elsewhere.
    assert!(r.focus_action("other"));
    assert!(r.focused_text_editor().is_none());
    assert_eq!(r.state_value("name").unwrap(), "한😀ㅎ글");
    assert_eq!(r.take_ime_requests(), vec![ImeRequest::DiscardComposition]);
}
#[test]
fn clipboard_is_a_semantic_service_and_stale_paste_cannot_retarget() {
    let mut r = runtime();
    r.focus_action("field");
    input(
        &mut r,
        InputEvent::ModifiersChanged(Modifiers {
            control: true,
            ..Default::default()
        }),
    );
    key(&mut r, LogicalKey::Character("a".into()));
    key(&mut r, LogicalKey::Character("c".into()));
    assert_eq!(
        r.take_clipboard_requests(),
        vec![ClipboardRequest::Write("Ada".into())]
    );
    key(&mut r, LogicalKey::Character("x".into()));
    assert_eq!(r.state_value("name").unwrap(), "Ada");
    assert_eq!(
        r.take_clipboard_requests(),
        vec![ClipboardRequest::Cut {
            request: 1,
            text: "Ada".into()
        }]
    );
    input(
        &mut r,
        InputEvent::ClipboardWriteCompleted {
            request: 1,
            success: true,
        },
    );
    assert_eq!(r.state_value("name").unwrap(), "");
    key(&mut r, LogicalKey::Character("v".into()));
    assert_eq!(
        r.take_clipboard_requests(),
        vec![ClipboardRequest::Read {
            request: 2,
            target: "field".into()
        }]
    );
    // Focus moved before the asynchronous response: the stale paste is dropped.
    r.focus_action("other");
    input(
        &mut r,
        InputEvent::ClipboardReadCompleted {
            request: 2,
            text: Some("wrong".into()),
        },
    );
    assert_eq!(r.state_value("name").unwrap(), "");
    key(&mut r, LogicalKey::Character("v".into()));
    assert_eq!(
        r.take_clipboard_requests(),
        vec![ClipboardRequest::Read {
            request: 3,
            target: "other".into()
        }]
    );
    input(
        &mut r,
        InputEvent::ClipboardReadCompleted {
            request: 3,
            text: Some("한\r\n국\u{7}".into()),
        },
    );
    assert_eq!(r.state_value("name").unwrap(), "한 국");
    input(&mut r, InputEvent::WindowFocusChanged(false));
    key(&mut r, LogicalKey::Character("x".into()));
    assert!(r.take_clipboard_requests().is_empty());
}

#[test]
fn cut_failure_or_changed_selection_never_deletes_text() {
    let mut r = runtime();
    r.focus_action("field");
    input(
        &mut r,
        InputEvent::ModifiersChanged(Modifiers {
            control: true,
            ..Default::default()
        }),
    );
    key(&mut r, LogicalKey::Character("a".into()));
    key(&mut r, LogicalKey::Character("x".into()));
    input(
        &mut r,
        InputEvent::ClipboardWriteCompleted {
            request: 1,
            success: false,
        },
    );
    assert_eq!(r.state_value("name").unwrap(), "Ada");
    key(&mut r, LogicalKey::Character("x".into()));
    input(
        &mut r,
        InputEvent::TextEdit(TextEdit::Left { select: false }),
    );
    input(
        &mut r,
        InputEvent::ClipboardWriteCompleted {
            request: 2,
            success: true,
        },
    );
    assert_eq!(r.state_value("name").unwrap(), "Ada");
}

const WIDE_FIELD: &str = r#"{"version":1,"sourceLanguage":"mun","entry":"Test","states":[{"name":"name","initial":"한국 hi"},{"name":"flag","initial":false}],"root":{"kind":"window","id":"window","title":"Test","child":{"kind":"column","id":"stack","layout":{"alignment":"leading"},"children":[{"kind":"textField","id":"field","state":"name","layout":{"width":{"kind":"literal","value":300},"height":{"kind":"literal","value":40}}},{"kind":"action","id":"button","label":"Go","action":{"kind":"toggle-state","state":"flag"}}]}}}"#;

fn rect<'a>(scene: &'a mun_runtime::Scene, id: &str) -> Option<&'a mun_runtime::scene::SceneRect> {
    scene.rects.iter().find(|item| item.id == id)
}

fn press_at(r: &mut Runtime, x: f32, y: f32) {
    input(
        r,
        InputEvent::PointerMoved {
            pointer: PointerId::MOUSE,
            position: InputPoint::new(x, y),
        },
    );
    input(
        r,
        InputEvent::PointerButton {
            pointer: PointerId::MOUSE,
            button: PointerButton::Primary,
            state: ButtonState::Pressed,
        },
    );
}

fn release(r: &mut Runtime) {
    input(
        r,
        InputEvent::PointerButton {
            pointer: PointerId::MOUSE,
            button: PointerButton::Primary,
            state: ButtonState::Released,
        },
    );
}

/// Headless metrics: 9.6pt per grapheme at 16pt, text origin at field.x + 12.
fn caret_x(boundary: usize) -> f32 {
    12.0 + boundary as f32 * 9.6
}

#[test]
fn caret_selection_and_preedit_are_presented_from_shaped_geometry() {
    let mut r = Runtime::from_json(WIDE_FIELD).unwrap();
    let scene = r.build_scene(400.0, 300.0).unwrap();
    assert!(
        rect(&scene, "field:caret").is_none(),
        "unfocused fields draw no caret"
    );

    r.focus_action("field");
    input(
        &mut r,
        InputEvent::TextEdit(TextEdit::End { select: false }),
    );
    let frame = r.build_frame(400.0, 300.0).unwrap();
    let caret = rect(&frame.scene, "field:caret").expect("focused caret");
    assert!((caret.rect.x + caret.rect.width * 0.5 - caret_x(5)).abs() < 0.01);
    let ime = frame.ime_cursor_area.expect("IME caret area");
    assert_eq!(ime, caret.rect);

    input(
        &mut r,
        InputEvent::TextEdit(TextEdit::Home { select: false }),
    );
    input(
        &mut r,
        InputEvent::TextEdit(TextEdit::Right { select: true }),
    );
    input(
        &mut r,
        InputEvent::TextEdit(TextEdit::Right { select: true }),
    );
    let scene = r.build_scene(400.0, 300.0).unwrap();
    let selection = rect(&scene, "field:selection").expect("selection highlight");
    assert!((selection.rect.x - caret_x(0)).abs() < 0.01);
    assert!((selection.rect.width - 2.0 * 9.6).abs() < 0.01);

    input(
        &mut r,
        InputEvent::TextEdit(TextEdit::CompositionUpdate(Composition {
            text: "にほん".into(),
            selection: Some((0, 2)),
        })),
    );
    let scene = r.build_scene(400.0, 300.0).unwrap();
    assert!(rect(&scene, "field:selection").is_none());
    let preedit = rect(&scene, "field:preedit").expect("preedit underline");
    assert!((preedit.rect.width - 3.0 * 9.6).abs() < 0.01);
    let focused_segment = rect(&scene, "field:preedit-selection").expect("composition target");
    assert!((focused_segment.rect.width - 2.0 * 9.6).abs() < 0.01);
    assert_eq!(r.state_value("name").unwrap(), "にほん hi");
}

#[test]
fn composition_survives_frames_and_unrelated_reconciliation() {
    let mut r = Runtime::from_json(WIDE_FIELD).unwrap();
    r.focus_action("field");
    input(
        &mut r,
        InputEvent::TextEdit(TextEdit::CompositionUpdate(Composition {
            text: "하".into(),
            selection: None,
        })),
    );
    for _ in 0..5 {
        r.step(1.0 / 60.0);
        r.build_frame(400.0, 300.0).unwrap();
        r.build_accessibility_tree(400.0, 300.0).unwrap();
        r.build_frame(320.0, 200.0).unwrap();
    }
    // An unrelated state transaction reconciles the tree but must not reset preedit.
    r.activate_action("button");
    let editor = r.focused_text_editor().expect("editor survives");
    assert_eq!(editor.composition().unwrap().text, "하");
    assert!(r.take_ime_requests().is_empty());
}

#[test]
fn pointer_maps_to_shaped_positions_drag_selects_and_shift_extends() {
    let mut r = Runtime::from_json(WIDE_FIELD).unwrap();
    // Click between 국 and the space (boundary 2), slightly right of the stop.
    press_at(&mut r, caret_x(2) + 2.0, 20.0);
    release(&mut r);
    assert_eq!(r.focused_action(), Some("field"));
    assert_eq!(r.focused_text_editor().unwrap().cursor(), 2);

    // Drag from boundary 1 to boundary 4 creates and updates a selection.
    press_at(&mut r, caret_x(1), 20.0);
    input(
        &mut r,
        InputEvent::PointerMoved {
            pointer: PointerId::MOUSE,
            position: InputPoint::new(caret_x(4) - 1.0, 22.0),
        },
    );
    release(&mut r);
    assert_eq!(r.focused_text_editor().unwrap().selected_text(), "국 h");

    // Shift-click extends from the anchor.
    input(
        &mut r,
        InputEvent::ModifiersChanged(Modifiers {
            shift: true,
            ..Default::default()
        }),
    );
    press_at(&mut r, caret_x(5) + 30.0, 20.0);
    release(&mut r);
    assert_eq!(r.focused_text_editor().unwrap().selected_text(), "국 hi");
    assert_eq!(r.state_value("name").unwrap(), "한국 hi");
}

#[test]
fn click_relocation_commits_preedit_then_moves_caret() {
    let mut r = Runtime::from_json(WIDE_FIELD).unwrap();
    r.focus_action("field");
    input(
        &mut r,
        InputEvent::TextEdit(TextEdit::Home { select: false }),
    );
    input(
        &mut r,
        InputEvent::TextEdit(TextEdit::CompositionUpdate(Composition {
            text: "가".into(),
            selection: None,
        })),
    );
    // Presentation is "가한국 hi"; click after 국 (boundary 3 of presentation).
    press_at(&mut r, caret_x(3), 20.0);
    release(&mut r);
    assert_eq!(r.state_value("name").unwrap(), "가한국 hi");
    let editor = r.focused_text_editor().unwrap();
    assert!(editor.composition().is_none());
    assert_eq!(editor.cursor(), 3);
    assert_eq!(r.take_ime_requests(), vec![ImeRequest::DiscardComposition]);
    // Composition then continues at the relocated caret.
    input(
        &mut r,
        InputEvent::TextEdit(TextEdit::CompositionCommit("다".into())),
    );
    assert_eq!(r.state_value("name").unwrap(), "가한국다 hi");
}

#[test]
fn paste_failure_unavailable_content_and_composition_never_mutate() {
    let mut r = Runtime::from_json(WIDE_FIELD).unwrap();
    r.focus_action("field");
    input(
        &mut r,
        InputEvent::ModifiersChanged(Modifiers {
            control: true,
            ..Default::default()
        }),
    );
    key(&mut r, LogicalKey::Character("v".into()));
    let [ClipboardRequest::Read { request, .. }] = r.take_clipboard_requests()[..] else {
        panic!("one read request");
    };
    input(
        &mut r,
        InputEvent::ClipboardReadCompleted {
            request,
            text: None,
        },
    );
    assert_eq!(r.state_value("name").unwrap(), "한국 hi");
    // A response for an unknown request id is ignored.
    input(
        &mut r,
        InputEvent::ClipboardReadCompleted {
            request: request + 40,
            text: Some("x".into()),
        },
    );
    assert_eq!(r.state_value("name").unwrap(), "한국 hi");
    // A newer request supersedes an older one.
    key(&mut r, LogicalKey::Character("v".into()));
    key(&mut r, LogicalKey::Character("v".into()));
    let requests = r.take_clipboard_requests();
    let ids = requests
        .iter()
        .map(|item| match item {
            ClipboardRequest::Read { request, .. } => *request,
            _ => panic!("read"),
        })
        .collect::<Vec<_>>();
    input(
        &mut r,
        InputEvent::ClipboardReadCompleted {
            request: ids[0],
            text: Some("old".into()),
        },
    );
    assert_eq!(r.state_value("name").unwrap(), "한국 hi");
    // Composition started while the read was in flight: the paste is dropped and
    // the preedit stays uncommitted.
    input(
        &mut r,
        InputEvent::TextEdit(TextEdit::CompositionUpdate(Composition {
            text: "ㅎ".into(),
            selection: None,
        })),
    );
    input(
        &mut r,
        InputEvent::ClipboardReadCompleted {
            request: ids[1],
            text: Some("new".into()),
        },
    );
    assert_eq!(r.state_value("name").unwrap(), "한국 hiㅎ");
    assert_eq!(
        r.focused_text_editor().unwrap().composition().unwrap().text,
        "ㅎ"
    );
}

#[test]
fn platform_conventions_choose_word_and_line_granularity() {
    let mut r = runtime();
    r.set_platform_conventions(mun_runtime::PlatformConventions {
        apple_text_navigation: true,
    });
    r.focus_action("field");
    input(
        &mut r,
        InputEvent::TextEdit(TextEdit::Insert(" Lovelace".into())),
    );
    input(
        &mut r,
        InputEvent::ModifiersChanged(Modifiers {
            alt: true,
            ..Default::default()
        }),
    );
    key(&mut r, LogicalKey::ArrowLeft);
    assert_eq!(r.focused_text_editor().unwrap().cursor(), 4);
    key(&mut r, LogicalKey::Backspace);
    assert_eq!(r.state_value("name").unwrap(), "Lovelace");
    input(
        &mut r,
        InputEvent::ModifiersChanged(Modifiers {
            meta: true,
            ..Default::default()
        }),
    );
    key(&mut r, LogicalKey::ArrowRight);
    assert_eq!(r.focused_text_editor().unwrap().cursor(), 8);
    key(&mut r, LogicalKey::Character("a".into()));
    assert_eq!(r.focused_text_editor().unwrap().selected_text(), "Lovelace");
}
