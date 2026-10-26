/**
 * Renderer-independent progressive-blur planning.
 *
 * A {@link BlurProfile} says *where* and *how fast* blur ramps up; the planner
 * turns it into a stack of uniform-blur layers, each masked by a CSS gradient.
 * Nothing here touches the DOM, so every backend (web today, others later) can
 * share it and it can be tested without a browser.
 *
 * Why layers: blur radii of stacked backdrop layers combine as the root of the
 * sum of squares. With N layers of radius R/sqrt(N), fully opaque layers give R,
 * and a layer at partial opacity contributes proportionally to variance. So the
 * effective radius at strength `s` (0...1) is R * sqrt(s). The planner squares
 * the eased curve so the *radius* itself follows the curve you asked for.
 */

export type Edge = "top" | "bottom" | "leading" | "trailing"
export type UnitPoint = "top" | "bottom" | "leading" | "trailing" | "center" | "topLeading" | "topTrailing" | "bottomLeading" | "bottomTrailing" | { readonly x: number; readonly y: number }
export type Easing = "linear" | "smooth" | "easeIn" | "easeOut"
/** A radial profile is centered on a fixed point or on a view marked with `blurFocus(id)`. */
export type BlurCenter = UnitPoint | { readonly focus: string }

interface ProfileBase {
  readonly curve: Easing
  readonly isInverted: boolean
  /** The same profile with another falloff curve. */
  easing(curve: Easing): this
  /** The same profile with strong and weak ends swapped. */
  inverted(): this
}

export interface UniformProfile extends ProfileBase { readonly kind: "uniform" }
export interface LinearProfile extends ProfileBase { readonly kind: "linear"; readonly from: UnitPoint; readonly to: UnitPoint }
export interface EdgeProfile extends ProfileBase { readonly kind: "edge"; readonly edge: Edge; readonly length: number }
export interface RadialProfile extends ProfileBase { readonly kind: "radial"; readonly around: BlurCenter; readonly inner: number; readonly outer: number }
export type BlurProfile = UniformProfile | LinearProfile | EdgeProfile | RadialProfile

function profile<T extends Omit<ProfileBase, "easing" | "inverted"> & { readonly kind: string }>(fields: T): T & ProfileBase {
  const value = {
    ...fields,
    easing(curve: Easing) { return profile({ ...fields, curve }) },
    inverted() { return profile({ ...fields, isInverted: !fields.isInverted }) },
  }
  return Object.freeze(value) as unknown as T & ProfileBase
}

export const BlurProfile = Object.freeze({
  /** Same blur everywhere in the modified view. Scope it with the view itself or `in:`. */
  uniform(): UniformProfile {
    return profile({ kind: "uniform" as const, curve: "linear" as Easing, isInverted: false })
  },
  /** Blur ramps from none at `from` to full at `to`, like a `LinearGradient`. */
  linear(options: { from: UnitPoint; to: UnitPoint }): LinearProfile {
    return profile({ kind: "linear" as const, from: options.from, to: options.to, curve: "linear" as Easing, isInverted: false })
  },
  /** Blur is strongest at `edge` and fades out over `length` points; the common "under a bar" case. */
  edge(edge: Edge, length: number): EdgeProfile {
    return profile({ kind: "edge" as const, edge, length: Math.max(0, length), curve: "linear" as Easing, isInverted: false })
  },
  /** Blur is full inside `inner` and fades to none at `outer`, like a `RadialGradient`. */
  radial(options: { around?: BlurCenter; inner?: number; outer: number }): RadialProfile {
    const inner = Math.max(0, options.inner ?? 0)
    return profile({ kind: "radial" as const, around: options.around ?? "center", inner, outer: Math.max(inner, options.outer), curve: "linear" as Easing, isInverted: false })
  },
})

/** Center of a radial profile that follows the view marked with `.modifier(blurFocus(id))`. */
export const focus = (id: string): { readonly focus: string } => Object.freeze({ focus: id })

export interface BlurLayer {
  /** Blur radius of this backdrop layer, in CSS pixels. */
  readonly blur: number
  /** CSS gradient used as the layer's alpha mask; absent means the whole box. */
  readonly mask?: string
}

export interface PlanOptions {
  /** Strongest effective blur radius in points. */
  readonly radius: number
  /** Rendering budget; reduced uses at most two layers, none disables blur. */
  readonly quality?: BlurQuality
  /** Where a `focus` center currently is, in px inside the blurred box; CSS variables are used when absent. */
  readonly focusCenter?: { readonly x: number; readonly y: number }
}

export type BlurQuality = "full" | "reduced" | "none"

const SAMPLES = 16
const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

const curves: Record<Easing, (t: number) => number> = {
  linear: t => t,
  smooth: t => t * t * (3 - 2 * t),
  easeIn: t => t * t,
  easeOut: t => 1 - (1 - t) * (1 - t),
}

/** Position along the profile (0 = no blur, 1 = full) to the *radius* fraction, 0...1. */
export function strengthAt(profile: BlurProfile, t: number): number {
  const position = clamp01(profile.isInverted ? 1 - t : t)
  return clamp01(curves[profile.curve](position))
}

export function layerCount(radius: number, quality: BlurQuality = "full"): number {
  if (!(radius > 0) || quality === "none") return 0
  return quality === "reduced" ? 2 : Math.min(8, Math.max(3, Math.round(radius / 2)))
}

/** Per-layer opacity for a strength fraction; exported so backends and tests agree on the model. */
export function layerAlphas(strength: number, count: number): number[] {
  const variance = clamp01(strength) ** 2 // radius fraction -> variance fraction
  return Array.from({ length: count }, (_, index) => clamp01(count * variance - index))
}

/** Effective blur radius produced by `alphas` over `count` equal-variance layers of total radius `radius`. */
export function effectiveRadius(alphas: readonly number[], count: number, radius: number): number {
  return radius * Math.sqrt(alphas.reduce((sum, alpha) => sum + alpha, 0) / Math.max(1, count))
}

const unit = (point: UnitPoint): { x: number; y: number } => {
  if (typeof point === "object") return point
  switch (point) {
    case "top": return { x: 0.5, y: 0 }
    case "bottom": return { x: 0.5, y: 1 }
    case "leading": return { x: 0, y: 0.5 }
    case "trailing": return { x: 1, y: 0.5 }
    case "topLeading": return { x: 0, y: 0 }
    case "topTrailing": return { x: 1, y: 0 }
    case "bottomLeading": return { x: 0, y: 1 }
    case "bottomTrailing": return { x: 1, y: 1 }
    default: return { x: 0.5, y: 0.5 }
  }
}

const rgba = (alpha: number) => `rgba(0,0,0,${Math.round(alpha * 1000) / 1000})`
const num = (value: number) => String(Math.round(value * 100) / 100)

type Axis = { readonly css: string; readonly position: (t: number) => string }

/** CSS gradient line and the stop position (as a function of profile position t) for a profile. */
function axisFor(profile: LinearProfile | EdgeProfile): Axis {
  if (profile.kind === "edge") {
    const to = profile.edge === "leading" ? "left" : profile.edge === "trailing" ? "right" : profile.edge
    return { css: `to ${to}`, position: t => `calc(100% - ${num((1 - t) * profile.length)}px)` }
  }
  const from = unit(profile.from)
  const to = unit(profile.to)
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return { css: "to bottom", position: () => "0%" }
  if (Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6) {
    const vertical = Math.abs(dx) < 1e-6
    const start = vertical ? from.y : from.x
    const span = vertical ? dy : dx
    const forward = span > 0
    const css = vertical ? (forward ? "to bottom" : "to top") : (forward ? "to right" : "to left")
    const origin = forward ? start : 1 - start
    return { css, position: t => `${num((origin + t * Math.abs(span)) * 100)}%` }
  }
  // Diagonals: corner keyword gradient spanning the whole box.
  const css = `to ${dy > 0 ? "bottom" : "top"} ${dx > 0 ? "right" : "left"}`
  return { css, position: t => `${num(t * 100)}%` }
}

function maskFor(profile: BlurProfile, index: number, count: number, options: PlanOptions): string {
  const alphaAt = (t: number) => layerAlphas(strengthAt(profile, t), count)[index] ?? 0
  const stops = (position: (t: number) => string, ts: readonly number[]) => ts.map(t => `${rgba(alphaAt(t))} ${position(t)}`).join(",")
  const ascending = Array.from({ length: SAMPLES + 1 }, (_, i) => i / SAMPLES)
  if (profile.kind === "radial") {
    const center = profile.around
    const at = typeof center === "object" && "focus" in center
      ? options.focusCenter ? `${num(options.focusCenter.x)}px ${num(options.focusCenter.y)}px` : "var(--pb-cx,50%) var(--pb-cy,50%)"
      : (() => { const point = unit(center as UnitPoint); return `${num(point.x * 100)}% ${num(point.y * 100)}%` })()
    const span = profile.outer - profile.inner
    // Gradient distance grows outward while strength grows inward, so walk t downward.
    const ts = [...ascending].reverse()
    const position = (t: number) => `${num(profile.outer - t * span)}px`
    return `radial-gradient(circle at ${at},${rgba(alphaAt(1))} 0px,${stops(position, ts)})`
  }
  if (profile.kind === "uniform") return ""
  const axis = axisFor(profile)
  return `linear-gradient(${axis.css},${stops(axis.position, ascending)})`
}

/** Turn a profile into the layer stack a backend renders. */
export function planBlur(profile: BlurProfile, options: PlanOptions): BlurLayer[] {
  if (options.quality === "none") return []
  if (profile.kind === "uniform") return options.radius > 0 ? [{ blur: options.radius }] : []
  const count = layerCount(options.radius, options.quality)
  const blur = count === 0 ? 0 : Math.round((options.radius / Math.sqrt(count)) * 100) / 100
  return Array.from({ length: count }, (_, index) => ({ blur, mask: maskFor(profile, index, count, options) }))
}
