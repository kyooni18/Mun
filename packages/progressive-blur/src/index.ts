import { Element, type ContentModifier, type ModifiableViewNode, type ViewNode } from "@mun/core"
import { BlurProfile, focus, planBlur, type BlurCenter, type Easing, type Edge, type UnitPoint } from "./plan.js"
import { observeRenderingQuality, type RenderingQuality } from "@mun/animation/rendering-quality"

export { BlurProfile, focus, planBlur }
export { prepareProgressiveBlur } from "./quality.js"
export type { BlurCenter, BlurQuality, Easing, Edge, UnitPoint } from "./plan.js"

export interface ProgressiveBlurOptions {
  /** Strongest effective blur radius in points. Defaults to 12. */
  readonly radius?: number
  /** 0...1 blend of the whole effect; changing it animates. Defaults to 1. */
  readonly amount?: number
  /** Clip the blur to a shape, like `.background(_, in:)`. */
  readonly in?: ViewNode
  /** Fade duration in milliseconds when `amount` changes. Defaults to 380. */
  readonly fadeMs?: number
}

const focusSelector = (id: string) => `[data-pb-focus="${id.replace(/["\\]/g, "\\$&")}"]`

/**
 * Keep `--pb-cx/--pb-cy` pointing at the focus view's center, relative to the
 * blur box, for as long as the box is connected and visible.
 */
function followFocus(box: HTMLElement, id: string, quality: RenderingQuality) {
  const owner = box.ownerDocument.defaultView!
  let frame = 0
  let previous = -Infinity
  const tick = (time: number) => {
    if (!box.isConnected) return
    if (Number(box.dataset.pbAmount) > 0 && (quality === "full" || time - previous >= 1000 / 30)) {
      previous = time
      const target = box.ownerDocument.querySelector(focusSelector(id))
      if (target) {
        const t = target.getBoundingClientRect()
        const b = box.getBoundingClientRect()
        box.style.setProperty("--pb-cx", `${t.left - b.left + t.width / 2}px`)
        box.style.setProperty("--pb-cy", `${t.top - b.top + t.height / 2}px`)
      }
    }
    frame = owner.requestAnimationFrame(tick)
  }
  frame = owner.requestAnimationFrame(tick)
  return () => owner.cancelAnimationFrame(frame)
}

/** Backdrop-blurs whatever is behind it. Place it in `.overlay`, `.background` or a ZStack. */
export function ProgressiveBlur(profile: BlurProfile, options: ProgressiveBlurOptions = {}): ModifiableViewNode {
  const radius = options.radius ?? 12
  const amount = Math.min(1, Math.max(0, options.amount ?? 1))
  const fade = options.fadeMs ?? 380
  const layers = planBlur(profile, { radius })
  const center: BlurCenter | undefined = profile.kind === "radial" ? profile.around : undefined
  const focusId = center && typeof center === "object" && "focus" in center ? center.focus : undefined
  let stopQuality: (() => void) | undefined
  let stopFocus: (() => void) | undefined
  const box = Element("div", {
    "aria-hidden": "true",
    "data-pb-amount": String(amount),
    ref: (element: HTMLElement | null) => {
      stopQuality?.()
      stopFocus?.()
      if (!element) return
      const owner = element.ownerDocument.defaultView
      if (!owner) return
      let applied: RenderingQuality | undefined
      stopQuality = observeRenderingQuality(({ quality }) => {
        if (applied === quality) return
        applied = quality
        element.dataset.pbQuality = quality
        stopFocus?.()
        if (focusId !== undefined && quality !== "none") stopFocus = followFocus(element, focusId, quality)
        const planned = planBlur(profile, { radius, quality })
        Array.from(element.children).forEach((child, index) => {
          const style = (child as HTMLElement).style
          const layer = planned[index]
          style.display = layer ? "" : "none"
          style.backdropFilter = layer ? `blur(${layer.blur}px)` : "none"
          style.setProperty("-webkit-backdrop-filter", style.backdropFilter)
          style.maskImage = style.webkitMaskImage = layer?.mask ?? "none"
        })
      }, owner)
    },
    style: { position: "absolute", inset: "0px", pointerEvents: "none" },
  }, ...layers.map((layer, index) => Element("div", {
    style: {
      position: "absolute",
      inset: "0px",
      opacity: amount,
      transition: `opacity ${fade}ms ease`,
      backdropFilter: `blur(${layer.blur}px)`,
      WebkitBackdropFilter: `blur(${layer.blur}px)`,
      ...(layer.mask ? { maskImage: layer.mask, WebkitMaskImage: layer.mask } : {}),
    },
  }).keyed(index)))
  return options.in ? box.clipShape(options.in) : box
}

/**
 * SwiftUI-style modifier: `view.modifier(progressiveBlur(.edge("bottom", 120)))`.
 * The blur covers the modified view's bounds, so scoping is just where you attach it.
 */
export function progressiveBlur(profile: BlurProfile, options: ProgressiveBlurOptions = {}): ContentModifier {
  return content => content.overlay(ProgressiveBlur(profile, options))
}

/** Marks a view as the center for radial profiles using `focus(id)`. */
export function blurFocus(id: string): ContentModifier {
  return content => content.withProps({ "data-pb-focus": id })
}
