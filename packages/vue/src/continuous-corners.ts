import { APPLE_CONTINUOUS_CORNER_SMOOTHING, continuousCornerPath, expandCornerRadiusShorthand } from "@mun/core/corners"

const observers = new WeakMap<Element, ResizeObserver>()

function radius(value: string, size: number): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? (value.trim().endsWith("%") ? parsed * size / 100 : parsed) : 0
}

function update(element: Element): void {
  const view = element.ownerDocument?.defaultView
  if (!view || !(element instanceof view.HTMLElement)) return
  const width = element.offsetWidth
  const height = element.offsetHeight
  if (width <= 0 || height <= 0) return
  const size = Math.min(width, height)
  const css = view.getComputedStyle(element)
  const shorthand = expandCornerRadiusShorthand(css.borderRadius)
  const smoothing = Number.parseFloat(css.getPropertyValue("--mun-corner-smoothing"))
  const preserveSmoothing = css.getPropertyValue("--mun-corner-preserve-smoothing").trim() !== "0"
  const path = continuousCornerPath(width, height, {
    topLeft: radius(css.borderTopLeftRadius || shorthand.topLeft, size),
    topRight: radius(css.borderTopRightRadius || shorthand.topRight, size),
    bottomRight: radius(css.borderBottomRightRadius || shorthand.bottomRight, size),
    bottomLeft: radius(css.borderBottomLeftRadius || shorthand.bottomLeft, size),
  }, Number.isFinite(smoothing) ? smoothing : APPLE_CONTINUOUS_CORNER_SMOOTHING, preserveSmoothing)
  const clip = `path("${path}")`
  element.style.clipPath = clip
  ;(element.style as CSSStyleDeclaration & { webkitClipPath?: string }).webkitClipPath = clip
}

export function attachContinuousCornerRef(value: unknown): void {
  if (!value || typeof value !== "object" || !("ownerDocument" in value)) return
  const view = (value as Element).ownerDocument?.defaultView
  if (!view || !(value instanceof view.Element)) return
  update(value)
  const ResizeObserverConstructor = view.ResizeObserver
    ?? (typeof ResizeObserver === "undefined" ? undefined : ResizeObserver)
  if (!ResizeObserverConstructor) return
  observers.get(value)?.disconnect()
  const observer = new ResizeObserverConstructor(() => update(value))
  observer.observe(value)
  observers.set(value, observer)
}
