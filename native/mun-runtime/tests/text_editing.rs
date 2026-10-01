use mun_runtime::input::ClipboardRequest;
use mun_runtime::text_edit::{Composition, TextEdit};
use mun_runtime::{InputEvent, KeyState, LogicalKey, Modifiers, PhysicalKey, Runtime};
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
    assert_eq!(r.state_value("name").unwrap(), "Ada");
    assert_eq!(
        r.build_accessibility_tree(400.0, 300.0)
            .unwrap()
            .node("field")
            .unwrap()
            .value
            .as_deref(),
        Some("Ada")
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
    key(&mut r, LogicalKey::Backspace);
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
    assert!(r.focus_action("other"));
    assert!(r.focused_text_editor().is_none());
    assert_eq!(r.state_value("name").unwrap(), "한😀글");
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
            target: "field".into()
        }]
    );
    r.focus_action("other");
    input(
        &mut r,
        InputEvent::ClipboardPaste {
            target: "field".into(),
            text: "wrong".into(),
        },
    );
    assert_eq!(r.state_value("name").unwrap(), "");
    input(
        &mut r,
        InputEvent::ClipboardPaste {
            target: "other".into(),
            text: "한국".into(),
        },
    );
    assert_eq!(r.state_value("name").unwrap(), "한국");
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
