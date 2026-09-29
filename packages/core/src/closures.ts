export type MunClosureKind = "value" | "viewBuilder" | "action"

export const munClosureKind = Symbol.for("mun.closure.kind")
export const munClosureVariants = Symbol.for("mun.closure.variants")

export interface MunClosureVariants {
  readonly value?: (...args: any[]) => any
  readonly viewBuilder?: (...args: any[]) => any
  readonly action?: (...args: any[]) => any
}

export type MunClosure<T extends (...args: any[]) => any> = T & {
  readonly [munClosureKind]?: MunClosureKind
  readonly [munClosureVariants]?: MunClosureVariants
}

function ownDataValue(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

export function overloadClosure<Args extends any[] = any[], Result = any>(
  viewBuilder: (...args: Args) => Result,
  action: (...args: Args) => unknown,
): MunClosure<(...args: Args) => Result> {
  const closure = ((...args: Args) => viewBuilder(...args)) as MunClosure<(...args: Args) => Result>
  Object.defineProperty(closure, munClosureVariants, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ viewBuilder, action }),
  })
  return closure
}

export function closureVariantsOf(value: unknown): MunClosureVariants | undefined {
  if (typeof value !== "function") return undefined
  const variants = ownDataValue(value, munClosureVariants)
  if ((typeof variants !== "object" && typeof variants !== "function") || variants === null) return undefined
  const snapshot: MunClosureVariants = Object.freeze(Object.fromEntries(
    (["value", "viewBuilder", "action"] as const).flatMap(kind => {
      const variant = ownDataValue(variants, kind)
      return typeof variant === "function" ? [[kind, variant]] : []
    }),
  ))
  return Object.keys(snapshot).length > 0 ? snapshot : undefined
}

export function closureForKind<T extends (...args: any[]) => any>(value: T, kind: MunClosureKind): T {
  return (closureVariantsOf(value)?.[kind] ?? value) as T
}

export function markMunClosure<T extends (...args: any[]) => any>(closure: T, kind: MunClosureKind): MunClosure<T> {
  const current = ownDataValue(closure, munClosureKind)
  if (current === kind) return closure as MunClosure<T>
  if (current !== undefined) {
    const wrapped = ((...args: any[]) => closure(...args)) as MunClosure<T>
    Object.defineProperty(wrapped, munClosureKind, { configurable: false, enumerable: false, value: kind })
    // Preserve overload variants across re-marking so closureForKind and
    // initializer scoring keep working on the wrapped closure.
    const variants = ownDataValue(closure, munClosureVariants)
    if (variants !== undefined && typeof variants === "object" && variants !== null) {
      Object.defineProperty(wrapped, munClosureVariants, { configurable: false, enumerable: false, value: variants })
    }
    return wrapped
  }
  try {
    Object.defineProperty(closure, munClosureKind, { configurable: false, enumerable: false, value: kind })
    return closure as MunClosure<T>
  } catch {
    const wrapped = ((...args: any[]) => closure(...args)) as MunClosure<T>
    Object.defineProperty(wrapped, munClosureKind, { configurable: false, enumerable: false, value: kind })
    return wrapped
  }
}

export function closureKindOf(value: unknown): MunClosureKind | undefined {
  if (typeof value !== "function") return undefined
  const kind = ownDataValue(value, munClosureKind)
  return kind === "value" || kind === "viewBuilder" || kind === "action" ? kind : undefined
}

export const viewBuilderClosure = <T extends (...args: any[]) => any>(closure: T) => markMunClosure(closure, "viewBuilder")
export const actionClosure = <T extends (...args: any[]) => any>(closure: T) => markMunClosure(closure, "action")
export const valueClosure = <T extends (...args: any[]) => any>(closure: T) => markMunClosure(closure, "value")
