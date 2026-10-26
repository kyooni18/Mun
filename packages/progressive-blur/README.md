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


Progressive blur subscribes to Mün's global `full` / `reduced` / `none` rendering
quality policy. Reduced quality uses two layers with recomputed masks and radii;
none disables all layers, including uniform blur. Updates apply to mounted blur
without replacing hydrated nodes. Radial focus tracking pauses at none and reduces
its measurement cadence at reduced quality.

The controller is shared with GPU island and Canvas rendering. It starts with the
cached startup measurement, observes passive frame/queue delays, and repeats the
same tiny idle CSS backdrop probe about every 30 seconds while consumers are mounted.
Quality falls under sustained pressure and recovers gradually after healthy probes.
SSR and initial uncertainty retain full quality; an unclear runtime check keeps the
current selection. Storage access fails safely.

`prepareProgressiveBlur()` remains a compatibility alias for
`prepareRenderingQuality()` from `@mun/ui/rendering-quality`. Used alone it shares
one startup preparation; mounted consumers own ongoing monitoring and cleanup.
See the [global policy, thresholds, API and measurements](../../docs/RENDERING_QUALITY.md).
