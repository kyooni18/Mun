export type MunBoundaryRenderMode = "compiled" | "reconcile" | "root"

export interface MunDevtoolsBoundarySnapshot {
  readonly key: string
  readonly name: string
  readonly parentKey?: string
  readonly renderCount: number
  readonly totalDurationMs: number
  readonly lastDurationMs: number
  readonly maxDurationMs: number
  readonly dependencyCount: number
  readonly nodeCount: number
  readonly mode: MunBoundaryRenderMode
}

export interface MunDevtoolsSnapshot {
  readonly enabled: boolean
  readonly revision: number
  readonly runtime: MunDevtoolsRuntimeSnapshot
  readonly boundaries: readonly MunDevtoolsBoundarySnapshot[]
}

export interface MunDevtoolsRuntimeSnapshot {
  readonly boundaryInvalidations: number
  readonly boundaryFlushes: number
  readonly boundaryUpdates: number
  readonly compiledPatches: number
  readonly reconcilePasses: number
  readonly rootRequests: number
  readonly rootPasses: number
  readonly rootEscalations: number
  readonly collectionFallbacks: number
}

export type MunDevtoolsRuntimeEvent = keyof MunDevtoolsRuntimeSnapshot

type MutableBoundarySnapshot = {
  key: string
  name: string
  parentKey?: string
  renderCount: number
  totalDurationMs: number
  lastDurationMs: number
  maxDurationMs: number
  dependencyCount: number
  nodeCount: number
  mode: MunBoundaryRenderMode
}

const boundaries = new Map<string, MutableBoundarySnapshot>()
const boundaryElements = new Map<string, WeakRef<Element>>()
const listeners = new Set<() => void>()
const runtime: Record<MunDevtoolsRuntimeEvent, number> = {
  boundaryInvalidations: 0,
  boundaryFlushes: 0,
  boundaryUpdates: 0,
  compiledPatches: 0,
  reconcilePasses: 0,
  rootRequests: 0,
  rootPasses: 0,
  rootEscalations: 0,
  collectionFallbacks: 0,
}
let enabled = false
let revision = 0
let notifyPending = false

function notify(): void {
  if (notifyPending || listeners.size === 0) return
  notifyPending = true
  queueMicrotask(() => {
    notifyPending = false
    for (const listener of [...listeners]) listener()
  })
}

export function setMunDevtoolsEnabled(value: boolean): void {
  const next = value === true
  if (enabled === next) return
  enabled = next
  revision += 1
  notify()
}

export function munDevtoolsEnabled(): boolean {
  return enabled
}

export function recordMunBoundaryRender(event: {
  readonly key: string
  readonly name: string
  readonly parentKey?: string
  readonly durationMs: number
  readonly dependencyCount: number
  readonly nodeCount: number
  readonly mode: MunBoundaryRenderMode
  readonly element?: Element
}): void {
  if (!enabled) return
  const duration = Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : 0
  const existing = boundaries.get(event.key)
  if (existing) {
    existing.name = event.name
    existing.parentKey = event.parentKey
    existing.renderCount += 1
    existing.totalDurationMs += duration
    existing.lastDurationMs = duration
    existing.maxDurationMs = Math.max(existing.maxDurationMs, duration)
    existing.dependencyCount = event.dependencyCount
    existing.nodeCount = event.nodeCount
    existing.mode = event.mode
  } else {
    boundaries.set(event.key, {
      key: event.key,
      name: event.name,
      parentKey: event.parentKey,
      renderCount: 1,
      totalDurationMs: duration,
      lastDurationMs: duration,
      maxDurationMs: duration,
      dependencyCount: event.dependencyCount,
      nodeCount: event.nodeCount,
      mode: event.mode,
    })
  }
  if (event.element) boundaryElements.set(event.key, new WeakRef(event.element))
  revision += 1
  notify()
}

export function recordMunRuntimeEvent(event: MunDevtoolsRuntimeEvent, amount = 1): void {
  if (!enabled || !Number.isFinite(amount) || amount === 0) return
  runtime[event] += amount
  revision += 1
  notify()
}

export function getMunBoundaryElement(key: string): Element | null {
  const element = boundaryElements.get(key)?.deref() ?? null
  if (!element || !element.isConnected) {
    boundaryElements.delete(key)
    return null
  }
  return element
}

export function recordMunBoundaryDisposed(key: string): void {
  boundaryElements.delete(key)
  if (!enabled || !boundaries.delete(key)) return
  revision += 1
  notify()
}

export function resetMunDevtools(): void {
  boundaries.clear()
  boundaryElements.clear()
  for (const event of Object.keys(runtime) as MunDevtoolsRuntimeEvent[]) runtime[event] = 0
  revision += 1
  notify()
}

export function getMunDevtoolsSnapshot(): MunDevtoolsSnapshot {
  return Object.freeze({
    enabled,
    revision,
    runtime: Object.freeze({ ...runtime }),
    boundaries: Object.freeze([...boundaries.values()]
      .map(value => Object.freeze({ ...value }))
      .sort((left, right) => right.totalDurationMs - left.totalDurationMs)),
  })
}

export function subscribeMunDevtools(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
