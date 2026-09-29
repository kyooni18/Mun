import {
  closureForKind,
  closureKindOf,
  closureVariantsOf,
  markMunClosure,
  type MunClosureKind,
} from "../closures.js"
import { collectStateReads, isBinding, isStateRef, type StateRef } from "../state.js"
import {
  resolveSemanticInitializer,
  type SemanticArgument,
  type SemanticBuilderTypeSymbol,
  type SemanticInitializerSymbol,
  type SemanticViewTypeSymbol,
} from "../semantic.js"
import { arrayCheck, snapshotArrayValues } from "./arrays.js"
import { decorate } from "./modifiers.js"
import { isViewNode, viewFragment, viewHost } from "./nodes.js"
import { munInitializers, munNamedArguments, munView, munViewNodeFactory } from "./symbols.js"
import type {
  CompiledViewBodyPlan,
  ModifiableViewNode,
  ViewGraphChild,
  ViewGraphValue,
  ViewValue,
} from "./types.js"

const initializerSpecializations = new WeakMap<object, Map<string, InitializerMatch>>()
const initializerSpecializationEligibility = new WeakMap<object, boolean>()
// Cache keys embed argument shapes, including short string values, so distinct
// dynamic inputs (e.g. Text(userInput)) would otherwise retain one entry per
// distinct string for the process lifetime. Evicting everything above the cap
// keeps the hot path allocation-free while bounding memory.
const maximumSpecializationsPerTarget = 512

function ownPropertyDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key)
  } catch {
    return undefined
  }
}

function ownDataValue(value: object, key: PropertyKey): unknown {
  const descriptor = ownPropertyDescriptor(value, key)
  return descriptor && "value" in descriptor ? descriptor.value : undefined
}

function genericParametersOf(target: unknown): string | undefined {
  if (typeof target !== "function") return undefined
  const viewType = ownDataValue(target, "viewType")
  if ((typeof viewType !== "object" && typeof viewType !== "function") || viewType === null) return undefined
  const value = ownDataValue(viewType, "genericParameters")
  return typeof value === "string" ? value : undefined
}

function isRegisteredView(target: unknown): boolean {
  return typeof target === "function" && ownDataValue(target, munView) === true
}

function specializationShape(value: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (isBinding(value)) return `binding:${specializationShape(referenceValue(value), depth + 1) ?? "unknown"}`
  if (isStateRef(value)) return `state:${specializationShape(referenceValue(value), depth + 1) ?? "unknown"}`
  if (typeof value === "function") {
    const variants = closureVariantsOf(value)
    const variantNames = variants ? Object.keys(variants).sort().join(",") : ""
    return `function:${closureKindOf(value) ?? "unmarked"}:${variantNames}`
  }
  if (arrayCheck(value) === true) {
    const values = value as readonly unknown[]
    try {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(values, "length")
      if (!lengthDescriptor || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number") return undefined
      const items: Array<string | undefined> = []
      for (let index = 0; index < Math.min(lengthDescriptor.value, 16); index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(values, String(index))
        if (!descriptor) { items.push("hole"); continue }
        if (!("value" in descriptor)) return undefined
        items.push(specializationShape(descriptor.value, depth + 1))
      }
      if (items.some(item => item === undefined)) return undefined
      return `array:${lengthDescriptor.value}:${items.join(",")}`
    } catch {
      return undefined
    }
  }
  switch (typeof value) {
    case "string": return value.length <= 128 ? `string:${JSON.stringify(value)}` : undefined
    case "number": return Number.isFinite(value) ? `number:${value}` : `number:${String(value)}`
    case "boolean": return `boolean:${value}`
    case "bigint": return `bigint:${String(value)}`
    case "symbol": return `symbol:${String(value)}`
  }
  if (typeof value !== "object") return typeof value
  if (isViewNode(value)) return `view:${value.kind}`
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const properties = Object.keys(descriptors).filter(key => descriptors[key].enumerable).sort().map(key => {
      const descriptor = descriptors[key]
      if (!("value" in descriptor)) return undefined
      const item = specializationShape(descriptor.value, depth + 1)
      return item === undefined ? undefined : `${key}=${item}`
    })
    if (properties.some(item => item === undefined)) return undefined
    return `object:${properties.join(";")}`
  } catch {
    return undefined
  }
}

function specializationKey(args: readonly unknown[]): string | undefined {
  const shapes = args.map(value => specializationShape(value))
  return shapes.some(shape => shape === undefined) ? undefined : shapes.join("|")
}

function canSpecialize(candidates: readonly InitializerMatch[]): boolean {
  return candidates.length > 0 && candidates.every(candidate => candidate.parameters !== undefined)
}

export type InitializerParameterKind = "value" | "binding" | "viewBuilder" | "action"

export interface InitializerParameter {
  /** Source field/property populated by a declared initializer, when known. */
  readonly name?: string
  readonly label?: string
  /** The source call must provide this parameter with its declaration label. */
  readonly labelRequired?: boolean
  readonly kind: InitializerParameterKind
  readonly required?: boolean
  /** The final parameter accepts additional positional values. */
  readonly variadic?: boolean
  /** The source call may provide this closure as the trailing closure. */
  readonly trailing?: boolean
  readonly type?: string
  readonly properties?: readonly string[]
}

export interface InitializerMatch {
  readonly signature: string
  readonly parameters?: readonly InitializerParameter[]
  readonly accepts: (args: readonly unknown[]) => boolean
  readonly build?: (args: readonly unknown[]) => Record<string, unknown>
}

export interface InitializerResolution {
  readonly initializer: InitializerMatch
  readonly args: readonly unknown[]
}

export interface ViewFieldDefinition {
  readonly name: string
  readonly kind: "stored" | "state" | "binding"
  readonly type?: string
  readonly defaultValue?: string
}

/**
 * Compiler-emitted adapter metadata for embedding a Mün View in a legacy host.
 * The metadata is intentionally renderer-neutral: platform adapters can map
 * field names to framework props without parsing source type strings at runtime.
 */
export type LegacyHostCoercion = "identity" | "boolean" | "number"

export interface LegacyHostParameterPlan {
  readonly name?: string
  readonly label?: string
  readonly kind: InitializerParameterKind
  readonly required?: boolean
  readonly trailing?: boolean
  readonly coercion: LegacyHostCoercion
}

export interface LegacyHostInitializerPlan {
  readonly index: number
  readonly parameters: readonly LegacyHostParameterPlan[]
}

export interface LegacyHostPlan {
  readonly initializers: readonly LegacyHostInitializerPlan[]
}

export interface ViewDefinition<Props extends object = Record<string, unknown>> {
  readonly name?: string
  readonly genericParameters?: string
  readonly fields?: readonly ViewFieldDefinition[]
  readonly initializers: readonly InitializerMatch[]
  readonly state?: (props: Props) => Partial<Props>
  /** Optional compiler-proven dependency list used to bypass runtime State-read discovery. */
  readonly dependencies?: (props: Props) => readonly StateRef<unknown>[]
  /** True only when the compiler has proven the dependency list is exhaustive. */
  readonly dependenciesComplete?: boolean
  /** Compiler-emitted immutable template plus its dynamic slot evaluator. */
  readonly compiledBody?: CompiledViewBodyPlan<Props>
  /** Compiler-emitted plan consumed by framework compatibility hosts. */
  readonly legacyHost?: LegacyHostPlan
  readonly intrinsic?: boolean
  readonly body: (props: Props) => ViewValue
}

export interface ViewConstructorMetadata<Props extends object = Record<string, unknown>> {
  readonly [munView]: true
  readonly [munInitializers]: readonly InitializerMatch[]
  readonly viewType: ViewType<Props>
  readonly displayName?: string
}

export type ViewConstructor<
  Props extends object = Record<string, unknown>,
  Args extends readonly unknown[] = readonly unknown[],
> = ((...args: Args) => ModifiableViewNode) & ViewConstructorMetadata<Props>

/** Attach Mün View metadata to an explicit overload surface without adding a catch-all call. */
export type TypedViewConstructor<
  Props extends object,
  Call extends (...args: any[]) => ModifiableViewNode,
> = Call & ViewConstructorMetadata<Props>

export class MunInitializerError extends TypeError {
  readonly typeName: string
  readonly arguments: readonly unknown[]
  readonly candidates: readonly string[]

  constructor(typeName: string, args: readonly unknown[], candidates: readonly string[]) {
    const rendered = args.map(value => typeof value === "function" ? "closure" : typeof value).join(", ")
    super(`No matching initializer for ${typeName}(${rendered}).${candidates.length ? ` Available initializers: ${candidates.join("; ")}.` : ""}`)
    this.name = "MunInitializerError"
    this.typeName = typeName
    this.arguments = args
    this.candidates = candidates
  }
}

/** Thrown when declaration-defined initializer resolution has no unique winner. */
export class MunInitializerAmbiguityError extends MunInitializerError {
  constructor(typeName: string, args: readonly unknown[], candidates: readonly string[]) {
    const ordered = [...candidates].sort()
    super(typeName, args, ordered)
    this.name = "MunInitializerAmbiguityError"
    this.message = `Ambiguous initializer for ${typeName}(${args.map(value => typeof value === "function" ? "closure" : typeof value).join(", ")}). Candidates: ${ordered.join("; ")}.`
  }
}

function semanticInitializerSymbol(initializer: InitializerMatch, index: number): SemanticInitializerSymbol | undefined {
  return {
    kind: "initializer",
    index,
    signature: initializer.signature,
    // Legacy variadic initializers predate explicit parameter metadata. Keep
    // them in the shared semantic model as an unconstrained optional value
    // parameter so zero-argument calls are resolved instead of diagnosed as
    // unknown, while typed overloads still outrank them when applicable.
    parameters: initializer.parameters ?? [{ kind: "value", required: false, variadic: true }],
  }
}

function semanticRuntimeArgument(value: unknown): SemanticArgument {
  if (isBinding(value)) {
    const reference = referenceValue(value)
    return { value, kind: "binding", type: "binding", underlyingType: typeof reference }
  }
  if (isStateRef(value)) {
    const reference = referenceValue(value)
    return { value, kind: "value", type: "state", underlyingType: arrayCheck(reference) === true ? "array" : typeof reference }
  }
  const closureKind = closureKindOf(value)
  if (closureKind === "action" || closureKind === "viewBuilder") {
    return { value, kind: closureKind, closureRole: closureKind, type: "function" }
  }
  if (typeof value === "function") return { value, type: "function" }
  if (isViewNode(value)) return { value, type: "View" }
  return {
    value,
    type: value === null ? "null" : arrayCheck(value) === true ? "array" : typeof value,
  }
}

function semanticRuntimeArguments(candidate: InitializerMatch, args: readonly unknown[]): readonly SemanticArgument[] {
  void candidate
  return args.flatMap(value => {
    if (!value || typeof value !== "object") return [semanticRuntimeArgument(value)]
    try {
      const marker = Object.getOwnPropertyDescriptor(value, munNamedArguments)
      if (!marker || !("value" in marker) || marker.value !== true) return [semanticRuntimeArgument(value)]
      return Object.keys(value).map(label => {
        const descriptor = Object.getOwnPropertyDescriptor(value, label)
        const item = descriptor && "value" in descriptor ? descriptor.value : undefined
        return { label, ...semanticRuntimeArgument(item) }
      })
    } catch {
      return [semanticRuntimeArgument(value)]
    }
  })
}

function sharedRuntimeResolution(target: unknown, candidates: readonly InitializerMatch[], args: readonly unknown[]): InitializerResolution | undefined {
  if (candidates.length === 0 || candidates.some(candidate => !candidate.parameters)) return undefined
  const symbols = candidates.map(semanticInitializerSymbol).filter((item): item is SemanticInitializerSymbol => item !== undefined)
  const genericParameters = genericParametersOf(target)
  const supplied = suppliedInitializerArguments(args)
  const runtimeArguments = semanticRuntimeArguments(candidates[0], supplied)
  let result = resolveSemanticInitializer(symbols, runtimeArguments, genericParameters)
  // The source compiler lowers SwiftUI-style trailing closures to the final
  // JavaScript function argument. Imported/custom View metadata is not always
  // available during that first syntax pass, so the runtime can receive the
  // same `(value, closure)` shape as an ordinary positional call. Preserve the
  // existing positional interpretation first; only if it fails, retry with
  // the final function marked as the source-level trailing closure. This lets
  // declarations with omitted optional middle parameters (for example MkA)
  // route the closure to their final @ViewBuilder/@Action parameter without
  // changing any call that already resolves positionally.
  const lastRuntimeArgument = runtimeArguments.at(-1)
  if (!result.ok && lastRuntimeArgument && typeof lastRuntimeArgument.value === "function" && !lastRuntimeArgument.trailing) {
    const trailingArguments = runtimeArguments.map((argument, index) => index === runtimeArguments.length - 1
      ? { ...argument, trailing: true }
      : argument)
    const trailingResult = resolveSemanticInitializer(symbols, trailingArguments, genericParameters)
    if (trailingResult.ok) result = trailingResult
  }
  if (!result.ok) {
    const signatures = result.failure.candidates.map(candidate => candidate.signature)
    if (result.failure.kind === "ambiguous") throw new MunInitializerAmbiguityError(displayNameOf(target), supplied, signatures)
    throw new MunInitializerError(displayNameOf(target), supplied, signatures)
  }
  const candidate = candidates[result.resolution.initializerIndex]
  if (!candidate) return undefined
  const normalized = result.resolution.arguments.map(argument => argument.value)
  const typed = normalized.map((item, index) => {
    const parameter = candidate.parameters?.[index]
    return typeof item === "function" && parameter && parameter.kind !== "binding"
      ? markMunClosure(closureForKind(item as (...args: any[]) => any, parameter.kind as MunClosureKind), parameter.kind)
      : item
  })
  return { initializer: candidate, args: typed }
}

function displayNameOf(target: unknown): string {
  if (typeof target !== "function") return "View"
  const displayName = ownDataValue(target, "displayName")
  if (typeof displayName === "string" && displayName) return displayName
  const name = ownDataValue(target, "name")
  return typeof name === "string" && name ? name : "View"
}

function metadataOf(target: unknown): readonly InitializerMatch[] {
  if (typeof target !== "function") return []
  const metadata = ownDataValue(target, munInitializers)
  return arrayCheck(metadata) === true ? metadata as readonly InitializerMatch[] : []
}

export function registerInitializers<T extends Function>(target: T, initializers: readonly InitializerMatch[]): T {
  initializerSpecializations.delete(target as unknown as object)
  initializerSpecializationEligibility.set(target as unknown as object, canSpecialize(initializers))
  if (!isRegisteredView(target)) {
    Object.defineProperty(target, munView, { configurable: true, enumerable: false, value: true })
  }
  Object.defineProperty(target, munInitializers, { configurable: true, enumerable: false, value: Object.freeze([...initializers]) })
  return target
}

export function initializersOf(target: unknown): readonly InitializerMatch[] {
  return metadataOf(target)
}

export type NamedArguments<T extends object> = T & {
  readonly [munNamedArguments]: true
}

export function namedArguments<T extends Record<string, unknown>>(value: T): NamedArguments<T> {
  Object.defineProperty(value, munNamedArguments, { configurable: false, enumerable: false, value: true })
  return value as NamedArguments<T>
}

function namedObjectKeys(value: unknown): readonly string[] | undefined {
  if (typeof value !== "object" || value === null || arrayCheck(value) !== false || isViewNode(value)) return undefined
  try {
    // StateRef and BindingRef deliberately expose an accessor named `value`.
    // They are value arguments, not labeled-argument carriers.
    const valueDescriptor = Object.getOwnPropertyDescriptor(value, "value")
    if (valueDescriptor && (valueDescriptor.get || valueDescriptor.set)) return undefined
    return Object.keys(value)
  } catch {
    return undefined
  }
}

function normalizeNamedArguments(candidate: InitializerMatch, args: readonly unknown[]): readonly unknown[] {
  const parameters = candidate.parameters
  if (!parameters) return args
  const labels = new Set(parameters.flatMap(parameter => parameter.label ? [parameter.label] : []))
  const properties = new Set(parameters.flatMap(parameter => parameter.properties ?? []))
  const carriers = args.flatMap((value, index) => {
    const keys = namedObjectKeys(value)
    if (!keys) return []
    if (keys.length === 0 || keys.some(key => !labels.has(key))) return []
    if (properties.size > 0 && keys.every(key => properties.has(key))) return []
    return [{ index, value, keys }]
  })
  if (carriers.length !== 1) {
    if (parameters.some(parameter => parameter.variadic)) return args
    const normalized = Array<unknown>(parameters.length).fill(undefined)
    const align = (parameterIndex: number, argumentIndex: number): boolean => {
      if (parameterIndex === parameters.length) return argumentIndex === args.length
      const parameter = parameters[parameterIndex]
      if (parameter.required === false && align(parameterIndex + 1, argumentIndex)) return true
      if (argumentIndex >= args.length) return false
      const value = args[argumentIndex]
      if (typeMatches(parameter, value) === false) return false
      normalized[parameterIndex] = value
      return align(parameterIndex + 1, argumentIndex + 1)
    }
    return align(0, 0) ? normalized : args
  }
  const carrier = carriers[0]
  const positional = args.filter((_, index) => index !== carrier.index)
  let positionalIndex = 0
  const normalized = parameters.map(parameter => {
    if (parameter.label) {
      const descriptor = ownPropertyDescriptor(carrier.value as object, parameter.label)
      if (descriptor) return "value" in descriptor ? descriptor.value : undefined
    }
    if (positionalIndex < positional.length) return positional[positionalIndex++]
    return undefined
  })
  return positionalIndex === positional.length ? normalized : args
}

function genericConstraint(genericParameters: string | undefined, type: string): string | undefined {
  if (!genericParameters || !/^[$A-Za-z_][A-Za-z0-9_]*$/.test(type.trim())) return undefined
  const match = new RegExp(`(?:^|,)\\s*${type.trim()}\\s*(?:=[^:,>]+)?\\s*(?::\\s*([^,>]+))?`).exec(genericParameters)
  return match?.[1]?.trim() ?? (match ? "unknown" : undefined)
}

function splitTypeAlternatives(type: string): string[] {
  const result: string[] = []
  let start = 0
  let angle = 0
  let square = 0
  let parens = 0
  for (let index = 0; index < type.length; index += 1) {
    switch (type[index]) {
      case "<": angle += 1; break
      case ">": angle = Math.max(0, angle - 1); break
      case "[": square += 1; break
      case "]": square = Math.max(0, square - 1); break
      case "(": parens += 1; break
      case ")": parens = Math.max(0, parens - 1); break
      case "|":
        if (angle === 0 && square === 0 && parens === 0) {
          result.push(type.slice(start, index).trim())
          start = index + 1
        }
        break
    }
  }
  result.push(type.slice(start).trim())
  return result.filter(Boolean)
}

function referenceValue(value: unknown): unknown {
  if (isStateRef(value) || isBinding(value)) {
    return collectStateReads(() => (value as { value: unknown }).value, () => undefined)
  }
  return value
}

function typeMatchesSingle(type: string, value: unknown, genericParameters?: string): boolean | undefined {
  const normalized = type.trim().replace(/\s+/g, " ").replace(/\s*\?$/, "")
  if (!normalized || normalized === "unknown" || normalized === "any") return undefined
  if (normalized === "null") return value === null
  if (normalized === "undefined" || normalized === "void") return value === undefined

  const generic = genericConstraint(genericParameters, normalized)
  if (generic) {
    if (/\bView\b/.test(generic)) return isViewNode(value) || isRegisteredView(value)
    return undefined
  }

  const reference = referenceValue(value)
  const stateMatch = /^(?:State|StateRef)\s*<([\s\S]+)>$/.exec(normalized)
  if (stateMatch) return isStateRef(value) && typeMatchesType(stateMatch[1], reference, genericParameters) !== false
  const bindingMatch = /^(?:Binding|BindingRef)\s*<([\s\S]+)>$/.exec(normalized)
  if (bindingMatch) return isBinding(value) && typeMatchesType(bindingMatch[1], reference, genericParameters) !== false
  const valueMatch = /^Value\s*<([\s\S]+)>$/.exec(normalized)
  if (valueMatch) {
    if (typeof value === "function") return true
    if (isStateRef(value) || isBinding(value)) return typeMatchesType(valueMatch[1], reference, genericParameters) !== false
    return typeMatchesType(valueMatch[1], value, genericParameters)
  }

  if (/^(?:some\s+)?View$/.test(normalized)) return isViewNode(value) || isRegisteredView(value)
  if (/^(?:Function|function)$/.test(normalized) || normalized.includes("=>")) return typeof value === "function"
  const arrayMatch = /^(?:ReadonlyArray|Array)\s*<([\s\S]+)>$/.exec(normalized) ?? /^([\s\S]+)\[\]$/.exec(normalized)
  if (arrayMatch) return arrayCheck(reference) === true && snapshotArrayValues(reference as readonly unknown[]).every(item => typeMatchesType(arrayMatch[1], item, genericParameters) !== false)
  if (normalized.toLowerCase() === "array") return arrayCheck(reference) === true
  if (normalized === "string") return typeof reference === "string"
  if (normalized === "number") return typeof reference === "number"
  if (normalized === "boolean") return typeof reference === "boolean"
  if (normalized === "object" || normalized.startsWith("Record<")) return typeof reference === "object" && reference !== null && arrayCheck(reference) === false && !isViewNode(reference)
  if (/^(?:true|false)$/.test(normalized)) return value === (normalized === "true")
  if (/^(?:\"[^\"]*\"|'[^']*')$/.test(normalized)) return value === normalized.slice(1, -1)
  if (/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return value === Number(normalized)
  return undefined
}

function typeMatchesType(type: string, value: unknown, genericParameters?: string): boolean | undefined {
  const results = splitTypeAlternatives(type).map(alternative => typeMatchesSingle(alternative, value, genericParameters))
  if (results.some(result => result === true)) return true
  return results.some(result => result === undefined) ? undefined : false
}

function typeMatches(parameter: InitializerParameter, value: unknown, genericParameters?: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (parameter.kind === "binding") {
    if (!isBinding(value)) return false
    if (!parameter.type) return true
    if (/^(?:Binding|BindingRef)\s*</.test(parameter.type.trim())) return typeMatchesType(parameter.type, value, genericParameters)
    return typeMatchesType(parameter.type, referenceValue(value), genericParameters)
  }
  if (parameter.kind === "viewBuilder" || parameter.kind === "action") {
    return typeof value === "function"
  }
  if (!parameter.type || parameter.kind !== "value") return undefined
  const results = splitTypeAlternatives(parameter.type).map(type => typeMatchesSingle(type, value, genericParameters))
  if (results.some(result => result === true)) return true
  return results.some(result => result === undefined) ? undefined : false
}

function genericViewType(type: string | undefined, genericParameters: string | undefined): boolean {
  if (!type || !genericParameters) return false
  return genericParameters.split(",").some(declaration => {
    const name = /^\s*[$A-Za-z_][A-Za-z0-9_]*/.exec(declaration)?.[0]
    return !!name && new RegExp(`\\b${name}\\b`).test(type) && /\bView\b/.test(genericConstraint(genericParameters, name) ?? "")
  })
}

function isViewBuilderValue(value: unknown): boolean {
  if (arrayCheck(value) === true) return snapshotArrayValues(value as readonly unknown[]).every(isViewBuilderValue)
  return isViewNode(value)
}

function validateGenericViewBuilders(
  target: unknown,
  resolution: InitializerResolution,
  props: Record<string, unknown>,
): void {
  const genericParameters = genericParametersOf(target)
  if (!genericParameters || !resolution.initializer.parameters) return
  for (const parameter of resolution.initializer.parameters) {
    if (parameter.kind !== "viewBuilder" || !genericViewType(parameter.type, genericParameters)) continue
    const field = parameter.name ?? parameter.label
    if (!field || isViewBuilderValue(props[field])) continue
    throw new MunInitializerError(displayNameOf(target), resolution.args, [resolution.initializer.signature])
  }
}

function labelOrderScore(candidate: InitializerMatch, original: readonly unknown[]): number {
  if (!candidate.parameters) return 0
  const carrier = original.map(value => ({ value, keys: namedObjectKeys(value) }))
    .find(item => item.keys && item.keys.length > 0)
  if (!carrier?.keys) return 0
  const labels = candidate.parameters.flatMap(parameter => parameter.label ? [parameter.label] : [])
  return carrier.keys.reduce((score, key, index) => score + (labels[index] === key ? 1 : 0), 0)
}

function score(candidate: InitializerMatch, original: readonly unknown[], args: readonly unknown[], genericParameters?: string): number {
  if (!candidate.parameters) return 1
  // Labels are the first part of the language contract. A named carrier keeps
  // source order so declarations with the same label set but different call
  // syntax remain distinguishable before closure/type scoring.
  let result = 40 + labelOrderScore(candidate, original) * 1000 + (original === args ? 0 : 80) + (candidate.parameters.length === args.length ? 20 : 0)
  for (let index = 0; index < candidate.parameters.length; index += 1) {
    const parameter = candidate.parameters[index]
    const value = args[index]
    if (value === undefined) {
      if (parameter.required === false) result += 2
      continue
    }
    const variants = closureVariantsOf(value)
    if (variants && (parameter.kind === "viewBuilder" || parameter.kind === "action") && !variants[parameter.kind]) return Number.NEGATIVE_INFINITY
    const kind = closureKindOf(value)
    if (kind !== undefined && kind !== parameter.kind) return Number.NEGATIVE_INFINITY
    if (typeMatches(parameter, value, genericParameters) === false) return Number.NEGATIVE_INFINITY
    result += parameter.kind === "value" ? 8 : 12
  }
  return result
}

function declaredParametersAccept(candidate: InitializerMatch, args: readonly unknown[], genericParameters?: string): boolean | undefined {
  if (!candidate.parameters) return undefined
  const parameters = candidate.parameters
  const required = parameters.filter(parameter => parameter.required !== false).length
  const variadic = parameters.at(-1)?.variadic === true
  if (args.length < required || (!variadic && args.length > parameters.length)) return false
  if (variadic && args.slice(parameters.length).some(value => typeof value === "function")) return false
  for (let index = 0; index < parameters.length; index += 1) {
    const value = args[index]
    const parameter = parameters[index]
    if (value === undefined) {
      if (parameter.required !== false) return false
      continue
    }
    const variants = closureVariantsOf(value)
    if (variants && (parameter.kind === "viewBuilder" || parameter.kind === "action") && !variants[parameter.kind]) return false
    const kind = closureKindOf(value)
    if (kind !== undefined && kind !== parameter.kind) return false
    if (typeMatches(parameter, value, genericParameters) === false) return false
  }
  return true
}

function suppliedInitializerArguments(args: readonly unknown[]): readonly unknown[] {
  return args.length === 2 && args[1] === undefined && (args[0] === null || typeof args[0] === "object")
    ? args.slice(0, -1)
    : args
}

function resolveSingleDeclaredInitializer(
  target: unknown,
  candidate: InitializerMatch,
  args: readonly unknown[],
  genericParameters?: string,
  scoreCandidate = true,
): InitializerResolution {
  const supplied = suppliedInitializerArguments(args)
  const normalized = normalizeNamedArguments(candidate, supplied)
  if (declaredParametersAccept(candidate, normalized, genericParameters) !== false
    && (!scoreCandidate || Number.isFinite(score(candidate, supplied, normalized, genericParameters)))) {
    const typed = normalized.map((item, index) => {
      const parameter = candidate.parameters?.[index]
      return typeof item === "function" && parameter && parameter.kind !== "binding"
        ? markMunClosure(closureForKind(item as (...args: any[]) => any, parameter.kind as MunClosureKind), parameter.kind)
        : item
    })
    return { initializer: candidate, args: typed }
  }
  throw new MunInitializerError(displayNameOf(target), supplied, [candidate.signature])
}

export function resolveInitializer(target: unknown, args: readonly unknown[]): InitializerResolution {
  const supplied = suppliedInitializerArguments(args)
  const cacheTarget = typeof target === "function" ? target as unknown as object : undefined
  const cacheKey = cacheTarget && initializerSpecializationEligibility.get(cacheTarget) ? specializationKey(supplied) : undefined
  const cached = cacheKey && cacheTarget ? initializerSpecializations.get(cacheTarget)?.get(cacheKey) : undefined
  if (cached) {
    const genericParameters = genericParametersOf(target)
    const normalized = normalizeNamedArguments(cached, supplied)
    if (declaredParametersAccept(cached, normalized, genericParameters) !== false) {
      const typed = cached.parameters
        ? normalized.map((item, index) => {
          const parameter = cached.parameters?.[index]
          return typeof item === "function" && parameter && parameter.kind !== "binding"
            ? markMunClosure(closureForKind(item as (...args: any[]) => any, parameter.kind as MunClosureKind), parameter.kind)
            : item
        })
        : normalized
      return { initializer: cached, args: typed }
    }
  }
  const candidates = metadataOf(target)
  if (candidates.length === 1 && !candidates[0].parameters) {
    const candidate = candidates[0]
    // Legacy single-initializer Views cannot be ambiguous and their score is
    // constant. Avoid semantic resolution and one-entry candidate allocation
    // on every dynamic construction (notably reused ForEach rows).
    const normalized = normalizeNamedArguments(candidate, supplied)
    if (candidate.accepts(normalized)) return { initializer: candidate, args: normalized }
    throw new MunInitializerError(displayNameOf(target), supplied, [candidate.signature])
  }
  const genericParameters = genericParametersOf(target)
  const shared = sharedRuntimeResolution(target, candidates, supplied)
  if (shared) return shared
  if (candidates.length === 1) return resolveSingleDeclaredInitializer(target, candidates[0], supplied, genericParameters)
  const matches = candidates.map(candidate => {
    const normalized = normalizeNamedArguments(candidate, supplied)
    const declared = declaredParametersAccept(candidate, normalized, genericParameters)
    // Parameter metadata is the canonical resolver contract. Predicates remain
    // available for legacy variadic initializers that intentionally have no
    // finite parameter list.
    if (declared === false || (declared === undefined && !candidate.accepts(normalized))) return null
    const value = score(candidate, supplied, normalized, genericParameters)
    if (!Number.isFinite(value)) return null
    const typed = candidate.parameters
      ? normalized.map((item, index) => {
        const parameter = candidate.parameters?.[index]
        return typeof item === "function" && parameter && parameter.kind !== "binding"
          ? markMunClosure(closureForKind(item as (...args: any[]) => any, parameter.kind as MunClosureKind), parameter.kind)
          : item
      })
      : normalized
    return { candidate, args: typed, score: value }
  }).filter((item): item is { candidate: InitializerMatch; args: readonly unknown[]; score: number } => item !== null)
    .sort((left, right) => right.score - left.score)
  const match = matches[0]
  if (!match) throw new MunInitializerError(displayNameOf(target), supplied, candidates.map(candidate => candidate.signature))
  const tied = matches.filter(candidate => candidate.score === match.score)
  if (tied.length > 1) {
    throw new MunInitializerAmbiguityError(
      displayNameOf(target),
      supplied,
      tied.map(candidate => candidate.candidate.signature),
    )
  }
  if (cacheKey && cacheTarget) {
    const cache = initializerSpecializations.get(cacheTarget) ?? new Map<string, InitializerMatch>()
    if (cache.size >= maximumSpecializationsPerTarget) cache.clear()
    cache.set(cacheKey, match.candidate)
    initializerSpecializations.set(cacheTarget, cache)
  }
  return { initializer: match.candidate, args: match.args }
}

export function assertInitializerCall(target: unknown, args: readonly unknown[]): void {
  if (metadataOf(target).length > 0) resolveInitializer(target, args)
}

/** Statically valid result of a declared @ViewBuilder closure. */
export type ViewBuilderContent = ModifiableViewNode | readonly ViewBuilderContent[] | null | undefined | false
export type ViewBuilderClosure = () => ViewBuilderContent
/** Runtime normalization input retained for renderer and compatibility boundaries. */
export type ViewBuilderResult = ViewValue | readonly ViewBuilderResult[] | false

export const viewBuilderSemanticSymbol: SemanticBuilderTypeSymbol = Object.freeze({
  kind: "builder",
  name: "ViewBuilder",
  contentType: "View",
  operations: ["buildBlock", "buildOptional", "buildEither", "buildArray"] as const,
})

export function flattenViewBuilder(value: ViewBuilderResult): ViewValue[] {
  if (value === null || value === undefined || value === false) return []
  if (arrayCheck(value) === true) return snapshotArrayValues(value as readonly unknown[]).flatMap(item => flattenViewBuilder(item as ViewBuilderResult))
  return [value]
}

export const ViewBuilder = Object.freeze({
  semanticSymbol: viewBuilderSemanticSymbol,
  buildBlock: (...values: ViewBuilderResult[]) => values.flatMap(flattenViewBuilder),
  buildOptional: (value: ViewBuilderResult | null | undefined) => flattenViewBuilder(value as ViewBuilderResult),
  buildEither: (first: ViewBuilderResult, second?: ViewBuilderResult) => flattenViewBuilder(second === undefined ? first : second),
  buildArray: (values: readonly ViewBuilderResult[]) => snapshotArrayValues(values).flatMap(item => flattenViewBuilder(item as ViewBuilderResult)),
})

export function resolveBuilderClosure(closure: () => ViewBuilderResult): ViewValue[] {
  return ViewBuilder.buildBlock(markMunClosure(closure, "viewBuilder")())
}

/**
 * Normalize compiler-lowered ViewBuilder input. Optimized compiler output can
 * pass the already-evaluated builder value directly, avoiding allocation and
 * immediate execution of a throwaway closure. Dynamic/runtime calls retain
 * the closure path and therefore the same validation semantics as before.
 */
export function resolveBuilderInput(value: unknown): ViewValue[] {
  return typeof value === "function"
    ? resolveBuilderClosure(value as () => ViewBuilderResult)
    : ViewBuilder.buildBlock(value as ViewBuilderResult)
}

export class ViewType<Props extends object = Record<string, unknown>> {
  readonly name: string
  readonly genericParameters?: string
  readonly fields: readonly ViewFieldDefinition[]
  readonly definition: ViewDefinition<Props>
  readonly initializers: readonly InitializerMatch[]
  readonly legacyHost?: LegacyHostPlan
  /** Canonical semantic symbol consumed by compiler/IDE/runtime adapters. */
  readonly semanticSymbol: SemanticViewTypeSymbol
  private target: unknown

  constructor(name: string, definition: ViewDefinition<Props>) {
    this.name = name
    this.genericParameters = definition.genericParameters
    this.fields = definition.fields ?? []
    this.definition = definition
    this.initializers = definition.initializers
    this.legacyHost = definition.legacyHost
    this.semanticSymbol = {
      kind: "view",
      name,
      qualifiedName: name,
      genericParameters: definition.genericParameters,
      fields: this.fields,
      initializers: this.initializers.flatMap((item, index) => {
        const symbol = semanticInitializerSymbol(item, index)
        return symbol ? [symbol] : []
      }),
    }
  }

  bind(target: unknown): void { this.target = target }

  createNode(args: readonly unknown[]): ModifiableViewNode {
    if (!this.target) throw new TypeError(`View type ${this.name} is not bound to a constructor`)
    const resolution = resolveInitializer(this.target, args)
    return this.createNodeFromResolution(resolution)
  }

  /**
   * Materialize a compiler-selected declaration initializer without scanning
   * the overload set again. The compiler only emits this for an unambiguous
   * declaration-defined call; the guard keeps hand-written callers safe.
   */
  createNodeSpecialized(initializerIndex: number, args: readonly unknown[]): ModifiableViewNode {
    if (!this.target) throw new TypeError(`View type ${this.name} is not bound to a constructor`)
    const candidate = this.initializers[initializerIndex]
    if (!candidate?.parameters) return this.createNode(args)
    return this.createNodeFromResolution(resolveSingleDeclaredInitializer(this.target, candidate, args, this.genericParameters, false))
  }

  /**
   * Trusted AOT fast path. The compiler emits this only after TypeScript and
   * Mun semantic resolution have selected a concrete initializer and proven
   * that the argument positions are already normalized. No overload scan,
   * label normalization, closure-role wrapping, or runtime type scoring is
   * repeated here. Uncertain calls deliberately stay on createNodeSpecialized.
   */
  createNodeCompiled(initializerIndex: number, args: readonly unknown[]): ModifiableViewNode {
    if (!this.target) throw new TypeError(`View type ${this.name} is not bound to a constructor`)
    const candidate = this.initializers[initializerIndex]
    if (!candidate?.parameters) return this.createNode(args)
    const props = (candidate.build?.(args) ?? {}) as Props
    return this.materializeProps(props)
  }

  private materializeProps(props: Props): ModifiableViewNode {
    if (this.definition.intrinsic) {
      const value = this.definition.body(props)
      return isViewNode(value) ? decorate(value) : viewFragment([value as ViewGraphChild])
    }
    return viewHost(
      this.name,
      this,
      props as Record<string, unknown>,
      next => this.definition.body(next as Props),
      this.definition.state as ((props: Record<string, unknown>) => Record<string, unknown>) | undefined,
      this.definition.dependencies as ((props: Record<string, unknown>) => readonly StateRef<unknown>[]) | undefined,
      this.definition.dependenciesComplete,
      this.definition.compiledBody as CompiledViewBodyPlan<Record<string, unknown>> | undefined,
    )
  }

  private createNodeFromResolution(resolution: InitializerResolution): ModifiableViewNode {
    const props = (resolution.initializer.build?.(resolution.args) ?? {}) as Props
    validateGenericViewBuilders(this.target, resolution, props as Record<string, unknown>)
    return this.materializeProps(props)
  }
}

export function defineView<
  Props extends object = Record<string, unknown>,
  Args extends readonly unknown[] = readonly unknown[],
>(name: string, definition: ViewDefinition<Props>): ViewConstructor<Props, Args> {
  const viewType = new ViewType(name, definition)
  const Type = ((...args: unknown[]) => viewType.createNode(args)) as unknown as ViewConstructor<Props, Args>
  Object.defineProperty(Type, munView, { configurable: false, value: true })
  Object.defineProperty(Type, "displayName", { configurable: true, value: name })
  Object.defineProperty(Type, "viewType", { configurable: false, value: viewType })
  Object.defineProperty(Type, munViewNodeFactory, { configurable: false, value: (...args: unknown[]) => viewType.createNode(args) })
  viewType.bind(Type)
  registerInitializers(Type, definition.initializers)
  return Type
}

export const structView = defineView

export function createViewNode(target: unknown, args: readonly unknown[] = []): ModifiableViewNode {
  const factory = typeof target === "function" ? ownDataValue(target, munViewNodeFactory) : undefined
  if (typeof factory !== "function") throw new TypeError(`Target ${displayNameOf(target)} is not a Mün View constructor`)
  return factory(...args)
}

export function defineBuiltinView<Props extends object = Record<string, unknown>>(
  name: string,
  initializers: readonly InitializerMatch[],
  body: (props: Props) => ViewValue,
  genericParameters?: string,
): ViewConstructor<Props> {
  return defineView(name, { name, initializers, genericParameters, intrinsic: true, body })
}

export function initializer(signature: string, accepts: (args: readonly unknown[]) => boolean, build?: (args: readonly unknown[]) => Record<string, unknown>, parameters?: readonly InitializerParameter[]): InitializerMatch {
  return { signature, accepts, build, parameters }
}

export const initializerKinds = Object.freeze({
  value: (required = true, label?: string, properties?: readonly string[], type?: string, variadic = false, name?: string): InitializerParameter => ({
    kind: "value",
    required,
    name,
    label,
    properties,
    type,
    ...(variadic ? { variadic: true } : {}),
  }),
  binding: (required = true, label?: string, type?: string, name?: string): InitializerParameter => ({ kind: "binding", required, name, label, type }),
  viewBuilder: (required = true, label?: string, type?: string, trailing = true, name?: string): InitializerParameter => ({ kind: "viewBuilder", required, name, label, trailing, type }),
  action: (required = true, label?: string, type?: string, trailing = false, name?: string): InitializerParameter => ({ kind: "action", required, name, label, trailing, type }),
})
