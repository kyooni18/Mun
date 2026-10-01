//! Deterministic display/window lifecycle checks through the production
//! renderer: scale changes, resizes, minimize/restore while editing,
//! scrolling and animating. Logical (runtime) geometry must stay coherent and
//! only the framebuffer mapping may change.
use mun_native::OffscreenSession;
use mun_runtime::InputEvent;
use mun_runtime::text_edit::{Composition, TextEdit};

const PROGRAM: &str = r##"{"version":1,"sourceLanguage":"mun","entry":"Life","states":[{"name":"name","initial":"한국어 text"},{"name":"wide","initial":false}],
"root":{"kind":"window","id":"window","title":"Life","child":{"kind":"column","id":"stack","layout":{"alignment":"leading","padding":10,"spacing":8},"visual":{"background":"#101018"},"children":[
 {"kind":"textField","id":"field","state":"name","layout":{"width":{"kind":"literal","value":260},"height":{"kind":"literal","value":40}},"visual":{"background":"#202030"}},
 {"kind":"action","id":"grow","label":"Grow","action":{"kind":"toggle-state","state":"wide","transaction":{"animation":{"kind":"timing","duration":0.4,"curve":[0,0,1,1],"delayMs":0,"repeatCount":1,"autoreverses":false},"disablesAnimations":false,"isContinuous":false}}},
 {"kind":"panel","id":"bar","layout":{"width":{"kind":"conditional","condition":{"kind":"state","state":"wide"},"then":{"kind":"literal","value":240},"otherwise":{"kind":"literal","value":40}},"height":{"kind":"literal","value":20}},"visual":{"background":"#63C8A2"},
  "motion":[{"property":"width","propertyMask":512,"value":{"kind":"conditional","condition":{"kind":"state","state":"wide"},"then":{"kind":"literal","value":240},"otherwise":{"kind":"literal","value":40}}}]},
 {"kind":"scroll","id":"scroll","axis":"vertical","layout":{"width":{"kind":"literal","value":200},"height":{"kind":"literal","value":60}},"children":[
  {"kind":"column","id":"rows","children":[
   {"kind":"text","id":"r1","value":{"kind":"literal","value":"one"},"layout":{"height":{"kind":"literal","value":50}}},
   {"kind":"text","id":"r2","value":{"kind":"literal","value":"two"},"layout":{"height":{"kind":"literal","value":50}}},
   {"kind":"text","id":"r3","value":{"kind":"literal","value":"three"},"layout":{"height":{"kind":"literal","value":50}}}]}]}]}}}"##;

fn scene_rect(session: &OffscreenSession, id: &str, w: f32, h: f32) -> mun_runtime::Rect {
    let frame = session.runtime().build_frame(w, h).unwrap();
    frame
        .scene
        .rects
        .iter()
        .find(|item| item.id == id)
        .unwrap_or_else(|| panic!("{id}"))
        .rect
}

fn pixel(session: &OffscreenSession, rgba: &[u8], x: f32, y: f32, scale: f32) -> [u8; 4] {
    let (width, height) = session.size();
    let (px, py) = ((x * scale) as u32, (y * scale) as u32);
    assert!(
        px < width && py < height,
        "pixel ({px},{py}) outside {width}x{height}"
    );
    let index = ((py * width + px) * 4) as usize;
    [
        rgba[index],
        rgba[index + 1],
        rgba[index + 2],
        rgba[index + 3],
    ]
}

fn compose(session: &mut OffscreenSession) {
    assert!(session.runtime_mut().focus_action("field"));
    session
        .input(InputEvent::TextEdit(TextEdit::End { select: false }))
        .unwrap();
    session
        .input(InputEvent::TextEdit(TextEdit::CompositionUpdate(
            Composition {
                text: "가".into(),
                selection: None,
            },
        )))
        .unwrap();
}

#[test]
fn display_scale_changes_while_composing_keep_logical_geometry_and_rescale_pixels() {
    let (w, h) = (320.0, 220.0);
    let mut session = OffscreenSession::new(PROGRAM, w, h, 1.0).unwrap();
    compose(&mut session);
    let caret = scene_rect(&session, "field:caret", w, h);
    let ime_area = session.runtime().build_frame(w, h).unwrap().ime_cursor_area;
    for scale in [1.0, 2.0, 1.5, 1.0] {
        session.resize(w, h, scale);
        assert_eq!(
            session.size(),
            ((w * scale).round() as u32, (h * scale).round() as u32)
        );
        session.render().unwrap();
        let rgba = session.rgba().unwrap();
        assert_eq!(
            scene_rect(&session, "field:caret", w, h),
            caret,
            "logical caret at {scale}x"
        );
        assert_eq!(
            session.runtime().build_frame(w, h).unwrap().ime_cursor_area,
            ime_area
        );
        let [r, g, b, _] = pixel(
            &session,
            &rgba,
            caret.x + caret.width * 0.5,
            caret.y + 4.0,
            scale,
        );
        assert!(
            r > 170 && g > 170 && b > 170,
            "caret pixel at {scale}x: {r} {g} {b}"
        );
        assert!(
            session
                .runtime()
                .focused_text_editor()
                .unwrap()
                .composition()
                .is_some(),
            "composition survives display changes"
        );
    }
    assert_eq!(
        session.runtime().state_value("name").unwrap(),
        "한국어 text가"
    );
}

#[test]
fn minimize_and_restore_while_editing_scrolled_and_animating() {
    let (w, h) = (320.0, 220.0);
    let mut session = OffscreenSession::new(PROGRAM, w, h, 2.0).unwrap();
    compose(&mut session);
    // Scroll the nested viewport to its end, start an animation, then minimize.
    session
        .input(InputEvent::PointerMoved {
            pointer: mun_runtime::input::PointerId::MOUSE,
            position: mun_runtime::input::InputPoint::new(60.0, 160.0),
        })
        .unwrap();
    session
        .input(InputEvent::Scroll {
            pointer: Some(mun_runtime::input::PointerId::MOUSE),
            delta: mun_runtime::input::ScrollDelta::Pixels { x: 0.0, y: -500.0 },
            phase: mun_runtime::input::ScrollPhase::Changed,
        })
        .unwrap();
    let scrolled = scene_rect(&session, "scroll:scrollbar-thumb", w, h);
    session.runtime_mut().activate_action("grow");
    session.runtime_mut().step(0.1);
    session.render().unwrap();
    let mid = scene_rect(&session, "bar", w, h).width;
    assert!(mid > 40.0 && mid < 240.0, "{mid}");

    // Minimized: zero-sized framebuffer requests keep the previous surface and
    // a zero logical size neither panics nor discards runtime state.
    session.resize(0.0, 0.0, 2.0);
    assert_eq!(session.size(), (640, 440));
    session.runtime().build_frame(0.0, 0.0).unwrap();
    session.runtime_mut().step(0.2);

    session.resize(w, h, 2.0);
    session.runtime_mut().step(0.2);
    session.render().unwrap();
    assert_eq!(scene_rect(&session, "bar", w, h).width, 240.0);
    assert_eq!(
        scene_rect(&session, "scroll:scrollbar-thumb", w, h),
        scrolled
    );
    assert!(
        session
            .runtime()
            .focused_text_editor()
            .unwrap()
            .composition()
            .is_some()
    );

    // Growing the window cannot leave a scroll offset beyond the new maximum.
    session.resize(w, 600.0, 2.0);
    session.render().unwrap();
    let thumb = scene_rect(&session, "scroll:scrollbar-thumb", w, 600.0);
    let track = scene_rect(&session, "scroll:scrollbar-track", w, 600.0);
    assert!(thumb.y + thumb.height <= track.y + track.height + 0.01);
}

#[test]
fn zero_sized_initial_window_defers_rendering_without_panicking() {
    let mut session = OffscreenSession::new(PROGRAM, 0.0, 0.0, 2.0).unwrap();
    session.resize(320.0, 220.0, 2.0);
    session.render().unwrap();
    let rgba = session.rgba().unwrap();
    let [r, g, b, _] = pixel(&session, &rgba, 4.0, 210.0, 2.0);
    assert!(
        r.abs_diff(0x10) <= 2 && g.abs_diff(0x10) <= 2 && b.abs_diff(0x18) <= 2,
        "{r} {g} {b}"
    );
}
