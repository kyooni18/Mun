import { isSafeUrlAttribute } from "./url-policy.js"

export type PatchScalar = string | number | boolean | null | undefined

export type PatchLocation =
  | { readonly node: number; readonly kind: "text" }
  | { readonly node: number; readonly kind: "attribute"; readonly key: string }
  | { readonly node: number; readonly kind: "property"; readonly key: string }
  | { readonly node: number; readonly kind: "style"; readonly key: string }
  | { readonly node: number; readonly kind: "class"; readonly key?: string }
  | { readonly node: number; readonly kind: "child-range"; readonly endNode: number }

export interface PatchIR {
  readonly version: 1
  readonly locations: readonly PatchLocation[]
  readonly dirtyWordCount: number
}

export interface PatchValues {
  readonly dirty: Uint32Array
  readonly values: readonly unknown[]
}

const unsafePropertyKeys = new Set([
  "__proto__",
  "constructor",
  "innerHTML",
  "outerHTML",
  "prototype",
  "textContent",
  "srcdoc",
])

const patchKinds = new Set(["text", "attribute", "property", "style", "class", "child-range"])

const attributeNamePattern = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/u
const styleNamePattern = /^(?:--[A-Za-z0-9_-]+|[A-Za-z-][A-Za-z0-9-]*)$/u

function assertNodeIndex(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`)
}

function validateLocation(location: PatchLocation): PatchLocation {
  if (!patchKinds.has(location.kind)) throw new TypeError(`unknown patch kind: ${JSON.stringify(location.kind)}`)
  assertNodeIndex(location.node, "patch node index")
  if (location.kind === "attribute") {
    if (!attributeNamePattern.test(location.key) || /^on/iu.test(location.key)
      || location.key === "style" || location.key === "class" || location.key.toLowerCase() === "srcdoc") {
      throw new TypeError(`unsafe patch attribute: ${JSON.stringify(location.key)}`)
    }
  } else if (location.kind === "property") {
    if (!/^[$A-Z_a-z][$\w]*$/u.test(location.key) || unsafePropertyKeys.has(location.key) || /^on/iu.test(location.key)) {
      throw new TypeError(`unsafe patch property: ${JSON.stringify(location.key)}`)
    }
  } else if (location.kind === "style") {
    if (!styleNamePattern.test(location.key) || location.key.toLowerCase() === "csstext") {
      throw new TypeError(`unsafe patch style: ${JSON.stringify(location.key)}`)
    }
  } else if (location.kind === "class" && location.key !== undefined) {
    if (location.key.length === 0 || /\s/u.test(location.key)) throw new TypeError(`invalid patch class token: ${JSON.stringify(location.key)}`)
  } else if (location.kind === "child-range") {
    assertNodeIndex(location.endNode, "patch range end node index")
    if (location.endNode === location.node) throw new RangeError("patch child range requires distinct start and end anchors")
  }
  return Object.freeze({ ...location })
}

export function definePatchIR(locations: readonly PatchLocation[]): PatchIR {
  if (locations.length === 0) throw new TypeError("Patch IR requires at least one location")
  return Object.freeze({
    version: 1,
    locations: Object.freeze(locations.map(validateLocation)),
    dirtyWordCount: Math.ceil(locations.length / 32),
  })
}

export function allocatePatchValues(ir: PatchIR): { dirty: Uint32Array; values: unknown[] } {
  return { dirty: new Uint32Array(ir.dirtyWordCount), values: new Array(ir.locations.length) }
}

export function markPatchDirty(dirty: Uint32Array, index: number): void {
  assertNodeIndex(index, "patch index")
  const word = Math.floor(index / 32)
  if (word >= dirty.length) throw new RangeError(`patch index ${index} exceeds the dirty bitset`)
  dirty[word] |= 1 << (index & 31)
}

export function clearPatchDirty(dirty: Uint32Array): void {
  dirty.fill(0)
}

function patchIsDirty(dirty: Uint32Array, index: number): boolean {
  const word = dirty[Math.floor(index / 32)]
  return word !== undefined && (word & (1 << (index & 31))) !== 0
}

function scalarText(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  throw new TypeError("text, attribute, style, and class patches require primitive values")
}

function elementNode(node: Node, kind: string): Element {
  if (node.nodeType !== 1) throw new TypeError(`${kind} patch target must be an Element`)
  return node as Element
}

function styleNode(node: Node): HTMLElement | SVGElement {
  const element = elementNode(node, "style") as HTMLElement | SVGElement
  if (!("style" in element) || !element.style?.setProperty) throw new TypeError("style patch target has no CSSStyleDeclaration")
  return element
}

function patchChildRange(nodes: readonly Node[], location: Extract<PatchLocation, { readonly kind: "child-range" }>, value: unknown): void {
  const start = nodes[location.node]
  const end = nodes[location.endNode]
  if (!start || !end || start.nodeType !== 8 || end.nodeType !== 8 || start.parentNode !== end.parentNode || !start.parentNode) {
    throw new TypeError("child-range patch requires live sibling Comment anchors")
  }
  if (start === end) throw new TypeError("child-range patch requires distinct anchors")
  const parent = start.parentNode
  if (parent.nodeType !== 1 && parent.nodeType !== 11) throw new TypeError("child-range patch requires an Element or DocumentFragment parent")
  let boundary: Node | null = start.nextSibling
  while (boundary && boundary !== end) boundary = boundary.nextSibling
  if (!boundary) throw new TypeError("child-range anchors must be in forward sibling order")

  // Validate all replacement nodes before removing anything. In particular,
  // insertBefore's own validation would run too late to preserve the old range.
  if (value != null && !Array.isArray(value)) throw new TypeError("child-range patch value must be an array of renderer-owned Nodes")
  // Exact identity with the already validated live range proves that these
  // are distinct, legal DOM children. Avoid both writes and per-node native
  // brand/ancestor checks on this common path.
  let cursor = start.nextSibling
  let unchanged = true
  for (const child of value ?? []) {
    if (!cursor || cursor === end || cursor !== child) { unchanged = false; break }
    cursor = cursor.nextSibling
  }
  if (unchanged && cursor === end) return

  const children: Node[] = []
  const seen = new Set<Node>()
  const append = (child: unknown): void => {
    try {
      // Native DOM brand checking accepts nodes from other windows/documents,
      // unlike instanceof against the target window's Node constructor.
      parent.compareDocumentPosition(child as Node)
    } catch {
      throw new TypeError("child-range patch value contains a non-Node")
    }
    const node = child as Node
    if (node === start || node === end || node.contains(parent)) {
      throw new TypeError("child-range replacement cannot contain its anchors or an ancestor")
    }
    if (node.nodeType === 11) {
      for (const item of [...node.childNodes]) append(item)
      return
    }
    if (![1, 3, 4, 7, 8].includes(node.nodeType)) throw new TypeError("child-range patch contains an unsupported Node type")
    if (seen.has(node)) throw new TypeError("child-range replacement contains a duplicate Node")
    seen.add(node)
    children.push(node)
  }
  for (const child of value ?? []) append(child)

  let current = start.nextSibling
  while (current && current !== end) {
    const next = current.nextSibling
    parent.removeChild(current)
    current = next
  }
  for (const child of children) parent.insertBefore(child, end)
}

/** Apply dirty compiler-owned patches in stable location order. */
export function applyPatchIR(nodes: readonly Node[], ir: PatchIR, patch: PatchValues): number {
  if (patch.dirty.length !== ir.dirtyWordCount) throw new RangeError("patch dirty bitset does not match Patch IR")
  if (patch.values.length !== ir.locations.length) throw new RangeError("patch values do not match Patch IR")
  let applied = 0
  for (let index = 0; index < ir.locations.length; index += 1) {
    if (!patchIsDirty(patch.dirty, index)) continue
    const location = ir.locations[index]!
    const node = nodes[location.node]
    if (!node) throw new RangeError(`Patch IR references missing node ${location.node}`)
    const value = patch.values[index]
    if (location.kind === "text") {
      if (node.nodeType !== 3) throw new TypeError("text patch target must be a Text node")
      node.nodeValue = scalarText(value)
    } else if (location.kind === "attribute") {
      const element = elementNode(node, "attribute")
      if (value == null || value === false || !isSafeUrlAttribute(location.key, value)) element.removeAttribute(location.key)
      else element.setAttribute(location.key, scalarText(value))
    } else if (location.kind === "property") {
      const element = elementNode(node, "property") as Element & Record<string, unknown>
      if (!isSafeUrlAttribute(location.key, value)) element.removeAttribute(location.key)
      else element[location.key] = value
    } else if (location.kind === "style") {
      const element = styleNode(node)
      if (value == null || value === false) element.style.removeProperty(location.key)
      else element.style.setProperty(location.key, scalarText(value))
    } else if (location.kind === "class") {
      const element = elementNode(node, "class")
      if (location.key === undefined) element.setAttribute("class", scalarText(value))
      else element.classList.toggle(location.key, Boolean(value))
    } else {
      patchChildRange(nodes, location, value)
    }
    applied += 1
  }
  return applied
}
