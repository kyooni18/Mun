import { actionClosure } from "./closures.js"
import { currentTransaction, snapshotTransaction, Transaction } from "./animation.js"
import { isViewNode } from "./graph/nodes.js"
import { stateArraySubscriptionSnapshotSymbol } from "./state-internal.js"

declare const stateBrand: unique symbol
declare const bindingBrand: unique symbol

export interface StateRef<T> {
  value: T
  readonly [stateBrand]: true
}

export interface BindingRef<T> {
  value: T
  readonly [bindingBrand]: true
}
export type Value<T> = T | StateRef<T> | BindingRef<T> | (() => T)

export interface StateMutation {
  readonly kind: "replace" | "set" | "delete" | "define" | "array" | "invalidate"
  /** Raw reactive object that received the mutation, when one exists. */
  readonly target?: object
  readonly property?: PropertyKey
  readonly method?: string
  readonly previous?: unknown
  readonly value?: unknown
  readonly arguments?: readonly unknown[]
  /** Descriptor-validated replacement items captured while ownership was reconciled. */
  readonly snapshot?: readonly unknown[]
}

export interface StateMutationBatch {
  /** State version after this logical notification. */
  readonly version: number
  /** Mutations coalesced by the current State batch. */
  readonly mutations: readonly StateMutation[]
}

export type StateListener = (transaction: Transaction, batch: StateMutationBatch) => void
type Listener = StateListener

type OwnershipChange = "none" | "add" | "reconcile"

interface StateRecord<T> {
  current: T
  listeners: Set<Listener>
  version: number
  owners: Set<ReactiveOwner>
  /** Per-State hot-path cache from raw reactive objects to their stable proxy. */
  proxies: WeakMap<object, object>
  // Present only while the root value is proven to be an ordinary array whose
  // reactive indexed entries are shallow plain-object leaves. Keeping the
  // counts here lets replacement/pop detach one row without walking the rest
  // of the array. Absence deliberately means "fall back to graph reconcile".
  rootArrayRefs?: Map<object, number>
  /** Whether the tracked root array is a dense ordinary indexed array. */
  rootArrayDense?: boolean
  /** Descriptor-validated collection read waiting for its first subscription. */
  preparedRootArray?: {
    readonly raw: object
    readonly refs: Map<object, number>
    readonly dense: boolean
    readonly mutationClock: number
  }
  /** Compiler-built ownership metadata for an imminent immutable array replacement. */
  preparedRootArrayReplacement?: {
    readonly previousRaw: object
    readonly nextRaw: object
    readonly refs: Map<object, number>
    readonly snapshot: readonly unknown[]
    readonly mutationClock: number
    readonly localized?: {
      readonly index: number
      readonly previous: unknown
      readonly value: unknown
    }
  }
  transaction: Transaction
  batchDepth: number
  pendingNotification: boolean
  pendingReconcile: boolean
  pendingMutations: StateMutation[]
  observedMutationClock: number
}

interface ReactiveOwner {
  raw: object
  /** Single-owner rows avoid allocating a Set until sharing actually occurs. */
  primaryRecord?: StateRecord<unknown>
  records?: Set<StateRecord<unknown>>
  /** Row proxies are uncommon relative to owned rows, so allocate lazily. */
  proxies?: WeakMap<StateRecord<unknown>, object>
}

const records = new WeakMap<object, StateRecord<any>>()
const bindings = new WeakSet<object>()
const owners = new WeakMap<object, ReactiveOwner>()
/**
 * Active shallow-array States are usually far fewer than their rows. Keep the
 * inverse ownership relation at State granularity and discover row sharing
 * lazily only when a row is actually proxied/mutated. This avoids one WeakMap
 * insertion (and one owner allocation) per untouched collection row during
 * mount/hydration while preserving cross-State notifications.
 */
const shallowRootArrayRecords = new Set<StateRecord<unknown>>()
const proxyRaws = new WeakMap<object, object>()
const arraySubscriptionSnapshotSymbol = stateArraySubscriptionSnapshotSymbol()
const arrayMutators = new Map<PropertyKey, Function>([
  ["copyWithin", Array.prototype.copyWithin],
  ["fill", Array.prototype.fill],
  ["pop", Array.prototype.pop],
  ["push", Array.prototype.push],
  ["reverse", Array.prototype.reverse],
  ["shift", Array.prototype.shift],
  ["sort", Array.prototype.sort],
  ["splice", Array.prototype.splice],
  ["unshift", Array.prototype.unshift],
])
let activeCollector: ((state: StateRef<unknown>) => void) | null = null
// Nested mutations can happen while a renderer is between getSnapshot() and
// subscribe(). Owners are intentionally detached while a State has no live
// listeners, so retain a cheap global clock to conservatively detect that
// race without keeping every object graph strongly indexed at all times.
let reactiveMutationClock = 0

export function isStateRef(value: unknown): value is StateRef<unknown> {
  return typeof value === "object" && value !== null && records.has(value as object)
}

export function isBinding(value: unknown): value is BindingRef<unknown> {
  return typeof value === "object" && value !== null && bindings.has(value as object)
}

function reactiveContainer(value: unknown): value is object {
  if (typeof value !== "object" || value === null || records.has(value) || isViewNode(value)) return false
  try {
    if (Object.isFrozen(value)) return false
    if (owners.has(value)) return true
    if (Array.isArray(value)) return true
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function unwrap<T>(value: T): T {
  return typeof value === "object" && value !== null ? (proxyRaws.get(value as object) ?? value) as T : value
}

/** Stable raw identity used by fine-grained render executors and diagnostics. */
export function reactiveIdentity<T>(value: T): T {
  return unwrap(value)
}

/**
 * Compiler-only fast path for a proven-pure `state.value.map(...)` replacement.
 *
 * A subscribed dense shallow root array has already been descriptor-validated
 * by State ownership tracking. In that case the mapper can consume the raw
 * row values directly, avoiding thousands of transient row proxies before the
 * normal State setter performs ownership transfer. The compiler only emits
 * this helper for data-only mapper bodies; every other shape remains normal
 * JavaScript. Runtime uncertainty falls back to the ordinary proxy `.map`.
 */
export function mapStateArrayData<Item, Result>(
  state: StateRef<readonly Item[]>,
  mapper: (item: Item, index: number) => Result,
): Result[] {
  const record = records.get(state as object) as StateRecord<readonly Item[]> | undefined
  const fallback = (): Result[] => {
    const current = state.value as unknown as { map(callback: (item: Item, index: number) => Result): Result[] }
    const next = current.map(mapper)
    ;(state as unknown as StateRef<Result[]>).value = next
    return next
  }
  if (!record || record.listeners.size === 0 || record.rootArrayDense !== true || !record.rootArrayRefs) return fallback()
  const raw = unwrap(record.current)
  let length: number
  try {
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return fallback()
    length = raw.length
  } catch { return fallback() }

  const next = new Array<Result>(length)
  const snapshot = new Array<unknown>(length)
  const refs = new Map<object, number>()
  let preparable = true
  let localizedIndex = -1
  let localizedPrevious: unknown
  let localizedValue: unknown
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined
    try { descriptor = Object.getOwnPropertyDescriptor(raw, String(index)) } catch { return fallback() }
    if (!descriptor || !("value" in descriptor)) return fallback()
    const item = unwrap(descriptor.value)
    if (reactiveContainer(item) && !record.rootArrayRefs.has(item as object)) return fallback()
    const mapped = mapper(item as Item, index)
    next[index] = mapped
    snapshot[index] = mapped
    const mappedRaw = unwrap(mapped)
    if (!Object.is(item, mappedRaw)) {
      if (localizedIndex >= 0) localizedIndex = -2
      else if (localizedIndex !== -2) {
        localizedIndex = index
        localizedPrevious = item
        localizedValue = mappedRaw
      }
    }
    if (!preparable || !reactiveContainer(mappedRaw)) continue
    const count = refs.get(mappedRaw as object)
    if (count !== undefined) {
      refs.set(mappedRaw as object, count + 1)
      continue
    }
    if (!record.rootArrayRefs.has(mappedRaw as object) && !shallowReactiveRow(mappedRaw)) {
      preparable = false
      refs.clear()
      continue
    }
    refs.set(mappedRaw as object, 1)
  }
  if (preparable) {
    Object.freeze(snapshot)
    record.preparedRootArrayReplacement = {
      previousRaw: raw as object,
      nextRaw: next as object,
      refs,
      snapshot,
      mutationClock: reactiveMutationClock,
      ...(localizedIndex >= 0
        ? { localized: { index: localizedIndex, previous: localizedPrevious, value: localizedValue } }
        : {}),
    }
  }
  ;(state as unknown as StateRef<Result[]>).value = next
  return next
}

function ownerFor(raw: object): ReactiveOwner {
  const existing = owners.get(raw)
  if (existing) return existing
  const owner: ReactiveOwner = { raw }
  owners.set(raw, owner)
  return owner
}

function ownerHasRecord(owner: ReactiveOwner, record: StateRecord<unknown>): boolean {
  return owner.primaryRecord === record || owner.records?.has(record) === true
}

function addOwnerRecord(owner: ReactiveOwner, record: StateRecord<unknown>): void {
  if (owner.records) {
    owner.records.add(record)
    return
  }
  if (!owner.primaryRecord) {
    owner.primaryRecord = record
    return
  }
  if (owner.primaryRecord === record) return
  owner.records = new Set([owner.primaryRecord, record])
  owner.primaryRecord = undefined
}

function removeOwnerRecord(owner: ReactiveOwner, record: StateRecord<unknown>): void {
  if (!owner.records) {
    if (owner.primaryRecord === record) owner.primaryRecord = undefined
    return
  }
  owner.records.delete(record)
  if (owner.records.size === 1) {
    owner.primaryRecord = owner.records.values().next().value
    owner.records = undefined
  }
}

function ownerRecordSnapshot(owner: ReactiveOwner): StateRecord<unknown>[] {
  const result = owner.records ? [...owner.records] : owner.primaryRecord ? [owner.primaryRecord] : []
  for (const record of shallowRootArrayRecords) {
    if (!record.rootArrayRefs?.has(owner.raw) || ownerHasRecord(owner, record)) continue
    addOwnerRecord(owner, record)
    result.push(record)
  }
  return result
}

function forEachOwnerRecord(owner: ReactiveOwner, action: (record: StateRecord<unknown>) => void): void {
  if (owner.records) {
    for (const record of owner.records) action(record)
  } else if (owner.primaryRecord) {
    action(owner.primaryRecord)
  }
}

function snapshotMutation(mutation: StateMutation): StateMutation {
  const arguments_ = mutation.arguments
    ? Object.freeze(mutation.arguments.map(argument => unwrap(argument)))
    : undefined
  return Object.freeze({
    ...mutation,
    ...(mutation.previous === undefined ? {} : { previous: unwrap(mutation.previous) }),
    ...(mutation.value === undefined ? {} : { value: unwrap(mutation.value) }),
    ...(arguments_ ? { arguments: arguments_ } : {}),
  })
}

function dispatchNotification(record: StateRecord<unknown>): void {
  record.version += 1
  const mutations = Object.freeze(record.pendingMutations.splice(0))
  const batch: StateMutationBatch = Object.freeze({
    version: record.version,
    mutations: mutations.length > 0 ? mutations : Object.freeze([snapshotMutation({ kind: "invalidate" })]),
  })
  let failed = false
  let failure: unknown
  for (const listener of [...record.listeners]) {
    try { listener(record.transaction, batch) } catch (error) {
      if (!failed) { failed = true; failure = error }
    }
  }
  // A broken subscriber must not prevent sibling renderers from observing the
  // mutation. Preserve the caller-visible error after all listeners caught up.
  if (failed) throw failure
}

function notify(record: StateRecord<unknown>, mutation: StateMutation = { kind: "invalidate" }): void {
  record.transaction = snapshotTransaction(currentTransaction())
  record.pendingMutations.push(snapshotMutation(mutation))
  if (record.batchDepth > 0) {
    record.pendingNotification = true
    return
  }
  dispatchNotification(record)
}

function beginBatch(record: StateRecord<unknown>): void {
  record.batchDepth += 1
}

function endBatch(record: StateRecord<unknown>): void {
  if (record.batchDepth === 0) return
  record.batchDepth -= 1
  if (record.batchDepth > 0) return
  if (record.pendingReconcile) {
    record.pendingReconcile = false
    if (record.listeners.size > 0) reconcile(record)
  }
  if (record.pendingNotification) {
    record.pendingNotification = false
    dispatchNotification(record)
  }
}

function attach(record: StateRecord<unknown>, owner: ReactiveOwner): void {
  if (ownerHasRecord(owner, record)) return
  addOwnerRecord(owner, record)
  record.owners.add(owner)
}

function attachShallowLeaf(record: StateRecord<unknown>, raw: object): void {
  const owner = owners.get(raw)
  if (owner) {
    if (!ownerHasRecord(owner, record)) addOwnerRecord(owner, record)
  }
}

function setRootArrayFastPath(record: StateRecord<unknown>, refs: Map<object, number>, dense: boolean): void {
  record.rootArrayRefs = refs
  record.rootArrayDense = dense
  shallowRootArrayRecords.add(record)
}

function clearRootArrayFastPath(record: StateRecord<unknown>): void {
  record.rootArrayRefs = undefined
  record.rootArrayDense = undefined
  shallowRootArrayRecords.delete(record)
}

function attachGraph(record: StateRecord<unknown>, value: unknown): void {
  // State values can be produced from deeply nested JSON or document trees.
  // Walking ownership recursively makes subscription depth depend on the JS
  // call-stack limit (only a few thousand nodes in Node/browser engines). Keep
  // the same descriptor-only, cycle-safe traversal on an explicit stack.
  const visited = new Set<object>()
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const raw = unwrap(pending.pop())
    if (!reactiveContainer(raw) || visited.has(raw)) continue
    visited.add(raw)
    attach(record, ownerFor(raw))
    let properties: readonly PropertyKey[]
    try {
      properties = Reflect.ownKeys(raw)
    } catch {
      // Proxies are allowed as State values. If they intentionally block
      // reflection, keep the reachable container itself reactive instead of
      // making subscription fail merely because its children are opaque.
      continue
    }
    for (const property of properties) {
      let descriptor: PropertyDescriptor | undefined
      try { descriptor = Object.getOwnPropertyDescriptor(raw, property) } catch { continue }
      if (descriptor && "value" in descriptor) pending.push(descriptor.value)
    }
  }
}

function detach(record: StateRecord<unknown>): void {
  if (record.rootArrayRefs) {
    for (const raw of record.rootArrayRefs.keys()) {
      const owner = owners.get(raw)
      if (owner) removeOwnerRecord(owner, record)
    }
  }
  for (const owner of record.owners) removeOwnerRecord(owner, record)
  record.owners.clear()
  clearRootArrayFastPath(record)
}

function shallowReactiveRow(value: unknown): value is object {
  const raw = unwrap(value)
  if (!reactiveContainer(raw)) return false
  try {
    if (Array.isArray(raw)) return false
    const prototype = Object.getPrototypeOf(raw)
    if (prototype !== Object.prototype && prototype !== null) return false
  } catch {
    return false
  }
  let properties: readonly PropertyKey[]
  try { properties = Reflect.ownKeys(raw) } catch { return false }
  for (const property of properties) {
    let descriptor: PropertyDescriptor | undefined
    try { descriptor = Object.getOwnPropertyDescriptor(raw, property) } catch { return false }
    if (!descriptor) continue
    if (!("value" in descriptor)) return false
    if (reactiveContainer(unwrap(descriptor.value))) return false
  }
  return true
}

function arrayIndex(property: PropertyKey): number | undefined {
  if (typeof property !== "string" || property.length === 0) return undefined
  const index = Number(property)
  if (!Number.isInteger(index) || index < 0 || index >= 0xffff_ffff || String(index) !== property) return undefined
  return index
}

function attachShallowRootArray(record: StateRecord<unknown>, value: unknown): boolean {
  const raw = unwrap(value)
  try {
    if (!Array.isArray(raw) || !reactiveContainer(raw)) return false
    if (Object.getPrototypeOf(raw) !== Array.prototype) return false
  } catch {
    return false
  }

  const prepared = record.preparedRootArray
  if (prepared) {
    record.preparedRootArray = undefined
    if (prepared.raw === raw && prepared.mutationClock === reactiveMutationClock) {
      attach(record, ownerFor(raw))
      for (const row of prepared.refs.keys()) attachShallowLeaf(record, row)
      setRootArrayFastPath(record, prepared.refs, prepared.dense)
      return true
    }
  }

  let properties: readonly PropertyKey[]
  try { properties = Reflect.ownKeys(raw) } catch { return false }

  const refs = new Map<object, number>()
  const rows: object[] = []
  let indexedProperties = 0
  for (const property of properties) {
    if (property === "length") continue
    if (arrayIndex(property) === undefined) return false
    indexedProperties += 1
    let descriptor: PropertyDescriptor | undefined
    try { descriptor = Object.getOwnPropertyDescriptor(raw, property) } catch { return false }
    if (!descriptor || !("value" in descriptor)) return false
    const row = unwrap(descriptor.value)
    if (!reactiveContainer(row)) continue
    const count = refs.get(row)
    if (count !== undefined) {
      refs.set(row, count + 1)
      continue
    }
    if (!shallowReactiveRow(row)) return false
    refs.set(row, 1)
    rows.push(row)
  }

  attach(record, ownerFor(raw))
  for (const row of rows) attachShallowLeaf(record, row)
  setRootArrayFastPath(record, refs, indexedProperties === raw.length)
  return true
}

/**
 * Build the first renderer collection snapshot and shallow ownership metadata
 * in one descriptor walk. Plain arrays and already-subscribed State proxies
 * return undefined so callers can retain their ordinary snapshot path.
 */
function snapshotStateArrayForSubscription(record: StateRecord<unknown>, raw: object): readonly unknown[] | undefined {
  if (record.listeners.size > 0) return undefined
  let length: number
  try {
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(raw, "length")
    if (!descriptor || !("value" in descriptor) || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) return undefined
    length = descriptor.value
  } catch { return undefined }

  let properties: readonly PropertyKey[]
  try { properties = Reflect.ownKeys(raw) } catch { return undefined }
  const snapshot = new Array<unknown>(length)
  let indexedProperties = 0
  const refs = new Map<object, number>()
  let preparable = true
  for (const property of properties) {
    if (property === "length") continue
    const index = arrayIndex(property)
    if (index === undefined || index >= length) {
      preparable = false
      continue
    }
    let descriptor: PropertyDescriptor | undefined
    try { descriptor = Object.getOwnPropertyDescriptor(raw, property) } catch { return undefined }
    if (!descriptor) continue
    if (!("value" in descriptor)) return undefined
    snapshot[index] = descriptor.value
    indexedProperties += 1
    if (!preparable) continue
    const row = unwrap(descriptor.value)
    if (!reactiveContainer(row)) continue
    const count = refs.get(row)
    if (count !== undefined) {
      refs.set(row, count + 1)
      continue
    }
    if (!shallowReactiveRow(row)) {
      preparable = false
      refs.clear()
      continue
    }
    refs.set(row, 1)
  }
  Object.freeze(snapshot)
  if (preparable) {
    record.preparedRootArray = {
      raw,
      refs,
      dense: indexedProperties === length,
      mutationClock: reactiveMutationClock,
    }
  }
  return snapshot
}

interface ShallowArrayReplacementResult {
  readonly localized?: {
    readonly index: number
    readonly previous: unknown
    readonly value: unknown
  }
  readonly snapshot?: readonly unknown[]
}

function replaceShallowRootArrayOwnership(
  record: StateRecord<unknown>,
  previousValue: unknown,
  nextValue: unknown,
): ShallowArrayReplacementResult | undefined {
  const previousRefs = record.rootArrayRefs
  if (!previousRefs) return undefined
  const previousDense = record.rootArrayDense === true
  const previousRaw = unwrap(previousValue)
  const nextRaw = unwrap(nextValue)
  try {
    if (!Array.isArray(previousRaw) || !Array.isArray(nextRaw)) return undefined
    if (Object.getPrototypeOf(nextRaw) !== Array.prototype) return undefined
  } catch {
    return undefined
  }

  const prepared = record.preparedRootArrayReplacement
  record.preparedRootArrayReplacement = undefined
  if (prepared && prepared.previousRaw === previousRaw && prepared.nextRaw === nextRaw
    && prepared.mutationClock === reactiveMutationClock) {
    const nextRefs = prepared.refs
    const previousOwner = owners.get(previousRaw)
    if (previousOwner) {
      removeOwnerRecord(previousOwner, record)
      record.owners.delete(previousOwner)
    }
    attach(record, ownerFor(nextRaw))
    for (const row of previousRefs.keys()) {
      if (!nextRefs.has(row)) detachReactiveLeaf(record, row)
    }
    for (const row of nextRefs.keys()) {
      if (!previousRefs.has(row)) attachShallowLeaf(record, row)
    }
    setRootArrayFastPath(record, nextRefs, true)
    return {
      snapshot: prepared.snapshot,
      ...(prepared.localized ? { localized: prepared.localized } : {}),
    }
  }

  let properties: readonly PropertyKey[]
  try { properties = Reflect.ownKeys(nextRaw) } catch { return undefined }

  // Immutable list updates commonly clone one dense array and replace a
  // single row. Preserve the existing ownership-count map in that case rather
  // than allocating and rebuilding a second O(n) Map merely to discover the
  // same identities again. We still descriptor-check every slot so accessor,
  // sparse, symbol, or custom-property arrays remain on the conservative path.
  if (previousDense && previousRaw.length === nextRaw.length && properties.length === nextRaw.length + 1) {
    let changedIndex = -1
    let changedPrevious: unknown
    let changedNext: unknown
    let safe = true
    for (const property of properties) {
      if (property === "length") continue
      const index = arrayIndex(property)
      if (index === undefined) { safe = false; break }
      let descriptor: PropertyDescriptor | undefined
      try { descriptor = Object.getOwnPropertyDescriptor(nextRaw, property) } catch { safe = false; break }
      if (!descriptor || !("value" in descriptor)) { safe = false; break }
      const nextRow = unwrap(descriptor.value)
      const previousRow = unwrap(previousRaw[index])
      if (Object.is(previousRow, nextRow)) continue
      if (changedIndex >= 0) { safe = false; break }
      changedIndex = index
      changedPrevious = previousRow
      changedNext = nextRow
    }
    if (safe) {
      const previousReactive = reactiveContainer(changedPrevious)
      const nextReactive = reactiveContainer(changedNext)
      const previousCount = previousReactive ? previousRefs.get(changedPrevious as object) : undefined
      const nextCount = nextReactive ? previousRefs.get(changedNext as object) : undefined
      if ((!previousReactive || previousCount !== undefined)
        && (!nextReactive || nextCount !== undefined || shallowReactiveRow(changedNext))) {
        const previousOwner = owners.get(previousRaw)
        if (previousOwner) {
          removeOwnerRecord(previousOwner, record)
          record.owners.delete(previousOwner)
        }
        attach(record, ownerFor(nextRaw))
        if (changedIndex >= 0) {
          if (previousReactive) {
            if (previousCount === 1) {
              previousRefs.delete(changedPrevious as object)
              detachReactiveLeaf(record, changedPrevious)
            } else {
              previousRefs.set(changedPrevious as object, (previousCount as number) - 1)
            }
          }
          if (nextReactive) {
            previousRefs.set(changedNext as object, (nextCount ?? 0) + 1)
            if (nextCount === undefined) attachShallowLeaf(record, changedNext as object)
          }
        }
        setRootArrayFastPath(record, previousRefs, true)
        return {
          ...(changedIndex >= 0
            ? { localized: { index: changedIndex, previous: changedPrevious, value: changedNext } }
            : {}),
        }
      }
    }
  }

  const nextRefs = new Map<object, number>()
  const nextSnapshot = new Array<unknown>(nextRaw.length)
  let indexedProperties = 0
  let localizedIndex = -1
  let localizedPrevious: unknown
  let localizedValue: unknown
  const canLocalize = previousDense && previousRaw.length === nextRaw.length
  for (const property of properties) {
    if (property === "length") continue
    const index = arrayIndex(property)
    if (index === undefined) return undefined
    indexedProperties += 1
    let descriptor: PropertyDescriptor | undefined
    try { descriptor = Object.getOwnPropertyDescriptor(nextRaw, property) } catch { return undefined }
    if (!descriptor || !("value" in descriptor)) return undefined
    nextSnapshot[index] = descriptor.value
    const row = unwrap(descriptor.value)
    if (canLocalize && localizedIndex !== -2) {
      const previous = unwrap(previousRaw[index])
      if (!Object.is(previous, row)) {
        if (localizedIndex >= 0) localizedIndex = -2
        else {
          localizedIndex = index
          localizedPrevious = previous
          localizedValue = row
        }
      }
    }
    if (typeof row !== "object" || row === null) continue
    const count = nextRefs.get(row)
    if (count !== undefined) {
      nextRefs.set(row, count + 1)
      continue
    }
    // Rows already owned by the previous shallow array were proven data-only
    // when the fast path was established. State mutations that make one row
    // structurally deep invalidate rootArrayRefs before reaching this point,
    // so only genuinely new rows need another descriptor walk here.
    if (!previousRefs.has(row)) {
      if (!reactiveContainer(row)) continue
      if (!shallowReactiveRow(row)) return undefined
    }
    nextRefs.set(row, 1)
  }
  const nextDense = indexedProperties === nextRaw.length

  const previousOwner = typeof previousRaw === "object" && previousRaw !== null ? owners.get(previousRaw as object) : undefined
  if (previousOwner) {
    removeOwnerRecord(previousOwner, record)
    record.owners.delete(previousOwner)
  }
  attach(record, ownerFor(nextRaw))
  for (const row of previousRefs.keys()) {
    if (!nextRefs.has(row)) detachReactiveLeaf(record, row)
  }
  for (const row of nextRefs.keys()) {
    if (!previousRefs.has(row)) attachShallowLeaf(record, row)
  }
  setRootArrayFastPath(record, nextRefs, nextDense)
  Object.freeze(nextSnapshot)
  return {
    snapshot: nextSnapshot,
    ...(canLocalize && nextDense && localizedIndex >= 0
      ? { localized: { index: localizedIndex, previous: localizedPrevious, value: localizedValue } }
      : {}),
  }
}

function reconcile(record: StateRecord<unknown>): void {
  detach(record)
  if (attachShallowRootArray(record, record.current)) return
  attachGraph(record, record.current)
}

function detachReactiveLeaf(record: StateRecord<unknown>, value: unknown): void {
  const raw = unwrap(value)
  if (!reactiveContainer(raw)) return
  const owner = owners.get(raw)
  if (!owner) return
  removeOwnerRecord(owner, record)
  record.owners.delete(owner)
}

function promoteRootArrayLeaves(record: StateRecord<unknown>): void {
  const refs = record.rootArrayRefs
  if (!refs) return
  for (const raw of refs.keys()) {
    attach(record, ownerFor(raw))
  }
  clearRootArrayFastPath(record)
}

function updateRootArrayReference(
  record: StateRecord<unknown>,
  arrayOwner: ReactiveOwner,
  previous: unknown,
  next: unknown,
): boolean {
  if (!record.rootArrayRefs || unwrap(record.current) !== arrayOwner.raw) return false
  const previousRaw = unwrap(previous)
  const nextRaw = unwrap(next)
  const previousReactive = reactiveContainer(previousRaw)
  const nextReactive = reactiveContainer(nextRaw)

  if (Object.is(previousRaw, nextRaw)) return true

  const previousCount = previousReactive ? record.rootArrayRefs.get(previousRaw as object) : undefined
  if (previousReactive && previousCount === undefined) {
    promoteRootArrayLeaves(record)
    return false
  }
  const nextCount = nextReactive ? record.rootArrayRefs.get(nextRaw as object) : undefined
  if (nextReactive && nextCount === undefined && !shallowReactiveRow(nextRaw)) {
    promoteRootArrayLeaves(record)
    return false
  }

  if (previousReactive) {
    if (previousCount === 1) {
      record.rootArrayRefs.delete(previousRaw as object)
      detachReactiveLeaf(record, previousRaw)
    } else {
      record.rootArrayRefs.set(previousRaw as object, (previousCount as number) - 1)
    }
  }

  if (nextReactive) {
    record.rootArrayRefs.set(nextRaw as object, (nextCount ?? 0) + 1)
    if (nextCount === undefined) attachShallowLeaf(record, nextRaw as object)
  }
  return true
}

function notifyRootArraySlot(
  owner: ReactiveOwner,
  previous: unknown,
  next: unknown,
  mutation: StateMutation,
): void {
  reactiveMutationClock += 1
  const affected = ownerRecordSnapshot(owner)
  for (const record of affected) {
    if (!updateRootArrayReference(record, owner, previous, next)) {
      const change = ownershipChange(previous, next)
      updateOwnership(record, change, change === "add" ? next : undefined)
    }
  }
  let failed = false
  let failure: unknown
  for (const record of affected) {
    try { notify(record, mutation) } catch (error) {
      if (!failed) { failed = true; failure = error }
    }
  }
  if (failed) throw failure
}

function notifyRootArrayRemoval(owner: ReactiveOwner, removed: unknown, mutation: StateMutation): void {
  reactiveMutationClock += 1
  const affected = ownerRecordSnapshot(owner)
  for (const record of affected) {
    if (!record.rootArrayRefs || unwrap(record.current) !== owner.raw || !reactiveContainer(unwrap(removed))) {
      updateOwnership(record, reactiveContainer(unwrap(removed)) ? "reconcile" : "none")
      continue
    }
    const raw = unwrap(removed)
    const count = record.rootArrayRefs.get(raw as object)
    if (count === undefined) {
      promoteRootArrayLeaves(record)
      requestReconcile(record)
    } else if (count === 1) {
      record.rootArrayRefs.delete(raw as object)
      detachReactiveLeaf(record, raw)
    } else {
      record.rootArrayRefs.set(raw as object, count - 1)
    }
  }
  let failed = false
  let failure: unknown
  for (const record of affected) {
    try { notify(record, mutation) } catch (error) {
      if (!failed) { failed = true; failure = error }
    }
  }
  if (failed) throw failure
}

function requestReconcile(record: StateRecord<unknown>): void {
  if (record.listeners.size === 0) return
  if (record.batchDepth > 0) {
    record.pendingReconcile = true
    return
  }
  reconcile(record)
}

function ownershipChange(previous: unknown, next: unknown, previousExists = true): OwnershipChange {
  const left = unwrap(previous)
  const right = unwrap(next)
  if (previousExists && Object.is(left, right)) return "none"
  const previousReactive = previousExists && reactiveContainer(left)
  const nextReactive = reactiveContainer(right)
  if (!previousReactive && nextReactive) return "add"
  if (previousReactive) return "reconcile"
  return "none"
}

function updateOwnership(record: StateRecord<unknown>, change: OwnershipChange, addedValue?: unknown): void {
  if (record.listeners.size === 0 || change === "none") return
  if (change === "add") {
    attachGraph(record, addedValue)
    return
  }
  requestReconcile(record)
}

function invalidateRootArrayFastPath(record: StateRecord<unknown>, owner: ReactiveOwner): void {
  if (!record.rootArrayRefs) return
  if (unwrap(record.current) === owner.raw || record.rootArrayRefs.has(owner.raw)) {
    promoteRootArrayLeaves(record)
  }
}

function markRootArrayNotDense(owner: ReactiveOwner): void {
  forEachOwnerRecord(owner, record => {
    if (record.rootArrayRefs && unwrap(record.current) === owner.raw) record.rootArrayDense = false
  })
}

function notifyOwner(
  owner: ReactiveOwner,
  change: OwnershipChange = "reconcile",
  addedValue?: unknown,
  mutation: StateMutation = { kind: "invalidate", target: owner.raw },
): void {
  reactiveMutationClock += 1
  const affected = ownerRecordSnapshot(owner)
  for (const record of affected) {
    if (change !== "none" || mutation.kind === "define" || mutation.kind === "invalidate") {
      invalidateRootArrayFastPath(record, owner)
    }
    updateOwnership(record, change, addedValue)
  }
  let failed = false
  let failure: unknown
  for (const record of affected) {
    try { notify(record, mutation) } catch (error) {
      if (!failed) { failed = true; failure = error }
    }
  }
  // Shared raw objects may feed multiple State records. Keep every record's
  // version/listeners coherent even when one subscriber fails, then preserve
  // the first error for normal error-boundary/reporting behavior.
  if (failed) throw failure
}

function notifyOwnerAdditions(
  owner: ReactiveOwner,
  additions: readonly unknown[],
  mutation: StateMutation = { kind: "invalidate", target: owner.raw },
): void {
  reactiveMutationClock += 1
  const affected = ownerRecordSnapshot(owner)
  for (const record of affected) {
    if (record.listeners.size === 0) continue
    if (record.rootArrayRefs && unwrap(record.current) === owner.raw) {
      let safe = true
      for (const addition of additions) {
        const raw = unwrap(addition)
        if (!reactiveContainer(raw) || record.rootArrayRefs.has(raw)) continue
        if (!shallowReactiveRow(raw)) { safe = false; break }
      }
      if (safe) {
        for (const addition of additions) {
          const raw = unwrap(addition)
          if (!reactiveContainer(raw)) continue
          const count = record.rootArrayRefs.get(raw as object)
          record.rootArrayRefs.set(raw as object, (count ?? 0) + 1)
          if (count === undefined) attachShallowLeaf(record, raw as object)
        }
        continue
      }
      promoteRootArrayLeaves(record)
    }
    for (const addition of additions) attachGraph(record, addition)
  }
  let failed = false
  let failure: unknown
  for (const record of affected) {
    try { notify(record, mutation) } catch (error) {
      if (!failed) { failed = true; failure = error }
    }
  }
  if (failed) throw failure
}

/** Clamps relative (possibly negative) start/end arguments like Array.prototype.fill. */
function relativeArrayRange(length: number, start: unknown, end: unknown): { readonly start: number; readonly end: number } {
  const clamp = (value: unknown, fallback: number): number => {
    const number = value === undefined ? fallback : Math.trunc(Number(value)) || 0
    return number < 0 ? Math.max(length + number, 0) : Math.min(number, length)
  }
  return { start: clamp(start, 0), end: clamp(end, length) }
}

function sameArraySnapshot(previous: readonly unknown[], current: readonly unknown[]): boolean {
  if (previous.length !== current.length) return false
  for (let index = 0; index < previous.length; index += 1) {
    if (!Object.is(unwrap(previous[index]), unwrap(current[index]))) return false
  }
  return true
}

function samePropertyDescriptor(left: PropertyDescriptor | undefined, right: PropertyDescriptor | undefined): boolean {
  if (!left || !right) return left === right
  if (left.configurable !== right.configurable || left.enumerable !== right.enumerable) return false
  const leftData = "value" in left || "writable" in left
  const rightData = "value" in right || "writable" in right
  if (leftData !== rightData) return false
  return leftData
    ? left.writable === right.writable && Object.is(unwrap(left.value), unwrap(right.value))
    : left.get === right.get && left.set === right.set
}

function wrap<T>(value: T, record: StateRecord<unknown>): T {
  const raw = unwrap(value)
  if (typeof raw === "object" && raw !== null) {
    const cached = record.proxies.get(raw)
    if (cached) return cached as T
  }
  if (!reactiveContainer(raw)) return raw
  const owner = ownerFor(raw)
  const existing = owner.proxies?.get(record)
  if (existing) {
    record.proxies.set(raw, existing)
    return existing as T
  }
  const mutatorCache = new Map<PropertyKey, Function>()
  const proxy = new Proxy(raw, {
    get(target, property, receiver) {
      if (property === arraySubscriptionSnapshotSymbol && Array.isArray(target)) {
        const cached = mutatorCache.get(property)
        if (cached) return cached
        const hook = () => snapshotStateArrayForSubscription(record, target)
        mutatorCache.set(property, hook)
        return hook
      }
      const result = Reflect.get(target, property, receiver)
      const nativeMutator = Array.isArray(target) ? arrayMutators.get(property) : undefined
      if (nativeMutator && result === nativeMutator) {
        const cached = mutatorCache.get(property)
        if (cached) return cached
        const wrapper = function(this: unknown, ...arguments_: unknown[]) {
          const actual = unwrap(this)
          const actualOwner = typeof actual === "object" && actual !== null ? owners.get(actual as object) : undefined

          // The overwhelmingly common path is invoking the mutator on the
          // State proxy it came from. Execute the native operation against the
          // raw array so thousands of index writes do not each bounce through
          // Proxy set/delete traps. We still preserve one logical State
          // notification and the ownership semantics of the operation.
          if (actual === raw && actualOwner === owner && Array.isArray(actual)) {
            const mutatorArguments = [...arguments_]
            if (property === "push" || property === "unshift") {
              for (let index = 0; index < mutatorArguments.length; index += 1) mutatorArguments[index] = unwrap(mutatorArguments[index])
            } else if (property === "splice") {
              for (let index = 2; index < mutatorArguments.length; index += 1) mutatorArguments[index] = unwrap(mutatorArguments[index])
            } else if (property === "fill" && mutatorArguments.length > 0) {
              mutatorArguments[0] = unwrap(mutatorArguments[0])
            } else if (property === "sort" && typeof mutatorArguments[0] === "function") {
              const compare = mutatorArguments[0] as (left: unknown, right: unknown) => number
              mutatorArguments[0] = (left: unknown, right: unknown) => compare(wrap(left, record), wrap(right, record))
            }

            // Change detection only snapshots what the operation can touch:
            // splice compares its removed and inserted items, fill its target
            // range. Only reorderings (sort/reverse/copyWithin) need the full
            // array, which they already traverse.
            const previousLength = actual.length
            const fillRange = property === "fill" ? relativeArrayRange(previousLength, mutatorArguments[1], mutatorArguments[2]) : undefined
            const previous = property === "push" || property === "unshift" || property === "pop" || property === "shift" || property === "splice"
              ? undefined
              : fillRange
                ? Array.prototype.slice.call(actual, fillRange.start, fillRange.end) as unknown[]
                : Array.prototype.slice.call(actual) as unknown[]
            const result = Reflect.apply(nativeMutator, actual, mutatorArguments)
            const changed = property === "push" || property === "unshift"
              ? mutatorArguments.length > 0
              : property === "pop" || property === "shift"
                ? previousLength > 0
                : property === "splice"
                  ? !sameArraySnapshot(result as unknown[], mutatorArguments.slice(2))
                  : fillRange
                    ? !sameArraySnapshot(previous ?? [], Array.prototype.slice.call(actual, fillRange.start, fillRange.end) as unknown[])
                    : !sameArraySnapshot(previous ?? [], actual)

            if (changed) {
              const mutation: StateMutation = {
                kind: "array",
                target: actual,
                method: String(property),
                arguments: mutatorArguments,
              }
              if (property === "reverse" || property === "sort") {
                notifyOwner(owner, "none", undefined, mutation)
              } else if (property === "push" || property === "unshift") {
                const additions = mutatorArguments.filter(value => reactiveContainer(unwrap(value)))
                if (additions.length > 0) notifyOwnerAdditions(owner, additions, mutation)
                else notifyOwner(owner, "none", undefined, mutation)
              } else if (property === "pop" && reactiveContainer(unwrap(result))) {
                notifyRootArrayRemoval(owner, result, mutation)
              } else if ((property === "pop" || property === "shift") && !reactiveContainer(unwrap(result))) {
                notifyOwner(owner, "none", undefined, mutation)
              } else {
                notifyOwner(owner, "reconcile", undefined, mutation)
              }
            }

            if (property === "reverse" || property === "sort" || property === "copyWithin" || property === "fill") return this
            if (property === "pop" || property === "shift") return wrap(result, record)
            if (property === "splice" && Array.isArray(result)) return result.map(item => wrap(item, record))
            return result
          }

          // Borrowed methods (`const push = first.value.push; push.call(second,
          // ...)`) keep the fully generic Proxy path. This preserves JS method
          // borrowing semantics without complicating the hot path above.
          const batched = actualOwner ? ownerRecordSnapshot(actualOwner) : []
          for (const affected of batched) beginBatch(affected)
          let failed = false
          let failure: unknown
          let result: unknown
          try {
            result = Reflect.apply(nativeMutator, this, arguments_)
          } catch (error) {
            failed = true
            failure = error
          }
          for (let index = batched.length - 1; index >= 0; index -= 1) {
            try { endBatch(batched[index]) } catch (error) {
              if (!failed) { failed = true; failure = error }
            }
          }
          if (failed) throw failure
          return result
        }
        mutatorCache.set(property, wrapper)
        return wrapper
      }
      if (Array.isArray(target) && property === "map" && result === Array.prototype.map) {
        const cached = mutatorCache.get(property)
        if (cached) return cached
        const wrapper = function(this: unknown, callback: unknown, thisArgument?: unknown) {
          const actual = unwrap(this)
          // Preserve ArraySpeciesCreate and borrowed-method semantics for
          // exotic arrays. The fast path is intentionally only the ordinary
          // State-array case produced by application data.
          if (actual !== raw || !Array.isArray(actual) || typeof callback !== "function"
            || Object.getPrototypeOf(actual) !== Array.prototype
            || Object.prototype.hasOwnProperty.call(actual, "constructor")
            || Array[Symbol.species] !== Array) {
            return Reflect.apply(Array.prototype.map, this as object, [callback, thisArgument])
          }
          const length = actual.length
          const mapped = new Array<unknown>(length)
          for (let index = 0; index < length; index += 1) {
            const propertyName = String(index)
            const descriptor = Object.getOwnPropertyDescriptor(actual, propertyName)
            if (!descriptor) {
              if (!(propertyName in actual)) continue
              mapped[index] = Reflect.apply(callback, thisArgument, [wrap(Reflect.get(actual, propertyName, this as object), record), index, this])
              continue
            }
            const value = "value" in descriptor
              ? descriptor.value
              : Reflect.get(actual, propertyName, this as object)
            mapped[index] = Reflect.apply(callback, thisArgument, [wrap(value, record), index, this])
          }
          return mapped
        }
        mutatorCache.set(property, wrapper)
        return wrapper
      }
      return wrap(result, record)
    },
    set(target, property, next) {
      const normalized = unwrap(next)
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
      const previousLength = Array.isArray(target) ? target.length : undefined
      const changed = !descriptor || !("value" in descriptor) || !Object.is(unwrap(descriptor.value), normalized)
      const change = descriptor && "value" in descriptor
        ? ownershipChange(descriptor.value, normalized)
        : ownershipChange(undefined, normalized, false)
      const previous = descriptor && "value" in descriptor ? unwrap(descriptor.value) : undefined
      const updated = Reflect.set(target, property, normalized, target)
      if (updated && changed) {
        const mutation: StateMutation = { kind: "set", target, property, previous, value: normalized }
        const index = Array.isArray(target) ? arrayIndex(property) : undefined
        if (index !== undefined) {
          if (previousLength !== undefined && index > previousLength) markRootArrayNotDense(owner)
          notifyRootArraySlot(owner, previous, normalized, mutation)
        } else if (Array.isArray(target) && property === "length") {
          // Shrinking length deletes indexed entries internally without
          // invoking this Proxy's delete trap. Reconcile ownership so proxies
          // for truncated rows cannot continue notifying this State.
          notifyOwner(owner, "reconcile", undefined, mutation)
        } else {
          notifyOwner(owner, change, change === "add" ? normalized : undefined, mutation)
        }
      }
      return updated
    },
    deleteProperty(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
      const existed = descriptor !== undefined
      const deleted = Reflect.deleteProperty(target, property)
      if (deleted && existed) {
        if (Array.isArray(target) && arrayIndex(property) !== undefined) markRootArrayNotDense(owner)
        const change = descriptor && "value" in descriptor && reactiveContainer(unwrap(descriptor.value)) ? "reconcile" : "none"
        notifyOwner(owner, change, undefined, {
          kind: "delete",
          target,
          property,
          previous: descriptor && "value" in descriptor ? descriptor.value : undefined,
        })
      }
      return deleted
    },
    defineProperty(target, property, descriptor) {
      const previous = Reflect.getOwnPropertyDescriptor(target, property)
      const normalized = "value" in descriptor ? { ...descriptor, value: unwrap(descriptor.value) } : descriptor
      const defined = Reflect.defineProperty(target, property, normalized)
      const current = Reflect.getOwnPropertyDescriptor(target, property)
      if (defined && !samePropertyDescriptor(previous, current)) {
        const previousValue = previous && "value" in previous ? previous.value : undefined
        const currentValue = current && "value" in current ? current.value : undefined
        const change = Array.isArray(target) && property === "length"
          ? "reconcile"
          : ownershipChange(previousValue, currentValue, Boolean(previous && "value" in previous))
        notifyOwner(owner, change, change === "add" ? currentValue : undefined, {
          kind: "define",
          target,
          property,
          previous: previousValue,
          value: currentValue,
        })
      }
      return defined
    },
    setPrototypeOf(target, prototype) {
      const previous = Reflect.getPrototypeOf(target)
      const updated = Reflect.setPrototypeOf(target, prototype)
      if (updated && previous !== prototype) notifyOwner(owner, "reconcile", undefined, {
        kind: "invalidate",
        target,
      })
      return updated
    },
    preventExtensions(target) {
      const wasExtensible = Reflect.isExtensible(target)
      const updated = Reflect.preventExtensions(target)
      if (updated && wasExtensible) notifyOwner(owner, "reconcile", undefined, {
        kind: "invalidate",
        target,
      })
      return updated
    },
  })
  ;(owner.proxies ??= new WeakMap<StateRecord<unknown>, object>()).set(record, proxy)
  record.proxies.set(raw, proxy)
  proxyRaws.set(proxy, raw)
  return proxy as T
}

export function State<T>(initial: T): StateRef<T> {
  const state = {} as StateRef<T>
  const record: StateRecord<T> = {
    current: initial,
    listeners: new Set(),
    version: 0,
    owners: new Set(),
    proxies: new WeakMap(),
    transaction: new Transaction(),
    batchDepth: 0,
    pendingNotification: false,
    pendingReconcile: false,
    pendingMutations: [],
    observedMutationClock: reactiveMutationClock,
  }
  record.current = wrap(initial, record as StateRecord<unknown>)
  records.set(state as object, record)
  Object.defineProperty(state, "value", {
    enumerable: true,
    get() { activeCollector?.(state as StateRef<unknown>); return record.current },
    set(next: T) {
      record.preparedRootArray = undefined
      const previous = unwrap(record.current)
      const rawNext = unwrap(next)
      if (Object.is(previous, rawNext)) return
      const shallowReplacement = record.listeners.size > 0
        ? replaceShallowRootArrayOwnership(record as StateRecord<unknown>, previous, rawNext)
        : undefined
      const preservedShallowOwnership = shallowReplacement !== undefined
      if (!preservedShallowOwnership) detach(record as StateRecord<unknown>)
      record.current = wrap(rawNext, record as StateRecord<unknown>) as T
      if (record.listeners.size && !preservedShallowOwnership) reconcile(record as StateRecord<unknown>)
      const localized = shallowReplacement?.localized
      notify(record as StateRecord<unknown>, localized
        ? {
            kind: "replace",
            target: rawNext && typeof rawNext === "object" ? rawNext as object : undefined,
            property: String(localized.index),
            previous: localized.previous,
            value: localized.value,
          }
        : shallowReplacement
          ? {
              kind: "replace",
              target: rawNext && typeof rawNext === "object" ? rawNext as object : undefined,
              previous,
              value: rawNext,
              ...(shallowReplacement.snapshot ? { snapshot: shallowReplacement.snapshot } : {}),
            }
          : { kind: "replace", previous, value: rawNext })
    },
  })
  return state
}

export function subscribeState(state: StateRef<unknown>, listener: Listener): () => void {
  const record = records.get(state as object)
  if (!record) return () => undefined
  const first = record.listeners.size === 0
  if (first && record.observedMutationClock !== reactiveMutationClock) {
    // useSyncExternalStore reads its snapshot before subscribing. If any
    // reactive object changed in that gap, advance this State's snapshot
    // conservatively so the renderer performs its mandatory post-subscribe
    // recheck instead of potentially committing stale nested data.
    record.version += 1
    record.observedMutationClock = reactiveMutationClock
    record.preparedRootArray = undefined
  }
  record.listeners.add(listener)
  if (first) reconcile(record)
  let active = true
  return () => {
    if (!active) return
    active = false
    record.listeners.delete(listener)
    if (!record.listeners.size) {
      record.pendingNotification = false
      record.pendingReconcile = false
      record.pendingMutations.length = 0
      detach(record)
      record.observedMutationClock = reactiveMutationClock
    }
  }
}

export function collectStateReads<T>(compute: () => T, collector: (state: StateRef<unknown>) => void): T {
  const previous = activeCollector
  activeCollector = collector
  try { return compute() } finally { activeCollector = previous }
}

export function stateVersion(state: StateRef<unknown>): number {
  const record = records.get(state as object)
  if (!record) return 0
  if (record.listeners.size === 0 && record.observedMutationClock !== reactiveMutationClock) {
    // Detached States cannot cheaply know which shared nested object changed.
    // A conservative bump is preferable to a missed external-store snapshot;
    // once subscribed, owner tracking makes notifications precise again.
    record.version += 1
    record.observedMutationClock = reactiveMutationClock
  }
  return record.version
}

/** Transaction attached to the most recent mutation of this State. */
export function stateTransaction(state: StateRef<unknown>): Transaction {
  return snapshotTransaction(records.get(state as object)?.transaction)
}

export function resolveValue<T>(value: Value<T>): T {
  if (typeof value === "function") return (value as () => T)()
  if (isStateRef(value) || isBinding(value)) return value.value as T
  return value as T
}

export function Binding<T>(source: StateRef<T> | BindingRef<T>): BindingRef<T>
export function Binding<T>(get: () => T, set: (value: T) => void): BindingRef<T>
export function Binding<T>(sourceOrGet: StateRef<T> | BindingRef<T> | (() => T), set?: (value: T) => void): BindingRef<T> {
  const binding = {} as BindingRef<T>
  Object.defineProperty(binding, "value", {
    enumerable: true,
    get: typeof sourceOrGet === "function" ? sourceOrGet : () => sourceOrGet.value,
    set: typeof sourceOrGet === "function" ? (set ?? (() => undefined)) : (value: T) => { sourceOrGet.value = value },
  })
  bindings.add(binding as object)
  return binding
}

export function Action<T>(expression: T | (() => T)): () => T {
  return actionClosure(typeof expression === "function" ? expression as () => T : () => expression)
}
