# Adaptive rendering quality

`@mun/ui/rendering-quality` exposes one browser rendering policy per `Window`, shared
by progressive blur, direct-web GPU island canvases (and their Canvas fallbacks), and
`CanvasMotionRenderer`. The implementation lives in `@mun/animation/rendering-quality`;
the pure numeric animation runtime does not start browser work merely by being imported.

| Level | Progressive blur | Continuous GPU/Canvas drawing |
| --- | --- | --- |
| `full` | Existing radius-based 3–8 layers; uniform 1 | Display cadence |
| `reduced` | 2 layers, preserving maximum radius; uniform 1 | At most 30fps |
| `none` | 0 layers, including uniform | Paused, retaining the last image |

Canvas motion bindings keep their newest numeric state while paused and draw it when
quality recovers. Reduced drawing retains a trailing update so the final value is not
lost. GPU island simulation deltas reflect elapsed time when drawing at 30fps and
reset on resume. The controller does not reduce solver accuracy, drop application
state, or change the semantics of WebGL/WebGPU data bindings and compute backends.
Custom visual renderers consume the same policy through the observer API.

## API and lifecycle

```ts
import {
  getRenderingQuality,
  observeRenderingQuality,
  prepareRenderingQuality,
} from "@mun/ui/rendering-quality"

// Optional preparation; never block startup by awaiting this.
const initialQuality = prepareRenderingQuality(window)

// Subscribe for the lifetime of a custom renderer. Mun's built-in consumers
// already do this and clean up their subscriptions on unmount/dispose.
const stop = observeRenderingQuality(({ quality }) => {
  customRenderer.setQuality(quality)
}, window)

// Optional telemetry from existing rendering work; add no monitoring frame loop.
const controller = getRenderingQuality(window)
controller?.recordFrame(existingFrameIntervalMs)
controller?.sampleGPUQueue(device.queue) // after an existing submission

// Dispose with the renderer.
stop()
```

`getRenderingQuality` creates no timers or observers. Its `snapshot` contains quality,
selection source, baseline interval, recent frame delay, GPU queue completion delay,
long-frame duration and last successful check time. `prepareRenderingQuality` shares
the initial promise and performs one startup preparation when used alone. Active
subscriptions keep monitoring alive. The last unsubscribe aborts pending sampling,
clears the check timer and disconnects observers. SSR returns full quality and starts
no work. An explicit owner Window supports iframe renderers without sharing unrelated
pages' state.

## Startup and periodic probe

The initial result can use the previous startup probe's cache. The cache remains
origin-local, versioned by browser UA, screen width/height, color depth and DPR.
Storage failures are caught; in-memory deduplication still applies. Switching screens
invalidates the controller's selection and prepares for the new configuration.

With active consumers, a single timer requests another check 30 seconds after the
previous check finishes. Remounts preserve that deadline. Periodic checks bypass the
cache and perform the same bounded CSS backdrop sample:

- Wait for load, a paint boundary, one second without input, and an idle callback
  with at least 8ms remaining. No idle timeout or timer fallback forces sampling.
- Repaint a 32×32 device-pixel patterned patch with three masked `backdrop-filter`
  layers. Collect two baseline intervals and two filtered intervals: six callbacks.
- Cancel on input, scrolling, resize, visibility changes, or pagehide. Give up after
  five seconds waiting for an opportunity, or 250ms of active sampling.
- Hidden pages suspend checks. Becoming visible resumes the shared deadline.

The filtered intervals must both exceed `max(24ms, baseline × 1.5)` for reduced,
or `max(48ms, baseline × 2.5)` for none. Baseline intervals must agree within
`max(2ms, baseline × 0.2)` and filtered intervals within 25%. Intervals outside
4–100ms or a baseline above 40ms are inconclusive. Initial uncertainty gives full;
runtime uncertainty preserves the current level and breaks the recovery streak.

## Passive pressure signals and recovery

Browsers expose no portable system GPU utilization percentage. The policy uses
observable pressure signals without allocating GPU query buffers or reading results
back from the GPU:

- Existing continuous renderer callbacks aggregate frame intervals into one-second
  windows. With at least 4 samples, a window is bad when at least 25% are delayed
  by `max(24ms, baseline × 1.5)` or more.
- WebGPU queue completion is observed at most once per second per queue, with only
  one outstanding observation. Completion delays of `max(32ms, baseline × 2)` or
  more are bad. A still-pending observation also reports backlog once per second.
  An outstanding queue observation prevents quality recovery.
  Queue rejection and completions from a stopped/hidden controller are ignored.
- A `PerformanceObserver` consumes long animation frames when supported, falling back
  to Long Tasks. Entries of at least 50ms supply another delay signal. There is no
  synthetic monitoring animation loop or short polling timer.

Three consecutive bad one-second windows from the same signal lower quality by one
level. Gaps above 2.5 seconds reset a streak, and changes under continuing pressure
are separated by at least 10 seconds. The startup sample itself is excluded from
pressure accounting. Healthy probes can restore one level only after two consecutive
successful checks and at least 30 seconds without observed pressure. This slower
recovery avoids reacting to a single good frame or oscillating after a brief pause.

These signals include CPU/scheduling delays and describe this page's work, not total
system GPU usage. The small CSS probe cannot predict every large surface or shader.
Missing APIs preserve safe behavior; they do not manufacture a utilization reading.

## Verification

`tests/rendering-quality.test.mjs` uses a controlled browser clock to verify shared
deadlines, cache bypass, hysteresis, late frames, backed-up queues, hidden pages,
screen changes, live blur/canvas adaptation, trailing motion values, and disposal.
Existing blur planner, SSR/hydration, GPU-residency and animation adapter suites cover
the surrounding contracts.

Build `@mun/animation`, then run `node benchmarks/progressive-blur.mjs` for cold/cache
cost measurements, or `node benchmarks/progressive-blur.mjs --monitor` for a real
30-second cycle. On 2026-10-27, headless Chromium 156.0.8078.4 with SwiftShader
measured 31.095 seconds between two patch insertions (30-second delay plus idle/paint
gates), 78.8ms and 81.8ms patch residence, and no Long Tasks across the cycle.
Six cold runs at DPR 1 and 2 measured 1.8–4.5ms summed instrumented callback time
(maximum callback 1.8ms), 1.13–5.53ms summed style/layout/paint CPU trace time, and
79.5–81.5ms patch residence. Cached reloads created no sample nodes or sample frames
and used 0.1–0.3ms callback time. Instrumentation and tracing add overhead.
Hardware GPU utilization and mobile/Safari/Firefox behavior remain unmeasured.

References: [idle scheduling](https://www.w3.org/TR/requestidlecallback/),
[long animation frames](https://www.w3.org/TR/long-animation-frames/),
[GPU queue completion semantics](https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/onSubmittedWorkDone),
and [CSS backdrop filtering](https://drafts.csswg.org/filter-effects-2/#BackdropFilterProperty).
