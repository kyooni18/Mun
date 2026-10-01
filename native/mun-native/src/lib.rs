mod accessibility;
pub mod offscreen;
mod text;

pub use offscreen::{FrameTiming, OffscreenSession, encode_png};

use std::{collections::HashMap, error::Error, fmt, rc::Rc, sync::Arc, time::Instant};

use accessibility::{AccessibilityHost, NativeEvent};
use accesskit::ActionRequest;
use bytemuck::{Pod, Zeroable};
use glyphon::{
    Buffer, Cache, Color as GlyphColor, FontSystem, Metrics, Resolution, Shaping, SwashCache,
    TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Wrap,
};
use mun_runtime::scene::{Rect, ScenePresentation, SceneTransform};
use mun_runtime::{
    ButtonState as MunButtonState, Color, ImeRequest, InputEvent, InputPoint,
    KeyState as MunKeyState, LogicalKey, Modifiers, PhysicalKey as MunPhysicalKey,
    PlatformConventions, PointerButton as MunPointerButton, PointerId, Runtime, RuntimeLoadError,
    Scene, ScrollDelta, ScrollPhase,
};
use text::{LINE_HEIGHT_FACTOR, TextShaping, text_attrs};
use winit::{
    application::ApplicationHandler,
    dpi::{LogicalPosition, LogicalSize, PhysicalPosition},
    event::{ElementState, Ime, MouseButton, MouseScrollDelta, TouchPhase, WindowEvent},
    event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy},
    keyboard::{Key, KeyCode, ModifiersState, NamedKey, PhysicalKey as WinitPhysicalKey},
    window::{Window, WindowId},
};

/// Failure while preparing or running Mün's desktop-native backend.
#[derive(Debug)]
pub enum NativeBackendError {
    Program(RuntimeLoadError),
    EventLoop(winit::error::EventLoopError),
    /// Native window creation failed.
    Window(winit::error::OsError),
    /// GPU initialization failed or the device was lost; names the subsystem.
    Gpu(GpuError),
}

impl fmt::Display for NativeBackendError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Program(error) => write!(formatter, "{error}"),
            Self::EventLoop(error) => write!(formatter, "{error}"),
            Self::Window(error) => write!(formatter, "Mün window creation failed: {error}"),
            Self::Gpu(error) => write!(formatter, "{error}"),
        }
    }
}

impl Error for NativeBackendError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Program(error) => Some(error),
            Self::EventLoop(error) => Some(error),
            Self::Window(error) => Some(error),
            Self::Gpu(error) => Some(error),
        }
    }
}

impl From<RuntimeLoadError> for NativeBackendError {
    fn from(error: RuntimeLoadError) -> Self {
        Self::Program(error)
    }
}

impl From<winit::error::EventLoopError> for NativeBackendError {
    fn from(error: winit::error::EventLoopError) -> Self {
        Self::EventLoop(error)
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Vertex {
    position: [f32; 2],
    color: [f32; 4],
    local_position: [f32; 2],
    rect_size: [f32; 2],
    corner_radius: f32,
}

impl Vertex {
    fn layout() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Self>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &[
                wgpu::VertexAttribute {
                    offset: 0,
                    shader_location: 0,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: std::mem::size_of::<[f32; 2]>() as wgpu::BufferAddress,
                    shader_location: 1,
                    format: wgpu::VertexFormat::Float32x4,
                },
                wgpu::VertexAttribute {
                    offset: (std::mem::size_of::<[f32; 2]>() + std::mem::size_of::<[f32; 4]>())
                        as wgpu::BufferAddress,
                    shader_location: 2,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: (std::mem::size_of::<[f32; 2]>() * 2 + std::mem::size_of::<[f32; 4]>())
                        as wgpu::BufferAddress,
                    shader_location: 3,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: (std::mem::size_of::<[f32; 2]>() * 3 + std::mem::size_of::<[f32; 4]>())
                        as wgpu::BufferAddress,
                    shader_location: 4,
                    format: wgpu::VertexFormat::Float32,
                },
            ],
        }
    }
}

const INITIAL_RECT_VERTEX_BUFFER_BYTES: u64 = 4096;

fn rect_vertex_buffer_capacity(required_bytes: u64) -> u64 {
    required_bytes
        .max(INITIAL_RECT_VERTEX_BUFFER_BYTES)
        .checked_next_power_of_two()
        .unwrap_or(required_bytes)
}

struct CachedTextBuffer {
    buffer: Buffer,
    text: String,
    font_size: f32,
    logical_width: f32,
    logical_height: f32,
}

impl CachedTextBuffer {
    fn new(
        font_system: &mut FontSystem,
        text: &str,
        font_size: f32,
        logical_width: f32,
        logical_height: f32,
    ) -> Self {
        let mut buffer = Buffer::new(
            font_system,
            Metrics::new(font_size, font_size * LINE_HEIGHT_FACTOR),
        );
        // Scene text is single-line in the runtime layout model; wrapping here
        // would desynchronize drawn glyphs from layout and caret geometry.
        buffer.set_wrap(Wrap::None);
        buffer.set_size(Some(logical_width), Some(logical_height));
        buffer.set_text(text, &text_attrs(), Shaping::Advanced, None);
        buffer.shape_until_scroll(font_system, false);
        Self {
            buffer,
            text: text.to_owned(),
            font_size,
            logical_width,
            logical_height,
        }
    }

    fn update(
        &mut self,
        font_system: &mut FontSystem,
        text: &str,
        font_size: f32,
        logical_width: f32,
        logical_height: f32,
    ) -> bool {
        let mut dirty = false;
        if self.font_size.to_bits() != font_size.to_bits() {
            self.buffer
                .set_metrics(Metrics::new(font_size, font_size * LINE_HEIGHT_FACTOR));
            self.font_size = font_size;
            dirty = true;
        }
        if self.logical_width.to_bits() != logical_width.to_bits()
            || self.logical_height.to_bits() != logical_height.to_bits()
        {
            self.buffer
                .set_size(Some(logical_width), Some(logical_height));
            self.logical_width = logical_width;
            self.logical_height = logical_height;
            dirty = true;
        }
        if self.text != text {
            self.buffer
                .set_text(text, &text_attrs(), Shaping::Advanced, None);
            self.text.clear();
            self.text.push_str(text);
            dirty = true;
        }
        if dirty {
            self.buffer.shape_until_scroll(font_system, false);
        }
        dirty
    }
}

struct TextBatchRenderer {
    viewport: Viewport,
    renderer: TextRenderer,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct TextTransformPlan {
    raster_scale: f32,
    virtual_width: u32,
    virtual_height: u32,
    viewport_x: f32,
    viewport_y: f32,
    viewport_width: f32,
    viewport_height: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ScissorRect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RectDrawBatch {
    start: u32,
    end: u32,
    scissor: ScissorRect,
}

#[derive(Clone, Copy, Debug)]
struct PreparedTextBatch {
    slot: usize,
    plan: TextTransformPlan,
    scissor: ScissorRect,
}

/// Where a frame is realized: a window surface or an offscreen texture used for
/// pixel-level verification and headless measurement.
enum RenderTarget {
    Surface(wgpu::Surface<'static>),
    Offscreen(wgpu::Texture),
}

/// GPU realization counters for resource-growth measurement.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RendererStats {
    pub text_buffers: usize,
    pub text_batch_renderers: usize,
    pub rect_vertex_capacity_bytes: u64,
    pub frames: u64,
    pub skipped_frames: u64,
    pub surface_reconfigurations: u64,
    pub text_reshapes: u64,
}

struct GpuRenderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    target: RenderTarget,
    config: wgpu::SurfaceConfiguration,
    rect_pipeline: wgpu::RenderPipeline,
    rect_vertex_buffer: wgpu::Buffer,
    rect_vertex_capacity: u64,
    shaping: Rc<TextShaping>,
    swash_cache: SwashCache,
    cache: Cache,
    atlas: TextAtlas,
    text_batches: Vec<TextBatchRenderer>,
    text_buffers: HashMap<String, CachedTextBuffer>,
    device_lost: Arc<std::sync::Mutex<Option<String>>>,
    stats: RendererStats,
    mirrored_text_reported: bool,
}

/// Outcome of one frame realization. Recoverable surface states never panic.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FrameStatus {
    Presented,
    /// Surface temporarily unavailable (occluded, timeout, zero-sized); retry later.
    Skipped,
    /// Surface was reconfigured or recreated; a redraw should follow.
    Reconfigured,
}

impl GpuRenderer {
    async fn new(
        window: Arc<Window>,
        event_loop: &ActiveEventLoop,
        shaping: Rc<TextShaping>,
    ) -> Result<Self, GpuError> {
        let size = window.inner_size();
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_with_display_handle(
            Box::new(event_loop.owned_display_handle()),
        ));
        let surface = instance
            .create_surface(window)
            .map_err(|error| GpuError::new("surface", error))?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                compatible_surface: Some(&surface),
                ..Default::default()
            })
            .await
            .map_err(|error| GpuError::new("adapter", error))?;
        let mut config = surface
            .get_default_config(&adapter, size.width.max(1), size.height.max(1))
            .ok_or_else(|| GpuError::new("surface", "adapter cannot present to this window"))?;
        config.present_mode = wgpu::PresentMode::Fifo;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .map_err(|error| GpuError::new("device", error))?;
        surface.configure(&device, &config);
        Ok(Self::with_device(
            device,
            queue,
            RenderTarget::Surface(surface),
            config,
            shaping,
        ))
    }

    /// Offscreen renderer with the same pipelines, for pixel verification.
    async fn new_offscreen(
        width: u32,
        height: u32,
        shaping: Rc<TextShaping>,
    ) -> Result<Self, GpuError> {
        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .map_err(|error| GpuError::new("adapter", error))?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .map_err(|error| GpuError::new("device", error))?;
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            width: width.max(1),
            height: height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: wgpu::CompositeAlphaMode::Opaque,
            view_formats: Vec::new(),
            color_space: Default::default(),
        };
        let texture = Self::offscreen_texture(&device, &config);
        Ok(Self::with_device(
            device,
            queue,
            RenderTarget::Offscreen(texture),
            config,
            shaping,
        ))
    }

    fn offscreen_texture(
        device: &wgpu::Device,
        config: &wgpu::SurfaceConfiguration,
    ) -> wgpu::Texture {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Mün offscreen target"),
            size: wgpu::Extent3d {
                width: config.width,
                height: config.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: config.format,
            usage: config.usage,
            view_formats: &[],
        })
    }

    fn with_device(
        device: wgpu::Device,
        queue: wgpu::Queue,
        target: RenderTarget,
        config: wgpu::SurfaceConfiguration,
        shaping: Rc<TextShaping>,
    ) -> Self {
        let device_lost = Arc::new(std::sync::Mutex::new(None));
        let lost = device_lost.clone();
        device.set_device_lost_callback(move |reason, message| {
            if let Ok(mut slot) = lost.lock() {
                *slot = Some(format!("{reason:?}: {message}"));
            }
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Mün retained-scene shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("rect.wgsl").into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Mün retained-scene pipeline layout"),
            bind_group_layouts: &[],
            immediate_size: 0,
        });
        let rect_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Mün retained-scene pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[Some(Vertex::layout())],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &[(
                        "SRGB_TARGET",
                        if config.format.is_srgb() { 1.0 } else { 0.0 },
                    )],
                    ..Default::default()
                },
                targets: &[Some(wgpu::ColorTargetState {
                    format: config.format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });

        let rect_vertex_capacity = INITIAL_RECT_VERTEX_BUFFER_BYTES;
        let rect_vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Mün retained-scene vertices"),
            size: rect_vertex_capacity,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let swash_cache = SwashCache::new();
        let cache = Cache::new(&device);
        let atlas = TextAtlas::new(&device, &queue, &cache, config.format);

        Self {
            device,
            queue,
            target,
            config,
            rect_pipeline,
            rect_vertex_buffer,
            rect_vertex_capacity,
            shaping,
            swash_cache,
            cache,
            atlas,
            text_batches: Vec::new(),
            text_buffers: HashMap::new(),
            device_lost,
            stats: RendererStats {
                rect_vertex_capacity_bytes: rect_vertex_capacity,
                ..Default::default()
            },
            mirrored_text_reported: false,
        }
    }

    /// Device loss is unrecoverable for this renderer instance; the host reports
    /// it as a structured GPU diagnostic.
    fn device_lost(&self) -> Option<String> {
        self.device_lost.lock().ok().and_then(|slot| slot.clone())
    }

    fn stats(&self) -> RendererStats {
        RendererStats {
            text_buffers: self.text_buffers.len(),
            text_batch_renderers: self.text_batches.len(),
            rect_vertex_capacity_bytes: self.rect_vertex_capacity,
            ..self.stats
        }
    }

    /// Zero-sized (minimized) surfaces keep their previous configuration; the
    /// next non-zero size reconfigures. Safe before and after initialization.
    fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        if self.config.width == width && self.config.height == height {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        match &mut self.target {
            RenderTarget::Surface(surface) => surface.configure(&self.device, &self.config),
            RenderTarget::Offscreen(texture) => {
                *texture = Self::offscreen_texture(&self.device, &self.config)
            }
        }
        self.stats.surface_reconfigurations += 1;
    }

    fn ensure_rect_vertex_capacity(&mut self, required_bytes: u64) {
        if required_bytes <= self.rect_vertex_capacity {
            return;
        }

        let next_capacity = rect_vertex_buffer_capacity(required_bytes);
        let next_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Mün retained-scene vertices"),
            size: next_capacity,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let previous = std::mem::replace(&mut self.rect_vertex_buffer, next_buffer);
        previous.destroy();
        self.rect_vertex_capacity = next_capacity;
    }

    fn ensure_text_batch(&mut self, slot: usize) {
        while self.text_batches.len() <= slot {
            let viewport = Viewport::new(&self.device, &self.cache);
            let renderer = TextRenderer::new(
                &mut self.atlas,
                &self.device,
                wgpu::MultisampleState::default(),
                None,
            );
            self.text_batches
                .push(TextBatchRenderer { viewport, renderer });
        }
    }

    fn render(&mut self, scene: &Scene, scale_factor: f32) -> FrameStatus {
        self.render_presented(scene, &scene.presentation, scale_factor)
    }

    fn render_presented(
        &mut self,
        scene: &Scene,
        presentation: &ScenePresentation,
        scale_factor: f32,
    ) -> FrameStatus {
        if !scale_factor.is_finite() || scale_factor <= 0.0 {
            self.stats.skipped_frames += 1;
            return FrameStatus::Skipped;
        }
        let surface_width = self.config.width.max(1);
        let surface_height = self.config.height.max(1);
        let physical_width = surface_width as f32;
        let physical_height = surface_height as f32;

        let (vertices, rect_batches) = scene_geometry(
            scene,
            presentation,
            surface_width,
            surface_height,
            scale_factor,
        );
        if !vertices.is_empty() {
            let bytes = bytemuck::cast_slice(&vertices);
            self.ensure_rect_vertex_capacity(bytes.len() as u64);
            self.queue.write_buffer(&self.rect_vertex_buffer, 0, bytes);
        }

        let logical_width = physical_width / scale_factor;
        let logical_height = physical_height / scale_factor;
        let shaping = self.shaping.clone();
        let mut font_system = shaping.font_system();
        // Retained buffers for primitives that left the scene are released so
        // repeated insertion/removal cannot grow shaping memory without bound.
        if self.text_buffers.len() > scene.texts.len() {
            let live = scene
                .texts
                .iter()
                .map(|text| text.id.as_str())
                .collect::<std::collections::HashSet<_>>();
            self.text_buffers.retain(|id, _| live.contains(id.as_str()));
        }
        for text in &scene.texts {
            match self.text_buffers.get_mut(&text.id) {
                Some(cached) => {
                    if cached.update(
                        &mut font_system,
                        &text.text,
                        text.font_size,
                        logical_width,
                        logical_height,
                    ) {
                        self.stats.text_reshapes += 1;
                    }
                }
                None => {
                    self.stats.text_reshapes += 1;
                    self.text_buffers.insert(
                        text.id.clone(),
                        CachedTextBuffer::new(
                            &mut font_system,
                            &text.text,
                            text.font_size,
                            logical_width,
                            logical_height,
                        ),
                    );
                }
            }
        }

        let mut groups = Vec::new();
        let mut start = 0;
        while start < scene.texts.len() {
            let text = &scene.texts[start];
            let transform = presentation.transform_for(&text.id);
            let Some(scissor) = scissor_for_clip(
                presentation.clip_for(&text.id),
                surface_width,
                surface_height,
                scale_factor,
            ) else {
                start += 1;
                continue;
            };
            let mut end = start + 1;
            while end < scene.texts.len() {
                let next = &scene.texts[end];
                if presentation.transform_for(&next.id) != transform
                    || scissor_for_clip(
                        presentation.clip_for(&next.id),
                        surface_width,
                        surface_height,
                        scale_factor,
                    ) != Some(scissor)
                {
                    break;
                }
                end += 1;
            }
            groups.push((start, end, transform, scissor));
            start = end;
        }

        let mut prepared_batches = Vec::with_capacity(groups.len());
        for (start, end, transform, scissor) in groups {
            let plan = match text_transform_plan(
                transform,
                physical_width,
                physical_height,
                scale_factor,
            ) {
                Ok(Some(plan)) => plan,
                // Collapsed (zero-scale) text has no visible extent.
                Ok(None) => continue,
                Err(reason) => {
                    // Supported-contract diagnostic: glyph rasterization here is
                    // axis-aligned and non-mirrored. Report once, never draw wrongly.
                    if !self.mirrored_text_reported {
                        eprintln!(
                            "Mün renderer: skipped text with unsupported transform ({reason}): {transform:?}"
                        );
                        self.mirrored_text_reported = true;
                    }
                    continue;
                }
            };

            let slot = prepared_batches.len();
            self.ensure_text_batch(slot);

            let device = &self.device;
            let queue = &self.queue;
            let font_system = &mut *font_system;
            let atlas = &mut self.atlas;
            let swash_cache = &mut self.swash_cache;
            let batch = &mut self.text_batches[slot];

            batch.viewport.update(
                queue,
                Resolution {
                    width: plan.virtual_width,
                    height: plan.virtual_height,
                },
            );

            let text_buffers = &self.text_buffers;
            let text_areas = scene.texts[start..end].iter().filter_map(|text| {
                let cached = text_buffers.get(&text.id)?;
                let rgba = text
                    .color
                    .0
                    .map(|value| (value.clamp(0.0, 1.0) * 255.0).round() as u8);
                Some(TextArea {
                    buffer: &cached.buffer,
                    left: text.x * plan.raster_scale,
                    top: text.y * plan.raster_scale,
                    scale: plan.raster_scale,
                    bounds: TextBounds {
                        left: 0,
                        top: 0,
                        right: plan.virtual_width.min(i32::MAX as u32) as i32,
                        bottom: plan.virtual_height.min(i32::MAX as u32) as i32,
                    },
                    default_color: GlyphColor::rgba(rgba[0], rgba[1], rgba[2], rgba[3]),
                    custom_glyphs: &[],
                })
            });

            if let Err(error) = batch.renderer.prepare(
                device,
                queue,
                font_system,
                atlas,
                &batch.viewport,
                text_areas,
                swash_cache,
            ) {
                // Atlas exhaustion is recoverable: drop this batch for the frame;
                // trimming below frees unused glyphs for the next one.
                eprintln!("Mün renderer: text preparation failed: {error}");
                continue;
            }
            prepared_batches.push(PreparedTextBatch {
                slot,
                plan,
                scissor,
            });
        }
        drop(font_system);

        let (frame, view) = match &self.target {
            RenderTarget::Surface(surface) => {
                let frame = match surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(frame) => frame,
                    wgpu::CurrentSurfaceTexture::Timeout
                    | wgpu::CurrentSurfaceTexture::Occluded => {
                        self.stats.skipped_frames += 1;
                        return FrameStatus::Skipped;
                    }
                    wgpu::CurrentSurfaceTexture::Suboptimal(_)
                    | wgpu::CurrentSurfaceTexture::Outdated
                    | wgpu::CurrentSurfaceTexture::Lost
                    | wgpu::CurrentSurfaceTexture::Validation => {
                        // Reconfigure and redraw; a persistently lost device is
                        // reported through the device-lost diagnostic instead.
                        surface.configure(&self.device, &self.config);
                        self.stats.surface_reconfigurations += 1;
                        return FrameStatus::Reconfigured;
                    }
                };
                let view = frame
                    .texture
                    .create_view(&wgpu::TextureViewDescriptor::default());
                (Some(frame), view)
            }
            RenderTarget::Offscreen(texture) => (
                None,
                texture.create_view(&wgpu::TextureViewDescriptor::default()),
            ),
        };
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Mün frame encoder"),
            });

        {
            let clear = Color::WINDOW.0;
            let srgb = self.config.format.is_srgb();
            let channel = |value: f32| -> f64 {
                let value = value as f64;
                if !srgb {
                    value
                } else if value <= 0.04045 {
                    value / 12.92
                } else {
                    ((value + 0.055) / 1.055).powf(2.4)
                }
            };
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Mün retained scene"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: channel(clear[0]),
                            g: channel(clear[1]),
                            b: channel(clear[2]),
                            a: clear[3] as f64,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });

            if !rect_batches.is_empty() {
                pass.set_pipeline(&self.rect_pipeline);
                pass.set_vertex_buffer(0, self.rect_vertex_buffer.slice(..));
                for batch in rect_batches {
                    pass.set_scissor_rect(
                        batch.scissor.x,
                        batch.scissor.y,
                        batch.scissor.width,
                        batch.scissor.height,
                    );
                    pass.draw(batch.start..batch.end, 0..1);
                }
            }

            for prepared in prepared_batches {
                let batch = &self.text_batches[prepared.slot];
                pass.set_scissor_rect(
                    prepared.scissor.x,
                    prepared.scissor.y,
                    prepared.scissor.width,
                    prepared.scissor.height,
                );
                pass.set_viewport(
                    prepared.plan.viewport_x,
                    prepared.plan.viewport_y,
                    prepared.plan.viewport_width,
                    prepared.plan.viewport_height,
                    0.0,
                    1.0,
                );
                if let Err(error) = batch
                    .renderer
                    .render(&self.atlas, &batch.viewport, &mut pass)
                {
                    eprintln!("Mün renderer: text realization failed: {error}");
                }
            }
        }

        self.queue.submit(Some(encoder.finish()));
        if let Some(frame) = frame {
            self.queue.present(frame);
        }
        self.atlas.trim();
        self.stats.frames += 1;
        FrameStatus::Presented
    }

    /// Read back the offscreen target as tightly packed RGBA8 rows.
    fn read_offscreen_rgba(&self) -> Option<Vec<u8>> {
        let RenderTarget::Offscreen(texture) = &self.target else {
            return None;
        };
        let width = self.config.width;
        let height = self.config.height;
        let padded_row = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Mün offscreen readback"),
            size: u64::from(padded_row) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Mün offscreen readback"),
            });
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_row),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit(Some(encoder.finish()));
        let slice = buffer.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        self.device.poll(wgpu::PollType::wait_indefinitely()).ok()?;
        let data = slice.get_mapped_range().ok()?;
        let mut output = Vec::with_capacity((width * height * 4) as usize);
        for row in data.chunks(padded_row as usize) {
            output.extend_from_slice(&row[..(width * 4) as usize]);
        }
        Some(output)
    }
}

/// Structured GPU diagnostic naming the failing subsystem.
#[derive(Debug)]
pub struct GpuError {
    pub subsystem: &'static str,
    pub message: String,
}

impl GpuError {
    fn new(subsystem: &'static str, error: impl fmt::Display) -> Self {
        Self {
            subsystem,
            message: error.to_string(),
        }
    }
}

impl fmt::Display for GpuError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Mün GPU {} initialization failed: {}",
            self.subsystem, self.message
        )
    }
}

impl Error for GpuError {}

fn text_transform_plan(
    transform: SceneTransform,
    physical_width: f32,
    physical_height: f32,
    device_scale: f32,
) -> Result<Option<TextTransformPlan>, &'static str> {
    if !physical_width.is_finite()
        || !physical_height.is_finite()
        || !device_scale.is_finite()
        || physical_width <= 0.0
        || physical_height <= 0.0
        || device_scale <= 0.0
        || !transform.scale_x.is_finite()
        || !transform.scale_y.is_finite()
        || !transform.translation_x.is_finite()
        || !transform.translation_y.is_finite()
        || transform.scale_x < 0.0
        || transform.scale_y < 0.0
    {
        return Err("invalid text transform");
    }

    if transform.scale_x <= f32::EPSILON || transform.scale_y <= f32::EPSILON {
        return Ok(None);
    }

    let max_axis_scale = transform.scale_x.max(transform.scale_y).max(1.0);
    let raster_scale = device_scale * max_axis_scale;
    let logical_width = physical_width / device_scale;
    let logical_height = physical_height / device_scale;
    let virtual_width = (logical_width * raster_scale)
        .ceil()
        .clamp(1.0, i32::MAX as f32) as u32;
    let virtual_height = (logical_height * raster_scale)
        .ceil()
        .clamp(1.0, i32::MAX as f32) as u32;

    Ok(Some(TextTransformPlan {
        raster_scale,
        virtual_width,
        virtual_height,
        viewport_x: transform.translation_x * device_scale,
        viewport_y: transform.translation_y * device_scale,
        viewport_width: physical_width * transform.scale_x,
        viewport_height: physical_height * transform.scale_y,
    }))
}

fn scissor_for_clip(
    clip: Option<Rect>,
    surface_width: u32,
    surface_height: u32,
    scale: f32,
) -> Option<ScissorRect> {
    if surface_width == 0 || surface_height == 0 || !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let Some(clip) = clip else {
        return Some(ScissorRect {
            x: 0,
            y: 0,
            width: surface_width,
            height: surface_height,
        });
    };
    if !clip.x.is_finite()
        || !clip.y.is_finite()
        || !clip.width.is_finite()
        || !clip.height.is_finite()
        || clip.width <= 0.0
        || clip.height <= 0.0
    {
        return None;
    }

    let max_x = surface_width as f32;
    let max_y = surface_height as f32;
    let left = (clip.x * scale).floor().clamp(0.0, max_x);
    let top = (clip.y * scale).floor().clamp(0.0, max_y);
    let right = ((clip.x + clip.width) * scale).ceil().clamp(0.0, max_x);
    let bottom = ((clip.y + clip.height) * scale).ceil().clamp(0.0, max_y);
    if right <= left || bottom <= top {
        return None;
    }

    Some(ScissorRect {
        x: left as u32,
        y: top as u32,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    })
}

fn scene_geometry(
    scene: &Scene,
    presentation: &ScenePresentation,
    surface_width: u32,
    surface_height: u32,
    scale: f32,
) -> (Vec<Vertex>, Vec<RectDrawBatch>) {
    let width = surface_width.max(1) as f32;
    let height = surface_height.max(1) as f32;
    let mut vertices = Vec::with_capacity(scene.rects.len() * 6);
    let mut batches: Vec<RectDrawBatch> = Vec::new();
    for item in &scene.rects {
        let Some(scissor) = scissor_for_clip(
            presentation.clip_for(&item.id),
            surface_width,
            surface_height,
            scale,
        ) else {
            continue;
        };
        let transform = presentation.transform_for(&item.id);
        let (left, top) = transform.transform_point(item.rect.x, item.rect.y);
        let (right, bottom) = transform.transform_point(
            item.rect.x + item.rect.width,
            item.rect.y + item.rect.height,
        );
        let x0 = left * scale / width * 2.0 - 1.0;
        let x1 = right * scale / width * 2.0 - 1.0;
        let y0 = 1.0 - top * scale / height * 2.0;
        let y1 = 1.0 - bottom * scale / height * 2.0;
        let gradient = scene.gradient_for(&item.id);
        let rect_size = [item.rect.width, item.rect.height];
        let radius = item.corner_radius.max(0.0);
        let color_at = |local_position: [f32; 2]| {
            let Some(gradient) = gradient else {
                return item.color.0;
            };
            let point = [
                if item.rect.width > 0.0 {
                    local_position[0] / item.rect.width
                } else {
                    0.0
                },
                if item.rect.height > 0.0 {
                    local_position[1] / item.rect.height
                } else {
                    0.0
                },
            ];
            let dx = gradient.end_point[0] - gradient.start_point[0];
            let dy = gradient.end_point[1] - gradient.start_point[1];
            let denominator = dx * dx + dy * dy;
            let t = if denominator <= f32::EPSILON {
                0.0
            } else {
                (((point[0] - gradient.start_point[0]) * dx
                    + (point[1] - gradient.start_point[1]) * dy)
                    / denominator)
                    .clamp(0.0, 1.0)
            };
            std::array::from_fn(|index| {
                gradient.start.0[index] + (gradient.end.0[index] - gradient.start.0[index]) * t
            })
        };
        let vertex = |position, local_position| Vertex {
            position,
            color: color_at(local_position),
            local_position,
            rect_size,
            corner_radius: radius,
        };
        let start = vertices.len() as u32;
        vertices.extend_from_slice(&[
            vertex([x0, y0], [0.0, 0.0]),
            vertex([x1, y0], [item.rect.width, 0.0]),
            vertex([x1, y1], [item.rect.width, item.rect.height]),
            vertex([x0, y0], [0.0, 0.0]),
            vertex([x1, y1], [item.rect.width, item.rect.height]),
            vertex([x0, y1], [0.0, item.rect.height]),
        ]);
        let end = vertices.len() as u32;
        if let Some(previous) = batches.last_mut() {
            if previous.scissor == scissor && previous.end == start {
                previous.end = end;
                continue;
            }
        }
        batches.push(RectDrawBatch {
            start,
            end,
            scissor,
        });
    }
    (vertices, batches)
}

#[cfg(test)]
fn scene_vertices(
    scene: &Scene,
    presentation: &ScenePresentation,
    width: f32,
    height: f32,
    scale: f32,
) -> Vec<Vertex> {
    scene_geometry(
        scene,
        presentation,
        width.max(1.0) as u32,
        height.max(1.0) as u32,
        scale,
    )
    .0
}

#[cfg(test)]
mod tests {
    use super::*;
    use mun_runtime::scene::SceneRect;

    #[test]
    fn platform_key_mapping_stays_inside_the_native_adapter() {
        assert_eq!(
            input_logical_key(&Key::Named(NamedKey::Tab)),
            LogicalKey::Tab
        );
        assert_eq!(
            input_logical_key(&Key::Character("x".into())),
            LogicalKey::Character("x".into())
        );
        assert_eq!(
            input_physical_key(WinitPhysicalKey::Code(KeyCode::Enter)),
            MunPhysicalKey::Enter
        );
    }

    #[test]
    fn touch_pointer_namespace_never_aliases_mouse_or_u64_local_ids() {
        assert_ne!(PointerId::touch(0), PointerId::MOUSE);
        assert_ne!(PointerId::touch(u64::MAX), PointerId(u64::MAX as u128));
        assert_ne!(PointerId::touch(7), PointerId(7));
    }

    #[test]
    fn touch_events_translate_to_canonical_pointer_capture_sequence() {
        let pointer = PointerId::touch(42);
        assert_eq!(
            input_touch_events(
                42,
                TouchPhase::Started,
                PhysicalPosition::new(20.0, 40.0),
                2.0,
            ),
            vec![
                InputEvent::PointerMoved {
                    pointer,
                    position: InputPoint::new(10.0, 20.0),
                },
                InputEvent::PointerButton {
                    pointer,
                    button: MunPointerButton::Primary,
                    state: MunButtonState::Pressed,
                },
            ]
        );

        assert_eq!(
            input_touch_events(
                42,
                TouchPhase::Ended,
                PhysicalPosition::new(24.0, 44.0),
                2.0,
            ),
            vec![
                InputEvent::PointerMoved {
                    pointer,
                    position: InputPoint::new(12.0, 22.0),
                },
                InputEvent::PointerButton {
                    pointer,
                    button: MunPointerButton::Primary,
                    state: MunButtonState::Released,
                },
                InputEvent::Cancel {
                    pointer: Some(pointer),
                },
            ]
        );

        assert_eq!(
            input_touch_events(
                42,
                TouchPhase::Cancelled,
                PhysicalPosition::new(0.0, 0.0),
                2.0,
            ),
            vec![InputEvent::Cancel {
                pointer: Some(pointer),
            }]
        );
    }

    #[test]
    fn platform_scroll_phase_preserves_trackpad_gesture_boundaries() {
        assert_eq!(input_scroll_phase(TouchPhase::Started), ScrollPhase::Began);
        assert_eq!(input_scroll_phase(TouchPhase::Moved), ScrollPhase::Changed);
        assert_eq!(input_scroll_phase(TouchPhase::Ended), ScrollPhase::Ended);
        assert_eq!(
            input_scroll_phase(TouchPhase::Cancelled),
            ScrollPhase::Cancelled
        );
    }

    #[test]
    fn platform_scroll_pixels_are_normalized_to_logical_points() {
        let delta = input_scroll_delta(
            MouseScrollDelta::PixelDelta(PhysicalPosition::new(20.0, -10.0)),
            2.0,
        );
        assert_eq!(delta, ScrollDelta::Pixels { x: 10.0, y: -5.0 });
    }

    #[test]
    fn rect_vertex_buffer_capacity_reuses_small_buffers_and_grows_geometrically() {
        assert_eq!(
            rect_vertex_buffer_capacity(1),
            INITIAL_RECT_VERTEX_BUFFER_BYTES
        );
        assert_eq!(
            rect_vertex_buffer_capacity(INITIAL_RECT_VERTEX_BUFFER_BYTES),
            INITIAL_RECT_VERTEX_BUFFER_BYTES
        );
        assert_eq!(
            rect_vertex_buffer_capacity(INITIAL_RECT_VERTEX_BUFFER_BYTES + 1),
            INITIAL_RECT_VERTEX_BUFFER_BYTES * 2
        );
    }

    #[test]
    fn scissor_for_clip_rounds_outward_and_intersects_surface() {
        assert_eq!(
            scissor_for_clip(None, 20, 10, 2.0),
            Some(ScissorRect {
                x: 0,
                y: 0,
                width: 20,
                height: 10,
            })
        );
        assert_eq!(
            scissor_for_clip(
                Some(Rect {
                    x: -0.25,
                    y: 1.25,
                    width: 10.5,
                    height: 4.1,
                }),
                20,
                10,
                2.0,
            ),
            Some(ScissorRect {
                x: 0,
                y: 2,
                width: 20,
                height: 8,
            })
        );
        assert_eq!(
            scissor_for_clip(
                Some(Rect {
                    x: 30.0,
                    y: 0.0,
                    width: 5.0,
                    height: 5.0,
                }),
                20,
                10,
                1.0,
            ),
            None
        );
    }

    #[test]
    fn scene_geometry_batches_equal_clips() {
        let item = |id: &str| SceneRect {
            id: id.into(),
            rect: Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            color: Color([1.0; 4]),
            corner_radius: 0.0,
        };
        let scene = Scene {
            rects: vec![item("a"), item("b")],
            ..Default::default()
        };
        let mut presentation = ScenePresentation::default();
        let clip = presentation.push_clip(
            None,
            Rect {
                x: 5.0,
                y: 6.0,
                width: 20.0,
                height: 10.0,
            },
            None,
        );
        presentation.bind_clip("a", clip);
        presentation.bind_clip("b", clip);

        let (vertices, batches) = scene_geometry(&scene, &presentation, 100, 80, 2.0);
        assert_eq!(vertices.len(), 12);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].start, 0);
        assert_eq!(batches[0].end, 12);
        assert_eq!(
            batches[0].scissor,
            ScissorRect {
                x: 10,
                y: 12,
                width: 40,
                height: 20
            }
        );
    }

    #[test]
    fn retained_text_buffer_reshapes_only_when_layout_inputs_change() {
        let mut font_system = FontSystem::new();
        let mut cached = CachedTextBuffer::new(&mut font_system, "Hello", 16.0, 320.0, 200.0);

        assert!(!cached.update(&mut font_system, "Hello", 16.0, 320.0, 200.0));
        assert!(cached.update(&mut font_system, "World", 16.0, 320.0, 200.0));
        assert!(!cached.update(&mut font_system, "World", 16.0, 320.0, 200.0));
        assert!(cached.update(&mut font_system, "World", 18.0, 320.0, 200.0));
        assert!(cached.update(&mut font_system, "World", 18.0, 640.0, 200.0));
    }

    #[test]
    fn scene_vertices_preserve_rounded_rect_geometry() {
        let scene = Scene {
            rects: vec![SceneRect {
                id: "rounded".into(),
                rect: Rect {
                    x: 10.0,
                    y: 20.0,
                    width: 40.0,
                    height: 20.0,
                },
                color: Color([0.25, 0.5, 0.75, 1.0]),
                corner_radius: 6.0,
            }],
            ..Default::default()
        };

        let vertices = scene_vertices(&scene, &ScenePresentation::default(), 200.0, 120.0, 2.0);

        assert_eq!(vertices.len(), 6);
        assert_eq!(vertices[0].local_position, [0.0, 0.0]);
        assert_eq!(vertices[2].local_position, [40.0, 20.0]);
        assert_eq!(vertices[0].rect_size, [40.0, 20.0]);
        assert_eq!(vertices[0].color, [0.25, 0.5, 0.75, 1.0]);
        assert_eq!(vertices[0].corner_radius, 6.0);
    }

    #[test]
    fn scene_vertices_interpolate_linear_gradient_colors() {
        let scene = Scene {
            rects: vec![SceneRect {
                id: "gradient".into(),
                rect: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 40.0,
                    height: 20.0,
                },
                color: Color([1.0, 0.0, 0.0, 1.0]),
                corner_radius: 0.0,
            }],
            gradients: vec![mun_runtime::scene::SceneGradient {
                id: "gradient".into(),
                gradient: mun_runtime::scene::LinearGradient {
                    start: Color([1.0, 0.0, 0.0, 1.0]),
                    end: Color([0.0, 0.0, 1.0, 1.0]),
                    start_point: [0.0, 0.5],
                    end_point: [1.0, 0.5],
                },
            }],
            ..Default::default()
        };

        let vertices = scene_vertices(&scene, &ScenePresentation::default(), 100.0, 80.0, 1.0);

        assert_eq!(vertices.len(), 6);
        assert_eq!(vertices[0].local_position, [0.0, 0.0]);
        assert_eq!(vertices[0].color, [1.0, 0.0, 0.0, 1.0]);
        assert_eq!(vertices[2].local_position, [40.0, 20.0]);
        assert_eq!(vertices[2].color, [0.0, 0.0, 1.0, 1.0]);
    }

    #[test]
    fn scene_vertices_apply_non_uniform_presentation_transform() {
        let scene = Scene {
            rects: vec![SceneRect {
                id: "box".into(),
                rect: Rect {
                    x: 10.0,
                    y: 20.0,
                    width: 40.0,
                    height: 20.0,
                },
                color: Color([1.0, 1.0, 1.0, 1.0]),
                corner_radius: 4.0,
            }],
            ..Default::default()
        };
        let mut presentation = ScenePresentation::default();
        let transform = presentation.push_transform(
            None,
            SceneTransform {
                scale_x: 0.5,
                scale_y: 2.0,
                translation_x: 5.0,
                translation_y: -10.0,
            },
        );
        presentation.bind("box", transform);

        let vertices = scene_vertices(&scene, &presentation, 200.0, 120.0, 2.0);

        assert!((vertices[0].position[0] - -0.8).abs() < 0.0001);
        assert!(vertices[0].position[1].abs() < 0.0001);
        assert!((vertices[2].position[0] - -0.4).abs() < 0.0001);
        assert!((vertices[2].position[1] - -1.3333334).abs() < 0.0001);
        assert_eq!(vertices[2].local_position, [40.0, 20.0]);
        assert_eq!(vertices[0].rect_size, [40.0, 20.0]);
        assert_eq!(vertices[0].corner_radius, 4.0);
    }

    #[test]
    fn non_uniform_text_plan_rasterizes_at_largest_axis() {
        let plan = text_transform_plan(
            SceneTransform {
                scale_x: 2.0,
                scale_y: 0.5,
                translation_x: 3.0,
                translation_y: -4.0,
            },
            200.0,
            120.0,
            2.0,
        )
        .unwrap()
        .unwrap();

        assert_eq!(plan.raster_scale, 4.0);
        assert_eq!(plan.virtual_width, 400);
        assert_eq!(plan.virtual_height, 240);
        assert_eq!(plan.viewport_x, 6.0);
        assert_eq!(plan.viewport_y, -8.0);
        assert_eq!(plan.viewport_width, 400.0);
        assert_eq!(plan.viewport_height, 60.0);
    }

    #[test]
    fn text_plan_skips_collapsed_axes_and_rejects_mirroring() {
        assert!(
            text_transform_plan(SceneTransform::scale(0.0, 1.0), 200.0, 120.0, 2.0)
                .unwrap()
                .is_none()
        );
        assert!(text_transform_plan(SceneTransform::scale(-1.0, 1.0), 200.0, 120.0, 2.0).is_err());
    }
}

fn input_button_state(state: ElementState) -> MunButtonState {
    match state {
        ElementState::Pressed => MunButtonState::Pressed,
        ElementState::Released => MunButtonState::Released,
    }
}

fn input_mouse_button(button: MouseButton) -> MunPointerButton {
    match button {
        MouseButton::Left => MunPointerButton::Primary,
        MouseButton::Right => MunPointerButton::Secondary,
        MouseButton::Middle => MunPointerButton::Middle,
        MouseButton::Back => MunPointerButton::Back,
        MouseButton::Forward => MunPointerButton::Forward,
        MouseButton::Other(button) => MunPointerButton::Other(button),
    }
}

fn input_logical_key(key: &Key) -> LogicalKey {
    match key {
        Key::Named(NamedKey::Tab) => LogicalKey::Tab,
        Key::Named(NamedKey::Enter) => LogicalKey::Enter,
        Key::Named(NamedKey::Space) => LogicalKey::Space,
        Key::Named(NamedKey::Escape) => LogicalKey::Escape,
        Key::Named(NamedKey::ArrowUp) => LogicalKey::ArrowUp,
        Key::Named(NamedKey::ArrowDown) => LogicalKey::ArrowDown,
        Key::Named(NamedKey::ArrowLeft) => LogicalKey::ArrowLeft,
        Key::Named(NamedKey::ArrowRight) => LogicalKey::ArrowRight,
        Key::Named(NamedKey::Home) => LogicalKey::Home,
        Key::Named(NamedKey::End) => LogicalKey::End,
        Key::Named(NamedKey::PageUp) => LogicalKey::PageUp,
        Key::Named(NamedKey::PageDown) => LogicalKey::PageDown,
        Key::Named(NamedKey::Backspace) => LogicalKey::Backspace,
        Key::Named(NamedKey::Delete) => LogicalKey::Delete,
        Key::Character(value) => LogicalKey::Character(value.to_string()),
        _ => LogicalKey::Unidentified,
    }
}

fn input_physical_key(key: WinitPhysicalKey) -> MunPhysicalKey {
    match key {
        WinitPhysicalKey::Code(KeyCode::Tab) => MunPhysicalKey::Tab,
        WinitPhysicalKey::Code(KeyCode::Enter) => MunPhysicalKey::Enter,
        WinitPhysicalKey::Code(KeyCode::Space) => MunPhysicalKey::Space,
        WinitPhysicalKey::Code(KeyCode::Escape) => MunPhysicalKey::Escape,
        WinitPhysicalKey::Code(KeyCode::ArrowUp) => MunPhysicalKey::ArrowUp,
        WinitPhysicalKey::Code(KeyCode::ArrowDown) => MunPhysicalKey::ArrowDown,
        WinitPhysicalKey::Code(KeyCode::ArrowLeft) => MunPhysicalKey::ArrowLeft,
        WinitPhysicalKey::Code(KeyCode::ArrowRight) => MunPhysicalKey::ArrowRight,
        WinitPhysicalKey::Code(KeyCode::Home) => MunPhysicalKey::Home,
        WinitPhysicalKey::Code(KeyCode::End) => MunPhysicalKey::End,
        WinitPhysicalKey::Code(KeyCode::PageUp) => MunPhysicalKey::PageUp,
        WinitPhysicalKey::Code(KeyCode::PageDown) => MunPhysicalKey::PageDown,
        WinitPhysicalKey::Code(KeyCode::Backspace) => MunPhysicalKey::Backspace,
        WinitPhysicalKey::Code(KeyCode::Delete) => MunPhysicalKey::Delete,
        WinitPhysicalKey::Code(_) => MunPhysicalKey::Other,
        WinitPhysicalKey::Unidentified(_) => MunPhysicalKey::Unidentified,
    }
}

fn input_modifiers(state: ModifiersState) -> Modifiers {
    Modifiers {
        shift: state.shift_key(),
        control: state.control_key(),
        alt: state.alt_key(),
        meta: state.super_key(),
    }
}

fn input_scroll_delta(delta: MouseScrollDelta, scale_factor: f64) -> ScrollDelta {
    match delta {
        MouseScrollDelta::LineDelta(x, y) => ScrollDelta::Lines { x, y },
        MouseScrollDelta::PixelDelta(position) => ScrollDelta::Pixels {
            x: (position.x / scale_factor) as f32,
            y: (position.y / scale_factor) as f32,
        },
    }
}

fn input_scroll_phase(phase: TouchPhase) -> ScrollPhase {
    match phase {
        TouchPhase::Started => ScrollPhase::Began,
        TouchPhase::Moved => ScrollPhase::Changed,
        TouchPhase::Ended => ScrollPhase::Ended,
        TouchPhase::Cancelled => ScrollPhase::Cancelled,
    }
}

fn input_touch_events(
    id: u64,
    phase: TouchPhase,
    position: PhysicalPosition<f64>,
    scale_factor: f64,
) -> Vec<InputEvent> {
    let pointer = PointerId::touch(id);
    let position = InputPoint::new(
        (position.x / scale_factor) as f32,
        (position.y / scale_factor) as f32,
    );
    let moved = InputEvent::PointerMoved { pointer, position };

    match phase {
        TouchPhase::Started => vec![
            moved,
            InputEvent::PointerButton {
                pointer,
                button: MunPointerButton::Primary,
                state: MunButtonState::Pressed,
            },
        ],
        TouchPhase::Moved => vec![moved],
        TouchPhase::Ended => vec![
            moved,
            InputEvent::PointerButton {
                pointer,
                button: MunPointerButton::Primary,
                state: MunButtonState::Released,
            },
            InputEvent::Cancel {
                pointer: Some(pointer),
            },
        ],
        TouchPhase::Cancelled => vec![InputEvent::Cancel {
            pointer: Some(pointer),
        }],
    }
}

struct WindowState {
    runtime: Runtime,
    renderer: GpuRenderer,
    accessibility: AccessibilityHost,
    last_frame: Instant,
    clipboard: Option<arboard::Clipboard>,
    modifiers: Modifiers,
    ime_composing: bool,
    ime_allowed: bool,
    ime_cursor_area: Option<mun_runtime::Rect>,
    window: Arc<Window>,
}

/// Drop the platform input method's marked text after the runtime deliberately
/// committed or cancelled a composition (pointer relocation, focus change).
/// winit's `set_ime_allowed(false)` only clears its own copy on macOS; the
/// system input context must be told explicitly or the IME keeps composing.
#[cfg(target_os = "macos")]
fn discard_platform_marked_text() {
    if let Some(mtm) = objc2_foundation::MainThreadMarker::new() {
        // SAFETY: called on the main thread (checked by `MainThreadMarker`).
        if let Some(context) =
            unsafe { objc2_app_kit::NSTextInputContext::currentInputContext(mtm) }
        {
            context.discardMarkedText();
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn discard_platform_marked_text() {
    // Windows (IMM/TSF) and X11/Wayland input methods are reset by the
    // allowed-state toggle performed in `sync_text_input`.
}

impl WindowState {
    async fn new(
        window: Arc<Window>,
        event_loop: &ActiveEventLoop,
        mut runtime: Runtime,
        proxy: EventLoopProxy<NativeEvent>,
    ) -> Result<Self, GpuError> {
        let shaping = Rc::new(TextShaping::new(FontSystem::new()));
        runtime.set_intrinsic_measurer(shaping.clone());
        runtime.set_platform_conventions(PlatformConventions::native());
        let scale_factor = window.scale_factor() as f32;
        let size = window.inner_size();
        let logical_width = size.width.max(1) as f32 / scale_factor;
        let logical_height = size.height.max(1) as f32 / scale_factor;
        let tree = runtime
            .build_accessibility_tree(logical_width, logical_height)
            .expect("build initial Mün accessibility tree");
        let accessibility = AccessibilityHost::new(event_loop, &window, tree, scale_factor, proxy);
        // The platform IME is routed only while an editable field owns focus.
        window.set_ime_allowed(false);
        window.set_visible(true);
        let renderer = GpuRenderer::new(window.clone(), event_loop, shaping).await?;
        Ok(Self {
            runtime,
            renderer,
            accessibility,
            last_frame: Instant::now(),
            clipboard: None,
            modifiers: Modifiers::default(),
            ime_composing: false,
            ime_allowed: false,
            ime_cursor_area: None,
            window,
        })
    }

    fn logical_size(&self) -> (f32, f32) {
        let scale = self.window.scale_factor() as f32;
        (
            self.renderer.config.width as f32 / scale,
            self.renderer.config.height as f32 / scale,
        )
    }

    fn dispatch_input(&mut self, event: InputEvent) {
        let (width, height) = self.logical_size();
        let outcome = self
            .runtime
            .handle_input(event, width, height)
            .expect("route Mün semantic input");
        if outcome.needs_redraw {
            self.window.request_redraw();
        }
        self.service_clipboard();
        self.sync_text_input();
    }

    /// Service runtime clipboard requests through the OS clipboard. Every cut and
    /// read is acknowledged, including failures, so the runtime never guesses.
    fn service_clipboard(&mut self) {
        use mun_runtime::input::ClipboardRequest;
        let (width, height) = self.logical_size();
        loop {
            let requests = self.runtime.take_clipboard_requests();
            if requests.is_empty() {
                return;
            }
            for request in requests {
                if self.clipboard.is_none() {
                    match arboard::Clipboard::new() {
                        Ok(clipboard) => self.clipboard = Some(clipboard),
                        Err(error) => eprintln!("Mün clipboard unavailable: {error}"),
                    }
                }
                let response = match (request, self.clipboard.as_mut()) {
                    (ClipboardRequest::Write(text), Some(clipboard)) => {
                        if let Err(error) = clipboard.set_text(text) {
                            eprintln!("Mün clipboard write failed: {error}");
                        }
                        None
                    }
                    (ClipboardRequest::Write(_), None) => None,
                    (ClipboardRequest::Cut { request, text }, clipboard) => {
                        let success = match clipboard.map(|clipboard| clipboard.set_text(text)) {
                            Some(Ok(())) => true,
                            Some(Err(error)) => {
                                eprintln!("Mün clipboard cut failed: {error}");
                                false
                            }
                            None => false,
                        };
                        Some(InputEvent::ClipboardWriteCompleted { request, success })
                    }
                    (ClipboardRequest::Read { request, .. }, clipboard) => {
                        let text = match clipboard.map(|clipboard| clipboard.get_text()) {
                            Some(Ok(text)) => Some(text),
                            Some(Err(error)) => {
                                eprintln!("Mün clipboard read unavailable: {error}");
                                None
                            }
                            None => None,
                        };
                        Some(InputEvent::ClipboardReadCompleted { request, text })
                    }
                };
                if let Some(response) = response {
                    let outcome = self
                        .runtime
                        .handle_input(response, width, height)
                        .expect("acknowledge Mün clipboard service");
                    if outcome.needs_redraw || outcome.activated {
                        self.window.request_redraw();
                    }
                }
            }
        }
    }

    /// Keep the platform input method aligned with runtime-owned editing state.
    fn sync_text_input(&mut self) {
        let mut reset = false;
        for request in self.runtime.take_ime_requests() {
            match request {
                ImeRequest::DiscardComposition => {
                    discard_platform_marked_text();
                    self.ime_composing = false;
                    reset = true;
                }
            }
        }
        let wants = self.runtime.wants_text_input();
        if reset && self.ime_allowed {
            // Clears winit's preedit copy (and on Windows/X11 ends the platform
            // composition); re-enabled below when an editable field keeps focus.
            self.window.set_ime_allowed(false);
            self.ime_allowed = false;
        }
        if wants != self.ime_allowed {
            self.window.set_ime_allowed(wants);
            self.ime_allowed = wants;
            if !wants {
                self.ime_composing = false;
                self.ime_cursor_area = None;
            }
        }
    }

    fn update_ime_cursor_area(&mut self, area: Option<mun_runtime::Rect>) {
        if !self.ime_allowed || area == self.ime_cursor_area {
            return;
        }
        self.ime_cursor_area = area;
        if let Some(area) = area {
            self.window.set_ime_cursor_area(
                LogicalPosition::new(area.x as f64, area.y as f64),
                LogicalSize::new(area.width.max(1.0) as f64, area.height.max(1.0) as f64),
            );
        }
    }

    fn handle_accessibility_action(&mut self, request: ActionRequest) {
        let Some((id, action)) = self.accessibility.semantic_request(&request) else {
            return;
        };
        let outcome = self.runtime.handle_accessibility_action(&id, action);
        if outcome.needs_redraw {
            self.window.request_redraw();
        }
        self.sync_text_input();
    }

    fn redraw(&mut self) {
        let size = self.window.inner_size();
        if size.width == 0 || size.height == 0 {
            return;
        }
        let now = Instant::now();
        let dt = (now - self.last_frame).as_secs_f32().min(0.05);
        self.last_frame = now;
        self.runtime.step(dt);

        let (width, height) = self.logical_size();
        let frame = self
            .runtime
            .build_frame(width, height)
            .expect("build Mün native frame");
        self.update_ime_cursor_area(frame.ime_cursor_area);
        self.accessibility
            .update(frame.accessibility, self.window.scale_factor() as f32);
        let status = self
            .renderer
            .render(&frame.scene, self.window.scale_factor() as f32);
        if status == FrameStatus::Reconfigured || self.runtime.has_active_motion() {
            self.window.request_redraw();
        }
    }
}

struct Application {
    state: Option<WindowState>,
    failure: Option<NativeBackendError>,
    proxy: EventLoopProxy<NativeEvent>,
    runtime: Option<Runtime>,
    smoke_frames: Option<u32>,
}

impl Application {
    fn new(proxy: EventLoopProxy<NativeEvent>, runtime: Runtime) -> Self {
        Self {
            state: None,
            failure: None,
            proxy,
            runtime: Some(runtime),
            smoke_frames: None,
        }
    }
}

impl ApplicationHandler<NativeEvent> for Application {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.state.is_some() {
            return;
        }

        let runtime = self
            .runtime
            .take()
            .expect("Mün runtime must be available before the native window is created");
        let (width, height) = runtime.initial_window_size();
        let window = match event_loop.create_window(
            Window::default_attributes()
                .with_title(runtime.title())
                .with_visible(false)
                .with_inner_size(LogicalSize::new(width as f64, height as f64)),
        ) {
            Ok(window) => Arc::new(window),
            Err(error) => {
                self.failure = Some(NativeBackendError::Window(error));
                event_loop.exit();
                return;
            }
        };
        match pollster::block_on(WindowState::new(
            window,
            event_loop,
            runtime,
            self.proxy.clone(),
        )) {
            Ok(state) => self.state = Some(state),
            Err(error) => {
                self.failure = Some(NativeBackendError::Gpu(error));
                event_loop.exit();
            }
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        let Some(state) = &mut self.state else { return };
        state.accessibility.process_event(&state.window, &event);
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                state.renderer.resize(size.width, size.height);
                state.window.request_redraw();
            }
            WindowEvent::ScaleFactorChanged { .. } => {
                let size = state.window.inner_size();
                state.renderer.resize(size.width, size.height);
                state.window.request_redraw();
            }
            WindowEvent::ModifiersChanged(modifiers) => {
                state.modifiers = input_modifiers(modifiers.state());
                state.dispatch_input(InputEvent::ModifiersChanged(input_modifiers(
                    modifiers.state(),
                )));
            }
            WindowEvent::CursorMoved {
                position: PhysicalPosition { x, y },
                ..
            } => {
                let scale = state.window.scale_factor();
                state.dispatch_input(InputEvent::PointerMoved {
                    pointer: PointerId::MOUSE,
                    position: InputPoint::new((x / scale) as f32, (y / scale) as f32),
                });
            }
            WindowEvent::CursorLeft { .. } => {
                state.dispatch_input(InputEvent::Cancel {
                    pointer: Some(PointerId::MOUSE),
                });
            }
            WindowEvent::MouseInput {
                state: button_state,
                button,
                ..
            } => {
                state.dispatch_input(InputEvent::PointerButton {
                    pointer: PointerId::MOUSE,
                    button: input_mouse_button(button),
                    state: input_button_state(button_state),
                });
            }
            WindowEvent::MouseWheel { delta, phase, .. } => {
                state.dispatch_input(InputEvent::Scroll {
                    pointer: Some(PointerId::MOUSE),
                    delta: input_scroll_delta(delta, state.window.scale_factor()),
                    phase: input_scroll_phase(phase),
                });
            }
            WindowEvent::Touch(touch) => {
                for event in input_touch_events(
                    touch.id,
                    touch.phase,
                    touch.location,
                    state.window.scale_factor(),
                ) {
                    state.dispatch_input(event);
                }
            }
            WindowEvent::KeyboardInput { event, .. } => {
                let text = if event.state == ElementState::Pressed
                    && !state.ime_composing
                    && !state.modifiers.control
                    && !state.modifiers.meta
                {
                    event
                        .text
                        .as_ref()
                        .map(|text| {
                            text.chars()
                                .filter(|ch| !ch.is_control())
                                .collect::<String>()
                        })
                        .filter(|text| !text.is_empty())
                } else {
                    None
                };
                state.dispatch_input(InputEvent::Key {
                    logical: input_logical_key(&event.logical_key),
                    physical: input_physical_key(event.physical_key),
                    state: match event.state {
                        ElementState::Pressed => MunKeyState::Pressed,
                        ElementState::Released => MunKeyState::Released,
                    },
                    repeat: event.repeat,
                });
                if let Some(text) = text {
                    state.dispatch_input(InputEvent::TextInput { text });
                }
            }
            WindowEvent::Ime(event) => {
                use mun_runtime::text_edit::{Composition, TextEdit};
                let edit = match event {
                    Ime::Enabled => None,
                    Ime::Preedit(text, selection) => {
                        state.ime_composing = !text.is_empty();
                        if text.is_empty() {
                            Some(TextEdit::CompositionCancel)
                        } else {
                            // winit preedit offsets are UTF-8 bytes. Normalize at the adapter.
                            let scalar = |byte: usize| {
                                text.char_indices()
                                    .take_while(|(index, _)| *index < byte)
                                    .count()
                            };
                            let selection = selection.map(|(a, b)| (scalar(a), scalar(b)));
                            Some(TextEdit::CompositionUpdate(Composition { text, selection }))
                        }
                    }
                    Ime::Commit(text) => {
                        state.ime_composing = false;
                        Some(TextEdit::CompositionCommit(text))
                    }
                    Ime::Disabled => {
                        state.ime_composing = false;
                        Some(TextEdit::CompositionCancel)
                    }
                };
                if let Some(edit) = edit {
                    state.dispatch_input(InputEvent::TextEdit(edit));
                }
            }
            WindowEvent::Focused(focused) => {
                if !focused {
                    state.modifiers = Modifiers::default();
                    state.ime_composing = false;
                }
                state.dispatch_input(InputEvent::WindowFocusChanged(focused));
            }
            WindowEvent::RedrawRequested => {
                state.redraw();
                if let Some(reason) = state.renderer.device_lost() {
                    self.failure = Some(NativeBackendError::Gpu(GpuError {
                        subsystem: "device",
                        message: format!("GPU device lost: {reason}"),
                    }));
                    event_loop.exit();
                    return;
                }
                if let Some(frames) = &mut self.smoke_frames {
                    *frames = frames.saturating_sub(1);
                    if *frames == 0 {
                        event_loop.exit();
                    } else {
                        state.window.request_redraw();
                    }
                }
            }
            _ => {}
        }
    }

    fn user_event(&mut self, _event_loop: &ActiveEventLoop, event: NativeEvent) {
        let Some(state) = &mut self.state else { return };
        match event {
            NativeEvent::AccessibilityAction(request) => {
                state.handle_accessibility_action(request);
            }
        }
    }
}

/// Run an initialized Mün semantic runtime in the desktop native backend.
pub fn run_runtime(runtime: Runtime) -> Result<(), NativeBackendError> {
    let event_loop = EventLoop::<NativeEvent>::with_user_event().build()?;
    let proxy = event_loop.create_proxy();
    let mut application = Application::new(proxy, runtime);
    event_loop.run_app(&mut application)?;
    application.failure.map_or(Ok(()), Err)
}

/// Render compiler-produced IR offscreen through the production renderer after
/// applying a semantic input script; returns PNG bytes and a JSON report.
pub fn render_program_png(
    program: &str,
    script: &serde_json::Value,
    logical_width: f32,
    logical_height: f32,
    scale_factor: f32,
) -> Result<(Vec<u8>, serde_json::Value), NativeBackendError> {
    let mut session = OffscreenSession::new(program, logical_width, logical_height, scale_factor)?;
    session.render().map_err(NativeBackendError::Gpu)?;
    session.apply_script(script).map_err(|message| {
        NativeBackendError::Gpu(GpuError {
            subsystem: "script",
            message,
        })
    })?;
    let timing = session.render().map_err(NativeBackendError::Gpu)?;
    let (width, height) = session.size();
    let rgba = session.rgba().ok_or_else(|| {
        NativeBackendError::Gpu(GpuError {
            subsystem: "readback",
            message: "offscreen target could not be read".into(),
        })
    })?;
    let frame = session
        .runtime()
        .build_frame(logical_width, logical_height)
        .map_err(|error| NativeBackendError::Gpu(GpuError::new("layout", error)))?;
    let stats = session.renderer_stats();
    let report = serde_json::json!({
        "width": width,
        "height": height,
        "focused": session.runtime().focused_action(),
        "imeCursorArea": frame.ime_cursor_area.map(|area| [area.x, area.y, area.width, area.height]),
        "rects": frame.scene.rects.iter().map(|item| serde_json::json!({
            "id": item.id,
            "rect": [item.rect.x, item.rect.y, item.rect.width, item.rect.height],
        })).collect::<Vec<_>>(),
        "texts": frame.scene.texts.iter().map(|item| serde_json::json!({
            "id": item.id, "text": item.text, "x": item.x, "y": item.y,
        })).collect::<Vec<_>>(),
        "retainedNodes": session.runtime().retained_tree().len(),
        "textBuffers": stats.text_buffers,
        "textReshapes": stats.text_reshapes,
        "buildMicros": timing.build_micros,
        "renderMicros": timing.render_micros,
    });
    Ok((encode_png(width, height, &rgba), report))
}

/// Bounded real-window/GPU/accesskit smoke path; failures remain fatal.
pub fn smoke_program(program: &str) -> Result<(), NativeBackendError> {
    let runtime = Runtime::from_json(program)?;
    let event_loop = EventLoop::<NativeEvent>::with_user_event().build()?;
    let mut application = Application::new(event_loop.create_proxy(), runtime);
    application.smoke_frames = Some(3);
    event_loop.run_app(&mut application)?;
    application.failure.map_or(Ok(()), Err)
}

/// Parse compiler-produced Mün Semantic UI IR and run it in the desktop native backend.
pub fn run_program(program: &str) -> Result<(), NativeBackendError> {
    run_runtime(Runtime::from_json(program)?)
}

#[cfg(test)]
mod backend_tests {
    use super::*;

    #[test]
    fn invalid_program_fails_before_platform_startup() {
        let error = run_program("{").expect_err("invalid IR must fail before opening a window");
        assert!(matches!(error, NativeBackendError::Program(_)));
    }
}
