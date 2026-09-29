import { FrameBudgetGovernor as ExecutionFrameBudgetGovernor, type FrameBudgetSnapshot } from '@mun/execution';

export type AnimationStatus = 'finished' | 'interrupted' | 'cancelled';
export type AnimationResult = { status: AnimationStatus; value: number; reducedMotion?: boolean };
export type SpringSpec = { kind: 'spring'; omega: number; dampingRatio: number; initialVelocity?: number; blendDuration?: number; source: string };
export type TimingSpec = { kind: 'timing'; duration: number; curve: BezierCurve };
export type ProfileSpec = { kind: 'profile'; name: string; options: Record<string, number> };
export type MotionSpec = SpringSpec | TimingSpec | ProfileSpec;
export type SpringMotionExecutionPlan = {
  kind: 'motion-plan';
  route: 'spring';
  spec: SpringSpec;
  omega: number;
  dampingRatio: number;
  initialVelocity?: number;
  blendDurationMs: number;
};
export type TimingMotionExecutionPlan = {
  kind: 'motion-plan';
  route: 'timing';
  spec: TimingSpec;
  durationMs: number;
  easing: CompiledEasing;
};
export type ProfileMotionExecutionPlan = {
  kind: 'motion-plan';
  route: 'profile';
  spec: ProfileSpec;
};
export type MotionExecutionPlan = SpringMotionExecutionPlan | TimingMotionExecutionPlan | ProfileMotionExecutionPlan;
export type ResolvedMotionExecutionPlan = SpringMotionExecutionPlan | TimingMotionExecutionPlan;
export type DecayOptions = {
  velocity?: number;
  timeConstant?: number;
  power?: number;
  restSpeed?: number;
  modifyTarget?: (target: number) => number;
};
export type DecaySpec = {
  kind: 'decay';
  velocity?: number;
  timeConstant: number;
  power: number;
  restSpeed: number;
  modifyTarget?: (target: number) => number;
};
export type InertiaOptions = DecayOptions & {
  min?: number;
  max?: number;
  restDelta?: number;
  bounce?: SpringSpec;
  bounceResponse?: number;
  bounceDampingRatio?: number;
};
export type InertiaSpec = {
  kind: 'inertia';
  velocity?: number;
  timeConstant: number;
  power: number;
  restSpeed: number;
  restDelta: number;
  min: number;
  max: number;
  bounceOmega: number;
  bounceDampingRatio: number;
  modifyTarget?: (target: number) => number;
};
export type VelocityAnimationSpec = DecaySpec | InertiaSpec;
export type BezierCurve = { kind: 'bezier'; x1: number; y1: number; x2: number; y2: number };
export type CompiledEasing = { kind: 'linear' } | { kind: 'function'; easing: (progress: number) => number } | { kind: 'lut'; values: Float64Array };
export function compileEasing(easing?: BezierCurve | ((progress: number) => number)): CompiledEasing;
export function evaluateCompiledEasing(compiled: CompiledEasing, progress: number): number;
export function derivativeCompiledEasing(compiled: CompiledEasing, progress: number): number;
export type WorkerMode = boolean | 'auto';
export type GpuMode = boolean | 'auto';

export class MotionValue {
  constructor(initial?: number);
  get(): number;
  getVelocity(): number;
  getVersion(): number;
  set(value: number, velocity?: number): void;
  subscribe(listener: (value: number, info: { previous: number; velocity: number; version: number }) => void, options?: { emitCurrent?: boolean }): () => void;
  subscribeValue(listener: (value: number) => void, options?: { emitCurrent?: boolean }): () => void;
}
export function motionValue(initial?: number): MotionValue;

export class AnimationControls {
  cancel(): void;
  finish(): void;
  readonly finished: Promise<AnimationResult>;
}

export type MotionEngineOptions = {
  autoStart?: boolean;
  wasm?: 'auto' | boolean;
  wasmThreshold?: number;
  maxWasmMotions?: number;
  worker?: WorkerMode;
  workerThreshold?: number;
  gpu?: GpuMode;
  gpuThreshold?: number;
  gpuDevice?: unknown;
  autoWorkerScheduler?: boolean;
  adaptiveBackends?: boolean;
  frameBudgetMs?: number | false;
  respectReducedMotion?: boolean;
};

export class MotionEngine {
  constructor(options?: MotionEngineOptions);
  animate(value: MotionValue, to: number, spec?: MotionSpec | MotionExecutionPlan): AnimationControls;
  animateVelocity(value: MotionValue, spec?: VelocityAnimationSpec | InertiaOptions): AnimationControls;
  addDriver(driver: { step(dtMs: number): boolean | void; owns?(value: MotionValue): boolean; interruptValue?(value: MotionValue, status?: 'cancelled' | 'interrupted'): boolean | void; onEngineDispose?(): void }): () => void;
  removeDriver(driver: object): boolean;
  stop(value: MotionValue, status?: 'cancelled' | 'interrupted'): void;
  step(dtMs: number): void;
  stepAsync(dtMs: number): Promise<void>;
  prepareWasm(): Promise<unknown>;
  prepareWorker(): Promise<unknown>;
  prepareGpu(): Promise<unknown>;
  maybePromoteToWasm(): void;
  maybePromoteToWorker(): boolean;
  maybePromoteToGpu(): boolean;
  dispose(): void;
  readonly stats: {
    frames: number;
    promotedToWasm: boolean;
    promotedToWorker: boolean;
    promotedToGpu: boolean;
    backend: string;
    lastDtMs: number;
    syncFrames: number;
    asyncFrames: number;
    workerFrames: number;
    workerFailures: number;
    gpuFrames: number;
    gpuFailures: number;
    lastStepWallMs: number;
    lastMainThreadMs: number;
    emaMainThreadMs: number;
    budgetPressure: number;
    budgetLevel: 'idle' | 'comfortable' | 'pressured' | 'critical';
    effectiveWasmThreshold: number;
    effectiveWorkerThreshold: number;
    activeSprings: number;
    activeKinetics: number;
    activeDrivers: number;
    pendingMutations: number;
  };
  getBackendPlan(): {
    current: string;
    activeSprings: number;
    activeKinetics: number;
    wasm: { mode: 'auto' | boolean; ready: boolean; threshold: number };
    worker: { mode: WorkerMode; ready: boolean; unavailable: boolean; threshold: number; inFlight: boolean };
    gpu: { mode: GpuMode; ready: boolean; unavailable: boolean; threshold: number; inFlight: boolean };
    budget: FrameBudgetSnapshot | null;
  };
}


export type { FrameBudgetLevel, FrameBudgetSnapshot } from '@mun/execution';

export class FrameBudgetGovernor extends ExecutionFrameBudgetGovernor {
  constructor(options?: { budgetMs?: number; alpha?: number; minWasmThreshold?: number; minWorkerThreshold?: number });
  wasmThreshold(baseThreshold: number, activeCount: number): number;
  workerThreshold(baseThreshold: number, activeCount: number): number;
}

export const defaultEngine: MotionEngine;
export function animate(value: MotionValue, to: number, spec?: MotionSpec | MotionExecutionPlan): AnimationControls;
export function animateVelocity(value: MotionValue, spec?: VelocityAnimationSpec | InertiaOptions): AnimationControls;
export function animateDecay(value: MotionValue, options?: DecayOptions): AnimationControls;
export function animateInertia(value: MotionValue, options?: InertiaOptions): AnimationControls;
export function spring(options?: { response?: number; dampingRatio?: number; initialVelocity?: number; blendDuration?: number }): SpringSpec;
export namespace spring { function physics(options?: { mass?: number; stiffness?: number; damping?: number; initialVelocity?: number; blendDuration?: number }): SpringSpec; }
export function timing(options?: { duration?: number; curve?: BezierCurve }): TimingSpec;
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): BezierCurve;
export const curves: Record<'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'smooth', BezierCurve>;
export function smooth(options?: { responseBias?: number }): ProfileSpec;
export function snappy(options?: { responseBias?: number }): ProfileSpec;
export function bouncy(options?: { responseBias?: number }): ProfileSpec;
export function gentle(options?: { responseBias?: number }): ProfileSpec;
export function interactive(options?: { responseBias?: number }): ProfileSpec;
export function resolveMotionSpec(spec: MotionSpec | undefined, from: number, to: number): SpringSpec | TimingSpec;
export function isMotionExecutionPlan(value: unknown): value is MotionExecutionPlan;
export function compileMotionPlan(spec?: MotionSpec | MotionExecutionPlan): MotionExecutionPlan;
export function resolveMotionPlan(plan: MotionSpec | MotionExecutionPlan | undefined, from: number, to: number): ResolvedMotionExecutionPlan;
export function decay(options?: DecayOptions): DecaySpec;
export function inertia(options?: InertiaOptions): InertiaSpec;
export function projectDecayTarget(value: number, velocity: number, spec: DecaySpec | InertiaSpec): number;
export function stepDecay(position: number, velocity: number, dtSeconds: number, timeConstant: number, out?: { position: number; velocity: number }): { position: number; velocity: number };
export function stepDampedSpring(position: number, velocity: number, target: number, omega: number, dampingRatio: number, dtSeconds: number, out?: { position: number; velocity: number }): { position: number; velocity: number };
export function delay(milliseconds: number): Promise<void>;
export function parallel(...factories: Array<(() => AnimationControls | Promise<unknown>) | Promise<unknown>>): Promise<unknown[]>;
export function sequence(...factories: Array<(() => AnimationControls | Promise<unknown>) | Promise<unknown>>): Promise<unknown[]>;
export { WebGPUSpringBatch } from './src/webgpu/index.js';

export type Color = { r: number; g: number; b: number; a?: number };
export type ColorInput = string | Color | [number, number, number] | [number, number, number, number];
export type ColorSpace = 'srgb' | 'linear-srgb' | 'oklab' | 'oklch';
export function parseColor(input: ColorInput): Required<Color>;
export function formatColor(color: Color): string;
export function mixColor(from: ColorInput, to: ColorInput, progress: number, options?: { space?: ColorSpace }): Required<Color>;
export function interpolateColor(from: ColorInput, to: ColorInput, options?: { space?: ColorSpace }): (progress: number) => string;

export type TransformValue = {
  x?: number; y?: number; z?: number;
  scale?: number; scaleX?: number; scaleY?: number; scaleZ?: number;
  rotate?: number; rotateX?: number; rotateY?: number; rotateZ?: number;
  skewX?: number; skewY?: number;
  perspective?: number;
};
export type ParsedTransform = Required<Omit<TransformValue, 'scale' | 'rotate'>>;
export function parseTransform(input: string | TransformValue): ParsedTransform;
export function formatTransform(value: string | TransformValue): string;
export function mixTransform(from: string | TransformValue, to: string | TransformValue, progress: number, options?: { shortestRotation?: boolean }): ParsedTransform;
export function interpolateTransform(from: string | TransformValue, to: string | TransformValue, options?: { shortestRotation?: boolean }): (progress: number) => string;
export function interpolateNumber(from: number, to: number): (progress: number) => number;

export type PathMorphOptions = { align?: boolean; allowReverse?: boolean; precision?: number; alignmentCandidates?: number };

export type MaterialInput = 'clear' | 'ultraThin' | 'thin' | 'regular' | 'thick' | 'glass' | {
  blur?: number;
  saturation?: number;
  brightness?: number;
  contrast?: number;
  tint?: ColorInput;
  tintStrength?: number;
};
export type ResolvedMaterial = {
  blur: number;
  saturation: number;
  brightness: number;
  contrast: number;
  tint: Required<Color>;
  tintStrength: number;
};

export type InterpolatorOptions = {
  type?: 'color' | 'transform' | 'path' | 'material';
  color?: { space?: ColorSpace };
  transform?: { shortestRotation?: boolean };
  path?: PathMorphOptions;
  material?: { colorSpace?: ColorSpace };
  interpolate?: (from: unknown, to: unknown, progress: number) => unknown;
};
export function createInterpolator<T = unknown>(from: T, to: T, options?: InterpolatorOptions): (progress: number) => T | string | number;
export function animateInterpolated<T>(
  from: T,
  to: T,
  spec: MotionSpec | undefined,
  onUpdate: (value: unknown, progress: number) => void,
  options?: InterpolatorOptions & { engine?: MotionEngine },
): AnimationControls;


export type ParsedPathSegment = {
  p0: { x: number; y: number };
  p1: { x: number; y: number };
  p2: { x: number; y: number };
  p3: { x: number; y: number };
};
export function parsePath(path: string): { subpaths: Array<{ segments: ParsedPathSegment[]; closed: boolean }> };
export function normalizePathPair(fromPath: string, toPath: string, options?: PathMorphOptions): {
  from: { coords: Float64Array; subpaths: Array<{ offset: number; count: number; closed: boolean }> };
  to: { coords: Float64Array; subpaths: Array<{ offset: number; count: number; closed: boolean }> };
};
export class PathMorpher {
  constructor(fromPath: string, toPath: string, options?: PathMorphOptions);
  readonly coordinateCount: number;
  readonly segmentCount: number;
  readonly from: Float64Array;
  readonly to: Float64Array;
  readonly buffer: Float64Array;
  sampleInto(progress: number, output?: Float64Array): Float64Array;
  format(buffer?: Float64Array): string;
  sample(progress: number): string;
}
export function createPathMorpher(fromPath: string, toPath: string, options?: PathMorphOptions): PathMorpher;
export function interpolatePath(fromPath: string, toPath: string, options?: PathMorphOptions): (progress: number) => string;

export const materials: Readonly<Record<'clear' | 'ultraThin' | 'thin' | 'regular' | 'thick' | 'glass', Readonly<MaterialInput>>>;
export function resolveMaterial(input?: MaterialInput): ResolvedMaterial;
export function mixMaterial(from: MaterialInput, to: MaterialInput, progress: number, options?: { colorSpace?: ColorSpace }): ResolvedMaterial;
export function interpolateMaterial(from: MaterialInput, to: MaterialInput, options?: { colorSpace?: ColorSpace }): (progress: number) => ResolvedMaterial;
export function materialToCss(input: MaterialInput): { backdropFilter: string; backgroundColor: string };


export type Point = { x: number; y: number };
export type DragBounds = { minX?: number; maxX?: number; minY?: number; maxY?: number };
export type DragAxis = 'x' | 'y' | 'both';
export type DragState = {
  active: boolean;
  axis: DragAxis;
  lockedAxis: 'x' | 'y' | null;
  point: Point;
  value: { x: number | null; y: number | null };
  velocity: Point;
};
export type GroupAnimationControls = { cancel(): void; finish(): void; finished: Promise<Array<AnimationResult>> };
export class VelocityTracker {
  constructor(options?: { windowMs?: number; maxSamples?: number; maxVelocity?: number });
  readonly velocity: number;
  reset(value: number, time?: number): this;
  add(value: number, time?: number): this;
}
export function rubberBandDistance(distance: number, dimension?: number, constant?: number): number;
export function constrainWithRubberBand(value: number, min?: number, max?: number, options?: { enabled?: boolean; constant?: number; dimension?: number }): number;
export type DragControllerOptions = {
  x?: MotionValue | null; y?: MotionValue | null; axis?: DragAxis; engine?: MotionEngine;
  bounds?: DragBounds | (() => DragBounds) | null; momentum?: boolean; inertia?: InertiaOptions;
  rubberBand?: boolean | number; rubberBandConstant?: number; rubberBandDimension?: number | { x?: number; y?: number };
  directionLock?: boolean; directionLockThreshold?: number;
  snapX?: number[] | ((target: number) => number) | null; snapY?: number[] | ((target: number) => number) | null;
  settle?: { response?: number; dampingRatio?: number };
  velocity?: { windowMs?: number; maxSamples?: number; maxVelocity?: number };
  onStart?: (state: DragState) => void; onMove?: (state: DragState) => void;
  onEnd?: (state: DragState & { controls: GroupAnimationControls }) => void;
};
export class DragController {
  constructor(options?: DragControllerOptions);
  readonly active: boolean; readonly lockedAxis: 'x' | 'y' | null;
  start(point: Point, time?: number): DragState; move(point: Point, time?: number): DragState;
  end(time?: number): DragState & { controls: GroupAnimationControls };
  cancel(options?: { settle?: boolean }): DragState; getState(): DragState;
}
export function createDragController(options?: DragControllerOptions): DragController;


export type TimelineEasing = BezierCurve | ((progress: number) => number);
export type TimelineKeyframe<T> = {
  at?: number;
  time?: number;
  offset?: number;
  value: T;
  easing?: TimelineEasing;
};
export type TimelineTrackOptions = InterpolatorOptions & {
  duration?: number;
  easing?: TimelineEasing;
};
export type TimelineDirection = 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';
export type TimelineFill = 'none' | 'forwards' | 'backwards' | 'both';
export type TimelineStatus = 'finished' | 'cancelled' | 'interrupted';
export type TimelineResult = {
  status: TimelineStatus;
  currentTime: number;
  elapsedTime: number;
  progress: number;
  iteration: number;
};
export type TimelinePlayerOptions = {
  engine?: MotionEngine;
  autoplay?: boolean;
  playbackRate?: number;
  iterations?: number;
  direction?: TimelineDirection;
  onUpdate?: (player: TimelinePlayer) => void;
  onRepeat?: (iteration: number, player: TimelinePlayer, crossedIterations: number) => void;
  onComplete?: (player: TimelinePlayer) => void;
};

export class Timeline {
  constructor(options?: { duration?: number; easing?: TimelineEasing });
  readonly duration: number;
  track(target: MotionValue, frames: Array<number | TimelineKeyframe<number>>, options?: { duration?: number; easing?: TimelineEasing }): this;
  track<T>(target: ((value: T, velocity?: number) => void) | { set(value: T, velocity?: number): void }, frames: Array<T | TimelineKeyframe<T>>, options?: TimelineTrackOptions): this;
  keyframes(target: MotionValue, frames: Array<number | TimelineKeyframe<number>>, options?: { duration?: number; easing?: TimelineEasing }): this;
  keyframes<T>(target: ((value: T, velocity?: number) => void) | { set(value: T, velocity?: number): void }, frames: Array<T | TimelineKeyframe<T>>, options?: TimelineTrackOptions): this;
  fromTo(target: MotionValue, from: number, to: number, options?: { at?: number; duration?: number; easing?: TimelineEasing }): this;
  fromTo<T>(target: ((value: T, velocity?: number) => void) | { set(value: T, velocity?: number): void }, from: T, to: T, options?: TimelineTrackOptions & { at?: number }): this;
  to(target: MotionValue, to: number, options?: { at?: number; duration?: number; easing?: TimelineEasing; from?: number }): this;
  to<T>(target: ((value: T, velocity?: number) => void) | { get?(): T; set(value: T, velocity?: number): void }, to: T, options?: TimelineTrackOptions & { at?: number; from?: T }): this;
  add(child: Timeline, options?: { at?: number; speed?: number; fill?: TimelineFill }): this;
  sample(time: number, options?: { velocityScale?: number }): number;
  zeroVelocities(): void;
  hasMotionValue(value: MotionValue): boolean;
  stopConflicts(engine: MotionEngine): void;
  player(options?: TimelinePlayerOptions): TimelinePlayer;
}

export class TimelinePlayer {
  constructor(timeline: Timeline, options?: TimelinePlayerOptions);
  readonly timeline: Timeline;
  readonly engine: MotionEngine;
  readonly duration: number;
  readonly totalDuration: number;
  readonly finished: Promise<TimelineResult>;
  readonly running: boolean;
  state: 'idle' | 'running' | 'paused' | TimelineStatus;
  playbackRate: number;
  readonly iterations: number;
  readonly direction: TimelineDirection;
  elapsedTime: number;
  currentTime: number;
  progress: number;
  iteration: number;
  play(): this;
  pause(): this;
  cancel(): this;
  finish(): this;
  reverse(): this;
  setPlaybackRate(rate: number): this;
  seek(timeSeconds: number, options?: { iteration?: number }): this;
  seekProgress(progress: number, options?: { iteration?: number }): this;
  scrub(progress: number, options?: { iteration?: number }): this;
  seekElapsed(elapsedSeconds: number): this;
  step(dtMs: number): boolean;
  owns(value: MotionValue): boolean;
  interruptValue(value: MotionValue, status?: 'cancelled' | 'interrupted'): boolean;
}

export type PhaseTarget<T = unknown> =
  | MotionValue
  | ((value: T) => void)
  | { set(value: T): void }
  | ({ target: MotionValue | ((value: T) => void) | { set(value: T): void } } & TimelineTrackOptions);
export type PhaseDefinition = {
  name?: string;
  duration?: number;
  hold?: number;
  easing?: TimelineEasing;
  values?: Record<string, unknown>;
};

export class PhaseTimeline {
  constructor(
    targets: Record<string, PhaseTarget>,
    phases: PhaseDefinition[],
    options?: { defaultDuration?: number; easing?: TimelineEasing },
  );
  readonly names: string[];
  readonly arrivals: Float64Array;
  readonly timeline: Timeline;
  readonly duration: number;
  phaseAt(timeSeconds: number): string;
  player(options?: TimelinePlayerOptions): TimelinePlayer;
  sample(time: number, options?: { velocityScale?: number }): number;
}

export function timeline(options?: { duration?: number; easing?: TimelineEasing }): Timeline;
export function createPhaseTimeline(
  targets: Record<string, PhaseTarget>,
  phases: PhaseDefinition[],
  options?: { defaultDuration?: number; easing?: TimelineEasing },
): PhaseTimeline;
export function stagger(
  interval: number,
  options?: { start?: number; from?: 'first' | 'last' | 'center' | number; easing?: TimelineEasing },
): (index: number, total: number) => number;


export { TimelineScrubber, createTimelineScrubber } from './src/timeline/index.js';
export {
  StateTransitionGraph,
  TransitionController,
  PresenceController,
  createStateTransitionGraph,
  createTransition,
  createPresence,
} from './src/transition/index.js';
export type {
  StateBinding,
  TransitionBinding,
  TransitionGroupControls,
  TransitionGroupResult,
  TransitionRoutes,
  TransitionTarget,
} from './src/transition/index.js';

export * from './src/scroll/index.js';
export * from './src/constraints/index.js';
