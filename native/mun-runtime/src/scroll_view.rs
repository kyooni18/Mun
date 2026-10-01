//! Runtime-owned viewport geometry and offsets. Renderer adapters consume clips;
//! they never own scroll input, content extents, or offset reconciliation.
use crate::scene::Rect;

/// Scrollbar presentation geometry derived from viewport/content ratio and offset.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ScrollbarGeometry {
    pub track: Rect,
    pub thumb: Rect,
}

#[derive(Clone, Debug, Default)]
pub struct ScrollViewport {
    pub bounds: Rect,
    pub extent: [f32; 2],
    pub offset: [f32; 2],
    pub horizontal: bool,
    /// Present only when content overflows the viewport on the scroll axis.
    pub scrollbar: Option<ScrollbarGeometry>,
}

pub const SCROLLBAR_THICKNESS: f32 = 6.0;
pub const SCROLLBAR_INSET: f32 = 2.0;
pub const SCROLLBAR_MIN_THUMB: f32 = 24.0;
/// Keyboard arrow step in logical points.
pub const SCROLL_LINE: f32 = 40.0;

impl ScrollViewport {
    pub fn reconcile(&mut self, bounds: Rect, extent: [f32; 2], horizontal: bool) {
        self.bounds = bounds;
        self.extent = extent;
        self.horizontal = horizontal;
        self.clamp();
    }
    fn axis(&self) -> usize {
        usize::from(!self.horizontal)
    }
    fn viewport_length(&self) -> f32 {
        if self.horizontal {
            self.bounds.width
        } else {
            self.bounds.height
        }
    }
    /// Maximum offset on the scroll axis (0 when content fits).
    pub fn max_offset(&self) -> f32 {
        (self.extent[self.axis()] - self.viewport_length()).max(0.0)
    }
    pub fn is_scrollable(&self) -> bool {
        self.max_offset() > 0.5
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
    /// Set the axis offset directly (scrollbar drag, Home/End); clamped.
    pub fn set_axis_offset(&mut self, value: f32) {
        if value.is_finite() {
            let axis = self.axis();
            self.offset[axis] = value;
            self.clamp();
        }
    }
    pub fn axis_offset(&self) -> f32 {
        self.offset[self.axis()]
    }
    /// Page distance: one viewport minus a line of overlap for context.
    pub fn page(&self) -> f32 {
        (self.viewport_length() - SCROLL_LINE).max(self.viewport_length() * 0.5)
    }

    /// Recompute scrollbar geometry for the current bounds/extent/offset.
    pub fn update_scrollbar(&mut self) {
        if !self.is_scrollable() {
            self.scrollbar = None;
            return;
        }
        let viewport = self.viewport_length();
        let extent = self.extent[self.axis()].max(viewport);
        let track_length = (viewport - SCROLLBAR_INSET * 2.0).max(0.0);
        let thumb_length = (track_length * viewport / extent)
            .max(SCROLLBAR_MIN_THUMB)
            .min(track_length);
        let progress = self.axis_offset() / self.max_offset();
        let thumb_start = (track_length - thumb_length) * progress.clamp(0.0, 1.0);
        let b = self.bounds;
        let (track, thumb) = if self.horizontal {
            let y = b.y + b.height - SCROLLBAR_THICKNESS - SCROLLBAR_INSET;
            let x = b.x + SCROLLBAR_INSET;
            (
                Rect {
                    x,
                    y,
                    width: track_length,
                    height: SCROLLBAR_THICKNESS,
                },
                Rect {
                    x: x + thumb_start,
                    y,
                    width: thumb_length,
                    height: SCROLLBAR_THICKNESS,
                },
            )
        } else {
            let x = b.x + b.width - SCROLLBAR_THICKNESS - SCROLLBAR_INSET;
            let y = b.y + SCROLLBAR_INSET;
            (
                Rect {
                    x,
                    y,
                    width: SCROLLBAR_THICKNESS,
                    height: track_length,
                },
                Rect {
                    x,
                    y: y + thumb_start,
                    width: SCROLLBAR_THICKNESS,
                    height: thumb_length,
                },
            )
        };
        self.scrollbar = Some(ScrollbarGeometry { track, thumb });
    }

    /// Map a pointer coordinate on the axis to an offset, keeping the grab point
    /// under the pointer (scrollbar thumb dragging).
    pub fn offset_for_thumb_position(&self, pointer_axis: f32, grab: f32) -> Option<f32> {
        let bar = self.scrollbar?;
        let (track_start, track_length, thumb_length) = if self.horizontal {
            (bar.track.x, bar.track.width, bar.thumb.width)
        } else {
            (bar.track.y, bar.track.height, bar.thumb.height)
        };
        let travel = track_length - thumb_length;
        if travel <= f32::EPSILON {
            return Some(0.0);
        }
        let start = (pointer_axis - grab - track_start).clamp(0.0, travel);
        Some(start / travel * self.max_offset())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viewport(extent: f32, offset: f32) -> ScrollViewport {
        let mut view = ScrollViewport::default();
        view.reconcile(
            Rect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 200.0,
            },
            [100.0, extent],
            false,
        );
        view.set_axis_offset(offset);
        view.update_scrollbar();
        view
    }

    #[test]
    fn scrollbar_reflects_ratio_and_offset_and_disappears_when_content_fits() {
        assert!(viewport(200.0, 0.0).scrollbar.is_none());
        let top = viewport(800.0, 0.0).scrollbar.unwrap();
        // 196pt track, 200/800 ratio -> 49pt thumb at the track start.
        assert!((top.thumb.height - 49.0).abs() < 0.01);
        assert_eq!(top.thumb.y, top.track.y);
        let bottom = viewport(800.0, 600.0).scrollbar.unwrap();
        assert!(
            (bottom.thumb.y + bottom.thumb.height - (bottom.track.y + bottom.track.height)).abs()
                < 0.01
        );
        // Huge content keeps a usable minimum thumb.
        assert_eq!(
            viewport(100_000.0, 0.0).scrollbar.unwrap().thumb.height,
            SCROLLBAR_MIN_THUMB
        );
    }

    #[test]
    fn thumb_drag_maps_track_travel_to_offset_range() {
        let view = viewport(800.0, 0.0);
        let bar = view.scrollbar.unwrap();
        let travel = bar.track.height - bar.thumb.height;
        let end = view
            .offset_for_thumb_position(bar.track.y + travel, 0.0)
            .unwrap();
        assert!((end - 600.0).abs() < 0.01);
        let middle = view
            .offset_for_thumb_position(bar.track.y + travel * 0.5, 0.0)
            .unwrap();
        assert!((middle - 300.0).abs() < 0.01);
        assert_eq!(view.offset_for_thumb_position(-500.0, 0.0), Some(0.0));
    }
}
