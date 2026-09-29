import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { useReactiveValue } from './state.js'
import { finalize } from './modifiers.js'
import { materializeViewNode, reactRenderer } from './runtime/renderer.js'
import { isViewNode, markViewNode, viewElement, viewFragment, viewGraphChild, viewHost, type ViewGraphValue, type ViewNode } from './runtime/view-graph.js'
import { arrayCheck, snapshotArrayValues } from './runtime/arrays.js'
import { useViewIdentityStorage } from './runtime/view-storage.js'
import { markIntrinsic } from './layout.js'
import { closureForKind, closureKindOf, closureVariantsOf, markMunClosure, type MunClosureKind } from './closures.js'
import type { Modifiers } from './types.js'

/** The marker used by values produced by Mun's struct/View model. */
export const munView = Symbol.for('mun.view')
export const munInitializers = Symbol.for('mun.initializers')
/** Marks objects synthesized by the Mun parser for labeled arguments. */
export const munNamedArguments = Symbol.for('mun.named.arguments')
const munViewNodeFactory = Symbol.for('mun.view.node.factory')

export interface ViewObject {
  readonly [munView]: true
  readonly body: ReactNode | (() => ReactNode)
}

export type View = ReactNode | ViewObject | ViewNode
export type ViewBuilderResult = View | readonly ViewBuilderResult[] | null | undefined | false
export type ViewBuilder = (...values: unknown[]) => ViewBuilderResult
export type ViewBuilderClosure = () => ViewBuilderResult

export type InitializerParameterKind = 'value' | 'viewBuilder' | 'action'

export interface InitializerParameter {
  label?: string
  kind: InitializerParameterKind
  required?: boolean
  /** Static type spelling retained for overload diagnostics and scoring. */
  type?: string
  /** Fields accepted by a value parameter represented by a compatibility object. */
  properties?: readonly string[]
}

export interface InitializerMatch {
  /** A human-readable signature used in diagnostics and editor tooling. */
  signature: string
  parameters?: readonly InitializerParameter[]
  /** Whether this initializer accepts the supplied JavaScript arguments. */
  accepts(args: readonly unknown[]): boolean
  /** Builds the props stored by a struct View. */
  build?(args: readonly unknown[]): Record<string, unknown>
}

export interface InitializerResolution {
  initializer: InitializerMatch
  args: readonly unknown[]
}

export interface ViewDefinition<Props extends object = Record<string, unknown>> {
  name?: string
  initializers: readonly InitializerMatch[]
  state?(props: Props): Partial<Props>
  /** Built-ins apply modifiers to their rendered root instead of a host slot. */
  intrinsic?: boolean
  body(props: Props): View
}

export type ViewConstructor<Props extends object = Record<string, unknown>> = {
  (...args: unknown[]): ReactElement & Modifiers
  readonly [munView]: true
  readonly [munInitializers]: readonly InitializerMatch[]
  readonly viewType: ViewType<Props>
  readonly displayName?: string
}

/** Preserve a public callable overload surface while exposing its View type. */
export type ViewCallable<Call extends (...args: any[]) => any, Props extends object = Record<string, unknown>> =
  Call & Pick<ViewConstructor<Props>, 'viewType'>

export class MunInitializerError extends TypeError {
  readonly typeName: string
  readonly arguments: readonly unknown[]
  readonly candidates: readonly string[]

  constructor(typeName: string, args: readonly unknown[], candidates: readonly string[]) {
    const rendered = args.map(value => typeof value === 'function' ? 'closure' : typeof value).join(', ')
    const available = candidates.length > 0 ? ` Available initializers: ${candidates.join('; ')}.` : ''
    super(`No matching initializer for ${typeName}(${rendered}).${available}`)
    this.name = 'MunInitializerError'
    this.typeName = typeName
    this.arguments = args
    this.candidates = candidates
  }
}

function typeName(target: unknown): string {
  if (typeof target === 'function' && (target as any).displayName) return (target as any).displayName
  if (typeof target === 'function' && target.name) return target.name
  return 'View'
}

function metadataOf(target: unknown): readonly InitializerMatch[] {
  if (typeof target !== 'function') return []
  return ((target as any)[munInitializers] as readonly InitializerMatch[] | undefined) ?? []
}

/** Register overload metadata on a callable View without changing its identity. */
export function registerInitializers<T extends Function>(
  target: T,
  initializers: readonly InitializerMatch[],
): T {
  if (!(target as any)[munView]) {
    Object.defineProperty(target, munView, { configurable: true, enumerable: false, value: true })
  }
  Object.defineProperty(target, munInitializers, {
    configurable: true,
    enumerable: false,
    value: Object.freeze([...initializers]),
  })
  return target
}

export function initializersOf(target: unknown): readonly InitializerMatch[] {
  return metadataOf(target)
}

/** Internal labeled-argument carrier; plain objects remain a compatibility API. */
export function namedArguments<T extends Record<string, unknown>>(value: T): T {
  Object.defineProperty(value, munNamedArguments, { configurable: false, enumerable: false, value: true })
  return value
}

function namedArgumentsFor(
  candidate: InitializerMatch,
  args: readonly unknown[],
): readonly unknown[] {
  const parameters = candidate.parameters
  const first = args[0]
  if (!parameters || !isNamedArguments(first)) return args

  const labels = new Set(parameters.flatMap(parameter => parameter.label ? [parameter.label] : []))
  const properties = new Set(parameters.flatMap(parameter => parameter.properties ?? []))
  const keys = Object.keys(first)
  const isOptionObject = properties.size > 0
    && keys.length > 0
    && keys.every(key => properties.has(key))
  if (isOptionObject) return args
  if (!keys.some(label => labels.has(label)) || keys.some(label => !labels.has(label))) return args

  let trailingClosures = args.slice(1).filter(value => typeof value === 'function').length
  for (const parameter of parameters) {
    if (parameter.required === false || (parameter.label && Object.prototype.hasOwnProperty.call(first, parameter.label))) continue
    if ((parameter.kind === 'viewBuilder' || parameter.kind === 'action') && trailingClosures > 0) {
      trailingClosures -= 1
      continue
    }
    if (parameter.required) return args
  }

  let trailing = 1
  const normalized = parameters.map(parameter => {
    if (parameter.label && Object.prototype.hasOwnProperty.call(first, parameter.label)) {
      return first[parameter.label]
    }
    if ((parameter.kind === 'viewBuilder' || parameter.kind === 'action') && typeof args[trailing] === 'function') {
      return args[trailing++]
    }
    return undefined
  })
  while (normalized.length > 0
    && normalized[normalized.length - 1] === undefined
    && parameters[normalized.length - 1]?.required === false) {
    normalized.pop()
  }
  return trailing === args.length ? normalized : args
}

function isNamedArguments(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && !isValidElement(value)
}

function namedObjectMatches(candidate: InitializerMatch, args: readonly unknown[]): boolean {
  const parameters = candidate.parameters
  const first = args[0]
  if (!parameters || !isNamedArguments(first)) return true
  const labels = new Set(parameters.flatMap(parameter => parameter.label ? [parameter.label] : []))
  const properties = new Set(parameters.flatMap(parameter => parameter.properties ?? []))
  if (properties.size === 0) return true
  const keys = Object.keys(first)
  if (keys.length === 0) return true
  if (keys.some(key => properties.has(key))) return keys.every(key => properties.has(key))
  if (keys.some(key => labels.has(key))) return keys.every(key => labels.has(key))
  // A value parameter may itself be a plain object (StateRef/BindingRef are
  // the common case), so unrelated keys are not evidence of a named call.
  return true
}

function runtimeTypeScore(parameter: InitializerParameter, value: unknown): number {
  if (!parameter.type || parameter.kind !== 'value' || value === undefined || value === null) return 0
  const type = parameter.type
    .replace(/\b(readonly|const)\b/g, '')
    .replace(/[?\[\]<>|&{},:]/g, ' ')
    .trim()
    .toLowerCase()
  if (!type || /^[a-z_$][a-z0-9_$]*$/.test(type) && !['string', 'number', 'boolean', 'object', 'function', 'array'].includes(type)) return 0
  if (type.includes('string') && typeof value === 'string') return 4
  if (type.includes('number') && typeof value === 'number') return 4
  if (type.includes('boolean') && typeof value === 'boolean') return 4
  if ((type.includes('function') || type.includes('=>')) && typeof value === 'function') return 4
  if ((type.includes('array') || type.includes('[]')) && Array.isArray(value)) return 4
  if (type.includes('object') && typeof value === 'object') return 2
  return 0
}

function runtimeTypeMatches(parameter: InitializerParameter, value: unknown): boolean | undefined {
  if (!parameter.type || parameter.kind !== 'value' || value === undefined || value === null) return undefined
  const type = parameter.type
    .replace(/\b(readonly|const)\b/g, '')
    .replace(/[?\[\]<>|&{},:]/g, ' ')
    .trim()
    .toLowerCase()
  if (!type) return undefined
  if (type.includes('string')) return typeof value === 'string'
  if (type.includes('number')) return typeof value === 'number'
  if (type.includes('boolean')) return typeof value === 'boolean'
  if (type.includes('function') || type.includes('=>')) return typeof value === 'function'
  if (type.includes('array') || type.includes('[]')) return Array.isArray(value)
  if (type === 'object') return typeof value === 'object'
  return undefined
}

function initializerScore(candidate: InitializerMatch, args: readonly unknown[], normalized: readonly unknown[]): number {
  const parameters = candidate.parameters
  if (!parameters) return 1

  let score = 40
  if (normalized !== args) score += 80
  if (parameters.length === normalized.length) score += 20

  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index]
    const value = normalized[index]
    if (value === undefined) {
      if (parameter.required === false) score += 2
      continue
    }
    const variants = closureVariantsOf(value)
    if (variants && parameter.kind !== 'value' && !variants[parameter.kind]) return Number.NEGATIVE_INFINITY
    const closureKind = closureKindOf(value)
    if (closureKind !== undefined && parameter.kind !== closureKind) return Number.NEGATIVE_INFINITY
    if (runtimeTypeMatches(parameter, value) === false) return Number.NEGATIVE_INFINITY
    if (parameter.kind === 'value' && typeof value !== 'function') score += 8
    if ((parameter.kind === 'viewBuilder' || parameter.kind === 'action') && typeof value === 'function') score += 12
    score += runtimeTypeScore(parameter, value)
  }
  return score
}

/** Resolve overloads exactly once at the View boundary. */
export function resolveInitializer(target: unknown, args: readonly unknown[]): InitializerResolution {
  // React 19 invokes function components with a legacy second argument. It is
  // always undefined for Mun constructors and must not become an initializer
  // argument when a callable View is used directly as a React component.
  const suppliedArgs = args.length === 2
    && args[1] === undefined
    && (args[0] === null || typeof args[0] === 'object')
    ? args.slice(0, -1)
    : args
  const candidates = metadataOf(target)
  const match = candidates
    .map(candidate => {
      const candidateArgs = namedArgumentsFor(candidate, suppliedArgs)
      if (!namedObjectMatches(candidate, suppliedArgs) || !candidate.accepts(candidateArgs)) return null
      const score = initializerScore(candidate, suppliedArgs, candidateArgs)
      if (!Number.isFinite(score)) return null
      const typedArgs = candidate.parameters
        ? candidateArgs.map((value, index) => {
          const parameter = candidate.parameters?.[index]
          if (typeof value !== 'function' || !parameter || (parameter.kind !== 'value' && parameter.kind !== 'viewBuilder' && parameter.kind !== 'action')) return value
          const selected = closureForKind(value as (...args: any[]) => any, parameter.kind as MunClosureKind)
          return markMunClosure(selected, parameter.kind as MunClosureKind)
        })
        : candidateArgs
      return { candidate, args: typedArgs, score }
    })
    .filter((value): value is { candidate: InitializerMatch; args: readonly unknown[]; score: number } => value !== null)
    .sort((left, right) => right.score - left.score)[0]
  const initializer = match?.candidate
  if (!initializer) throw new MunInitializerError(typeName(target), suppliedArgs, candidates.map(candidate => candidate.signature))
  return { initializer, args: match?.args ?? suppliedArgs }
}

/** Validate a legacy function DSL call against its declared initializer metadata. */
export function assertInitializerCall(target: unknown, args: readonly unknown[]): void {
  if (metadataOf(target).length > 0) resolveInitializer(target, args)
}

export function flattenViewBuilder(value: ViewBuilderResult): View[] {
  if (value === null || value === undefined || value === false) return []
  const array = arrayCheck(value)
  if (array === undefined) throw new TypeError('Legacy ViewBuilder arrays must be inspectable')
  if (array) return snapshotArrayValues(value as readonly unknown[]).flatMap(item => flattenViewBuilder(item as ViewBuilderResult))
  return [value as View]
}

export const ViewBuilder = Object.freeze({
  buildBlock(...values: ViewBuilderResult[]): View[] {
    return values.flatMap(flattenViewBuilder)
  },
  buildOptional(value: ViewBuilderResult | null | undefined): View[] {
    return flattenViewBuilder(value)
  },
  buildEither(first: ViewBuilderResult, second?: ViewBuilderResult): View[] {
    return flattenViewBuilder(second === undefined ? first : second)
  },
  buildArray(values: readonly ViewBuilderResult[]): View[] {
    if (arrayCheck(values) !== true) throw new TypeError('Legacy ViewBuilder arrays must be inspectable')
    return snapshotArrayValues(values).flatMap(item => flattenViewBuilder(item as ViewBuilderResult))
  },
})

export function resolveBuilderClosure(closure: ViewBuilderClosure): View[] {
  return ViewBuilder.buildBlock(markMunClosure(closure, 'viewBuilder')())
}

function renderView(value: View): ReactNode {
  if (isViewNode(value)) return reactRenderer.render(value)
  if (value && typeof value === 'object' && munView in (value as object)) {
    const body = (value as any).body
    return typeof body === 'function' ? body() : body
  }
  return value as ReactNode
}

/** Render a View value at the React ownership boundary. */
export function renderViewTree(value: ViewBuilderResult): ReactNode {
  const array = arrayCheck(value)
  if (array === undefined) throw new TypeError('Legacy ViewBuilder arrays must be inspectable')
  if (array) return snapshotArrayValues(value as readonly unknown[]).map(item => renderViewTree(item as ViewBuilderResult))
  if (value === null || value === undefined || value === false) return value as any
  return renderView(value as View)
}

interface ViewHostProps<Props extends object> {
  definition: ViewDefinition<Props>
  props: Props
}

function renderDefinition<Props extends object>(
  definition: ViewDefinition<Props>,
  props: Props,
  forwarded: Record<string, unknown>,
): ReactNode {
  const state = useViewIdentityStorage<Partial<Props> | null>(() => definition.state?.(props) ?? null)
  const resolvedProps = state === null ? props : { ...props, ...state }
  const node = useReactiveValue(() => definition.body(resolvedProps))
  const rendered = renderViewTree(node)
  if (definition.intrinsic && isValidElement(rendered)) {
    const renderedProps = rendered.props as Record<string, unknown>
    const merged = { ...forwarded }
    if (forwarded.style !== undefined || renderedProps.style !== undefined) {
      merged.style = { ...(renderedProps.style as object ?? {}), ...(forwarded.style as object ?? {}) }
    }
    if (forwarded.className !== undefined && renderedProps.className !== undefined) {
      merged.className = `${String(renderedProps.className)} ${String(forwarded.className)}`
    }
    return cloneElement(rendered, merged as any)
  }
  return materializeViewNode(viewFragment([rendered]))
}

function ViewHost<Props extends object>({ definition, props }: ViewHostProps<Props>) {
  return renderDefinition(definition, props, {})
}

interface BuiltinViewHostProps<Props extends object> extends ViewHostProps<Props> {
  [key: string]: unknown
}

function BuiltinViewHost<Props extends object>({ definition, props, ...forwarded }: BuiltinViewHostProps<Props>) {
  return renderDefinition(definition, props, forwarded)
}

markIntrinsic(BuiltinViewHost)

/** The renderer-neutral type object behind every callable View compatibility wrapper. */
export class ViewType<Props extends object = Record<string, unknown>> {
  readonly name: string
  readonly definition: ViewDefinition<Props>
  readonly initializers: readonly InitializerMatch[]
  private target: unknown

  constructor(name: string, definition: ViewDefinition<Props>) {
    this.name = name
    this.definition = definition
    this.initializers = definition.initializers
  }

  bind(target: unknown): void {
    this.target = target
  }

  createNode(args: readonly unknown[]): ViewNode {
    if (!this.target) throw new TypeError(`View type ${this.name} is not bound to a constructor`)
    const resolution = resolveInitializer(this.target, args)
    const props = (resolution.initializer.build?.(resolution.args) ?? {}) as Props
    if (this.definition.intrinsic) {
      const value = this.definition.body(props)
      return isViewNode(value) ? value : viewFragment([viewGraphChild(value as ReactNode)])
    }
    const hostProps = { definition: this.definition, props }
    return viewHost(
      this.name,
      ViewHost,
      hostProps,
      value => this.definition.body((value as ViewHostProps<Props>).props) as unknown as ViewGraphValue,
    )
  }
}

/**
 * Define a user View with the same initializer/body split as a built-in View.
 * The returned callable is intentionally React-compatible, so it can be used
 * inside the existing renderer while the View graph stays declarative.
 */
export function defineView<Props extends object = Record<string, unknown>>(
  name: string,
  definition: ViewDefinition<Props>,
): ViewConstructor<Props> {
  const viewType = new ViewType(name, definition)

  const Type = ((...args: unknown[]) => {
    const node = viewType.createNode(args)
    const element = finalize(materializeViewNode(node))
    markViewNode(element, node)
    return element
  }) as ViewConstructor<Props>

  Object.defineProperty(Type, munView, { configurable: false, value: true })
  Object.defineProperty(Type, 'displayName', { configurable: true, value: name })
  Object.defineProperty(Type, 'viewType', { configurable: false, value: viewType })
  viewType.bind(Type)
  Object.defineProperty(Type, munViewNodeFactory, {
    configurable: false,
    value: (...args: unknown[]) => viewType.createNode(args),
  })
  registerInitializers(Type, definition.initializers)
  return Type
}

/** Build a renderer-neutral View graph node without creating a React element. */
export function createViewNode(target: unknown, args: readonly unknown[] = []): ViewNode {
  const factory = typeof target === 'function'
    ? (target as { [munViewNodeFactory]?: (...values: unknown[]) => ViewNode })[munViewNodeFactory]
    : undefined
  if (!factory) throw new TypeError(`Target ${typeName(target)} is not a Mün View constructor`)
  return factory(...args)
}

export function defineBuiltinView<Props extends object = Record<string, unknown>>(
  name: string,
  initializers: readonly InitializerMatch[],
  body: (props: Props) => View,
): ViewConstructor<Props> {
  return defineView(name, { name, initializers, intrinsic: true, body })
}

/** A concise alias for code that wants to describe a SwiftUI-like struct. */
export const structView = defineView

export function initializer(
  signature: string,
  accepts: (args: readonly unknown[]) => boolean,
  build?: (args: readonly unknown[]) => Record<string, unknown>,
  parameters?: readonly InitializerParameter[],
): InitializerMatch {
  return { signature, accepts, build, parameters }
}

/** Helpers shared by built-in initializer declarations. */
export const initializerKinds = Object.freeze({
  value: (required = true, label?: string, properties?: readonly string[], type?: string): InitializerParameter => ({ kind: 'value', required, label, properties, type }),
  viewBuilder: (required = true, label?: string, type?: string): InitializerParameter => ({ kind: 'viewBuilder', required, label, type }),
  action: (required = true, label?: string, type?: string): InitializerParameter => ({ kind: 'action', required, label, type }),
})

export function acceptsTrailingBuilder(args: readonly unknown[], requiredArguments = 0): boolean {
  return args.length === requiredArguments + 1 && typeof args[args.length - 1] === 'function'
}
