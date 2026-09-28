//! Renderer-neutral playback clock ported from the existing Mün runtime's `TimelinePlayer`.
//!
//! This module intentionally owns only time/iteration/direction mapping. It does
//! not know about scene nodes, layout, wgpu, or platform widgets. Keyframe tracks
//! and motion-channel bindings can consume this clock without redefining repeat,
//! alternate, reverse, seek, or large-gap behavior.

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
}
