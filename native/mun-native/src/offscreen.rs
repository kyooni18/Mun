//! Headless realization through the production renderer.
//!
//! An `OffscreenSession` drives the same `Runtime` semantics and the same
//! wgpu/glyphon realization as a window, but targets a texture. It exists for
//! pixel-level verification (caret, selection, preedit, scrollbars, clipping)
//! and for deterministic resource/timing measurement. It does not bypass or
//! re-implement any runtime semantics: steps are ordinary semantic input events.
use std::{rc::Rc, time::Instant};

use glyphon::FontSystem;
use mun_runtime::{
    ButtonState, InputEvent, InputPoint, KeyState, LogicalKey, Modifiers, PhysicalKey,
    PlatformConventions, PointerButton, PointerId, Runtime, ScrollDelta, ScrollPhase,
    text_edit::{Composition, TextEdit},
};
use serde_json::Value;

use crate::{
    FrameStatus, GpuError, GpuRenderer, NativeBackendError, RendererStats, text::TextShaping,
};

pub struct OffscreenSession {
    runtime: Runtime,
    renderer: GpuRenderer,
    shaping: Rc<TextShaping>,
    logical_width: f32,
    logical_height: f32,
    scale_factor: f32,
    modifiers: Modifiers,
}

/// Measured cost of one representative frame.
#[derive(Clone, Copy, Debug, Default)]
pub struct FrameTiming {
    pub build_micros: u128,
    pub render_micros: u128,
}

impl OffscreenSession {
    pub fn new(
        program: &str,
        logical_width: f32,
        logical_height: f32,
        scale_factor: f32,
    ) -> Result<Self, NativeBackendError> {
        let mut runtime = Runtime::from_json(program)?;
        let shaping = Rc::new(TextShaping::new(FontSystem::new()));
        runtime.set_intrinsic_measurer(shaping.clone());
        runtime.set_platform_conventions(PlatformConventions::native());
        let renderer = pollster::block_on(GpuRenderer::new_offscreen(
            (logical_width * scale_factor).round() as u32,
            (logical_height * scale_factor).round() as u32,
            shaping.clone(),
        ))
        .map_err(NativeBackendError::Gpu)?;
        Ok(Self {
            runtime,
            renderer,
            shaping,
            logical_width,
            logical_height,
            scale_factor,
            modifiers: Modifiers::default(),
        })
    }

    pub fn runtime(&self) -> &Runtime {
        &self.runtime
    }

    pub fn runtime_mut(&mut self) -> &mut Runtime {
        &mut self.runtime
    }

    pub fn renderer_stats(&self) -> RendererStats {
        self.renderer.stats()
    }

    pub fn shaped_line_count(&self) -> u64 {
        self.shaping.shaped_line_count()
    }

    pub fn cached_line_count(&self) -> usize {
        self.shaping.cached_line_count()
    }

    pub fn size(&self) -> (u32, u32) {
        (self.renderer.config.width, self.renderer.config.height)
    }

    /// Resize in logical points and/or change the device scale factor, as a
    /// window moving between displays would.
    pub fn resize(&mut self, logical_width: f32, logical_height: f32, scale_factor: f32) {
        self.logical_width = logical_width;
        self.logical_height = logical_height;
        self.scale_factor = scale_factor;
        self.renderer.resize(
            (logical_width * scale_factor).round() as u32,
            (logical_height * scale_factor).round() as u32,
        );
    }

    pub fn input(&mut self, event: InputEvent) -> Result<(), GpuError> {
        if let InputEvent::ModifiersChanged(modifiers) = &event {
            self.modifiers = *modifiers;
        }
        self.runtime
            .handle_input(event, self.logical_width, self.logical_height)
            .map_err(|error| GpuError::new("layout", error))?;
        // Clipboard requests are acknowledged as unavailable in headless runs so
        // the runtime never waits on a host that cannot answer.
        for request in self.runtime.take_clipboard_requests() {
            let response = match request {
                mun_runtime::input::ClipboardRequest::Write(_) => None,
                mun_runtime::input::ClipboardRequest::Cut { request, .. } => {
                    Some(InputEvent::ClipboardWriteCompleted {
                        request,
                        success: false,
                    })
                }
                mun_runtime::input::ClipboardRequest::Read { request, .. } => {
                    Some(InputEvent::ClipboardReadCompleted {
                        request,
                        text: None,
                    })
                }
            };
            if let Some(response) = response {
                self.runtime
                    .handle_input(response, self.logical_width, self.logical_height)
                    .map_err(|error| GpuError::new("layout", error))?;
            }
        }
        self.runtime.take_ime_requests();
        Ok(())
    }

    pub fn render(&mut self) -> Result<FrameTiming, GpuError> {
        let start = Instant::now();
        let frame = self
            .runtime
            .build_frame(self.logical_width, self.logical_height)
            .map_err(|error| GpuError::new("layout", error))?;
        let built = Instant::now();
        let status = self.renderer.render(&frame.scene, self.scale_factor);
        self.shaping.end_frame();
        let done = Instant::now();
        if status != FrameStatus::Presented {
            return Err(GpuError::new(
                "surface",
                format!("offscreen frame {status:?}"),
            ));
        }
        if let Some(reason) = self.renderer.device_lost() {
            return Err(GpuError::new("device", reason));
        }
        Ok(FrameTiming {
            build_micros: (built - start).as_micros(),
            render_micros: (done - built).as_micros(),
        })
    }

    pub fn rgba(&self) -> Option<Vec<u8>> {
        self.renderer.read_offscreen_rgba()
    }

    /// Apply one scripted semantic step (see `apply_script`).
    pub fn apply_step(&mut self, step: &Value) -> Result<(), String> {
        let text = |key: &str| step.get(key).and_then(Value::as_str).map(str::to_owned);
        let number = |value: &Value| value.as_f64().map(|value| value as f32);
        let point = |key: &str| {
            let array = step.get(key)?.as_array()?;
            Some(InputPoint::new(
                number(array.first()?)?,
                number(array.get(1)?)?,
            ))
        };
        let gpu = |error: GpuError| error.to_string();
        if let Some(id) = text("focus") {
            if !self.runtime.focus_action(&id) {
                return Err(format!("cannot focus '{id}'"));
            }
            self.runtime.take_ime_requests();
        } else if let Some(id) = text("activate") {
            self.runtime.activate_action(&id);
        } else if let Some(value) = text("type") {
            self.input(InputEvent::TextInput { text: value })
                .map_err(gpu)?;
        } else if let Some(value) = text("preedit") {
            let selection = step
                .get("selection")
                .and_then(Value::as_array)
                .and_then(|range| {
                    Some((
                        range.first()?.as_u64()? as usize,
                        range.get(1)?.as_u64()? as usize,
                    ))
                });
            self.input(InputEvent::TextEdit(TextEdit::CompositionUpdate(
                Composition {
                    text: value,
                    selection,
                },
            )))
            .map_err(gpu)?;
        } else if let Some(value) = text("commit") {
            self.input(InputEvent::TextEdit(TextEdit::CompositionCommit(value)))
                .map_err(gpu)?;
        } else if let Some(name) = text("key") {
            let logical = match name.as_str() {
                "Tab" => LogicalKey::Tab,
                "Enter" => LogicalKey::Enter,
                "Space" => LogicalKey::Space,
                "Escape" => LogicalKey::Escape,
                "ArrowUp" => LogicalKey::ArrowUp,
                "ArrowDown" => LogicalKey::ArrowDown,
                "ArrowLeft" => LogicalKey::ArrowLeft,
                "ArrowRight" => LogicalKey::ArrowRight,
                "Home" => LogicalKey::Home,
                "End" => LogicalKey::End,
                "PageUp" => LogicalKey::PageUp,
                "PageDown" => LogicalKey::PageDown,
                "Backspace" => LogicalKey::Backspace,
                "Delete" => LogicalKey::Delete,
                other => LogicalKey::Character(other.to_owned()),
            };
            let flag = |key: &str| step.get(key).and_then(Value::as_bool).unwrap_or(false);
            let modifiers = Modifiers {
                shift: flag("shift"),
                control: flag("control"),
                alt: flag("alt"),
                meta: flag("meta"),
            };
            if modifiers != self.modifiers {
                self.input(InputEvent::ModifiersChanged(modifiers))
                    .map_err(gpu)?;
            }
            for state in [KeyState::Pressed, KeyState::Released] {
                self.input(InputEvent::Key {
                    logical: logical.clone(),
                    physical: PhysicalKey::Other,
                    state,
                    repeat: false,
                })
                .map_err(gpu)?;
            }
        } else if let Some(position) = point("press") {
            self.input(InputEvent::PointerMoved {
                pointer: PointerId::MOUSE,
                position,
            })
            .map_err(gpu)?;
            self.input(InputEvent::PointerButton {
                pointer: PointerId::MOUSE,
                button: PointerButton::Primary,
                state: ButtonState::Pressed,
            })
            .map_err(gpu)?;
        } else if let Some(position) = point("move") {
            self.input(InputEvent::PointerMoved {
                pointer: PointerId::MOUSE,
                position,
            })
            .map_err(gpu)?;
        } else if step.get("release").is_some() {
            self.input(InputEvent::PointerButton {
                pointer: PointerId::MOUSE,
                button: PointerButton::Primary,
                state: ButtonState::Released,
            })
            .map_err(gpu)?;
        } else if let Some(delta) = point("scroll") {
            self.input(InputEvent::Scroll {
                pointer: Some(PointerId::MOUSE),
                delta: ScrollDelta::Pixels {
                    x: delta.x,
                    y: delta.y,
                },
                phase: ScrollPhase::Changed,
            })
            .map_err(gpu)?;
        } else if let Some(seconds) = step.get("step").and_then(Value::as_f64) {
            let mut remaining = seconds as f32;
            while remaining > 0.0 {
                let dt = remaining.min(1.0 / 60.0);
                self.runtime.step(dt);
                remaining -= dt;
            }
        } else if let Some(size) = step.get("resize").and_then(Value::as_array) {
            let value = |index: usize| size.get(index).and_then(number);
            self.resize(
                value(0).ok_or("resize width")?,
                value(1).ok_or("resize height")?,
                value(2).unwrap_or(self.scale_factor),
            );
        } else {
            return Err(format!("unknown offscreen step {step}"));
        }
        Ok(())
    }

    pub fn apply_script(&mut self, script: &Value) -> Result<(), String> {
        for step in script.as_array().ok_or("script must be a JSON array")? {
            self.apply_step(step)?;
        }
        Ok(())
    }
}

/// Minimal PNG encoder (RGBA8, stored deflate blocks); no image dependency.
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    0xedb8_8320 ^ (crc >> 1)
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }
    fn chunk(output: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        output.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        output.extend_from_slice(&body);
        output.extend_from_slice(&crc32(&body).to_be_bytes());
    }
    let mut raw = Vec::with_capacity((width * 4 + 1) as usize * height as usize);
    for row in rgba.chunks((width * 4) as usize) {
        raw.push(0);
        raw.extend_from_slice(row);
    }
    let mut zlib = vec![0x78, 0x01];
    let blocks = raw.chunks(65_535).collect::<Vec<_>>();
    for (index, block) in blocks.iter().enumerate() {
        zlib.push(u8::from(index + 1 == blocks.len()));
        let len = block.len() as u16;
        zlib.extend_from_slice(&len.to_le_bytes());
        zlib.extend_from_slice(&(!len).to_le_bytes());
        zlib.extend_from_slice(block);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for byte in &raw {
        a = (a + u32::from(*byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    zlib.extend_from_slice(&((b << 16) | a).to_be_bytes());

    let mut output = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut header = Vec::new();
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(&mut output, b"IHDR", &header);
    chunk(&mut output, b"IDAT", &zlib);
    chunk(&mut output, b"IEND", &[]);
    output
}
