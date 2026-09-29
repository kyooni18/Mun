import { munForeignComponent } from "./symbols.js"
import { arrayCheck, snapshotArrayValues } from "./arrays.js"
import { decorate, modifiedContent, snapshotRecord } from "./modifiers.js"
import { snapshotElementProps } from "./element-internal.js"
import { collectStateReads, isStateRef, type StateRef } from "../state.js"
import type {
  CompiledTemplateDescriptor,
  CompiledTemplateValue,
  CompiledPatchLocation,
  CompiledCollectionPlan,
  CompiledViewBodyPlan,
  ForeignComponentDescriptor,
  ForeignComponentOptions,
  GeometryProxy,
  GPUIslandGraphIR,
  GPUIslandViewNode,
  GPUIslandViewOptions,
  LazyViewNode,
  ModifiableViewNode,
  ViewGraphChild,
  KeyedCollectionEntry,
  KeyedCollectionViewNode,
  ViewGraphValue,
  ViewHostNode,
  ViewModifierNode,
  ViewNode,
} from "./types.js"

function mergeSnapshotRecords(...records: readonly Record<string, unknown>[]): Record<string, unknown> {
  const descriptors = new Map<PropertyKey, PropertyDescriptor>()
  for (const record of records) {
    for (const key of Reflect.ownKeys(record)) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key)
      if (descriptor && "value" in descriptor) descriptors.set(key, descriptor)
    }
  }
  const merged: Record<PropertyKey, unknown> = {}
  for (const [key, descriptor] of descriptors) {
    Object.defineProperty(merged, key, { ...descriptor, configurable: true })
  }
  return merged as Record<string, unknown>
}

function snapshotForeignSchema(schema: NonNullable<ForeignComponentOptions["schema"]>): NonNullable<ForeignComponentDescriptor["schema"]> {
  const snapshot = mergeSnapshotRecords(schema as unknown as Record<string, unknown>)
  for (const key of ["props", "events", "slots"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(snapshot, key)
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "object" || descriptor.value === null) continue
    Object.defineProperty(snapshot, key, { ...descriptor, configurable: true, value: snapshotRecord(descriptor.value) })
  }
  return Object.freeze(snapshot)
}

function ownDataValue(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

export function viewElement(type: unknown, props: Record<string, unknown> | null = null, children: readonly ViewGraphChild[] = []): ModifiableViewNode {
  const normalizedProps = props === null ? null : snapshotElementProps(type, props)
  return decorate({ kind: "element" as const, type, props: normalizedProps, children: snapshotArrayValues(children) as readonly ViewGraphChild[] }, true)
}

/** Construct a renderer-neutral foreign component boundary. */
export function ForeignComponent(
  component: unknown,
  options: ForeignComponentOptions = {},
  ...children: ViewGraphChild[]
): ModifiableViewNode {
  const normalizedOptions = snapshotRecord(options) as ForeignComponentOptions
  const props = snapshotRecord(normalizedOptions.props ?? {}, true) as Record<string, unknown>
  const events = snapshotRecord(normalizedOptions.events ?? {}) as Record<string, unknown>
  const slots = snapshotRecord(normalizedOptions.slots ?? {}) as NonNullable<ForeignComponentOptions["slots"]>
  const componentName = ownDataValue(component, "name")
  const descriptor: ForeignComponentDescriptor = Object.freeze({
    [munForeignComponent]: true,
    component,
    props,
    events,
    slots,
    ...(normalizedOptions.ref === undefined ? {} : { ref: normalizedOptions.ref }),
    ...(normalizedOptions.key === undefined ? {} : { key: normalizedOptions.key }),
    ...(normalizedOptions.adapter === undefined ? {} : { adapter: normalizedOptions.adapter }),
    ...(normalizedOptions.schema === undefined ? {} : { schema: snapshotForeignSchema(normalizedOptions.schema) }),
    name: typeof normalizedOptions.name === "string" && normalizedOptions.name
      ? normalizedOptions.name
      : typeof componentName === "string" && componentName ? componentName : "ForeignComponent",
  })
  return viewElement(descriptor, mergeSnapshotRecords(
    descriptor.props,
    descriptor.events,
    descriptor.ref === undefined ? {} : { ref: descriptor.ref },
  ), children)
}

export function isForeignComponent(value: unknown): value is ForeignComponentDescriptor {
  if (typeof value !== "object" || value === null) return false
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, munForeignComponent)
    return !!descriptor && "value" in descriptor && descriptor.value === true
  } catch {
    return false
  }
}


function snapshotCompiledTemplateValue(
  value: CompiledTemplateValue,
  slotCount: number,
  slotIdentities: Array<readonly (string | number)[] | undefined>,
): CompiledTemplateValue {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean" || typeof value === "bigint") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (typeof value !== "object") throw new TypeError("Compiled template values must be static primitives, host elements, fragments, or slots")
  if (value.kind === "slot") {
    if (!Number.isSafeInteger(value.index) || value.index < 0 || value.index >= slotCount) throw new RangeError(`Compiled template slot ${String(value.index)} is outside 0..<${slotCount}`)
    if (slotIdentities[value.index] !== undefined) throw new RangeError(`Compiled template slot ${value.index} appears more than once`)
    const identity = Object.freeze([...value.identity])
    slotIdentities[value.index] = identity
    return Object.freeze({ kind: "slot" as const, index: value.index, identity })
  }
  if (value.kind === "fragment") {
    return Object.freeze({ kind: "fragment" as const, children: Object.freeze(value.children.map(child => snapshotCompiledTemplateValue(child, slotCount, slotIdentities))) })
  }
  if (value.kind === "element") {
    if (typeof value.type !== "string" || value.type.length === 0) throw new TypeError("Compiled templates only contain renderer-native host element names")
    return Object.freeze({
      kind: "element" as const,
      type: value.type,
      props: value.props === null ? null : snapshotRecord(value.props, true) as Record<string, unknown>,
      children: Object.freeze(value.children.map(child => snapshotCompiledTemplateValue(child, slotCount, slotIdentities))),
    })
  }
  throw new TypeError("Unknown compiled template instruction")
}

/** Freeze, validate, and index a renderer-neutral AOT template once at module evaluation. */
export function defineCompiledTemplate(
  root: CompiledTemplateValue,
  slotCount: number,
  slotKinds: readonly ("view" | "text")[] = Array(slotCount).fill("view"),
  patchLocations: readonly CompiledPatchLocation[] = [],
): CompiledTemplateDescriptor {
  if (!Number.isSafeInteger(slotCount) || slotCount < 0) throw new RangeError("Compiled template slotCount must be a non-negative safe integer")
  if (slotKinds.length !== slotCount) throw new RangeError(`Compiled template expected ${slotCount} slot kinds but received ${slotKinds.length}`)
  if (slotKinds.some(kind => kind !== "view" && kind !== "text")) throw new TypeError("Compiled template slot kinds must be 'view' or 'text'")
  const slotIdentities: Array<readonly (string | number)[] | undefined> = Array(slotCount).fill(undefined)
  const snapshot = snapshotCompiledTemplateValue(root, slotCount, slotIdentities)
  const missing = slotIdentities.findIndex(identity => identity === undefined)
  if (missing >= 0) throw new RangeError(`Compiled template slot ${missing} is declared but never referenced`)
  const patchIR = patchLocations.length > 0 ? Object.freeze({
    version: 1 as const,
    locations: Object.freeze(patchLocations.map(location => {
      if (!Number.isSafeInteger(location.node) || location.node < 0) throw new RangeError("Compiled patch node must be a non-negative safe integer")
      if (location.kind === "child-range" && (!Number.isSafeInteger(location.endNode) || location.endNode < 0 || location.endNode === location.node)) {
        throw new RangeError("Compiled child-range patch requires distinct non-negative safe node indices")
      }
      if ((location.kind === "attribute" || location.kind === "property" || location.kind === "style") && (!location.key || /^on/iu.test(location.key))) {
        throw new TypeError(`Unsafe compiled ${location.kind} patch key`)
      }
      if (location.kind === "property" && ["__proto__", "constructor", "innerHTML", "outerHTML", "prototype", "textContent"].includes(location.key)) {
        throw new TypeError("Unsafe compiled property patch key")
      }
      return Object.freeze({ ...location })
    })),
    dirtyWordCount: Math.ceil(patchLocations.length / 32),
  }) : undefined
  return Object.freeze({
    root: snapshot,
    slotCount,
    slotIdentities: Object.freeze(slotIdentities as readonly (readonly (string | number)[])[]),
    slotKinds: Object.freeze([...slotKinds]),
    ...(patchIR ? { patchIR } : {}),
  })
}

/** Instantiate an immutable compiler template with only the dynamic graph/value slots allocated per evaluation. */
export function compiledTemplate(template: CompiledTemplateDescriptor, slots: readonly ViewGraphValue[] = []): ModifiableViewNode {
  if (slots.length !== template.slotCount) throw new RangeError(`Compiled template expected ${template.slotCount} slots but received ${slots.length}`)
  return decorate({ kind: "template" as const, template, slots: snapshotArrayValues(slots) as readonly ViewGraphValue[] }, true)
}

const compiledCollectionPlans = new WeakMap<Function, CompiledCollectionPlan>()

/**
 * Attach a compiler-generated pure row executor while preserving the original
 * closure as fallback. `evaluate`/`evaluateKey` are row-local compiler output;
 * renderers may skip them for items proven unchanged by mutation metadata.
 */
export function compiledCollectionContent<Content extends (...arguments_: any[]) => ViewGraphValue>(
  content: Content,
  plan: CompiledCollectionPlan,
): Content {
  if (typeof content !== "function") throw new TypeError("Compiled collection content must be a function")
  if (plan?.kind !== "flat-text-host" || typeof plan.evaluate !== "function") {
    throw new TypeError("Unknown compiled collection execution plan")
  }
  compiledCollectionPlans.set(content, Object.freeze({
    kind: "flat-text-host",
    indexIndependent: plan.indexIndependent === true,
    ...(typeof plan.evaluateKey === "function" ? { evaluateKey: plan.evaluateKey } : {}),
    ...(typeof plan.hostType === "string" ? { hostType: plan.hostType } : {}),
    ...(Object.prototype.hasOwnProperty.call(plan, "staticProps") ? { staticProps: plan.staticProps ?? null } : {}),
    ...(typeof plan.evaluateProps === "function" ? { evaluateProps: plan.evaluateProps } : {}),
    ...(typeof plan.evaluateText === "function" ? { evaluateText: plan.evaluateText } : {}),
    evaluate: plan.evaluate,
  }))
  return content
}

export function compiledCollectionPlanOf(content: Function): CompiledCollectionPlan | undefined {
  return compiledCollectionPlans.get(content)
}

export function keyedCollectionChildKey(entryKey: string, index: number): string {
  return `${entryKey}|child:${index}`
}

/** Persistent identity for one occurrence of a possibly duplicated base key. */
export function keyedCollectionEntryKey(baseKey: string, occurrence: number): string {
  return `${baseKey}|occurrence:${occurrence}`
}

export function keyedCollectionEntries(node: KeyedCollectionViewNode, itemSnapshot?: readonly unknown[]): readonly KeyedCollectionEntry[] {
  const items = itemSnapshot ?? node.readItems?.() ?? node.items
  const occurrences = new Map<string, number>()
  const entries = new Array<KeyedCollectionEntry>(items.length)
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const resolved = node.key(item, index)
    if (!resolved || typeof resolved.identity !== "string" || typeof resolved.display !== "string") {
      throw new TypeError("Keyed collection identity must contain string identity and display values")
    }
    const occurrence = occurrences.get(resolved.identity) ?? 0
    occurrences.set(resolved.identity, occurrence + 1)
    if (occurrence > 0) node.onDuplicateKey?.(resolved.display, occurrence)
    entries[index] = {
      key: keyedCollectionEntryKey(resolved.identity, occurrence),
      baseKey: resolved.identity,
      displayKey: resolved.display,
      occurrence,
      item,
      index,
    }
  }
  return Object.freeze(entries)
}

function materializeKeyedCollectionChildren(node: KeyedCollectionViewNode): readonly ViewGraphChild[] {
  const children: ViewGraphChild[] = []
  for (const entry of keyedCollectionEntries(node)) {
    const value = node.content(entry.item, entry.index, entry.key)
    if (isViewNode(value) && value.kind === "fragment") children.push(...value.children)
    else if (arrayCheck(value) === true) children.push(...(snapshotArrayValues(value as readonly ViewGraphChild[]) as readonly ViewGraphChild[]))
    else children.push(value as ViewGraphChild)
  }
  return Object.freeze(children)
}

/** Create a compact keyed collection whose rows stay unevaluated until rendering. */
export function keyedCollectionView(
  items: readonly unknown[],
  source: unknown,
  key: KeyedCollectionViewNode["key"],
  content: KeyedCollectionViewNode["content"],
  options: {
    readonly indexIndependent?: boolean
    readonly compiled?: CompiledCollectionPlan
    readonly readItems?: KeyedCollectionViewNode["readItems"]
    readonly onDuplicateKey?: KeyedCollectionViewNode["onDuplicateKey"]
  } = {},
): ModifiableViewNode {
  let materializedChildren: readonly ViewGraphChild[] | undefined
  const fallbackContent: KeyedCollectionViewNode["content"] = options.readItems && isStateRef(source)
    ? (item, index, entryKey) => {
        let reactiveItem = item
        try {
          const current = collectStateReads(() => source.value, () => undefined)
          if (Array.isArray(current) && index >= 0 && index < current.length) reactiveItem = current[index]
        } catch { /* revoked or hostile State values keep the descriptor snapshot fallback */ }
        return content(reactiveItem, index, entryKey)
      }
    : content
  const node = {
    kind: "collection" as const,
    items: snapshotArrayValues(items),
    source,
    key,
    content: fallbackContent,
    indexIndependent: options.indexIndependent === true,
    ...(options.compiled ? { compiled: options.compiled } : {}),
    ...(options.readItems ? { readItems: options.readItems } : {}),
    ...(options.onDuplicateKey ? { onDuplicateKey: options.onDuplicateKey } : {}),
  } as Omit<KeyedCollectionViewNode, "children"> & { readonly children: readonly ViewGraphChild[] }
  Object.defineProperty(node, "children", {
    enumerable: true,
    configurable: false,
    get() {
      return materializedChildren ??= materializeKeyedCollectionChildren(node)
    },
  })
  return decorate(node, true)
}

export function viewFragment(children: readonly ViewGraphChild[] = []): ModifiableViewNode {
  return decorate({ kind: "fragment" as const, children: snapshotArrayValues(children) as readonly ViewGraphChild[] }, true)
}

export function viewHost(
  name: string,
  host: unknown,
  props: Record<string, unknown>,
  render: (props: Record<string, unknown>) => ViewGraphValue,
  state?: (props: Record<string, unknown>) => Record<string, unknown>,
  dependencies?: (props: Record<string, unknown>) => readonly StateRef<unknown>[],
  dependenciesComplete = false,
  compiledBody?: CompiledViewBodyPlan<Record<string, unknown>>,
): ModifiableViewNode {
  const normalizedState = state
    ? (props: Record<string, unknown>): Record<string, unknown> => {
        const value = state(props)
        if (typeof value !== "object" || value === null || arrayCheck(value) !== false) return Object.freeze({})
        try {
          const prototype = Object.getPrototypeOf(value)
          if (prototype !== Object.prototype && prototype !== null) return Object.freeze({})
        } catch {
          return Object.freeze({})
        }
        return snapshotRecord(value) as Record<string, unknown>
      }
    : undefined
  return decorate({
    kind: "view" as const,
    name,
    host,
    props: snapshotRecord(props, true) as Record<string, unknown>,
    render,
    state: normalizedState,
    ...(dependencies ? { dependencies } : {}),
    ...(dependenciesComplete ? { dependenciesComplete: true } : {}),
    ...(compiledBody ? { compiledBody: Object.freeze({
      template: compiledBody.template,
      ...(compiledBody.patchesModifiers ? { patchesModifiers: true } : {}),
      ...(compiledBody.patchDependencyIndices ? { patchDependencyIndices: Object.freeze(Object.fromEntries(
        Object.entries(compiledBody.patchDependencyIndices).map(([key, indices]) => [key, Object.freeze([...indices])]),
      )) } : {}),
      ...(compiledBody.evaluatePatch ? { evaluatePatch: compiledBody.evaluatePatch } : {}),
      evaluate: compiledBody.evaluate,
    }) } : {}),
  }, true)
}

/** Create a renderer-neutral geometry observation boundary. */
export function geometryView(content: (geometry: GeometryProxy) => ViewGraphValue): ModifiableViewNode {
  return decorate({ kind: "geometry" as const, content }, true)
}

/** Create a lazy graph boundary. Renderers may window its children by range. */
export function lazyView(
  name: string,
  axis: LazyViewNode["axis"],
  props: Record<string, unknown>,
  children: readonly ViewGraphChild[] = [],
): ModifiableViewNode {
  return decorate({
    kind: "lazy" as const,
    name,
    axis,
    props: snapshotRecord(props, true) as Record<string, unknown>,
    children: snapshotArrayValues(children) as readonly ViewGraphChild[],
  }, true)
}

function positiveDimension(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer`)
  return value
}

/**
 * Internal compiler/runtime bridge for a strict compute-to-render GPU island.
 * The exact proof is rechecked here so hand-written graph values cannot turn a
 * CPU/object region into an implicit native backend.
 */
export function gpuIslandView(ir: GPUIslandGraphIR, options: GPUIslandViewOptions = {}): ModifiableViewNode {
  const residentBufferName = ir?.kind === "line-chart" ? "points" : "particles"
  const residentBuffer = ir?.buffers?.find(buffer => buffer.name === residentBufferName)
  if (!ir || ir.version !== 1 || (ir.kind !== "particle-field" && ir.kind !== "line-chart") || ir.typeProof !== "numeric-packed"
    || ir.inputResidency !== "gpu" || ir.outputResidency !== "gpu" || ir.readback !== "forbidden"
    || ir.materialization !== "renderer-owned" || ir.lifetime !== "frame-persistent"
    || ir.render?.target !== "gpu-canvas" || !Number.isSafeInteger(ir.render.vertexCount)
    || ir.render.vertexCount <= 0 || (ir.fallback !== "canvas" && ir.fallback !== "static")) {
    throw new TypeError("GPU Island graph nodes require compiler-proven gpu-to-gpu, no-readback IR")
  }
  if (!residentBuffer || residentBuffer.authority !== "gpu" || residentBuffer.cpuReadable !== false
    || !residentBuffer.usages.includes("storage") || !residentBuffer.usages.includes("vertex")
    || ir.compute.workgroupSize !== 64 || !ir.compute.writes.includes(residentBufferName)
    || !ir.render.reads.includes(residentBufferName) || ir.compute.dispatchCount !== Math.ceil(ir.render.vertexCount / 64)) {
    throw new TypeError("GPU Island graph nodes require one GPU-authoritative compute-to-render resident buffer")
  }
  if (ir.kind === "particle-field" && residentBuffer.stride !== 32) {
    throw new TypeError("ParticleField GPU Islands require the canonical 32-byte particle layout")
  }
  if (ir.kind === "line-chart" && (residentBuffer.stride !== 16 || ir.render.vertexCount < 2 || ir.render.topology !== "line-strip")) {
    throw new TypeError("LineChart GPU Islands require the canonical 16-byte point layout and line-strip renderer")
  }
  const width = positiveDimension(options.width, "GPU Island width")
  const height = positiveDimension(options.height, "GPU Island height")
  const expectedFloats = residentBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT
  if (options.initialData && (!(options.initialData instanceof Float32Array) || options.initialData.length !== expectedFloats)) {
    throw new RangeError(`GPU Island initialData must contain exactly ${expectedFloats} float values`)
  }
  const initialData = options.initialData ? new Float32Array(options.initialData) : undefined
  if (options.clearColor && (options.clearColor.length !== 4 || options.clearColor.some(channel => !Number.isFinite(channel)))) {
    throw new TypeError("GPU Island clearColor must contain four finite channels")
  }
  const clearColor = options.clearColor ? Object.freeze([...options.clearColor] as [number, number, number, number]) : undefined
  const style = options.style === undefined
    ? undefined
    : snapshotRecord(options.style as Record<string, unknown>, true) as Readonly<Record<string, unknown>>
  const node: GPUIslandViewNode = Object.freeze({
    kind: "gpu-island",
    ir,
    options: Object.freeze({
      ...(options.experimentalResidentCompute === true ? { experimentalResidentCompute: true } : {}),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(options.class === undefined ? {} : { class: options.class }),
      ...(style === undefined ? {} : { style }),
      ...(options.ariaLabel === undefined ? {} : { ariaLabel: options.ariaLabel }),
      ...(initialData === undefined ? {} : { initialData }),
      ...(clearColor === undefined ? {} : { clearColor }),
    }),
  })
  return decorate(node, true)
}

export function isViewNode(value: unknown): value is ViewNode {
  if (typeof value !== "object" || value === null) return false
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "kind")
    if (!descriptor || !("value" in descriptor)) return false
    const kind = descriptor.value
    return kind === "element" || kind === "fragment" || kind === "template" || kind === "collection" || kind === "view" || kind === "geometry" || kind === "lazy" || kind === "gpu-island" || kind === "modified"
  } catch {
    return false
  }
}
