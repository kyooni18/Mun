//! Renderer-neutral gesture recognition recovered from Mün's inherited animation stack.
//!
//! This layer owns pointer-sample interpretation only. It reports semantic drag state
//! and release velocity; kinetic continuation remains owned by the motion scheduler.

use std::collections::VecDeque;

use crate::input::{InputPoint, PointerId};

const DEFAULT_WINDOW_SECONDS: f64 = 0.120;
const DEFAULT_MAX_SAMPLES: usize = 12;
const DEFAULT_MAX_VELOCITY: f64 = 100_000.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VelocityTrackerConfig {
    pub window_seconds: f64,
    pub max_samples: usize,
    pub max_velocity: f64,
}

impl Default for VelocityTrackerConfig {
    fn default() -> Self {
        Self {
            window_seconds: DEFAULT_WINDOW_SECONDS,
            max_samples: DEFAULT_MAX_SAMPLES,
            max_velocity: DEFAULT_MAX_VELOCITY,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct VelocitySample {
    value: f64,
    time_seconds: f64,
}

#[derive(Clone, Debug)]
pub struct VelocityTracker {
    config: VelocityTrackerConfig,
    samples: VecDeque<VelocitySample>,
}

impl Default for VelocityTracker {
    fn default() -> Self {
        Self::new(VelocityTrackerConfig::default())
    }
}

impl VelocityTracker {
    pub fn new(config: VelocityTrackerConfig) -> Self {
        let config = VelocityTrackerConfig {
            window_seconds: finite_or(config.window_seconds, DEFAULT_WINDOW_SECONDS).max(0.016),
            max_samples: config.max_samples.max(2),
            max_velocity: finite_or(config.max_velocity, DEFAULT_MAX_VELOCITY)
                .abs()
                .max(1.0),
        };
        Self {
            samples: VecDeque::with_capacity(config.max_samples),
            config,
        }
    }

    pub fn reset(&mut self, value: f64, time_seconds: f64) {
        self.samples.clear();
        self.add(value, time_seconds);
    }

    pub fn add(&mut self, value: f64, time_seconds: f64) {
        let value = finite_or(value, 0.0);
        let time_seconds = if time_seconds.is_finite() {
            time_seconds
        } else {
            self.samples
                .back()
                .map(|sample| sample.time_seconds)
                .unwrap_or(0.0)
        };

        if let Some(last) = self.samples.back_mut() {
            if time_seconds < last.time_seconds {
                return;
            }
            if time_seconds == last.time_seconds {
                last.value = value;
                return;
            }
        }

        if self.samples.len() == self.config.max_samples {
            self.samples.pop_front();
        }
        self.samples.push_back(VelocitySample {
            value,
            time_seconds,
        });

        let cutoff = time_seconds - self.config.window_seconds;
        while self.samples.len() > 2
            && self
                .samples
                .front()
                .is_some_and(|sample| sample.time_seconds < cutoff)
        {
            self.samples.pop_front();
        }
    }

    pub fn velocity(&self) -> f64 {
        if self.samples.len() < 2 {
            return 0.0;
        }

        let latest = self
            .samples
            .back()
            .expect("velocity tracker has samples")
            .time_seconds;
        let weight_scale = 0.024_f64.max(self.config.window_seconds * 0.55);
        let mut weight_sum = 0.0;
        let mut mean_time = 0.0;
        let mut mean_value = 0.0;

        for sample in &self.samples {
            let age = latest - sample.time_seconds;
            let weight = (-age / weight_scale).exp();
            let relative_time = sample.time_seconds - latest;
            weight_sum += weight;
            mean_time += relative_time * weight;
            mean_value += sample.value * weight;
        }

        if weight_sum <= 0.0 {
            return 0.0;
        }
        mean_time /= weight_sum;
        mean_value /= weight_sum;

        let mut numerator = 0.0;
        let mut denominator = 0.0;
        for sample in &self.samples {
            let age = latest - sample.time_seconds;
            let weight = (-age / weight_scale).exp();
            let time = sample.time_seconds - latest - mean_time;
            let value = sample.value - mean_value;
            numerator += weight * time * value;
            denominator += weight * time * time;
        }

        if denominator < 1e-9 {
            return 0.0;
        }

        (numerator / denominator).clamp(-self.config.max_velocity, self.config.max_velocity)
    }

    pub fn sample_count(&self) -> usize {
        self.samples.len()
    }
}

pub fn rubber_band_distance(distance: f32, dimension: f32, constant: f32) -> f32 {
    let sign = distance.signum();
    let distance = finite_f32_or(distance, 0.0).abs();
    let dimension = finite_f32_or(dimension, 320.0).abs().max(1.0);
    let constant = finite_f32_or(constant, 0.55).max(0.0);
    if distance == 0.0 || constant == 0.0 {
        return 0.0;
    }

    sign * ((distance * constant * dimension) / (dimension + constant * distance))
}

pub fn constrain_with_rubber_band(
    value: f32,
    min: f32,
    max: f32,
    enabled: bool,
    constant: f32,
    dimension: Option<f32>,
) -> f32 {
    assert!(min <= max, "gesture min cannot be greater than max");

    if value < min {
        if !enabled {
            return min;
        }
        let size = dimension.unwrap_or_else(|| {
            if (max - min).is_finite() {
                max - min
            } else {
                320.0
            }
        });
        return min + rubber_band_distance(value - min, size, constant);
    }

    if value > max {
        if !enabled {
            return max;
        }
        let size = dimension.unwrap_or_else(|| {
            if (max - min).is_finite() {
                max - min
            } else {
                320.0
            }
        });
        return max + rubber_band_distance(value - max, size, constant);
    }

    value
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DragAxis {
    X,
    Y,
    Both,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GesturePhase {
    Began,
    Changed,
    Ended,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DragRecognizerConfig {
    pub axis: DragAxis,
    pub direction_lock: bool,
    pub direction_lock_threshold: f32,
    pub velocity: VelocityTrackerConfig,
}

impl Default for DragRecognizerConfig {
    fn default() -> Self {
        Self {
            axis: DragAxis::Both,
            direction_lock: false,
            direction_lock_threshold: 8.0,
            velocity: VelocityTrackerConfig::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GestureAxisRelease {
    pub position: f32,
    pub velocity: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DragState {
    pub phase: GesturePhase,
    pub pointer: PointerId,
    pub start: InputPoint,
    pub position: InputPoint,
    pub translation: InputPoint,
    pub velocity: InputPoint,
    pub locked_axis: Option<DragAxis>,
}

impl DragState {
    pub fn release(&self, axis: DragAxis) -> Option<GestureAxisRelease> {
        match axis {
            DragAxis::X if self.locked_axis != Some(DragAxis::Y) => Some(GestureAxisRelease {
                position: self.translation.x,
                velocity: self.velocity.x,
            }),
            DragAxis::Y if self.locked_axis != Some(DragAxis::X) => Some(GestureAxisRelease {
                position: self.translation.y,
                velocity: self.velocity.y,
            }),
            DragAxis::Both => None,
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct DragRecognizer {
    config: DragRecognizerConfig,
    active_pointer: Option<PointerId>,
    start: InputPoint,
    position: InputPoint,
    locked_axis: Option<DragAxis>,
    tracker_x: VelocityTracker,
    tracker_y: VelocityTracker,
}

impl DragRecognizer {
    pub fn new(config: DragRecognizerConfig) -> Self {
        let velocity = config.velocity;
        Self {
            config: DragRecognizerConfig {
                direction_lock_threshold: finite_f32_or(config.direction_lock_threshold, 8.0)
                    .max(0.0),
                ..config
            },
            active_pointer: None,
            start: InputPoint::default(),
            position: InputPoint::default(),
            locked_axis: None,
            tracker_x: VelocityTracker::new(velocity),
            tracker_y: VelocityTracker::new(velocity),
        }
    }

    pub fn is_active(&self) -> bool {
        self.active_pointer.is_some()
    }

    pub fn begin(
        &mut self,
        pointer: PointerId,
        position: InputPoint,
        time_seconds: f64,
    ) -> DragState {
        self.active_pointer = Some(pointer);
        self.start = position;
        self.position = position;
        self.locked_axis = None;
        self.tracker_x.reset(position.x as f64, time_seconds);
        self.tracker_y.reset(position.y as f64, time_seconds);
        self.state(GesturePhase::Began)
    }

    pub fn move_pointer(
        &mut self,
        pointer: PointerId,
        position: InputPoint,
        time_seconds: f64,
    ) -> Option<DragState> {
        if self.active_pointer != Some(pointer) {
            return None;
        }

        self.position = position;
        self.tracker_x.add(position.x as f64, time_seconds);
        self.tracker_y.add(position.y as f64, time_seconds);
        self.resolve_direction_lock();
        Some(self.state(GesturePhase::Changed))
    }

    pub fn end(&mut self, pointer: PointerId, time_seconds: f64) -> Option<DragState> {
        if self.active_pointer != Some(pointer) {
            return None;
        }

        self.tracker_x.add(self.position.x as f64, time_seconds);
        self.tracker_y.add(self.position.y as f64, time_seconds);
        self.resolve_direction_lock();
        let state = self.state(GesturePhase::Ended);
        self.active_pointer = None;
        Some(state)
    }

    pub fn cancel(&mut self, pointer: Option<PointerId>) -> Option<DragState> {
        let active = self.active_pointer?;
        if pointer.is_some() && pointer != Some(active) {
            return None;
        }

        let mut state = self.state(GesturePhase::Cancelled);
        state.velocity = InputPoint::default();
        self.active_pointer = None;
        Some(state)
    }

    fn resolve_direction_lock(&mut self) {
        if !self.config.direction_lock || self.locked_axis.is_some() {
            return;
        }

        let dx = self.position.x - self.start.x;
        let dy = self.position.y - self.start.y;
        if dx.hypot(dy) < self.config.direction_lock_threshold {
            return;
        }

        self.locked_axis = Some(match self.config.axis {
            DragAxis::X => DragAxis::X,
            DragAxis::Y => DragAxis::Y,
            DragAxis::Both => {
                if dx.abs() >= dy.abs() {
                    DragAxis::X
                } else {
                    DragAxis::Y
                }
            }
        });
    }

    fn state(&self, phase: GesturePhase) -> DragState {
        let dx = self.position.x - self.start.x;
        let dy = self.position.y - self.start.y;
        let (translation, velocity) = if self.config.direction_lock && self.locked_axis.is_none() {
            (InputPoint::default(), InputPoint::default())
        } else {
            (
                self.filter_axes(InputPoint::new(dx, dy)),
                self.filter_axes(InputPoint::new(
                    self.tracker_x.velocity() as f32,
                    self.tracker_y.velocity() as f32,
                )),
            )
        };

        DragState {
            phase,
            pointer: self
                .active_pointer
                .expect("drag state requires an active pointer"),
            start: self.start,
            position: self.position,
            translation,
            velocity,
            locked_axis: self.locked_axis.or(match self.config.axis {
                DragAxis::X => Some(DragAxis::X),
                DragAxis::Y => Some(DragAxis::Y),
                DragAxis::Both => None,
            }),
        }
    }

    fn filter_axes(&self, point: InputPoint) -> InputPoint {
        match self.locked_axis.unwrap_or(self.config.axis) {
            DragAxis::X => InputPoint::new(point.x, 0.0),
            DragAxis::Y => InputPoint::new(0.0, point.y),
            DragAxis::Both => point,
        }
    }
}

fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() { value } else { fallback }
}

fn finite_f32_or(value: f32, fallback: f32) -> f32 {
    if value.is_finite() { value } else { fallback }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ir::MotionProperty,
        motion::{InertiaSpec, KineticSpec, MotionChannelKey, MotionScheduler},
    };

    fn point(x: f32, y: f32) -> InputPoint {
        InputPoint::new(x, y)
    }

    #[test]
    fn velocity_tracker_recovers_weighted_linear_velocity() {
        let mut tracker = VelocityTracker::default();
        tracker.reset(0.0, 0.0);
        tracker.add(4.0, 0.04);
        tracker.add(8.0, 0.08);
        tracker.add(12.0, 0.12);

        assert!((tracker.velocity() - 100.0).abs() < 0.001);
    }

    #[test]
    fn velocity_tracker_replaces_equal_time_and_ignores_time_regression() {
        let mut tracker = VelocityTracker::default();
        tracker.reset(0.0, 0.0);
        tracker.add(5.0, 0.05);
        tracker.add(6.0, 0.05);
        tracker.add(100.0, 0.04);

        assert_eq!(tracker.sample_count(), 2);
        assert!((tracker.velocity() - 120.0).abs() < 0.001);
    }

    #[test]
    fn velocity_tracker_trims_old_samples_but_keeps_regression_pair() {
        let mut tracker = VelocityTracker::new(VelocityTrackerConfig {
            window_seconds: 0.016,
            max_samples: 4,
            max_velocity: 100_000.0,
        });
        tracker.reset(0.0, 0.0);
        tracker.add(1.0, 0.010);
        tracker.add(2.0, 0.020);
        tracker.add(10.0, 1.0);

        assert_eq!(tracker.sample_count(), 2);
    }

    #[test]
    fn drag_direction_lock_waits_for_threshold_and_filters_velocity() {
        let mut drag = DragRecognizer::new(DragRecognizerConfig {
            direction_lock: true,
            direction_lock_threshold: 8.0,
            ..Default::default()
        });

        let began = drag.begin(PointerId(7), point(0.0, 0.0), 0.0);
        assert_eq!(began.phase, GesturePhase::Began);
        assert_eq!(began.translation, point(0.0, 0.0));

        let pending = drag
            .move_pointer(PointerId(7), point(4.0, 3.0), 0.04)
            .expect("active pointer move");
        assert_eq!(pending.locked_axis, None);
        assert_eq!(pending.translation, point(0.0, 0.0));

        let changed = drag
            .move_pointer(PointerId(7), point(12.0, 5.0), 0.08)
            .expect("direction-locking move");
        assert_eq!(changed.locked_axis, Some(DragAxis::X));
        assert_eq!(changed.translation, point(12.0, 0.0));
        assert_eq!(changed.velocity.y, 0.0);
        assert!(changed.velocity.x > 0.0);

        let ended = drag.end(PointerId(7), 0.10).expect("drag end");
        assert_eq!(ended.phase, GesturePhase::Ended);
        assert_eq!(ended.locked_axis, Some(DragAxis::X));
        assert!(!drag.is_active());
    }

    #[test]
    fn drag_ignores_non_owner_pointer_and_cancels_owner() {
        let mut drag = DragRecognizer::new(Default::default());
        drag.begin(PointerId(1), point(10.0, 20.0), 0.0);

        assert!(
            drag.move_pointer(PointerId(2), point(30.0, 40.0), 0.02)
                .is_none()
        );
        assert!(drag.cancel(Some(PointerId(2))).is_none());

        let cancelled = drag.cancel(Some(PointerId(1))).expect("owner cancellation");
        assert_eq!(cancelled.phase, GesturePhase::Cancelled);
        assert_eq!(cancelled.velocity, point(0.0, 0.0));
        assert!(!drag.is_active());
    }

    #[test]
    fn drag_release_velocity_hands_off_to_existing_motion_scheduler() {
        let mut drag = DragRecognizer::new(DragRecognizerConfig {
            axis: DragAxis::X,
            ..Default::default()
        });
        let pointer = PointerId(17);
        drag.begin(pointer, point(0.0, 0.0), 0.0);
        drag.move_pointer(pointer, point(12.0, 0.0), 0.04)
            .expect("drag sample");
        drag.move_pointer(pointer, point(28.0, 0.0), 0.08)
            .expect("drag sample");
        let ended = drag.end(pointer, 0.10).expect("drag release");
        let release = ended.release(DragAxis::X).expect("x-axis release");
        assert!(release.velocity > 0.0);

        let key = MotionChannelKey {
            node_id: "drag-target".into(),
            property: MotionProperty::TranslationX,
        };
        let mut scheduler = MotionScheduler::default();
        let spec = KineticSpec::Inertia(InertiaSpec {
            velocity: Some(release.velocity as f64),
            power: 1.0,
            min: -500.0,
            max: 500.0,
            ..Default::default()
        });
        scheduler
            .animate_velocity(key.clone(), release.position, &spec)
            .expect("kinetic handoff");

        let start = scheduler.value(&key).expect("kinetic presentation");
        let velocity = scheduler.velocity(&key).expect("kinetic velocity");
        assert!((start - release.position).abs() < 0.001);
        assert!((velocity - release.velocity).abs() < 0.001);

        scheduler.step(1.0 / 60.0);
        assert!(scheduler.value(&key).expect("advanced presentation") > start);
    }

    #[test]
    fn rubber_band_matches_inherited_bounded_constraint() {
        let constrained = constrain_with_rubber_band(120.0, 0.0, 100.0, true, 0.55, Some(100.0));
        assert!(constrained > 100.0);
        assert!(constrained < 120.0);

        assert_eq!(
            constrain_with_rubber_band(120.0, 0.0, 100.0, false, 0.55, Some(100.0)),
            100.0
        );
        assert_eq!(
            constrain_with_rubber_band(40.0, 0.0, 100.0, true, 0.55, Some(100.0)),
            40.0
        );
    }
}
