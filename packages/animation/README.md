# @mun/animation

A renderer-agnostic motion runtime focused on interruptibility, low main-thread cost, smooth retargeting, and scalable execution. Mün can consume it through an adapter, but the core has no Mün, DOM, React, or Vue dependency.

## Current state (0.2.2)

### Numeric runtime

- Numeric `MotionValue` with velocity tracking, detailed subscriptions, and allocation-free `subscribeValue()` listeners for hot render bindings.
- Interruptible springs. Retargeting preserves current position and velocity.
- Response/damping springs and low-level mass/stiffness/damping springs.
- Distance-adaptive `smooth`, `snappy`, `bouncy`, `gentle`, and `interactive` profiles.
- Cubic-bezier timing animations.
- Analytic exponential decay and bounded inertia for release motion.
- Exact damped-spring settling for low-count interaction physics, avoiding frame-rate-dependent substeps.
- One scheduler for all active motion.
- Dense spring storage with swap-remove.
- Bounded solver substeps for bad frame-time spikes.
- Reduced-motion support.

### Adaptive execution backends

- Zero-startup-cost JS spring kernel.
- Lazy WebAssembly promotion for larger spring batches.
- WebAssembly SIMD (`f32x4`) with scalar WASM fallback.
- State remains in WASM linear memory after promotion; there is no per-frame full-buffer copy.
- WASM memory grows on demand instead of imposing a fixed allocator ceiling.
- Optional Worker + `SharedArrayBuffer` + shared `WebAssembly.Memory` path.
- `worker: 'auto'` is now the default. It only prepares a Worker when workload crosses the threshold and gracefully stays on JS/WASM when shared memory is unavailable.
- The normal auto scheduler can switch itself to asynchronous Worker frames after the shared backend is ready.
- When a Worker frame is running, retarget/cancel/replace mutations are buffered to the frame boundary so the main thread never races the Worker over an in-flight shared slot.
- Overlapping `stepAsync()` calls are serialized at the engine level as well as the backend level.
- Supported environments use `Atomics.waitAsync()` for completion, eliminating the per-frame Worker `done` message. A message fallback remains for environments without it.
- Worker failure restores authoritative `MotionValue` state before falling back to the local shared-WASM path.
- Optional WebGPU Compute promotion (`gpu: 'auto'`) runs dense spring batches in a compute shader with asynchronous readback and automatically falls back when WebGPU is unavailable.

### Frame-budget governor

`FrameBudgetGovernor` tracks an exponential moving average of main-thread motion cost. Under sustained pressure it can lower the promotion thresholds, moving medium workloads to WASM or the Worker earlier without changing public motion semantics.

```js
const engine = new MotionEngine({
  frameBudgetMs: 7,
  adaptiveBackends: true,
  wasmThreshold: 256,
  workerThreshold: 4096,
});

console.log(engine.getBackendPlan());
```

The governor does not skip frames or silently lower animation quality. It only changes where the same solver work runs.

### Direct manipulation / gestures

The gesture package is renderer-agnostic. It turns pointer-like coordinates into `MotionValue` updates, release velocity, inertia, snapping, rubber-band bounds, and spring settling without knowing about DOM elements.

- `VelocityTracker` uses a short recency-weighted regression window instead of a single event delta.
- Tracking storage is a fixed-size typed-array ring buffer, so steady-state input sampling allocates no sample objects.
- `DragController` supports x/y/both axes, direction locking, dynamic bounds, momentum, snapping, and rubber-band resistance.
- Release motion preserves measured velocity and changes from decay to an exact damped spring only when a bound is crossed.
- The DOM adapter consumes `PointerEvent.getCoalescedEvents()` when available, retaining high-frequency pen/touch samples that browsers may merge into one delivered event.

```js
import { motionValue } from '@mun/animation';
import { createDragController } from '@mun/animation/gesture';
import { bindMotionStyles, bindPointerDrag } from '@mun/animation/dom';

const x = motionValue(0);
const drag = createDragController({
  x,
  axis: 'x',
  bounds: { minX: 0, maxX: 480 },
  snapX: [0, 160, 320, 480],
});

bindMotionStyles(card, { x });
const unbind = bindPointerDrag(card, drag);
```

The numeric core also exposes release motion directly:

```js
import { animateInertia } from '@mun/animation';

animateInertia(x, {
  velocity: 1450, // units per second
  min: 0,
  max: 480,
  timeConstant: 0.325,
});
```

### Keyframes, phases, and timeline graph

`Timeline` is a precompiled time-axis runtime rather than a Promise chain. Numeric keyframe times and values live in typed arrays, cubic-bezier curves are compiled once into shared lookup tables, and steady-state scalar sampling creates no timeline frame objects.

- Multiple tracks on one timeline.
- Nested timeline clips with offsets, playback speed, and fill policy.
- `play()`, `pause()`, `seek()`, `scrub()`, `reverse()`, playback-rate changes, finite/infinite repeats, and alternate direction.
- Exact numeric velocity propagation from keyframe tracks, so interrupting a timeline with a spring or inertia animation keeps motion continuity.
- Bidirectional ownership arbitration: a timeline interrupts an older spring/timeline on the same `MotionValue`, and starting an engine animation interrupts the owning timeline.
- Large frame gaps use wall-clock driver time while numerical spring integration keeps its safety clamp. Timelines therefore catch up after a suspended tab instead of playing in slow motion.
- `PhaseTimeline` compiles named multi-property choreography with transition durations and holds.
- `stagger()` supports first/last/center/index origins and optional easing.

```js
import {
  MotionEngine,
  curves,
  motionValue,
  timeline,
} from '@mun/animation';

const engine = new MotionEngine();
const x = motionValue(0);
const scale = motionValue(1);

const intro = timeline()
  .fromTo(x, 0, 280, {
    at: 0,
    duration: 0.42,
    easing: curves.smooth,
  })
  .fromTo(scale, 0.94, 1, {
    at: 0.08,
    duration: 0.28,
    easing: curves.easeOut,
  });

const player = intro.player({
  engine,
  iterations: 2,
  direction: 'alternate',
});

player.play();
player.scrub(0.5);  // deterministic seek, useful for interactive scrubbing
player.reverse();
```

Structured values can use the same timeline through the existing interpolation layer:

```js
const colorTimeline = timeline().fromTo(
  (color) => panel.style.backgroundColor = color,
  '#ff2d55',
  '#5ac8fa',
  { duration: 0.4, type: 'color', color: { space: 'oklab' } },
);
```

Named phases are convenient for reusable UI choreography:

```js
import { createPhaseTimeline } from '@mun/animation/timeline';

const press = createPhaseTimeline({ scale, opacity }, [
  { name: 'idle', values: { scale: 1, opacity: 1 } },
  { name: 'pressed', duration: 0.10, hold: 0.04, values: { scale: 0.96, opacity: 0.88 } },
  { name: 'release', duration: 0.18, values: { scale: 1, opacity: 1 } },
]);

press.player({ engine }).play();
```





Timeline playback can also be driven by a numeric interaction domain instead of a clock:

```js
import { createTimelineScrubber } from '@mun/animation/timeline';

// 0..400 can be drag pixels while the timeline remains normalized internally.
const scrubber = createTimelineScrubber(player, {
  min: 0,
  max: 400,
  snapPoints: [0, 400],
});

scrubber.set(160, 900);
scrubber.release(); // bounded inertia -> nearest snap point
```

The scrubber only depends on a `MotionValue`; a `DragController`, gamepad axis, scroll position, or custom input source can all drive it.

### State transitions and presence

The transition package adds named UI state motion without making the numeric core aware of components or renderers. Numeric `MotionValue` bindings are animated directly, so every property retains its own velocity during interruption. Structured bindings (colors, transforms, materials, paths, or custom interpolators) share one precompiled scalar progress animation per state change.

```js
import { motionValue, spring } from '@mun/animation';
import { createStateTransitionGraph } from '@mun/animation/transition';

const x = motionValue(0);
const opacity = motionValue(0);

const panel = createStateTransitionGraph({ x, opacity }, {
  hidden: { x: 24, opacity: 0 },
  visible: { x: 0, opacity: 1 },
  focused: { x: 0, opacity: 0.92 },
}, {
  initial: 'hidden',
  routes: {
    'hidden->visible': spring({ response: 0.32, dampingRatio: 0.82 }),
    '*->hidden': spring({ response: 0.24, dampingRatio: 0.9 }),
  },
});

panel.to('visible');
```

`TransitionController` is the two-state enter/exit convenience layer. Reversing an enter while it is still moving retargets the same numeric `MotionValue`s instead of restarting them from rest.

```js
import { createPresence, createTransition } from '@mun/animation/transition';

const transition = createTransition([
  { key: 'opacity', target: opacity, from: 0, to: 1 },
  { key: 'scale', target: scale, from: 0.96, to: 1 },
]);

const presence = createPresence(transition);
presence.enter();

// `rendered` stays true until exit motion actually finishes.
const exit = presence.exit();
await exit.finished;
console.log(presence.rendered); // false
```

If enter is requested during exit, the pending unmount is invalidated and the same values reverse smoothly.

### Structured interpolation

- Numbers.
- CSS colors: hex, rgb/rgba, hsl/hsla and common basic named colors.
- `srgb`, linear-light `linear-srgb`, `oklab`, and `oklch` interpolation.
- OKLab is the default color path for visually even transitions.
- Transparent endpoint chroma borrowing avoids the usual transparent-black fade halo.
- 2D CSS transform matrix composition/decomposition.
- Common 3D transform components.
- Shortest-path angle interpolation by default.
- Materials: blur, saturation, brightness, contrast and perceptual tint interpolation driven by a single progress value.
- SVG path morphing with one-time command normalization to cubic curves.
- `animateInterpolated()` drives structured output through the same scalar motion runtime.

### SVG path morphing

Path parsing and topology work happen once. Per-frame numeric sampling only lerps a reusable typed buffer.

Supported input commands include `M/L/H/V/C/S/Q/T/A/Z`, absolute or relative. Lines, quadratics and arcs normalize to cubic segments. Paths with different segment counts are equalized by splitting cubic curves. Closed paths can align starting segments and reverse winding to avoid needlessly long morphs.

```js
import { createPathMorpher } from '@mun/animation/path';

const morph = createPathMorpher(
  'M0 0 L100 0 L100 100 Z',
  'M20 10 C80 -20 120 60 80 120 Z',
);

// Allocation-free numeric sampling for Canvas/WebGL/custom renderers.
const coordinates = morph.sampleInto(0.5);

// SVG DOM route. Formatting is done only when a path string is needed.
const d = morph.sample(0.5);
```

For very large closed paths, alignment uses a bounded set of promising start-index candidates instead of exhaustive O(n^2) matching.

### Materials

The material model is renderer-agnostic. Presets are only convenient starting values.

```js
import { materials, mixMaterial } from '@mun/animation/material';

const material = mixMaterial(materials.ultraThin, materials.glass, 0.5);
```

The DOM adapter maps a resolved material to `backdrop-filter` plus a tint color:

```js
import { animateMaterial } from '@mun/animation/dom';
import { smooth } from '@mun/animation';

animateMaterial(panel, 'ultraThin', 'glass', smooth());
```

### Layout / FLIP

- `LayoutTransition` captures first and last bounds in separate read phases.
- Writes begin only after all last bounds have been measured.
- Position and size projection.
- Existing transforms are preserved and restored.
- Page-scroll compensation.
- Nested projection correction: an animated child removes the selected ancestor's projection instead of double-transforming.
- Interrupting an older layout transition captures the current visual rectangle before restoring the previous projection.



Matched geometry across different element instances uses keyed snapshots:

```js
import {
  captureSharedLayout,
  createSharedLayoutTransition,
} from '@mun/animation/layout';

const before = captureSharedLayout(oldTree, {
  key: (element) => element.dataset.motionKey,
});

// mutate / replace the tree here

const shared = createSharedLayoutTransition(before, newTree, {
  key: (element) => element.dataset.motionKey,
  fadeTarget: true,
});
shared.play();
```

The source element does not have to remain mounted. All matched targets in one shared transition use a single progress animation; each target only evaluates its projection matrix during the write phase. Duplicate source or target keys are rejected instead of being matched ambiguously. If a matched transition is interrupted, the next transition captures the currently rendered target geometry before cancelling the old projection so it can continue without jumping back to the underlying layout box.

### DOM adapter

- x/y/z, scale3d, rotateX/Y/Z bindings.
- Direct numeric style bindings with units.
- Structured `animateStyle()` for colors/transforms.
- `animateMaterial()` and `applyMaterial()`.
- `animatePath()` / `animateAttribute()` for SVG and other attributes.
- WAAPI escape hatch for fixed compositor-friendly keyframes.
- One global dirty-element queue: updating thousands of bound elements does not enqueue one microtask per element.
- Dirty compositor writes: direct/attribute updates do not reserialize transforms, and `will-change` is limited to the bound transform/opacity properties.
- Optional RAF-based DOM commit mode.
- Pointer-drag binding with pointer capture, touch-action management, cancellation handling, and coalesced-event sampling.

```js
import { configureDomBatching } from '@mun/animation/dom';

configureDomBatching({ scheduler: 'raf' });
```

## Basic numeric API

```js
import { motionValue, animate, smooth, spring } from '@mun/animation';

const x = motionValue(0);

x.subscribe((value, { velocity }) => {
  console.log(value, velocity);
});

// Hot render bindings that only need the value avoid allocating metadata.
x.subscribeValue((value) => render(value));

animate(x, 600, smooth());

// Retarget while moving. Existing velocity is kept.
setTimeout(() => {
  animate(x, -120, spring({
    response: 0.34,
    dampingRatio: 0.8,
  }));
}, 120);
```

For deterministic/manual stepping:

```js
import { MotionEngine, motionValue, spring } from '@mun/animation';

const engine = new MotionEngine({ autoStart: false, wasm: false, worker: false });
const x = motionValue(0);

engine.animate(x, 100, spring());
for (let frame = 0; frame < 120; frame += 1) {
  engine.step(1000 / 60);
}
```

## Color, transform, path, and material interpolation

```js
import { animateInterpolated, smooth } from '@mun/animation';

animateInterpolated(
  '#ff2d55',
  '#5ac8fa',
  smooth(),
  (color) => {
    element.style.backgroundColor = color;
  },
  { type: 'color', color: { space: 'oklab' } },
);
```

Transforms can be strings or component objects. A `350deg -> 10deg` rotation takes the short 20-degree route by default.

Path and material values use the same progress-channel mechanism:

```js
animateInterpolated(fromPath, toPath, smooth(), updatePath, {
  type: 'path',
  path: { precision: 2 },
});

animateInterpolated('clear', 'glass', smooth(), updateMaterial, {
  type: 'material',
});
```

## Layout animation

```js
import { smooth } from '@mun/animation';
import { animateLayout } from '@mun/animation/layout';

const { controls } = animateLayout(
  [sidebar, content],
  () => root.classList.toggle('expanded'),
  { spec: smooth() },
);

await controls?.finished;
```

The numeric core does not know that this is a layout animation.

## Worker + shared WASM

For normal browser use, `worker: 'auto'` lets the engine decide when to prepare and use the Worker. Explicit manual control is still available:

```js
const engine = new MotionEngine({
  autoStart: false,
  wasm: 'auto',
  worker: true,
  workerThreshold: 4096,
});

await engine.prepareWorker();

const values = Array.from({ length: 10000 }, () => motionValue(0));
for (const value of values) engine.animate(value, 200, spring());

await engine.stepAsync(1000 / 60);
```

The Worker and main thread instantiate the same kernel over the same shared `WebAssembly.Memory`. Spring state itself never crosses `postMessage`.

When `Atomics.waitAsync()` exists, the completion path is:

```text
main                         worker
 |                             |
 | count + dt + sequence       |
 | Atomics.notify -----------> |
 |                             | step_springs(...)
 |                             | store(doneSequence)
 | <---------- Atomics.notify  |
 | resume                      |
```

Without `Atomics.waitAsync()`, the backend uses the previous tiny `done` message as a fallback.

### Browser requirements for shared Worker execution

Shared WASM memory requires `SharedArrayBuffer`. On the web that normally means a secure, cross-origin-isolated page, for example:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

If shared memory is unavailable, `worker: 'auto'` keeps the regular JS/WASM execution path.


## Scroll-driven motion

`ScrollTracker` is renderer-independent: it maps an arbitrary scalar offset to a normalized `MotionValue`, while preserving offset and normalized velocity. The DOM/window `ScrollObserver` is a thin adapter that coalesces bursts of scroll events into one metric read per animation frame.

```js
import { observeScroll, bindScrollTimeline } from '@mun/animation/scroll';

const scroll = observeScroll(scroller, {
  axis: 'y',
  start: 0,
  end: (metrics) => metrics.max,
});

// player stays paused; scroll position deterministically seeks it.
const link = bindScrollTimeline(player, scroll);
```

The range may be dynamic, so resizes/content growth can be reflected on the next sampled frame without rebuilding the tracker. `ScrollTracker` itself can also be fed from a virtual scroller, game camera, native shell, or any other numeric source.

## Constraint graph

`ConstraintGraph` evaluates relationships between numeric values after source motion commits. The graph is compiled once into a topological operation order and typed arrays, rather than chaining one subscription callback per relationship.

```js
import { createConstraintGraph } from '@mun/animation/constraints';

const graph = createConstraintGraph();
const leader = graph.node(x, { name: 'leader' });
const follower = graph.node(y, { name: 'follower' });
const opacityNode = graph.node(opacity);

graph
  .affine(follower, leader, { scale: 0.5, offset: 24 })
  .clamp(opacityNode, follower, { min: 0, max: 1 })
  .attach(engine);
```

Built-in relations include affine/follow, clamp, weighted sum, mix, and custom mapping. Numeric velocity is propagated analytically through the built-in relations. This means a derived value can be interrupted by spring/inertia motion without first losing its instantaneous velocity.

The topology is intentionally locked after the first compile/evaluate. Runtime work is then just typed-array reads, a compact operation switch, and writes to bound outputs. Cycles are rejected at compile time.

## Canvas / WebGL / WebGPU adapters

Renderer adapters remain outside the motion solver. They subscribe through the value-only hot path and coalesce changes so a burst of `MotionValue` commits does not create one render submission per value.

Canvas keeps one retained `Float64Array` snapshot and invokes one draw callback per dirty frame:

```js
import { createCanvasRenderer } from '@mun/animation/canvas';

const renderer = createCanvasRenderer(ctx, [x, y, scale], (ctx, values) => {
  const [x, y, scale] = values;
  // draw using the retained numeric snapshot
});
```

WebGL resolves uniform locations once and batches dirty uniform uploads:

```js
import { createWebGLUniformBinder } from '@mun/animation/webgl';

const uniforms = createWebGLUniformBinder(gl, program, [
  { name: 'uProgress', value: progress },
  { name: 'uPosition', values: [x, y] },
]);
```

WebGPU packs scalar values into one retained `Float32Array` and emits one `queue.writeBuffer()` per dirty frame:

```js
import { createWebGPUBufferBinder } from '@mun/animation/webgpu';

const gpuValues = createWebGPUBufferBinder(device, uniformBuffer, [
  { value: x, index: 0 },
  { value: y, index: 1 },
  { value: opacity, index: 4 }, // explicit padding/layout is allowed
], { floatCount: 8 });
```

`WebGPUSpringBatch` is also available for direct dense spring workloads. It uses one storage buffer, one compute dispatch per bounded solver substep, and one readback per frame. Use it for sufficiently large batches; small interactive animations should stay on JS/WASM to avoid GPU submission and readback overhead.

```js
import { MotionEngine, motionValue, spring } from '@mun/animation';

const engine = new MotionEngine({ gpu: 'auto', gpuThreshold: 4096 });
const value = motionValue(0);
engine.animate(value, 1, spring());
await engine.stepAsync(16.6667);
console.log(engine.getBackendPlan().gpu);
```

## Package entry points

```text
@mun/animation
@mun/animation/dom
@mun/animation/interpolate
@mun/animation/layout
@mun/animation/gesture
@mun/animation/timeline
@mun/animation/transition
@mun/animation/scroll
@mun/animation/constraints
@mun/animation/canvas
@mun/animation/webgl
@mun/animation/webgpu
@mun/animation/material
@mun/animation/path
@mun/animation/wasm
@mun/animation/worker
```

## Build / test / benchmark

```sh
npm run build:wasm
npm test
npm run test:full
npm run typecheck
npm run bench -- 10000 600
npm run bench:worker -- 10000 300
npm run bench:path -- 256 10000
npm run bench:gestures -- 500000
npm run bench:timeline -- 10000 600
npm run bench:transitions -- 10000 1000
npm run bench:constraints -- 10000 1000
npm run bench:scroll -- 500000
npm run bench:renderers -- 1000 500
```

`npm test` runs the focused motion suite; `npm run test:full` runs every
non-browser test file.

`build:wasm` emits four binaries:

```text
kernel-scalar.wasm
kernel-simd.wasm
kernel-shared-scalar.wasm
kernel-shared-simd.wasm
```

The numeric benchmarks intentionally exclude browser layout, paint, compositing, input, and framework overhead.

## Deliberately outside the numeric core

Renderer-specific layout measurement, DOM style parsing, material rendering, path rendering, and framework bindings remain adapters or optional packages. Canvas/WebGL/WebGPU have lightweight value-to-renderer bridges, while dense WebGPU spring compute is an optional asynchronous backend selected by `MotionEngine`.

The next useful layers are a particle/mesh compute backend, richer rotated/skewed shared-layout geometry, declarative constraint presets, and framework bindings such as Mün.
