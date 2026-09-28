//! Renderer-neutral kinetic continuation recovered from the existing Mün runtime.
//!
//! The legacy JavaScript engine uses exact exponential decay and an exact
//! damped-spring solution for low-count interaction motion. Keeping those
//! algorithms here makes drag/timeline/scroll release motion independent from
//! frame cadence and from any renderer or window-system backend.

use std::{error::Error, fmt};

const DEFAULT_TIME_CONSTANT: f64 = 0.325;
const DEFAULT_REST_SPEED: f64 = 5.0;
const DEFAULT_REST_DELTA: f64 = 0.5;
const DEFAULT_BOUNCE_RESPONSE: f64 = 0.28;
const DEFAULT_BOUNCE_DAMPING_RATIO: f64 = 0.82;
const MIN_TIME_CONSTANT: f64 = 0.016;
const CRITICAL_EPSILON: f64 = 1e-4;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DecaySpec {
    pub velocity: Option<f64>,
    pub time_constant: f64,
    pub power: f64,
    pub rest_speed: f64,
    /// The already-resolved result of the inherited `modifyTarget` hook.
    ///
    /// Source-level callback ownership does not live in the numeric executor.
    /// Gesture/timeline semantics can resolve snapping once, then pass the
    /// resulting scalar here without starting a second animation.
    pub target_override: Option<f64>,
}

impl Default for DecaySpec {
    fn default() -> Self {
        Self {
            velocity: None,
            time_constant: DEFAULT_TIME_CONSTANT,
            power: 1.0,
            rest_speed: DEFAULT_REST_SPEED,
            target_override: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InertiaSpec {
    pub velocity: Option<f64>,
    pub time_constant: f64,
    pub power: f64,
    pub rest_speed: f64,
    pub rest_delta: f64,
    pub min: f64,
    pub max: f64,
    pub bounce_omega: f64,
    pub bounce_damping_ratio: f64,
    /// The already-resolved result of the inherited `modifyTarget` hook.
    pub target_override: Option<f64>,
}

impl Default for InertiaSpec {
    fn default() -> Self {
        Self {
            velocity: None,
            time_constant: DEFAULT_TIME_CONSTANT,
            power: 0.8,
            rest_speed: DEFAULT_REST_SPEED,
            rest_delta: DEFAULT_REST_DELTA,
            min: f64::NEG_INFINITY,
            max: f64::INFINITY,
            bounce_omega: std::f64::consts::TAU / DEFAULT_BOUNCE_RESPONSE,
            bounce_damping_ratio: DEFAULT_BOUNCE_DAMPING_RATIO,
            target_override: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum KineticSpec {
    Decay(DecaySpec),
    Inertia(InertiaSpec),
}

impl From<DecaySpec> for KineticSpec {
    fn from(value: DecaySpec) -> Self {
        Self::Decay(value)
    }
}

impl From<InertiaSpec> for KineticSpec {
    fn from(value: InertiaSpec) -> Self {
        Self::Inertia(value)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KineticSpecError {
    InvalidBounds,
}

impl fmt::Display for KineticSpecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidBounds => write!(f, "inertia min cannot be greater than max"),
        }
    }
}

impl Error for KineticSpecError {}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KineticSample {
    pub position: f64,
    pub velocity: f64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum KineticMode {
    Decay,
    Spring,
}

#[derive(Clone, Debug)]
pub(crate) struct KineticChannel {
    kind: KineticKind,
    mode: KineticMode,
    position: f64,
    velocity: f64,
    final_target: f64,
    time_constant: f64,
    rest_speed: f64,
    rest_delta: f64,
    min: f64,
    max: f64,
    bounce_omega: f64,
    bounce_damping_ratio: f64,
    settled: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum KineticKind {
    Decay,
    Inertia,
}

impl KineticSpec {
    fn normalized(self) -> Result<Self, KineticSpecError> {
        match self {
            Self::Decay(spec) => Ok(Self::Decay(DecaySpec {
                velocity: finite_option(spec.velocity),
                time_constant: finite_or(spec.time_constant, DEFAULT_TIME_CONSTANT)
                    .max(MIN_TIME_CONSTANT),
                power: finite_or(spec.power, 1.0).max(0.0),
                rest_speed: finite_or(spec.rest_speed, DEFAULT_REST_SPEED).max(0.0),
                target_override: finite_option(spec.target_override),
            })),
            Self::Inertia(spec) => {
                let min = if spec.min.is_nan() {
                    f64::NEG_INFINITY
                } else {
                    spec.min
                };
                let max = if spec.max.is_nan() {
                    f64::INFINITY
                } else {
                    spec.max
                };
                if min > max {
                    return Err(KineticSpecError::InvalidBounds);
                }
                Ok(Self::Inertia(InertiaSpec {
                    velocity: finite_option(spec.velocity),
                    time_constant: finite_or(spec.time_constant, DEFAULT_TIME_CONSTANT)
                        .max(MIN_TIME_CONSTANT),
                    power: finite_or(spec.power, 0.8).max(0.0),
                    rest_speed: finite_or(spec.rest_speed, DEFAULT_REST_SPEED).max(0.0),
                    rest_delta: finite_or(spec.rest_delta, DEFAULT_REST_DELTA).max(0.0),
                    min,
                    max,
                    bounce_omega: finite_or(
                        spec.bounce_omega,
                        std::f64::consts::TAU / DEFAULT_BOUNCE_RESPONSE,
                    )
                    .max(0.0),
                    bounce_damping_ratio: finite_or(
                        spec.bounce_damping_ratio,
                        DEFAULT_BOUNCE_DAMPING_RATIO,
                    )
                    .max(0.0),
                    target_override: finite_option(spec.target_override),
                }))
            }
        }
    }

    fn configured_velocity(self) -> Option<f64> {
        match self {
            Self::Decay(spec) => spec.velocity,
            Self::Inertia(spec) => spec.velocity,
        }
    }

    fn time_constant(self) -> f64 {
        match self {
            Self::Decay(spec) => spec.time_constant,
            Self::Inertia(spec) => spec.time_constant,
        }
    }

    fn power(self) -> f64 {
        match self {
            Self::Decay(spec) => spec.power,
            Self::Inertia(spec) => spec.power,
        }
    }

    fn target_override(self) -> Option<f64> {
        match self {
            Self::Decay(spec) => spec.target_override,
            Self::Inertia(spec) => spec.target_override,
        }
    }
}

impl KineticChannel {
    pub(crate) fn new(
        current: f32,
        inherited_velocity: f32,
        requested_spec: &KineticSpec,
    ) -> Result<Self, KineticSpecError> {
        let spec = requested_spec.normalized()?;
        let from = current as f64;
        let source_velocity = spec
            .configured_velocity()
            .unwrap_or(inherited_velocity as f64);
        let projected_target = project_decay_target(
            from,
            source_velocity,
            spec.time_constant(),
            spec.power(),
            spec.target_override(),
        );
        let initial_velocity = if spec.time_constant() > 0.0 {
            (projected_target - from) / spec.time_constant()
        } else {
            source_velocity * spec.power()
        };

        let channel = match spec {
            KineticSpec::Decay(spec) => Self {
                kind: KineticKind::Decay,
                mode: KineticMode::Decay,
                position: from,
                velocity: initial_velocity,
                final_target: projected_target,
                time_constant: spec.time_constant,
                rest_speed: spec.rest_speed,
                rest_delta: DEFAULT_REST_DELTA,
                min: f64::NEG_INFINITY,
                max: f64::INFINITY,
                bounce_omega: 0.0,
                bounce_damping_ratio: 1.0,
                settled: false,
            },
            KineticSpec::Inertia(spec) => {
                let outside = nearest_bound(from, spec.min, spec.max);
                let final_target = clamp_to_bounds(projected_target, spec.min, spec.max);
                Self {
                    kind: KineticKind::Inertia,
                    mode: if outside.is_some() {
                        KineticMode::Spring
                    } else {
                        KineticMode::Decay
                    },
                    position: from,
                    velocity: initial_velocity,
                    final_target: outside.unwrap_or(final_target),
                    time_constant: spec.time_constant,
                    rest_speed: spec.rest_speed,
                    rest_delta: spec.rest_delta,
                    min: spec.min,
                    max: spec.max,
                    bounce_omega: spec.bounce_omega,
                    bounce_damping_ratio: spec.bounce_damping_ratio,
                    settled: false,
                }
            }
        };

        Ok(channel)
    }

    pub(crate) fn position(&self) -> f32 {
        self.position as f32
    }

    pub(crate) fn velocity(&self) -> f32 {
        self.velocity as f32
    }

    pub(crate) fn settled(&self) -> bool {
        self.settled
    }

    pub(crate) fn snap(&mut self, target: f32) {
        self.position = target as f64;
        self.velocity = 0.0;
        self.final_target = target as f64;
        self.settled = true;
    }

    pub(crate) fn step(&mut self, dt_seconds: f32) {
        if self.settled || !dt_seconds.is_finite() || dt_seconds <= 0.0 {
            return;
        }

        let dt = dt_seconds as f64;
        if self.mode == KineticMode::Decay {
            let next = step_decay(self.position, self.velocity, dt, self.time_constant);
            self.position = next.position;
            self.velocity = next.velocity;

            if self.kind == KineticKind::Inertia {
                if let Some(crossed) = nearest_bound(self.position, self.min, self.max) {
                    self.mode = KineticMode::Spring;
                    self.final_target = crossed;
                }
            }

            if self.mode == KineticMode::Decay && self.velocity.abs() <= self.rest_speed {
                self.position = self.final_target;
                self.velocity = 0.0;
                self.settled = true;
                return;
            }
        }

        // The inherited engine enters bounce mode in the same frame a decay
        // crosses a bound, carrying the post-decay position and velocity into
        // the exact damped-spring solution.
        if self.mode == KineticMode::Spring {
            let next = step_damped_spring(
                self.position,
                self.velocity,
                self.final_target,
                self.bounce_omega,
                self.bounce_damping_ratio,
                dt,
            );
            self.position = next.position;
            self.velocity = next.velocity;

            if (self.final_target - self.position).abs() <= self.rest_delta
                && self.velocity.abs() <= self.rest_speed
            {
                self.position = self.final_target;
                self.velocity = 0.0;
                self.settled = true;
            }
        }
    }
}

fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

fn finite_option(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite())
}

/// Projects the inherited decay destination once. `target_override` is the
/// already-resolved result of the source runtime's optional `modifyTarget`
/// hook; non-finite overrides fall back to the ordinary projection.
pub fn project_decay_target(
    value: f64,
    velocity: f64,
    time_constant: f64,
    power: f64,
    target_override: Option<f64>,
) -> f64 {
    let base = value + velocity * time_constant * power;
    target_override
        .filter(|target| target.is_finite())
        .unwrap_or(base)
}

pub fn nearest_bound(value: f64, min: f64, max: f64) -> Option<f64> {
    if value < min {
        Some(min)
    } else if value > max {
        Some(max)
    } else {
        None
    }
}

pub fn clamp_to_bounds(value: f64, min: f64, max: f64) -> f64 {
    if !min.is_finite() && !max.is_finite() {
        value
    } else {
        value.clamp(min, max)
    }
}

/// Exact exponential integration for `dv/dt = -v/tau`.
pub fn step_decay(
    position: f64,
    velocity: f64,
    dt_seconds: f64,
    time_constant: f64,
) -> KineticSample {
    if !(dt_seconds > 0.0) || !(time_constant > 0.0) {
        return KineticSample { position, velocity };
    }
    let attenuation = (-dt_seconds / time_constant).exp();
    KineticSample {
        position: position + velocity * time_constant * (1.0 - attenuation),
        velocity: velocity * attenuation,
    }
}

/// Exact solution of `y'' + 2*zeta*omega*y' + omega^2*y = 0` around target.
pub fn step_damped_spring(
    position: f64,
    velocity: f64,
    target: f64,
    omega: f64,
    damping_ratio: f64,
    dt_seconds: f64,
) -> KineticSample {
    if !(dt_seconds > 0.0) || !(omega > 0.0) {
        return KineticSample { position, velocity };
    }

    let y0 = position - target;
    let v0 = velocity;
    let zeta = damping_ratio.max(0.0);

    if zeta < 1.0 - CRITICAL_EPSILON {
        let alpha = zeta * omega;
        let wd = omega * (1.0 - zeta * zeta).sqrt();
        let exp = (-alpha * dt_seconds).exp();
        let sin = (wd * dt_seconds).sin();
        let cos = (wd * dt_seconds).cos();
        let b = (v0 + alpha * y0) / wd;
        let y = exp * (y0 * cos + b * sin);
        let velocity = exp * (-alpha * (y0 * cos + b * sin) + (-y0 * wd * sin + b * wd * cos));
        return KineticSample {
            position: target + y,
            velocity,
        };
    }

    if zeta > 1.0 + CRITICAL_EPSILON {
        let root = (zeta * zeta - 1.0).sqrt();
        let r1 = -omega * (zeta - root);
        let r2 = -omega * (zeta + root);
        let denominator = r1 - r2;
        let c1 = (v0 - r2 * y0) / denominator;
        let c2 = y0 - c1;
        let e1 = (r1 * dt_seconds).exp();
        let e2 = (r2 * dt_seconds).exp();
        let y = c1 * e1 + c2 * e2;
        let velocity = c1 * r1 * e1 + c2 * r2 * e2;
        return KineticSample {
            position: target + y,
            velocity,
        };
    }

    let exp = (-omega * dt_seconds).exp();
    let b = v0 + omega * y0;
    let y = exp * (y0 + b * dt_seconds);
    let velocity = exp * (b - omega * (y0 + b * dt_seconds));
    KineticSample {
        position: target + y,
        velocity,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_damped_spring_is_stable_through_a_long_frame() {
        let one = step_damped_spring(180.0, 2500.0, 100.0, 25.0, 0.78, 0.2);
        let mut many = KineticSample {
            position: 180.0,
            velocity: 2500.0,
        };
        for _ in 0..20 {
            many = step_damped_spring(many.position, many.velocity, 100.0, 25.0, 0.78, 0.01);
        }

        assert!(one.position.is_finite());
        assert!(one.velocity.is_finite());
        assert!((one.position - many.position).abs() < 1e-9);
        assert!((one.velocity - many.velocity).abs() < 1e-8);
    }
}
