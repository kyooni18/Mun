import { State, type StateRef } from "./state.js"

/**
 * SwiftUI's `@Observable`: every stored property of an instance is backed by
 * a State, so a View body that reads `model.count` re-renders when it
 * changes. The compiler lowers `@Observable class Model { ... }` to
 * `Observable(class Model { ... })`.
 */
export function Observable<T extends abstract new (...args: any[]) => object>(Base: T): T {
  class ObservableModel extends (Base as unknown as new (...args: any[]) => object) {
    constructor(...args: any[]) {
      super(...args)
      for (const key of Object.keys(this)) {
        const descriptor = Object.getOwnPropertyDescriptor(this, key)
        if (!descriptor || !("value" in descriptor) || typeof descriptor.value === "function") continue
        const storage: StateRef<unknown> = State(descriptor.value)
        Object.defineProperty(this, key, {
          configurable: true,
          enumerable: true,
          get: () => storage.value,
          set: (value: unknown) => { storage.value = value },
        })
      }
    }
  }
  Object.defineProperty(ObservableModel, "name", { configurable: true, value: Base.name })
  return ObservableModel as unknown as T
}

interface EnvironmentScope {
  readonly parent?: EnvironmentScope
  readonly overrides: Map<unknown, unknown>
}

let currentScope: EnvironmentScope | undefined
const scopesByFunction = new WeakMap<Function, EnvironmentScope>()

/** A scope inheriting the environment in effect where a View is created. */
export function createEnvironmentScope(): EnvironmentScope {
  return { parent: currentScope, overrides: new Map() }
}

/**
 * Run `body` inside `scope` whenever it is called. Renderers evaluate View
 * bodies and deferred rows long after the parent body returned; binding the
 * closure keeps the environment lexical to where the View was declared.
 */
export function bindEnvironmentScope<F extends (...args: any[]) => any>(scope: EnvironmentScope, body: F): F {
  const bound = function (this: unknown, ...args: unknown[]) {
    const previous = currentScope
    currentScope = scope
    try { return body.apply(this, args) } finally { currentScope = previous }
  } as F
  scopesByFunction.set(bound, scope)
  return bound
}

function systemColorScheme(): "light" | "dark" {
  try {
    const host = globalThis as { matchMedia?: (query: string) => { matches: boolean } }
    return host.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  } catch {
    return "light"
  }
}

const defaultEnvironmentValues: Record<string, () => unknown> = {
  colorScheme: systemColorScheme,
  locale: () => (globalThis as { navigator?: { language?: string } }).navigator?.language ?? "en-US",
  isEnabled: () => true,
}

function keyName(key: unknown): string {
  return typeof key === "function" ? key.name || "anonymous type" : String(key)
}

/**
 * `@Environment(\.colorScheme) var scheme` or `@Environment(Model.self) var model`.
 * Key paths are strings; observable objects are keyed by their class.
 */
export function environmentValue<T = unknown>(key: unknown): T {
  for (let scope = currentScope; scope; scope = scope.parent) {
    if (scope.overrides.has(key)) return scope.overrides.get(key) as T
  }
  if (typeof key === "string" && key in defaultEnvironmentValues) return defaultEnvironmentValues[key]!() as T
  throw new Error(`No environment value for ${keyName(key)}; provide it with .environment(...) on an ancestor View`)
}

/**
 * `.environment(model)` / `.environment(\.key, value)`: set the value on every
 * View scope in this subtree. Modifiers apply inside-out, so a nearer
 * `.environment` for the same key is kept.
 */
export function applyEnvironment(node: unknown, key: unknown, value: unknown): void {
  const seen = new Set<unknown>()
  const visit = (current: unknown, depth: number): void => {
    if (depth > 64 || current === null || seen.has(current)) return
    if (typeof current === "function") {
      const scope = scopesByFunction.get(current)
      if (scope && !scope.overrides.has(key)) scope.overrides.set(key, value)
      return
    }
    if (typeof current !== "object") return
    seen.add(current)
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1)
      return
    }
    for (const field of ["render", "content", "children", "modifiers", "compiledBody", "evaluate", "evaluatePatch", "slots", "props"]) {
      const descriptor = Object.getOwnPropertyDescriptor(current, field)
      if (descriptor && "value" in descriptor) visit(descriptor.value, depth + 1)
    }
  }
  visit(node, 0)
}
