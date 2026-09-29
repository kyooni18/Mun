import {
  ViewBuilder,
  defineBuiltinView,
  geometryView,
  initializer,
  initializerKinds,
  isViewNode,
  lazyView,
  resolveBuilderInput,
  type NamedArguments,
  type ViewValue,
  type ViewBuilderClosure,
  type ModifiableViewNode,
  type ViewBuilderContent,
  type TypedViewConstructor,
  viewElement,
  viewFragment,
} from "./graph.js"
import { compiledCollectionPlanOf, keyedCollectionChildKey, keyedCollectionView } from "./graph/nodes.js"
import { viewElementOwned } from "./graph/element-internal.js"
import type { MunCustomElementAttributes, MunHtmlAttributes, MunHtmlTagName } from "./html.js"
import { layoutLength } from "./layout.js"
import { requireOptionRecord, snapshotOptionRecord } from "./options.js"
import { Binding, isBinding, isStateRef, type BindingRef, type StateRef } from "./state.js"
import { snapshotStateArrayForSubscription } from "./state-internal.js"
import type { GeometryProxy } from "./graph.js"
import { arrayCheck, snapshotDataArrayValues } from "./graph/arrays.js"
import { keyedContent } from "./graph/modifiers.js"

export interface VStackOptions {
  readonly alignment?: "leading" | "center" | "trailing" | "stretch"
  readonly spacing?: number | string
}

export interface HStackOptions {
  readonly alignment?: "top" | "center" | "bottom" | "stretch"
  readonly spacing?: number | string
}

export interface LazyOptions {
  readonly estimatedItemSize?: number | string
  readonly overscan?: number
}

export interface LazyVStackOptions extends VStackOptions, LazyOptions {}
export interface LazyHStackOptions extends HStackOptions, LazyOptions {}

export interface ZStackOptions {
  readonly alignment?: "center" | "leading" | "trailing" | "top" | "bottom" | "topLeading" | "topTrailing" | "bottomLeading" | "bottomTrailing"
}

const textValue = initializerKinds.value(true, "value", undefined, "string | number")
const stackContent = initializerKinds.viewBuilder(true, "content")
const genericStackContent = initializerKinds.viewBuilder(true, "content", "Content")

interface TextProps { readonly value: string | number }

interface TextCall { (value: string | number): ReturnType<typeof viewElement> }

export const Text = defineBuiltinView<TextProps>(
  "Text",
  [initializer(
    "Text(value)",
    args => args.length === 1 && (typeof args[0] === "string" || typeof args[0] === "number"),
    args => ({ value: args[0] as string | number }),
    [textValue],
  )],
  ({ value }) => viewElement("span", null, [value]),
) as TypedViewConstructor<TextProps, TextCall>

function stackChildren(value: unknown): ViewValue[] {
  return ViewBuilder.buildBlock(value as ViewValue)
}

function stackInitializers(name: string, optionsParameter: ReturnType<typeof initializerKinds.value>, optionKeys: readonly string[]) {
  const variadicOptions = initializerKinds.value(true, optionsParameter.label, optionsParameter.properties, optionsParameter.type, true)
  return [
    initializer(
      "@ViewBuilder content",
      args => args.length === 1 && typeof args[0] === "function",
      args => ({ content: resolveBuilderInput(args[0]) }),
      [genericStackContent],
    ),
    initializer(
      "options, @ViewBuilder content",
      args => args.length === 2 && snapshotOptionRecord(args[0], optionKeys) !== undefined && typeof args[1] === "function",
      args => ({
        ...(args[0] === undefined ? {} : { options: requireOptionRecord(args[0], optionKeys, name) }),
        content: resolveBuilderInput(args[1]),
      }),
      [optionsParameter, genericStackContent],
    ),
    initializer(
      "options, ...children",
      args => args.length >= 1 && snapshotOptionRecord(args[0], optionKeys) !== undefined && args.slice(1).every(value => typeof value !== "function"),
      args => ({ options: requireOptionRecord(args[0], optionKeys, name), content: args.slice(1).flatMap(stackChildren) }),
      [variadicOptions],
    ),
    initializer(
      "...children",
      args => args.every(value => typeof value !== "function"),
      args => ({ content: args.flatMap(stackChildren) }),
    ),
  ]
}

export interface VStackProps { readonly options?: VStackOptions; readonly content: ViewValue[] }
export interface StackCall<Options> {
  (content: ViewBuilderClosure): ReturnType<typeof viewElement>
  (options: Options, content: ViewBuilderClosure): ReturnType<typeof viewElement>
  (options: Options, ...children: ViewBuilderContent[]): ReturnType<typeof viewElement>
  (...children: ViewBuilderContent[]): ReturnType<typeof viewElement>
}

export const VStack = defineBuiltinView<VStackProps>(
  "VStack",
  stackInitializers("VStack", initializerKinds.value(false, "options", ["alignment", "spacing"], "object"), ["alignment", "spacing"]),
  ({ options = {}, content }) => viewElement("div", {
    "data-mun": "VStack",
    style: {
      display: "flex",
      flexDirection: "column",
      width: "100%",
      boxSizing: "border-box",
      alignItems: options.alignment === "leading" ? "flex-start" : options.alignment === "trailing" ? "flex-end" : options.alignment === "stretch" ? "stretch" : "center",
      gap: layoutLength(options.spacing),
    },
  }, content),
  "Content: View",
) as TypedViewConstructor<VStackProps, StackCall<VStackOptions>>

export interface HStackProps { readonly options?: HStackOptions; readonly content: ViewValue[] }
export const HStack = defineBuiltinView<HStackProps>(
  "HStack",
  stackInitializers("HStack", initializerKinds.value(false, "options", ["alignment", "spacing"], "object"), ["alignment", "spacing"]),
  ({ options = {}, content }) => viewElement("div", {
    "data-mun": "HStack",
    style: {
      display: "flex",
      flexDirection: "row",
      width: "100%",
      boxSizing: "border-box",
      justifyContent: "center",
      alignItems: options.alignment === "top" ? "flex-start" : options.alignment === "bottom" ? "flex-end" : options.alignment === "stretch" ? "stretch" : "center",
      gap: layoutLength(options.spacing),
    },
  }, content),
  "Content: View",
) as TypedViewConstructor<HStackProps, StackCall<HStackOptions>>

export interface ZStackProps { readonly options?: ZStackOptions; readonly content: ViewValue[] }
const zStackOptions = initializerKinds.value(false, "options", ["alignment"], "object")
const zStackVariadicOptions = initializerKinds.value(true, "options", ["alignment"], "object", true)
function zStackPlaceItems(alignment: ZStackOptions["alignment"]): string {
  switch (alignment) {
    case "leading": return "center start"
    case "trailing": return "center end"
    case "top": return "start center"
    case "bottom": return "end center"
    case "topLeading": return "start start"
    case "topTrailing": return "start end"
    case "bottomLeading": return "end start"
    case "bottomTrailing": return "end end"
    default: return "center"
  }
}

export const ZStack = defineBuiltinView<ZStackProps>(
  "ZStack",
  [
    initializer("@ViewBuilder content", args => args.length === 1 && typeof args[0] === "function", args => ({ content: resolveBuilderInput(args[0]) }), [genericStackContent]),
    initializer("options, @ViewBuilder content", args => args.length === 2 && snapshotOptionRecord(args[0], ["alignment"]) !== undefined && typeof args[1] === "function", args => ({ ...(args[0] === undefined ? {} : { options: requireOptionRecord(args[0], ["alignment"], "ZStack") }), content: resolveBuilderInput(args[1]) }), [zStackOptions, genericStackContent]),
    initializer("options, ...children", args => args.length >= 1 && snapshotOptionRecord(args[0], ["alignment"]) !== undefined && args.slice(1).every(value => typeof value !== "function"), args => ({ options: requireOptionRecord(args[0], ["alignment"], "ZStack"), content: args.slice(1).flatMap(stackChildren) }), [zStackVariadicOptions]),
    initializer("...children", args => args.every(value => typeof value !== "function"), args => ({ content: args.flatMap(stackChildren) })),
  ],
  ({ options = {}, content }) => viewElement("div", {
    "data-mun": "ZStack",
    style: {
      display: "grid",
      width: "100%",
      boxSizing: "border-box",
      placeItems: zStackPlaceItems(options.alignment),
    },
  }, content),
  "Content: View",
) as TypedViewConstructor<ZStackProps, StackCall<ZStackOptions>>

export type ScrollAxis = "vertical" | "horizontal" | "both"

const scrollContent = initializerKinds.viewBuilder(true, "content")
const scrollAxisType = '"vertical" | "horizontal" | "both"'
const scrollAxis = initializerKinds.value(false, "axis", undefined, scrollAxisType)
const scrollAxes = new Set<ScrollAxis>(["vertical", "horizontal", "both"])

function isScrollAxis(value: unknown): value is ScrollAxis {
  return typeof value === "string" && scrollAxes.has(value as ScrollAxis)
}

export interface ScrollViewProps { readonly axis?: ScrollAxis; readonly content: ViewValue[] }
export interface ScrollViewCall {
  (content: ViewBuilderClosure): ReturnType<typeof viewElement>
  (axis: ScrollAxis, content: ViewBuilderClosure): ReturnType<typeof viewElement>
  (content: ViewBuilderContent, axis?: ScrollAxis): ReturnType<typeof viewElement>
}
export const ScrollView = defineBuiltinView<ScrollViewProps>(
  "ScrollView",
  [
    initializer(
      "ScrollView(@ViewBuilder content)",
      args => args.length === 1 && typeof args[0] === "function",
      args => ({ content: resolveBuilderInput(args[0]) }),
      [scrollContent],
    ),
    initializer(
      "ScrollView(axis, @ViewBuilder content)",
      args => args.length === 2 && isScrollAxis(args[0]) && typeof args[1] === "function",
      args => ({ axis: args[0] as ScrollAxis, content: resolveBuilderInput(args[1]) }),
      [initializerKinds.value(true, "axis", undefined, scrollAxisType), scrollContent],
    ),
    initializer(
      "ScrollView(content, axis?)",
      args => args.length >= 1 && args.length <= 2 && typeof args[0] !== "function" && (args[1] === undefined || isScrollAxis(args[1])),
      args => ({ content: stackChildren(args[0] as ViewValue), axis: args[1] as ScrollAxis | undefined }),
      [initializerKinds.value(true, "content"), scrollAxis],
    ),
  ],
  ({ axis = "vertical", content }) => viewElement("div", {
    "data-mun": "ScrollView",
    style: {
      overflowX: axis === "horizontal" || axis === "both" ? "auto" : "hidden",
      overflowY: axis === "vertical" || axis === "both" ? "auto" : "hidden",
      WebkitOverflowScrolling: "touch",
    },
  }, content),
) as TypedViewConstructor<ScrollViewProps, ScrollViewCall>

export type SafeAreaEdge = "top" | "right" | "bottom" | "left" | "all"

const safeAreaEdges = new Set<SafeAreaEdge>(["top", "right", "bottom", "left", "all"])

function snapshotSafeAreaEdges(value: unknown): SafeAreaEdge | readonly SafeAreaEdge[] | undefined {
  if (typeof value === "string") return safeAreaEdges.has(value as SafeAreaEdge) ? value as SafeAreaEdge : undefined
  if (arrayCheck(value) !== true) return undefined
  const values = value as readonly unknown[]
  try {
    const length = Object.getOwnPropertyDescriptor(values, "length")
    if (!length || !("value" in length) || typeof length.value !== "number") return undefined
    const snapshot: SafeAreaEdge[] = []
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(values, String(index))
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || !safeAreaEdges.has(descriptor.value as SafeAreaEdge)) return undefined
      snapshot.push(descriptor.value as SafeAreaEdge)
    }
    return Object.freeze(snapshot)
  } catch {
    return undefined
  }
}

function requireSafeAreaEdges(value: unknown): SafeAreaEdge | readonly SafeAreaEdge[] {
  const snapshot = snapshotSafeAreaEdges(value)
  if (snapshot === undefined) throw new TypeError("SafeArea edges must be a data-only edge or edge array")
  return snapshot
}

function hasSafeAreaEdge(edges: SafeAreaEdge | readonly SafeAreaEdge[], edge: Exclude<SafeAreaEdge, "all">): boolean {
  return edges === "all" || (arrayCheck(edges) === true ? (edges as readonly SafeAreaEdge[]).includes("all") || (edges as readonly SafeAreaEdge[]).includes(edge) : edges === edge)
}

const safeAreaContent = initializerKinds.viewBuilder(true, "content")

export interface SafeAreaProps { readonly edges?: SafeAreaEdge | readonly SafeAreaEdge[]; readonly content: ViewValue[] }
export interface SafeAreaCall {
  (content: ViewBuilderClosure): ReturnType<typeof viewElement>
  (edges: SafeAreaEdge | readonly SafeAreaEdge[], content: ViewBuilderClosure): ReturnType<typeof viewElement>
}
export const SafeArea = defineBuiltinView<SafeAreaProps>(
  "SafeArea",
  [
    initializer(
      "SafeArea(@ViewBuilder content)",
      args => args.length === 1 && typeof args[0] === "function",
      args => ({ content: resolveBuilderInput(args[0]) }),
      [safeAreaContent],
    ),
    initializer(
      "SafeArea(edges, @ViewBuilder content)",
      args => args.length === 2 && snapshotSafeAreaEdges(args[0]) !== undefined && typeof args[1] === "function",
      args => ({ edges: requireSafeAreaEdges(args[0]), content: resolveBuilderInput(args[1]) }),
      [initializerKinds.value(true, "edges"), safeAreaContent],
    ),
  ],
  ({ edges = "all", content }) => viewElement("div", {
    "data-mun": "SafeArea",
    style: {
      paddingTop: hasSafeAreaEdge(edges, "top") ? "env(safe-area-inset-top)" : undefined,
      paddingRight: hasSafeAreaEdge(edges, "right") ? "env(safe-area-inset-right)" : undefined,
      paddingBottom: hasSafeAreaEdge(edges, "bottom") ? "env(safe-area-inset-bottom)" : undefined,
      paddingLeft: hasSafeAreaEdge(edges, "left") ? "env(safe-area-inset-left)" : undefined,
      boxSizing: "border-box",
    },
  }, content),
) as TypedViewConstructor<SafeAreaProps, SafeAreaCall>

export interface GeometryReaderProps { readonly content: (geometry: GeometryProxy) => ViewValue }
export interface GeometryReaderCall { (content: (geometry: GeometryProxy) => ViewBuilderContent): ReturnType<typeof viewElement> }
export const GeometryReader = defineBuiltinView<GeometryReaderProps>(
  "GeometryReader",
  [initializer(
    "GeometryReader(@ViewBuilder content)",
    args => args.length === 1 && typeof args[0] === "function",
    args => ({ content: args[0] as (geometry: GeometryProxy) => ViewValue }),
    [initializerKinds.viewBuilder(true, "content")],
  )],
  ({ content }) => geometryView(content),
) as TypedViewConstructor<GeometryReaderProps, GeometryReaderCall>

export interface SpacerProps { readonly minLength?: number | string }
export interface SpacerCall { (minLength?: number | string): ReturnType<typeof viewElement> }
export const Spacer = defineBuiltinView<SpacerProps>(
  "Spacer",
  [initializer("Spacer(minLength?)", args => args.length <= 1 && typeof args[0] !== "function", args => ({ minLength: args[0] as number | string | undefined }), [initializerKinds.value(false, "minLength")])],
  ({ minLength }) => viewElement("div", { "data-mun": "Spacer", style: { flexGrow: 1, flexShrink: 0, flexBasis: layoutLength(minLength) } }),
) as TypedViewConstructor<SpacerProps, SpacerCall>

export const Divider = defineBuiltinView("Divider", [initializer("Divider()", args => args.length === 0)], () => viewElement("hr", { "data-mun": "Divider" }))

export const Group = defineBuiltinView<{ content: ViewValue[] }>(
  "Group",
  [
    initializer("@ViewBuilder content", args => args.length === 1 && typeof args[0] === "function", args => ({ content: resolveBuilderInput(args[0]) }), [stackContent]),
    initializer("...children", args => args.every(value => typeof value !== "function"), args => ({ content: args.flatMap(stackChildren) })),
  ],
  ({ content }) => viewFragment(content),
)

/** Construct typed raw HTML without involving a renderer or a component allow-list. */
export function Element<Tag extends MunHtmlTagName>(tag: Tag, props?: MunHtmlAttributes<Tag> | null, ...children: ViewValue[]): ReturnType<typeof viewElement>
export function Element<Tag extends `${string}-${string}`>(tag: Tag, props?: MunCustomElementAttributes<Tag> | null, ...children: ViewValue[]): ReturnType<typeof viewElement>
export function Element(tag: string, props: object | null = null, ...children: ViewValue[]): ReturnType<typeof viewElement> {
  return viewElementOwned(tag, props as Record<string, unknown> | null, children)
}

interface ButtonProps {
  readonly label: ViewValue[]
  readonly action: () => unknown
}

type ButtonAction = () => unknown
interface ButtonCustomLabelArguments {
  readonly action: ButtonAction
  readonly label: ViewBuilderClosure
}

interface ButtonCall {
  (title: string | number, action: ButtonAction): ReturnType<typeof viewElement>
  (configuration: NamedArguments<ButtonCustomLabelArguments>): ReturnType<typeof viewElement>
}

const titleParameter = initializerKinds.value(true, undefined, undefined, "string | number", false, "title")
const trailingActionParameter = initializerKinds.action(true, undefined, "function", true, "action")
const labeledActionParameter = initializerKinds.action(true, "action", "function", false, "action")
const labeledLabelParameter = initializerKinds.viewBuilder(true, "label", undefined, false, "label")

export const Button = defineBuiltinView<ButtonProps>(
  "Button",
  [
    initializer(
      "Button(_ title: string | number, @Action action)",
      args => args.length === 2 && (typeof args[0] === "string" || typeof args[0] === "number") && typeof args[1] === "function",
      args => ({ label: [Text(args[0] as string | number)], action: args[1] as () => unknown }),
      [titleParameter, trailingActionParameter],
    ),
    initializer(
      "Button(@Action action, @ViewBuilder label)",
      args => args.length === 2 && typeof args[0] === "function" && typeof args[1] === "function",
      args => ({ action: args[0] as () => unknown, label: resolveBuilderInput(args[1]) }),
      [
        { ...labeledActionParameter, labelRequired: true },
        { ...labeledLabelParameter, labelRequired: true },
      ],
    ),
  ],
  ({ label, action }) => viewElement("button", { type: "button", onClick: action }, label),
) as TypedViewConstructor<ButtonProps, ButtonCall>

type CollectionKey = string | number
type CollectionKeySelector<Item> = (item: Item, index: number) => CollectionKey
type InferredCollectionKey = CollectionKey | boolean | bigint | null | undefined

const noPrimitiveCollectionKey = Symbol("noPrimitiveCollectionKey")
const noOwnDataProperty = Symbol("noOwnDataProperty")

const warnedForEachIdentity = new Set<string>()
// Duplicate-key warnings interpolate runtime values, so the dedup set would
// otherwise grow without bound on adversarial or churning collections.
const maximumWarnedForEachIdentities = 256

function warnForEachIdentity(message: string): void {
  if (warnedForEachIdentity.has(message)) return
  if (warnedForEachIdentity.size >= maximumWarnedForEachIdentities) warnedForEachIdentity.clear()
  warnedForEachIdentity.add(message)
  const runtime = globalThis as unknown as { readonly console?: { readonly warn?: (message: string) => void } }
  runtime.console?.warn?.(`[Mün] ${message}`)
}

function deterministicIdentityPart(value: unknown, seen = new Set<object>(), depth = 0): string | undefined {
  if (depth > 8) return undefined
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeof value === "string") return `string:${JSON.stringify(value)}`
  if (typeof value === "number") return `number:${Number.isNaN(value) ? "NaN" : Object.is(value, -0) ? "-0" : String(value)}`
  if (typeof value === "boolean") return `boolean:${String(value)}`
  if (typeof value === "bigint") return `bigint:${String(value)}`
  if (typeof value === "symbol") return undefined
  if (typeof value === "function") return undefined
  if (seen.has(value)) return undefined
  seen.add(value)
  try {
    if (arrayCheck(value) === true) {
      const items = value as readonly unknown[]
      const length = Object.getOwnPropertyDescriptor(items, "length")
      if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) return undefined
      const values: Array<string | undefined> = []
      for (let index = 0; index < length.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(items, String(index))
        if (descriptor && !("value" in descriptor)) return undefined
        values.push(descriptor ? deterministicIdentityPart(descriptor.value, seen, depth + 1) : "hole")
      }
      return values.some(item => item === undefined) ? undefined : `array:[${values.join(",")}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== null && prototype !== Object.prototype) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const entries = Object.keys(descriptors).filter(key => descriptors[key].enumerable).sort().map(key => {
      const descriptor = descriptors[key]
      if (!("value" in descriptor)) return undefined
      const item = deterministicIdentityPart(descriptor.value, seen, depth + 1)
      return item === undefined ? undefined : `${JSON.stringify(key)}=${item}`
    })
    return entries.some(item => item === undefined) ? undefined : `object:{${entries.join(",")}}`
  } catch {
    return undefined
  } finally {
    seen.delete(value)
  }
}

// Frozen records with only primitive enumerable fields cannot change between
// renders. Keep their structural identity string so ForEach does not repeat
// descriptor traversal for every unchanged frame; mutable objects continue to
// use the exact uncached path above.
const primitiveIdentityCache = new WeakMap<object, string>()

function cacheablePrimitiveIdentity(value: object): boolean {
  try {
    if (!Object.isFrozen(value)) return false
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) return false
      const item = descriptor.value
      if (item !== null && typeof item === "object") return false
      if (typeof item === "function" || typeof item === "symbol") return false
    }
    return true
  } catch {
    return false
  }
}

function primitiveCollectionKey(value: unknown): InferredCollectionKey | typeof noPrimitiveCollectionKey {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || value === null || value === undefined) return value
  return noPrimitiveCollectionKey
}

function explicitCollectionKey(value: unknown): CollectionKey | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined
}

function ownDataProperty(value: object, key: PropertyKey): unknown | typeof noOwnDataProperty {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor ? descriptor.value : noOwnDataProperty
  } catch {
    return noOwnDataProperty
  }
}

function collectionKey<Item>(item: Item, index: number, selector?: CollectionKeySelector<Item>): InferredCollectionKey {
  const selected = selector ? selector(item, index) : undefined
  const selectedKey = typeof selected === "string" || typeof selected === "number" ? selected : undefined
  if (selector && selectedKey !== undefined) return selectedKey
  if (selector) warnForEachIdentity("ForEach key selector must return a stable string or number; falling back to inferred identity.")
  const primitive = primitiveCollectionKey(item)
  if (primitive !== noPrimitiveCollectionKey) return primitive
  if (item && typeof item === "object") {
    const id = ownDataProperty(item, "id")
    const key = ownDataProperty(item, "key")
    const explicit = explicitCollectionKey(id === noOwnDataProperty ? undefined : id)
      ?? explicitCollectionKey(key === noOwnDataProperty ? undefined : key)
    if (explicit !== undefined) return explicit
    const cached = primitiveIdentityCache.get(item)
    const deterministic = cached ?? deterministicIdentityPart(item)
    if (cached === undefined && deterministic !== undefined && cacheablePrimitiveIdentity(item)) {
      primitiveIdentityCache.set(item, deterministic)
    }
    if (deterministic !== undefined) {
      warnForEachIdentity("ForEach item has no id/key; inferred identity is value-based and cannot distinguish equal duplicate objects.")
      return `object:${deterministic}`
    }
  }
  warnForEachIdentity("ForEach item has no stable identity. Provide key: item => item.id (or another stable primitive key).")
  return `unstable:${typeof item}:${index}`
}

function encodedCollectionKey(key: InferredCollectionKey): string {
  const value = typeof key === "number" && Object.is(key, -0) ? "-0" : String(key)
  const type = key === null ? "null" : typeof key
  return `${type}:${value.length}:${value}`
}

function appendKeyedCollectionChildren(children: ViewValue[], value: ViewValue, key: string): void {
  if (isViewNode(value)) {
    children.push(keyedContent(value, keyedCollectionChildKey(key, 0)))
    return
  }
  const built = ViewBuilder.buildBlock(value)
  for (let index = 0; index < built.length; index += 1) {
    const child = built[index]
    children.push(isViewNode(child) ? keyedContent(child, keyedCollectionChildKey(key, index)) : child)
  }
}

function snapshotCollectionItems(value: unknown): readonly unknown[] | undefined {
  return snapshotDataArrayValues(value)
}

function requireCollectionItems(value: unknown): readonly unknown[] {
  const snapshot = snapshotStateArrayForSubscription(value) ?? snapshotCollectionItems(value)
  if (snapshot === undefined) throw new TypeError("ForEach items must be a data-only array")
  return snapshot
}

const emptyCollectionItems = Object.freeze([]) as readonly unknown[]

interface ForEachProps<Item> {
  readonly items: readonly Item[] | StateRef<readonly Item[]>
  readonly key?: CollectionKeySelector<Item>
  readonly content: (item: Item, index: number) => ViewValue
}

interface ForEachCall {
  <Item>(items: readonly Item[] | StateRef<readonly Item[]>, content: (item: Item, index: number) => ViewValue): ModifiableViewNode
  <Item>(items: readonly Item[] | StateRef<readonly Item[]>, key: CollectionKeySelector<Item>, content: (item: Item, index: number) => ViewValue): ModifiableViewNode
  <Item>(items: readonly Item[] | StateRef<readonly Item[]>, options: NamedArguments<{ readonly key: CollectionKeySelector<Item> }>, content: (item: Item, index: number) => ViewValue): ModifiableViewNode
}

const ForEachType = defineBuiltinView<ForEachProps<unknown>>(
  "ForEach",
  [
    initializer(
      "ForEach(items, @ViewBuilder content)",
      args => args.length === 2 && typeof args[1] === "function",
      args => ({ items: args[0] as readonly unknown[] | StateRef<readonly unknown[]>, content: args[1] as (item: unknown, index: number) => ViewValue }),
      [initializerKinds.value(true, "items", undefined, "array"), initializerKinds.viewBuilder(true, "content", "(item: Item, index: number) => View")],
    ),
    initializer(
      "ForEach(items, key: (item) => string | number, @ViewBuilder content)",
      args => args.length === 3 && typeof args[1] === "function" && typeof args[2] === "function",
      args => ({ items: args[0] as readonly unknown[] | StateRef<readonly unknown[]>, key: args[1] as CollectionKeySelector<unknown>, content: args[2] as (item: unknown, index: number) => ViewValue }),
      [
        initializerKinds.value(true, "items", undefined, "array"),
        initializerKinds.value(false, "key", undefined, "function", false, "key"),
        initializerKinds.viewBuilder(true, "content", "(item: Item, index: number) => View"),
      ],
    ),
  ],
  ({ items, key, content }) => {
    const stateSource = isStateRef(items) ? items as StateRef<readonly unknown[]> : undefined
    const source = stateSource ?? items
    const collection = stateSource ? emptyCollectionItems : requireCollectionItems(items)
    const compiled = compiledCollectionPlanOf(content)
    const selector = (compiled?.evaluateKey ?? key) as CollectionKeySelector<unknown> | undefined
    return keyedCollectionView(
      collection,
      source,
      (item, index) => {
        const rawKey = collectionKey(item, index, selector)
        return { identity: encodedCollectionKey(rawKey), display: String(rawKey) }
      },
      (item, index, entryKey) => {
        const children: ViewValue[] = []
        appendKeyedCollectionChildren(children, content(item, index), entryKey)
        return children.length === 1 ? children[0] : viewFragment(children)
      },
      {
        indexIndependent: false,
        compiled,
        ...(stateSource ? { readItems: () => requireCollectionItems(stateSource.value) } : {}),
        onDuplicateKey: display => warnForEachIdentity(`ForEach contains duplicate key "${display}"; state identity is ambiguous.`),
      },
    )
  },
  "Item",
)

/** A keyed collection View that also accepts a State-backed collection directly. */
export const ForEach = ForEachType as unknown as ForEachCall & typeof ForEachType

export const Section = defineBuiltinView<{ title?: string; content: ViewValue[] }>(
  "Section",
  [
    initializer("@ViewBuilder content", args => args.length === 1 && typeof args[0] === "function", args => ({ content: resolveBuilderInput(args[0]) }), [stackContent]),
    initializer("title, @ViewBuilder content", args => args.length === 2 && typeof args[0] === "string" && typeof args[1] === "function", args => ({ title: args[0] as string, content: resolveBuilderInput(args[1]) }), [initializerKinds.value(true, "title", undefined, "string"), stackContent]),
  ],
  ({ title, content }) => viewElement("section", { "data-mun": "Section" }, [
    ...(title === undefined ? [] : [Text(title)]),
    ...content,
  ]),
)

export const List = defineBuiltinView<{ content: ViewValue[] }>(
  "List",
  [
    initializer("@ViewBuilder content", args => args.length === 1 && typeof args[0] === "function", args => ({ content: resolveBuilderInput(args[0]) }), [stackContent]),
    initializer("...children", args => args.every(value => typeof value !== "function"), args => ({ content: args.flatMap(stackChildren) })),
  ],
  ({ content }) => viewElement("ul", { "data-mun": "List", style: { listStyle: "none", padding: 0, margin: 0 } }, content),
)

function lazyStyle(options: LazyOptions): Record<string, string | undefined> {
  const estimated = layoutLength(normalizedLazyEstimate(options.estimatedItemSize)) ?? "44px"
  return { contentVisibility: "auto", containIntrinsicSize: `auto ${estimated}` }
}

function normalizedLazyEstimate(value: number | string | undefined): number | string | undefined {
  return typeof value === "number" ? Number.isFinite(value) && value > 0 ? value : undefined : value
}

function normalizedLazyOverscan(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function lazyData(options: LazyOptions, axis: "vertical" | "horizontal"): Record<string, unknown> {
  return {
    "data-mun-lazy": axis,
    "data-mun-lazy-estimate": normalizedLazyEstimate(options.estimatedItemSize),
    "data-mun-lazy-overscan": normalizedLazyOverscan(options.overscan),
    style: lazyStyle(options),
  }
}

export interface LazyVStackProps { readonly options?: LazyVStackOptions; readonly content: ViewValue[] }
export interface LazyHStackProps { readonly options?: LazyHStackOptions; readonly content: ViewValue[] }

export const LazyVStack = defineBuiltinView<LazyVStackProps>(
  "LazyVStack",
  stackInitializers("LazyVStack", initializerKinds.value(false, "options", ["alignment", "spacing", "estimatedItemSize", "overscan"], "object"), ["alignment", "spacing", "estimatedItemSize", "overscan"]),
  ({ options = {}, content }) => lazyView("LazyVStack", "vertical", {
    "data-mun": "LazyVStack",
    ...lazyData(options, "vertical"),
    style: {
      display: "flex",
      flexDirection: "column",
      width: "100%",
      boxSizing: "border-box",
      alignItems: options.alignment === "leading" ? "flex-start" : options.alignment === "trailing" ? "flex-end" : options.alignment === "stretch" ? "stretch" : "center",
      gap: layoutLength(options.spacing),
      ...lazyStyle(options),
    },
  }, content),
  "Content: View",
) as TypedViewConstructor<LazyVStackProps, StackCall<LazyVStackOptions>>

export const LazyHStack = defineBuiltinView<LazyHStackProps>(
  "LazyHStack",
  stackInitializers("LazyHStack", initializerKinds.value(false, "options", ["alignment", "spacing", "estimatedItemSize", "overscan"], "object"), ["alignment", "spacing", "estimatedItemSize", "overscan"]),
  ({ options = {}, content }) => lazyView("LazyHStack", "horizontal", {
    "data-mun": "LazyHStack",
    ...lazyData(options, "horizontal"),
    style: {
      display: "flex",
      flexDirection: "row",
      width: "100%",
      boxSizing: "border-box",
      alignItems: options.alignment === "top" ? "flex-start" : options.alignment === "bottom" ? "flex-end" : options.alignment === "stretch" ? "stretch" : "center",
      gap: layoutLength(options.spacing),
      ...lazyStyle(options),
    },
  }, content),
  "Content: View",
) as TypedViewConstructor<LazyHStackProps, StackCall<LazyHStackOptions>>

export function BindingValue<T>(state: StateRef<T> | BindingRef<T>): BindingRef<T> {
  if (isBinding(state)) return state
  if (isStateRef(state)) return Binding(state)
  return state as BindingRef<T>
}
