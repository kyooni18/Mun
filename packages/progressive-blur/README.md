# @mun/progressive-blur

Progressive (variable-radius) blur as a SwiftUI-style modifier for Mün.

```ts
import { BlurProfile, blurFocus, focus, progressiveBlur } from "@mun/progressive-blur"

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
- `@mun/progressive-blur/plan` is the pure, DOM-free planner (profile to masked layers), shared by any renderer.

The web renderer stacks masked `backdrop-filter` layers. Avoid `opacity` or `filter` on an ancestor of the blurred
view, since that makes a backdrop root and the blur then sees only the ancestor's contents.
