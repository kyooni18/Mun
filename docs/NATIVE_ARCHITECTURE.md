# Native-first Mün architecture

Mün is a standalone UI language and runtime. The canonical source format is `.mun`. Web and Astro are backend targets; they do not define Mün's language, semantic model, layout model, state model, motion model, or lifecycle.

```text
                         Mün .mun
                            |
                            v
                      parser / AST
                            |
                            v
                    semantic analysis
                            |
                            v
                    Semantic UI IR
                            |
                  +---------+---------+
                  |                   |
                  v                   v
           native runtime         Web / Astro
           primary target       secondary target
                  |                   |
          reactive state              |
          + transactions              |
                  |                   |
          motion execution            |
                  |                   |
              layout tree             |
                  |                   |
              scene graph             |
                  |                   |
              GPU renderer       HTML/browser lowering
```

The semantic UI IR is the boundary that must remain stable across backends. Native code may use winit, wgpu, Taffy, glyphon/cosmic-text, Vello, AccessKit, or replacements, but those libraries are implementation details. Their types and concepts must not become Mün source-language semantics.

## Current migration boundary

The repository still contains a mature TypeScript compiler and older graph/rendering paths inherited from the existing Mün runtime. They are not being discarded wholesale. The first native slice therefore keeps the existing parser, builder parser, initializer/type machinery, and compiler analyses in TypeScript, then lowers into the backend-neutral UI IR before the legacy web transform materializes HTML templates.

The new boundary is implemented by `compileMunUiProgram` in `packages/compiler/src/ui-ir.ts` and the shared IR types in `packages/core/src/ui-ir.ts`.

This is intentionally incremental. Replacing the mature compiler with a new Rust parser today would throw away working language analysis while the semantic boundary is still moving. The native runtime and motion scheduler are Rust now. A future compiler port may cross the same serialized IR boundary without changing Mün semantics or creating a second language.

The old raw-HTML compiler path is transitional compatibility code. Raw HTML, DOM nodes, CSS declarations, browser layout, React, Vue, and Astro constructs are not canonical Mün semantics and must not be added to the semantic UI IR.

## Native runtime

The Rust workspace is under `native/`.

`mun-runtime` owns backend-independent runtime behavior needed by the first slice: state storage, transactions, motion channels, expression evaluation, layout adaptation, retained scene construction, accessibility-tree projection, and hit-test data. Taffy receives already-resolved Mün layout intent and therefore remains replaceable. A `RuntimeFrame` runs layout once and projects the same presentation geometry independently into the visual `Scene` and semantic `AccessibilityTree`; accessibility is not inferred from draw commands and rendering does not own accessibility.

`mun-native` is the reusable desktop backend host. It loads arbitrary compiler-produced Semantic UI IR, then uses winit for the desktop window and input, wgpu for GPU presentation, glyphon/cosmic-text for native text shaping/rendering, and AccessKit for the operating-system accessibility bridge. It consumes Mün's retained scene and semantic accessibility tree as separate projections. It does not use WebView, Chromium, DOM, HTML, or CSS.

Accessibility semantics are carried independently on semantic nodes. The visual scene does not infer accessibility roles. The native backend projects Semantic UI IR into an `AccessibilityTree`, then lowers that tree through AccessKit. Window/group/text/button roles, labels, enabled state, focus, action identity, and presentation bounds come from semantic/runtime data rather than GPU scene primitives. AccessKit actions are routed back to the same semantic Action IDs used by pointer and keyboard input, and disabled Actions are rejected by the runtime itself. Keyboard focus traversal is also semantic-runtime-owned: `Tab`/`Shift+Tab`, pointer activation, and AccessKit focus all use the same enabled Action identities instead of inferring order from scene draw/hit-test arrays. The AccessKit adapter is replaceable; AccessKit types do not appear in Mün source or Semantic UI IR.

## Semantic controls

Controls are semantic objects, not host widgets. For example, an action has an action/button role, input behavior, visual representation, accessibility representation, and backend lowering. The native backend draws it into the retained scene and handles pointer/keyboard activation. The web backend may emit a `<button>` because HTML is that backend's representation; `button` is not the Mün core node type.

The first semantic IR supports window, row, column, text, panel, and action nodes, scalar state, simple state expressions, sizing, padding, alignment, foreground/background color, corner-radius metadata, pointer hit testing, keyboard activation, and motion bindings. Unsupported language constructs should fail conservatively rather than silently falling back to HTML semantics.

## State, transaction, layout, and scene flow

A state mutation is resolved through a transaction before presentation values are changed. The native IR preserves `withAnimation`, statically representable `withTransaction(new Transaction(...))`, `disablesAnimations`, and `isContinuous`. Dynamic animatable properties participate in motion even when they do not have a property-local animation plan, allowing the active transaction to supply the fallback plan.

```text
state/property mutation
        |
        v
    Transaction
        |
        v
animation resolution
        |
        v
MotionExecutionPlan
        |
        v
 MotionChannels
        |
        v
presentation values
        |
        v
   layout tree
        |
        v
 retained scene
        |
        v
   GPU renderer
```

The retained scene is owned by Mün. AppKit, WinUI, GTK, DOM, and browser layout are backend boundaries, not the semantic view tree.

Motion resolution follows the existing Mün transaction precedence rather than backend policy. `disablesAnimations` snaps affected properties. Otherwise a changed property-local `.animation(..., value:)` plan wins; an unchanged explicit `value:` trigger suppresses animation for that property. If there is no property-local plan, the mutation transaction's animation is the fallback. If neither exists, the property snaps to its new model value. `withAnimation(null)` therefore preserves a real transaction with no animation rather than inventing an automatic native animation.

The recovered native timeline layer now owns inherited playback-time mapping, scalar numeric keyframe execution, and renderer-neutral nested-clip time mapping. `TimelineClock` preserves normal/reverse/alternate/alternate-reverse mapping, seek, seek-progress, elapsed seeking, reverse playback, exact repeat-boundary ownership, and constant-time repeat catch-up. `ScalarKeyframeTrack` and `ScalarTimelinePlayer` reuse that clock for stable keyframe ordering/collapse, the inherited 256-sample cubic-bezier easing LUT, instantaneous segment velocity, zero-velocity seeking, and direction/playback-rate velocity scaling. `TimelineClipTiming` preserves inherited `at`, positive `speed`, parent/child duration scaling, active velocity scaling, and `none`/`forwards`/`backwards`/`both` fill endpoint behavior without embedding child targets or scene bindings. Public Mün timeline/keyframe syntax, the full nested timeline graph and conflict ownership, structured interpolation, phase timelines, pause/play lifecycle, and timeline-driven scene bindings are still migration work; these internal runtime primitives must not be mistaken for a completed public timeline API.

Animation source modifiers are resolved through the actual `@mun/core` `Animation` descriptors and then through the existing `@mun/animation/core` planner. Native execution preserves timing/spring plans, delay, speed folding, velocity-preserving spring retargeting, the existing Mün runtime-style coefficient blending over `blendDuration`, finite `repeatCount`, `repeatForever`, and autoreverse/alternate behavior. Timing repeats are driven by a Rust port of the existing Mün runtime's renderer-neutral timeline iteration/direction clock, including exact-boundary handling and O(1) large-gap catch-up. Spring repeats keep the existing settle-based cycle model: autoreversing cycles retarget the same channel back toward the origin, while non-autoreversing cycles restart from the origin before the next forward pass. Delayed retargets let the current in-flight cycle continue until handoff while suppressing future cycles from the superseded repeat wrapper.

Kinetic continuation is also runtime-owned rather than renderer-owned. The recovered Rust decay/inertia channel uses the existing Mün runtime's exact exponential decay and exact damped-spring bounce equations, including velocity inheritance at handoff, bounded inertia, same-frame decay-to-bounce transfer, and exact final settling. Snap/target policy stays above the numeric executor: the runtime accepts an already-resolved target override instead of embedding source callbacks or browser gesture machinery. This execution seam is ready for future native gesture, scroll, and timeline scrubber coordination, but it is not yet exposed as a canonical Semantic UI IR/source construct.

The native frame boundary is intentionally split after layout:

```text
                     presentation state
                            |
                            v
                      Mün layout tree
                            |
               +------------+------------+
               |                         |
               v                         v
        retained visual Scene      AccessibilityTree
               |                         |
               v                         v
          wgpu / glyphon               AccessKit
               |                         |
               v                         v
              GPU                native OS a11y API
```

Both projections use the same presentation geometry, including in-flight animated layout. They must remain semantically separate: visual styling cannot manufacture accessibility meaning, and accessibility adapters cannot become the source of layout or control semantics.

## Web and Astro

`@mun/web` is a target backend. HTML and CSS are allowed there because they are target-platform output. New web lowering from semantic UI IR belongs in that package and must not push tag names, DOM events, or CSS properties back into core IR.

The Astro `@mun { ... }` source extractor is also a host-integration boundary. It may discover embedded Mün source and manage Astro frontmatter/import plumbing, but the Mün block itself must pass through the same compiler and semantic IR as a standalone `.mun` file. The existing Astro virtual-module implementation predates this boundary and should be migrated incrementally rather than duplicated as a separate "Mün Web" language.

## First vertical slice

`examples/NativeDemo.mun` is the native-first executable slice. It uses existing Mün-style `State`, `VStack`, `Text`, `Button`, `Rectangle`, modifiers, and `Animation.spring`. Toggling state changes semantic width, opacity, and offset expressions. The compiler emits renderer-neutral motion bindings, the Rust runtime opens a transaction, the inherited scheduler produces presentation values, Taffy owns layout geometry, and scene-space opacity/translation are applied after layout before the retained scene is redrawn on the GPU.

Build and run it with:

```sh
./scripts/build-native-demo.sh
./native/target/debug/mun-native native/generated/NativeDemo.json
```

This vertical slice is deliberately small. It proves the backend boundary; it is not a replacement for the remaining compatibility feature surface.

## Presentation-space motion

Native presentation now distinguishes layout geometry from scene-space transforms. Semantic UI IR carries `opacity`, `translationX`, and `translationY` expressions in addition to layout sizing. Dynamic values receive the same renderer-neutral motion bindings and inherited spring/timing execution as width and height.

`.offset(...)` is deliberately applied after Taffy layout. Animated translation therefore moves retained-scene drawing, descendant presentation coordinates, action hit-test bounds, and accessibility bounds together without mutating the underlying layout snapshot. Opacity is also presentation-only: it composes through descendants by multiplying alpha, while semantic presence and hit testing remain intact. This boundary is intended to be reused by FLIP, insertion/removal transitions, matched geometry, gestures, and scroll-driven motion rather than creating separate renderer-side animation systems.

`examples/NativeDemo.mun` exercises width, opacity, and x/y translation from one state-triggered spring. Width changes presentation layout; opacity and translation are projected after layout from independent property channels.


## Retained scene transform boundary

The retained scene now has a renderer-neutral `ScenePresentation` layer for presentation transforms that must not mutate Taffy geometry. A transform node carries independent x/y scale and translation and may inherit from a parent transform; retained primitive IDs bind to those nodes. This is deliberately below Semantic UI IR and above wgpu/glyphon. The compiler does not emit GPU matrices, Taffy remains the logical layout source, and the renderer only realizes the transform it is given. The same presentation object can inverse-map action geometry for transform-aware hit testing.

The wgpu backend can realize non-uniform scale for rectangles and text without rewriting semantic sizes. Rect vertices are projected through the resolved scene transform while their local rounded-rectangle geometry remains logical. glyphon 0.12 exposes only a scalar `TextArea::scale`, so the backend does not approximate `scaleX/scaleY` with an averaged font size. Instead it shapes text at its logical metrics, rasterizes each transform batch at the largest requested axis scale, and uses the wgpu render-pass viewport for independent x/y presentation scale and translation. Font/cache/atlas state and transform-batch renderers remain persistent across frames.

This establishes the renderer capability required by full size-projecting FLIP, matched geometry, future gesture transforms, and future scroll transforms, but the runtime has not yet migrated structural FLIP onto `ScenePresentation`; current structural FLIP remains positional. Negative/mirrored text scales are not currently supported, and a collapsed text axis draws nothing rather than inventing a substitute transform. General retained clipping is also not implemented yet. Existing subtree opacity is per-primitive alpha multiplication and must not be described as true offscreen group compositing when overlapping descendants would require an intermediate layer.

## Native lifecycle presence

`Transition` is a canonical core semantic value and its descriptor now crosses the same compiler/IR boundary as other native UI semantics. Native presence supports ordered `opacity`, uniform `scale`, and directional `move` effects for insertion and removal. The lifecycle is driven by a single normalized channel in the existing motion scheduler; it does not create widget-local timers or renderer-owned animation state.

An entering subtree is part of the live semantic tree immediately. Its presentation transform is projected after Taffy layout across drawing, pointer hit geometry, and accessibility bounds around the same root center pivot. A removed subtree leaves the live semantic/action/accessibility tree immediately, while a visual-only retained scene snapshot may continue its exit transition until the scheduler settles. This preserves stable layout snapshots for future FLIP/matched-geometry work and prevents an outgoing animation from retaining interaction or accessibility authority.


## Native structural FLIP

Animated structural state mutations now preserve stable sibling position with native FLIP projection. The runtime captures the current rendered semantic bounds before mutation, recomputes the new Taffy layout after the branch changes, and applies an inverse scene-space translation to stable siblings so their first post-mutation presentation frame remains visually continuous. The inverse converges to identity using the transaction's existing motion plan.

The same translation is applied to retained drawing, action hit geometry, descendants, and Accessibility bounds; Taffy remains the final layout source of truth. Unanimated structural mutations snap without FLIP. Interrupted FLIP captures the current presentation geometry before replacing the projection, so retargeting does not jump back to the underlying layout rectangle.

This is deliberately the positional structural-reflow slice, not a claim that all legacy layout animation is complete. Non-uniform size projection and shared/matched-geometry routing still need the remaining `packages/animation/src/layout` behavior ported onto native layout/scene snapshots.
