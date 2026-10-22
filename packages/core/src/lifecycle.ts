import { State, type StateRef } from "./state.js"
import { viewElement, viewHost } from "./graph/nodes.js"
import type { ModifiableViewNode, ViewNode } from "./graph/types.js"

/** Cancellation for `.task`; a real `AbortSignal` where the platform has one. */
export interface TaskSignal { readonly aborted: boolean }
interface TaskController { readonly signal: TaskSignal; abort(): void }

function createController(): TaskController {
  const Native = (globalThis as { AbortController?: new () => TaskController }).AbortController
  if (Native) return new Native()
  const signal = { aborted: false }
  return { signal, abort() { signal.aborted = true } }
}

const queueMicrotask = (callback: () => void): void => { void Promise.resolve().then(callback) }

/** One SwiftUI lifecycle modifier; chained modifiers nest one host each. */
export type LifecycleSpec =
  | { readonly kind: "appear"; readonly action: () => unknown }
  | { readonly kind: "disappear"; readonly action: () => unknown }
  | { readonly kind: "task"; readonly action: (signal: TaskSignal) => unknown; readonly id?: unknown }
  | { readonly kind: "change"; readonly value: unknown; readonly action: (oldValue: unknown, newValue: unknown) => unknown; readonly initial?: boolean }

interface LifecycleCell {
  mounted: boolean
  spec: LifecycleSpec
  controller?: TaskController
  taskId?: unknown
  observed?: { readonly value: unknown }
  readonly ref: (element: unknown) => void
}

const lifecycleHost = Object.freeze({ name: "Lifecycle" })
// Keyed by the per-instance State so the cell lives exactly as long as the
// View identity, and mutating it never schedules a render.
const cells = new WeakMap<StateRef<number>, LifecycleCell>()

function report(error: unknown): void {
  queueMicrotask(() => { throw error })
}

function run(action: () => unknown): void {
  try {
    const result = action()
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      Promise.resolve(result).catch(error => { if (!(error instanceof Error && error.name === "AbortError")) report(error) })
    }
  } catch (error) {
    report(error)
  }
}

function startTask(cell: LifecycleCell): void {
  if (cell.spec.kind !== "task") return
  cell.controller?.abort()
  const controller = createController()
  const spec = cell.spec
  cell.controller = controller
  cell.taskId = spec.id
  queueMicrotask(() => { if (!controller.signal.aborted) run(() => spec.action(controller.signal)) })
}

function createCell(spec: LifecycleSpec): LifecycleCell {
  const cell: LifecycleCell = {
    mounted: false,
    spec,
    ref(element) {
      if (element) {
        if (cell.mounted) return
        cell.mounted = true
        const current = cell.spec
        if (current.kind === "appear") queueMicrotask(() => run(current.action))
        else if (current.kind === "task") startTask(cell)
        else if (current.kind === "change" && current.initial) queueMicrotask(() => run(() => current.action(current.value, current.value)))
      } else if (cell.mounted) {
        cell.mounted = false
        cell.controller?.abort()
        cell.controller = undefined
        const current = cell.spec
        if (current.kind === "disappear") queueMicrotask(() => run(current.action))
      }
    },
  }
  return cell
}

/** Wrap `content` in a layout-neutral host that reports mount, unmount, and value changes. */
export function lifecycleView(content: ViewNode, spec: LifecycleSpec): ModifiableViewNode {
  return viewHost("Lifecycle", lifecycleHost, { content, spec }, props => {
    const storage = props.cell as StateRef<number>
    let cell = cells.get(storage)
    if (!cell) cells.set(storage, cell = createCell(props.spec as LifecycleSpec))
    const next = props.spec as LifecycleSpec
    cell.spec = next
    if (next.kind === "task" && cell.mounted && !Object.is(cell.taskId, next.id)) startTask(cell)
    if (next.kind === "change") {
      const previous = cell.observed
      cell.observed = { value: next.value }
      if (previous && cell.mounted && !Object.is(previous.value, next.value)) queueMicrotask(() => run(() => next.action(previous.value, next.value)))
    }
    return viewElement("div", { "data-mun": "Lifecycle", style: { display: "contents" }, ref: cell.ref }, [props.content as ViewNode])
  }, () => ({ cell: State(0) }))
}
