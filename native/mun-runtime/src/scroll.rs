//! Renderer-neutral scroll state and nested delta routing.
//!
//! Canonical ScrollDelta describes content movement: positive X/Y moves content
//! right/down. A scroll offset describes the viewport into content, so applying
//! input changes offset in the opposite direction. Unconsumed content delta is
//! returned for an ancestor scroll container to route.

use crate::{
    gesture::{VelocityTracker, VelocityTrackerConfig},
    input::ScrollDelta,
};

const RANGE_EPSILON: f32 = 1e-6;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScrollAxis {
    X,
    Y,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ScrollMetrics {
    pub viewport: f32,
    pub extent: f32,
}

impl ScrollMetrics {
    pub fn new(viewport: f32, extent: f32) -> Self {
        let viewport = finite_nonnegative(viewport);
        let extent = finite_nonnegative(extent).max(viewport);
        Self { viewport, extent }
    }

    pub fn max_offset(self) -> f32 {
        (self.extent - self.viewport).max(0.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollRange {
    pub start: f32,
    pub end: f32,
    pub span: f32,
}

impl ScrollRange {
    pub fn new(start: f32, end: f32) -> Self {
        let start = finite_or(start, 0.0);
        let end = finite_or(end, start);
        Self {
            start,
            end,
            span: end - start,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollState {
    pub offset: f32,
    pub velocity: f32,
    pub progress: f32,
    pub progress_velocity: f32,
    pub range: ScrollRange,
}

#[derive(Clone, Debug)]
pub struct ScrollTracker {
    range: ScrollRange,
    clamp_progress: bool,
    offset: f32,
    velocity: f32,
    progress: f32,
    progress_velocity: f32,
    velocity_tracker: VelocityTracker,
}

impl ScrollTracker {
    pub fn new(
        range: ScrollRange,
        clamp_progress: bool,
        initial_offset: f32,
        velocity: VelocityTrackerConfig,
        time_seconds: f64,
    ) -> Self {
        let initial_offset = finite_or(initial_offset, 0.0);
        let mut tracker = Self {
            range,
            clamp_progress,
            offset: initial_offset,
            velocity: 0.0,
            progress: 0.0,
            progress_velocity: 0.0,
            velocity_tracker: VelocityTracker::new(velocity),
        };
        tracker
            .velocity_tracker
            .reset(initial_offset as f64, time_seconds);
        tracker.update_derived(0.0);
        tracker
    }

    pub fn set_range(&mut self, range: ScrollRange, time_seconds: f64) -> ScrollState {
        self.range = range;
        self.reset(self.offset, time_seconds)
    }

    pub fn sample(&mut self, offset: f32, time_seconds: f64) -> ScrollState {
        let offset = finite_or(offset, self.offset);
        self.velocity_tracker.add(offset as f64, time_seconds);
        let velocity = self.velocity_tracker.velocity() as f32;
        self.offset = offset;
        self.update_derived(velocity);
        self.state()
    }

    pub fn reset(&mut self, offset: f32, time_seconds: f64) -> ScrollState {
        let offset = finite_or(offset, self.offset);
        self.velocity_tracker.reset(offset as f64, time_seconds);
        self.offset = offset;
        self.update_derived(0.0);
        self.state()
    }

    pub fn state(&self) -> ScrollState {
        ScrollState {
            offset: self.offset,
            velocity: self.velocity,
            progress: self.progress,
            progress_velocity: self.progress_velocity,
            range: self.range,
        }
    }

    fn update_derived(&mut self, velocity: f32) {
        self.velocity = velocity;
        if self.range.span.abs() <= RANGE_EPSILON {
            self.progress = 0.0;
            self.progress_velocity = 0.0;
            return;
        }

        let raw = (self.offset - self.range.start) / self.range.span;
        self.progress = if self.clamp_progress {
            raw.clamp(0.0, 1.0)
        } else {
            raw
        };
        self.progress_velocity = if self.clamp_progress && !(0.0..=1.0).contains(&raw) {
            0.0
        } else {
            velocity / self.range.span
        };
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollRouteResult {
    pub state: ScrollState,
    /// Content-space delta consumed by this container.
    pub consumed: f32,
    /// Content-space delta left for an ancestor container.
    pub remaining: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NestedScrollRouteResult {
    /// Total content-space delta consumed by the inner-to-outer chain.
    pub consumed: f32,
    /// Content-space delta still unconsumed after the outermost container.
    pub remaining: f32,
}

#[derive(Clone, Debug)]
pub struct ScrollContainerState {
    axis: ScrollAxis,
    metrics: ScrollMetrics,
    tracker: ScrollTracker,
}

impl ScrollContainerState {
    pub fn new(
        axis: ScrollAxis,
        metrics: ScrollMetrics,
        initial_offset: f32,
        velocity: VelocityTrackerConfig,
        time_seconds: f64,
    ) -> Self {
        let metrics = ScrollMetrics::new(metrics.viewport, metrics.extent);
        let offset = finite_or(initial_offset, 0.0).clamp(0.0, metrics.max_offset());
        Self {
            axis,
            metrics,
            tracker: ScrollTracker::new(
                ScrollRange::new(0.0, metrics.max_offset()),
                true,
                offset,
                velocity,
                time_seconds,
            ),
        }
    }

    pub fn axis(&self) -> ScrollAxis {
        self.axis
    }

    pub fn metrics(&self) -> ScrollMetrics {
        self.metrics
    }

    pub fn state(&self) -> ScrollState {
        self.tracker.state()
    }

    pub fn set_metrics(&mut self, metrics: ScrollMetrics, time_seconds: f64) -> ScrollState {
        self.metrics = ScrollMetrics::new(metrics.viewport, metrics.extent);
        let offset = self
            .tracker
            .state()
            .offset
            .clamp(0.0, self.metrics.max_offset());
        self.tracker.set_range(
            ScrollRange::new(0.0, self.metrics.max_offset()),
            time_seconds,
        );
        self.tracker.reset(offset, time_seconds)
    }

    pub fn route_delta(
        &mut self,
        delta: ScrollDelta,
        line_extent: f32,
        time_seconds: f64,
    ) -> ScrollRouteResult {
        let content_delta = self.content_delta(delta, line_extent);
        self.route_content_delta(content_delta, time_seconds)
    }

    pub fn route_content_delta(
        &mut self,
        content_delta: f32,
        time_seconds: f64,
    ) -> ScrollRouteResult {
        let content_delta = finite_or(content_delta, 0.0);
        let before = self.tracker.state().offset;
        let desired_offset = before - content_delta;
        let next = desired_offset.clamp(0.0, self.metrics.max_offset());
        let consumed_offset = next - before;
        let consumed_content = -consumed_offset;
        let remaining = content_delta - consumed_content;
        let state = if (next - before).abs() <= f32::EPSILON {
            self.tracker.state()
        } else {
            self.tracker.sample(next, time_seconds)
        };

        ScrollRouteResult {
            state,
            consumed: consumed_content,
            remaining,
        }
    }

    fn content_delta(&self, delta: ScrollDelta, line_extent: f32) -> f32 {
        let line_extent = finite_nonnegative(line_extent);
        match (self.axis, delta) {
            (ScrollAxis::X, ScrollDelta::Lines { x, .. }) => x * line_extent,
            (ScrollAxis::Y, ScrollDelta::Lines { y, .. }) => y * line_extent,
            (ScrollAxis::X, ScrollDelta::Pixels { x, .. }) => x,
            (ScrollAxis::Y, ScrollDelta::Pixels { y, .. }) => y,
        }
    }
}

/// Route one same-axis content delta from the innermost scroll container to
/// successive ancestors. Containers are mutated in slice order.
///
/// This deliberately operates on already-resolved content-space delta rather
/// than platform line/pixel units, so unit normalization happens exactly once.
pub fn route_nested_content_delta(
    containers: &mut [ScrollContainerState],
    content_delta: f32,
    time_seconds: f64,
) -> NestedScrollRouteResult {
    let input = finite_or(content_delta, 0.0);
    let Some(axis) = containers.first().map(ScrollContainerState::axis) else {
        return NestedScrollRouteResult {
            consumed: 0.0,
            remaining: input,
        };
    };

    assert!(
        containers.iter().all(|container| container.axis() == axis),
        "nested scroll routing requires one semantic axis"
    );

    let mut remaining = input;
    for container in containers {
        let routed = container.route_content_delta(remaining, time_seconds);
        remaining = routed.remaining;
        if remaining.abs() <= f32::EPSILON {
            remaining = 0.0;
            break;
        }
    }

    NestedScrollRouteResult {
        consumed: input - remaining,
        remaining,
    }
}

fn finite_or(value: f32, fallback: f32) -> f32 {
    if value.is_finite() { value } else { fallback }
}

fn finite_nonnegative(value: f32) -> f32 {
    finite_or(value, 0.0).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn velocity_config() -> VelocityTrackerConfig {
        VelocityTrackerConfig::default()
    }

    #[test]
    fn scroll_tracker_recovers_progress_and_progress_velocity() {
        let mut tracker = ScrollTracker::new(
            ScrollRange::new(0.0, 100.0),
            true,
            0.0,
            velocity_config(),
            0.0,
        );

        tracker.sample(25.0, 0.05);
        let state = tracker.sample(50.0, 0.10);
        assert!((state.progress - 0.5).abs() < 0.001);
        assert!(state.velocity > 0.0);
        assert!((state.progress_velocity - state.velocity / 100.0).abs() < 0.001);
    }

    #[test]
    fn clamped_progress_zeroes_velocity_outside_range() {
        let mut tracker = ScrollTracker::new(
            ScrollRange::new(0.0, 100.0),
            true,
            0.0,
            velocity_config(),
            0.0,
        );

        let state = tracker.sample(120.0, 0.05);
        assert_eq!(state.progress, 1.0);
        assert_eq!(state.progress_velocity, 0.0);
        assert!(state.velocity > 0.0);
    }

    #[test]
    fn zero_span_scroll_range_has_stable_zero_progress() {
        let mut tracker = ScrollTracker::new(
            ScrollRange::new(10.0, 10.0),
            true,
            10.0,
            velocity_config(),
            0.0,
        );

        let state = tracker.sample(20.0, 0.05);
        assert_eq!(state.progress, 0.0);
        assert_eq!(state.progress_velocity, 0.0);
    }

    #[test]
    fn container_routes_content_motion_into_inverse_viewport_offset() {
        let mut scroll = ScrollContainerState::new(
            ScrollAxis::Y,
            ScrollMetrics::new(100.0, 300.0),
            100.0,
            velocity_config(),
            0.0,
        );

        let result = scroll.route_delta(ScrollDelta::Pixels { x: 0.0, y: 30.0 }, 16.0, 0.05);
        assert_eq!(result.state.offset, 70.0);
        assert_eq!(result.consumed, 30.0);
        assert_eq!(result.remaining, 0.0);
    }

    #[test]
    fn nested_scroll_routing_returns_unconsumed_delta_at_bounds() {
        let mut child = ScrollContainerState::new(
            ScrollAxis::Y,
            ScrollMetrics::new(100.0, 200.0),
            10.0,
            velocity_config(),
            0.0,
        );

        let result = child.route_content_delta(30.0, 0.05);
        assert_eq!(result.state.offset, 0.0);
        assert_eq!(result.consumed, 10.0);
        assert_eq!(result.remaining, 20.0);

        let result = child.route_content_delta(15.0, 0.10);
        assert_eq!(result.state.offset, 0.0);
        assert_eq!(result.consumed, 0.0);
        assert_eq!(result.remaining, 15.0);
    }

    #[test]
    fn nested_scroll_chain_routes_remainder_inner_to_outer() {
        let mut chain = [
            ScrollContainerState::new(
                ScrollAxis::Y,
                ScrollMetrics::new(100.0, 180.0),
                10.0,
                velocity_config(),
                0.0,
            ),
            ScrollContainerState::new(
                ScrollAxis::Y,
                ScrollMetrics::new(200.0, 500.0),
                80.0,
                velocity_config(),
                0.0,
            ),
        ];

        let result = route_nested_content_delta(&mut chain, 50.0, 0.05);
        assert_eq!(result.consumed, 50.0);
        assert_eq!(result.remaining, 0.0);
        assert_eq!(chain[0].state().offset, 0.0);
        assert_eq!(chain[1].state().offset, 40.0);
    }

    #[test]
    fn nested_scroll_chain_preserves_outermost_remainder() {
        let mut chain = [
            ScrollContainerState::new(
                ScrollAxis::Y,
                ScrollMetrics::new(100.0, 180.0),
                0.0,
                velocity_config(),
                0.0,
            ),
            ScrollContainerState::new(
                ScrollAxis::Y,
                ScrollMetrics::new(200.0, 240.0),
                0.0,
                velocity_config(),
                0.0,
            ),
        ];

        let result = route_nested_content_delta(&mut chain, 30.0, 0.05);
        assert_eq!(result.consumed, 0.0);
        assert_eq!(result.remaining, 30.0);
    }

    #[test]
    #[should_panic(expected = "nested scroll routing requires one semantic axis")]
    fn nested_scroll_chain_rejects_cross_axis_arbitration() {
        let mut chain = [
            ScrollContainerState::new(
                ScrollAxis::Y,
                ScrollMetrics::new(100.0, 200.0),
                50.0,
                velocity_config(),
                0.0,
            ),
            ScrollContainerState::new(
                ScrollAxis::X,
                ScrollMetrics::new(100.0, 200.0),
                50.0,
                velocity_config(),
                0.0,
            ),
        ];

        let _ = route_nested_content_delta(&mut chain, 10.0, 0.05);
    }

    #[test]
    fn line_deltas_are_scaled_only_when_the_container_resolves_them() {
        let mut scroll = ScrollContainerState::new(
            ScrollAxis::X,
            ScrollMetrics::new(100.0, 300.0),
            100.0,
            velocity_config(),
            0.0,
        );

        let result = scroll.route_delta(ScrollDelta::Lines { x: -2.0, y: 50.0 }, 12.0, 0.05);
        assert_eq!(result.state.offset, 124.0);
        assert_eq!(result.consumed, -24.0);
        assert_eq!(result.remaining, 0.0);
    }

    #[test]
    fn changing_metrics_clamps_offset_and_resets_velocity() {
        let mut scroll = ScrollContainerState::new(
            ScrollAxis::Y,
            ScrollMetrics::new(100.0, 400.0),
            250.0,
            velocity_config(),
            0.0,
        );
        scroll.route_content_delta(-20.0, 0.05);

        let state = scroll.set_metrics(ScrollMetrics::new(100.0, 180.0), 0.10);
        assert_eq!(state.offset, 80.0);
        assert_eq!(state.velocity, 0.0);
        assert_eq!(state.progress, 1.0);
    }
}
