/**
 * Renderer-independent identity storage for a mounted Mün View instance.
 * Mun traversal decides identity; renderers only bind storage and native
 * reconciliation to this renderer-independent contract.
 */
export class ViewIdentityStore {
  private values = new WeakMap<object, unknown>()

  getOrCreate<T>(identity: object, create: () => T): T {
    if (this.values.has(identity)) return this.values.get(identity) as T
    const value = create()
    this.values.set(identity, value)
    return value
  }

  delete(identity: object): void {
    this.values.delete(identity)
  }

  clear(): void {
    this.values = new WeakMap<object, unknown>()
  }
}


const viewTypeIds = new WeakMap<object, number>()
let nextViewTypeId = 1

/** Stable process-local token for a concrete View host/type, independent of its display name. */
export function viewTypeIdentity(host: unknown, fallbackName: string): string {
  if ((typeof host !== "object" || host === null) && typeof host !== "function") return `name:${fallbackName}`
  const object = host as object
  let id = viewTypeIds.get(object)
  if (id === undefined) {
    id = nextViewTypeId++
    viewTypeIds.set(object, id)
  }
  return `host:${id}`
}

export type ViewIdentitySegment = string | number
export type ViewIdentity = readonly ViewIdentitySegment[]

export function viewIdentityKey(identity: ViewIdentity): string {
  let key = ""
  for (let index = 0; index < identity.length; index += 1) {
    const segment = identity[index]
    const value = String(segment)
    if (index > 0) key += "|"
    key += `${typeof segment === "number" ? "n" : "s"}:${value.length}:${value}`
  }
  return key
}

export function keyedViewIdentity(identity: ViewIdentity, key: string | number): ViewIdentity {
  const tail = identity.at(-2)
  const parent = tail === "array" || tail === "element" || tail === "fragment" || tail === "lazy" ? identity.slice(0, -2) : identity
  return [...parent, "key", key]
}

export function createViewIdentityStore(): ViewIdentityStore {
  return new ViewIdentityStore()
}
