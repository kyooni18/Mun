import { isSafeUrlAttribute } from "./url-policy.js"
import {
  classNameOf,
  domContentContainer,
  htmlAttributeName,
  isBooleanHtmlAttribute,
  isEnumeratedBooleanAttribute,
  styleAttribute,
  type DomRenderContext,
} from "./shared.js"
import { rememberDomProps, setDomEvent, synchronizeDomSelectValue } from "./props.js"

const HTML_NS = "http://www.w3.org/1999/xhtml"

/**
 * Verify that live SSR attributes already equal the final renderer-owned prop
 * snapshot. The speculative live-node hydration path is deliberately strict:
 * unsupported/custom/form-control shapes fall back to candidate hydration
 * instead of mutating the server tree before structural validation completes.
 */
export function hydratedPropsMatch(
  element: Element,
  props: Record<string, unknown> | null | undefined,
): boolean {
  if (element.namespaceURI !== HTML_NS || element.localName.includes("-")) return false
  if (!props) return !element.hasAttributes()
  const tag = element.localName.toLowerCase()
  let expectedCount = 0
  for (const key in props) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) continue
    const value = props[key]
    if (key === "children" || key === "key" || key === "ref" || /^on[A-Za-z]/.test(key)
      || value === undefined || value === null || typeof value === "function") continue
    if ((tag === "textarea" || tag === "select") && htmlAttributeName(key).toLowerCase() === "value") return false
    if (typeof value === "object" && key !== "style" && key !== "className" && key !== "class") return false
    const name = htmlAttributeName(key)
    if (name !== key && Object.prototype.hasOwnProperty.call(props, name)) return false
    const serialized = key === "style"
      ? styleAttribute(value)
      : key === "className" || key === "class"
        ? classNameOf(value)
        : String(value)
    if (serialized === undefined || !isSafeUrlAttribute(name, serialized)) continue
    if (isBooleanHtmlAttribute(name)) {
      if (value) {
        expectedCount += 1
        if (element.getAttribute(name) !== "") return false
      }
      continue
    }
    if (value === false || value === true) {
      if (name.startsWith("aria-") || name.startsWith("data-") || isEnumeratedBooleanAttribute(name)) {
        expectedCount += 1
        if (element.getAttribute(name) !== String(value)) return false
      } else if (value) {
        expectedCount += 1
        if (element.getAttribute(name) !== "") return false
      } else {
        expectedCount += 1
        if (element.getAttribute(name) !== "false") return false
      }
      continue
    }
    expectedCount += 1
    if (element.getAttribute(name) !== serialized) return false
  }
  return element.attributes.length === expectedCount
}

function synchronizeAttributes(source: Element, target: Element): void {
  // Server markup normally already matches the candidate tree exactly. Avoid
  // rebuilding the attribute map and issuing setAttribute calls in that hot
  // path; besides the allocation, each write can invalidate the browser's
  // style/attribute caches during hydration.
  if (source.attributes.length === target.attributes.length) {
    let identical = true
    for (let index = 0; index < source.attributes.length; index += 1) {
      const expected = source.attributes[index]
      const actual = target.attributes[index]
      if (expected.namespaceURI !== actual.namespaceURI
        || expected.localName !== actual.localName
        || expected.value !== actual.value) {
        identical = false
        break
      }
    }
    if (identical) return
  }
  const sourceAttributes = new Map([...source.attributes].map(attribute => [
    `${attribute.namespaceURI ?? ""}|${attribute.localName}`,
    attribute,
  ]))
  for (const attribute of [...target.attributes]) {
    const key = `${attribute.namespaceURI ?? ""}|${attribute.localName}`
    if (sourceAttributes.has(key)) continue
    if (attribute.namespaceURI) target.removeAttributeNS(attribute.namespaceURI, attribute.localName)
    else target.removeAttribute(attribute.name)
  }
  for (const attribute of sourceAttributes.values()) {
    const current = attribute.namespaceURI
      ? target.getAttributeNS(attribute.namespaceURI, attribute.localName)
      : target.getAttribute(attribute.name)
    if (current === attribute.value) continue
    if (attribute.namespaceURI) target.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value)
    else target.setAttribute(attribute.name, attribute.value)
  }
}

function activateHydratedProps(source: Element, target: Element, context: DomRenderContext, attributesAlreadyMatch = false): void {
  const props = context.hydrationProps.get(source)
  if (!attributesAlreadyMatch) synchronizeAttributes(source, target)
  rememberDomProps(target, props, context, false)
  const tag = context.domTags.get(source)
  if (tag) context.domTags.set(target, tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === "children" || key === "key" || key === "ref" || value === undefined || value === null) continue
    if (typeof value === "function" && /^on[A-Za-z]/.test(key)) {
      setDomEvent(target, key, value, context)
      continue
    }
    if (key === "value" || key === "checked" || key === "selected" || key === "disabled" || key === "multiple" || key === "muted") {
      try { (target as unknown as Record<string, unknown>)[key] = value } catch { /* attribute remains authoritative */ }
    }
  }
}

export function hydrateNode(source: Node, target: Node, context: DomRenderContext): boolean {
  if (source.nodeType !== target.nodeType) return false
  if (source.nodeType === 3) {
    // Matching SSR text is overwhelmingly the common case. Avoid turning a
    // no-op hydration check into a DOM mutation for every text node.
    if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue
    return true
  }
  if (source.nodeType !== 1 || target.nodeType !== 1) return source.nodeType === target.nodeType
  const sourceElement = source as Element
  const targetElement = target as Element
  if (sourceElement.namespaceURI !== targetElement.namespaceURI || sourceElement.tagName !== targetElement.tagName) return false
  const sourceContent = domContentContainer(sourceElement)
  const targetContent = domContentContainer(targetElement)
  activateHydratedProps(sourceElement, targetElement, context)
  const key = context.domKeys.get(sourceElement)
  if (key !== undefined) context.domKeys.set(targetElement, key)
  const lazyKey = context.lazyKeys.get(sourceElement)
  if (lazyKey) context.lazyKeys.set(targetElement, lazyKey)
  let sourceChild = sourceContent.firstChild
  let targetChild = targetContent.firstChild
  while (sourceChild && targetChild) {
    if (!hydrateNode(sourceChild, targetChild, context)) return false
    sourceChild = sourceChild.nextSibling
    targetChild = targetChild.nextSibling
  }
  if (sourceChild || targetChild) return false
  synchronizeDomSelectValue(targetElement, context.hydrationProps.get(sourceElement))
  return true
}

function activateHydratedTree(node: Node, context: DomRenderContext): void {
  if (node.nodeType !== 1) return
  const element = node as Element
  activateHydratedProps(element, element, context, true)
  const content = domContentContainer(element)
  for (let child = content.firstChild; child; child = child.nextSibling) activateHydratedTree(child, context)
}
export { activateHydratedTree }

/**
 * Successful speculative hydration already proved structure and attributes.
 * Activate live props and bind renderer metadata in one tree walk instead of
 * running the generic compare pass followed by a second binding pass.
 */
export function activateReusedHydratedTree(
  node: Node,
  context: DomRenderContext,
  bind: (node: Node) => void,
): void {
  if (node.nodeType !== 1) {
    bind(node)
    return
  }
  const element = node as Element
  activateHydratedProps(element, element, context)
  bind(node)
  const content = domContentContainer(element)
  for (let child = content.firstChild; child; child = child.nextSibling) {
    activateReusedHydratedTree(child, context, bind)
  }
  synchronizeDomSelectValue(element, context.hydrationProps.get(element))
}
