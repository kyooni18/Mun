//! Pixel-level checks through the production wgpu/glyphon renderer.
use mun_native::OffscreenSession;
use mun_runtime::text_edit::{Composition, TextEdit};
use mun_runtime::{InputEvent, IntrinsicMeasurer};

const FIELD: &str = r##"{"version":1,"sourceLanguage":"mun","entry":"Pixels","states":[{"name":"name","initial":"한국어 text"}],"root":{"kind":"window","id":"window","title":"Pixels","child":{"kind":"column","id":"stack","layout":{"alignment":"leading","padding":10,"maxWidth":"infinity","maxHeight":"infinity"},"visual":{"background":"#101018"},"children":[{"kind":"textField","id":"field","state":"name","layout":{"width":{"kind":"literal","value":260},"height":{"kind":"literal","value":40}},"visual":{"background":"#202030"}}]}}}"##;

fn pixel(session: &OffscreenSession, rgba: &[u8], x: f32, y: f32, scale: f32) -> [u8; 4] {
    let (width, _) = session.size();
    let index = (((y * scale) as u32 * width + (x * scale) as u32) * 4) as usize;
    [
        rgba[index],
        rgba[index + 1],
        rgba[index + 2],
        rgba[index + 3],
    ]
}

fn rect(session: &OffscreenSession, id: &str) -> mun_runtime::Rect {
    let frame = session.runtime().build_frame(320.0, 120.0).unwrap();
    frame
        .scene
        .rects
        .iter()
        .find(|item| item.id == id)
        .unwrap_or_else(|| panic!("scene rect {id}"))
        .rect
}

#[test]
fn authored_srgb_colors_survive_srgb_render_targets() {
    let mut session = OffscreenSession::new(FIELD, 320.0, 120.0, 2.0).unwrap();
    session.render().unwrap();
    let rgba = session.rgba().unwrap();
    // #101018 container background, not a gamma-brightened value.
    let [r, g, b, _] = pixel(&session, &rgba, 4.0, 100.0, 2.0);
    assert!(
        r.abs_diff(0x10) <= 2 && g.abs_diff(0x10) <= 2 && b.abs_diff(0x18) <= 2,
        "{r} {g} {b}"
    );
}

/// Field origin of `FIELD`'s text: 10pt stack padding + 12pt field inset.
const TEXT_ORIGIN_X: f32 = 22.0;

fn assert_close(actual: f32, expected: f32, what: &str) {
    assert!(
        (actual - expected).abs() < 0.01,
        "{what}: {actual} != shaped {expected}"
    );
}

/// Selection, caret and preedit geometry comes from the same shaping the
/// renderer draws with, and reaches the framebuffer there. Expectations are
/// derived from the session's own shaped lines, never from assumed font
/// metrics: which face covers Hangul (and so the glyph advances) differs per
/// system, e.g. a Linux image without a CJK font shapes `.notdef` boxes.
#[test]
fn caret_selection_and_preedit_reach_the_framebuffer_at_shaped_positions() {
    let scale = 2.0;
    let mut session = OffscreenSession::new(FIELD, 320.0, 120.0, scale).unwrap();
    assert!(session.runtime_mut().focus_action("field"));
    session
        .input(InputEvent::TextEdit(TextEdit::Home { select: false }))
        .unwrap();
    for _ in 0..3 {
        session
            .input(InputEvent::TextEdit(TextEdit::Right { select: true }))
            .unwrap();
    }
    session.render().unwrap();
    let rgba = session.rgba().unwrap();
    let line = session.shaped_line("한국어 text", 16.0);
    // Real shaping, not the uniform per-grapheme headless model: proportional
    // Latin advances differ whatever face is chosen.
    assert_ne!(
        line.carets,
        mun_runtime::FallbackIntrinsicMeasurer
            .text_line("한국어 text", 16.0)
            .carets,
        "the session measures with shaped glyph advances"
    );
    let selection = rect(&session, "field:selection");
    assert_close(
        selection.x,
        TEXT_ORIGIN_X + line.x_for_offset(0),
        "selection start",
    );
    assert_close(
        selection.width,
        line.x_for_offset(3) - line.x_for_offset(0),
        "selection covers the three shaped syllables",
    );
    assert!(
        selection.width > 0.0 && selection.width < 236.0,
        "{selection:?}"
    );
    // Sample just below the glyph area inside the highlight: blue-tinted.
    let [r, g, b, _] = pixel(
        &session,
        &rgba,
        selection.x + 2.0,
        selection.y + selection.height - 1.5,
        scale,
    );
    assert!(b > r + 40 && b > g, "selection highlight pixel {r} {g} {b}");

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
    session.render().unwrap();
    let rgba = session.rgba().unwrap();
    let composed = session.shaped_line("한국어 text가", 16.0);
    let committed = "한국어 text".chars().count();
    let caret = rect(&session, "field:caret");
    assert_close(
        caret.x + caret.width * 0.5,
        TEXT_ORIGIN_X + composed.width,
        "caret after the preedit",
    );
    let [r, g, b, _] = pixel(
        &session,
        &rgba,
        caret.x + caret.width * 0.5,
        caret.y + 4.0,
        scale,
    );
    assert!(r > 180 && g > 180 && b > 180, "caret pixel {r} {g} {b}");
    let underline = rect(&session, "field:preedit");
    assert_close(
        underline.x,
        TEXT_ORIGIN_X + composed.x_for_offset(committed),
        "preedit start",
    );
    assert_close(
        underline.width,
        composed.width - composed.x_for_offset(committed),
        "preedit underline spans the composing syllable",
    );
    let [r, _, _, _] = pixel(
        &session,
        &rgba,
        underline.x + underline.width * 0.5,
        underline.y + 0.5,
        scale,
    );
    assert!(r > 150, "preedit underline pixel {r}");
    assert_eq!(
        session.runtime().state_value("name").unwrap(),
        "한국어 text가",
        "the binding shows the in-progress composition"
    );
}
