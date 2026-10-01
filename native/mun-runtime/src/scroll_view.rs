//! Runtime-owned viewport geometry and offsets. Renderer adapters consume clips;
//! they never own scroll input, content extents, or offset reconciliation.
use crate::scene::Rect;
#[derive(Clone, Debug, Default)]
pub struct ScrollViewport {
    pub bounds: Rect,
    pub extent: [f32; 2],
    pub offset: [f32; 2],
    pub horizontal: bool,
}
impl ScrollViewport {
    pub fn reconcile(&mut self, bounds: Rect, extent: [f32; 2], horizontal: bool) {
        self.bounds = bounds;
        self.extent = extent;
        self.horizontal = horizontal;
        self.clamp();
    }
    fn clamp(&mut self) {
        self.offset[0] = if self.horizontal {
            self.offset[0].clamp(0.0, (self.extent[0] - self.bounds.width).max(0.0))
        } else {
            0.0
        };
        self.offset[1] = if !self.horizontal {
            self.offset[1].clamp(0.0, (self.extent[1] - self.bounds.height).max(0.0))
        } else {
            0.0
        };
    }
    /// Canonical content movement, with residual delta for ancestor routing.
    pub fn scroll(&mut self, delta: [f32; 2]) -> [f32; 2] {
        let before = self.offset;
        for (offset, delta) in self.offset.iter_mut().zip(delta) {
            if delta.is_finite() {
                *offset -= delta;
            }
        }
        self.clamp();
        [
            delta[0] + self.offset[0] - before[0],
            delta[1] + self.offset[1] - before[1],
        ]
    }
}
