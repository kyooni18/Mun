import { APPLE_CONTINUOUS_CORNER_SMOOTHING, continuousCornerPath, expandCornerRadiusShorthand } from "@mun/core/corners"

const observers = new WeakMap<Element, ResizeObserver>()
const lastClip = new WeakMap<Element, string>()

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
  if (lastClip.get(element) === clip) return
  lastClip.set(element, clip)
  element.style.clipPath = clip
  ;(element.style as CSSStyleDeclaration & { webkitClipPath?: string }).webkitClipPath = clip
}

function hasContinuousCorners(style: unknown): boolean {
  return typeof style === "object"
    && style !== null
    && (style as Record<string, unknown>)["--mun-corner-style"] === "continuous"
}

export function syncContinuousCorners(element: Element, style: unknown): void {
  if (!hasContinuousCorners(style)) {
    disposeContinuousCorners(element)
    return
  }
  update(element)
  const ResizeObserverConstructor = element.ownerDocument?.defaultView?.ResizeObserver
    ?? (typeof ResizeObserver === "undefined" ? undefined : ResizeObserver)
  if (!ResizeObserverConstructor || observers.has(element)) return
  const observer = new ResizeObserverConstructor(() => update(element))
  observer.observe(element)
  observers.set(element, observer)
}

export function disposeContinuousCorners(element: Element): void {
  observers.get(element)?.disconnect()
  observers.delete(element)
  lastClip.delete(element)
}
