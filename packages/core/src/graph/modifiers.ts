import type { Animation } from "../animation.js"
import type { FrameOptions } from "../layout.js"
import type { Transition } from "../transition.js"
import type { ContentTransition } from "../content-transition.js"
import type { MunStyleProperties } from "../html.js"
import { APPLE_CONTINUOUS_CORNER_SMOOTHING } from "../corners.js"
import { Color, LinearGradient, shapeStyleCss, type ShapeStyle } from "../style.js"
import { arrayCheck, snapshotArrayValues } from "./arrays.js"
import type { ClassValue, Length, ModifiableViewNode, Modifiers, OffsetValue, ScaleEffectValue, ViewModifierNode, ViewNode } from "./types.js"

const decoratedNodes = new WeakMap<object, ModifiableViewNode>()

function snapshotStyleRecord(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value
  const array = arrayCheck(value)
  if (array === true) return value
  if (array === undefined) return Object.freeze({})
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return Object.freeze({})
    const clone = Object.create(prototype) as Record<PropertyKey, unknown>
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) continue
      const item = descriptor.value
      if (item !== undefined && typeof item !== "string" && (typeof item !== "number" || !Number.isFinite(item))) continue
      Object.defineProperty(clone, key, descriptor)
    }
    return Object.freeze(clone)
  } catch {
    return Object.freeze({})
  }
}

export function snapshotRecord(value: unknown, snapshotStyle = false): unknown {
  if (typeof value !== "object" || value === null) return value
  const array = arrayCheck(value)
  if (array === true) return value
  if (array === undefined) return Object.freeze({})
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return value
    const clone = Object.create(prototype) as Record<PropertyKey, unknown>
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) continue
      const normalized = snapshotStyle && key === "style"
        ? { ...descriptor, value: snapshotStyleRecord(descriptor.value) }
        : descriptor
      Object.defineProperty(clone, key, normalized)
    }
    return Object.freeze(clone)
  } catch {
    return Object.freeze({})
  }
}

function snapshotClassValue(value: unknown, seen = new Set<unknown[]>()): unknown {
  const array = arrayCheck(value)
  if (array === undefined) return false
  if (!array) return value
  const values = value as unknown[]
  if (seen.has(values)) return false
  seen.add(values)
  try {
    const length = Object.getOwnPropertyDescriptor(values, "length")
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) return false
    const snapshot: unknown[] = []
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(values, String(index))
      if (descriptor && "value" in descriptor) snapshot.push(snapshotClassValue(descriptor.value, seen))
    }
    return Object.freeze(snapshot)
  } catch {
    return false
  } finally {
    seen.delete(values)
  }
}

function maskShapeDescriptor(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const node = value as { kind?: string; content?: unknown; props?: Record<string, unknown> }
  const shape = node.kind === "modified" ? node.content : node
  if (!shape || typeof shape !== "object") return undefined
  const shapeNode = shape as { kind?: string; props?: Record<string, unknown> }
  if (shapeNode.kind !== "element") return undefined
  const name = shapeNode.props?.["data-mun"]
  if (typeof name !== "string") return undefined
  const radius = name === "Circle" ? 50
    : name === "Capsule" ? 50
      : name === "RoundedRectangle"
        ? (() => {
            const value = shapeNode.props?.style && typeof shapeNode.props.style === "object" ? (shapeNode.props.style as Record<string, unknown>).borderRadius : undefined
            const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : 8
            return Number.isFinite(parsed) ? Math.max(0, Math.min(50, parsed)) : 8
          })()
        : undefined
  if (radius === undefined && name !== "Rectangle") return undefined
  const shapeMarkup = name === "Circle"
    ? `<circle cx="50" cy="50" r="50" fill="white"/>`
    : `<rect x="0" y="0" width="100" height="100" rx="${radius ?? 0}" fill="white"/>`
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${shapeMarkup}</svg>`)}")`
}

function maskStyle(value: unknown): Record<string, string> {
  const source = typeof value === "string" ? value : maskShapeDescriptor(value)
  return source ? { mask: source, WebkitMask: source } : {}
}

function clipShapeStyle(value: unknown): Record<string, string> {
  if (typeof value === "string") return { clipPath: value }
  if (typeof value !== "object" || value === null) return {}
  const node = value as { kind?: string; content?: unknown }
  const shape = node.kind === "modified" ? node.content : node
  if (!shape || typeof shape !== "object") return {}
  const shapeNode = shape as { kind?: string; props?: Record<string, unknown> }
  if (shapeNode.kind !== "element") return {}
  const name = shapeNode.props?.["data-mun"]
  if (name === "Circle") return { clipPath: "circle(50%)" }
  if (name === "Capsule") return { clipPath: "inset(0 round 9999px)" }
  if (name === "Rectangle") return { clipPath: "inset(0)" }
  if (name === "RoundedRectangle") {
    const style = shapeNode.props?.style
    const radius = style && typeof style === "object" ? (style as Record<string, unknown>).borderRadius : 8
    return { clipPath: `inset(0 round ${typeof radius === "number" ? `${radius}px` : String(radius ?? "8px")})` }
  }
  return {}
}

function snapshotModifierArgument(name: string, value: unknown): unknown {
  if (name === "style") return snapshotStyleRecord(value)
  if (name === "frame") return snapshotRecord(value)
  if (name === "className") return snapshotClassValue(value)
  if (name === "withProps") return snapshotRecord(value, true)
  return value
}

function ownDataValue(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== "object" || value === null) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function snapshotModifierNode(value: unknown): ViewModifierNode | undefined {
  const name = ownDataValue(value, "name")
  const arguments_ = ownDataValue(value, "arguments")
  if (typeof name !== "string" || arrayCheck(arguments_) !== true) return undefined
  const props = ownDataValue(value, "props")
  const normalizedArguments = Object.freeze(snapshotArrayValues(arguments_ as readonly unknown[]).map(item => snapshotModifierArgument(name, item)))
  const mask = name === "mask" ? maskStyle(normalizedArguments[0]) : name === "clipShape" ? clipShapeStyle(normalizedArguments[0]) : {}
  const normalizedProps = props === undefined ? undefined : props === null ? null : snapshotRecord(props, true) as object
  return Object.freeze({
    name,
    arguments: normalizedArguments,
    ...(Object.keys(mask).length > 0 ? { props: Object.freeze({ style: Object.freeze(mask) }) } : normalizedProps === undefined ? {} : { props: normalizedProps }),
  })
}

function applyModifier(content: ViewNode, name: string, arguments_: readonly unknown[]): ModifiableViewNode {
  return modifiedContent(content, { name, arguments: arguments_ })
}

const modifierPrototype = Object.freeze(Object.assign(Object.create(Object.prototype), {
  // SwiftUI's parameterless padding uses a platform default rather than zero.
  // Mun uses a deterministic 16 CSS-pixel web default while preserving an
  // explicitly authored zero.
  padding(this: ViewNode, valueOrEdges: unknown = 16, length?: Length) {
    return applyModifier(this, "padding", arguments.length >= 2 ? [valueOrEdges, length] : [valueOrEdges])
  },
  margin(this: ViewNode, value: Length = 0) { return applyModifier(this, "margin", [value]) },
  gap(this: ViewNode, value: Length) { return applyModifier(this, "gap", [value]) },
  frame(this: ViewNode, options: FrameOptions = {}) { return applyModifier(this, "frame", [options]) },
  font(this: ViewNode, value: string) { return applyModifier(this, "font", [value]) },
  fontSize(this: ViewNode, value: Length) { return applyModifier(this, "fontSize", [value]) },
  bold(this: ViewNode, isActive = true) { return applyModifier(this, "bold", [isActive]) },
  fontWeight(this: ViewNode, value: unknown) { return applyModifier(this, "fontWeight", [value]) },
  fontDesign(this: ViewNode, value: unknown) { return applyModifier(this, "fontDesign", [value]) },
  fontWidth(this: ViewNode, value: unknown) { return applyModifier(this, "fontWidth", [value]) },
  italic(this: ViewNode, isActive = true) { return applyModifier(this, "italic", [isActive]) },
  underline(this: ViewNode, isActive = true, pattern = "solid", color: string | null = null) { return applyModifier(this, "underline", [isActive, pattern, color]) },
  strikethrough(this: ViewNode, isActive = true, pattern = "solid", color: string | null = null) { return applyModifier(this, "strikethrough", [isActive, pattern, color]) },
  monospaced(this: ViewNode, isActive = true) { return applyModifier(this, "monospaced", [isActive]) },
  monospacedDigit(this: ViewNode) { return applyModifier(this, "monospacedDigit", []) },
  kerning(this: ViewNode, value: number) { return applyModifier(this, "kerning", [value]) },
  tracking(this: ViewNode, value: number) { return applyModifier(this, "tracking", [value]) },
  baselineOffset(this: ViewNode, value: number) { return applyModifier(this, "baselineOffset", [value]) },
  lineSpacing(this: ViewNode, value: number) { return applyModifier(this, "lineSpacing", [value]) },
  lineLimit(this: ViewNode, value: number | null, reservesSpace = false) { return applyModifier(this, "lineLimit", [value, reservesSpace]) },
  minimumScaleFactor(this: ViewNode, value: number) { return applyModifier(this, "minimumScaleFactor", [value]) },
  multilineTextAlignment(this: ViewNode, value: unknown) { return applyModifier(this, "multilineTextAlignment", [value]) },
  truncationMode(this: ViewNode, value: unknown) { return applyModifier(this, "truncationMode", [value]) },
  textCase(this: ViewNode, value: unknown) { return applyModifier(this, "textCase", [value]) },
  allowsTightening(this: ViewNode, value: boolean) { return applyModifier(this, "allowsTightening", [value]) },
  foreground(this: ViewNode, value: ShapeStyle) { return applyModifier(this, "foreground", [shapeStyleCss(value)]) },
  foregroundStyle(this: ViewNode, primary: ShapeStyle, secondary?: ShapeStyle, tertiary?: ShapeStyle) { return applyModifier(this, "foregroundStyle", [shapeStyleCss(primary), secondary === undefined ? undefined : shapeStyleCss(secondary), tertiary === undefined ? undefined : shapeStyleCss(tertiary)]) },
  background(this: ViewNode, valueOrAlignment: unknown, contentOrAlignment: unknown = "center") {
    if (typeof contentOrAlignment === "function") return applyModifier(this, "background", [(contentOrAlignment as () => unknown)(), valueOrAlignment])
    const value = valueOrAlignment instanceof Color || valueOrAlignment instanceof LinearGradient
      ? shapeStyleCss(valueOrAlignment)
      : valueOrAlignment
    return applyModifier(this, "background", [value, contentOrAlignment])
  },

  overlay(this: ViewNode, value: unknown, alignment = "center") {
    return applyModifier(this, "overlay", [typeof value === "function" ? (value as () => unknown)() : value, alignment])
  },
  opacity(this: ViewNode, value: number) { return applyModifier(this, "opacity", [value]) },
  aspectRatio(this: ViewNode, ratio: unknown, contentMode: unknown) { return applyModifier(this, "aspectRatio", [ratio, contentMode]) },
  scaledToFit(this: ViewNode) { return applyModifier(this, "scaledToFit", []) },
  scaledToFill(this: ViewNode) { return applyModifier(this, "scaledToFill", []) },
  fixedSize(this: ViewNode, horizontal = true, vertical = true) { return applyModifier(this, "fixedSize", [horizontal, vertical]) },
  layoutPriority(this: ViewNode, value: number) { return applyModifier(this, "layoutPriority", [value]) },
  position(this: ViewNode, valueOrX: unknown, y?: number) { return applyModifier(this, "position", typeof valueOrX === "number" ? [valueOrX, y ?? 0] : [valueOrX]) },
  zIndex(this: ViewNode, value: number) { return applyModifier(this, "zIndex", [value]) },
  ignoresSafeArea(this: ViewNode, regions = "all", edges: unknown = "all", alignment?: unknown) { return applyModifier(this, "ignoresSafeArea", [regions, edges, alignment]) },
  safeAreaPadding(this: ViewNode, valueOrEdges: unknown = "all", length?: Length) { return applyModifier(this, "safeAreaPadding", arguments.length >= 2 ? [valueOrEdges, length] : [valueOrEdges]) },
  gridCellColumns(this: ViewNode, count: number) { return applyModifier(this, "gridCellColumns", [count]) },
  gridCellUnsizedAxes(this: ViewNode, axes: unknown) { return applyModifier(this, "gridCellUnsizedAxes", [axes]) },
  gridCellAnchor(this: ViewNode, anchor: unknown) { return applyModifier(this, "gridCellAnchor", [anchor]) },
  gridColumnAlignment(this: ViewNode, alignment: unknown) { return applyModifier(this, "gridColumnAlignment", [alignment]) },
  scaleEffect(this: ViewNode, value: ScaleEffectValue, anchor = "center") { return applyModifier(this, "scaleEffect", [value, anchor]) },
  rotationEffect(this: ViewNode, value: number, anchor = "center") { return applyModifier(this, "rotationEffect", [value, anchor]) },
  rotation3DEffect(this: ViewNode, angle: number, axis: unknown, anchor = "center", anchorZ = 0, perspective = 1) { return applyModifier(this, "rotation3DEffect", [angle, axis, anchor, anchorZ, perspective]) },
  transformEffect(this: ViewNode, transform: unknown) { return applyModifier(this, "transformEffect", [transform]) },
  projectionEffect(this: ViewNode, transform: unknown) { return applyModifier(this, "projectionEffect", [transform]) },
  offset(this: ViewNode, valueOrX: OffsetValue | number, y?: number) {
    return applyModifier(this, "offset", typeof valueOrX === "number" ? [valueOrX, y ?? 0] : [valueOrX])
  },
  mask(this: ViewNode, value: ViewNode | string, alignment = "center") { return applyModifier(this, "mask", [value, alignment]) },
  clipShape(this: ViewNode, value: ViewNode | string, style?: unknown) { return applyModifier(this, "clipShape", [value, style]) },
  clipped(this: ViewNode, antialiased = false) { return applyModifier(this, "clipped", [antialiased]) },
  border(this: ViewNode, style: string, width: Length = 1) { return applyModifier(this, "border", [style, width]) },
  shadow(this: ViewNode, color: string | undefined, radius: number, x = 0, y = 0) { return applyModifier(this, "shadow", [color ?? "rgba(0, 0, 0, 0.33)", radius, x, y]) },
  blur(this: ViewNode, radius: number, opaque = false) { return applyModifier(this, "blur", [radius, opaque]) },
  brightness(this: ViewNode, value: number) { return applyModifier(this, "brightness", [value]) },
  contrast(this: ViewNode, value: number) { return applyModifier(this, "contrast", [value]) },
  saturation(this: ViewNode, value: number) { return applyModifier(this, "saturation", [value]) },
  grayscale(this: ViewNode, value: number) { return applyModifier(this, "grayscale", [value]) },
  hueRotation(this: ViewNode, value: number) { return applyModifier(this, "hueRotation", [value]) },
  colorInvert(this: ViewNode) { return applyModifier(this, "colorInvert", []) },
  colorMultiply(this: ViewNode, value: string) { return applyModifier(this, "colorMultiply", [value]) },
  blendMode(this: ViewNode, value: unknown) { return applyModifier(this, "blendMode", [value]) },
  compositingGroup(this: ViewNode) { return applyModifier(this, "compositingGroup", []) },
  drawingGroup(this: ViewNode, opaque = false, colorMode = "nonLinear") { return applyModifier(this, "drawingGroup", [opaque, colorMode]) },
  luminanceToAlpha(this: ViewNode) { return applyModifier(this, "luminanceToAlpha", []) },
  tint(this: ViewNode, value: string | null) { return applyModifier(this, "tint", [value]) },
  backgroundStyle(this: ViewNode, value: string) { return applyModifier(this, "backgroundStyle", [value]) },
  dynamicTypeSize(this: ViewNode, value: string) { return applyModifier(this, "dynamicTypeSize", [value]) },
  disabled(this: ViewNode, value: boolean) { return applyModifier(this, "disabled", [value]) },
  hidden(this: ViewNode) { return applyModifier(this, "hidden", []) },
  allowsHitTesting(this: ViewNode, value: boolean) { return applyModifier(this, "allowsHitTesting", [value]) },
  onTapGesture(this: ViewNode, countOrAction: number | undefined | (() => void), action?: () => void) {
    return applyModifier(this, "onTapGesture", typeof countOrAction === "function" ? [1, countOrAction] : [countOrAction ?? 1, action])
  },
  onLongPressGesture(this: ViewNode, minimumDuration: number | undefined, maximumDistance: number | undefined, action: () => void, onPressingChanged?: (pressing: boolean) => void) {
    return applyModifier(this, "onLongPressGesture", [minimumDuration ?? 0.5, maximumDistance ?? 10, action, onPressingChanged])
  },
  onHover(this: ViewNode, action: (hovering: boolean) => void) { return applyModifier(this, "onHover", [action]) },
  onSubmit(this: ViewNode, action: () => void) { return applyModifier(this, "onSubmit", [action]) },
  focusable(this: ViewNode, isFocusable = true, onFocusChange?: (focused: boolean) => void) { return applyModifier(this, "focusable", [isFocusable, onFocusChange]) },
  id(this: ViewNode, value: string | number) { return applyModifier(this, "id", [value]) },
  preferredColorScheme(this: ViewNode, value: unknown) { return applyModifier(this, "preferredColorScheme", [value]) },
  controlSize(this: ViewNode, value: string) { return applyModifier(this, "controlSize", [value]) },
  buttonStyle(this: ViewNode, value: string) { return applyModifier(this, "buttonStyle", [value]) },
  toggleStyle(this: ViewNode, value: string) { return applyModifier(this, "toggleStyle", [value]) },
  pickerStyle(this: ViewNode, value: string) { return applyModifier(this, "pickerStyle", [value]) },
  textFieldStyle(this: ViewNode, value: string) { return applyModifier(this, "textFieldStyle", [value]) },
  textEditorStyle(this: ViewNode, value: string) { return applyModifier(this, "textEditorStyle", [value]) },
  listStyle(this: ViewNode, value: string) { return applyModifier(this, "listStyle", [value]) },
  labelStyle(this: ViewNode, value: string) { return applyModifier(this, "labelStyle", [value]) },
  progressViewStyle(this: ViewNode, value: string) { return applyModifier(this, "progressViewStyle", [value]) },
  scrollDisabled(this: ViewNode, value: boolean) { return applyModifier(this, "scrollDisabled", [value]) },
  scrollIndicators(this: ViewNode, value: unknown, axes: unknown = "all") { return applyModifier(this, "scrollIndicators", [value, axes]) },
  scrollBounceBehavior(this: ViewNode, value: string, axes: unknown = "all") { return applyModifier(this, "scrollBounceBehavior", [value, axes]) },
  scrollClipDisabled(this: ViewNode, value = true) { return applyModifier(this, "scrollClipDisabled", [value]) },
  scrollDismissesKeyboard(this: ViewNode, value: string) { return applyModifier(this, "scrollDismissesKeyboard", [value]) },
  listRowInsets(this: ViewNode, valueOrEdges: unknown, length?: Length) { return applyModifier(this, "listRowInsets", arguments.length >= 2 ? [valueOrEdges, length] : [valueOrEdges]) },
  listRowBackground(this: ViewNode, value: unknown) { return applyModifier(this, "listRowBackground", [typeof value === "function" ? (value as () => unknown)() : value]) },
  listRowSeparator(this: ViewNode, value: unknown, edges = "all") { return applyModifier(this, "listRowSeparator", [value, edges]) },
  listSectionSeparator(this: ViewNode, value: unknown, edges = "all") { return applyModifier(this, "listSectionSeparator", [value, edges]) },
  symbolRenderingMode(this: ViewNode, value: unknown) { return applyModifier(this, "symbolRenderingMode", [value]) },
  symbolVariant(this: ViewNode, value: unknown) { return applyModifier(this, "symbolVariant", [value]) },
  draggable(this: ViewNode, payload: unknown) { return applyModifier(this, "draggable", [payload]) },
  dropDestination(this: ViewNode, payloadType: unknown, action: unknown, isTargeted?: unknown) { return applyModifier(this, "dropDestination", [payloadType, action, isTargeted]) },
  accessibilityLabel(this: ViewNode, value: string) { return applyModifier(this, "accessibilityLabel", [value]) },
  accessibilityHint(this: ViewNode, value: string) { return applyModifier(this, "accessibilityHint", [value]) },
  accessibilityValue(this: ViewNode, value: string) { return applyModifier(this, "accessibilityValue", [value]) },
  accessibilityHidden(this: ViewNode, value: boolean) { return applyModifier(this, "accessibilityHidden", [value]) },
  accessibilityIdentifier(this: ViewNode, value: string) { return applyModifier(this, "accessibilityIdentifier", [value]) },
  accessibilityHeading(this: ViewNode, value = "h2") { return applyModifier(this, "accessibilityHeading", [value]) },
  accessibilitySortPriority(this: ViewNode, value: number) { return applyModifier(this, "accessibilitySortPriority", [value]) },
  accessibilityElement(this: ViewNode, children = "ignore") { return applyModifier(this, "accessibilityElement", [children]) },
  accessibilityAction(this: ViewNode, kind: string, action: () => void) { return applyModifier(this, "accessibilityAction", [kind, action]) },
  animation(this: ViewNode, animation?: Animation | null, value?: unknown) {
    if (arguments.length === 0) return applyModifier(this, "animation", [])
    if (arguments.length === 1) return applyModifier(this, "animation", [animation ?? null])
    return applyModifier(this, "animation", [animation ?? null, value])
  },
  transition(this: ViewNode, transition: Transition) { return applyModifier(this, "transition", [transition]) },
  contentTransition(this: ViewNode, transition: ContentTransition) { return applyModifier(this, "contentTransition", [transition]) },
  style(this: ViewNode, value: MunStyleProperties) { return applyModifier(this, "style", [value]) },
  className(this: ViewNode, value: ClassValue) { return applyModifier(this, "className", [value]) },
  withProps(this: ViewNode, value: Record<string, unknown>) { return applyModifier(this, "withProps", [value]) },
  keyed(this: ViewNode, value: string | number) { return applyModifier(this, "keyed", [value]) },
  elementRef(this: ViewNode, value: unknown) { return applyModifier(this, "elementRef", [value]) },
  continuousCorners(this: ViewNode, smoothing = APPLE_CONTINUOUS_CORNER_SMOOTHING) { return applyModifier(this, "continuousCorners", [smoothing]) },
}) as Modifiers)

/** Add the shared immutable modifier surface to a graph node. */
export function decorate(node: ViewNode, owned = false): ModifiableViewNode {
  if (!owned) {
    const existing = decoratedNodes.get(node)
    if (existing) return existing
    try {
      // Intrinsic Views may return an already-decorated graph node. Reusing
      // that node is both semantically correct and critical for lazy graph
      // nodes whose enumerable compatibility accessors must not be copied.
      if (Object.getPrototypeOf(node) === modifierPrototype) return node as ModifiableViewNode
    } catch {
      // Reflection-hostile values fall through to the existing defensive path.
    }
  }
  // Internal graph constructors hand us a fresh object that cannot have been
  // decorated before. Mark it in place and return it directly: caching the
  // same frozen object as both key and value only adds two WeakMap writes per
  // transient node (notably every row in a large Element/ForEach tree).
  if (owned && Object.isExtensible(node)) {
    Object.setPrototypeOf(node, modifierPrototype)
    return Object.freeze(node) as ModifiableViewNode
  }
  const existing = decoratedNodes.get(node)
  if (existing) return existing
  const result = Object.assign(Object.create(modifierPrototype), node) as ModifiableViewNode
  const frozen = Object.freeze(result)
  decoratedNodes.set(node, frozen)
  if (frozen !== node) decoratedNodes.set(frozen, frozen)
  return frozen
}

function materializeModifiedContent(content: ViewNode, normalizedIncoming: readonly ViewModifierNode[]): ModifiableViewNode {
  if (normalizedIncoming.length === 0) return decorate(content)
  const normalizedModifiers = Object.freeze(content.kind === "modified"
    ? [...content.modifiers, ...normalizedIncoming]
    : [...normalizedIncoming])
  const finalModifier = normalizedModifiers[normalizedModifiers.length - 1]
  return decorate({
    kind: "modified" as const,
    content: content.kind === "modified" ? content.content : content,
    modifiers: normalizedModifiers,
    modifier: finalModifier,
    name: finalModifier.name,
    arguments: finalModifier.arguments,
  }, true)
}

export function modifiedContent(content: ViewNode, modifier: ViewModifierNode | readonly ViewModifierNode[]): ModifiableViewNode {
  const incoming = arrayCheck(modifier) === true ? snapshotArrayValues(modifier as readonly ViewModifierNode[]) : [modifier]
  const normalizedIncoming = incoming.flatMap(item => {
    const snapshot = snapshotModifierNode(item)
    return snapshot ? [snapshot] : []
  })
  return materializeModifiedContent(content, normalizedIncoming)
}

/**
 * Trusted compiler fast path for a statically-known modifier chain. The input
 * uses compact tuples and skips descriptor discovery/shape validation while
 * retaining argument snapshot semantics for mutable records and style values.
 */
export function modifiedContentCompiled(
  content: ViewNode,
  modifiers: readonly (readonly [name: string, arguments: readonly unknown[]])[],
): ModifiableViewNode {
  const normalizedIncoming = modifiers.map(([name, arguments_]) => {
    const normalizedArguments = Object.freeze(arguments_.map(item => snapshotModifierArgument(name, item)))
    const mask = name === "mask" ? maskStyle(normalizedArguments[0]) : name === "clipShape" ? clipShapeStyle(normalizedArguments[0]) : {}
    return Object.freeze({
      name,
      arguments: normalizedArguments,
      ...(Object.keys(mask).length > 0 ? { props: Object.freeze({ style: Object.freeze(mask) }) } : {}),
    }) as ViewModifierNode
  })
  return materializeModifiedContent(content, normalizedIncoming)
}

/** Apply a named modifier without coupling the graph to a renderer. */
export function modifier(content: ViewNode, name: string, ...arguments_: readonly unknown[]): ModifiableViewNode {
  return modifiedContent(content, { name, arguments: arguments_ })
}

export function modifierGraphOf(value: ViewNode): readonly ViewModifierNode[] {
  return value.kind === "modified" ? value.modifiers : []
}

/** Internal keyed wrapper used by collection builders. It preserves the same
 * modifier graph shape without installing the public modifier prototype on
 * every transient row node. */
export function keyedContent(content: ViewNode, key: string | number): ViewNode {
  const keyed = Object.freeze({
    name: "keyed",
    arguments: Object.freeze([key]),
  }) as ViewModifierNode
  const modifiers = Object.freeze(content.kind === "modified"
    ? [...content.modifiers, keyed]
    : [keyed])
  return Object.freeze({
    kind: "modified" as const,
    content: content.kind === "modified" ? content.content : content,
    modifiers,
    modifier: keyed,
    name: keyed.name,
    arguments: keyed.arguments,
  })
}
