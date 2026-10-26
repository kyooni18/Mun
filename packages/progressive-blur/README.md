# @mun/progressive-blur

Progressive (variable-radius) blur as a SwiftUI-style modifier for Mün.

> **Use `@mun/ui/progressive-blur`.** Progressive blur is an opt-in feature bundled with
> `@mun/ui`, so no extra install is needed. This package is the internal implementation
> module that `@mun/ui` re-exports. Importing `@mun/progressive-blur` directly still works
> and yields the same module instance, but new code should use the `@mun/ui` path.

```ts
import { BlurProfile, blurFocus, focus, progressiveBlur } from "@mun/ui/progressive-blur"

// Under a bar: strongest at the bottom edge, fading out over 120pt.
content.modifier(progressiveBlur(BlurProfile.edge("bottom", 120), { radius: 14 }))

// Gradient blur between two points, limited to a shape.
photo.modifier(progressiveBlur(BlurProfile.linear({ from: "center", to: "bottom" }), { radius: 16, in: RoundedRectangle(24) }))

// Around another view, without measuring anything yourself.
menu.modifier(blurFocus("menu"))
screen.modifier(progressiveBlur(BlurProfile.radial({ around: focus("menu"), inner: 120, outer: 360 }), { radius: 10, amount: isOpen ? 1 : 0 }))
```

- **Profile** (`BlurProfile.uniform | linear | edge | radial`, then `.easing("smooth")`, `.inverted()`) says where and how fast the blur ramps.
- **Scope** is the view the modifier is attached to, optionally clipped with `in:`.
- **`amount`** (0...1) fades the effect; changing it animates.
- `ProgressiveBlur(profile, options)` is the underlying View (backdrop blur); use it in `.overlay`/`.background`/ZStack directly.
- `@mun/ui/progressive-blur/plan` is the pure, DOM-free planner (profile to masked layers), shared by any renderer.

The web renderer stacks masked `backdrop-filter` layers. Avoid `opacity` or `filter` on an ancestor of the blurred
view, since that makes a backdrop root and the blur then sees only the ancestor's contents.

Notes: the blur covers the modified view's layout box (a `position: fixed` root has none, so give it a real box), and it
paints above the view's content; keep menus or toasts that must stay sharp above it with their own `z-index`.

The direct web GPU renderer schedules `prepareProgressiveBlur()` when an experimental
GPU island starts. GPU activation does not wait for it. CSS-only hosts can call the
same function explicitly from `@mun/ui/progressive-blur`. It returns a shared promise
of `"full" | "reduced" | "none"`; prepare early and consume it before opening a later
blurred panel. Importing this module starts no work.

Preparation waits for `load`, two animation callbacks (a paint boundary), one second
without input, and `requestIdleCallback` with at least 8ms remaining. It never supplies
an idle timeout or substitutes a timer for idle work. Input, scrolling, resize,
visibility changes, missing APIs, exceptions, or five seconds without an opportunity
give up with full quality. A running sample is removed on input or after 250ms.
The sample is a visible 32×32 device-pixel patch in the bottom-right corner, with
three masked CSS `backdrop-filter` layers. It repaints its own patterned backdrop,
collects two unfiltered intervals and two filtered intervals (six animation callbacks),
then removes itself. There are no layout reads, GPU readbacks, workers or ongoing loop.

The conservative thresholds compare both filtered intervals with the average baseline:

| Quality | Required filtered interval, for both samples | Active layers |
| --- | --- | --- |
| full | Default, including any ambiguity | Existing 3–8; uniform 1 |
| reduced | At least `max(24ms, baseline × 1.5)` | 2; uniform 1 |
| none | At least `max(48ms, baseline × 2.5)` | 0, including uniform |

Baseline intervals must agree within `max(2ms, baseline × 0.2)`, and filtered intervals
within 25%. Invalid intervals, intervals outside 4–100ms, or baseline above 40ms give
full quality. These are cautious heuristics, not hardware-calibrated GPU timings.
The reduced plan recalculates masks and layer radii to retain the intended maximum
radius. Mounted blur applies the result without replacing hydrated nodes; unused
layers have `display:none` and no backdrop filter. SSR and pending/unavailable
preparation retain full quality, so existing first-paint HTML remains supported.

Results are cached in memory and origin-local storage under a versioned browser UA,
screen width/height, color depth and DPR key. Reads and writes occur in idle callbacks;
storage errors are caught. Without storage, deduplication lasts for the current page.
Simultaneous tabs may each sample before either writes its result.

Research: [the idle scheduling specification](https://www.w3.org/TR/requestidlecallback/)
explains why optional work should use idle periods; a timeout may force busy execution.
[Animation callbacks](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)
provide frame pacing rather than an isolated GPU timer. [CSS backdrop filtering](https://drafts.csswg.org/filter-effects-2/#BackdropFilterProperty)
is the rendering path being sampled; hidden/transparent/offscreen substitutes cannot
establish that it ran. [Storage access](https://html.spec.whatwg.org/multipage/webstorage.html#dom-localstorage-dev)
can fail and is origin-scoped.

Reproduce the cost check with `pnpm --filter @mun/progressive-blur build`, then
`node benchmarks/progressive-blur.mjs`. On 2026-10-27, six cold runs in headless
Chromium 156.0.8078.4 using SwiftShader, at DPR 1 and 2, measured 2.7–6.9ms total
instrumented callback time (maximum callback 2.3ms), 1.87–5.45ms summed style/layout/
paint CPU trace time, and 79–81ms sample residence. All sampled intervals were
16.6–16.7ms and no Long Tasks were observed. Cache reloads created no probe nodes,
used no sample frames, and measured 0.1–0.3ms callback time. The one-second quiet
wait is elapsed time, not CPU work. Instrumentation and tracing add overhead.
This does not establish hardware GPU cost or predict a large blur surface on a weak
device; Safari, Firefox, mobile GPUs and an absolute no-jank guarantee remain unverified.
