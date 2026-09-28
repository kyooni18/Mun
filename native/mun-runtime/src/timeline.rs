//! Renderer-neutral playback clock ported from the existing Mün runtime's `TimelinePlayer`.
//!
//! This module owns renderer-neutral time/iteration/direction mapping plus the
//! first scalar numeric keyframe execution primitive. It does not know about
//! scene nodes, layout, wgpu, or platform widgets, so future timeline bindings
//! can reuse these contracts without redefining repeat, seek, or reverse semantics.

use std::{error::Error, fmt};

const EPSILON: f64 = 1e-9;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimelineDirection {
    Normal,
    Reverse,
    Alternate,
    AlternateReverse,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TimelineMapping {
    pub iteration: u64,
    pub local_time: f64,
    pub sign: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TimelineClock {
    duration: f64,
    iterations: Option<u64>,
    direction: TimelineDirection,
    elapsed_time: f64,
    playback_rate: f64,
}

impl TimelineClock {
    pub fn new(duration: f64, iterations: Option<u64>, direction: TimelineDirection) -> Self {
        assert!(
            duration.is_finite() && duration >= 0.0,
            "timeline duration must be finite and non-negative"
        );
        if let Some(iterations) = iterations {
            assert!(iterations >= 1, "timeline iterations must be at least one");
        }
        Self {
            duration,
            iterations,
            direction,
            elapsed_time: 0.0,
            playback_rate: 1.0,
        }
    }

    pub fn duration(&self) -> f64 {
        self.duration
    }

    pub fn elapsed_time(&self) -> f64 {
        self.elapsed_time
    }

    pub fn playback_rate(&self) -> f64 {
        self.playback_rate
    }

    pub fn set_playback_rate(&mut self, rate: f64) {
        assert!(rate.is_finite(), "timeline playback rate must be finite");
        self.playback_rate = rate;
    }

    pub fn reverse(&mut self) {
        self.playback_rate = if self.playback_rate == 0.0 {
            -1.0
        } else {
            -self.playback_rate
        };
    }

    pub fn total_duration(&self) -> Option<f64> {
        self.iterations
            .map(|iterations| self.duration * iterations as f64)
    }

    /// Prevent future repeat cycles while allowing the currently sampled cycle
    /// to finish. This matches the existing Mün runtime's generation-based delayed-retarget handoff:
    /// the in-flight control keeps running, but its repeat wrapper is superseded.
    pub fn stop_after_current_iteration(&mut self) {
        let current = self.current_mapping().iteration;
        self.iterations = Some(current.saturating_add(1));
    }

    pub fn mapping(&self, raw_time: f64, traversal: f64) -> TimelineMapping {
        map_time(
            self.duration,
            self.iterations,
            self.direction,
            raw_time,
            traversal,
        )
    }

    pub fn current_mapping(&self) -> TimelineMapping {
        self.mapping(self.elapsed_time, self.playback_rate)
    }

    /// Seek by timeline-local time within an iteration, preserving the existing Mün runtime's
    /// direction-aware raw-time mapping.
    pub fn seek(&mut self, local_time: f64, iteration: u64) -> TimelineMapping {
        if self.duration <= EPSILON {
            self.elapsed_time = 0.0;
            return self.current_mapping();
        }
        let resolved_iteration = match self.iterations {
            Some(iterations) => iteration.min(iterations - 1),
            None => iteration,
        };
        let local = local_time.clamp(0.0, self.duration);
        let sign = direction_sign(self.direction, resolved_iteration);
        let raw_phase = if sign > 0.0 {
            local
        } else {
            self.duration - local
        };
        self.elapsed_time = resolved_iteration as f64 * self.duration + raw_phase;
        self.mapping(self.elapsed_time, 0.0)
    }

    pub fn seek_progress(&mut self, progress: f64, iteration: u64) -> TimelineMapping {
        self.seek(progress.clamp(0.0, 1.0) * self.duration, iteration)
    }

    pub fn seek_elapsed(&mut self, elapsed: f64) -> TimelineMapping {
        let mut raw = elapsed.max(0.0);
        if let Some(total) = self.total_duration() {
            raw = raw.min(total);
        }
        self.elapsed_time = raw;
        self.mapping(raw, 0.0)
    }

    /// Advance the clock in O(1), including across arbitrarily many repeats.
    /// Returns the sampled mapping, number of crossed iteration boundaries, and
    /// whether finite playback reached an endpoint.
    pub fn step(&mut self, dt_seconds: f64) -> TimelineStep {
        let previous = self.current_mapping();
        if !dt_seconds.is_finite() || dt_seconds <= 0.0 || self.playback_rate == 0.0 {
            return TimelineStep {
                mapping: previous,
                crossed_iterations: 0,
                finished: false,
            };
        }
        if self.duration <= EPSILON {
            return TimelineStep {
                mapping: previous,
                crossed_iterations: 0,
                finished: true,
            };
        }

        let mut next = self.elapsed_time + dt_seconds * self.playback_rate;
        let mut finished = false;
        if let Some(total) = self.total_duration() {
            if self.playback_rate > 0.0 && next >= total - EPSILON {
                next = total;
                finished = true;
            } else if self.playback_rate < 0.0 && next <= EPSILON {
                next = 0.0;
                finished = true;
            }
        } else if self.playback_rate < 0.0 && next <= EPSILON {
            next = 0.0;
            finished = true;
        }
        if next < 0.0 {
            next = 0.0;
        }

        self.elapsed_time = next;
        let mapping = self.mapping(next, self.playback_rate);
        let crossed_iterations = mapping.iteration as i64 - previous.iteration as i64;
        TimelineStep {
            mapping,
            crossed_iterations,
            finished,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TimelineStep {
    pub mapping: TimelineMapping,
    /// Signed count, matching the existing Mün runtime's `onRepeat(iteration, player, crossed)`.
    pub crossed_iterations: i64,
    pub finished: bool,
}

pub fn direction_sign(direction: TimelineDirection, iteration: u64) -> f64 {
    match direction {
        TimelineDirection::Reverse => -1.0,
        TimelineDirection::Alternate => {
            if iteration % 2 == 0 {
                1.0
            } else {
                -1.0
            }
        }
        TimelineDirection::AlternateReverse => {
            if iteration % 2 == 0 {
                -1.0
            } else {
                1.0
            }
        }
        TimelineDirection::Normal => 1.0,
    }
}

pub fn map_time(
    duration: f64,
    iterations: Option<u64>,
    direction: TimelineDirection,
    raw_time: f64,
    traversal: f64,
) -> TimelineMapping {
    if duration <= EPSILON {
        return TimelineMapping {
            iteration: 0,
            local_time: 0.0,
            sign: 1.0,
        };
    }

    let total = iterations.map(|iterations| duration * iterations as f64);
    let mut raw = raw_time.max(0.0);
    if let Some(total) = total {
        raw = raw.min(total);
    }

    let (iteration, phase) = if total.is_some_and(|total| raw >= total - EPSILON) {
        let iterations = iterations.expect("finite total requires finite iterations");
        (iterations.saturating_sub(1), duration)
    } else {
        let boundary = (raw / duration).round();
        let on_boundary = raw > 0.0 && (raw - boundary * duration).abs() <= EPSILON;
        if traversal < 0.0 && on_boundary {
            (boundary.max(1.0) as u64 - 1, duration)
        } else {
            let iteration = (raw / duration).floor().max(0.0) as u64;
            (iteration, raw - iteration as f64 * duration)
        }
    };

    let sign = direction_sign(direction, iteration);
    let local_time = if sign > 0.0 { phase } else { duration - phase };
    TimelineMapping {
        iteration,
        local_time: local_time.clamp(0.0, duration),
        sign,
    }
}

const EASING_LUT_SIZE: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TimelineEasing {
    Linear,
    CubicBezier([f64; 4]),
}

impl Default for TimelineEasing {
    fn default() -> Self {
        Self::Linear
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScalarKeyframe {
    pub at: f64,
    pub value: f64,
    /// Segment easing beginning at this frame. The final frame's easing is
    /// ignored, matching the inherited `Timeline` numeric keyframe track.
    pub easing: TimelineEasing,
}

impl ScalarKeyframe {
    pub fn linear(at: f64, value: f64) -> Self {
        Self {
            at,
            value,
            easing: TimelineEasing::Linear,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimelineTrackError {
    Empty,
    NonFiniteTime,
    NegativeTime,
    NonFiniteValue,
    NonFiniteDuration,
    NonFiniteEasing,
}

impl fmt::Display for TimelineTrackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Empty => "timeline track requires at least one keyframe",
            Self::NonFiniteTime => "keyframe time must be finite",
            Self::NegativeTime => "keyframe time cannot be negative",
            Self::NonFiniteValue => "numeric keyframes require finite values",
            Self::NonFiniteDuration => "shorthand keyframes require a finite non-negative duration",
            Self::NonFiniteEasing => "timeline easing control points must be finite",
        };
        f.write_str(message)
    }
}

impl Error for TimelineTrackError {}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TimelineValueSample {
    pub value: f64,
    pub velocity: f64,
}

#[derive(Clone, Debug, PartialEq)]
enum CompiledTimelineEasing {
    Linear,
    Lut(Box<[f64]>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ScalarKeyframeTrack {
    frames: Vec<ScalarKeyframe>,
    easings: Vec<CompiledTimelineEasing>,
    duration: f64,
}

impl ScalarKeyframeTrack {
    /// Stable-sort numeric keyframes by time and let the later authored frame
    /// win when two frames land within the inherited timeline epsilon.
    pub fn new(frames: Vec<ScalarKeyframe>) -> Result<Self, TimelineTrackError> {
        if frames.is_empty() {
            return Err(TimelineTrackError::Empty);
        }

        let mut ordered = Vec::with_capacity(frames.len());
        for (order, frame) in frames.into_iter().enumerate() {
            validate_frame(frame)?;
            ordered.push((order, frame));
        }
        ordered.sort_by(|(left_order, left), (right_order, right)| {
            left.at
                .total_cmp(&right.at)
                .then_with(|| left_order.cmp(right_order))
        });

        let mut normalized: Vec<ScalarKeyframe> = Vec::with_capacity(ordered.len());
        for (_, frame) in ordered {
            if let Some(last) = normalized.last_mut() {
                if (last.at - frame.at).abs() <= EPSILON {
                    *last = frame;
                    continue;
                }
            }
            normalized.push(frame);
        }

        let mut easings = Vec::with_capacity(normalized.len().saturating_sub(1));
        for frame in normalized.iter().take(normalized.len().saturating_sub(1)) {
            easings.push(compile_timeline_easing(frame.easing)?);
        }
        let duration = normalized.last().expect("non-empty after normalization").at;
        Ok(Self {
            frames: normalized,
            easings,
            duration,
        })
    }

    /// Legacy shorthand form: evenly distribute scalar values across duration.
    pub fn from_values(
        values: &[f64],
        duration: f64,
        easing: TimelineEasing,
    ) -> Result<Self, TimelineTrackError> {
        if values.is_empty() {
            return Err(TimelineTrackError::Empty);
        }
        if !duration.is_finite() || duration < 0.0 {
            return Err(TimelineTrackError::NonFiniteDuration);
        }
        let denominator = values.len().saturating_sub(1).max(1) as f64;
        let frames = values
            .iter()
            .enumerate()
            .map(|(index, value)| ScalarKeyframe {
                at: duration * index as f64 / denominator,
                value: *value,
                easing,
            })
            .collect();
        Self::new(frames)
    }

    pub fn duration(&self) -> f64 {
        self.duration
    }

    pub fn keyframes(&self) -> &[ScalarKeyframe] {
        &self.frames
    }

    /// Sample renderer-neutral scalar presentation state. `velocity_scale` is
    /// supplied by `TimelineClock` as direction-sign times playback-rate during
    /// playback, or zero while seeking/scrubbing.
    pub fn sample(&self, time: f64, velocity_scale: f64) -> TimelineValueSample {
        let time = if time.is_finite() {
            time.clamp(0.0, self.duration)
        } else {
            0.0
        };
        let velocity_scale = if velocity_scale.is_finite() {
            velocity_scale
        } else {
            0.0
        };

        let count = self.frames.len();
        if count == 1 || time <= self.frames[0].at {
            return TimelineValueSample {
                value: self.frames[0].value,
                velocity: 0.0,
            };
        }

        let last = count - 1;
        if time >= self.frames[last].at {
            return TimelineValueSample {
                value: self.frames[last].value,
                velocity: 0.0,
            };
        }

        let index = self
            .frames
            .partition_point(|frame| frame.at <= time)
            .saturating_sub(1)
            .min(last - 1);
        let start = self.frames[index];
        let end = self.frames[index + 1];
        let span = end.at - start.at;
        if span <= EPSILON {
            return TimelineValueSample {
                value: end.value,
                velocity: 0.0,
            };
        }

        let progress = (time - start.at) / span;
        let easing = &self.easings[index];
        let eased = evaluate_compiled_timeline_easing(easing, progress);
        let delta = end.value - start.value;
        TimelineValueSample {
            value: start.value + delta * eased,
            velocity: if velocity_scale == 0.0 {
                0.0
            } else {
                delta * derivative_compiled_timeline_easing(easing, progress) / span
                    * velocity_scale
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimelineFill {
    None,
    Forwards,
    Backwards,
    Both,
}

impl TimelineFill {
    fn fills_before(self) -> bool {
        matches!(self, Self::Backwards | Self::Both)
    }

    fn fills_after(self) -> bool {
        matches!(self, Self::Forwards | Self::Both)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimelineClipError {
    NonFiniteStart,
    NegativeStart,
    NonFiniteSpeed,
    NonPositiveSpeed,
    NonFiniteChildDuration,
    NegativeChildDuration,
}

impl fmt::Display for TimelineClipError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::NonFiniteStart => "timeline clip start must be finite",
            Self::NegativeStart => "timeline clip start cannot be negative",
            Self::NonFiniteSpeed => "timeline clip speed must be finite",
            Self::NonPositiveSpeed => "timeline clip speed must be greater than zero",
            Self::NonFiniteChildDuration => "timeline clip child duration must be finite",
            Self::NegativeChildDuration => "timeline clip child duration cannot be negative",
        };
        f.write_str(message)
    }
}

impl Error for TimelineClipError {}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TimelineClipSample {
    pub child_time: f64,
    pub velocity_scale: f64,
}

/// Renderer-neutral parent-to-child time mapping recovered from inherited
/// `TimelineClip` semantics. Target ownership and child track storage remain
/// separate; this type only decides whether/where a child timeline samples.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TimelineClipTiming {
    at: f64,
    speed: f64,
    fill: TimelineFill,
    child_duration: f64,
}

impl TimelineClipTiming {
    pub fn new(
        at: f64,
        speed: f64,
        fill: TimelineFill,
        child_duration: f64,
    ) -> Result<Self, TimelineClipError> {
        if !at.is_finite() {
            return Err(TimelineClipError::NonFiniteStart);
        }
        if at < 0.0 {
            return Err(TimelineClipError::NegativeStart);
        }
        if !speed.is_finite() {
            return Err(TimelineClipError::NonFiniteSpeed);
        }
        if speed <= 0.0 {
            return Err(TimelineClipError::NonPositiveSpeed);
        }
        if !child_duration.is_finite() {
            return Err(TimelineClipError::NonFiniteChildDuration);
        }
        if child_duration < 0.0 {
            return Err(TimelineClipError::NegativeChildDuration);
        }

        Ok(Self {
            at,
            speed,
            fill,
            child_duration,
        })
    }

    pub fn at(&self) -> f64 {
        self.at
    }

    pub fn speed(&self) -> f64 {
        self.speed
    }

    pub fn fill(&self) -> TimelineFill {
        self.fill
    }

    pub fn child_duration(&self) -> f64 {
        self.child_duration
    }

    pub fn duration(&self) -> f64 {
        self.child_duration / self.speed
    }

    pub fn end(&self) -> f64 {
        self.at + self.duration()
    }

    /// Map parent timeline time into the child timeline.
    ///
    /// Fill samples clamp to the child endpoint with zero velocity. Active
    /// samples scale both child time and inherited real-time velocity by
    /// `speed`, exactly matching the existing timeline runtime.
    pub fn map(&self, parent_time: f64, velocity_scale: f64) -> Option<TimelineClipSample> {
        let parent_time = if parent_time.is_finite() {
            parent_time
        } else {
            0.0
        };
        let velocity_scale = if velocity_scale.is_finite() {
            velocity_scale
        } else {
            0.0
        };

        if parent_time < self.at {
            return self.fill.fills_before().then_some(TimelineClipSample {
                child_time: 0.0,
                velocity_scale: 0.0,
            });
        }

        let end = self.end();
        if parent_time > end {
            return self.fill.fills_after().then_some(TimelineClipSample {
                child_time: self.child_duration,
                velocity_scale: 0.0,
            });
        }

        Some(TimelineClipSample {
            child_time: ((parent_time - self.at) * self.speed).clamp(0.0, self.child_duration),
            velocity_scale: velocity_scale * self.speed,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScalarTimelineStep {
    pub mapping: TimelineMapping,
    pub sample: TimelineValueSample,
    pub crossed_iterations: i64,
    pub finished: bool,
}

/// Runtime execution primitive for one inherited numeric keyframe track.
///
/// It deliberately reuses `TimelineClock` for repeat/direction/seek/reverse
/// semantics. It does not create a second wall clock and does not claim the
/// source-facing `Timeline`/`PhaseTimeline` API yet.
#[derive(Clone, Debug, PartialEq)]
pub struct ScalarTimelinePlayer {
    track: ScalarKeyframeTrack,
    clock: TimelineClock,
    sample: TimelineValueSample,
}

impl ScalarTimelinePlayer {
    pub fn new(
        track: ScalarKeyframeTrack,
        iterations: Option<u64>,
        direction: TimelineDirection,
    ) -> Self {
        let clock = TimelineClock::new(track.duration(), iterations, direction);
        let mapping = clock.current_mapping();
        let sample = track.sample(mapping.local_time, 0.0);
        Self {
            track,
            clock,
            sample,
        }
    }

    pub fn track(&self) -> &ScalarKeyframeTrack {
        &self.track
    }

    pub fn clock(&self) -> &TimelineClock {
        &self.clock
    }

    pub fn current_sample(&self) -> TimelineValueSample {
        self.sample
    }

    pub fn current_mapping(&self) -> TimelineMapping {
        self.clock.current_mapping()
    }

    pub fn set_playback_rate(&mut self, rate: f64) {
        self.clock.set_playback_rate(rate);
    }

    pub fn reverse(&mut self) {
        self.clock.reverse();
    }

    pub fn seek(&mut self, local_time: f64, iteration: u64) -> TimelineValueSample {
        let mapping = self.clock.seek(local_time, iteration);
        self.sample = self.track.sample(mapping.local_time, 0.0);
        self.sample
    }

    pub fn seek_progress(&mut self, progress: f64, iteration: u64) -> TimelineValueSample {
        let mapping = self.clock.seek_progress(progress, iteration);
        self.sample = self.track.sample(mapping.local_time, 0.0);
        self.sample
    }

    pub fn seek_elapsed(&mut self, elapsed: f64) -> TimelineValueSample {
        let mapping = self.clock.seek_elapsed(elapsed);
        self.sample = self.track.sample(mapping.local_time, 0.0);
        self.sample
    }

    pub fn step(&mut self, dt_seconds: f64) -> ScalarTimelineStep {
        if !dt_seconds.is_finite() || dt_seconds <= 0.0 || self.clock.playback_rate() == 0.0 {
            return ScalarTimelineStep {
                mapping: self.clock.current_mapping(),
                sample: self.sample,
                crossed_iterations: 0,
                finished: false,
            };
        }

        let step = self.clock.step(dt_seconds);
        let velocity_scale = if step.finished {
            0.0
        } else {
            step.mapping.sign * self.clock.playback_rate()
        };
        self.sample = self.track.sample(step.mapping.local_time, velocity_scale);
        ScalarTimelineStep {
            mapping: step.mapping,
            sample: self.sample,
            crossed_iterations: step.crossed_iterations,
            finished: step.finished,
        }
    }
}

fn validate_frame(frame: ScalarKeyframe) -> Result<(), TimelineTrackError> {
    if !frame.at.is_finite() {
        return Err(TimelineTrackError::NonFiniteTime);
    }
    if frame.at < 0.0 {
        return Err(TimelineTrackError::NegativeTime);
    }
    if !frame.value.is_finite() {
        return Err(TimelineTrackError::NonFiniteValue);
    }
    Ok(())
}

fn compile_timeline_easing(
    easing: TimelineEasing,
) -> Result<CompiledTimelineEasing, TimelineTrackError> {
    match easing {
        TimelineEasing::Linear => Ok(CompiledTimelineEasing::Linear),
        TimelineEasing::CubicBezier(curve) => {
            if curve.iter().any(|value| !value.is_finite()) {
                return Err(TimelineTrackError::NonFiniteEasing);
            }
            if curve[0] == curve[1] && curve[2] == curve[3] {
                return Ok(CompiledTimelineEasing::Linear);
            }
            let mut values = vec![0.0; EASING_LUT_SIZE + 1];
            for (index, value) in values.iter_mut().enumerate() {
                *value = evaluate_timeline_bezier(curve, index as f64 / EASING_LUT_SIZE as f64);
            }
            Ok(CompiledTimelineEasing::Lut(values.into_boxed_slice()))
        }
    }
}

fn evaluate_compiled_timeline_easing(easing: &CompiledTimelineEasing, progress: f64) -> f64 {
    let progress = progress.clamp(0.0, 1.0);
    match easing {
        CompiledTimelineEasing::Linear => progress,
        CompiledTimelineEasing::Lut(values) => {
            let scaled = progress * EASING_LUT_SIZE as f64;
            let index = (scaled.floor() as usize).min(EASING_LUT_SIZE - 1);
            let fraction = scaled - index as f64;
            values[index] + (values[index + 1] - values[index]) * fraction
        }
    }
}

fn derivative_compiled_timeline_easing(easing: &CompiledTimelineEasing, progress: f64) -> f64 {
    let progress = progress.clamp(0.0, 1.0);
    match easing {
        CompiledTimelineEasing::Linear => 1.0,
        CompiledTimelineEasing::Lut(values) => {
            let scaled = progress * EASING_LUT_SIZE as f64;
            let index = (scaled.floor() as usize).min(EASING_LUT_SIZE - 1);
            (values[index + 1] - values[index]) * EASING_LUT_SIZE as f64
        }
    }
}

fn timeline_sample_curve(a1: f64, a2: f64, t: f64) -> f64 {
    let inverse = 1.0 - t;
    3.0 * inverse * inverse * t * a1 + 3.0 * inverse * t * t * a2 + t * t * t
}

fn timeline_sample_derivative(a1: f64, a2: f64, t: f64) -> f64 {
    3.0 * (1.0 - t) * (1.0 - t) * a1 + 6.0 * (1.0 - t) * t * (a2 - a1) + 3.0 * t * t * (1.0 - a2)
}

fn evaluate_timeline_bezier(curve: [f64; 4], progress: f64) -> f64 {
    let [x1, y1, x2, y2] = curve;
    let x = progress.clamp(0.0, 1.0);
    if x1 == y1 && x2 == y2 {
        return x;
    }

    let mut t = x;
    for _ in 0..5 {
        let estimate = timeline_sample_curve(x1, x2, t) - x;
        let derivative = timeline_sample_derivative(x1, x2, t);
        if derivative.abs() < 1e-7 {
            break;
        }
        t = (t - estimate / derivative).clamp(0.0, 1.0);
    }

    let mut low = 0.0;
    let mut high = 1.0;
    for _ in 0..8 {
        let estimate = timeline_sample_curve(x1, x2, t);
        if (estimate - x).abs() < 1e-6 {
            break;
        }
        if estimate < x {
            low = t;
        } else {
            high = t;
        }
        t = (low + high) * 0.5;
    }

    timeline_sample_curve(y1, y2, t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alternate_iteration_boundary_matches_legacy_without_endpoint_jump() {
        let mut clock = TimelineClock::new(1.0, Some(2), TimelineDirection::Alternate);
        let first = clock.step(1.0);
        assert_eq!(first.mapping.iteration, 1);
        assert_eq!(first.mapping.local_time, 1.0);
        assert_eq!(first.mapping.sign, -1.0);
        assert_eq!(first.crossed_iterations, 1);

        let middle = clock.step(0.5);
        assert!((middle.mapping.local_time - 0.5).abs() < 1e-12);
        let end = clock.step(0.5);
        assert_eq!(end.mapping.local_time, 0.0);
        assert!(end.finished);
    }

    #[test]
    fn reverse_traversal_assigns_exact_boundary_to_previous_iteration() {
        let clock = TimelineClock::new(1.0, Some(4), TimelineDirection::Normal);
        let forward = clock.mapping(2.0, 1.0);
        assert_eq!(forward.iteration, 2);
        assert_eq!(forward.local_time, 0.0);

        let backward = clock.mapping(2.0, -1.0);
        assert_eq!(backward.iteration, 1);
        assert_eq!(backward.local_time, 1.0);
    }

    #[test]
    fn large_gap_crosses_repeats_in_constant_time() {
        let mut clock = TimelineClock::new(1.0, None, TimelineDirection::Normal);
        let step = clock.step(3_600.0);
        assert_eq!(step.mapping.iteration, 3600);
        assert_eq!(step.crossed_iterations, 3600);
        assert!(!step.finished);
    }

    #[test]
    fn seek_and_reverse_match_legacy_time_mapping() {
        let mut clock = TimelineClock::new(1.0, Some(3), TimelineDirection::Alternate);
        let sought = clock.seek_progress(0.75, 1);
        assert_eq!(sought.iteration, 1);
        assert!((sought.local_time - 0.75).abs() < 1e-12);

        clock.reverse();
        let stepped = clock.step(0.1);
        // Iteration 1 is already reversed by `alternate`; reversing playback
        // therefore traverses that reversed segment back toward its end.
        assert!(stepped.mapping.local_time > 0.75);
        assert_eq!(stepped.mapping.sign, -1.0);
    }

    #[test]
    fn scalar_keyframes_stable_sort_and_collapse_duplicate_times_last_wins() {
        let track = ScalarKeyframeTrack::new(vec![
            ScalarKeyframe::linear(1.0, 100.0),
            ScalarKeyframe::linear(0.5, 40.0),
            ScalarKeyframe::linear(0.0, 0.0),
            ScalarKeyframe::linear(0.5, 60.0),
        ])
        .expect("valid keyframes");

        assert_eq!(track.keyframes().len(), 3);
        assert_eq!(track.keyframes()[1].value, 60.0);
        assert_eq!(
            track.sample(0.5, 1.0),
            TimelineValueSample {
                value: 60.0,
                velocity: 80.0,
            }
        );
    }

    #[test]
    fn scalar_keyframe_velocity_scales_with_playback_direction() {
        let track = ScalarKeyframeTrack::from_values(&[0.0, 100.0], 2.0, TimelineEasing::Linear)
            .expect("valid shorthand keyframes");
        let forward = track.sample(0.5, 1.0);
        assert!((forward.value - 25.0).abs() < 1e-12);
        assert!((forward.velocity - 50.0).abs() < 1e-12);

        let reversed_fast = track.sample(0.5, -2.0);
        assert!((reversed_fast.value - 25.0).abs() < 1e-12);
        assert!((reversed_fast.velocity + 100.0).abs() < 1e-12);
    }

    #[test]
    fn scalar_timeline_player_seek_and_reverse_reuse_clock_mapping() {
        let track = ScalarKeyframeTrack::from_values(&[0.0, 100.0], 1.0, TimelineEasing::Linear)
            .expect("valid timeline");
        let mut player = ScalarTimelinePlayer::new(track, Some(2), TimelineDirection::Alternate);

        let sought = player.seek_progress(0.75, 1);
        assert!((sought.value - 75.0).abs() < 1e-12);
        assert_eq!(sought.velocity, 0.0);

        player.reverse();
        let stepped = player.step(0.1);
        assert_eq!(stepped.mapping.iteration, 1);
        assert!(stepped.mapping.local_time > 0.75);
        assert!((stepped.sample.value - 85.0).abs() < 1e-12);
        assert!((stepped.sample.velocity - 100.0).abs() < 1e-12);
    }

    #[test]
    fn scalar_timeline_finished_endpoint_zeroes_velocity() {
        let track = ScalarKeyframeTrack::new(vec![
            ScalarKeyframe {
                at: 0.0,
                value: 0.0,
                easing: TimelineEasing::CubicBezier([0.42, 0.0, 0.58, 1.0]),
            },
            ScalarKeyframe::linear(0.2, 10.0),
        ])
        .expect("valid eased timeline");
        let mut player = ScalarTimelinePlayer::new(track, Some(1), TimelineDirection::Normal);

        let middle = player.step(0.1);
        assert!(middle.sample.value > 0.0 && middle.sample.value < 10.0);
        assert!(middle.sample.velocity > 0.0);

        let end = player.step(0.1);
        assert!(end.finished);
        assert_eq!(end.sample.value, 10.0);
        assert_eq!(end.sample.velocity, 0.0);
    }

    #[test]
    fn timeline_clip_maps_offset_speed_and_velocity_scale() {
        let clip = TimelineClipTiming::new(1.0, 2.0, TimelineFill::None, 2.0).expect("valid clip");
        assert_eq!(clip.duration(), 1.0);
        assert_eq!(clip.end(), 2.0);

        assert_eq!(
            clip.map(1.25, 3.0),
            Some(TimelineClipSample {
                child_time: 0.5,
                velocity_scale: 6.0,
            })
        );
        assert_eq!(
            clip.map(2.0, -2.0),
            Some(TimelineClipSample {
                child_time: 2.0,
                velocity_scale: -4.0,
            })
        );
    }

    #[test]
    fn timeline_clip_fill_applies_only_outside_active_interval() {
        let none = TimelineClipTiming::new(1.0, 1.0, TimelineFill::None, 1.0).expect("valid clip");
        assert_eq!(none.map(0.5, 4.0), None);
        assert_eq!(none.map(2.5, 4.0), None);

        let backwards =
            TimelineClipTiming::new(1.0, 1.0, TimelineFill::Backwards, 1.0).expect("valid clip");
        assert_eq!(
            backwards.map(0.5, 4.0),
            Some(TimelineClipSample {
                child_time: 0.0,
                velocity_scale: 0.0,
            })
        );
        assert_eq!(backwards.map(2.5, 4.0), None);

        let forwards =
            TimelineClipTiming::new(1.0, 1.0, TimelineFill::Forwards, 1.0).expect("valid clip");
        assert_eq!(forwards.map(0.5, 4.0), None);
        assert_eq!(
            forwards.map(2.5, 4.0),
            Some(TimelineClipSample {
                child_time: 1.0,
                velocity_scale: 0.0,
            })
        );

        let both = TimelineClipTiming::new(1.0, 1.0, TimelineFill::Both, 1.0).expect("valid clip");
        assert_eq!(both.map(0.5, 4.0).unwrap().velocity_scale, 0.0);
        assert_eq!(both.map(2.5, 4.0).unwrap().velocity_scale, 0.0);
        assert_eq!(
            both.map(1.0, 4.0),
            Some(TimelineClipSample {
                child_time: 0.0,
                velocity_scale: 4.0,
            })
        );
        assert_eq!(
            both.map(2.0, 4.0),
            Some(TimelineClipSample {
                child_time: 1.0,
                velocity_scale: 4.0,
            })
        );
    }

    #[test]
    fn timeline_clip_rejects_non_positive_speed() {
        assert_eq!(
            TimelineClipTiming::new(0.0, 0.0, TimelineFill::None, 1.0),
            Err(TimelineClipError::NonPositiveSpeed)
        );
    }
}
