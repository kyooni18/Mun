import { edgeInsetsFromCss, zeroGeometry, type GeometryProxy } from "@mun/core/compat"

export function geometryFromElement(element: Element): GeometryProxy {
  let rect: DOMRect
  try { rect = element.getBoundingClientRect() } catch { return zeroGeometry }
  const frame = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  }
  const size = { width: rect.width, height: rect.height }
  const document = element.ownerDocument
  const view = document.defaultView
  const fallback = { frame, size, safeAreaInsets: zeroGeometry.safeAreaInsets }
  if (!view?.getComputedStyle || !document.body) return fallback
  const probe = document.createElement("div")
  probe.style.cssText = "position:fixed;inset:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"
  try {
    document.body.appendChild(probe)
    const style = view.getComputedStyle(probe)
    return { frame, size, safeAreaInsets: edgeInsetsFromCss({ top: style.paddingTop, right: style.paddingRight, bottom: style.paddingBottom, left: style.paddingLeft }) }
  } catch {
    return fallback
  } finally {
    try { probe.remove() } catch {}
  }
}

export function sameGeometry(left: GeometryProxy, right: GeometryProxy): boolean {
  return left.frame.x === right.frame.x
    && left.frame.y === right.frame.y
    && left.frame.width === right.frame.width
    && left.frame.height === right.frame.height
    && left.safeAreaInsets.top === right.safeAreaInsets.top
    && left.safeAreaInsets.right === right.safeAreaInsets.right
    && left.safeAreaInsets.bottom === right.safeAreaInsets.bottom
    && left.safeAreaInsets.left === right.safeAreaInsets.left
}
