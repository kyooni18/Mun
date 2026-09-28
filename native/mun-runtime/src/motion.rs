use std::collections::HashMap;

use crate::{
    ir::{MotionExecutionPlan, MotionProperty},
    timeline::{TimelineClock, TimelineDirection},
};

const MAX_STEP_SECONDS: f32 = 1.0 / 240.0;
const MAX_SUBSTEPS: usize = 32;
const POSITION_EPSILON: f32 = 0.001;
const VELOCITY_EPSILON: f32 = 0.01;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MotionChannelKey {
    pub node_id: String,
    pub property: MotionProperty,
}

#[derive(Clone, Debug)]
struct SpringChannel {
    position: f32,
    velocity: f32,
    origin: f32,
    forward_target: f32,
    target: f32,
    cycle: u64,
    iterations: Option<u64>,
    autoreverses: bool,
    omega: f32,
    damping_ratio: f32,
    delay_remaining: f32,
    blend_from_omega: f32,
    blend_from_damping_ratio: f32,
    blend_to_omega: f32,
    blend_to_damping_ratio: f32,
    blend_elapsed: f32,
    blend_duration: f32,
    settled: bool,
}

#[derive(Clone, Debug)]
struct TimingChannel {
    position: f32,
    velocity: f32,
    from: f32,
    target: f32,
    duration: f32,
    curve: [f32; 4],
    clock: TimelineClock,
    iterations: Option<u64>,
    autoreverses: bool,
    delay_remaining: f32,
    settled: bool,
}

#[derive(Clone, Debug)]
enum MotionChannel {
    Spring(SpringChannel),
    Timing(TimingChannel),
}

impl MotionChannel {
    fn position(&self) -> f32 {
        match self {
            Self::Spring(channel) => channel.position,
            Self::Timing(channel) => channel.position,
        }
    }

    fn velocity(&self) -> f32 {
        match self {
            Self::Spring(channel) => channel.velocity,
            Self::Timing(channel) => channel.velocity,
        }
    }

    fn settled(&self) -> bool {
        match self {
            Self::Spring(channel) => channel.settled,
            Self::Timing(channel) => channel.settled,
        }
    }

    fn stop_after_current_cycle(&mut self) {
        match self {
            Self::Spring(channel) => {
                channel.iterations = Some(channel.cycle.saturating_add(1));
            }
            Self::Timing(channel) => channel.clock.stop_after_current_iteration(),
        }
    }
}

#[derive(Clone, Debug)]
struct PendingRetarget {
    target: f32,
    plan: MotionExecutionPlan,
    remaining: f32,
}

/// Native counterpart to the existing Mün runtime's renderer-neutral per-property motion scheduler.
///
/// Spring retargeting deliberately preserves velocity. Timing channels use the
/// same cubic-bezier solving algorithm as the existing Mün runtime's `core/bezier.js` and retarget
/// from the current presentation value, keeping channel ownership independent
/// per node/property rather than falling back to timer-driven widget effects.
#[derive(Default, Debug)]
pub struct MotionScheduler {
    channels: Vec<MotionChannel>,
    indices: HashMap<MotionChannelKey, usize>,
    pending: HashMap<usize, PendingRetarget>,
}

impl MotionScheduler {
    pub fn retarget(
        &mut self,
        key: MotionChannelKey,
        current: f32,
        target: f32,
        plan: &MotionExecutionPlan,
    ) {
        if let Some(index) = self.indices.get(&key).copied() {
            let delay = plan_delay_seconds(plan);
            if delay > 0.0 {
                // Match the existing Mün runtime's delayed-retarget generation semantics: the
                // current control keeps running, but no future repeat cycles
                // are started before the delayed handoff.
                self.channels[index].stop_after_current_cycle();
                self.pending.insert(
                    index,
                    PendingRetarget {
                        target,
                        plan: plan.clone(),
                        remaining: delay,
                    },
                );
                return;
            }
            self.pending.remove(&index);
            self.retarget_index(index, target, plan);
            return;
        }

        let index = self.channels.len();
        self.channels
            .push(channel_from_plan(current, target, plan, 0.0, true));
        self.indices.insert(key, index);
    }

    fn retarget_index(&mut self, index: usize, target: f32, plan: &MotionExecutionPlan) {
        let presentation = self.channels[index].position();
        let velocity = self.channels[index].velocity();
        match (plan, &mut self.channels[index]) {
            (
                MotionExecutionPlan::Spring {
                    omega,
                    damping_ratio,
                    blend_duration,
                    repeat_count,
                    autoreverses,
                    ..
                },
                MotionChannel::Spring(channel),
            ) => {
                channel.origin = presentation;
                channel.forward_target = target;
                channel.target = target;
                channel.cycle = 0;
                channel.iterations = repeat_iterations(repeat_count);
                channel.autoreverses = *autoreverses;
                channel.delay_remaining = 0.0;
                let blend_duration = (*blend_duration).max(0.0);
                if blend_duration > 0.0
                    && (channel.omega != *omega || channel.damping_ratio != *damping_ratio)
                {
                    channel.blend_from_omega = channel.omega;
                    channel.blend_from_damping_ratio = channel.damping_ratio;
                    channel.blend_to_omega = *omega;
                    channel.blend_to_damping_ratio = *damping_ratio;
                    channel.blend_elapsed = 0.0;
                    channel.blend_duration = blend_duration;
                } else {
                    channel.omega = *omega;
                    channel.damping_ratio = *damping_ratio;
                    channel.blend_from_omega = *omega;
                    channel.blend_from_damping_ratio = *damping_ratio;
                    channel.blend_to_omega = *omega;
                    channel.blend_to_damping_ratio = *damping_ratio;
                    channel.blend_elapsed = 0.0;
                    channel.blend_duration = 0.0;
                }
                // Deliberately preserve the live channel velocity.
                channel.velocity = velocity;
                channel.settled = false;
            }
            (
                MotionExecutionPlan::Timing {
                    duration,
                    curve,
                    repeat_count,
                    autoreverses,
                    ..
                },
                MotionChannel::Timing(channel),
            ) => {
                let duration = duration.max(0.0);
                let iterations = repeat_iterations(repeat_count);
                channel.from = presentation;
                channel.position = presentation;
                channel.target = target;
                channel.duration = duration;
                channel.curve = *curve;
                channel.clock = timeline_clock(duration, iterations, *autoreverses);
                channel.iterations = iterations;
                channel.autoreverses = *autoreverses;
                channel.delay_remaining = 0.0;
                channel.velocity = 0.0;
                channel.settled = false;
            }
            _ => {
                self.channels[index] =
                    channel_from_plan(presentation, target, plan, velocity, false);
            }
        }
    }

    pub fn snap(&mut self, key: &MotionChannelKey, target: f32) {
        let Some(index) = self.indices.get(key).copied() else {
            return;
        };
        self.pending.remove(&index);
        match &mut self.channels[index] {
            MotionChannel::Spring(channel) => {
                channel.position = target;
                channel.velocity = 0.0;
                channel.origin = target;
                channel.forward_target = target;
                channel.target = target;
                channel.cycle = 0;
                channel.iterations = Some(1);
                channel.delay_remaining = 0.0;
                channel.blend_elapsed = 0.0;
                channel.blend_duration = 0.0;
                channel.settled = true;
            }
            MotionChannel::Timing(channel) => {
                channel.position = target;
                channel.velocity = 0.0;
                channel.from = target;
                channel.target = target;
                channel.clock = timeline_clock(channel.duration, Some(1), false);
                channel.clock.seek_elapsed(channel.duration as f64);
                channel.iterations = Some(1);
                channel.autoreverses = false;
                channel.delay_remaining = 0.0;
                channel.settled = true;
            }
        }
    }

    pub fn step(&mut self, dt_seconds: f32) -> bool {
        if self.channels.is_empty() || dt_seconds <= 0.0 {
            return false;
        }

        for index in 0..self.channels.len() {
            let mut handoff: Option<(f32, MotionExecutionPlan, f32)> = None;
            if let Some(pending) = self.pending.get_mut(&index) {
                let before_handoff = dt_seconds.min(pending.remaining);
                if before_handoff > 0.0 {
                    step_channel(&mut self.channels[index], before_handoff);
                    pending.remaining = (pending.remaining - before_handoff).max(0.0);
                }
                if pending.remaining <= f32::EPSILON {
                    handoff = Some((
                        pending.target,
                        pending.plan.clone(),
                        dt_seconds - before_handoff,
                    ));
                }
            } else {
                step_channel(&mut self.channels[index], dt_seconds);
            }

            if let Some((target, plan, remaining)) = handoff {
                self.pending.remove(&index);
                self.retarget_index(index, target, &plan);
                if remaining > 0.0 {
                    step_channel(&mut self.channels[index], remaining);
                }
            }
        }

        self.is_active()
    }

    pub fn value(&self, key: &MotionChannelKey) -> Option<f32> {
        self.indices
            .get(key)
            .and_then(|index| self.channels.get(*index))
            .map(MotionChannel::position)
    }

    pub fn velocity(&self, key: &MotionChannelKey) -> Option<f32> {
        self.indices
            .get(key)
            .and_then(|index| self.channels.get(*index))
            .map(MotionChannel::velocity)
    }

    pub fn is_key_active(&self, key: &MotionChannelKey) -> bool {
        let Some(index) = self.indices.get(key).copied() else {
            return false;
        };
        self.pending.contains_key(&index)
            || self
                .channels
                .get(index)
                .map(|channel| !channel.settled())
                .unwrap_or(false)
    }

    pub fn is_active(&self) -> bool {
        !self.pending.is_empty() || self.channels.iter().any(|channel| !channel.settled())
    }
}

fn channel_from_plan(
    current: f32,
    target: f32,
    plan: &MotionExecutionPlan,
    initial_velocity: f32,
    honor_delay: bool,
) -> MotionChannel {
    match plan {
        MotionExecutionPlan::Spring {
            omega,
            damping_ratio,
            delay_ms,
            repeat_count,
            autoreverses,
            ..
        } => MotionChannel::Spring(SpringChannel {
            position: current,
            velocity: initial_velocity,
            origin: current,
            forward_target: target,
            target,
            cycle: 0,
            iterations: repeat_iterations(repeat_count),
            autoreverses: *autoreverses,
            omega: *omega,
            damping_ratio: *damping_ratio,
            delay_remaining: if honor_delay {
                (*delay_ms / 1000.0).max(0.0)
            } else {
                0.0
            },
            blend_from_omega: *omega,
            blend_from_damping_ratio: *damping_ratio,
            blend_to_omega: *omega,
            blend_to_damping_ratio: *damping_ratio,
            blend_elapsed: 0.0,
            blend_duration: 0.0,
            settled: false,
        }),
        MotionExecutionPlan::Timing {
            duration,
            curve,
            delay_ms,
            repeat_count,
            autoreverses,
            ..
        } => {
            let duration = duration.max(0.0);
            let iterations = repeat_iterations(repeat_count);
            MotionChannel::Timing(TimingChannel {
                position: current,
                velocity: 0.0,
                from: current,
                target,
                duration,
                curve: *curve,
                clock: timeline_clock(duration, iterations, *autoreverses),
                iterations,
                autoreverses: *autoreverses,
                delay_remaining: if honor_delay {
                    (*delay_ms / 1000.0).max(0.0)
                } else {
                    0.0
                },
                settled: false,
            })
        }
    }
}

fn plan_delay_seconds(plan: &MotionExecutionPlan) -> f32 {
    match plan {
        MotionExecutionPlan::Spring { delay_ms, .. }
        | MotionExecutionPlan::Timing { delay_ms, .. } => (*delay_ms / 1000.0).max(0.0),
    }
}

fn repeat_iterations(value: &serde_json::Value) -> Option<u64> {
    if value.as_str() == Some("infinite") {
        None
    } else {
        Some(value.as_u64().unwrap_or(1).max(1))
    }
}

fn timeline_clock(duration: f32, iterations: Option<u64>, autoreverses: bool) -> TimelineClock {
    TimelineClock::new(
        duration as f64,
        iterations,
        if autoreverses {
            TimelineDirection::Alternate
        } else {
            TimelineDirection::Normal
        },
    )
}

fn step_channel(channel: &mut MotionChannel, dt_seconds: f32) {
    match channel {
        MotionChannel::Spring(channel) => step_spring(channel, dt_seconds),
        MotionChannel::Timing(channel) => step_timing(channel, dt_seconds),
    }
}

fn consume_delay(delay_remaining: &mut f32, dt_seconds: f32) -> f32 {
    if *delay_remaining <= 0.0 {
        return dt_seconds;
    }
    let active = (dt_seconds - *delay_remaining).max(0.0);
    *delay_remaining = (*delay_remaining - dt_seconds).max(0.0);
    active
}

fn step_spring(channel: &mut SpringChannel, dt_seconds: f32) {
    if channel.settled {
        return;
    }
    let dt_seconds = consume_delay(&mut channel.delay_remaining, dt_seconds);
    if dt_seconds <= 0.0 {
        return;
    }

    if channel.blend_duration > 0.0 {
        channel.blend_elapsed = (channel.blend_elapsed + dt_seconds).min(channel.blend_duration);
        let progress = channel.blend_elapsed / channel.blend_duration;
        channel.omega = channel.blend_from_omega
            + (channel.blend_to_omega - channel.blend_from_omega) * progress;
        channel.damping_ratio = channel.blend_from_damping_ratio
            + (channel.blend_to_damping_ratio - channel.blend_from_damping_ratio) * progress;
        if progress >= 1.0 {
            channel.omega = channel.blend_to_omega;
            channel.damping_ratio = channel.blend_to_damping_ratio;
            channel.blend_duration = 0.0;
            channel.blend_elapsed = 0.0;
        }
    }

    let mut steps = 1usize;
    while dt_seconds / steps as f32 > MAX_STEP_SECONDS && steps < MAX_SUBSTEPS {
        steps += 1;
    }
    let h = dt_seconds / steps as f32;

    for _ in 0..steps {
        let acceleration = channel.omega * channel.omega * (channel.target - channel.position)
            - 2.0 * channel.damping_ratio * channel.omega * channel.velocity;
        channel.velocity += acceleration * h;
        channel.position += channel.velocity * h;

        if (channel.target - channel.position).abs() <= POSITION_EPSILON
            && channel.velocity.abs() <= VELOCITY_EPSILON
        {
            channel.position = channel.target;
            channel.velocity = 0.0;
            if !advance_spring_cycle(channel) {
                channel.settled = true;
            }
            break;
        }
    }
}

fn advance_spring_cycle(channel: &mut SpringChannel) -> bool {
    let next = channel.cycle.saturating_add(1);
    if channel
        .iterations
        .is_some_and(|iterations| next >= iterations)
    {
        return false;
    }
    channel.cycle = next;
    channel.settled = false;
    if channel.autoreverses {
        channel.target = if next % 2 == 1 {
            channel.origin
        } else {
            channel.forward_target
        };
    } else {
        // the existing Mün runtime's non-autoreversing repeat restarts from the origin between
        // cycles instead of reversing the current channel.
        channel.position = channel.origin;
        channel.target = channel.forward_target;
    }
    channel.velocity = 0.0;
    true
}

fn step_timing(channel: &mut TimingChannel, dt_seconds: f32) {
    if channel.settled {
        return;
    }
    let dt_seconds = consume_delay(&mut channel.delay_remaining, dt_seconds);
    if dt_seconds <= 0.0 {
        return;
    }
    if channel.duration <= f32::EPSILON {
        let finishes_at_origin = channel.autoreverses
            && channel
                .iterations
                .is_some_and(|iterations| iterations > 1 && iterations % 2 == 0);
        channel.position = if finishes_at_origin {
            channel.from
        } else {
            channel.target
        };
        channel.velocity = 0.0;
        channel.settled = true;
        return;
    }

    let step = channel.clock.step(dt_seconds as f64);
    let progress = (step.mapping.local_time / channel.duration as f64) as f32;
    let eased = evaluate_bezier(channel.curve, progress);
    let delta = channel.target - channel.from;
    channel.position = channel.from + delta * eased;
    if step.finished {
        channel.velocity = 0.0;
        channel.settled = true;
    } else {
        let derivative = evaluate_bezier_derivative(channel.curve, progress);
        channel.velocity = delta * derivative / channel.duration
            * step.mapping.sign as f32
            * channel.clock.playback_rate() as f32;
    }
}

fn sample_curve(a1: f32, a2: f32, t: f32) -> f32 {
    let inv = 1.0 - t;
    3.0 * inv * inv * t * a1 + 3.0 * inv * t * t * a2 + t * t * t
}

fn sample_derivative(a1: f32, a2: f32, t: f32) -> f32 {
    3.0 * (1.0 - t) * (1.0 - t) * a1 + 6.0 * (1.0 - t) * t * (a2 - a1) + 3.0 * t * t * (1.0 - a2)
}

/// Port of the existing Mün runtime's renderer-neutral cubic-bezier evaluator.
fn evaluate_bezier(curve: [f32; 4], progress: f32) -> f32 {
    let [x1, y1, x2, y2] = curve;
    let x = progress.clamp(0.0, 1.0);
    if x1 == y1 && x2 == y2 {
        return x;
    }

    let mut t = x;
    for _ in 0..5 {
        let estimate = sample_curve(x1, x2, t) - x;
        let derivative = sample_derivative(x1, x2, t);
        if derivative.abs() < 1e-7 {
            break;
        }
        t = (t - estimate / derivative).clamp(0.0, 1.0);
    }

    let mut low = 0.0;
    let mut high = 1.0;
    for _ in 0..8 {
        let estimate = sample_curve(x1, x2, t);
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

    sample_curve(y1, y2, t)
}

fn evaluate_bezier_derivative(curve: [f32; 4], progress: f32) -> f32 {
    let [x1, y1, x2, y2] = curve;
    let x = progress.clamp(0.0, 1.0);
    if x1 == y1 && x2 == y2 {
        return 1.0;
    }
    let mut t = x;
    for _ in 0..5 {
        let estimate = sample_curve(x1, x2, t) - x;
        let derivative = sample_derivative(x1, x2, t);
        if derivative.abs() < 1e-7 {
            break;
        }
        t = (t - estimate / derivative).clamp(0.0, 1.0);
    }
    let mut low = 0.0;
    let mut high = 1.0;
    for _ in 0..8 {
        let estimate = sample_curve(x1, x2, t);
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
    let dx = sample_derivative(x1, x2, t);
    if dx.abs() < 1e-7 {
        0.0
    } else {
        sample_derivative(y1, y2, t) / dx
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spring() -> MotionExecutionPlan {
        MotionExecutionPlan::Spring {
            omega: std::f32::consts::TAU / 0.48,
            damping_ratio: 0.82,
            blend_duration: 0.0,
            delay_ms: 0.0,
            repeat_count: json!(1),
            autoreverses: true,
        }
    }

    fn timing() -> MotionExecutionPlan {
        MotionExecutionPlan::Timing {
            duration: 0.4,
            curve: [0.42, 0.0, 0.58, 1.0],
            delay_ms: 0.0,
            repeat_count: json!(1),
            autoreverses: true,
        }
    }

    #[test]
    fn spring_retarget_preserves_velocity() {
        let key = MotionChannelKey {
            node_id: "panel".into(),
            property: MotionProperty::Width,
        };
        let mut scheduler = MotionScheduler::default();
        scheduler.retarget(key.clone(), 160.0, 320.0, &spring());
        scheduler.step(0.08);
        let velocity_before = scheduler.velocity(&key).unwrap();
        assert!(velocity_before.abs() > 1.0);

        scheduler.retarget(
            key.clone(),
            scheduler.value(&key).unwrap(),
            160.0,
            &spring(),
        );
        assert_eq!(scheduler.velocity(&key).unwrap(), velocity_before);
    }

    #[test]
    fn delay_holds_presentation_until_the_delay_expires() {
        let key = MotionChannelKey {
            node_id: "panel".into(),
            property: MotionProperty::Width,
        };
        let mut plan = timing();
        if let MotionExecutionPlan::Timing { delay_ms, .. } = &mut plan {
            *delay_ms = 100.0;
        }
        let mut scheduler = MotionScheduler::default();
        scheduler.retarget(key.clone(), 160.0, 320.0, &plan);

        scheduler.step(0.05);
        assert!((scheduler.value(&key).unwrap() - 160.0).abs() < 1e-5);
        scheduler.step(0.05);
        assert!((scheduler.value(&key).unwrap() - 160.0).abs() < 1e-5);
        scheduler.step(0.05);
        assert!(scheduler.value(&key).unwrap() > 160.0);
    }

    #[test]
    fn spring_retarget_blends_coefficients_without_losing_velocity() {
        let key = MotionChannelKey {
            node_id: "panel".into(),
            property: MotionProperty::Width,
        };
        let mut scheduler = MotionScheduler::default();
        let initial = spring();
        scheduler.retarget(key.clone(), 160.0, 320.0, &initial);
        scheduler.step(0.05);
        let velocity_before = scheduler.velocity(&key).unwrap();

        let mut retarget = spring();
        if let MotionExecutionPlan::Spring {
            omega,
            damping_ratio,
            blend_duration,
            ..
        } = &mut retarget
        {
            *omega *= 1.8;
            *damping_ratio = 0.64;
            *blend_duration = 0.2;
        }
        scheduler.retarget(
            key.clone(),
            scheduler.value(&key).unwrap(),
            180.0,
            &retarget,
        );
        assert_eq!(scheduler.velocity(&key).unwrap(), velocity_before);

        let index = scheduler.indices[&key];
        let MotionChannel::Spring(channel) = &scheduler.channels[index] else {
            panic!("expected spring channel");
        };
        let old_omega = channel.omega;
        let target_omega = channel.blend_to_omega;
        assert_ne!(old_omega, target_omega);

        scheduler.step(0.1);
        let MotionChannel::Spring(channel) = &scheduler.channels[index] else {
            panic!("expected spring channel");
        };
        assert!(channel.omega > old_omega.min(target_omega));
        assert!(channel.omega < old_omega.max(target_omega));
    }

    #[test]
    fn delayed_live_retarget_keeps_previous_motion_running_until_handoff() {
        let key = MotionChannelKey {
            node_id: "panel".into(),
            property: MotionProperty::Width,
        };
        let initial = MotionExecutionPlan::Timing {
            duration: 1.0,
            curve: [0.0, 0.0, 1.0, 1.0],
            delay_ms: 0.0,
            repeat_count: json!(1),
            autoreverses: true,
        };
        let delayed = MotionExecutionPlan::Timing {
            duration: 0.4,
            curve: [0.0, 0.0, 1.0, 1.0],
            delay_ms: 200.0,
            repeat_count: json!(1),
            autoreverses: true,
        };
        let mut scheduler = MotionScheduler::default();
        scheduler.retarget(key.clone(), 0.0, 100.0, &initial);
        scheduler.step(0.1);
        let at_retarget = scheduler.value(&key).unwrap();
        assert!((at_retarget - 10.0).abs() < 0.01);

        scheduler.retarget(key.clone(), at_retarget, 25.0, &delayed);
        scheduler.step(0.1);
        let during_delay = scheduler.value(&key).unwrap();
        assert!((during_delay - 20.0).abs() < 0.01);
        scheduler.step(0.1);
        let at_handoff = scheduler.value(&key).unwrap();
        assert!((at_handoff - 30.0).abs() < 0.02);
        scheduler.step(0.1);
        let after_handoff = scheduler.value(&key).unwrap();
        assert!(after_handoff < at_handoff && after_handoff > 25.0);
    }

    #[test]
    fn timing_repeat_count_and_autoreverse_match_legacy_iteration_semantics() {
        let key = MotionChannelKey {
            node_id: "panel".into(),
            property: MotionProperty::Width,
        };
        let plan = MotionExecutionPlan::Timing {
            duration: 0.1,
            curve: [0.0, 0.0, 1.0, 1.0],
            delay_ms: 0.0,
            repeat_count: json!(2),
            autoreverses: true,
        };
        let mut scheduler = MotionScheduler::default();
        scheduler.retarget(key.clone(), 0.0, 10.0, &plan);
        scheduler.step(0.1);
        assert!((scheduler.value(&key).unwrap() - 10.0).abs() < 1e-5);
        assert!(scheduler.is_active());
        scheduler.step(0.05);
        assert!((scheduler.value(&key).unwrap() - 5.0).abs() < 0.01);
        scheduler.step(0.05);
        assert!(scheduler.value(&key).unwrap().abs() < 1e-5);
        assert!(!scheduler.is_active());
    }

    #[test]
    fn timing_repeat_without_autoreverse_restarts_from_origin() {
        let key = MotionChannelKey {
            node_id: "panel".into(),
            property: MotionProperty::Width,
        };
        let plan = MotionExecutionPlan::Timing {
            duration: 0.1,
            curve: [0.0, 0.0, 1.0, 1.0],
            delay_ms: 0.0,
            repeat_count: json!(2),
            autoreverses: false,
        };
        let mut scheduler = MotionScheduler::default();
        scheduler.retarget(key.clone(), 0.0, 10.0, &plan);
        scheduler.step(0.1);
        assert!(scheduler.value(&key).unwrap().abs() < 1e-5);
        scheduler.step(0.1);
        assert!((scheduler.value(&key).unwrap() - 10.0).abs() < 1e-5);
        assert!(!scheduler.is_active());
    }

    #[test]
    fn spring_repeat_autoreverse_finishes_at_origin_on_even_iteration_count() {
        let key = MotionChannelKey {
            node_id: "panel".into(),
            property: MotionProperty::Width,
        };
        let plan = MotionExecutionPlan::Spring {
            omega: 30.0,
            damping_ratio: 1.0,
            blend_duration: 0.0,
            delay_ms: 0.0,
            repeat_count: json!(2),
            autoreverses: true,
        };
        let mut scheduler = MotionScheduler::default();
        scheduler.retarget(key.clone(), 0.0, 10.0, &plan);
        for _ in 0..1000 {
            scheduler.step(1.0 / 120.0);
            if !scheduler.is_active() {
                break;
            }
        }
        assert!(scheduler.value(&key).unwrap().abs() < 0.01);
        assert!(!scheduler.is_active());
    }

    #[test]
    fn timing_repeat_forever_remains_active_without_growing_repeat_work() {
        let key = MotionChannelKey {
            node_id: "panel".into(),
            property: MotionProperty::Width,
        };
        let plan = MotionExecutionPlan::Timing {
            duration: 0.1,
            curve: [0.0, 0.0, 1.0, 1.0],
            delay_ms: 0.0,
            repeat_count: json!("infinite"),
            autoreverses: true,
        };
        let mut scheduler = MotionScheduler::default();
        scheduler.retarget(key.clone(), 0.0, 10.0, &plan);

        // Cross 10,000 complete iterations in one scheduler step. The timeline
        // clock maps the elapsed time directly instead of looping per repeat.
        scheduler.step(1_000.05);
        let value = scheduler.value(&key).unwrap();
        assert!(value > 0.0 && value < 10.0);
        assert!(scheduler.is_active());
    }

    #[test]
    fn timing_uses_existing_bezier_route_and_retargets_from_presentation_value() {
        let key = MotionChannelKey {
            node_id: "panel".into(),
            property: MotionProperty::Width,
        };
        let mut scheduler = MotionScheduler::default();
        scheduler.retarget(key.clone(), 160.0, 320.0, &timing());
        scheduler.step(0.1);
        let presentation = scheduler.value(&key).unwrap();
        assert!(presentation > 160.0 && presentation < 320.0);

        scheduler.retarget(key.clone(), presentation, 200.0, &timing());
        assert!((scheduler.value(&key).unwrap() - presentation).abs() < 1e-5);
        scheduler.step(0.4);
        assert!((scheduler.value(&key).unwrap() - 200.0).abs() < 1e-5);
        assert!(!scheduler.is_active());
    }
}
