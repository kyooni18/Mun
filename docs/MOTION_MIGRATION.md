# Legacy motion migration to native Mün

Mün does not get a new animation engine. The existing Mün runtime already contains a renderer-neutral motion architecture, and the native runtime must preserve its semantics and execution model while replacing browser-specific application code.

The intended boundary is:

```text
Animation / Transaction semantics
              |
              v
      MotionExecutionPlan
              |
              v
      motion scheduler
              |
              v
 interpolation / FLIP / timeline
              |
              v
       Mün scene + layout
              |
              v
         GPU renderer
```

## Renderer-neutral work to preserve

The public transaction and animation semantics in `packages/core/src/animation.ts` remain valuable: `Animation`, `Transaction`, `withAnimation`, `withTransaction`, implicit animation resolution, and transaction scoping are not browser concepts.

The planning layer in `packages/animation/src/core/planner.js` is also renderer-neutral. Its job is to resolve animation descriptors into an execution plan before a renderer consumes them. The native UI IR keeps that architecture by serializing compact motion plans rather than opaque "start a timer" calls.

The spring model in `packages/animation/src/core/math.js` is renderer-neutral. Response-based springs derive angular frequency as `2π / response`, and damping remains a dimensionless ratio.

The dense scheduler in `packages/animation/src/core/js-spring-batch.js` is algorithmic rather than DOM-specific. Its fixed-substep semi-implicit Euler integration, dense channel storage, target updates, settling thresholds, and independent per-property channels are suitable for a native scheduler. The initial Rust scheduler ports this execution model directly. Retargeting an existing spring changes its target and coefficients without zeroing velocity.

Compiler-derived property participation is also retained. `packages/core/src/ui-ir.ts` defines backend-neutral motion properties and masks; `packages/compiler/src/ui-ir.ts` derives a motion binding for dynamic animated layout properties. Native code consumes the mask/property identity without translating through CSS property names.

## Browser-specific work to replace

`packages/web/src/motion.ts` contains the renderer boundary: `Element`, `CSSStyleDeclaration`, CSS property application, DOM geometry, WAAPI/browser scheduling choices, and browser event plumbing. Those pieces should remain in the web backend or be replaced by native scene/layout adapters.

WASM/SIMD worker infrastructure is not an architectural requirement. The numeric algorithms and dense execution model survive; native SIMD should be introduced in Rust only after profiling shows it is useful.

Browser layout measurements used by FLIP and matched geometry must be replaced by Mün layout-tree snapshots and scene-space geometry. CSS transitions/animations must not become the native execution engine.

## Current native slice

The current native Rust scheduler implements the existing spring and timing routes as independent node/property channels. Spring channels retain the dense fixed-substep integration model, preserve velocity when retargeted, and port the existing Mün runtime's coefficient blending across `blendDuration`; timing channels port the existing Mün runtime's cubic-bezier solving algorithm and restart from the current presentation value when retargeted. Both routes honor compiled delay. Focused Rust tests protect retargeting, delay, and coefficient-blending contracts.

The compiler does not independently define `Animation` semantics or derive spring coefficients. `packages/compiler/src/ui-ir.ts` resolves source-level factories and modifiers through the actual `@mun/core` `Animation` API (`linear`, ease curves, `spring`, `interactiveSpring`, `smooth`, `snappy`, `bouncy`, `delay`, and `speed`) and then consumes `@mun/animation/core`'s existing `compileMotionPlan`. Speed is folded into duration/response/delay before serialization. The compiler emits renderer-neutral property participation and masks even when a dynamic property has no local plan, so a mutation transaction can provide its fallback animation.

This means `@mun/animation/core` remains the planning authority while Rust is a native execution backend. Do not fork a second spring/timing planner into the compiler or renderer.

Native transaction resolution now preserves the inherited core hierarchy. `withAnimation` is lowered as mutation transaction metadata; statically representable `withTransaction(new Transaction(...))` also preserves `animation`, `disablesAnimations`, and `isContinuous`. A property-local `.animation(..., value:)` override is more specific than the surrounding transaction, while an unchanged explicit trigger suppresses animation for that property. Without a local plan, the transaction animation is used; without either plan, the property snaps. `disablesAnimations` suppresses even a property-local plan.

Repeat metadata is now executed by the native backend instead of being ignored or approximated. `repeatCount` is preserved as the existing iteration count, `repeatForever` is serialized as an infinite iteration set, and `autoreverses` maps to the existing Mün runtime's alternate direction semantics. Timing channels consume the recovered renderer-neutral timeline clock; spring channels retain the existing Mün runtime's settle-based repeat loop. Non-autoreversing repeats restart from the origin between cycles. Delayed retargeting supersedes future cycles of the old wrapper but lets the currently running cycle advance until the handoff point.

The native scheduler now also recovers the inherited renderer-neutral decay/inertia executor. `MotionScheduler::animate_velocity` replaces one node/property channel with exact exponential decay or bounded inertia and inherits the channel's live presentation velocity unless the caller supplies an explicit release velocity. Inertia preserves the existing same-frame handoff from post-decay position/velocity into the exact damped bounce spring when a bound is crossed, then settles exactly on the resolved target. The optional `target_override` is deliberately an already-resolved scalar equivalent of the historical `modifyTarget` hook: gesture/timeline code owns snap-target policy, while the numeric executor remains free of callbacks, DOM events, and renderer state.

The current slice does not claim that all historical Mün motion capabilities are migrated. Adaptive animation-package profiles, physics-spring parameter forms beyond current core descriptors, source/IR wiring for kinetic motion, public timeline/keyframe/phase APIs, pause/play control surfaces, nested timeline clips, structured/custom-value interpolation, phase timelines, stagger, full size-projecting/shared-layout FLIP, matched geometry, gesture-driven motion, and scroll-driven motion remain migration work. The numeric decay/inertia executor and scalar numeric keyframe executor are now available to native runtime coordination, but no source-level or Semantic UI IR kinetic/timeline contract is claimed yet. These capabilities should continue to be recovered from the existing Mün runtime packages and Git history, not independently redesigned.

## Migration rules

A motion feature belongs above the renderer when its behavior can be expressed in terms of semantic properties, state transactions, time, velocity, geometry, or layout snapshots. Only the final application of presentation values to the scene or target platform belongs in a backend.

Native layout animation should operate on Mün/Taffy layout snapshots and retained scene geometry. Native visual-property animation should update scene properties. Web lowering may translate the same semantic plan into DOM/WAAPI/CSS machinery when that is the appropriate browser implementation.

Do not make per-widget timer animations. Do not reset spring velocity on retarget. Do not make CSS property names the canonical motion ABI. Do not make the browser's frame scheduler or DOMRect the source of truth for native geometry.


## Historical ownership map

| legacy/Mün subsystem | Native-first treatment |
| --- | --- |
| `packages/core/src/animation.ts` transaction and `Animation` semantics | Preserve above renderers; progressively connect native state mutation to the same transaction semantics. |
| `packages/animation/src/core/planner.js` and `specs.js` | Preserve as the current planning authority. Compiler lowering consumes it rather than reproducing its math. |
| `packages/animation/src/core/js-spring-batch.js`, `kinetics.js`, `bezier.js`, `easing.js` | Preserve algorithms and behavior. Port numeric execution to Rust; do not preserve WASM/worker mechanics by default. |
| `packages/animation/src/timeline` | Preserve timeline ownership, sampling, nested timelines, direction, seek/scrub/reverse, phase timelines, and stagger semantics. Port execution incrementally. |
| `packages/animation/src/layout` | Preserve FLIP/matched-geometry concepts and scheduling. Replace DOM measurement with Mün layout/scene snapshots. |
| `packages/animation/src/gesture` and `scroll` | Preserve gesture/scroll-driven motion semantics; replace browser event/scroll sources with native input/layout sources. |
| `packages/web/src/motion.ts`, `packages/animation/src/dom` | Web/backend-only boundary. DOM, CSS, WAAPI, `Element`, and browser geometry must not enter native semantics. |

The Rust runtime may optimize storage or numeric execution, including native SIMD after measurement, but it must remain behaviorally downstream of the inherited semantic/planning model.


## Native timeline execution recovered so far

`native/mun-runtime/src/timeline.rs` remains a renderer-neutral port of the existing Mün runtime rather than a new animation design. `TimelineClock` preserves normal/reverse/alternate/alternate-reverse direction, exact-boundary ownership while traversing backwards, finite and infinite iterations, seek/seek-progress/elapsed seek, playback-rate reversal, and O(1) catch-up across large wall-clock gaps. Current scalar timing repeats consume that clock directly.

The first native keyframe execution slice now layers `ScalarKeyframeTrack` and `ScalarTimelinePlayer` on the same clock. It preserves stable time ordering with later-authored duplicate-time keyframes winning, evenly-spaced shorthand frames, the inherited 256-sample cubic-bezier easing LUT, segment derivative velocity, zero-velocity seek/scrub samples, and direction/playback-rate velocity scaling. The player delegates repeat, seek, reverse, and iteration mapping to `TimelineClock`; it does not introduce a second timeline clock. Structured/custom-value interpolation, nested clips and fill/speed semantics, phase timelines, target ownership/conflict coordination, source/IR exposure, and scene/gesture/scroll bindings remain migration work.

## Native presentation channels recovered

The native scene path now consumes semantic opacity and translation channels in addition to animated layout size. `packages/compiler/src/ui-ir.ts` lowers dynamic `.opacity(...)` and `.offset(...)` values to `opacity`, `translationX`, and `translationY` motion bindings, using the same property-local or transaction animation resolution as layout motion.

Translation is applied after Taffy layout, so scene drawing, descendants, hit testing, and accessibility bounds move from presentation values while the layout snapshot remains stable. Opacity composes down the retained scene through alpha multiplication without removing semantic presence. This separation is groundwork for recovering the existing Mün runtime FLIP, transitions, matched geometry, gesture motion, and scroll motion from stable Mün layout snapshots instead of DOM geometry.


## Native lifecycle transitions recovered

The canonical core `Transition` descriptor is now part of the native Semantic UI IR. The compiler preserves insertion/removal effect order for `opacity`, `scale`, and directional `move`, including asymmetric/combined transitions and an explicit transition animation when supplied. Native does not translate these effects through CSS or DOM concepts.

Presence playback uses one normalized progress channel in the existing `MotionScheduler`, not a second transition clock. Opacity and the ordered affine scale/translation transform are derived from that progress, so spring/timing delay, settling, and the inherited scheduler remain authoritative. When no transition-local or mutation transaction animation is supplied, native falls back to the same `Animation.default` spring contract as core/web.

Insertion keeps the node live semantically and applies the presentation transform after layout to scene geometry, pointer hit bounds, and accessibility bounds from the same center pivot. Removal updates the semantic tree immediately and keeps only a retained visual subtree snapshot until exit playback settles; the exit snapshot carries no actions or accessibility authority. Scale changes retained rect size, text size, corner radius, pointer geometry, and accessibility geometry without mutating the underlying Taffy layout snapshot. Combined transform effects preserve descriptor order, matching the existing web transition transform ordering while remaining renderer-neutral.


## Native structural FLIP recovered

The first native FLIP slice now preserves stable sibling presentation geometry across animated structural mutations. Before a transaction-backed conditional insert/remove, the runtime records the active row/column neighborhood and the last rendered Accessibility geometry. After the state mutation, it recomputes Taffy geometry and identifies stable direct siblings whose parent child list changed. Those siblings receive the inherited inverse center translation and converge from progress 0 to 1 through the existing `MotionScheduler`; an unanimated mutation snaps directly and never opens a FLIP channel.

The capture is local to the changed layout neighborhood rather than a global tree scan, matching the existing web runtime's sibling-neighborhood intent. The inverse translation is projected after layout across retained scene drawing, pointer hit bounds, descendants, and Accessibility bounds from the same presentation state. If a structural FLIP is interrupted, the last rendered presentation geometry is captured first, the old projection is retired, and the new inverse delta starts from a fresh progress zero, mirroring the inherited `LayoutTransition` cancel-and-new-`MotionValue(0)` lifecycle.

This slice intentionally handles positional structural reflow only. Existing authored width/height motion continues to drive Taffy presentation layout directly, avoiding a second size animation. Non-uniform FLIP size projection, parent/child matrix compensation beyond translation, and shared/matched geometry remain migration work and should be recovered from `packages/animation/src/layout` before being exposed as complete native FLIP support. No DOMRect, CSS transform, or browser layout measurement participates in the native path.


## Renderer transform capability available for full FLIP

The retained scene now exposes a renderer-neutral `ScenePresentation` transform hierarchy with independent `scaleX`, `scaleY`, x/y translation, parent composition, primitive bindings, and inverse hit-test mapping. wgpu applies these transforms to retained rectangle geometry. Text stays logically shaped at its existing metrics; because glyphon 0.12 has only uniform `TextArea` scale, the native backend rasterizes a transformed text batch at the largest requested axis scale and realizes the independent axes through the wgpu viewport instead of mutating font size or averaging the two scales.

This is a renderer capability, not a new motion semantic and not completion of full FLIP. Runtime layout-motion code must still derive the correct inherited projection from layout snapshots, preserve interruption/hierarchy lifecycle, bind the affected retained primitives, and keep Accessibility geometry consistent before the positional FLIP slice can become full size-projecting FLIP. The renderer receives a transform and does not decide why it exists. Mirrored text, retained clipping, and true offscreen group-opacity compositing remain explicit backend limitations rather than silent approximations.
