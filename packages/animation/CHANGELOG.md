# Changelog

## 0.2.2

- Avoided redundant DOM transform/opacity writes and limited `will-change` hints to active compositor bindings.
- Made the Node shared-worker backend retry without invalid inherited runtime flags instead of falling back to the main-thread solver.
- Added optional WebGPU Compute spring promotion with asynchronous readback, `gpu`/`gpuThreshold` engine options, telemetry, and automatic fallback.

## 0.7.0

- Added renderer-independent `ScrollTracker` with normalized progress and velocity-preserving offset mapping.
- Added `ScrollObserver`, coalescing arbitrary scroll-event bursts into one scroll-metric read/sample per animation frame.
- Added `ScrollTimelineLink` so a paused timeline can be deterministically scrubbed by scroll progress without becoming another running engine driver.
- Added compiled `ConstraintGraph` with affine/follow, clamp, weighted sum, mix, and reusable-buffer custom mappings.
- Built-in constraints propagate numeric velocity analytically and execute in a topologically sorted typed-array program; cycles are rejected at compile time.
- Added engine integration for constraint graphs: source commits mark the graph dirty and schedule one post-motion driver evaluation rather than a chain of per-edge subscriptions.
- Added `CanvasMotionRenderer`, retaining one numeric snapshot and coalescing many value changes into one draw per frame.
- Added `WebGLUniformBinder`, caching uniform locations and batching dirty uniform uploads.
- Added `WebGPUBufferBinder`, packing scalar motion values into a retained `Float32Array` and issuing one `queue.writeBuffer()` per dirty frame.
- Added `scroll`, `constraints`, `canvas`, `webgl`, and `webgpu` package entry points.
- Added scroll, constraint, and renderer-adapter microbenchmarks.
- Expanded runtime coverage from 91 to 103 tests while preserving the existing JS/WASM/Worker solver path.

## 0.6.0

- Added renderer-agnostic `StateTransitionGraph` with named states and route-specific motion specs.
- Numeric state bindings animate their `MotionValue`s directly, preserving per-property velocity through rapid state changes.
- Structured state bindings precompile interpolators and share one scalar progress animation per transition.
- Added two-state `TransitionController` for interruptible enter/exit motion.
- Added `PresenceController`, which keeps content logically rendered until exit finishes and cancels pending unmount when an enter interrupts exit.
- Added keyed shared-layout snapshots and matched-geometry transitions across different element instances.
- Shared-layout groups use one progress animation for all matched targets, with nested projection correction, optional target fade, and in-flight visual-geometry capture for interruption continuity.
- Added duplicate shared-layout source/target key detection to avoid ambiguous geometry matches.
- Reused per-item matrix buffers and moved fixed layout style writes out of the frame hot path, roughly halving the synthetic 1,000-target projection-write cost during development.
- Added `TimelineScrubber`, mapping arbitrary numeric input ranges to timeline progress and using the existing bounded inertia engine for release snapping.
- Added the transition package entry point (now `@mun/animation/transition`).
- Added transition/shared-layout microbenchmarks and expanded runtime coverage from 77 to 91 tests.

## 0.5.0

- Added precompiled `Timeline` and `TimelinePlayer` runtimes with play/pause/seek/scrub/reverse/playback-rate control.
- Added finite and infinite iterations plus normal/reverse/alternate/alternate-reverse playback.
- Added nested timeline clips with start offsets, speed scaling, and fill policies.
- Added typed-array numeric keyframe tracks with analytical velocity propagation into subsequent spring/inertia motion.
- Added cubic-bezier lookup-table compilation shared by keyframe tracks, reducing large timeline sampling cost substantially while keeping built-in curve position error below 0.0002 normalized.
- Added `fromTo()`, `to()`, `keyframes()`, and `stagger()` choreography helpers.
- Added named multi-target `PhaseTimeline` sequences with transition durations and holds.
- Added bidirectional motion ownership: timelines interrupt older engine/timeline owners and engine animations interrupt timelines without losing current velocity.
- Added generic engine drivers so non-spring clocks can share the same scheduler without entering the numeric spring backend.
- Timeline drivers now receive real wall-clock frame gaps while numerical spring integration retains its defensive `dt` bound.
- Coalesced large repeat jumps into one `onRepeat` callback carrying the number of crossed iterations.
- Added `MotionValue.subscribeValue()` and moved DOM/layout/interpolation hot bindings onto the value-only subscription path to avoid per-frame metadata allocation.
- Added timeline benchmark and expanded runtime coverage from 50 to 77 tests.

## 0.4.0

- Added analytic exponential decay and bounded inertia release animations.
- Added exact damped-spring settling for direct-manipulation bounds, stable across irregular frame intervals.
- Added `animateVelocity()`, `animateDecay()`, and `animateInertia()` APIs.
- Added renderer-agnostic `VelocityTracker` and `DragController`.
- Added dynamic bounds, momentum, snapping, direction locking, and rubber-band resistance.
- Reworked velocity history into a fixed typed-array ring buffer to avoid per-sample allocations.
- Added DOM `bindPointerDrag()` with pointer capture, cancellation cleanup, touch-action restoration, and coalesced pointer-event support.
- Added gesture/kinetics benchmarks.
- Expanded runtime coverage from 36 to 50 tests.

## 0.3.0

- Made Worker execution part of the normal auto scheduler.
- Added frame-boundary spring mutation buffering to remove shared-memory retarget/cancel races.
- Serialized engine-level async frames.
- Added Worker failure recovery back to authoritative `MotionValue` state.
- Added `Atomics.waitAsync()` completion path with message fallback.
- Added `FrameBudgetGovernor`, backend telemetry, and adaptive promotion thresholds.
- Changed default Worker mode to `auto`.
- Added SVG path parsing/morphing with cubic normalization, segment splitting, closed-path alignment, winding reversal, reusable numeric buffers, and bounded alignment candidate search.
- Added renderer-agnostic material interpolation and material presets.
- Added DOM material and SVG path adapters.
- Replaced per-element DOM microtask scheduling with one global dirty-element batch.
- Added path benchmarks and expanded tests/type smoke coverage.

## 0.2.0

- Added layout/FLIP animation with nested projection correction.
- Added transform and perceptual color interpolation.
- Added Worker + SharedArrayBuffer + shared WASM backend.
- Added shared SIMD/scalar WASM binaries.
- Removed the fixed 4 MiB allocator ceiling by allowing WASM memory growth.
