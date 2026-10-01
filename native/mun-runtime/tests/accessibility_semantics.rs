//! Assistive-technology semantics derived from runtime state: radio options,
//! editable text (grapheme characters, selection, edit actions) and scrolling.
use mun_runtime::accessibility::AccessibilityAction as A;
use mun_runtime::ir::AccessibilityRole;
use mun_runtime::text_edit::{Composition, TextEdit};
use mun_runtime::{AccessibilityNode, InputEvent, Runtime};

const PROGRAM: &str = r##"{"version":1,"sourceLanguage":"mun","entry":"A11y","states":[
 {"name":"choice","initial":"work"},{"name":"name","initial":"한é👍🏽 ok"}],
 "root":{"kind":"window","id":"window","title":"A11y","child":{"kind":"column","id":"stack","children":[
  {"kind":"textField","id":"field","state":"name","placeholder":"Name","layout":{"width":{"kind":"literal","value":260},"height":{"kind":"literal","value":40}}},
  {"kind":"radioGroup","id":"choices","state":"choice","options":[
    {"label":"Work","value":"work"},{"label":"Personal","value":"personal"},{"label":"Off","value":"none","disabled":true}]},
  {"kind":"scroll","id":"scroll","axis":"vertical","layout":{"height":{"kind":"literal","value":100}},"children":[
    {"kind":"column","id":"content","children":[
      {"kind":"text","id":"top","value":{"kind":"literal","value":"Top"},"layout":{"height":{"kind":"literal","value":300}}},
      {"kind":"action","id":"deep","label":"Deep","action":{"kind":"toggle-state","state":"flag"}}]}]}]}}}"##;

fn runtime() -> Runtime {
    Runtime::from_json(&PROGRAM.replace(
        r#"{"kind":"toggle-state","state":"flag"}"#,
        r#"{"kind":"set-state","state":"choice","value":{"kind":"literal","value":"work"}}"#,
    ))
    .unwrap()
}

fn node(runtime: &Runtime, id: &str) -> AccessibilityNode {
    let tree = runtime.build_accessibility_tree(400.0, 400.0).unwrap();
    tree.node(id).cloned().unwrap_or_else(|| panic!("{id}"))
}

#[test]
fn radio_options_are_checkable_children_that_select_through_the_group() {
    let mut r = runtime();
    let group = node(&r, "choices");
    assert_eq!(
        group.children,
        ["choices:option:0", "choices:option:1", "choices:option:2"]
    );
    let work = node(&r, "choices:option:0");
    assert_eq!(work.role, AccessibilityRole::RadioButton);
    assert_eq!(
        (work.label.as_deref(), work.checked),
        (Some("Work"), Some(true))
    );
    let off = node(&r, "choices:option:2");
    assert!(!off.enabled && off.action_id.is_none());

    let outcome = r.handle_accessibility_action("choices:option:1", A::Activate);
    assert!(outcome.activated);
    assert_eq!(r.state_value("choice").unwrap(), "personal");
    assert_eq!(node(&r, "choices:option:1").checked, Some(true));
    assert_eq!(node(&r, "choices:option:0").checked, Some(false));
    assert_eq!(
        r.focused_action(),
        Some("choices"),
        "focus lands on the group"
    );

    assert!(
        !r.handle_accessibility_action("choices:option:2", A::Activate)
            .activated
    );
    assert_eq!(r.state_value("choice").unwrap(), "personal");
}

#[test]
fn text_field_exposes_grapheme_characters_and_selection_and_edits_through_the_editor() {
    let mut r = runtime();
    let text = node(&r, "field").text.unwrap();
    // 한 | e+combining acute | thumbs-up+skin tone | space | o | k
    assert_eq!(text.character_lengths, [3, 3, 8, 1, 1, 1]);
    assert_eq!(text.word_starts.first(), Some(&0));
    assert!(
        text.character_positions
            .windows(2)
            .all(|pair| pair[0] <= pair[1])
    );
    assert!(
        text.selection.is_none(),
        "selection exists only while focused"
    );

    // Select "e\u{301}👍🏽" (graphemes 1..3) and replace it with Korean text.
    assert!(
        r.handle_accessibility_action(
            "field",
            A::SetTextSelection {
                anchor: 1,
                focus: 3
            }
        )
        .handled
    );
    assert_eq!(r.focused_action(), Some("field"));
    assert_eq!(node(&r, "field").text.unwrap().selection, Some((1, 3)));
    r.handle_accessibility_action("field", A::ReplaceSelectedText("국어".into()));
    assert_eq!(r.state_value("name").unwrap(), "한국어 ok");
    assert_eq!(node(&r, "field").text.unwrap().selection, Some((3, 3)));

    r.handle_accessibility_action("field", A::SetValue("line\nbreak".into()));
    assert_eq!(
        r.state_value("name").unwrap(),
        "line break",
        "single-line sanitized"
    );
}

#[test]
fn assistive_selection_commits_an_active_composition_first() {
    let mut r = runtime();
    assert!(r.focus_action("field"));
    r.handle_input(
        InputEvent::TextEdit(TextEdit::End { select: false }),
        400.0,
        400.0,
    )
    .unwrap();
    r.handle_input(
        InputEvent::TextEdit(TextEdit::CompositionUpdate(Composition {
            text: "가".into(),
            selection: None,
        })),
        400.0,
        400.0,
    )
    .unwrap();
    assert_eq!(
        node(&r, "field").value.as_deref(),
        Some("한e\u{301}👍🏽 ok"),
        "preedit is not the value"
    );
    r.handle_accessibility_action(
        "field",
        A::SetTextSelection {
            anchor: 0,
            focus: 0,
        },
    );
    assert_eq!(r.state_value("name").unwrap(), "한e\u{301}👍🏽 ok가");
    assert!(r.focused_text_editor().unwrap().composition().is_none());
}

#[test]
fn scroll_views_expose_offsets_and_accept_paging_and_reveal() {
    let mut r = runtime();
    let scroll = node(&r, "scroll").scroll.expect("overflowing scroll view");
    assert_eq!((scroll.offset, scroll.horizontal), (0.0, false));
    assert!(scroll.max > 200.0);
    assert!(node(&r, "content").scroll.is_none());

    assert!(
        r.handle_accessibility_action("scroll", A::ScrollByPages(1.0))
            .handled
    );
    let paged = node(&r, "scroll").scroll.unwrap().offset;
    assert!(paged > 0.0);
    r.handle_accessibility_action("scroll", A::SetScrollOffset(0.0));
    assert_eq!(node(&r, "scroll").scroll.unwrap().offset, 0.0);

    assert!(
        r.handle_accessibility_action("deep", A::ScrollIntoView)
            .handled
    );
    let deep = node(&r, "deep");
    let viewport = node(&r, "scroll").bounds;
    assert!(
        deep.bounds.height > 0.0
            && deep.bounds.y + deep.bounds.height <= viewport.y + viewport.height + 0.5
    );
    assert_eq!(r.focused_action(), None, "reveal does not move focus");
}
