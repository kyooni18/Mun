mod accessibility;

use std::{error::Error, fmt, sync::Arc, time::Instant};

use accessibility::{AccessibilityHost, NativeEvent};
use accesskit::{Action, ActionRequest};
use bytemuck::{Pod, Zeroable};
use glyphon::{
    Attrs, Buffer, Cache, Color as GlyphColor, Family, FontSystem, Metrics, Resolution, Shaping,
    SwashCache, TextArea, TextAtlas, TextBounds, TextRenderer, Viewport,
};
use mun_runtime::{
    ButtonState as MunButtonState, Color, InputEvent, InputPoint, KeyState as MunKeyState,
    LogicalKey, Modifiers, PhysicalKey as MunPhysicalKey, PointerButton as MunPointerButton,
    PointerId, Runtime, RuntimeLoadError, Scene, ScrollDelta,
};
use wgpu::util::DeviceExt;
use winit::{
    application::ApplicationHandler,
    dpi::{LogicalSize, PhysicalPosition},
    event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent},
    event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy},
    keyboard::{Key, KeyCode, ModifiersState, NamedKey, PhysicalKey as WinitPhysicalKey},
    window::{Window, WindowId},
};

/// Failure while preparing or running Mün's desktop-native backend.
#[derive(Debug)]
pub enum NativeBackendError {
    Program(RuntimeLoadError),
    EventLoop(winit::error::EventLoopError),
}

impl fmt::Display for NativeBackendError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Program(error) => write!(formatter, "{error}"),
            Self::EventLoop(error) => write!(formatter, "{error}"),
        }
    }
}

impl Error for NativeBackendError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Program(error) => Some(error),
            Self::EventLoop(error) => Some(error),
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

struct GpuRenderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    rect_pipeline: wgpu::RenderPipeline,
    font_system: FontSystem,
    swash_cache: SwashCache,
    viewport: Viewport,
    atlas: TextAtlas,
    text_renderer: TextRenderer,
}

impl GpuRenderer {
    async fn new(window: Arc<Window>, event_loop: &ActiveEventLoop) -> Self {
        let size = window.inner_size();
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_with_display_handle(
            Box::new(event_loop.owned_display_handle()),
        ));
        let surface = instance.create_surface(window).expect("create Mün surface");
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                compatible_surface: Some(&surface),
                ..Default::default()
            })
            .await
            .expect("find GPU adapter");
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .expect("create GPU device");
        let mut config = surface
            .get_default_config(&adapter, size.width.max(1), size.height.max(1))
            .expect("surface configuration");
        config.present_mode = wgpu::PresentMode::Fifo;
        surface.configure(&device, &config);

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
                compilation_options: Default::default(),
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

        let font_system = FontSystem::new();
        let swash_cache = SwashCache::new();
        let cache = Cache::new(&device);
        let viewport = Viewport::new(&device, &cache);
        let mut atlas = TextAtlas::new(&device, &queue, &cache, config.format);
        let text_renderer =
            TextRenderer::new(&mut atlas, &device, wgpu::MultisampleState::default(), None);

        Self {
            device,
            queue,
            surface,
            config,
            rect_pipeline,
            font_system,
            swash_cache,
            viewport,
            atlas,
            text_renderer,
        }
    }

    fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
    }

    fn render(&mut self, scene: &Scene, scale_factor: f32) {
        let physical_width = self.config.width.max(1) as f32;
        let physical_height = self.config.height.max(1) as f32;
        self.viewport.update(
            &self.queue,
            Resolution {
                width: self.config.width.max(1),
                height: self.config.height.max(1),
            },
        );

        let vertices = scene_vertices(scene, physical_width, physical_height, scale_factor);
        let vertex_buffer = (!vertices.is_empty()).then(|| {
            self.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Mün scene vertices"),
                    contents: bytemuck::cast_slice(&vertices),
                    usage: wgpu::BufferUsages::VERTEX,
                })
        });

        let mut text_buffers = Vec::with_capacity(scene.texts.len());
        for text in &scene.texts {
            let mut buffer = Buffer::new(
                &mut self.font_system,
                Metrics::new(text.font_size, text.font_size * 1.25),
            );
            buffer.set_size(
                Some(self.config.width as f32 / scale_factor),
                Some(self.config.height as f32 / scale_factor),
            );
            buffer.set_text(
                &text.text,
                &Attrs::new().family(Family::SansSerif),
                Shaping::Advanced,
                None,
            );
            buffer.shape_until_scroll(&mut self.font_system, false);
            text_buffers.push(buffer);
        }

        let text_areas: Vec<_> = text_buffers
            .iter()
            .zip(&scene.texts)
            .map(|(buffer, text)| {
                let rgba = text
                    .color
                    .0
                    .map(|value| (value.clamp(0.0, 1.0) * 255.0).round() as u8);
                TextArea {
                    buffer,
                    left: text.x * scale_factor,
                    top: text.y * scale_factor,
                    scale: scale_factor,
                    bounds: TextBounds {
                        left: 0,
                        top: 0,
                        right: self.config.width as i32,
                        bottom: self.config.height as i32,
                    },
                    default_color: GlyphColor::rgba(rgba[0], rgba[1], rgba[2], rgba[3]),
                    custom_glyphs: &[],
                }
            })
            .collect();

        self.text_renderer
            .prepare(
                &self.device,
                &self.queue,
                &mut self.font_system,
                &mut self.atlas,
                &self.viewport,
                text_areas,
                &mut self.swash_cache,
            )
            .expect("prepare Mün text");

        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame) => frame,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => return,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Suboptimal(_) => {
                self.surface.configure(&self.device, &self.config);
                return;
            }
            wgpu::CurrentSurfaceTexture::Lost => {
                self.surface.configure(&self.device, &self.config);
                return;
            }
            wgpu::CurrentSurfaceTexture::Validation => panic!("wgpu surface validation error"),
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Mün frame encoder"),
            });

        {
            let clear = Color::WINDOW.0;
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Mün retained scene"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: clear[0] as f64,
                            g: clear[1] as f64,
                            b: clear[2] as f64,
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

            if let Some(vertex_buffer) = &vertex_buffer {
                pass.set_pipeline(&self.rect_pipeline);
                pass.set_vertex_buffer(0, vertex_buffer.slice(..));
                pass.draw(0..vertices.len() as u32, 0..1);
            }
            self.text_renderer
                .render(&self.atlas, &self.viewport, &mut pass)
                .expect("render Mün text");
        }

        self.queue.submit(Some(encoder.finish()));
        self.queue.present(frame);
        self.atlas.trim();
    }
}

fn scene_vertices(scene: &Scene, width: f32, height: f32, scale: f32) -> Vec<Vertex> {
    let mut vertices = Vec::with_capacity(scene.rects.len() * 6);
    for item in &scene.rects {
        let left = item.rect.x * scale;
        let top = item.rect.y * scale;
        let right = (item.rect.x + item.rect.width) * scale;
        let bottom = (item.rect.y + item.rect.height) * scale;
        let x0 = left / width * 2.0 - 1.0;
        let x1 = right / width * 2.0 - 1.0;
        let y0 = 1.0 - top / height * 2.0;
        let y1 = 1.0 - bottom / height * 2.0;
        let color = item.color.0;
        let rect_size = [item.rect.width, item.rect.height];
        let radius = item.corner_radius.max(0.0);
        let vertex = |position, local_position| Vertex {
            position,
            color,
            local_position,
            rect_size,
            corner_radius: radius,
        };
        vertices.extend_from_slice(&[
            vertex([x0, y0], [0.0, 0.0]),
            vertex([x1, y0], [item.rect.width, 0.0]),
            vertex([x1, y1], [item.rect.width, item.rect.height]),
            vertex([x0, y0], [0.0, 0.0]),
            vertex([x1, y1], [item.rect.width, item.rect.height]),
            vertex([x0, y1], [0.0, item.rect.height]),
        ]);
    }
    vertices
}

#[cfg(test)]
mod tests {
    use super::*;
    use mun_runtime::{Rect, scene::SceneRect};

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
    fn platform_scroll_pixels_are_normalized_to_logical_points() {
        let delta = input_scroll_delta(
            MouseScrollDelta::PixelDelta(PhysicalPosition::new(20.0, -10.0)),
            2.0,
        );
        assert_eq!(delta, ScrollDelta::Pixels { x: 10.0, y: -5.0 });
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

        let vertices = scene_vertices(&scene, 200.0, 120.0, 2.0);

        assert_eq!(vertices.len(), 6);
        assert_eq!(vertices[0].local_position, [0.0, 0.0]);
        assert_eq!(vertices[2].local_position, [40.0, 20.0]);
        assert_eq!(vertices[0].rect_size, [40.0, 20.0]);
        assert_eq!(vertices[0].corner_radius, 6.0);
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

struct WindowState {
    runtime: Runtime,
    renderer: GpuRenderer,
    accessibility: AccessibilityHost,
    last_frame: Instant,
    window: Arc<Window>,
}

impl WindowState {
    async fn new(
        window: Arc<Window>,
        event_loop: &ActiveEventLoop,
        runtime: Runtime,
        proxy: EventLoopProxy<NativeEvent>,
    ) -> Self {
        let scale_factor = window.scale_factor() as f32;
        let size = window.inner_size();
        let logical_width = size.width.max(1) as f32 / scale_factor;
        let logical_height = size.height.max(1) as f32 / scale_factor;
        let tree = runtime
            .build_accessibility_tree(logical_width, logical_height)
            .expect("build initial Mün accessibility tree");
        let accessibility = AccessibilityHost::new(event_loop, &window, tree, scale_factor, proxy);
        window.set_visible(true);
        let renderer = GpuRenderer::new(window.clone(), event_loop).await;
        Self {
            runtime,
            renderer,
            accessibility,
            last_frame: Instant::now(),
            window,
        }
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
    }

    fn handle_accessibility_action(&mut self, request: ActionRequest) {
        let Some(id) = self.accessibility.semantic_id_for(request.target_node) else {
            return;
        };
        match request.action {
            Action::Click => {
                if self.runtime.focus_action(&id) {
                    self.runtime.activate_action(&id);
                    self.window.request_redraw();
                }
            }
            Action::Focus => {
                if self.runtime.focus_action(&id) {
                    self.window.request_redraw();
                }
            }
            Action::Blur => {
                if self.runtime.focused_action() == Some(id.as_str()) {
                    self.runtime.clear_focus();
                    self.window.request_redraw();
                }
            }
            _ => {}
        }
    }

    fn redraw(&mut self) {
        let now = Instant::now();
        let dt = (now - self.last_frame).as_secs_f32().min(0.05);
        self.last_frame = now;
        self.runtime.step(dt);

        let (width, height) = self.logical_size();
        let frame = self
            .runtime
            .build_frame(width, height)
            .expect("build Mün native frame");
        self.accessibility
            .update(frame.accessibility, self.window.scale_factor() as f32);
        self.renderer
            .render(&frame.scene, self.window.scale_factor() as f32);
        if self.runtime.has_active_motion() {
            self.window.request_redraw();
        }
    }
}

struct Application {
    state: Option<WindowState>,
    proxy: EventLoopProxy<NativeEvent>,
    runtime: Option<Runtime>,
}

impl Application {
    fn new(proxy: EventLoopProxy<NativeEvent>, runtime: Runtime) -> Self {
        Self {
            state: None,
            proxy,
            runtime: Some(runtime),
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
        let window = Arc::new(
            event_loop
                .create_window(
                    Window::default_attributes()
                        .with_title(runtime.title())
                        .with_visible(false)
                        .with_inner_size(LogicalSize::new(width as f64, height as f64)),
                )
                .expect("create native Mün window"),
        );
        self.state = Some(pollster::block_on(WindowState::new(
            window,
            event_loop,
            runtime,
            self.proxy.clone(),
        )));
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
            WindowEvent::ScaleFactorChanged { .. } => state.window.request_redraw(),
            WindowEvent::ModifiersChanged(modifiers) => {
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
            WindowEvent::MouseWheel { delta, .. } => {
                state.dispatch_input(InputEvent::Scroll {
                    pointer: Some(PointerId::MOUSE),
                    delta: input_scroll_delta(delta, state.window.scale_factor()),
                });
            }
            WindowEvent::KeyboardInput { event, .. } => {
                state.dispatch_input(InputEvent::Key {
                    logical: input_logical_key(&event.logical_key),
                    physical: input_physical_key(event.physical_key),
                    state: match event.state {
                        ElementState::Pressed => MunKeyState::Pressed,
                        ElementState::Released => MunKeyState::Released,
                    },
                    repeat: event.repeat,
                });
            }
            WindowEvent::Ime(Ime::Commit(text)) => {
                state.dispatch_input(InputEvent::TextInput { text });
            }
            WindowEvent::Focused(focused) => {
                state.dispatch_input(InputEvent::WindowFocusChanged(focused));
            }
            WindowEvent::RedrawRequested => state.redraw(),
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
    event_loop.run_app(&mut Application::new(proxy, runtime))?;
    Ok(())
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
