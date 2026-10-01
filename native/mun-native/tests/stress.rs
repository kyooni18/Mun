#![recursion_limit = "512"]
//! Retained-runtime stress: thousands of keyed rows with per-row state,
//! conditional churn, large text, frequent text-field edits, scrolling,
//! resizing, animation retargeting and keyed reorder/insert/remove.
//!
//! `bounded_resources_under_churn` runs in the normal suite and asserts that
//! nothing grows without bound. The measurement report runs explicitly:
//!
//!   cargo test --release --manifest-path native/Cargo.toml -p mun-native \
//!     --test stress -- --ignored --nocapture
//!
//! (`MUN_STRESS_ROWS=1000,3000` selects the collection sizes.)
use std::time::Instant;

use mun_native::{FrameTiming, OffscreenSession};
use mun_runtime::InputEvent;
use mun_runtime::input::{PointerId, ScrollDelta, ScrollPhase};
use mun_runtime::text_edit::TextEdit;
use serde_json::{Value, json};

const FOR_EACH: &str = "list";
const NOTE: &str = "@row/note";

fn literal(value: impl Into<Value>) -> Value {
    json!({"kind": "literal", "value": value.into()})
}

fn item(path: &str) -> Value {
    json!({"kind": "item", "forEach": FOR_EACH, "path": [path]})
}

fn program(rows: usize, large_text: usize) -> String {
    let items: Vec<Value> = (0..rows)
        .map(|i| json!({"id": format!("r{i}"), "title": format!("Row {i} 한국어 ✓"), "pinned": i % 3 == 0}))
        .collect();
    let row_action = |id: &str, operation: Value| {
        let mut action = json!({"kind": "collection", "state": "rows", "keyPath": ["id"]});
        action
            .as_object_mut()
            .unwrap()
            .extend(operation.as_object().unwrap().clone());
        json!({"kind": "action", "id": id, "label": id, "action": action,
               "layout": {"width": literal(40), "height": literal(24)}})
    };
    let width = json!({"kind": "conditional", "condition": {"kind": "state", "state": "wide"},
                       "then": literal(300), "otherwise": literal(60)});
    json!({
        "version": 1, "sourceLanguage": "mun", "entry": "Stress",
        "states": [
            {"name": "rows", "initial": items},
            {"name": "next", "initial": 0},
            {"name": "wide", "initial": false},
            {"name": "draft", "initial": ""},
            {"name": NOTE, "initial": "", "scope": FOR_EACH}
        ],
        "root": {"kind": "window", "id": "window", "title": "Stress", "child": {
            "kind": "column", "id": "stack", "layout": {"spacing": 4, "alignment": "leading"}, "children": [
                {"kind": "textField", "id": "draft", "state": "draft",
                 "layout": {"width": literal(400), "height": literal(32)}},
                {"kind": "action", "id": "grow", "label": "Grow", "action": {"kind": "toggle-state", "state": "wide",
                    "transaction": {"animation": {"kind": "timing", "duration": 0.3, "curve": [0, 0, 1, 1],
                        "delayMs": 0, "repeatCount": 1, "autoreverses": false},
                        "disablesAnimations": false, "isContinuous": false}}},
                {"kind": "action", "id": "prepend", "label": "Prepend", "action": {"kind": "sequence", "actions": [
                    {"kind": "collection", "state": "rows", "keyPath": ["id"], "operation": "insert", "index": literal(0),
                     "value": {"kind": "record", "fields": {
                        "id": {"kind": "binary", "operator": "add", "left": literal("n"),
                               "right": {"kind": "stringify", "value": {"kind": "state", "state": "next"}}},
                        "title": literal("Inserted"), "pinned": literal(false)}}},
                    {"kind": "set-state", "state": "next", "value": {"kind": "binary", "operator": "add",
                        "left": {"kind": "state", "state": "next"}, "right": literal(1)}}
                ]}},
                {"kind": "panel", "id": "bar", "layout": {"width": width.clone(), "height": literal(8)},
                 "visual": {"background": "#63C8A2"},
                 "motion": [{"property": "width", "propertyMask": 512, "value": width}]},
                {"kind": "text", "id": "large", "value": literal("Lorem ipsum 한국어 日本語 ".repeat(large_text / 24 + 1)),
                 "layout": {"width": literal(700), "height": literal(20)}},
                {"kind": "scroll", "id": "scroll", "axis": "vertical",
                 "layout": {"width": literal(780), "height": literal(420)}, "children": [
                    {"kind": "column", "id": "rows-column", "layout": {"spacing": 2}, "children": [
                        {"kind": "forEach", "id": FOR_EACH, "collection": {"kind": "state", "state": "rows"},
                         "keyPath": ["id"], "children": [
                            {"kind": "row", "id": "row", "layout": {"spacing": 6}, "children": [
                                {"kind": "text", "id": "title", "value": item("title"),
                                 "layout": {"width": literal(200)}},
                                {"kind": "textField", "id": "note", "state": NOTE,
                                 "layout": {"width": literal(160), "height": literal(24)}},
                                {"kind": "conditional", "id": "pin", "condition": item("pinned"),
                                 "then": [{"kind": "text", "id": "pinned", "value": literal("pinned")}],
                                 "otherwise": []},
                                row_action("toggle", json!({"operation": "update", "key": item("id"),
                                    "path": ["pinned"], "value": {"kind": "not", "value": item("pinned")}})),
                                row_action("up", json!({"operation": "move", "key": item("id"), "offset": literal(-1)})),
                                row_action("remove", json!({"operation": "remove", "key": item("id")}))
                            ]}
                        ]}
                    ]}
                ]}
            ]
        }}
    })
    .to_string()
}

fn key(id: &str, row: &str) -> String {
    format!("{id}[s:{row}]")
}

#[derive(Default)]
struct Phase {
    name: &'static str,
    frames: u32,
    build_micros: Vec<u128>,
    render_micros: Vec<u128>,
    input_micros: Vec<u128>,
}

impl Phase {
    fn frame(&mut self, timing: FrameTiming) {
        self.frames += 1;
        self.build_micros.push(timing.build_micros);
        self.render_micros.push(timing.render_micros);
    }
    fn report(&mut self, session: &OffscreenSession) {
        fn p(values: &mut [u128], q: f64) -> u128 {
            if values.is_empty() {
                return 0;
            }
            values.sort_unstable();
            values[((values.len() - 1) as f64 * q).round() as usize]
        }
        let stats = session.renderer_stats();
        let runtime = session.runtime();
        println!(
            "{:<22} frames {:>4} | build p50 {:>6}µs p95 {:>6}µs | render p50 {:>6}µs p95 {:>6}µs | input p50 {:>6}µs | retained {:>6} | scoped {:>5} | text buffers {:>5} | shaped {:>6} cached {:>5} | reshapes {:>6} | rect bytes {:>8}",
            self.name,
            self.frames,
            p(&mut self.build_micros, 0.5),
            p(&mut self.build_micros, 0.95),
            p(&mut self.render_micros, 0.5),
            p(&mut self.render_micros, 0.95),
            p(&mut self.input_micros, 0.5),
            runtime.retained_tree().len(),
            runtime.scoped_state_count(),
            stats.text_buffers,
            session.shaped_line_count(),
            session.cached_line_count(),
            stats.text_reshapes,
            stats.rect_vertex_capacity_bytes,
        );
    }
}

fn timed(phase: &mut Phase, session: &mut OffscreenSession, f: impl FnOnce(&mut OffscreenSession)) {
    let start = Instant::now();
    f(session);
    phase.input_micros.push(start.elapsed().as_micros());
    let timing = session.render().unwrap();
    phase.frame(timing);
}

fn scroll(session: &mut OffscreenSession, dy: f32) {
    session
        .input(InputEvent::PointerMoved {
            pointer: PointerId::MOUSE,
            position: mun_runtime::input::InputPoint::new(300.0, 400.0),
        })
        .unwrap();
    session
        .input(InputEvent::Scroll {
            pointer: Some(PointerId::MOUSE),
            delta: ScrollDelta::Pixels { x: 0.0, y: dy },
            phase: ScrollPhase::Changed,
        })
        .unwrap();
}

/// Run every workload once; returns the session for inspection.
fn workload(rows: usize, cycles: usize, report: bool) -> OffscreenSession {
    let mut session = OffscreenSession::new(&program(rows, 20_000), 800.0, 600.0, 2.0).unwrap();
    let mut phase = Phase {
        name: "initial",
        ..Default::default()
    };
    timed(&mut phase, &mut session, |_| {});
    if report {
        phase.report(&session);
    }

    let mut phase = Phase {
        name: "steady",
        ..Default::default()
    };
    for _ in 0..cycles {
        timed(&mut phase, &mut session, |_| {});
    }
    if report {
        phase.report(&session);
    }

    let mut phase = Phase {
        name: "typing",
        ..Default::default()
    };
    assert!(session.runtime_mut().focus_action("draft"));
    for i in 0..cycles {
        timed(&mut phase, &mut session, |s| {
            s.input(InputEvent::TextEdit(TextEdit::Insert(if i % 2 == 0 {
                "가".into()
            } else {
                "a".into()
            })))
            .unwrap();
        });
    }
    if report {
        phase.report(&session);
    }

    let mut phase = Phase {
        name: "row notes",
        ..Default::default()
    };
    for i in 0..cycles.min(rows) {
        timed(&mut phase, &mut session, |s| {
            assert!(s.runtime_mut().focus_action(&key("note", &format!("r{i}"))));
            s.input(InputEvent::TextEdit(TextEdit::Insert(format!("note {i}"))))
                .unwrap();
        });
    }
    if report {
        phase.report(&session);
    }

    let mut phase = Phase {
        name: "scrolling",
        ..Default::default()
    };
    for i in 0..cycles {
        timed(&mut phase, &mut session, |s| {
            scroll(s, if i < cycles / 2 { -120.0 } else { 120.0 })
        });
    }
    if report {
        phase.report(&session);
    }

    let mut phase = Phase {
        name: "conditional churn",
        ..Default::default()
    };
    for i in 0..cycles {
        let row = format!("r{}", (i * 7) % rows);
        timed(&mut phase, &mut session, |s| {
            s.runtime_mut().activate_action(&key("toggle", &row));
        });
    }
    if report {
        phase.report(&session);
    }

    let mut phase = Phase {
        name: "keyed insert/move/rm",
        ..Default::default()
    };
    for i in 0..cycles {
        timed(&mut phase, &mut session, |s| {
            s.runtime_mut().activate_action("prepend");
            s.runtime_mut()
                .activate_action(&key("up", &format!("r{}", (i * 13 + 5) % rows)));
            s.runtime_mut()
                .activate_action(&key("remove", &format!("n{i}")));
        });
    }
    if report {
        phase.report(&session);
    }

    let mut phase = Phase {
        name: "animation retarget",
        ..Default::default()
    };
    for _ in 0..cycles {
        timed(&mut phase, &mut session, |s| {
            s.runtime_mut().activate_action("grow");
            s.runtime_mut().step(1.0 / 60.0);
        });
    }
    if report {
        phase.report(&session);
    }

    let mut phase = Phase {
        name: "resizing",
        ..Default::default()
    };
    for i in 0..cycles {
        let width = 700.0 + (i % 10) as f32 * 20.0;
        timed(&mut phase, &mut session, |s| {
            s.resize(width, 600.0, if i % 4 == 0 { 1.0 } else { 2.0 })
        });
    }
    session.resize(800.0, 600.0, 2.0);
    if report {
        phase.report(&session);
    }
    session
}

#[test]
fn bounded_resources_under_churn() {
    let rows = 300;
    let mut session = workload(rows, 40, false);
    let runtime = session.runtime();
    // One live scoped note per live key; removed keys released their state.
    assert_eq!(runtime.scoped_state_count(), rows);
    assert_eq!(
        runtime
            .state_value("rows")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(rows)
    );
    // Text buffers track live text identities, not history.
    let frame = runtime.build_frame(800.0, 600.0).unwrap();
    let texts = frame.scene.texts.len();
    session.render().unwrap();
    let stats = session.renderer_stats();
    assert!(
        stats.text_buffers <= texts,
        "{} buffers for {texts} texts",
        stats.text_buffers
    );
    // The shaping cache tracks the live text set, not history.
    assert!(
        session.cached_line_count() <= 2 * (texts + 64),
        "{} cached lines",
        session.cached_line_count()
    );
    // Steady frames neither reshape nor rebuild retained structure.
    let reshapes = stats.text_reshapes;
    for _ in 0..5 {
        session.render().unwrap();
    }
    assert_eq!(session.renderer_stats().text_reshapes, reshapes);
    assert!(session.runtime().last_reconciliation().is_empty());
    // Window resizes and scale changes reshape nothing.
    for (width, scale) in [(700.0, 2.0), (900.0, 1.0), (800.0, 2.0)] {
        session.resize(width, 600.0, scale);
        session.render().unwrap();
    }
    assert_eq!(session.renderer_stats().text_reshapes, reshapes);
    // Steady frames hit the shaping cache: no measurement reshaping either.
    let shaped = session.shaped_line_count();
    session.render().unwrap();
    session.render().unwrap();
    assert_eq!(session.shaped_line_count(), shaped);
}

#[test]
#[ignore = "measurement report; run with --release --ignored --nocapture"]
fn stress_measurement_report() {
    let rows: Vec<usize> = std::env::var("MUN_STRESS_ROWS")
        .ok()
        .map(|value| {
            value
                .split(',')
                .filter_map(|rows| rows.trim().parse().ok())
                .collect()
        })
        .unwrap_or_else(|| vec![1000, 3000]);
    for rows in rows {
        println!("--- {rows} keyed rows ---");
        workload(rows, 120, true);
    }
}
