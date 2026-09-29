import { classNameOf, type Animation } from "@mun/core/compat"
import { cssPropertyName, htmlAttributeName, isBooleanHtmlAttribute, isEnumeratedBooleanAttribute, normalizedTextAreaValue, type DomRenderContext } from "./shared.js"
import { animateDomAttribute, animateDomStyles, cancelDomAnimations, cancelDomAttributeAnimation, cancelDomStyleAnimation, type DomStyleMotionChange } from "./motion.js"
import { syncFocusScope } from "./focus.js"
import { syncContinuousCorners } from "./continuous-corners.js"

const XLINK_NS = "http://www.w3.org/1999/xlink"
const XML_NS = "http://www.w3.org/XML/1998/namespace"

export interface DomStyleMotionPolicy {
  /**
   * Return an Animation to override the current transaction for this property,
   * null to force a discrete patch, or undefined to inherit the transaction.
   */
  animationForProperty(property: string, from: unknown, to: unknown): Animation | null | undefined
}

export interface DomAttributeMotionPolicy {
  /** Return the animation for one changing DOM attribute, or undefined for a direct patch. */
  animationForAttribute(attribute: string, from: unknown, to: unknown): Animation | null | undefined
}

function styleDeclaration(element: Element): CSSStyleDeclaration | undefined {
  return (element as Element & { style?: CSSStyleDeclaration }).style
}

function domStyle(element: Element, value: unknown): void {
  if (typeof value !== "object" || value === null) {
    if (typeof value === "string") element.setAttribute("style", value)
    return
  }
  const style = styleDeclaration(element)
  if (!style) return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined || item === null) continue
    style.setProperty(cssPropertyName(key), String(item))
  }
}

export function setDomRef(reference: unknown, element: Element): () => void {
  if (typeof reference === "function") {
    reference(element)
    return () => reference(null)
  }
  if (!reference || typeof reference !== "object") return () => undefined
  const target = reference as { current: unknown }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(reference, "current")
    if (!descriptor || !("value" in descriptor) || descriptor.writable !== true) return () => undefined
    target.current = element
  } catch {
    return () => undefined
  }
  return () => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(reference, "current")
      if (descriptor && "value" in descriptor && descriptor.writable === true && descriptor.value === element) target.current = null
    } catch { /* detached hostile refs are already inert */ }
  }
}

function domEvent(key: string): { readonly name: string; readonly capture: boolean; readonly storageKey: string } {
  const raw = key.slice(2)
  const capture = raw.endsWith("Capture") && raw !== "GotPointerCapture" && raw !== "LostPointerCapture"
  const normalized = (capture ? raw.slice(0, -"Capture".length) : raw).toLowerCase()
  const name = normalized === "doubleclick" ? "dblclick" : normalized
  return { name, capture, storageKey: `${capture ? "capture" : "bubble"}:${name}` }
}

export function setDomEvent(element: Element, key: string, value: unknown, context: DomRenderContext, attach = true): void {
  const event = domEvent(key)
  const listeners = context.eventListeners.get(element) ?? new Map<string, EventListener>()
  const hadListeners = listeners.size > 0
  type EventInvoker = EventListener & { handler?: EventListener }
  const previous = listeners.get(event.storageKey) as EventInvoker | undefined
  if (attach && typeof value === "function") {
    // Keep one native listener attached for the lifetime of the prop and only
    // replace the current callback. Rendered event closures are commonly new
    // function identities even when the DOM node is reused; remove/add on
    // every reconciliation is pure overhead and can perturb event ordering.
    if (previous) {
      previous.handler = value as EventListener
    } else {
      const invoker = ((nativeEvent: Event) => invoker.handler?.call(element, nativeEvent)) as EventInvoker
      invoker.handler = value as EventListener
      element.addEventListener(event.name, invoker, event.capture)
      listeners.set(event.storageKey, invoker)
    }
  } else if (previous) {
    element.removeEventListener(event.name, previous, event.capture)
    listeners.delete(event.storageKey)
  }
  const hasListeners = listeners.size > 0
  if (hasListeners) context.eventListeners.set(element, listeners)
  else context.eventListeners.delete(element)
  if (!hadListeners && hasListeners) context.eventTargetCount += 1
  else if (hadListeners && !hasListeners) context.eventTargetCount = Math.max(0, context.eventTargetCount - 1)
}

export function clearDomEvents(element: Element, context: DomRenderContext): void {
  const listeners = context.eventListeners.get(element)
  if (!listeners) return
  for (const [storageKey, listener] of listeners) {
    const separator = storageKey.indexOf(":")
    const capture = storageKey.slice(0, separator) === "capture"
    element.removeEventListener(storageKey.slice(separator + 1), listener, capture)
  }
  context.eventListeners.delete(element)
  context.eventTargetCount = Math.max(0, context.eventTargetCount - 1)
}

function namespacedAttribute(name: string): { readonly namespace?: string; readonly localName: string; readonly qualifiedName: string } {
  if (name.startsWith("xlink:")) return { namespace: XLINK_NS, localName: name.slice(6), qualifiedName: name }
  if (name.startsWith("xml:")) return { namespace: XML_NS, localName: name.slice(4), qualifiedName: name }
  return { localName: name, qualifiedName: name }
}

function setAttribute(element: Element, name: string, value: string): void {
  const attribute = namespacedAttribute(name)
  if (attribute.namespace) element.setAttributeNS(attribute.namespace, attribute.qualifiedName, value)
  else element.setAttribute(attribute.qualifiedName, value)
}

function removeAttribute(element: Element, name: string): void {
  const attribute = namespacedAttribute(name)
  if (attribute.namespace) element.removeAttributeNS(attribute.namespace, attribute.localName)
  else element.removeAttribute(attribute.qualifiedName)
}

function setDomProperty(element: Element, name: string, value: unknown): void {
  if (name !== "value" && name !== "checked" && name !== "selected" && name !== "disabled" && name !== "multiple" && name !== "muted") return
  try { (element as unknown as Record<string, unknown>)[name] = value } catch { /* attribute remains authoritative */ }
}

function isHtmlTextArea(element: Element): boolean {
  return element.namespaceURI === "http://www.w3.org/1999/xhtml" && element.localName.toLowerCase() === "textarea"
}

function isHtmlSelect(element: Element): boolean {
  return element.namespaceURI === "http://www.w3.org/1999/xhtml" && element.localName.toLowerCase() === "select"
}

export function synchronizeDomSelectValue(element: Element, props: Record<string, unknown> | null | undefined): void {
  const value = props?.value
  if (!isHtmlSelect(element) || value === undefined || value === null) return
  const normalized = String(value)
  let matched = false
  for (const option of element.querySelectorAll("option")) {
    const selected = !matched && option.value === normalized
    if (selected) matched = true
    if (selected) option.setAttribute("selected", "")
    else option.removeAttribute("selected")
  }
  setDomProperty(element, "value", normalized)
  removeAttribute(element, "value")
}

function applyAttributeValue(element: Element, key: string, value: unknown): void {
  const name = htmlAttributeName(key)
  const customElement = element.localName.includes("-")
  if (customElement && (key in element || typeof value === "object" || typeof value === "function")) {
    try {
      ;(element as unknown as Record<string, unknown>)[key] = value
      if (typeof value === "object" || typeof value === "function") removeAttribute(element, name)
      return
    } catch { /* fall through to attribute semantics */ }
  }
  if (isBooleanHtmlAttribute(name)) {
    setDomProperty(element, name, Boolean(value))
    if (value) setAttribute(element, name, "")
    else removeAttribute(element, name)
    return
  }
  if (value === false || value === true) {
    if (name.startsWith("aria-") || name.startsWith("data-") || isEnumeratedBooleanAttribute(name)) {
      setAttribute(element, name, String(value))
    } else if (value) {
      setAttribute(element, name, "")
    } else {
      setAttribute(element, name, "false")
    }
    setDomProperty(element, name, value)
    return
  }
  if (name === "value" && isHtmlTextArea(element)) {
    // A textarea's initial value is represented by its text content, not a
    // value attribute. Keep defaultValue and the live controlled value aligned.
    const normalized = normalizedTextAreaValue(value)
    element.textContent = normalized
    setDomProperty(element, name, normalized)
    removeAttribute(element, name)
    return
  }
  if (name === "value" && isHtmlSelect(element)) {
    setDomProperty(element, name, String(value))
    removeAttribute(element, name)
    return
  }
  setDomProperty(element, name, value)
  setAttribute(element, name, String(value))
}

function rememberDomKey(element: Element, props: Record<string, unknown> | null | undefined, context: DomRenderContext): void {
  const nextKey = typeof props?.key === "string" || typeof props?.key === "number" ? props.key : undefined
  if (nextKey === undefined) return
  context.hasDomKeys = true
  context.domKeys.set(element, nextKey)
}

/** Structural graph fields are reconciler metadata, never DOM properties. */
function renderableDomProps(props: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  if (!props) return undefined
  const keys = Object.keys(props)
  let structural = 0
  for (const key of keys) if (key === "key" || key === "children") structural += 1
  if (structural === 0) return props
  if (structural === keys.length) return undefined
  const filtered: Record<string, unknown> = {}
  for (const key of keys) {
    if (key === "key" || key === "children") continue
    filtered[key] = props[key]
  }
  return filtered
}

function trackDomRef(element: Element, props: Record<string, unknown> | null | undefined, context: DomRenderContext): void {
  const reference = props?.ref
  if (reference !== undefined && reference !== null) {
    context.hasRefs = true
    context.refElements.add(element)
  } else {
    context.refElements.delete(element)
  }
}

function stageDomProps(element: Element, props: Record<string, unknown>, context: DomRenderContext): void {
  rememberDomKey(element, props, context)
  const renderable = renderableDomProps(props)
  if (!renderable) return
  const previous = context.domProps.get(element)
  const hasClass = Object.prototype.hasOwnProperty.call(renderable, "class") || Object.prototype.hasOwnProperty.call(renderable, "className")
  if (!previous && !hasClass) {
    // Element props are already snapshotted by @mun/core. Keeping that
    // immutable record directly avoids allocating another object for the very
    // common first staging pass; later modifiers still merge through the path
    // below when the same candidate receives more props.
    context.domProps.set(element, renderable)
  } else {
    const before = previous ?? {}
    const previousStyle = before.style && typeof before.style === "object" ? before.style as Record<string, unknown> : undefined
    const nextStyle = renderable.style && typeof renderable.style === "object" ? renderable.style as Record<string, unknown> : undefined
    const remembered: Record<string, unknown> = {
      ...before,
      ...renderable,
      ...(nextStyle ? { style: { ...(previousStyle ?? {}), ...nextStyle } } : {}),
    }
    if (hasClass) {
      const beforeClass = classNameOf(before.class ?? before.className)
      const incoming = classNameOf(renderable.class ?? renderable.className)
      const combined = [beforeClass, incoming].filter(Boolean).join(" ")
      delete remembered.className
      if (combined) remembered.class = combined
      else delete remembered.class
    }
    context.domProps.set(element, remembered)
  }
  trackDomRef(element, context.domProps.get(element), context)
}

export function rememberDomProps(element: Element, props: Record<string, unknown> | null | undefined, context: DomRenderContext, merge = true): void {
  rememberDomKey(element, props, context)
  const renderable = renderableDomProps(props)
  if (!renderable) {
    if (!merge) {
      context.domProps.delete(element)
      context.refElements.delete(element)
    }
    return
  }
  const previousStored = merge ? context.domProps.get(element) : undefined
  const hasClass = Object.prototype.hasOwnProperty.call(renderable, "class") || Object.prototype.hasOwnProperty.call(renderable, "className")
  if (!previousStored && !hasClass) {
    // Core graph props are immutable snapshots, so a fresh node can retain the
    // record directly instead of cloning it merely for future reconciliation.
    context.domProps.set(element, renderable)
    trackDomRef(element, renderable, context)
    return
  }
  const previous = previousStored ?? {}
  const currentStyle = previous.style && typeof previous.style === "object" ? previous.style : {}
  const nextStyle = renderable.style && typeof renderable.style === "object" ? renderable.style : undefined
  const remembered: Record<string, unknown> = {
    ...previous,
    ...renderable,
    ...(nextStyle ? { style: { ...currentStyle, ...nextStyle } } : {}),
  }
  if (hasClass && element.getAttribute("class") !== null) {
    remembered.class = element.getAttribute("class") ?? ""
    delete remembered.className
  }
  context.domProps.set(element, remembered)
  trackDomRef(element, remembered, context)
}

function applyDomPropsNow(
  element: Element,
  props: Record<string, unknown> | null | undefined,
  context: DomRenderContext,
  remember: boolean,
): void {
  if (context.hydrating) context.hydrationProps.set(element, props)
  if (context.hydrating && context.hydrationLiveNodes?.has(element)) {
    // A speculative hydration pass must not mutate the SSR DOM before the
    // entire graph has been structurally and semantically validated. Keep the
    // same staged prop merge semantics used by detached candidates, then let
    // the successful hydration activation attach events/properties in one pass.
    if (props) stageDomProps(element, props, context)
    context.hydrationProps.set(element, context.domProps.get(element) ?? props)
    return
  }
  if (!props) return
  if (context.stagingProps && !context.hydrating) {
    stageDomProps(element, props, context)
    return
  }
  rememberDomKey(element, props, context)
  const renderable = renderableDomProps(props)
  if (!renderable) return
  const entries = Object.entries(renderable)
  if (entries.length === 0) return
  // Keep callback/object refs indexed even when props are applied directly
  // (for example during a direct initial mount or staged-prop activation).
  // commitRefs() relies on refElements rather than scanning the DOM.
  trackDomRef(element, renderable, context)
  for (const [key, value] of entries) {
    if (key === "children" || key === "key") continue
    if (/^on[A-Za-z]/.test(key)) {
      setDomEvent(element, key, value, context, !context.hydrating && !context.stagingEvents && typeof value === "function")
      continue
    }
    if (value === undefined || value === null) continue
    if (key === "style") { domStyle(element, value); continue }
    if (key === "className" || key === "class") {
      const next = [element.getAttribute("class"), classNameOf(value)].filter(Boolean).join(" ")
      if (next) element.setAttribute("class", next)
      continue
    }
    if (key === "ref") continue
    applyAttributeValue(element, key, value)
  }
  if (remember) rememberDomProps(element, props, context)
}

export function applyDomProps(element: Element, props: Record<string, unknown> | null | undefined, context: DomRenderContext): void {
  applyDomPropsNow(element, props, context, true)
  if (!context.stagingProps && !context.hydrating && props
    && Object.prototype.hasOwnProperty.call(props, "data-mun-focus-scope")) {
    syncFocusScope(element, props["data-mun-focus-scope"])
  }
  if (!context.stagingProps && !context.hydrating) syncContinuousCorners(element, props?.style)
}

export function commitStagedDomProps(element: Element, context: DomRenderContext): void {
  const props = context.domProps.get(element)
  if (!props || Object.keys(props).length === 0) return
  const stagingProps = context.stagingProps
  const stagingEvents = context.stagingEvents
  context.stagingProps = false
  context.stagingEvents = false
  try {
    // stageDomProps already holds the normalized snapshot. Do not clone it a
    // second time merely because the candidate is becoming live.
    applyDomPropsNow(element, props, context, false)
    if (Object.prototype.hasOwnProperty.call(props, "data-mun-focus-scope")) {
      syncFocusScope(element, props["data-mun-focus-scope"])
    }
    syncContinuousCorners(element, props.style)
  } finally {
    context.stagingProps = stagingProps
    context.stagingEvents = stagingEvents
  }
}

function removeDomProp(element: Element, key: string): void {
  if (key === "style") {
    element.removeAttribute("style")
    return
  }
  if (key === "class" || key === "className") {
    element.removeAttribute("class")
    return
  }
  const name = htmlAttributeName(key)
  if (element.localName.includes("-") && key in element) {
    try { (element as unknown as Record<string, unknown>)[key] = undefined } catch { /* remove the attribute below */ }
  }
  if (isBooleanHtmlAttribute(name)) setDomProperty(element, name, false)
  else if (name === "value") setDomProperty(element, name, "")
  if (key !== "children" && key !== "key" && key !== "ref" && !/^on[A-Za-z]/.test(key)) removeAttribute(element, name)
}

function sameDomProps(previous: Record<string, unknown>, next: Record<string, unknown>, nextKeys: readonly string[]): boolean {
  const previousKeys = Object.keys(previous)
  if (previousKeys.length !== nextKeys.length) return false
  for (const key of nextKeys) {
    if (!Object.prototype.hasOwnProperty.call(previous, key) || !Object.is(previous[key], next[key])) return false
  }
  return true
}

function canFastPatchPrimitive(key: string, value: unknown): boolean {
  if (key === "children" || key === "key" || key === "ref" || key === "style" || key === "class" || key === "className") return false
  if (/^on[A-Za-z]/.test(key)) return false
  return value === undefined || value === null || (typeof value !== "object" && typeof value !== "function")
}

export function patchDomProps(
  element: Element,
  next: Record<string, unknown> | null | undefined,
  context: DomRenderContext,
  motionPolicy?: DomStyleMotionPolicy,
  attributeMotionPolicy?: DomAttributeMotionPolicy,
): void {
  rememberDomKey(element, next, context)
  const renderable = renderableDomProps(next)
  const previousStored = context.domProps.get(element)
  const nextKeys = renderable ? Object.keys(renderable) : []
  if (!previousStored && nextKeys.length === 0) {
    context.refElements.delete(element)
    return
  }
  if (!attributeMotionPolicy && previousStored && renderable && nextKeys.length === 1) {
    const key = nextKeys[0]
    const previousKeys = Object.keys(previousStored)
    if (previousKeys.length === 1 && previousKeys[0] === key
      && canFastPatchPrimitive(key, previousStored[key])
      && canFastPatchPrimitive(key, renderable[key])) {
      if (Object.is(previousStored[key], renderable[key])) return
      if (renderable[key] === undefined || renderable[key] === null) {
        removeDomProp(element, key)
        context.domProps.delete(element)
        context.refElements.delete(element)
      } else {
        applyAttributeValue(element, key, renderable[key])
        context.domProps.set(element, renderable)
      }
      return
    }
  }
  if (previousStored && renderable && sameDomProps(previousStored, renderable, nextKeys)) return
  const previous = previousStored ?? {}
  for (const key of Object.keys(previous)) {
    if (key === "ref" || key === "key" || key === "children") continue
    if (renderable && Object.prototype.hasOwnProperty.call(renderable, key)) continue
    if (/^on[A-Za-z]/.test(key)) setDomEvent(element, key, undefined, context, false)
    else {
      if (key === "style") cancelDomAnimations(element)
      else cancelDomAttributeAnimation(element, htmlAttributeName(key))
      removeDomProp(element, key)
    }
  }
  for (const [key, value] of Object.entries(renderable ?? {})) {
    if (key === "children" || key === "key") continue
    if (/^on[A-Za-z]/.test(key)) {
      setDomEvent(element, key, value, context, typeof value === "function")
      continue
    }
    if (value === undefined || value === null) {
      if (previous[key] !== undefined) removeDomProp(element, key)
      continue
    }
    if (key === "style") {
      const previousStyle = previous.style
      if (typeof value === "object" && value !== null && typeof previousStyle === "object" && previousStyle !== null) {
        const style = styleDeclaration(element)
        if (style) {
          const before = previousStyle as Record<string, unknown>
          const after = value as Record<string, unknown>
          for (const styleKey of Object.keys(before)) {
            if (Object.prototype.hasOwnProperty.call(after, styleKey)) continue
            const cssName = cssPropertyName(styleKey)
            cancelDomStyleAnimation(element, cssName)
            style.removeProperty(cssName)
          }
          const motionChanges: DomStyleMotionChange[] = []
          const discreteChanges: Array<{ readonly property: string; readonly value: unknown }> = []
          for (const [styleKey, styleValue] of Object.entries(after)) {
            if (styleValue === undefined || styleValue === null) {
              if (before[styleKey] !== undefined && before[styleKey] !== null) {
                const cssName = cssPropertyName(styleKey)
                cancelDomStyleAnimation(element, cssName)
                style.removeProperty(cssName)
              }
              continue
            }
            if (Object.is(before[styleKey], styleValue)) continue
            const cssName = cssPropertyName(styleKey)
            const explicitAnimation = motionPolicy?.animationForProperty(cssName, before[styleKey], styleValue)
            const animation = explicitAnimation === undefined ? context.activeTransaction?.animation : explicitAnimation
            const currentValue = style.getPropertyValue(cssName) || before[styleKey]
            if (animation
              && !context.activeTransaction?.disablesAnimations
              && currentValue !== undefined
              && currentValue !== null) {
              motionChanges.push({ property: cssName, from: currentValue, to: styleValue, animation })
            } else {
              discreteChanges.push({ property: cssName, value: styleValue })
            }
          }
          // Start every eligible channel together. Each change still carries its
          // own Animation, so a spring width and linear opacity can share one
          // engine frame without sharing curve state or cancelling each other.
          const animated = animateDomStyles(element, motionChanges)
          for (const change of motionChanges) {
            if (animated.has(change.property)) continue
            cancelDomStyleAnimation(element, change.property)
            style.setProperty(change.property, String(change.to))
          }
          for (const change of discreteChanges) {
            cancelDomStyleAnimation(element, change.property)
            style.setProperty(change.property, String(change.value))
          }
        }
      } else if (!Object.is(previousStyle, value)) {
        cancelDomAnimations(element)
        element.removeAttribute("style")
        domStyle(element, value)
      }
      continue
    }
    if (key === "className" || key === "class") {
      const className = classNameOf(value)
      const previousClassName = classNameOf(previous[key])
      if (className !== previousClassName) {
        if (className) element.setAttribute("class", className)
        else element.removeAttribute("class")
      }
      continue
    }
    if (key === "ref") continue
    if (Object.is(previous[key], value)) continue
    const attributeName = htmlAttributeName(key)
    const attributeAnimation = attributeMotionPolicy?.animationForAttribute(attributeName, previous[key], value)
    if (attributeAnimation && !context.activeTransaction?.disablesAnimations) {
      const current = element.getAttribute(attributeName) ?? previous[key]
      if (current !== undefined && current !== null
        && animateDomAttribute(element, attributeName, current, value, attributeAnimation)) continue
    }
    cancelDomAttributeAnimation(element, attributeName)
    applyAttributeValue(element, key, value)
  }
  if (!renderable || nextKeys.length === 0) {
    context.domProps.delete(element)
    context.refElements.delete(element)
  } else {
    context.domProps.set(element, renderable)
    trackDomRef(element, renderable, context)
  }
  syncFocusScope(element, renderable?.["data-mun-focus-scope"])
  syncContinuousCorners(element, renderable?.style)
}
