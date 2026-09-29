import {
  collectLogicalViewIdentities,
  collectStateReads,
  edgeInsetsFromCss,
  frameStyle,
  isStateRef,
  renderViewNode,
  subscribeState,
  viewIdentityKey,
  withRenderTransaction,
  zeroGeometry,
  type MunRenderer,
  type CompiledTemplateDescriptor,
  type CompiledTemplateValue,
  type GeometryProxy,
  type LazyViewNode,
  type LazyViewRange,
  type StateRef,
  Transaction,
  Animation,
  type ContentTransition,
  type Transition,
  type ViewGraphValue,
  type ViewHostNode,
  type ViewModifierNode,
} from "@mun/core/compat"
import {
  keyedCollectionChildKey,
  keyedCollectionEntryKey,
  keyedCollectionEntries,
  reactiveIdentity,
  renderViewNodeAt,
  type KeyedCollectionEntry,
  type KeyedCollectionViewNode,
  type CompiledPatchValues,
  type GPUIslandViewNode,
  type StateMutation,
} from "@mun/core/internal/runtime"
import { compositorMotionPropertyMask, layoutMotionPropertyMask, motionPropertyBit, paintMotionPropertyMask } from "@mun/core/internal/motion-abi"
import { renderToHTML } from "./ssr.js"
import { activateReusedHydratedTree, hydratedPropsMatch, hydrateNode } from "./hydration.js"
import { applyDomProps, clearDomEvents, commitStagedDomProps, patchDomProps, setDomRef, synchronizeDomSelectValue, type DomAttributeMotionPolicy, type DomStyleMotionPolicy } from "./props.js"
import { disposeContinuousCorners } from "./continuous-corners.js"
import { animateDomLayout, cancelDomAnimations, type DomLayoutBox } from "./motion.js"
import { recordMunBoundaryDisposed, recordMunBoundaryRender, recordMunRuntimeEvent, munDevtoolsEnabled } from "./devtools.js"
import { classNameOf, cssPropertyName, domContentContainer, nativeElementProps, normalizedRawTextValue, propsOf, rawTextHtmlElements, styleOf, validTableChildElements, voidHtmlElements, type DomRenderContext } from "./shared.js"
import { disposeFocusScope } from "./focus.js"
import { LazyMeasurementIndex, lazyViewportOffset } from "./lazy-index.js"
import { playWebTransition, type WebTransitionPlayback } from "./transition.js"
import { activateWebPresentation, disposeWebPresentation } from "./presentation.js"
import { cancelWebContentTransition, playWebTextContentTransition, prepareWebSymbolContentTransition } from "./content-transition.js"
import { applyPatchIR, definePatchIR, type PatchIR } from "./patch-ir.js"
import { disposeParticleFieldGPUIslandCanvas, mountParticleFieldGPUIslandCanvas } from "./gpu-island.js"

interface DomViewBoundary {
  readonly key: string
  identity: readonly (string | number)[]
  host: unknown
  node: ViewHostNode
  render: (props?: Record<string, unknown>) => Node
  resolvedProps: Record<string, unknown>
  dependencies: Set<StateRef<unknown>>
  readonly subscriptions: Map<StateRef<unknown>, () => void>
  readonly children: Set<string>
  readonly nextChildren: Set<string>
  currentNodes: Node[]
  nextNodes: Node[]
  outerModifiers: ViewModifierNode[]
  parentKey?: string
  /** Cached tree depth used to order dirty boundaries parent-first. */
  depth: number
  pendingTransaction?: Transaction
  readonly pendingMutations: StateMutation[]
  readonly pendingDependencies: Set<StateRef<unknown>>
  compiledPatchPlan?: NonNullable<ViewHostNode["compiledBody"]>
  compiledPatchMasks?: Map<StateRef<unknown>, Uint32Array>
  compiledPatchDirty?: Uint32Array
  scheduled: boolean
  mounted: boolean
  localSafe: boolean
  renderedBody: boolean
}

interface DomCompiledTemplateInstance {
  readonly template: CompiledTemplateDescriptor
  roots: Node[]
  /** Static root props captured before any outer modifiers are staged. */
  readonly rootProps: readonly (Record<string, unknown> | null)[]
  readonly textSlots: Array<Text | undefined>
  /** Live DOM ranges produced by compiler-proven generic View slots. */
  readonly viewSlots: Array<Node[] | undefined>
  /** Stable pre-order host-node table addressed by compiler Patch IR. */
  nodes: Node[]
  /** Last renderer-committed values, used to refine compiler candidate bits. */
  patchValues?: unknown[]
  /** Reused compiler scratch storage for dependency-narrowed patch evaluation. */
  patchScratch?: unknown[]
}

interface DomCompiledTemplateBinding {
  readonly key: string
  readonly index: number
}

interface DomCollectionRow {
  readonly entryKey: string
  readonly baseKey: string
  displayKey: string
  readonly occurrence: number
  readonly key: string | number
  item: unknown
  index: number
  readonly type: string
  props: Record<string, unknown> | null
  textValue: string
  readonly element: Element
  readonly textNode: Text
}

interface DomCollectionInstance {
  readonly key: string
  readonly ownerKey: string
  node: KeyedCollectionViewNode
  sourceIdentity: unknown
  rows: Map<string, DomCollectionRow>
  /** Build the keyed row lookup only when generic reconciliation needs it. */
  rowsDirty?: boolean
  order: DomCollectionRow[]
  rowsByItem: Map<object, DomCollectionRow | Set<DomCollectionRow>>
  /** Rebuild the item-identity index only when a later nested mutation needs it. */
  rowsByItemDirty?: boolean
  actualKeys: Set<string | number>
  occurrenceCounts: Map<string, number>
  /** Build structural key/occurrence indexes only when append/remove needs them. */
  structuralIndexesDirty?: boolean
  pendingTransaction?: Transaction
  readonly pendingMutations: StateMutation[]
  scheduled: boolean
  unsubscribe?: () => void
}

interface DomAnimationDomain {
  /** undefined selects Mun's property-aware automatic timing. */
  readonly animation: Animation | null | undefined
  readonly trigger: unknown
  readonly automatic: boolean
  readonly propertyMask: number
  readonly properties: readonly string[]
}

interface DomMotionRenderState {
  pendingPropertyMask: number
  pendingProperties?: Set<string>
  readonly domains: DomAnimationDomain[]
  /** True when this state only describes modifiers layered onto a reused View. */
  readonly partial: boolean
}

interface DomTransitionState {
  readonly transition: Transition
  readonly animation?: Animation | null
}

interface DomContentTransitionState {
  readonly transition: ContentTransition
  readonly animation?: Animation | null
}

interface DomHydrationReuseState {
  next?: Node
  readonly ancestors: Node[]
  failed: boolean
  readonly elements: Set<Element>
  readonly pendingCollections: DomCollectionInstance[]
}

const directCompiledBodyModifierNames = new Set([
  "padding", "margin", "gap", "font", "fontSize", "bold",
  "foreground", "foregroundStyle", "opacity",
  "fontWeight", "fontDesign", "fontWidth", "italic", "underline", "strikethrough", "monospaced", "monospacedDigit",
  "kerning", "tracking", "baselineOffset", "lineSpacing", "lineLimit", "minimumScaleFactor", "multilineTextAlignment", "truncationMode", "textCase", "allowsTightening",
  "scaleEffect", "rotationEffect", "offset", "aspectRatio", "scaledToFit", "scaledToFill", "fixedSize", "layoutPriority", "position", "zIndex",
  "clipShape", "clipped", "border", "shadow", "blur", "brightness", "contrast", "saturation", "grayscale", "hueRotation", "colorInvert", "colorMultiply", "blendMode", "compositingGroup", "drawingGroup", "luminanceToAlpha", "tint",
  "hidden", "allowsHitTesting", "preferredColorScheme", "controlSize", "scrollDisabled", "scrollIndicators", "scrollBounceBehavior", "scrollClipDisabled", "scrollDismissesKeyboard",
  "accessibilityLabel", "accessibilityHint", "accessibilityValue", "accessibilityHidden", "accessibilityIdentifier", "accessibilityHeading", "accessibilitySortPriority",
  "style", "className", "animation", "animationAuto",
])

function compiledTextSlotValue(value: unknown): { readonly ok: true; readonly value: string } | { readonly ok: false } {
  if (value === null || value === undefined || typeof value === "boolean") return { ok: true, value: "" }
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return { ok: true, value: String(value) }
  return { ok: false }
}

const compiledTemplatePatchPrograms = new WeakMap<object, PatchIR>()

function patchProgram(template: CompiledTemplateDescriptor): PatchIR | undefined {
  if (!template.patchIR) return undefined
  let program = compiledTemplatePatchPrograms.get(template)
  if (!program) {
    program = definePatchIR(template.patchIR.locations)
    compiledTemplatePatchPrograms.set(template, program)
  }
  return program
}

function templateNodeTable(output: Node): Node[] {
  const nodes: Node[] = []
  const visit = (node: Node): void => {
    nodes.push(node)
    const content = node.nodeType === 1 ? domContentContainer(node as Element) : node
    for (let child = content.firstChild; child; child = child.nextSibling) visit(child)
  }
  for (const root of outputNodes(output)) visit(root)
  return nodes
}

const fullPatchDirtyMasks = new WeakMap<PatchIR, Uint32Array>()

function fullPatchCandidates(program: PatchIR, values: readonly unknown[]): CompiledPatchValues {
  let dirty = fullPatchDirtyMasks.get(program)
  if (!dirty) {
    dirty = new Uint32Array(program.dirtyWordCount)
    dirty.fill(0xffff_ffff)
    const remainder = program.locations.length & 31
    if (remainder !== 0) dirty[dirty.length - 1] = (2 ** remainder - 1) >>> 0
    fullPatchDirtyMasks.set(program, dirty)
  }
  return { dirty, values }
}

function rebuildCompiledPatchMasks(
  boundary: DomViewBoundary,
  plan: NonNullable<ViewHostNode["compiledBody"]>,
  program: PatchIR,
): void {
  const mappings = plan.patchDependencyIndices
  boundary.compiledPatchPlan = plan
  boundary.compiledPatchMasks = new Map()
  boundary.compiledPatchDirty = new Uint32Array(program.dirtyWordCount)
  if (!mappings) return
  for (const [propName, indices] of Object.entries(mappings)) {
    const dependency = boundary.resolvedProps[propName]
    if (!isStateRef(dependency) || !boundary.dependencies.has(dependency)) continue
    let mask = boundary.compiledPatchMasks.get(dependency)
    if (!mask) {
      mask = new Uint32Array(program.dirtyWordCount)
      boundary.compiledPatchMasks.set(dependency, mask)
    }
    for (const index of indices) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= program.locations.length) continue
      mask[index >>> 5] |= 1 << (index & 31)
    }
  }
}

/** Resolve pending State identities to one renderer-owned reusable Patch IR mask. */
function dependencyPatchCandidates(
  boundary: DomViewBoundary,
  plan: NonNullable<ViewHostNode["compiledBody"]>,
  program: PatchIR,
): Uint32Array | undefined {
  if (!plan.evaluatePatch || !plan.patchDependencyIndices || boundary.pendingDependencies.size === 0) return undefined
  if (boundary.compiledPatchPlan !== plan || !boundary.compiledPatchMasks || !boundary.compiledPatchDirty) {
    rebuildCompiledPatchMasks(boundary, plan, program)
  }
  let masks = boundary.compiledPatchMasks!
  // State-bearing props can be replaced without changing the compiled plan.
  // Refresh once on a cache miss before conservatively falling back.
  if ([...boundary.pendingDependencies].some(dependency => !masks.has(dependency))) {
    rebuildCompiledPatchMasks(boundary, plan, program)
    masks = boundary.compiledPatchMasks!
  }
  const dirty = boundary.compiledPatchDirty!
  dirty.fill(0)
  for (const dependency of boundary.pendingDependencies) {
    const mask = masks.get(dependency)
    if (!mask) return undefined
    for (let word = 0; word < dirty.length; word += 1) dirty[word] |= mask[word]!
  }
  return dirty.some(word => word !== 0) ? dirty : undefined
}

function applyCompiledPatch(
  instance: DomCompiledTemplateInstance,
  program: PatchIR,
  candidate: CompiledPatchValues,
  context: DomRenderContext,
): boolean {
  if (!(candidate.dirty instanceof Uint32Array)
    || candidate.dirty.length !== program.dirtyWordCount
    || candidate.values.length !== program.locations.length) return false
  const dirty = new Uint32Array(program.dirtyWordCount)
  const nextValues = instance.patchValues ? [...instance.patchValues] : new Array<unknown>(program.locations.length)
  let dirtyCount = 0
  for (let index = 0; index < program.locations.length; index += 1) {
    if ((candidate.dirty[index >>> 5]! & (1 << (index & 31))) === 0) continue
    const value = candidate.values[index]
    if (instance.patchValues && Object.is(instance.patchValues[index], value)) continue
    nextValues[index] = value
    dirty[index >>> 5] |= 1 << (index & 31)
    dirtyCount += 1
  }
  if (dirtyCount > 0) {
    applyPatchIR(instance.nodes, program, { dirty, values: candidate.values })
    for (let index = 0; index < program.locations.length; index += 1) {
      if ((dirty[index >>> 5]! & (1 << (index & 31))) === 0) continue
      const location = program.locations[index]!
      if (location.kind === "text" || location.kind === "child-range") continue
      const node = instance.nodes[location.node]
      if (!node || node.nodeType !== 1) continue
      const element = node as Element
      const remembered = cloneStoredDomProps(context.domProps.get(element)) ?? {}
      if (location.kind === "style") {
        const style = remembered.style && typeof remembered.style === "object"
          ? { ...remembered.style as Record<string, unknown> }
          : {}
        if (candidate.values[index] == null || candidate.values[index] === false) delete style[location.key]
        else style[location.key] = candidate.values[index]
        remembered.style = style
      } else if (location.kind === "class") {
        remembered.class = element.getAttribute("class") ?? ""
      } else if (candidate.values[index] == null || candidate.values[index] === false) {
        delete remembered[location.key]
      } else {
        remembered[location.key] = candidate.values[index]
      }
      context.domProps.set(element, remembered)
      const rootIndex = instance.roots.indexOf(element)
      if (rootIndex >= 0) (instance.rootProps as Array<Record<string, unknown> | null>)[rootIndex] = cloneStoredDomProps(remembered)
    }
  }
  instance.patchValues = nextValues
  return true
}

interface DomViewRuntime {
  readonly boundaries: Map<string, DomViewBoundary>
  readonly nodeKeys: WeakMap<Node, Set<string>>
  readonly reuseCandidates: WeakMap<Node, Node>
  readonly collections: Map<string, DomCollectionInstance>
  readonly collectionKeysByOwner: Map<string, Set<string>>
  /** Baseline props for compiler-template identity carriers. */
  readonly reuseCandidateBaseProps: WeakMap<Node, Record<string, unknown> | null>
  readonly compiledTemplates: Map<string, DomCompiledTemplateInstance>
  readonly compiledTemplateRoots: WeakMap<Node, DomCompiledTemplateBinding>
  readonly compiledTemplateTextSlots: WeakMap<Node, DomCompiledTemplateBinding>
  readonly compiledTemplateViewSlots: WeakMap<Node, DomCompiledTemplateBinding>
  readonly compiledTemplateNodes: WeakMap<Node, DomCompiledTemplateBinding>
  readonly compiledTemplatePatches: WeakMap<Node, () => void>
  /** Per-render animation domains attached by .animation(_:value:). */
  readonly motionStates: WeakMap<Node, DomMotionRenderState>
  readonly transitionStates: WeakMap<Node, DomTransitionState>
  readonly contentTransitionStates: WeakMap<Node, DomContentTransitionState>
  readonly enteredTransitions: WeakSet<Node>
  readonly exitTransitions: Map<Node, WebTransitionPlayback>
  readonly animationsDisabled: () => boolean
  transitionLayer?: HTMLElement
  /** Geometry reads are collected before a mutation and committed as one FLIP batch. */
  readonly layoutSnapshots: Map<Element, { readonly before: DomLayoutBox; animation: Animation }>
  /** Last animation used to snapshot one sibling neighborhood in this pass. */
  readonly layoutNeighborhoodAnimations: Map<Node, Animation>
  readonly stack: string[]
  renderedKeys: Set<string>
  passVisitedStates: Set<string>
  readonly rootChildren: Set<string>
  readonly rootNextChildren: Set<string>
  forceAll: boolean
  replayingModifiers: boolean
  suppressCollectionDirect: boolean
  hydrationReuse?: DomHydrationReuseState
  boundaryRootKey?: string
  invalidateBoundary?: (key: string, transaction: Transaction | undefined, mutations: readonly StateMutation[]) => void
  materializeView?: (
    node: ViewHostNode,
    render: (props?: Record<string, unknown>) => Node,
    identity: readonly (string | number)[],
    force?: boolean,
  ) => Node
}

const domViewRuntimes = new WeakMap<DomRenderContext, DomViewRuntime>()
const hydrationVirtualRoots = new WeakMap<Node, readonly Node[]>()
const emptyMotionProperties = Object.freeze([]) as readonly string[]

function runtimeFor(context: DomRenderContext): DomViewRuntime | undefined {
  return domViewRuntimes.get(context)
}

const layoutAffectingMotionProperties = new Set([
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "gap", "row-gap", "column-gap", "font", "font-size", "line-height",
  "letter-spacing", "word-spacing", "border-width", "border-top-width",
  "border-right-width", "border-bottom-width", "border-left-width",
  "flex-basis", "grid-template-columns", "grid-template-rows",
])

// Smart .animation() profiles. They are immutable singletons, so motion-plan
// compilation is cached once and every property channel can share the result.
const automaticTransformAnimation = Animation.spring(0.3, 0.86)
const automaticLayoutAnimation = Animation.spring(0.34, 0.9)
const automaticOpacityAnimation = Animation.easeOut(0.18)
const automaticColorAnimation = Animation.easeInOut(0.2)
const automaticDefaultAnimation = Animation.easeInOut(0.22)
const automaticSymbolContentAnimation = Animation.spring(0.28, 0.86)
const automaticTextContentAnimation = Animation.easeInOut(0.2)
const contentMotionProperty = "--mun-content"

function automaticAnimationForProperty(property: string): Animation {
  if (property === "opacity") return automaticOpacityAnimation
  const bit = motionPropertyBit(property)
  if (bit !== 0 && (bit & compositorMotionPropertyMask) !== 0) return automaticTransformAnimation
  if ((bit !== 0 && (bit & paintMotionPropertyMask) !== 0) || property.endsWith("-color")) return automaticColorAnimation
  if ((bit !== 0 && (bit & layoutMotionPropertyMask) !== 0) || layoutAffectingMotionProperties.has(property)) return automaticLayoutAnimation
  return automaticDefaultAnimation
}

function motionStateFor(node: Node, runtime: DomViewRuntime): DomMotionRenderState {
  let state = runtime.motionStates.get(node)
  if (!state) {
    state = { pendingPropertyMask: 0, domains: [], partial: node.nodeType === 8 }
    runtime.motionStates.set(node, state)
  }
  return state
}

function recordMotionProperty(state: DomMotionRenderState, property: string): void {
  const bit = motionPropertyBit(property)
  if (bit !== 0) state.pendingPropertyMask = (state.pendingPropertyMask | bit) >>> 0
  else (state.pendingProperties ??= new Set()).add(property)
}

function takePendingMotionProperties(state: DomMotionRenderState): Pick<DomAnimationDomain, "propertyMask" | "properties"> {
  const propertyMask = state.pendingPropertyMask >>> 0
  const properties = state.pendingProperties?.size ? [...state.pendingProperties] : emptyMotionProperties
  state.pendingPropertyMask = 0
  state.pendingProperties?.clear()
  return { propertyMask, properties }
}

function clearPendingMotionProperties(state: DomMotionRenderState): void {
  state.pendingPropertyMask = 0
  state.pendingProperties?.clear()
}

function recordMotionStyleProperties(content: Node, properties: readonly string[], context: DomRenderContext): void {
  if (properties.length === 0) return
  const runtime = runtimeFor(context)
  if (!runtime) return
  for (const node of outputNodes(content)) {
    if (node.nodeType !== 1 && node.nodeType !== 8) continue
    const state = motionStateFor(node, runtime)
    for (const property of properties) recordMotionProperty(state, property)
  }
}

function animationDomainArguments(arguments_: readonly unknown[]): Pick<DomAnimationDomain, "animation" | "trigger" | "automatic" | "propertyMask" | "properties"> {
  const automatic = arguments_.length < 2
  const rawAnimation = arguments_[0]
  const animation = arguments_.length === 0
    ? undefined
    : rawAnimation && typeof rawAnimation === "object"
      ? rawAnimation as Animation
      : null
  return { animation, trigger: arguments_[1], automatic, propertyMask: 0, properties: emptyMotionProperties }
}

function recordAnimationDomain(content: Node, arguments_: readonly unknown[], context: DomRenderContext): void {
  const runtime = runtimeFor(context)
  if (!runtime) return
  const domain = animationDomainArguments(arguments_)
  for (const node of outputNodes(content)) {
    if (node.nodeType !== 1 && node.nodeType !== 8) continue
    const state = motionStateFor(node, runtime)
    state.domains.push({ ...domain, ...takePendingMotionProperties(state) })
  }
}

function recordCompiledAutoAnimationDomain(content: Node, arguments_: readonly unknown[], context: DomRenderContext): void {
  const runtime = runtimeFor(context)
  if (!runtime) return
  for (const node of outputNodes(content)) {
    if (node.nodeType !== 1 && node.nodeType !== 8) continue
    const state = motionStateFor(node, runtime)
    state.domains.push({
      animation: undefined,
      trigger: undefined,
      automatic: true,
      propertyMask: typeof arguments_[0] === "number" ? arguments_[0] >>> 0 : state.pendingPropertyMask,
      properties: Array.isArray(arguments_[1]) ? arguments_[1] as string[] : (state.pendingProperties?.size ? [...state.pendingProperties] : emptyMotionProperties),
    })
    clearPendingMotionProperties(state)
  }
}

function copyMotionRenderState(source: Node, target: Node, runtime: DomViewRuntime): void {
  const state = runtime.motionStates.get(source)
  if (!state) return
  runtime.motionStates.set(target, {
    pendingPropertyMask: state.pendingPropertyMask,
    pendingProperties: state.pendingProperties?.size ? new Set(state.pendingProperties) : undefined,
    domains: state.domains.map(domain => ({ ...domain, properties: domain.properties.length > 0 ? [...domain.properties] : emptyMotionProperties })),
    partial: state.partial,
  })
}

interface ResolvedMotionState {
  readonly policy?: DomStyleMotionPolicy
  readonly merged?: DomMotionRenderState
  /** undefined inherits the active transaction, null explicitly disables layout motion. */
  readonly layoutAnimation?: Animation | null
  /** Empty animation domains may own intrinsic renderer content such as SVG Path.d. */
  readonly intrinsicAnimation?: Animation | null
}

function changedStyleProperties(
  live: Element,
  nextProps: Record<string, unknown> | null | undefined,
  context: DomRenderContext,
): { readonly propertyMask: number; readonly properties?: ReadonlySet<string> } | undefined {
  const previousStyle = context.domProps.get(live)?.style
  const nextStyle = nextProps?.style
  if ((previousStyle === undefined || previousStyle === null) && (nextStyle === undefined || nextStyle === null)) return { propertyMask: 0 }
  if (typeof previousStyle !== "object" || previousStyle === null || typeof nextStyle !== "object" || nextStyle === null) return undefined
  const before = previousStyle as Record<string, unknown>
  const after = nextStyle as Record<string, unknown>
  let propertyMask = 0
  let changed: Set<string> | undefined
  const record = (key: string) => {
    if (Object.is(before[key], after[key])) return
    const property = cssPropertyName(key)
    const bit = motionPropertyBit(property)
    if (bit) propertyMask = (propertyMask | bit) >>> 0
    else (changed ??= new Set()).add(property)
  }
  for (const key of Object.keys(before)) record(key)
  for (const key of Object.keys(after)) if (!Object.prototype.hasOwnProperty.call(before, key)) record(key)
  return { propertyMask, properties: changed }
}

function motionDomainIsEmpty(domain: DomAnimationDomain): boolean { return domain.propertyMask === 0 && domain.properties.length === 0 }
function motionDomainContainsProperty(domain: DomAnimationDomain, property: string): boolean {
  const bit = motionPropertyBit(property)
  return bit !== 0 ? (domain.propertyMask & bit) !== 0 : domain.properties.includes(property)
}

function resolveMotionRenderState(
  live: Element,
  nextState: DomMotionRenderState,
  context: DomRenderContext,
  nextProps?: Record<string, unknown> | null,
): ResolvedMotionState {
  const runtime = runtimeFor(context)
  if (!runtime) return {}
  const previous = runtime.motionStates.get(live)
  const previousDomains = previous?.domains ?? []
  const offset = nextState.partial ? Math.max(0, previousDomains.length - nextState.domains.length) : 0
  const comparedPrevious = nextState.partial ? previousDomains.slice(offset) : previousDomains
  // Automatic domains do not need a synthetic trigger. Reconciliation already
  // runs only for a dependency change, and the style patcher filters unchanged
  // values property-by-property. Explicit value domains keep SwiftUI semantics.
  const changed = nextState.domains.map((domain, index) => domain.automatic
    || !Object.is(domain.trigger, comparedPrevious[index]?.trigger))
  const mergedDomains = nextState.partial
    ? [...previousDomains.slice(0, offset), ...nextState.domains]
    : [...nextState.domains]
  const merged: DomMotionRenderState = {
    pendingPropertyMask: nextState.pendingPropertyMask,
    pendingProperties: nextState.pendingProperties?.size ? new Set(nextState.pendingProperties) : undefined,
    domains: mergedDomains.map(domain => ({ ...domain, properties: domain.properties.length > 0 ? [...domain.properties] : emptyMotionProperties })),
    partial: false,
  }
  const changedStyles = changedStyleProperties(live, nextProps, context)

  let layoutAnimation: Animation | null | undefined
  let hasLayoutDecision = false
  for (let index = nextState.domains.length - 1; index >= 0; index -= 1) {
    const domain = nextState.domains[index]
    if (!changed[index]) continue
    const knownLayout = domain.propertyMask & layoutMotionPropertyMask
    const hasChangedLayoutProperty = (knownLayout !== 0 && (changedStyles === undefined || (knownLayout & changedStyles.propertyMask) !== 0))
      || domain.properties.some(property => layoutAffectingMotionProperties.has(property) && (changedStyles === undefined || changedStyles.properties?.has(property) === true))
    if (motionDomainIsEmpty(domain) || hasChangedLayoutProperty) {
      layoutAnimation = domain.animation === undefined ? automaticLayoutAnimation : domain.animation
      hasLayoutDecision = true
      break
    }
  }
  if (!hasLayoutDecision) {
    for (let index = nextState.domains.length - 1; index >= 0; index -= 1) {
      const domain = nextState.domains[index]
      if (!changed[index]) continue
      // An empty domain means the compiler/runtime could not narrow the change
      // to authored style properties. Keep intrinsic-content FLIP in that case,
      // but do not force layout reads for a known compositor/paint-only domain.
      if (!motionDomainIsEmpty(domain)) continue
      layoutAnimation = domain.animation === undefined ? automaticLayoutAnimation : domain.animation
      hasLayoutDecision = true
      break
    }
  }

  const policy: DomStyleMotionPolicy = {
    animationForProperty(property) {
      for (let index = nextState.domains.length - 1; index >= 0; index -= 1) {
        const domain = nextState.domains[index]
        if (!motionDomainContainsProperty(domain, property)) continue
        if (!changed[index]) return undefined
        return domain.animation === undefined ? automaticAnimationForProperty(property) : domain.animation
      }
      return undefined
    },
  }
  let intrinsicAnimation: Animation | null | undefined
  for (let index = nextState.domains.length - 1; index >= 0; index -= 1) {
    const domain = nextState.domains[index]
    if (!changed[index] || !motionDomainIsEmpty(domain)) continue
    intrinsicAnimation = domain.animation === undefined ? automaticSymbolContentAnimation : domain.animation
    break
  }
  return { policy, merged, layoutAnimation, intrinsicAnimation }
}

function resolveMotionState(
  live: Element,
  candidate: Node,
  context: DomRenderContext,
): ResolvedMotionState {
  const runtime = runtimeFor(context)
  const nextState = runtime?.motionStates.get(candidate)
  const nextProps = candidate.nodeType === 1 ? context.domProps.get(candidate as Element) : undefined
  return nextState ? resolveMotionRenderState(live, nextState, context, nextProps) : {}
}

function automaticContentAnimation(transition: ContentTransition): Animation {
  return transition.descriptor.kind === "symbolEffect" ? automaticSymbolContentAnimation : automaticTextContentAnimation
}

function resolveContentTransitionState(
  live: Element,
  candidate: Element,
  context: DomRenderContext,
): DomContentTransitionState | undefined {
  const runtime = runtimeFor(context)
  const next = runtime?.contentTransitionStates.get(candidate)
  if (!runtime || !next) return undefined
  if (runtime.animationsDisabled() || context.activeTransaction?.disablesAnimations) {
    return { transition: next.transition, animation: null }
  }
  const nextMotion = runtime.motionStates.get(candidate)
  const previousMotion = runtime.motionStates.get(live)
  if (nextMotion) {
    const previousDomains = previousMotion?.domains ?? []
    const offset = nextMotion.partial ? Math.max(0, previousDomains.length - nextMotion.domains.length) : 0
    const comparedPrevious = nextMotion.partial ? previousDomains.slice(offset) : previousDomains
    for (let index = nextMotion.domains.length - 1; index >= 0; index -= 1) {
      const domain = nextMotion.domains[index]
      if (!motionDomainContainsProperty(domain, contentMotionProperty)) continue
      const changed = domain.automatic || !Object.is(domain.trigger, comparedPrevious[index]?.trigger)
      if (!changed) return { transition: next.transition, animation: null }
      return {
        transition: next.transition,
        animation: domain.animation === undefined ? automaticContentAnimation(next.transition) : domain.animation,
      }
    }
  }
  return { transition: next.transition, animation: context.activeTransaction?.animation ?? next.animation }
}

function contentAttributeMotionPolicy(element: Element, context: DomRenderContext): DomAttributeMotionPolicy | undefined {
  if (!element.hasAttribute("data-mun-symbol-layer")) return undefined
  const parent = element.parentElement
  const state = parent ? runtimeFor(context)?.contentTransitionStates.get(parent) : undefined
  if (!state || state.transition.descriptor.kind !== "symbolEffect" || !state.animation) return undefined
  return {
    animationForAttribute(attribute, from, to) {
      if (Object.is(from, to) || from === undefined || from === null || to === undefined || to === null) return undefined
      return attribute === "d" || attribute === "fill" || attribute === "stroke" || attribute === "stroke-width" || attribute === "opacity"
        ? state.animation
        : undefined
    },
  }
}

function intrinsicAttributeMotionPolicy(element: Element, resolved: ResolvedMotionState): DomAttributeMotionPolicy | undefined {
  const animation = resolved.intrinsicAnimation
  if (!animation || element.getAttribute("data-mun") !== "Path") return undefined
  return {
    animationForAttribute(attribute, from, to) {
      return attribute === "d" && from !== undefined && from !== null && to !== undefined && to !== null && !Object.is(from, to)
        ? animation
        : undefined
    },
  }
}

function commitResolvedMotionState(live: Element, resolved: ResolvedMotionState, context: DomRenderContext): void {
  const runtime = runtimeFor(context)
  if (!runtime) return
  if (resolved.merged) runtime.motionStates.set(live, resolved.merged)
}

function readLayoutBox(element: Element): DomLayoutBox | undefined {
  const read = (element as Element & { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect
  if (typeof read !== "function") return undefined
  const rect = read.call(element)
  const box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  return Object.values(box).every(Number.isFinite) && box.width > 0 && box.height > 0 ? box : undefined
}

function captureLayoutElement(element: Element, animation: Animation | null | undefined, context: DomRenderContext): void {
  if (context.activeTransaction?.disablesAnimations) return
  const selected = animation === undefined ? context.activeTransaction?.animation : animation
  if (!selected) return
  const runtime = runtimeFor(context)
  if (!runtime) return
  const existing = runtime.layoutSnapshots.get(element)
  if (existing) {
    // A property-scoped .animation(value:) discovered later in reconciliation
    // is more specific than the surrounding transaction. Keep the first box,
    // but allow the animation plan to be upgraded before commit.
    if (animation !== undefined && animation !== null) existing.animation = animation
    return
  }
  const before = readLayoutBox(element)
  if (before) runtime.layoutSnapshots.set(element, { before, animation: selected })
}

function captureLayoutNeighborhood(element: Element, animation: Animation | null | undefined, context: DomRenderContext): void {
  if (context.activeTransaction?.disablesAnimations) return
  const selected = animation === undefined ? context.activeTransaction?.animation : animation
  if (selected == null) return
  captureLayoutElement(element, animation, context)
  const parent = element.parentElement
  if (!parent) return
  const runtime = runtimeFor(context)
  if (!runtime) return
  // A wide update can touch hundreds or thousands of siblings under the same
  // transaction. The first changed child captures the whole neighborhood;
  // repeating the same scan for every sibling is O(n^2) even though
  // captureLayoutElement already deduplicates each geometry read.
  // Re-scan only when a different animation policy arrives, preserving the
  // existing latest-specific-animation behavior for mixed domains.
  if (runtime.layoutNeighborhoodAnimations.get(parent) === selected) return
  runtime.layoutNeighborhoodAnimations.set(parent, selected)
  // A size change can move siblings without changing their own props. Capture
  // the local sibling set before the mutation so those positional changes can
  // receive the same semantic animation without scanning the whole document.
  for (const sibling of parent.children) captureLayoutElement(sibling, animation, context)
}

function captureLayoutChildren(parent: Node, animation: Animation | null | undefined, context: DomRenderContext): void {
  if (context.activeTransaction?.disablesAnimations) return
  const selected = animation === undefined ? context.activeTransaction?.animation : animation
  if (selected == null) return
  const runtime = runtimeFor(context)
  if (runtime) runtime.layoutNeighborhoodAnimations.set(parent, selected)
  if (parent.nodeType === 1) captureLayoutElement(parent as Element, animation, context)
  for (const child of parent.childNodes) {
    if (child.nodeType === 1) captureLayoutElement(child as Element, animation, context)
  }
}

function clearLayoutCaptures(runtime: DomViewRuntime): void {
  runtime.layoutSnapshots.clear()
  runtime.layoutNeighborhoodAnimations.clear()
}

function flushLayoutMotion(context: DomRenderContext): void {
  const runtime = runtimeFor(context)
  if (!runtime) return
  if (runtime.layoutSnapshots.size === 0) {
    runtime.layoutNeighborhoodAnimations.clear()
    return
  }
  const changed: Array<{ readonly element: Element; readonly before: DomLayoutBox; readonly after: DomLayoutBox; readonly animation: Animation }> = []
  for (const [element, snapshot] of runtime.layoutSnapshots) {
    const after = readLayoutBox(element)
    if (!after) continue
    const { before } = snapshot
    const differs = Math.abs(before.left - after.left) >= 0.01
      || Math.abs(before.top - after.top) >= 0.01
      || Math.abs(before.width - after.width) >= 0.01
      || Math.abs(before.height - after.height) >= 0.01
    if (differs) changed.push({ element, before, after, animation: snapshot.animation })
  }
  clearLayoutCaptures(runtime)

  const changedElements = new Map(changed.map(entry => [entry.element, entry] as const))
  for (const entry of changed) {
    // When an ancestor and descendant are being driven by the exact same plan,
    // animating both FLIP transforms would double-apply the same geometric
    // movement. Let the nearest changed ancestor carry that visual delta. A
    // descendant with a different Animation remains independent by design.
    let ancestor = entry.element.parentElement
    let covered = false
    while (ancestor) {
      const parentChange = changedElements.get(ancestor)
      if (parentChange && parentChange.animation === entry.animation) {
        covered = true
        break
      }
      ancestor = ancestor.parentElement
    }
    if (!covered) animateDomLayout(entry.element, entry.before, entry.after, entry.animation)
  }
}

function shallowRecordEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  if (left === right) return true
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || !Object.is(left[key], right[key])) return false
  }
  return true
}

function outputNodes(output: Node): Node[] {
  const virtual = hydrationVirtualRoots.get(output)
  if (virtual) return [...virtual]
  return output.nodeType === 11 ? [...output.childNodes] : [output]
}

function directChildNodes(parent: Node): Node[] {
  const nodes: Node[] = []
  for (let child = parent.firstChild; child; child = child.nextSibling) nodes.push(child)
  return nodes
}

function descendHydrationPostorder(node: Node, reuse: DomHydrationReuseState): Node {
  let current = node
  while (true) {
    const content = current.nodeType === 1 ? domContentContainer(current as Element) : current
    const child = content.firstChild
    if (!child) return current
    reuse.ancestors.push(current)
    current = child
  }
}

function advanceHydrationPostorder(node: Node, reuse: DomHydrationReuseState): Node | undefined {
  if (node.nextSibling) return descendHydrationPostorder(node.nextSibling, reuse)
  return reuse.ancestors.pop()
}

function nextHydrationNode(runtime: DomViewRuntime | undefined): Node | undefined {
  const reuse = runtime?.hydrationReuse
  if (!reuse) return undefined
  const node = reuse.next
  if (!node) reuse.failed = true
  else reuse.next = advanceHydrationPostorder(node, reuse)
  return node
}

function hydrationChildrenMatch(element: Element, children: readonly Node[]): boolean {
  const content = domContentContainer(element)
  let live = content.firstChild
  for (const child of children) {
    const virtual = hydrationVirtualRoots.get(child)
    if (virtual) {
      for (const node of virtual) {
        if (live !== node) return false
        live = live.nextSibling
      }
      continue
    }
    if (child.nodeType === 11) {
      for (let node = child.firstChild; node; node = node.nextSibling) {
        if (live !== node) return false
        live = live.nextSibling
      }
      continue
    }
    if (live !== child) return false
    live = live.nextSibling
  }
  return live === null
}

function addBoundaryKey(node: Node, key: string, runtime: DomViewRuntime): void {
  const keys = runtime.nodeKeys.get(node) ?? new Set<string>()
  keys.add(key)
  runtime.nodeKeys.set(node, keys)
}

function markBoundaryOutput(output: Node, key: string, runtime: DomViewRuntime): void {
  outputNodes(output).forEach(node => addBoundaryKey(node, key, runtime))
}

function bindCandidateNode(candidate: Node, live: Node, context: DomRenderContext): void {
  const runtime = runtimeFor(context)
  if (!runtime) return
  if (candidate !== live && candidate.nodeType === 1) context.refElements.delete(candidate as Element)

  // Compiled-template bindings are renderer metadata just like View-boundary
  // identities. Transfer them before the boundary early-return so text-only
  // templates also work outside defineView() boundaries and during hydration.
  const rootBinding = runtime.compiledTemplateRoots.get(candidate)
  if (rootBinding) {
    const instance = runtime.compiledTemplates.get(rootBinding.key)
    if (instance && rootBinding.index < instance.roots.length) instance.roots[rootBinding.index] = live
    runtime.compiledTemplateRoots.set(live, rootBinding)
  }
  const slotBinding = runtime.compiledTemplateTextSlots.get(candidate)
  if (slotBinding && live.nodeType === 3) {
    const instance = runtime.compiledTemplates.get(slotBinding.key)
    if (instance && slotBinding.index < instance.textSlots.length) instance.textSlots[slotBinding.index] = live as Text
    runtime.compiledTemplateTextSlots.set(live, slotBinding)
  }
  const viewSlotBinding = runtime.compiledTemplateViewSlots.get(candidate)
  if (viewSlotBinding) {
    const instance = runtime.compiledTemplates.get(viewSlotBinding.key)
    const nodes = instance?.viewSlots[viewSlotBinding.index]
    if (instance && nodes) {
      const position = nodes.indexOf(candidate)
      if (position >= 0 && candidate !== live) {
        const nextNodes = [...nodes]
        nextNodes[position] = live
        instance.viewSlots[viewSlotBinding.index] = nextNodes
      }
    }
    runtime.compiledTemplateViewSlots.set(live, viewSlotBinding)
  }
  const nodeBinding = runtime.compiledTemplateNodes.get(candidate)
  if (nodeBinding) {
    const instance = runtime.compiledTemplates.get(nodeBinding.key)
    if (instance && nodeBinding.index < instance.nodes.length) instance.nodes[nodeBinding.index] = live
    runtime.compiledTemplateNodes.set(live, nodeBinding)
  }
  const candidateMotion = runtime.motionStates.get(candidate)
  if (candidateMotion && live.nodeType === 1) {
    runtime.motionStates.set(live, {
      pendingPropertyMask: candidateMotion.pendingPropertyMask,
      pendingProperties: candidateMotion.pendingProperties?.size ? new Set(candidateMotion.pendingProperties) : undefined,
      domains: candidateMotion.domains.map(domain => ({ ...domain, properties: domain.properties.length > 0 ? [...domain.properties] : emptyMotionProperties })),
      partial: false,
    })
  }
  const candidateTransition = runtime.transitionStates.get(candidate)
  if (candidateTransition && live.nodeType === 1) runtime.transitionStates.set(live, candidateTransition)
  const candidateContentTransition = runtime.contentTransitionStates.get(candidate)
  if (candidateContentTransition && live.nodeType === 1) runtime.contentTransitionStates.set(live, candidateContentTransition)

  const candidateKeys = runtime.nodeKeys.get(candidate)
  if (!candidateKeys || candidateKeys.size === 0) return
  const liveKeys = runtime.nodeKeys.get(live) ?? new Set<string>()
  for (const key of candidateKeys) {
    liveKeys.add(key)
    const boundary = runtime.boundaries.get(key)
    // commitViewPass already canonicalizes nextNodes through a Set. Avoid an
    // O(n) includes() probe for every root of a wide fragment here; doing both
    // made a boundary with n output nodes pay O(n^2) merely to deduplicate.
    if (boundary) boundary.nextNodes.push(live)
  }
  runtime.nodeKeys.set(live, liveKeys)
}

function commitStagedSubtree(node: Node, context: DomRenderContext): void {
  if (node.nodeType === 1) commitStagedDomProps(node as Element, context)
  const content = node.nodeType === 1 ? domContentContainer(node as Element) : node
  // Prop activation does not structurally mutate this detached subtree, so a
  // live indexed walk is safe and avoids allocating one child-array per leaf.
  for (let index = 0; index < content.childNodes.length; index += 1) {
    commitStagedSubtree(content.childNodes[index], context)
  }
  if (node.nodeType === 1) synchronizeDomSelectValue(node as Element, context.domProps.get(node as Element))
}

function activateDomPresentation(node: Node): void {
  if (node.nodeType !== 1) return
  const element = node as HTMLElement
  if (!element.hasAttribute("data-mun-presentation")) return
  queueMicrotask(() => {
    if (!element.isConnected) return
    activateWebPresentation(element)
  })
}

function activateDomTransition(node: Node, context: DomRenderContext): void {
  if (node.nodeType !== 1) return
  const runtime = runtimeFor(context)
  if (!runtime || runtime.enteredTransitions.has(node)) return
  const state = runtime.transitionStates.get(node)
  if (!state) return
  runtime.enteredTransitions.add(node)
  if (runtime.animationsDisabled()) return
  if (state.transition.descriptor.insertion.length === 0) return
  playWebTransition(node as Element, state.transition, true, state.animation)
}

function ensureTransitionLayer(context: DomRenderContext): HTMLElement | undefined {
  const runtime = runtimeFor(context)
  if (!runtime) return undefined
  if (runtime.transitionLayer?.isConnected) return runtime.transitionLayer
  const body = context.document.body
  if (!body) return undefined
  const layer = context.document.createElement("div")
  layer.setAttribute("data-mun-transition-layer", "")
  layer.setAttribute("aria-hidden", "true")
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;overflow:visible;z-index:2147483646;contain:layout style;"
  body.appendChild(layer)
  runtime.transitionLayer = layer
  return layer
}

function canExitWithTransition(node: Node, context: DomRenderContext): boolean {
  if (node.nodeType !== 1) return false
  const runtime = runtimeFor(context)
  const state = runtime?.transitionStates.get(node)
  return Boolean(runtime && !runtime.animationsDisabled() && state && state.transition.descriptor.removal.length > 0 && context.document.body)
}

function beginExitTransition(parent: Node, node: Node, context: DomRenderContext): boolean {
  if (!canExitWithTransition(node, context) || node.parentNode !== parent) return false
  const runtime = runtimeFor(context)
  const state = runtime?.transitionStates.get(node)
  if (!runtime || !state) return false
  if (runtime.exitTransitions.has(node)) return true
  const layer = ensureTransitionLayer(context)
  if (!layer) return false

  const element = node as HTMLElement
  const rect = safeBoundingRect(element)
	// Native dialog/popover elements live in the browser top layer. Moving the
	// live presentation into our transition layer can either make it disappear
	// immediately (closed dialog) or leave native top-layer state attached to a
	// node that is no longer part of reconciliation. Animate a visual clone for
	// presentation exits and release the live node immediately instead. Normal
	// elements keep using the live node so local DOM state is preserved during
	// their exit animation.
	const isPresentation = element.hasAttribute("data-mun-presentation")
	const transitionElement = isPresentation ? element.cloneNode(true) as HTMLElement : element
	if (isPresentation) {
		releaseDomSubtree(node, context)
		if (node.parentNode === parent) parent.removeChild(node)
	}
	layer.appendChild(transitionElement)
  if (rect) {
		transitionElement.style.position = "fixed"
		transitionElement.style.left = `${rect.left}px`
		transitionElement.style.top = `${rect.top}px`
		if (rect.width > 0) transitionElement.style.width = `${rect.width}px`
		if (rect.height > 0) transitionElement.style.height = `${rect.height}px`
		transitionElement.style.margin = "0"
		transitionElement.style.pointerEvents = "none"
		transitionElement.style.boxSizing = "border-box"
  }

	const playback = playWebTransition(transitionElement, state.transition, false, state.animation, () => {
    runtime.exitTransitions.delete(node)
		try {
			if (!isPresentation) releaseDomSubtree(node, context)
		} finally {
			try { transitionElement.parentNode?.removeChild(transitionElement) } catch { /* detached during teardown */ }
      if (runtime.transitionLayer && runtime.transitionLayer.childNodes.length === 0) {
        try { runtime.transitionLayer.remove() } catch { /* detached */ }
        runtime.transitionLayer = undefined
      }
    }
  })
  runtime.exitTransitions.set(node, playback)
  return true
}

function removeDomNode(parent: Node, node: Node, context: DomRenderContext): void {
  if (beginExitTransition(parent, node, context)) return
  releaseDomSubtree(node, context)
  if (node.parentNode === parent) parent.removeChild(node)
}

function bindInsertedSubtree(node: Node, context: DomRenderContext): void {
  const runtime = runtimeFor(context)
  const reusable = runtime?.reuseCandidates.get(node)
  if (reusable && reusable !== node && node.parentNode) {
    // A reused View may be carried through a newly-created ancestor. Patch any
    // staged outer modifiers onto the original root, then move that live node
    // into the candidate position instead of committing a clone/placeholder.
    if (node.nodeType === 1 && reusable.nodeType === 1) {
      reconcileDomNode(reusable.parentNode ?? node.parentNode, reusable, node, context)
    }
    const parent = node.parentNode
    parent.replaceChild(reusable, node)
    bindCandidateNode(node, reusable, context)
    bindInsertedSubtree(reusable, context)
    return
  }
  if (node.parentNode && nodeKey(node, context) !== undefined) context.keyedParents.add(node.parentNode)
  bindCandidateNode(node, node, context)
  // commitStagedSubtree() has already activated props (including events) for
  // every newly inserted descendant. This phase only binds runtime metadata;
  // walking props again would repeat event-map work for every live element.
  const content = node.nodeType === 1 ? domContentContainer(node as Element) : node
  if (content.childNodes.length > 0) {
    // Reused candidates may replace themselves while binding, so snapshot only
    // non-empty child ranges. Flat leaf-heavy trees avoid thousands of empty
    // temporary arrays while keeping replacement semantics unchanged.
    for (const child of [...content.childNodes]) bindInsertedSubtree(child, context)
  }
  activateDomPresentation(node)
  activateDomTransition(node, context)
}

function bindHydratedSubtree(candidate: Node, live: Node, context: DomRenderContext): void {
  bindCandidateNode(candidate, live, context)
  const candidateContent = candidate.nodeType === 1 ? domContentContainer(candidate as Element) : candidate
  const liveContent = live.nodeType === 1 ? domContentContainer(live as Element) : live
  let candidateChild = candidateContent.firstChild
  let liveChild = liveContent.firstChild
  while (candidateChild && liveChild) {
    bindHydratedSubtree(candidateChild, liveChild, context)
    candidateChild = candidateChild.nextSibling
    liveChild = liveChild.nextSibling
  }
}

function copyCandidateMetadata(source: Node, target: Node, context: DomRenderContext): void {
  const runtime = runtimeFor(context)
  const props = source.nodeType === 1 ? context.domProps.get(source as Element) : undefined
  if (props && target.nodeType === 1) {
    context.domProps.set(target as Element, {
      ...props,
      ...(props.style && typeof props.style === "object" ? { style: { ...(props.style as Record<string, unknown>) } } : {}),
    })
  }
  const key = context.domKeys.get(source)
  if (key !== undefined) context.domKeys.set(target, key)
  if (source.nodeType === 1 && target.nodeType === 1) {
    const tag = context.domTags.get(source as Element)
    if (tag !== undefined) context.domTags.set(target as Element, tag)
    const lazyKey = context.lazyKeys.get(source)
    if (lazyKey !== undefined) context.lazyKeys.set(target, lazyKey)
  }
  if (runtime) {
    const boundaryKeys = runtime.nodeKeys.get(source)
    if (boundaryKeys) runtime.nodeKeys.set(target, new Set(boundaryKeys))
    const rootBinding = runtime.compiledTemplateRoots.get(source)
    if (rootBinding) runtime.compiledTemplateRoots.set(target, rootBinding)
    const slotBinding = runtime.compiledTemplateTextSlots.get(source)
    if (slotBinding) runtime.compiledTemplateTextSlots.set(target, slotBinding)
    const viewSlotBinding = runtime.compiledTemplateViewSlots.get(source)
    if (viewSlotBinding) runtime.compiledTemplateViewSlots.set(target, viewSlotBinding)
    const nodeBinding = runtime.compiledTemplateNodes.get(source)
    if (nodeBinding) runtime.compiledTemplateNodes.set(target, nodeBinding)
    copyMotionRenderState(source, target, runtime)
    const transition = runtime.transitionStates.get(source)
    if (transition) runtime.transitionStates.set(target, transition)
    const contentTransition = runtime.contentTransitionStates.get(source)
    if (contentTransition) runtime.contentTransitionStates.set(target, contentTransition)
    runtime.reuseCandidates.set(target, source)
  }
}

function reusableBoundaryCandidate(current: Node, context: DomRenderContext): Node {
  // Unchanged View boundaries only need an identity carrier while their parent
  // is staged. A comment avoids cloning real DOM nodes and their attributes.
  const candidate = context.document.createComment("mun-reuse")
  copyCandidateMetadata(current, candidate, context)
  return candidate
}

function cloneStoredDomProps(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!value) return null
  const style = value.style && typeof value.style === "object" ? value.style as Record<string, unknown> : undefined
  return { ...value, ...(style ? { style: { ...style } } : {}) }
}

function reusableCompiledTemplateCandidate(
  current: Node,
  baseProps: Record<string, unknown> | null,
  context: DomRenderContext,
): Node {
  const candidate = reusableBoundaryCandidate(current, context)
  runtimeFor(context)?.reuseCandidateBaseProps.set(candidate, cloneStoredDomProps(baseProps))
  return candidate
}

function reusableBoundaryOutput(boundary: DomViewBoundary, context: DomRenderContext): Node {
  if (boundary.currentNodes.length === 1) return reusableBoundaryCandidate(boundary.currentNodes[0], context)
  const fragment = context.document.createDocumentFragment()
  for (const current of boundary.currentNodes) fragment.appendChild(reusableBoundaryCandidate(current, context))
  return fragment
}

function promoteReusableCandidate(candidate: Node, context: DomRenderContext): Node {
  const runtime = runtimeFor(context)
  const live = runtime?.reuseCandidates.get(candidate)
  if (candidate.nodeType !== 8 || !live || live.nodeType !== 1) return candidate
  const element = live as Element
  const promoted = context.document.createElementNS(element.namespaceURI, element.localName)
  copyCandidateMetadata(live, promoted, context)
  if (runtime?.reuseCandidateBaseProps.has(candidate)) {
    const baseProps = runtime.reuseCandidateBaseProps.get(candidate) ?? null
    if (baseProps) context.domProps.set(promoted, cloneStoredDomProps(baseProps)!)
    else context.domProps.delete(promoted)
  }
  const patch = runtime?.compiledTemplatePatches.get(candidate)
  if (patch) runtime?.compiledTemplatePatches.set(promoted, patch)
  if (candidate.parentNode) candidate.parentNode.replaceChild(promoted, candidate)
  return promoted
}

function promoteReusableContent(content: Node, context: DomRenderContext): Node {
  if (content.nodeType === 8) return promoteReusableCandidate(content, context)
  if (content.nodeType !== 11) return content
  for (const child of [...content.childNodes]) promoteReusableCandidate(child, context)
  return content
}

function mergeReusableCandidateProps(
  previous: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
): Record<string, unknown> | null {
  const before = previous ?? {}
  const previousStyle = before.style && typeof before.style === "object" ? before.style as Record<string, unknown> : undefined
  const nextStyle = incoming.style && typeof incoming.style === "object" ? incoming.style as Record<string, unknown> : undefined
  const merged: Record<string, unknown> = {
    ...before,
    ...incoming,
    ...(nextStyle ? { style: { ...(previousStyle ?? {}), ...nextStyle } } : {}),
  }
  const hasClass = Object.prototype.hasOwnProperty.call(incoming, "class") || Object.prototype.hasOwnProperty.call(incoming, "className")
  if (hasClass) {
    const beforeClass = classNameOf(before.class ?? before.className)
    const incomingClass = classNameOf(incoming.class ?? incoming.className)
    const combined = [beforeClass, incomingClass].filter(Boolean).join(" ")
    delete merged.className
    if (combined) merged.class = combined
    else delete merged.class
  }
  return Object.keys(merged).length > 0 ? merged : null
}

/**
 * Stage non-structural modifier changes directly on a compiler-template reuse
 * carrier. The live DOM is not mutated until reconciliation succeeds, but we
 * avoid allocating a shallow clone merely to carry the next props snapshot.
 */
function stageReusableModifierPatch(
  content: Node,
  modifier: ViewModifierNode,
  extraProps: Record<string, unknown>,
  baseStyle: Record<string, unknown> | undefined,
  context: DomRenderContext,
): boolean {
  if (modifier.name === "frame" || modifier.name === "keyed" || modifier.name === "withProps" || modifier.name === "elementRef") return false
  const runtime = runtimeFor(context)
  if (!runtime) return false
  const candidates = content.nodeType === 8
    ? [content]
    : content.nodeType === 11
      ? [...content.childNodes]
      : []
  if (candidates.length === 0) return false

  const targets: Array<{ readonly candidate: Node; readonly live: Element; readonly props: Record<string, unknown> | null }> = []
  for (const candidate of candidates) {
    const live = runtime.reuseCandidates.get(candidate)
    if (candidate.nodeType !== 8 || live?.nodeType !== 1 || !runtime.reuseCandidateBaseProps.has(candidate)) return false
    targets.push({ candidate, live: live as Element, props: runtime.reuseCandidateBaseProps.get(candidate) ?? null })
  }

  for (const { candidate, live, props: previous } of targets) {
    const style = baseStyle ? { ...baseStyle } : undefined
    if (style && typeof style.transform === "string") {
      const remembered = previous?.style
      const currentTransform = remembered && typeof remembered === "object"
        ? (remembered as Record<string, unknown>).transform
        : undefined
      if (typeof currentTransform === "string" && currentTransform) style.transform = `${currentTransform} ${style.transform}`
    }
    const props = { ...extraProps, ...(style ? { style } : {}) }
    const appliedProps = live.localName.includes("-") ? props : nativeElementProps(props)
    runtime.reuseCandidateBaseProps.set(candidate, mergeReusableCandidateProps(previous, appliedProps))
  }
  return true
}


function markUnsafeViewAncestors(context: DomRenderContext): void {
  const runtime = runtimeFor(context)
  if (!runtime) return
  for (const key of runtime.stack) {
    const boundary = runtime.boundaries.get(key)
    if (boundary) boundary.localSafe = false
  }
}

function retainBoundaryStateTree(key: string, context: DomRenderContext, runtime: DomViewRuntime): void {
  const boundary = runtime.boundaries.get(key)
  if (!boundary) return
  context.visitedStateIdentities.add(key)
  runtime.passVisitedStates.add(key)
  for (const child of boundary.children) retainBoundaryStateTree(child, context, runtime)
}

function updateBoundaryDepth(boundary: DomViewBoundary, parentKey: string | undefined, runtime: DomViewRuntime): void {
  const parent = parentKey ? runtime.boundaries.get(parentKey) : undefined
  const depth = parent ? parent.depth + 1 : 0
  if (boundary.parentKey === parentKey && boundary.depth === depth) return

  boundary.parentKey = parentKey
  boundary.depth = depth
  // A reparented boundary carries its mounted descendants with it. Refresh
  // their cached depths once here rather than making every scheduler flush
  // walk each descendant's ancestor chain.
  const pending = [...boundary.children]
  while (pending.length > 0) {
    const child = runtime.boundaries.get(pending.pop()!)
    if (!child || child.parentKey !== boundary.key) continue
    child.depth = boundary.depth + 1
    for (const descendant of child.children) pending.push(descendant)
  }
}

function nodeKey(node: Node, context: DomRenderContext): string | number | undefined {
  return context.domKeys.get(node)
}

function rangeHasDomKeys(parent: Node, next: ArrayLike<Node>, context: DomRenderContext): boolean {
  if (!context.hasDomKeys) return false
  if (context.keyedParents.has(parent)) return true
  for (let index = 0; index < next.length; index += 1) {
    if (nodeKey(next[index], context) === undefined) continue
    context.keyedParents.add(parent)
    return true
  }
  return false
}

function longestIncreasingSubsequenceIndices(values: readonly number[]): Set<number> {
  if (values.length === 0) return new Set()
  const predecessors = new Array<number>(values.length).fill(-1)
  const tails: number[] = []
  for (let index = 0; index < values.length; index += 1) {
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (values[tails[middle]] < values[index]) low = middle + 1
      else high = middle
    }
    if (low > 0) predecessors[index] = tails[low - 1]
    tails[low] = index
  }
  const indices = new Set<number>()
  let cursor = tails[tails.length - 1]
  while (cursor !== undefined && cursor >= 0) {
    indices.add(cursor)
    cursor = predecessors[cursor]
  }
  return indices
}

function appendNodeBatch(parent: Node, nodes: readonly Node[]): void {
  if (nodes.length === 0) return
  const append = (parent as Node & { append?: (...nodes: Node[]) => void }).append
  if (typeof append === "function") {
    const chunkSize = 4096
    for (let index = 0; index < nodes.length; index += chunkSize) {
      append.call(parent, ...nodes.slice(index, index + chunkSize))
    }
    return
  }
  const fragment = parent.ownerDocument?.createDocumentFragment()
  if (!fragment) {
    for (const node of nodes) parent.appendChild(node)
    return
  }
  for (const node of nodes) fragment.appendChild(node)
  parent.appendChild(fragment)
}

function removeNodeBatch(parent: Node, nodes: readonly Node[], context: DomRenderContext): void {
  if (nodes.length === 0) return
  // Preserve the fast all-at-once path for the overwhelmingly common case.
  // Lifecycle transitions opt individual nodes out of synchronous removal.
  if (!nodes.some(node => canExitWithTransition(node, context))) {
    for (const node of nodes) releaseDomSubtree(node, context)
    const current = parent.childNodes
    let coversParent = current.length === nodes.length
    if (coversParent) {
      for (let index = 0; index < nodes.length; index += 1) {
        if (current[index] !== nodes[index]) {
          coversParent = false
          break
        }
      }
    }
    const replaceChildren = (parent as Node & { replaceChildren?: (...nodes: Node[]) => void }).replaceChildren
    if (coversParent && typeof replaceChildren === "function") {
      replaceChildren.call(parent)
      return
    }
    for (const node of nodes) if (node.parentNode === parent) parent.removeChild(node)
    return
  }
  for (const node of nodes) removeDomNode(parent, node, context)
}

function reconcileTailAppend(
  parent: Node,
  currentChildren: readonly Node[],
  nextChildren: readonly Node[],
  context: DomRenderContext,
): boolean {
  if (currentChildren.length === 0 || nextChildren.length <= currentChildren.length) return false
  const runtime = runtimeFor(context)
  const currentKeys = new Set<string | number>()
  for (let index = 0; index < currentChildren.length; index += 1) {
    const current = currentChildren[index]
    const next = nextChildren[index]
    const currentKey = nodeKey(current, context)
    const nextKey = nodeKey(next, context)
    const reusable = runtime?.reuseCandidates.get(next)
    if (currentKey !== undefined) currentKeys.add(currentKey)
    if (reusable && reusable !== current) return false
    if ((currentKey !== undefined || nextKey !== undefined) && currentKey !== nextKey) return false
  }
  for (let index = currentChildren.length; index < nextChildren.length; index += 1) {
    const next = nextChildren[index]
    const reusable = runtime?.reuseCandidates.get(next)
    if (reusable?.parentNode) return false
    const key = nodeKey(next, context)
    if (key !== undefined && currentKeys.has(key)) return false
  }
  for (let index = 0; index < currentChildren.length; index += 1) {
    reconcileDomNode(parent, currentChildren[index], nextChildren[index], context)
  }
  const additions = nextChildren.slice(currentChildren.length)
  for (const addition of additions) commitStagedSubtree(addition, context)
  appendNodeBatch(parent, additions)
  for (const addition of additions) bindInsertedSubtree(addition, context)
  return true
}

function reconcilePureKeyedPermutation(
  parent: Node,
  currentChildren: readonly Node[],
  nextChildren: readonly Node[],
  context: DomRenderContext,
): boolean {
  if (currentChildren.length < 2 || currentChildren.length !== nextChildren.length) return false
  const runtime = runtimeFor(context)
  const keyed = new Map<string | number, Node>()
  const oldIndex = new Map<Node, number>()
  for (let index = 0; index < currentChildren.length; index += 1) {
    const child = currentChildren[index]
    const key = nodeKey(child, context)
    if (key === undefined || keyed.has(key)) return false
    keyed.set(key, child)
    oldIndex.set(child, index)
  }
  const desired: Node[] = []
  const indices: number[] = []
  const seen = new Set<string | number>()
  let alreadyOrdered = true
  let strictlyDescending = true
  for (const next of nextChildren) {
    const key = nodeKey(next, context)
    if (key === undefined || seen.has(key)) return false
    seen.add(key)
    const live = runtime?.reuseCandidates.get(next) ?? keyed.get(key)
    if (!live || live.parentNode !== parent || nodeKey(live, context) !== key) return false
    const index = oldIndex.get(live)
    if (index === undefined) return false
    if (index !== desired.length) alreadyOrdered = false
    if (indices.length > 0 && index >= indices[indices.length - 1]) strictlyDescending = false
    desired.push(live)
    indices.push(index)
  }

  for (let index = 0; index < nextChildren.length; index += 1) {
    reconcileDomNode(parent, desired[index], nextChildren[index], context)
  }
  if (alreadyOrdered) return true

  // A full reverse is common in tables and feeds. Computing an LIS only tells
  // us that every node but one must move, so batch the permutation directly.
  if (strictlyDescending) {
    appendNodeBatch(parent, desired)
    return true
  }

  const stable = longestIncreasingSubsequenceIndices(indices)
  const moveCount = desired.length - stable.size

  // When most rows move, repeatedly editing the live child list can become
  // quadratic in DOM implementations. Move the permutation through a detached
  // fragment so style/layout work is deferred until a single final insertion.
  if (desired.length >= 64 && moveCount * 2 >= desired.length) {
    appendNodeBatch(parent, desired)
    return true
  }

  // Otherwise keep the LIS in place and move only the minimal set of nodes.
  for (let index = desired.length - 1; index >= 0; index -= 1) {
    if (stable.has(index)) continue
    const anchor = index + 1 < desired.length ? desired[index + 1] : null
    if (desired[index].nextSibling !== anchor) parent.insertBefore(desired[index], anchor)
  }
  return true
}

function releaseDomSubtree(node: Node, context: DomRenderContext): void {
  const runtime = runtimeFor(context)
  const compiledRoot = runtime?.compiledTemplateRoots.get(node)
  if (compiledRoot) runtime?.compiledTemplates.delete(compiledRoot.key)
  if (node.nodeType === 1) {
    const element = node as Element
    if (element.localName === "canvas") disposeParticleFieldGPUIslandCanvas(element as HTMLCanvasElement)
    context.refElements.delete(element)
    if (element.hasAttribute("data-mun-presentation")) disposeWebPresentation(element as HTMLElement)
    cancelWebContentTransition(element)
    cancelDomAnimations(element)
    disposeContinuousCorners(element)
    disposeFocusScope(element)
    if (context.eventTargetCount > 0) clearDomEvents(element, context)
    for (const child of domContentContainer(element).childNodes) releaseDomSubtree(child, context)
    return
  }
  for (const child of node.childNodes) releaseDomSubtree(child, context)
}

function replaceDomNode(parent: Node, current: Node, next: Node, context: DomRenderContext): Node {
  const anchor = current.nextSibling
  const exiting = beginExitTransition(parent, current, context)
  if (!exiting) releaseDomSubtree(current, context)
  commitStagedSubtree(next, context)
  if (exiting) parent.insertBefore(next, anchor)
  else parent.replaceChild(next, current)
  bindInsertedSubtree(next, context)
  return next
}

function reconcileDomChildren(parent: Node, nextChildren: ArrayLike<Node>, context: DomRenderContext): void {
  const currentNodes = parent.childNodes
  const keyedChildren = rangeHasDomKeys(parent, nextChildren, context)
  if (currentNodes.length !== nextChildren.length || keyedChildren) captureLayoutChildren(parent, undefined, context)
  if (nextChildren.length === 0) {
    if (currentNodes.length > 0) removeNodeBatch(parent, [...currentNodes], context)
    return
  }
  if (currentNodes.length === 0) {
    const additions = Array.from(nextChildren)
    for (const addition of additions) commitStagedSubtree(addition, context)
    appendNodeBatch(parent, additions)
    for (const addition of additions) bindInsertedSubtree(addition, context)
    return
  }
  // Keyed reconciliation is a property of this sibling range, not of the
  // entire mount. A single keyed ForEach elsewhere must not force every
  // unrelated subtree through WeakMap probes and keyed bookkeeping forever.
  if (!keyedChildren && currentNodes.length === nextChildren.length) {
    // nextChildren is often a live NodeList owned by a detached candidate. If
    // a replacement moves one of those nodes into the live tree, that list
    // shrinks immediately and a direct loop can skip later siblings. Only
    // the candidate side needs a snapshot; replacements keep live length.
    const nextSnapshot = Array.from(nextChildren)
    for (let index = 0; index < nextSnapshot.length; index += 1) {
      reconcileDomNode(parent, currentNodes[index], nextSnapshot[index], context)
    }
    return
  }
  const currentChildren = [...currentNodes]
  const nextArray = Array.from(nextChildren)
  if (reconcileTailAppend(parent, currentChildren, nextArray, context)) return
  if (reconcilePureKeyedPermutation(parent, currentChildren, nextArray, context)) return
  const runtime = runtimeFor(context)
  const keyed = new Map<string | number, Node>()
  const used = new Set<Node>()
  for (const child of currentChildren) {
    const key = nodeKey(child, context)
    if (key !== undefined) keyed.set(key, child)
  }
  const unkeyed = currentChildren.filter(child => nodeKey(child, context) === undefined)
  let nextUnkeyed = 0

  for (let index = 0; index < nextArray.length; index += 1) {
    const next = nextArray[index]
    const key = nodeKey(next, context)
    const reusable = runtime?.reuseCandidates.get(next)
    let current = reusable && reusable.parentNode ? reusable : key === undefined ? unkeyed[nextUnkeyed++] : keyed.get(key)
    if (current) used.add(current)
    if (!current) {
      commitStagedSubtree(next, context)
      parent.insertBefore(next, parent.childNodes[index] ?? null)
      current = next
      bindInsertedSubtree(next, context)
    } else {
      const anchor = parent.childNodes[index]
      if (anchor !== current) parent.insertBefore(current, anchor ?? null)
      reconcileDomNode(parent, current, next, context)
    }
  }

  for (const child of currentChildren) {
    if (!used.has(child) && child.parentNode === parent) removeDomNode(parent, child, context)
  }
}

function reconcileDomNode(parent: Node, current: Node, next: Node, context: DomRenderContext): Node {
  const runtime = runtimeFor(context)
  const stagedReuse = runtime?.reuseCandidates.get(next)
  if (stagedReuse === current && next.nodeType === 8) {
    const resolvedMotion = current.nodeType === 1 ? resolveMotionState(current as Element, next, context) : undefined
    if (current.nodeType === 1) captureLayoutNeighborhood(current as Element, resolvedMotion?.layoutAnimation, context)
    if (runtime?.reuseCandidateBaseProps.has(next) && current.nodeType === 1) {
      patchDomProps(current as Element, runtime.reuseCandidateBaseProps.get(next) ?? undefined, context, resolvedMotion?.policy)
    }
    runtime?.compiledTemplatePatches.get(next)?.()
    bindCandidateNode(next, current, context)
    if (current.nodeType === 1 && resolvedMotion) commitResolvedMotionState(current as Element, resolvedMotion, context)
    return current
  }
  if (current.nodeType !== next.nodeType) return replaceDomNode(parent, current, next, context)
  if (current.nodeType === 3 && next.nodeType === 3) {
    if (current.nodeValue !== next.nodeValue) {
      const host = current.parentElement
      const contentState = host ? runtime?.contentTransitionStates.get(host) : undefined
      const before = host && contentState ? readLayoutBox(host) : undefined
      const previousText = current.nodeValue ?? ""
      if (host) captureLayoutNeighborhood(host, undefined, context)
      current.nodeValue = next.nodeValue
      if (host && contentState) {
        playWebTextContentTransition(host, previousText, next.nodeValue ?? "", contentState.transition, contentState.animation, before)
      }
    }
    bindCandidateNode(next, current, context)
    return current
  }
  if (current.nodeType !== 1 || next.nodeType !== 1) return current
  const currentElement = current as Element
  const nextElement = next as Element
  if (currentElement.namespaceURI !== nextElement.namespaceURI || currentElement.tagName !== nextElement.tagName) {
    return replaceDomNode(parent, current, next, context)
  }
  const reusable = runtimeFor(context)?.reuseCandidates.get(next)
  const lazyKey = context.lazyKeys.get(nextElement)
  if (lazyKey) context.lazyKeys.set(currentElement, lazyKey)
  const resolvedMotion = resolveMotionState(currentElement, nextElement, context)
  const resolvedContentTransition = resolveContentTransitionState(currentElement, nextElement, context)
  const symbolPlan = resolvedContentTransition
    ? prepareWebSymbolContentTransition(
        currentElement,
        nextElement,
        resolvedContentTransition.transition,
        resolvedContentTransition.animation,
        element => context.domProps.get(element),
      )
    : undefined
  captureLayoutNeighborhood(currentElement, resolvedMotion.layoutAnimation, context)
  patchDomProps(
    currentElement,
    context.domProps.get(nextElement),
    context,
    resolvedMotion.policy,
    contentAttributeMotionPolicy(currentElement, context) ?? intrinsicAttributeMotionPolicy(currentElement, resolvedMotion),
  )
  const nextKey = nodeKey(nextElement, context)
  if (nextKey !== undefined) {
    context.hasDomKeys = true
    context.domKeys.set(currentElement, nextKey)
    if (currentElement.parentNode) context.keyedParents.add(currentElement.parentNode)
  }
  else if (nodeKey(currentElement, context) !== undefined) context.domKeys.delete(currentElement)
  bindCandidateNode(next, current, context)
  commitResolvedMotionState(currentElement, resolvedMotion, context)
  if (resolvedContentTransition && runtime) runtime.contentTransitionStates.set(currentElement, resolvedContentTransition)
  if (reusable === current) runtime?.compiledTemplatePatches.get(next)?.()
  if (reusable !== current) {
    const currentContent = domContentContainer(currentElement)
    const nextContent = domContentContainer(nextElement)
    const currentChildren = currentContent.childNodes
    const nextChildren = nextContent.childNodes
    if (currentChildren.length === 1 && nextChildren.length === 1 && currentChildren[0].nodeType === 3 && nextChildren[0].nodeType === 3) {
      const currentText = currentChildren[0]
      const nextText = nextChildren[0]
      if (currentText.nodeValue !== nextText.nodeValue) {
        const contentState = runtime?.contentTransitionStates.get(currentElement)
        const before = contentState ? readLayoutBox(currentElement) : undefined
        const previousText = currentText.nodeValue ?? ""
        captureLayoutNeighborhood(currentElement, resolvedMotion.layoutAnimation, context)
        currentText.nodeValue = nextText.nodeValue
        if (contentState) {
          playWebTextContentTransition(currentElement, previousText, nextText.nodeValue ?? "", contentState.transition, contentState.animation, before)
        }
      }
      bindCandidateNode(nextText, currentText, context)
    } else if (currentChildren.length !== 0 || nextChildren.length !== 0) {
      reconcileDomChildren(currentContent, nextChildren, context)
    }
  }
  symbolPlan?.complete()
  synchronizeDomSelectValue(currentElement, context.domProps.get(nextElement))
  return current
}

function reconcileDomRange(parent: Node, currentNodes: readonly Node[], nextNodes: readonly Node[], context: DomRenderContext): Node[] {
  const current = currentNodes.filter(node => node.parentNode === parent)
  const keyedRange = rangeHasDomKeys(parent, nextNodes, context)
  if (current.length !== nextNodes.length || keyedRange) captureLayoutChildren(parent, undefined, context)
  if (current.length === 0) {
    for (const next of nextNodes) commitStagedSubtree(next, context)
    appendNodeBatch(parent, nextNodes)
    for (const next of nextNodes) bindInsertedSubtree(next, context)
    return [...nextNodes]
  }
  if (nextNodes.length === 0) {
    removeNodeBatch(parent, current, context)
    return []
  }
  if (!keyedRange && current.length === nextNodes.length) {
    const liveNodes = new Array<Node>(nextNodes.length)
    for (let index = 0; index < nextNodes.length; index += 1) {
      liveNodes[index] = reconcileDomNode(parent, current[index], nextNodes[index], context)
    }
    return liveNodes
  }
  const after = current[current.length - 1].nextSibling
  const keyed = new Map<string | number, Node>()
  const used = new Set<Node>()
  const liveNodes: Node[] = []
  const unkeyed = current.filter(node => nodeKey(node, context) === undefined)
  for (const node of current) {
    const key = nodeKey(node, context)
    if (key !== undefined) keyed.set(key, node)
  }
  let unkeyedIndex = 0
  let cursor: Node | null = current[0] ?? after
  for (const next of nextNodes) {
    const reusable = runtimeFor(context)?.reuseCandidates.get(next)
    const key = nodeKey(next, context)
    let live = reusable && reusable.parentNode ? reusable : key === undefined ? unkeyed[unkeyedIndex++] : keyed.get(key)
    if (live) used.add(live)
    if (!live) {
      commitStagedSubtree(next, context)
      parent.insertBefore(next, cursor ?? after)
      live = next
      bindInsertedSubtree(next, context)
    } else {
      if (live !== cursor) parent.insertBefore(live, cursor ?? after)
      live = reconcileDomNode(parent, live, next, context)
    }
    liveNodes.push(live)
    cursor = live.nextSibling
  }
  for (const node of current) {
    if (used.has(node) || node.parentNode !== parent) continue
    removeDomNode(parent, node, context)
  }
  return liveNodes
}

function safeBoundingRect(element: Element): DOMRect | undefined {
  try { return element.getBoundingClientRect() } catch { return undefined }
}

function lazyEstimate(node: LazyViewNode): number {
  const value = node.props["data-mun-lazy-estimate"]
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 44
}

function lazyOverscan(node: LazyViewNode): number {
  const value = node.props["data-mun-lazy-overscan"]
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 2
}

function lazyScrollParent(element: HTMLElement, axis: LazyViewNode["axis"]): HTMLElement | null {
  const property = axis === "horizontal" ? "overflowX" : "overflowY"
  let parent = element.parentElement
  while (parent) {
    let overflow = parent.style[property]
    try {
      overflow = parent.ownerDocument.defaultView?.getComputedStyle(parent)?.[property] || overflow
    } catch { /* inaccessible CSSOM: fall back to the inline declaration */ }
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return parent
    parent = parent.parentElement
  }
  return null
}

function lazyGap(node: LazyViewNode): number {
  const style = node.props.style
  if (!style || typeof style !== "object") return 0
  const raw = (style as Record<string, unknown>).gap
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function lazyMeasurementIndex(context: DomRenderContext, key: string, node: LazyViewNode): LazyMeasurementIndex {
  const estimate = lazyEstimate(node)
  const gap = lazyGap(node)
  let index = context.lazySizeIndexes.get(key)
  if (!index) {
    index = new LazyMeasurementIndex(node.children.length, estimate, gap)
    context.lazySizeIndexes.set(key, index)
  } else {
    index.configure(node.children.length, estimate, gap)
  }
  return index
}

function lazyViewportMetrics(element: HTMLElement, node: LazyViewNode): { readonly offset: number; readonly viewport: number } {
  const vertical = node.axis !== "horizontal"
  const rect = safeBoundingRect(element)
  const parent = lazyScrollParent(element, node.axis)
  const window = element.ownerDocument.defaultView
  const elementOffset = vertical ? rect?.top ?? 0 : rect?.left ?? 0
  let offset = -elementOffset
  let viewport = vertical ? window?.innerHeight ?? 800 : window?.innerWidth ?? 1200
  if (parent) {
    const parentRect = safeBoundingRect(parent)
    const parentOffset = vertical ? parentRect?.top ?? 0 : parentRect?.left ?? 0
    // Real layout rects are viewport-relative already, so their difference is
    // the scroll viewport origin in lazy-container coordinates. DOM shims and
    // temporarily unmeasurable layouts often return an all-zero rect even when
    // scrollTop/scrollLeft changed; fall back to the explicit scroll offset in
    // that case instead of pinning virtualization to the first window forever.
    const measuredAxis = vertical
      ? Math.max(rect?.height ?? 0, parentRect?.height ?? 0)
      : Math.max(rect?.width ?? 0, parentRect?.width ?? 0)
    offset = measuredAxis > 0
      ? lazyViewportOffset(parentOffset, elementOffset)
      : vertical ? parent.scrollTop : parent.scrollLeft
    viewport = vertical ? parent.clientHeight : parent.clientWidth
    if (!viewport) viewport = vertical ? window?.innerHeight ?? 800 : window?.innerWidth ?? 1200
  }
  return { offset: lazyViewportOffset(offset, 0), viewport: Math.max(1, viewport) }
}

function lazyRangeForElement(element: HTMLElement, node: LazyViewNode, index: LazyMeasurementIndex): LazyViewRange {
  const metrics = lazyViewportMetrics(element, node)
  return index.rangeForViewport(metrics.offset, metrics.viewport, lazyOverscan(node))
}

function boundedLazyRange(range: LazyViewRange, count: number): LazyViewRange {
  const start = Math.max(0, Math.min(count, Math.floor(range.start)))
  const end = Math.max(start, Math.min(count, Math.ceil(range.end)))
  return { start, end }
}

function sameLazyRange(left: LazyViewRange | undefined, right: LazyViewRange): boolean {
  return left?.start === right.start && left.end === right.end
}

function lazySpacer(context: DomRenderContext, node: LazyViewNode, size: number, position: "before" | "after"): HTMLElement {
  const spacer = context.document.createElement("div")
  applyDomProps(spacer, {
    "data-mun-lazy-spacer": position,
    "aria-hidden": true,
    style: node.axis === "horizontal"
      ? { width: `${Math.max(0, size)}px`, flex: "0 0 auto" }
      : { height: `${Math.max(0, size)}px`, width: "100%", flex: "0 0 auto" },
  }, context)
  return spacer
}

const HTML_NS = "http://www.w3.org/1999/xhtml"
const SVG_NS = "http://www.w3.org/2000/svg"

interface FlatKeyedHostRow {
  readonly key: string | number
  readonly type: string
  readonly props: Record<string, unknown> | null
  readonly text: string
}

interface FlatHostRow {
  readonly type: string
  readonly props: Record<string, unknown> | null
  readonly text: string
}

interface FlatHostPlan {
  readonly rootType: string
  readonly rootProps: Record<string, unknown> | null
  readonly rows: readonly FlatHostRow[]
}

interface FlatKeyedHostPlan {
  readonly rootType: string
  readonly rootProps: Record<string, unknown> | null
  readonly rows: readonly FlatKeyedHostRow[]
}

const directKeyedPatchUnsafeTags = new Set([
  ...rawTextHtmlElements,
  ...voidHtmlElements,
  "table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "td", "th",
  "select", "option", "optgroup", "textarea", "template", "svg", "math",
])

const directKeyedPatchUnsafeProps = new Set([
  "ref",
  "innerHTML",
  "outerHTML",
  "textContent",
  "innerText",
  "dangerouslySetInnerHTML",
])

function safeGraphArrayValues(value: unknown): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined
    const length = Object.getOwnPropertyDescriptor(value, "length")
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) return []
    const snapshot = new Array<unknown>(length.value)
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      snapshot[index] = descriptor && "value" in descriptor ? descriptor.value : undefined
    }
    return snapshot
  } catch {
    return undefined
  }
}

function ownGraphDataValue(value: unknown, key: PropertyKey): unknown {
  if (!value || typeof value !== "object") return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function ownGraphKind(value: unknown): string | undefined {
  const kind = ownGraphDataValue(value, "kind")
  return typeof kind === "string" ? kind : undefined
}

function directKeyedPatchPropsSafe(props: Record<string, unknown> | null, allowEvents = false, allowRefs = false): boolean {
  if (!props) return true
  try {
    for (const key of Reflect.ownKeys(props)) {
      if (typeof key !== "string") return false
      const descriptor = Object.getOwnPropertyDescriptor(props, key)
      if (!descriptor || !("value" in descriptor)) return false
      const value = descriptor.value
      if (key === "key" || key === "children") continue
      if (key === "ref") {
        if (allowRefs && (value === undefined || value === null || typeof value === "function" || typeof value === "object")) continue
        return false
      }
      if (key === "__proto__" || directKeyedPatchUnsafeProps.has(key)) return false
      if (key.startsWith("data-mun-")) return false
      if (key === "style") {
        if (!value || typeof value !== "object") {
          if (typeof value !== "string" && value !== undefined && value !== null) return false
          continue
        }
        for (const styleKey of Reflect.ownKeys(value)) {
          if (typeof styleKey !== "string" || styleKey === "__proto__") return false
          const styleDescriptor = Object.getOwnPropertyDescriptor(value, styleKey)
          if (!styleDescriptor || !("value" in styleDescriptor)) return false
          const item = styleDescriptor.value
          if (item !== undefined && item !== null && typeof item !== "string"
            && (typeof item !== "number" || !Number.isFinite(item))) return false
        }
        continue
      }
      if (/^on[A-Za-z]/.test(key)) {
        if (allowEvents && (value === undefined || value === null || typeof value === "function")) continue
        return false
      }
      const primitive = value === undefined || value === null || typeof value === "string" || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))
      if (!primitive) return false
    }
    return true
  } catch {
    return false
  }
}

function ordinaryDirectHostTag(type: unknown): type is string {
  return typeof type === "string" && !type.includes("-") && !directKeyedPatchUnsafeTags.has(type.toLowerCase())
}

function flatKeyedHostRow(value: unknown, allowEvents = false, allowRefs = false): FlatKeyedHostRow | undefined {
  let content = value as ViewGraphValue
  let modifierKey: string | number | undefined
  if (ownGraphKind(content) === "modified") {
    const modifiers = safeGraphArrayValues(ownGraphDataValue(content, "modifiers"))
    if (!modifiers) return undefined
    for (const item of modifiers) {
      if (!item || typeof item !== "object") return undefined
      if (ownGraphDataValue(item, "name") !== "keyed") return undefined
      const arguments_ = safeGraphArrayValues(ownGraphDataValue(item, "arguments"))
      const key = arguments_?.[0]
      if (typeof key !== "string" && typeof key !== "number") return undefined
      modifierKey = key
    }
    content = ownGraphDataValue(content, "content") as ViewGraphValue
  }
  if (ownGraphKind(content) !== "element") return undefined
  const type = ownGraphDataValue(content, "type")
  const propsValue = ownGraphDataValue(content, "props")
  const props = propsValue === null ? null : propsValue && typeof propsValue === "object"
    ? propsValue as Record<string, unknown>
    : undefined
  if (!ordinaryDirectHostTag(type) || props === undefined || !directKeyedPatchPropsSafe(props, allowEvents, allowRefs)) return undefined
  const children = safeGraphArrayValues(ownGraphDataValue(content, "children"))
  if (!children || children.length !== 1) return undefined
  const text = compiledTextSlotValue(children[0])
  if (!text.ok) return undefined
  const propKey = props ? ownGraphDataValue(props, "key") : undefined
  const key = modifierKey ?? (typeof propKey === "string" || typeof propKey === "number" ? propKey : undefined)
  if (key === undefined) return undefined
  return { key, type, props, text: text.value }
}

function appendFlatKeyedHostRows(value: unknown, rows: FlatKeyedHostRow[], allowEvents = false, allowRefs = false): boolean {
  const array = safeGraphArrayValues(value)
  if (array) {
    for (const item of array) if (!appendFlatKeyedHostRows(item, rows, allowEvents, allowRefs)) return false
    return true
  }
  if (ownGraphKind(value) === "fragment") {
    const children = safeGraphArrayValues(ownGraphDataValue(value, "children"))
    if (!children) return false
    for (const child of children) if (!appendFlatKeyedHostRows(child, rows, allowEvents, allowRefs)) return false
    return true
  }
  const row = flatKeyedHostRow(value, allowEvents, allowRefs)
  if (!row) return false
  rows.push(row)
  return true
}

function flatHostRow(value: unknown): FlatHostRow | undefined {
  if (ownGraphKind(value) !== "element") return undefined
  const type = ownGraphDataValue(value, "type")
  const propsValue = ownGraphDataValue(value, "props")
  const props = propsValue === null ? null : propsValue && typeof propsValue === "object"
    ? propsValue as Record<string, unknown>
    : undefined
  if (!ordinaryDirectHostTag(type) || props === undefined || !directKeyedPatchPropsSafe(props, true, true)) return undefined
  const propKey = props ? ownGraphDataValue(props, "key") : undefined
  if (typeof propKey === "string" || typeof propKey === "number") return undefined
  const children = safeGraphArrayValues(ownGraphDataValue(value, "children"))
  if (!children || children.length !== 1) return undefined
  const text = compiledTextSlotValue(children[0])
  if (!text.ok) return undefined
  return { type, props, text: text.value }
}

function appendFlatHostRows(value: unknown, rows: FlatHostRow[]): boolean {
  const array = safeGraphArrayValues(value)
  if (array) {
    for (const item of array) if (!appendFlatHostRows(item, rows)) return false
    return true
  }
  if (ownGraphKind(value) === "fragment") {
    const children = safeGraphArrayValues(ownGraphDataValue(value, "children"))
    if (!children) return false
    for (const child of children) if (!appendFlatHostRows(child, rows)) return false
    return true
  }
  const row = flatHostRow(value)
  if (!row) return false
  rows.push(row)
  return true
}

function flatHostPlan(value: ViewGraphValue): FlatHostPlan | undefined {
  if (ownGraphKind(value) !== "element") return undefined
  const type = ownGraphDataValue(value, "type")
  const propsValue = ownGraphDataValue(value, "props")
  const props = propsValue === null ? null : propsValue && typeof propsValue === "object"
    ? propsValue as Record<string, unknown>
    : undefined
  if (!ordinaryDirectHostTag(type) || props === undefined || !directKeyedPatchPropsSafe(props, true, true)) return undefined
  const children = safeGraphArrayValues(ownGraphDataValue(value, "children"))
  if (!children) return undefined
  const rows: FlatHostRow[] = []
  for (const child of children) if (!appendFlatHostRows(child, rows)) return undefined
  return rows.length > 0 ? { rootType: type, rootProps: props, rows } : undefined
}

function flatKeyedHostPlan(value: ViewGraphValue): FlatKeyedHostPlan | undefined {
  if (ownGraphKind(value) !== "element") return undefined
  const type = ownGraphDataValue(value, "type")
  const propsValue = ownGraphDataValue(value, "props")
  const props = propsValue === null ? null : propsValue && typeof propsValue === "object"
    ? propsValue as Record<string, unknown>
    : undefined
  if (!ordinaryDirectHostTag(type) || props === undefined || !directKeyedPatchPropsSafe(props, true, true)) return undefined
  const children = safeGraphArrayValues(ownGraphDataValue(value, "children"))
  if (!children) return undefined
  const rows: FlatKeyedHostRow[] = []
  for (const child of children) if (!appendFlatKeyedHostRows(child, rows, true, true)) return undefined
  if (rows.length === 0) return undefined
  const keys = new Set<string | number>()
  for (const row of rows) {
    if (keys.has(row.key)) return undefined
    keys.add(row.key)
  }
  return { rootType: type, rootProps: props, rows }
}

interface FlatKeyedCollectionBoundaryPlan {
  readonly rootType: string
  readonly rootProps: Record<string, unknown> | null
  readonly collection: KeyedCollectionViewNode
}

function flatKeyedCollectionBoundaryPlan(value: ViewGraphValue): FlatKeyedCollectionBoundaryPlan | undefined {
  if (ownGraphKind(value) !== "element") return undefined
  const type = ownGraphDataValue(value, "type")
  const propsValue = ownGraphDataValue(value, "props")
  const props = propsValue === null ? null : propsValue && typeof propsValue === "object"
    ? propsValue as Record<string, unknown>
    : undefined
  if (!ordinaryDirectHostTag(type) || props === undefined || !directKeyedPatchPropsSafe(props)) return undefined
  const children = safeGraphArrayValues(ownGraphDataValue(value, "children"))
  if (!children || children.length !== 1 || ownGraphKind(children[0]) !== "collection") return undefined
  return { rootType: type, rootProps: props, collection: children[0] as KeyedCollectionViewNode }
}

function directCollectionHostRow(node: KeyedCollectionViewNode, entry: KeyedCollectionEntry): FlatKeyedHostRow | undefined {
  const expectedKey = keyedCollectionChildKey(entry.key, 0)
  const compiled = node.compiled
  if (compiled?.kind === "flat-text-host") {
    if (typeof compiled.hostType === "string" && typeof compiled.evaluateText === "function") {
      if (!ordinaryDirectHostTag(compiled.hostType)) return undefined
      let props: Record<string, unknown> | null
      if (compiled.staticProps === null) props = null
      else if (compiled.staticProps !== undefined) props = compiled.staticProps
      else if (compiled.evaluateProps) props = compiled.evaluateProps(entry.item, entry.index)
      else return undefined
      if (!directKeyedPatchPropsSafe(props)) return undefined
      const text = compiledTextSlotValue(compiled.evaluateText(entry.item, entry.index))
      if (!text.ok) return undefined
      return { key: expectedKey, type: compiled.hostType, props, text: text.value }
    }
    const evaluated = compiled.evaluate(entry.item, entry.index)
    if (!evaluated || typeof evaluated !== "object" || !ordinaryDirectHostTag(evaluated.type)
      || !directKeyedPatchPropsSafe(evaluated.props)) return undefined
    const text = compiledTextSlotValue(evaluated.text)
    if (!text.ok) return undefined
    return { key: expectedKey, type: evaluated.type, props: evaluated.props, text: text.value }
  }
  const row = flatKeyedHostRow(node.content(entry.item, entry.index, entry.key))
  return row?.key === expectedKey ? row : undefined
}

function disposeDomCollection(runtime: DomViewRuntime, key: string): void {
  const instance = runtime.collections.get(key)
  if (!instance) return
  instance.unsubscribe?.()
  runtime.collections.delete(key)
  const keys = runtime.collectionKeysByOwner.get(instance.ownerKey)
  keys?.delete(key)
  if (keys?.size === 0) runtime.collectionKeysByOwner.delete(instance.ownerKey)
}

function discardDomCollections(runtime: DomViewRuntime, ownerKey: string): void {
  const keys = runtime.collectionKeysByOwner.get(ownerKey)
  if (!keys) return
  for (const key of [...keys]) disposeDomCollection(runtime, key)
}

function registerDomCollection(runtime: DomViewRuntime, instance: DomCollectionInstance): void {
  disposeDomCollection(runtime, instance.key)
  runtime.collections.set(instance.key, instance)
  const keys = runtime.collectionKeysByOwner.get(instance.ownerKey) ?? new Set<string>()
  keys.add(instance.key)
  runtime.collectionKeysByOwner.set(instance.ownerKey, keys)
}

function collectionEntries(node: KeyedCollectionViewNode, untrackedSource = false): readonly KeyedCollectionEntry[] {
  if (!untrackedSource || !node.readItems) return keyedCollectionEntries(node)
  const items = collectStateReads(() => node.readItems!(), () => undefined)
  return keyedCollectionEntries(node, items)
}

function collectionSourceIdentity(node: KeyedCollectionViewNode): unknown {
  const source = isStateRef(node.source)
    ? collectStateReads(() => (node.source as StateRef<unknown>).value, () => undefined)
    : node.source
  return reactiveIdentity(source)
}

function collectionRowItemIdentity(item: unknown): object | undefined {
  const identity = reactiveIdentity(item)
  return identity && typeof identity === "object" ? identity : undefined
}

function indexCollectionOccurrences(rows: readonly DomCollectionRow[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const row of rows) result.set(row.baseKey, Math.max(result.get(row.baseKey) ?? 0, row.occurrence + 1))
  return result
}

function appendCollectionRowIndex(
  index: Map<object, DomCollectionRow | Set<DomCollectionRow>>,
  identity: object,
  row: DomCollectionRow,
): void {
  const existing = index.get(identity)
  if (!existing) {
    index.set(identity, row)
    return
  }
  if (existing instanceof Set) {
    existing.add(row)
    return
  }
  if (existing !== row) index.set(identity, new Set([existing, row]))
}

function removeCollectionRowIndex(
  index: Map<object, DomCollectionRow | Set<DomCollectionRow>>,
  identity: object,
  row: DomCollectionRow,
): void {
  const existing = index.get(identity)
  if (!existing) return
  if (!(existing instanceof Set)) {
    if (existing === row) index.delete(identity)
    return
  }
  existing.delete(row)
  if (existing.size === 0) index.delete(identity)
  else if (existing.size === 1) index.set(identity, existing.values().next().value!)
}

function indexCollectionRowsByItem(rows: readonly DomCollectionRow[]): Map<object, DomCollectionRow | Set<DomCollectionRow>> {
  const result = new Map<object, DomCollectionRow | Set<DomCollectionRow>>()
  for (const row of rows) {
    const identity = collectionRowItemIdentity(row.item)
    if (!identity) continue
    appendCollectionRowIndex(result, identity, row)
  }
  return result
}

function replaceIndexedCollectionRow(instance: DomCollectionInstance, previous: DomCollectionRow, next: DomCollectionRow): void {
  if (!instance.rowsByItemDirty) {
    const previousIdentity = collectionRowItemIdentity(previous.item)
    if (previousIdentity) removeCollectionRowIndex(instance.rowsByItem, previousIdentity, previous)
    const nextIdentity = collectionRowItemIdentity(next.item)
    if (nextIdentity) appendCollectionRowIndex(instance.rowsByItem, nextIdentity, next)
  }
  if (!instance.rowsDirty) instance.rows.set(next.entryKey, next)
  instance.order[next.index] = next
}

function collectionRows(instance: DomCollectionInstance): Map<string, DomCollectionRow> {
  if (instance.rowsDirty) {
    instance.rows = new Map(instance.order.map(row => [row.entryKey, row] as const))
    instance.rowsDirty = false
  }
  return instance.rows
}

function collectionRowsByItem(instance: DomCollectionInstance): Map<object, DomCollectionRow | Set<DomCollectionRow>> {
  if (instance.rowsByItemDirty) {
    instance.rowsByItem = indexCollectionRowsByItem(instance.order)
    instance.rowsByItemDirty = false
  }
  return instance.rowsByItem
}

function ensureCollectionStructuralIndexes(instance: DomCollectionInstance): void {
  if (!instance.structuralIndexesDirty) return
  instance.actualKeys = new Set(instance.order.map(row => row.key))
  instance.occurrenceCounts = indexCollectionOccurrences(instance.order)
  instance.structuralIndexesDirty = false
}

function collectionRawSourceArray(node: KeyedCollectionViewNode): readonly unknown[] | undefined {
  if (!isStateRef(node.source)) return undefined
  const current = collectStateReads(() => (node.source as StateRef<unknown>).value, () => undefined)
  const raw = reactiveIdentity(current)
  try { return Array.isArray(raw) ? raw as readonly unknown[] : undefined } catch { return undefined }
}

function dataArrayLength(source: readonly unknown[]): number | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, "length")
    return descriptor && "value" in descriptor && Number.isSafeInteger(descriptor.value) && descriptor.value >= 0
      ? descriptor.value as number
      : undefined
  } catch { return undefined }
}

function dataArrayItem(source: readonly unknown[], index: number): unknown | typeof missingCollectionItem {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, String(index))
    return descriptor && "value" in descriptor ? descriptor.value : missingCollectionItem
  } catch { return missingCollectionItem }
}

const missingCollectionItem = Symbol("mun.collection.missing-item")

function collectionArrayIndex(property: PropertyKey | undefined): number | undefined {
  if (typeof property === "number") return Number.isSafeInteger(property) && property >= 0 ? property : undefined
  if (typeof property !== "string" || property.length === 0) return undefined
  const index = Number(property)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === property ? index : undefined
}

interface LocalCollectionPatch {
  readonly previous: DomCollectionRow
  readonly next: DomCollectionRow
  readonly plan: FlatKeyedHostRow
}

/**
 * Fast path for compiler-owned keyed collections. A non-structural array index
 * replacement or direct row-object mutation can be proven and committed
 * without snapshotting or keying the rest of the collection.
 *
 * undefined means the mutation needs the generic collection reconcile; false
 * means the direct DOM capability itself was lost and the owning View boundary
 * should take over.
 */
function patchLocalCompiledCollectionMutations(
  instance: DomCollectionInstance,
  node: KeyedCollectionViewNode,
  parent: Node,
  mutations: readonly StateMutation[],
  context: DomRenderContext,
): boolean | undefined {
  if (!node.compiled?.evaluateKey || !node.readItems || !isStateRef(node.source) || mutations.length === 0) return undefined
  const source = collectionRawSourceArray(node)
  const length = source ? dataArrayLength(source) : undefined
  if (!source || length !== instance.order.length) return undefined

  const candidates = new Map<string, { readonly row: DomCollectionRow; readonly item: unknown; readonly index: number }>()
  const previousSourceIdentity = instance.sourceIdentity
  const currentSourceIdentity = reactiveIdentity(source)
  for (const mutation of mutations) {
    const target = mutation.target ? reactiveIdentity(mutation.target) : undefined
    if (mutation.kind === "replace") {
      if (!target || !Object.is(target, currentSourceIdentity)) return undefined
      const index = collectionArrayIndex(mutation.property)
      if (index === undefined || index >= length) return undefined
      const item = dataArrayItem(source, index)
      const row = instance.order[index]
      if (item === missingCollectionItem || !row || row.index !== index) return undefined
      candidates.set(row.entryKey, { row, item, index })
      continue
    }
    if (target && Object.is(target, previousSourceIdentity)) {
      if (mutation.kind !== "set" && mutation.kind !== "define") return undefined
      const index = collectionArrayIndex(mutation.property)
      if (index === undefined || index >= length) return undefined
      const item = dataArrayItem(source, index)
      const row = instance.order[index]
      if (item === missingCollectionItem || !row || row.index !== index) return undefined
      candidates.set(row.entryKey, { row, item, index })
      continue
    }
    if (target && typeof target === "object") {
      const rows = collectionRowsByItem(instance).get(target)
      if (!rows) return undefined
      if (rows instanceof Set) {
        if (rows.size === 0) return undefined
        for (const row of rows) candidates.set(row.entryKey, { row, item: row.item, index: row.index })
      } else {
        candidates.set(rows.entryKey, { row: rows, item: rows.item, index: rows.index })
      }
      continue
    }
    return undefined
  }
  if (candidates.size === 0) return undefined

  const staged: LocalCollectionPatch[] = []
  for (const candidate of candidates.values()) {
    const { row, item, index } = candidate
    const resolved = node.key(item, index)
    if (!resolved || resolved.identity !== row.baseKey) return undefined
    const entry: KeyedCollectionEntry = {
      key: row.entryKey,
      baseKey: row.baseKey,
      displayKey: resolved.display,
      occurrence: row.occurrence,
      item,
      index,
    }
    const plan = directCollectionHostRow(node, entry)
    if (!plan || plan.key !== row.key || plan.type.toLowerCase() !== row.type.toLowerCase()) return false
    const content = domContentContainer(row.element)
    if (row.element.parentNode !== parent || row.element.namespaceURI !== HTML_NS
      || content?.childNodes.length !== 1 || content.firstChild !== row.textNode || row.textNode.nodeType !== 3) return false
    staged.push({
      previous: row,
      plan,
      next: {
        entryKey: row.entryKey,
        baseKey: row.baseKey,
        displayKey: resolved.display,
        occurrence: row.occurrence,
        key: plan.key,
        item,
        index,
        type: plan.type,
        props: plan.props,
        textValue: plan.text,
        element: row.element,
        textNode: row.textNode,
      },
    })
  }

  for (const patch of staged) {
    patchDomProps(patch.previous.element, patch.plan.props, context)
    if (patch.previous.textNode.nodeValue !== patch.plan.text) patch.previous.textNode.nodeValue = patch.plan.text
    replaceIndexedCollectionRow(instance, patch.previous, patch.next)
  }
  instance.node = node
  instance.sourceIdentity = currentSourceIdentity
  return true
}

/**
 * Immutable replacement fast path for compiler-owned collections whose key
 * sequence and host shape are unchanged. Validate every row before touching
 * the DOM, then update the persistent rows in place without rebuilding keyed
 * maps, occurrence indexes, or reorder plans.
 */
function patchStableCompiledCollectionReplacement(
  instance: DomCollectionInstance,
  node: KeyedCollectionViewNode,
  parent: Node,
  mutations: readonly StateMutation[],
  context: DomRenderContext,
): boolean | undefined {
  if (!node.compiled?.evaluateKey || mutations.length !== 1) return undefined
  const mutation = mutations[0]
  const snapshot = mutation.kind === "replace" ? mutation.snapshot : undefined
  if (!snapshot || snapshot.length !== instance.order.length) return undefined
  const sourceIdentity = mutation.target ? reactiveIdentity(mutation.target) : collectionSourceIdentity(node)
  const count = snapshot.length
  const plans = new Array<FlatKeyedHostRow>(count)
  const displays = new Array<string>(count)

  for (let index = 0; index < count; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, String(index))) return undefined
    const row = instance.order[index]
    if (!row || row.index !== index || row.element.parentNode !== parent) return false
    const item = snapshot[index]
    const resolved = node.key(item, index)
    if (!resolved || resolved.identity !== row.baseKey) return undefined
    const entry: KeyedCollectionEntry = {
      key: row.entryKey,
      baseKey: row.baseKey,
      displayKey: resolved.display,
      occurrence: row.occurrence,
      item,
      index,
    }
    const plan = directCollectionHostRow(node, entry)
    if (!plan || plan.key !== row.key || plan.type.toLowerCase() !== row.type.toLowerCase()) return false
    const content = domContentContainer(row.element)
    if (row.element.namespaceURI !== HTML_NS || content?.childNodes.length !== 1
      || content.firstChild !== row.textNode || row.textNode.nodeType !== 3) return false
    plans[index] = plan
    displays[index] = resolved.display
  }

  for (let index = 0; index < count; index += 1) {
    const row = instance.order[index]
    const plan = plans[index]
    if (!Object.is(row.props, plan.props)) patchDomProps(row.element, plan.props, context)
    if (row.textNode.nodeValue !== plan.text) row.textNode.nodeValue = plan.text
    row.displayKey = displays[index]
    row.item = snapshot[index]
    row.props = plan.props
    row.textValue = plan.text
  }
  instance.rowsByItemDirty = true
  instance.node = node
  instance.sourceIdentity = sourceIdentity
  return true
}

function removeCollectionRowFromItemIndex(instance: DomCollectionInstance, row: DomCollectionRow): void {
  if (instance.rowsByItemDirty) return
  const identity = collectionRowItemIdentity(row.item)
  if (!identity) return
  removeCollectionRowIndex(instance.rowsByItem, identity, row)
}

function appendCollectionRowToItemIndex(instance: DomCollectionInstance, row: DomCollectionRow): void {
  if (instance.rowsByItemDirty) return
  const identity = collectionRowItemIdentity(row.item)
  if (!identity) return
  appendCollectionRowIndex(instance.rowsByItem, identity, row)
}

/**
 * Structural fast paths for compiler-proven keyed collections. These handle
 * operations whose exact semantic effect is known from the State mutation
 * journal. Everything else falls through to the generic keyed reconcile.
 */
function patchStructuralCompiledCollectionMutation(
  instance: DomCollectionInstance,
  node: KeyedCollectionViewNode,
  parent: Node,
  mutations: readonly StateMutation[],
  context: DomRenderContext,
): boolean | undefined {
  if (!node.compiled?.evaluateKey || !node.readItems || !isStateRef(node.source) || mutations.length !== 1) return undefined
  const mutation = mutations[0]
  if (mutation.kind !== "array" || !mutation.target || !Object.is(reactiveIdentity(mutation.target), instance.sourceIdentity)) return undefined
  const source = collectionRawSourceArray(node)
  const length = source ? dataArrayLength(source) : undefined
  if (!source || length === undefined) return undefined

  if (mutation.method === "pop") {
    if (instance.order.length === 0 || length !== instance.order.length - 1) return undefined
    ensureCollectionStructuralIndexes(instance)
    const row = instance.order[instance.order.length - 1]
    if (!row || row.element.parentNode !== parent) return false
    instance.order.pop()
    if (!instance.rowsDirty) instance.rows.delete(row.entryKey)
    instance.actualKeys.delete(row.key)
    const occurrences = instance.occurrenceCounts.get(row.baseKey) ?? 0
    if (occurrences <= 1) instance.occurrenceCounts.delete(row.baseKey)
    else instance.occurrenceCounts.set(row.baseKey, occurrences - 1)
    removeCollectionRowFromItemIndex(instance, row)
    removeNodeBatch(parent, [row.element], context)
    instance.node = node
    return true
  }

  if (mutation.method === "push") {
    const added = mutation.arguments ?? []
    if (added.length === 0) return true
    const start = instance.order.length
    if (start === 0 || length !== start + added.length) return undefined
    ensureCollectionStructuralIndexes(instance)
    const occurrenceDeltas = new Map<string, number>()
    const staged: Array<{ readonly entry: KeyedCollectionEntry; readonly plan: FlatKeyedHostRow; readonly item: unknown }> = []
    const stagedKeys = new Set<string | number>()
    for (let offset = 0; offset < added.length; offset += 1) {
      const index = start + offset
      const item = dataArrayItem(source, index)
      if (item === missingCollectionItem) return undefined
      const resolved = node.key(item, index)
      if (!resolved) return undefined
      const delta = occurrenceDeltas.get(resolved.identity) ?? 0
      const occurrence = (instance.occurrenceCounts.get(resolved.identity) ?? 0) + delta
      occurrenceDeltas.set(resolved.identity, delta + 1)
      const entry: KeyedCollectionEntry = {
        key: keyedCollectionEntryKey(resolved.identity, occurrence),
        baseKey: resolved.identity,
        displayKey: resolved.display,
        occurrence,
        item,
        index,
      }
      const plan = directCollectionHostRow(node, entry)
      if (!plan || instance.actualKeys.has(plan.key) || stagedKeys.has(plan.key)) return false
      stagedKeys.add(plan.key)
      staged.push({ entry, plan, item })
    }
    for (const { entry, plan, item } of staged) {
      const element = createTaggedElement(context, plan.type)
      const textNode = context.document.createTextNode(plan.text)
      patchDomProps(element, plan.props, context)
      domContentContainer(element)?.appendChild(textNode)
      parent.appendChild(element)
      const row: DomCollectionRow = {
        entryKey: entry.key,
        baseKey: entry.baseKey,
        displayKey: entry.displayKey,
        occurrence: entry.occurrence,
        key: plan.key,
        item,
        index: entry.index,
        type: plan.type,
        props: plan.props,
        textValue: plan.text,
        element,
        textNode,
      }
      instance.order.push(row)
      if (!instance.rowsDirty) instance.rows.set(row.entryKey, row)
      instance.actualKeys.add(row.key)
      appendCollectionRowToItemIndex(instance, row)
      if (entry.occurrence > 0) node.onDuplicateKey?.(entry.displayKey, entry.occurrence)
    }
    for (const [baseKey, delta] of occurrenceDeltas) {
      instance.occurrenceCounts.set(baseKey, (instance.occurrenceCounts.get(baseKey) ?? 0) + delta)
    }
    instance.node = node
    return true
  }

  if (mutation.method === "reverse") {
    const count = instance.order.length
    if (!node.compiled.indexIndependent || length !== count || count < 2) return undefined
    const unique = new Set(instance.order.map(row => row.baseKey))
    if (unique.size !== count) return undefined
    for (let index = 0; index < count; index += 1) {
      const item = dataArrayItem(source, index)
      const expected = instance.order[count - index - 1]
      if (item === missingCollectionItem || !expected || !Object.is(collectionRowItemIdentity(item), collectionRowItemIdentity(expected.item))) return undefined
    }
    instance.order.reverse()
    const desired = new Array<Element>(count)
    for (let index = 0; index < count; index += 1) {
      const row = instance.order[index]
      row.index = index
      desired[index] = row.element
    }
    replaceFlatHostOrder(parent, desired)
    instance.node = node
    return true
  }

  return undefined
}

function subscribeDomCollection(instance: DomCollectionInstance, context: DomRenderContext, runtime: DomViewRuntime): void {
  if (!isStateRef(instance.node.source) || !instance.node.compiled?.evaluateKey) return
  const source = instance.node.source as StateRef<unknown>
  instance.unsubscribe = subscribeState(source, (transaction, batch) => {
    if (runtime.collections.get(instance.key) !== instance) return
    instance.pendingTransaction = transaction
    instance.pendingMutations.push(...batch.mutations)
    if (instance.scheduled) return
    instance.scheduled = true
    queueMicrotask(() => {
      instance.scheduled = false
      if (runtime.collections.get(instance.key) !== instance) return
      const pending = instance.pendingMutations.splice(0)
      const renderTransaction = instance.pendingTransaction
      instance.pendingTransaction = undefined
      const parent = instance.order[0]?.element.parentNode
      const previousTransaction = context.activeTransaction
      context.activeTransaction = renderTransaction
      let patched = false
      try {
        if (parent) patched = withRenderTransaction(renderTransaction, () => {
          const local = patchLocalCompiledCollectionMutations(instance, instance.node, parent, pending, context)
          if (local !== undefined) return local
          const stableReplacement = patchStableCompiledCollectionReplacement(instance, instance.node, parent, pending, context)
          if (stableReplacement !== undefined) return stableReplacement
          const structural = patchStructuralCompiledCollectionMutation(instance, instance.node, parent, pending, context)
          return structural ?? patchPersistentCollection(instance, instance.node, parent, pending, context)
        })
      } finally { context.activeTransaction = previousTransaction }
      if (patched) { flushLayoutMotion(context); return }
      runtime.invalidateBoundary?.(instance.ownerKey, renderTransaction, pending)
    })
  })
}

function materializeDirectCollection(
  node: KeyedCollectionViewNode,
  identity: readonly (string | number)[],
  ownerKey: string,
  context: DomRenderContext,
  runtime: DomViewRuntime,
): Node | undefined {
  const entries = collectionEntries(node, true)
  // An empty runtime-inferred collection has no row shape to prove. Compiler
  // metadata can safely retain an empty executor and accept later appends.
  if (entries.length === 0 && !node.compiled) return undefined
  const plans = new Array<FlatKeyedHostRow>(entries.length)
  for (let index = 0; index < entries.length; index += 1) {
    const row = directCollectionHostRow(node, entries[index])
    if (!row) return undefined
    plans[index] = row
  }

  const key = viewIdentityKey([...identity, "collection-executor"])
  const fragment = context.document.createDocumentFragment()
  const order = new Array<DomCollectionRow>(entries.length)
  context.hasDomKeys = true
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const plan = plans[index]
    const element = createTaggedElement(context, plan.type)
    const textNode = context.document.createTextNode(plan.text)
    element.appendChild(textNode)
    context.domKeys.set(element, plan.key)
    applyDomProps(element, plan.props, context)
    fragment.appendChild(element)
    const row: DomCollectionRow = {
      entryKey: entry.key,
      baseKey: entry.baseKey,
      displayKey: entry.displayKey,
      occurrence: entry.occurrence,
      key: plan.key,
      item: entry.item,
      index: entry.index,
      type: plan.type,
      props: plan.props,
      textValue: plan.text,
      element,
      textNode,
    }
    order[index] = row
  }
  const instance: DomCollectionInstance = {
    key,
    ownerKey,
    node,
    sourceIdentity: collectionSourceIdentity(node),
    rows: new Map(),
    rowsDirty: true,
    order,
    rowsByItem: new Map(),
    rowsByItemDirty: true,
    actualKeys: new Set(),
    occurrenceCounts: new Map(),
    structuralIndexesDirty: true,
    pendingMutations: [],
    scheduled: false,
  }
  registerDomCollection(runtime, instance)
  subscribeDomCollection(instance, context, runtime)
  return fragment
}

function registerGenericStateCollection(
  node: KeyedCollectionViewNode,
  identity: readonly (string | number)[],
  ownerKey: string,
  context: DomRenderContext,
  runtime: DomViewRuntime,
): void {
  // Compiler-owned State collections normally stay entirely inside the direct
  // executor. Runtime values can still invalidate that proof (for example a
  // manually supplied descriptor returning an event prop). Keep the source
  // subscription even when rendering the row graph generically, otherwise the
  // compiler's parent-invalidation isolation would leave that fallback stale.
  if (!isStateRef(node.source) || !node.compiled?.evaluateKey) return
  const key = viewIdentityKey([...identity, "collection-executor"])
  const instance: DomCollectionInstance = {
    key,
    ownerKey,
    node,
    sourceIdentity: collectionSourceIdentity(node),
    rows: new Map(),
    order: [],
    rowsByItem: new Map(),
    actualKeys: new Set(),
    occurrenceCounts: new Map(),
    pendingMutations: [],
    scheduled: false,
  }
  registerDomCollection(runtime, instance)
  subscribeDomCollection(instance, context, runtime)
}

function collectionMutationEffects(
  instance: DomCollectionInstance,
  node: KeyedCollectionViewNode,
  mutations: readonly StateMutation[],
): { readonly forceAll: boolean; readonly touched: ReadonlySet<string> } {
  const touched = new Set<string>()
  if (mutations.length === 0) return { forceAll: true, touched }

  const previousSource = instance.sourceIdentity
  const nextSource = collectionSourceIdentity(node)
  let itemKeys: Map<object, Set<string>> | undefined
  const keysForItem = (identity: object): Set<string> | undefined => {
    if (!itemKeys) {
      itemKeys = new Map<object, Set<string>>()
      for (const row of instance.order) {
        const rowIdentity = reactiveIdentity(row.item)
        if (!rowIdentity || typeof rowIdentity !== "object") continue
        const keys = itemKeys.get(rowIdentity) ?? new Set<string>()
        keys.add(row.entryKey)
        itemKeys.set(rowIdentity, keys)
      }
    }
    return itemKeys.get(identity)
  }

  let forceAll = false
  for (const mutation of mutations) {
    const target = mutation.target ? reactiveIdentity(mutation.target) : undefined
    const previous = reactiveIdentity(mutation.previous)
    const value = reactiveIdentity(mutation.value)
    if (mutation.kind === "replace"
      && (Object.is(previous, previousSource) || Object.is(value, nextSource))) continue
    if (target && (Object.is(target, previousSource) || Object.is(target, nextSource))) continue
    if (target && typeof target === "object") {
      const keys = keysForItem(target)
      if (keys) {
        keys.forEach(key => touched.add(key))
        continue
      }
    }
    forceAll = true
  }
  return { forceAll, touched }
}

function sameCollectionItem(left: unknown, right: unknown): boolean {
  return Object.is(reactiveIdentity(left), reactiveIdentity(right))
}

function patchPersistentCollection(
  instance: DomCollectionInstance,
  node: KeyedCollectionViewNode,
  parent: Node,
  mutations: readonly StateMutation[],
  context: DomRenderContext,
): boolean {
  const currentChildren = [...parent.childNodes]
  if (currentChildren.length !== instance.order.length) return false
  const knownElements = new Set(instance.order.map(row => row.element))
  if (currentChildren.some(child => child.nodeType !== 1 || !knownElements.has(child as Element))) return false
  const oldIndex = new Map<Element, number>()
  currentChildren.forEach((child, index) => oldIndex.set(child as Element, index))

  const replacementSnapshot = mutations.length === 1 && mutations[0]?.kind === "replace"
    ? mutations[0].snapshot
    : undefined
  const entries = replacementSnapshot ? keyedCollectionEntries(node, replacementSnapshot) : keyedCollectionEntries(node)
  const effects = collectionMutationEffects(instance, node, mutations)
  const indexIndependent = node.compiled?.indexIndependent ?? node.indexIndependent
  const desiredActualKeys = new Set<string | number>()
  const planned = new Array<{
    readonly entry: KeyedCollectionEntry
    readonly plan: FlatKeyedHostRow
    readonly previous?: DomCollectionRow
    readonly reuse: boolean
    readonly evaluated: boolean
  }>(entries.length)
  const existingRows = collectionRows(instance)

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const previous = existingRows.get(entry.key)
    const evaluated = effects.forceAll || !previous
      || !sameCollectionItem(previous.item, entry.item)
      || (!indexIndependent && previous.index !== entry.index)
      || effects.touched.has(entry.key)
    const plan = evaluated
      ? directCollectionHostRow(node, entry)
      : previous && { key: previous.key, type: previous.type, props: previous.props, text: previous.textValue }
    if (!plan || desiredActualKeys.has(plan.key)) return false
    desiredActualKeys.add(plan.key)
    const content = previous ? domContentContainer(previous.element) : undefined
    const reuse = Boolean(previous
      && previous.element.parentNode === parent
      && previous.element.namespaceURI === HTML_NS
      && previous.element.localName.toLowerCase() === plan.type.toLowerCase()
      && content?.childNodes.length === 1
      && content.firstChild === previous.textNode
      && previous.textNode.nodeType === 3)
    planned[index] = { entry, plan, previous, reuse, evaluated }
  }

  const reusedElements = new Set(planned.flatMap(item => item.reuse && item.previous ? [item.previous.element] : []))
  const stale = instance.order.flatMap(row => reusedElements.has(row.element) ? [] : [row.element])
  context.hasDomKeys = true
  context.keyedParents.add(parent)
  removeNodeBatch(parent, stale, context)

  const nextRows = new Map<string, DomCollectionRow>()
  const order = new Array<DomCollectionRow>(planned.length)
  const desired = new Array<Element>(planned.length)
  const existingDesired: Element[] = []
  const existingIndices: number[] = []
  for (let index = 0; index < planned.length; index += 1) {
    const item = planned[index]
    let element: Element
    let textNode: Text
    if (item.reuse && item.previous) {
      element = item.previous.element
      textNode = item.previous.textNode
      existingDesired.push(element)
      existingIndices.push(oldIndex.get(element)!)
    } else {
      element = createTaggedElement(context, item.plan.type)
      textNode = context.document.createTextNode(item.plan.text)
      element.appendChild(textNode)
    }
    context.domKeys.set(element, item.plan.key)
    if (item.evaluated || !item.reuse) {
      patchDomProps(element, item.plan.props, context)
      if (textNode.nodeValue !== item.plan.text) textNode.nodeValue = item.plan.text
    }
    const row: DomCollectionRow = {
      entryKey: item.entry.key,
      baseKey: item.entry.baseKey,
      displayKey: item.entry.displayKey,
      occurrence: item.entry.occurrence,
      key: item.plan.key,
      item: item.entry.item,
      index: item.entry.index,
      type: item.plan.type,
      props: item.plan.props,
      textValue: item.plan.text,
      element,
      textNode,
    }
    nextRows.set(item.entry.key, row)
    order[index] = row
    desired[index] = element
  }

  reorderKnownKeyedChildren(parent, existingDesired, existingIndices)
  let anchor: Node | null = null
  for (let index = desired.length - 1; index >= 0; index -= 1) {
    const element = desired[index]
    if (element.parentNode !== parent) parent.insertBefore(element, anchor)
    anchor = element
  }
  instance.node = node
  instance.sourceIdentity = collectionSourceIdentity(node)
  instance.rows = nextRows
  instance.rowsDirty = false
  instance.order = order
  instance.rowsByItem = new Map()
  instance.rowsByItemDirty = true
  instance.actualKeys = new Set()
  instance.occurrenceCounts = new Map()
  instance.structuralIndexesDirty = true
  return true
}

function patchKeyedCollectionBoundary(
  boundary: DomViewBoundary,
  value: ViewGraphValue,
  context: DomRenderContext,
  runtime: DomViewRuntime,
): boolean {
  if (context.hydrating || context.activeTransaction?.animation || boundary.children.size > 0
    || boundary.outerModifiers.length > 0 || boundary.currentNodes.length !== 1) return false
  const plan = flatKeyedCollectionBoundaryPlan(value)
  const root = boundary.currentNodes[0]
  if (!plan || root?.nodeType !== 1) return false
  const rootElement = root as Element
  if (rootElement.namespaceURI !== HTML_NS || rootElement.localName.toLowerCase() !== plan.rootType.toLowerCase()) return false
  const instanceKeys = runtime.collectionKeysByOwner.get(boundary.key)
  if (!instanceKeys || instanceKeys.size !== 1) return false
  const instanceKey = instanceKeys.values().next().value as string | undefined
  const instance = instanceKey ? runtime.collections.get(instanceKey) : undefined
  if (!instance) return false
  const parent = domContentContainer(rootElement)
  if (!patchPersistentCollection(instance, plan.collection, parent, boundary.pendingMutations, context)) return false
  patchDomProps(rootElement, plan.rootProps, context)
  return true
}

function reorderKnownKeyedChildren(parent: Node, desired: readonly Node[], indices: readonly number[]): void {
  let alreadyOrdered = true
  let strictlyDescending = true
  for (let index = 0; index < indices.length; index += 1) {
    if (indices[index] !== index) alreadyOrdered = false
    if (index > 0 && indices[index] >= indices[index - 1]) strictlyDescending = false
  }
  if (alreadyOrdered) return
  if (strictlyDescending) {
    replaceFlatHostOrder(parent, desired)
    return
  }
  const stable = longestIncreasingSubsequenceIndices(indices)
  const moveCount = desired.length - stable.size
  if (desired.length >= 64 && moveCount * 2 >= desired.length) {
    replaceFlatHostOrder(parent, desired)
    return
  }
  for (let index = desired.length - 1; index >= 0; index -= 1) {
    if (stable.has(index)) continue
    const anchor = index + 1 < desired.length ? desired[index + 1] : null
    if (desired[index].nextSibling !== anchor) parent.insertBefore(desired[index], anchor)
  }
}

function replaceFlatHostOrder(parent: Node, desired: readonly Node[]): void {
  const replaceChildren = (parent as Node & { replaceChildren?: (...nodes: Node[]) => void }).replaceChildren
  if (typeof replaceChildren !== "function") {
    appendNodeBatch(parent, desired)
    return
  }
  // These callers have already proven every row to be an ordinary direct host
  // with text-only content. Detach once, then reattach the same node objects.
  // Repeatedly moving attached siblings makes live NodeList implementations
  // quadratic; the two-phase move keeps identity/listeners while staying O(n).
  replaceChildren.call(parent)
  appendNodeBatch(parent, desired)
}

function patchFlatHostBoundary(boundary: DomViewBoundary, value: ViewGraphValue, context: DomRenderContext): boolean {
  if (context.hydrating || context.activeTransaction?.animation || boundary.children.size > 0
    || boundary.outerModifiers.length > 0 || boundary.currentNodes.length !== 1) return false
  const plan = flatHostPlan(value)
  const root = boundary.currentNodes[0]
  if (!plan || root?.nodeType !== 1) return false
  const rootElement = root as Element
  if (rootElement.namespaceURI !== HTML_NS || rootElement.localName.toLowerCase() !== plan.rootType.toLowerCase()) return false
  const parent = domContentContainer(rootElement)
  const currentChildren = parent.childNodes
  if (currentChildren.length !== plan.rows.length) return false

  const matched = new Array<{ readonly live: Element; readonly text: Text }>(plan.rows.length)
  for (let index = 0; index < plan.rows.length; index += 1) {
    const row = plan.rows[index]
    const live = currentChildren[index]
    if (live?.nodeType !== 1) return false
    const element = live as Element
    if (element.namespaceURI !== HTML_NS || element.localName.toLowerCase() !== row.type.toLowerCase()) return false
    const content = domContentContainer(element)
    if (content.childNodes.length !== 1 || content.firstChild?.nodeType !== 3) return false
    matched[index] = { live: element, text: content.firstChild as Text }
  }

  patchDomProps(rootElement, plan.rootProps, context)
  for (let index = 0; index < plan.rows.length; index += 1) {
    const row = plan.rows[index]
    const { live, text } = matched[index]
    patchDomProps(live, row.props, context)
    if (text.nodeValue !== row.text) text.nodeValue = row.text
  }
  return true
}

function patchFlatKeyedHostBoundary(boundary: DomViewBoundary, value: ViewGraphValue, context: DomRenderContext): boolean {
  if (context.hydrating || context.activeTransaction?.animation || boundary.children.size > 0
    || boundary.outerModifiers.length > 0 || boundary.currentNodes.length !== 1) return false
  const plan = flatKeyedHostPlan(value)
  const root = boundary.currentNodes[0]
  if (!plan || root?.nodeType !== 1) return false
  const rootElement = root as Element
  if (rootElement.namespaceURI !== HTML_NS || rootElement.localName.toLowerCase() !== plan.rootType.toLowerCase()) return false
  const parent = domContentContainer(rootElement)
  const currentChildren = [...parent.childNodes]
  const keyed = new Map<string | number, Element>()
  const oldIndex = new Map<Element, number>()
  for (let index = 0; index < currentChildren.length; index += 1) {
    const child = currentChildren[index]
    const key = context.domKeys.get(child)
    if (child.nodeType !== 1 || key === undefined || keyed.has(key)) return false
    const element = child as Element
    keyed.set(key, element)
    oldIndex.set(element, index)
  }

  const matched: Array<{ readonly live: Element; readonly text: Text; readonly position: number } | undefined> = new Array(plan.rows.length)
  const desiredKeys = new Set<string | number>()
  for (let index = 0; index < plan.rows.length; index += 1) {
    const row = plan.rows[index]
    desiredKeys.add(row.key)
    const live = keyed.get(row.key)
    if (!live) continue
    if (live.parentNode !== parent || live.namespaceURI !== HTML_NS
      || live.localName.toLowerCase() !== row.type.toLowerCase()) return false
    const content = domContentContainer(live)
    if (content.childNodes.length !== 1 || content.firstChild?.nodeType !== 3) return false
    const position = oldIndex.get(live)
    if (position === undefined) return false
    matched[index] = { live, text: content.firstChild as Text, position }
  }

  const stale = currentChildren.filter(child => {
    const key = context.domKeys.get(child)
    return key !== undefined && !desiredKeys.has(key)
  })
  patchDomProps(rootElement, plan.rootProps, context)
  context.hasDomKeys = true
  context.keyedParents.add(parent)
  removeNodeBatch(parent, stale, context)

  const desired: Element[] = new Array(plan.rows.length)
  const existingDesired: Element[] = []
  const existingIndices: number[] = []
  for (let index = 0; index < plan.rows.length; index += 1) {
    const row = plan.rows[index]
    const existing = matched[index]
    let live: Element
    let text: Text
    if (existing) {
      live = existing.live
      text = existing.text
      existingDesired.push(live)
      existingIndices.push(existing.position)
    } else {
      live = createTaggedElement(context, row.type)
      text = context.document.createTextNode(row.text)
      live.appendChild(text)
    }
    desired[index] = live
    context.domKeys.set(live, row.key)
    patchDomProps(live, row.props, context)
    if (text.nodeValue !== row.text) text.nodeValue = row.text
  }

  // First minimize moves among rows that survived the mutation, then insert
  // only genuinely new rows into the gaps. Appends therefore allocate one
  // element + one text node, removals allocate nothing, and reverse keeps the
  // existing high-density reorder path.
  reorderKnownKeyedChildren(parent, existingDesired, existingIndices)
  let anchor: Node | null = null
  for (let index = desired.length - 1; index >= 0; index -= 1) {
    const live = desired[index]
    if (live.parentNode !== parent) parent.insertBefore(live, anchor)
    anchor = live
  }
  return true
}

function createTaggedElement(context: DomRenderContext, tag: string, namespace = HTML_NS): Element {
  const lower = tag.toLowerCase()
  const actualNamespace = namespace === SVG_NS || lower === "svg" ? SVG_NS : HTML_NS
  const element = actualNamespace === SVG_NS
    ? context.document.createElementNS(SVG_NS, tag)
    : context.document.createElement(tag)
  if (tag !== tag.toLowerCase()) context.domTags.set(element, tag)
  return element
}

function childNamespace(parent: Element): string {
  return parent.namespaceURI === SVG_NS && parent.localName.toLowerCase() !== "foreignobject" ? SVG_NS : HTML_NS
}

function copyRawAttributes(source: Element, target: Element): void {
  for (const attribute of [...source.attributes]) {
    if (attribute.namespaceURI) target.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value)
    else target.setAttribute(attribute.name, attribute.value)
  }
}

function normalizeChildNamespace(child: Element, parent: Element, context: DomRenderContext): Element {
  const tag = context.domTags.get(child) ?? child.localName
  const expectedParentNamespace = childNamespace(parent)
  const desiredNamespace = expectedParentNamespace === SVG_NS || tag.toLowerCase() === "svg" ? SVG_NS : HTML_NS
  if (child.namespaceURI === desiredNamespace) return child

  const replacement = createTaggedElement(context, tag, desiredNamespace)
  copyRawAttributes(child, replacement)
  const props = context.domProps.get(child)
  if (props) applyDomProps(replacement, props, context)
  const hydrationProps = context.hydrationProps.get(child)
  if (hydrationProps !== undefined) context.hydrationProps.set(replacement, hydrationProps)
  context.domKeys.set(replacement, context.domKeys.get(child))
  const lazyKey = context.lazyKeys.get(child)
  if (lazyKey) context.lazyKeys.set(replacement, lazyKey)
  for (const nested of [...domContentContainer(child).childNodes]) {
    appendDomChild(domContentContainer(replacement), nested, context)
  }
  return replacement
}

function appendDomChild(parent: Node, child: Node, context: DomRenderContext): void {
  if (context.hydrating && context.hydrationLiveNodes?.has(child)) return
  if (child.nodeType === 11) {
    // DocumentFragment insertion already moves all of its children in one DOM
    // operation. Flatten only when an SVG parent needs per-element namespace
    // normalization; ordinary HTML/fragment parents can take the fragment as-is.
    if (parent.nodeType !== 1 || childNamespace(parent as Element) === HTML_NS) {
      parent.appendChild(child)
      return
    }
    for (const nested of [...child.childNodes]) appendDomChild(parent, nested, context)
    return
  }
  const normalized = parent.nodeType === 1 && child.nodeType === 1
    ? normalizeChildNamespace(child as Element, parent as Element, context)
    : child
  parent.appendChild(normalized)
}

function rawTextContent(tag: string, children: readonly Node[]): string {
  let content = ""
  const append = (node: Node): void => {
    if (node.nodeType === 3) {
      content += node.nodeValue ?? ""
      return
    }
    if (node.nodeType === 11) {
      for (const child of node.childNodes) append(child)
      return
    }
    throw new TypeError(`<${tag.toLowerCase()}> only accepts text children`)
  }
  children.forEach(append)
  return normalizedRawTextValue(tag, content)
}

function flattenedDomChildren(children: readonly Node[]): Node[] {
  return children.flatMap(child => child.nodeType === 11
    ? flattenedDomChildren([...child.childNodes])
    : [child])
}

function appendElementChildren(element: Element, tag: string, children: readonly Node[], context: DomRenderContext): void {
  const content = domContentContainer(element)
  if (element.namespaceURI !== HTML_NS || tag.toLowerCase() !== "table") {
    children.forEach(child => appendDomChild(content, child, context))
    return
  }
  let implicitGroup: { readonly kind: "row" | "column" | "cell"; readonly parent: Element } | undefined
  for (const child of flattenedDomChildren(children)) {
    const childTag = child.nodeType === 1 && (child as Element).namespaceURI === HTML_NS
      ? (child as Element).localName.toLowerCase()
      : undefined
    const kind = childTag === "tr" ? "row" : childTag === "col" ? "column" : childTag === "td" || childTag === "th" ? "cell" : undefined
    if (!kind) {
      implicitGroup = undefined
      const isWhitespace = child.nodeType === 3 && !(child.nodeValue ?? "").trim()
      if (!isWhitespace && (!childTag || !validTableChildElements.has(childTag))) {
        throw new TypeError("<table> only accepts table sections, rows, columns, cells, scripts, templates, or whitespace")
      }
      appendDomChild(content, child, context)
      continue
    }
    if (implicitGroup?.kind !== kind) {
      const wrapper = createTaggedElement(context, kind === "column" ? "colgroup" : "tbody")
      appendDomChild(content, wrapper, context)
      const parent = kind === "cell" ? createTaggedElement(context, "tr") : wrapper
      if (kind === "cell") appendDomChild(wrapper, parent, context)
      implicitGroup = { kind, parent }
    }
    appendDomChild(implicitGroup.parent, child, context)
  }
}

function createDomRenderer(context: DomRenderContext): MunRenderer<Node> {
  const runtime = runtimeFor(context)
  const renderFragment = (children: readonly Node[]): Node => {
    const fragment = context.document.createDocumentFragment()
    if (runtime?.hydrationReuse) {
      hydrationVirtualRoots.set(fragment, children.flatMap(outputNodes))
      return fragment
    }
    children.forEach(child => appendDomChild(fragment, child, context))
    return fragment
  }
  const renderValue = (value: unknown): Node => {
    const text = value === null || value === undefined || value === false ? "" : String(value)
    const reuse = runtime?.hydrationReuse
    if (reuse) {
      const live = nextHydrationNode(runtime)
      if (live?.nodeType === 3) {
        context.hydrationLiveNodes?.add(live)
        if ((live.nodeValue ?? "") !== text) reuse.failed = true
        return live
      }
      reuse.failed = true
    }
    return context.document.createTextNode(text)
  }
  const renderElement = (type: unknown, props: Record<string, unknown> | null, children: readonly Node[]): Node => {
    const tag = typeof type === "string" ? type : "div"
    const reuse = runtime?.hydrationReuse
    if (reuse) {
      const live = nextHydrationNode(runtime)
      const reusable = typeof type === "string"
        && live?.nodeType === 1
        && (live as Element).namespaceURI === HTML_NS
        && (live as Element).localName.toLowerCase() === tag.toLowerCase()
      if (reusable) {
        const element = live as Element
        context.hydrationLiveNodes?.add(element)
        reuse.elements.add(element)
        if (tag !== tag.toLowerCase()) context.domTags.set(element, tag)
        applyDomProps(element, props, context)
        if (!hydrationChildrenMatch(element, children)) reuse.failed = true
        return element
      }
      reuse.failed = true
      const placeholder = createTaggedElement(context, tag)
      applyDomProps(placeholder, props, context)
      return placeholder
    }
    const element = createTaggedElement(context, tag)
    applyDomProps(element, props, context)
    const hasTextAreaValue = element.namespaceURI === HTML_NS
      && tag.toLowerCase() === "textarea"
      && props?.value !== undefined
      && props.value !== null
    if (hasTextAreaValue && context.stagingProps && !context.hydrating) {
      element.textContent = String(props?.value).replace(/\r\n?/g, "\n")
    }
    const isRawText = element.namespaceURI === HTML_NS && rawTextHtmlElements.has(tag.toLowerCase())
    if (isRawText) {
      element.textContent = rawTextContent(tag, children)
    } else if (!voidHtmlElements.has(tag.toLowerCase()) && !hasTextAreaValue) {
      appendElementChildren(element, tag, children, context)
    }
    synchronizeDomSelectValue(element, props)
    return element
  }
  const renderHydratedCompiledCollection = (
    node: KeyedCollectionViewNode,
    identity: readonly (string | number)[],
    ownerKey: string | undefined,
  ): Node | undefined => {
    const reuse = runtime?.hydrationReuse
    if (!reuse || node.compiled?.kind !== "flat-text-host") return undefined
    const entries = collectionEntries(node, Boolean(ownerKey))
    const plans = new Array<FlatKeyedHostRow>(entries.length)
    for (let index = 0; index < entries.length; index += 1) {
      const plan = directCollectionHostRow(node, entries[index])
      if (!plan) return undefined
      plans[index] = plan
    }

    const roots = new Array<Node>(entries.length)
    const track = Boolean(ownerKey && isStateRef(node.source) && node.compiled.evaluateKey)
    const order = track ? new Array<DomCollectionRow>(entries.length) : undefined
    context.hasDomKeys = entries.length > 0 || context.hasDomKeys
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      const plan = plans[index]
      const textNode = renderValue(plan.text)
      const element = renderElement(plan.type, plan.props, [textNode])
      if (element.nodeType !== 1 || textNode.nodeType !== 3) reuse.failed = true
      context.domKeys.set(element, plan.key)
      roots[index] = element
      if (order && element.nodeType === 1 && textNode.nodeType === 3) {
        const row: DomCollectionRow = {
          entryKey: entry.key,
          baseKey: entry.baseKey,
          displayKey: entry.displayKey,
          occurrence: entry.occurrence,
          key: plan.key,
          item: entry.item,
          index: entry.index,
          type: plan.type,
          props: plan.props,
          textValue: plan.text,
          element: element as Element,
          textNode: textNode as Text,
        }
        order[index] = row
      }
    }

    if (order && ownerKey && order.length === entries.length) {
      reuse.pendingCollections.push({
        key: viewIdentityKey([...identity, "collection-executor"]),
        ownerKey,
        node,
        sourceIdentity: collectionSourceIdentity(node),
        rows: new Map(),
        rowsDirty: true,
        order,
        rowsByItem: new Map(),
        rowsByItemDirty: true,
        actualKeys: new Set(),
        occurrenceCounts: new Map(),
        structuralIndexesDirty: true,
        pendingMutations: [],
        scheduled: false,
      })
    }
    return renderFragment(roots)
  }
  type DomTemplateFactory = (renderSlot: (index: number) => Node) => Node
  const templateFactories = new WeakMap<object, DomTemplateFactory>()
  const compileTemplate = (value: CompiledTemplateValue): DomTemplateFactory => {
    if (value !== null && typeof value === "object") {
      if (value.kind === "slot") {
        const index = value.index
        return renderSlot => renderSlot(index)
      }
    if (value.kind === "fragment") {
      const children = value.children.map(compileTemplate)
      return renderSlot => renderFragment(children.map(child => child(renderSlot)))
      }
      if (value.kind === "element") {
        const type = value.type
        const props = value.props
        const children = value.children.map(compileTemplate)
        return renderSlot => renderElement(type, props, children.map(child => child(renderSlot)))
      }
    }
    const text = value === null || value === undefined || value === false || value === true ? "" : String(value)
    return () => renderValue(text)
  }
  let renderer!: MunRenderer<Node>

  const recordDirectModifiers = (content: Node, modifier: ViewModifierNode): void => {
    if (!runtime || runtime.replayingModifiers || modifier.name === "frame") return
    const seen = new Set<string>()
    for (const node of outputNodes(content)) {
      const keys = runtime.nodeKeys.get(node)
      if (!keys) continue
      for (const key of keys) {
        if (seen.has(key)) continue
        seen.add(key)
        const boundary = runtime.boundaries.get(key)
        if (boundary) boundary.outerModifiers.push(modifier)
      }
    }
  }

  const applyModifier = (content: Node, modifier: ViewModifierNode, renderArgument?: (index: number) => Node): Node => {
    recordDirectModifiers(content, modifier)
    if (modifier.name === "animationAuto") {
      recordCompiledAutoAnimationDomain(content, modifier.arguments, context)
      return content
    }
    if (modifier.name === "animation") {
      recordAnimationDomain(content, modifier.arguments, context)
      return content
    }
    if (modifier.name === "transition") {
      const transition = modifier.arguments[0]
      if (runtime && transition && typeof transition === "object" && "descriptor" in transition) {
        const state: DomTransitionState = {
          transition: transition as Transition,
          animation: context.activeTransaction?.animation,
        }
        for (const node of outputNodes(content)) {
          if (node.nodeType === 1) runtime.transitionStates.set(node, state)
        }
      }
      return content
    }
    if (modifier.name === "contentTransition") {
      const transition = modifier.arguments[0]
      recordMotionStyleProperties(content, [contentMotionProperty], context)
      if (runtime && transition && typeof transition === "object" && "descriptor" in transition) {
        const state: DomContentTransitionState = {
          transition: transition as ContentTransition,
          animation: context.activeTransaction?.animation,
        }
        for (const node of outputNodes(content)) {
          if (node.nodeType === 1) runtime.contentTransitionStates.set(node, state)
        }
      }
      return content
    }
    if (modifier.name === "keyed" || modifier.name === "id") {
      const key = typeof modifier.arguments[0] === "string" || typeof modifier.arguments[0] === "number"
        ? modifier.arguments[0]
        : undefined
      if (key === undefined) return content
      context.hasDomKeys = true
      for (const node of outputNodes(content)) context.domKeys.set(node, key)
      return content
    }
    if (modifier.name === "frame") {
      const wrapper = renderElement(
        "div",
        { style: frameStyle(modifier.arguments[0] && typeof modifier.arguments[0] === "object" ? modifier.arguments[0] : {}) },
        [content],
      ) as Element
      recordMotionStyleProperties(wrapper, Object.keys(styleOf(modifier, false)), context)
      return wrapper
    }
    if ((modifier.name === "background" || modifier.name === "overlay" || modifier.name === "listRowBackground")
      && typeof modifier.arguments[0] !== "string" && modifier.arguments[0] != null && renderArgument) {
      const layer = renderArgument(0)
      const alignment = modifier.arguments[1]
      const wrapper = renderElement("div", { style: { display: "grid", position: "relative" } }, []) as Element
      const place = alignment === "leading" ? "center start"
        : alignment === "trailing" ? "center end"
          : alignment === "top" ? "start center"
            : alignment === "bottom" ? "end center"
              : alignment === "topLeading" ? "start start"
                : alignment === "topTrailing" ? "start end"
                  : alignment === "bottomLeading" ? "end start"
                    : alignment === "bottomTrailing" ? "end end"
                      : "center"
      const layerWrapper = renderElement("div", { style: { gridArea: "1 / 1", placeSelf: place, pointerEvents: modifier.name === "overlay" ? undefined : "none" } }, [layer])
      const contentWrapper = renderElement("div", { style: { gridArea: "1 / 1", minWidth: 0, minHeight: 0 } }, [content])
      if (modifier.name !== "overlay") {
        appendDomChild(wrapper, layerWrapper, context)
        appendDomChild(wrapper, contentWrapper, context)
      } else {
        appendDomChild(wrapper, contentWrapper, context)
        appendDomChild(wrapper, layerWrapper, context)
      }
      return wrapper
    }
    const extraStyle = styleOf(modifier, false)
    const extraProps = propsOf(modifier)
    if (Object.keys(extraProps).length === 0 && Object.keys(extraStyle).length === 0) return content
    const baseStyle = Object.keys(extraStyle).length > 0 || extraProps.style
      ? { ...extraStyle, ...(extraProps.style && typeof extraProps.style === "object" ? extraProps.style : {}) }
      : undefined
    if (baseStyle) recordMotionStyleProperties(content, Object.keys(baseStyle).map(cssPropertyName), context)
    if ((Object.keys(extraProps).length > 0 || baseStyle)
      && stageReusableModifierPatch(content, modifier, extraProps, baseStyle, context)) return content
    if (Object.keys(extraProps).length > 0 || baseStyle) content = promoteReusableContent(content, context)
    const nodes = outputNodes(content)
    nodes.forEach(node => {
      if (node.nodeType !== 1) return
      const element = node as Element
      const style = baseStyle ? { ...baseStyle } as Record<string, unknown> : undefined
      if (style && typeof style.transform === "string") {
        const remembered = context.domProps.get(element)?.style
        const currentTransform = remembered && typeof remembered === "object"
          ? (remembered as Record<string, unknown>).transform
          : (element as Element & { readonly style?: CSSStyleDeclaration }).style?.transform
        if (typeof currentTransform === "string" && currentTransform) style.transform = `${currentTransform} ${style.transform}`
      }
      const props = { ...extraProps, ...(style ? { style } : {}) }
      const appliedProps = element.localName.includes("-") ? props : nativeElementProps(props)
      if (Object.keys(appliedProps).length > 0) applyDomProps(element, appliedProps, context)
    })
    return content
  }

  const materializeView = (
    node: ViewHostNode,
    render: (props?: Record<string, unknown>) => Node,
    identity: readonly (string | number)[],
    force = false,
  ): Node => {
    const key = viewIdentityKey(identity)
    context.visitedStateIdentities.add(key)
    runtime?.passVisitedStates.add(key)
    let entry = context.states.get(key)
    if (!entry || entry.host !== node.host) {
      entry = { host: node.host, value: node.state?.(node.props) ?? {} }
      context.states.set(key, entry)
    }
    const resolvedProps = { ...node.props, ...entry.value }
    if (!runtime) return render(resolvedProps)

    const parentKey = runtime.stack.at(-1)
    if (!force || runtime.boundaryRootKey !== key) {
      if (parentKey) runtime.boundaries.get(parentKey)?.nextChildren.add(key)
      else runtime.rootNextChildren.add(key)
    }

    let boundary = runtime.boundaries.get(key)
    if (!boundary || boundary.host !== node.host) {
      if (boundary) {
        boundary.subscriptions.forEach(unsubscribe => unsubscribe())
        boundary.subscriptions.clear()
      }
      boundary = {
        key,
        identity: [...identity],
        host: node.host,
        node,
        render,
        resolvedProps,
        dependencies: new Set(),
        subscriptions: new Map(),
        children: new Set(),
        nextChildren: new Set(),
        currentNodes: [],
        nextNodes: [],
        outerModifiers: [],
        parentKey,
        pendingMutations: [],
        pendingDependencies: new Set(),
        depth: 0,
        scheduled: false,
        mounted: false,
        localSafe: true,
        renderedBody: true,
      }
      runtime.boundaries.set(key, boundary)
    }

    const canReuse = !force
      && !runtime.forceAll
      && boundary.mounted
      && !boundary.scheduled
      && boundary.host === node.host
      && shallowRecordEqual(boundary.resolvedProps, resolvedProps)
      && boundary.currentNodes.length > 0
      && boundary.currentNodes.every(current => current.parentNode !== null)

    boundary.host = node.host
    boundary.identity = [...identity]
    boundary.node = node
    boundary.render = render
    boundary.resolvedProps = resolvedProps
    updateBoundaryDepth(boundary, parentKey, runtime)
    boundary.nextNodes = []
    boundary.nextChildren.clear()
    runtime.renderedKeys.add(key)

    if (canReuse) {
      boundary.renderedBody = false
      boundary.children.forEach(child => boundary!.nextChildren.add(child))
      boundary.children.forEach(child => retainBoundaryStateTree(child, context, runtime))
      boundary.outerModifiers = []
      const output = reusableBoundaryOutput(boundary, context)
      markBoundaryOutput(output, key, runtime)
      return output
    }

    const previousOuterModifiers = force ? [...boundary.outerModifiers] : []
    if (!force) boundary.outerModifiers = []
    boundary.renderedBody = true
    boundary.localSafe = true
    const declared = node.dependencies
      ? collectStateReads(() => node.dependencies!(resolvedProps), () => undefined)
      : undefined
    const dependencies = new Set<StateRef<unknown>>(declared ?? [])
    const observedDependencies = new Set<StateRef<unknown>>()
    runtime.stack.push(key)
    let output: Node
    try {
      output = withRenderTransaction(boundary.pendingTransaction, () => collectStateReads(
        () => {
          // A locally-updated, modifier-free View whose body is one ordinary
          // host element containing a stable keyed text-row set can patch the
          // bound live nodes directly. Evaluate the graph once, validate the
          // complete shape before touching the DOM, and retain the generic
          // renderer/reconciler as the exact fallback for every other case.
          if (force && previousOuterModifiers.length === 0 && boundary.children.size === 0
            && boundary.currentNodes.length === 1 && !context.activeTransaction?.animation) {
            const graph = node.render(resolvedProps)
            if (patchKeyedCollectionBoundary(boundary, graph, context, runtime)
              || patchFlatKeyedHostBoundary(boundary, graph, context)
              || patchFlatHostBoundary(boundary, graph, context)) {
              boundary.pendingMutations.length = 0
              return reusableBoundaryOutput(boundary, context)
            }
            // A previously proven collection may leave its capability set.
            // Drop the executor before the generic renderer takes ownership;
            // collection() is suppressed during this candidate pass so it
            // cannot retain detached nodes produced for reconciliation.
            discardDomCollections(runtime, boundary.key)
            runtime.suppressCollectionDirect = true
            try {
              return renderViewNodeAt(graph, renderer, [...identity, "body"])
            } finally {
              runtime.suppressCollectionDirect = false
            }
          }
          return render(resolvedProps)
        },
        dependency => {
          observedDependencies.add(dependency)
          if (!(declared && node.dependenciesComplete === true)) dependencies.add(dependency)
        },
      ))
    } finally {
      runtime.stack.pop()
    }
    // Compiler-generated struct metadata conservatively declares every
    // @State field. A persistent collection below this boundary can own one
    // of those States directly; keeping the parent subscribed would defeat
    // the collection executor and rerender the whole View on every row
    // mutation. Only subtract a declared dependency when the collection has
    // actually registered its own State subscription and the body did not
    // independently read that State during this render.
    if (declared && runtime.collectionKeysByOwner.has(key)) {
      for (const collectionKey of runtime.collectionKeysByOwner.get(key) ?? []) {
        const collection = runtime.collections.get(collectionKey)
        const source = collection?.node.source
        if (isStateRef(source) && !observedDependencies.has(source)) dependencies.delete(source)
      }
    }
    boundary.dependencies = dependencies
    boundary.scheduled = false
    boundary.pendingTransaction = undefined
    boundary.pendingMutations.length = 0
    boundary.pendingDependencies.clear()
    markBoundaryOutput(output, key, runtime)

    if (force && previousOuterModifiers.length > 0) {
      runtime.replayingModifiers = true
      try {
        for (const modifier of previousOuterModifiers) output = applyModifier(output, modifier)
      } finally {
        runtime.replayingModifiers = false
      }
      boundary.outerModifiers = previousOuterModifiers
      markBoundaryOutput(output, key, runtime)
    }
    return output
  }

  runtime && Object.assign(runtime, { materializeView })

  renderer = {
    element(type, props, ...children) {
      return renderElement(type, props, children)
    },
    fragment(children) {
      return renderFragment(children)
    },
    value(value) {
      return renderValue(value)
    },
    gpuIsland(node: GPUIslandViewNode) {
      const canvas = renderElement("canvas", {
        ...(node.options.width === undefined ? {} : { width: node.options.width }),
        ...(node.options.height === undefined ? {} : { height: node.options.height }),
        ...(node.options.class === undefined ? {} : { class: node.options.class }),
        ...(node.options.style === undefined ? {} : { style: node.options.style }),
        ...(node.options.ariaLabel === undefined ? {} : { "aria-label": node.options.ariaLabel }),
        "data-mun-gpu-island": node.ir.id,
        "data-mun-gpu-kind": node.ir.kind,
        "data-mun-gpu-owner": "direct-web",
        "data-mun-gpu-readback": "forbidden",
        "data-mun-gpu-fallback": node.ir.fallback,
      }, [])
      if (canvas.nodeType === 1 && (canvas as Element).localName === "canvas") {
        mountParticleFieldGPUIslandCanvas(canvas as HTMLCanvasElement, node, {
          experimentalResidentCompute: context.experimentalResidentCompute === true
            || node.options.experimentalResidentCompute === true,
        })
      }
      return canvas
    },
    template(node, renderSlot, identity) {
      let factory = templateFactories.get(node.template)
      if (!factory) {
        factory = compileTemplate(node.template.root)
        templateFactories.set(node.template, factory)
      }

      const key = viewIdentityKey([...identity, "compiled-template"])
      const textOnly = node.template.slotKinds.length === node.template.slotCount
        && node.template.slotKinds.every(kind => kind === "text")
      const previous = runtime?.compiledTemplates.get(key)
      const program = patchProgram(node.template)

      // Compiler-proven text-only templates do not need their immutable host
      // tree rebuilt on every evaluation. Render only the dynamic primitive
      // slots, carry the existing roots through reconciliation as tiny comment
      // identities, and patch the bound live Text nodes in place. Static
      // zero-slot templates take this path too and allocate no candidate DOM.
      if (runtime && textOnly && previous?.template === node.template
        && previous.roots.length > 0
        && previous.roots.every(root => root.parentNode !== null)
        && previous.textSlots.length === node.template.slotCount
        && previous.textSlots.every(slot => slot?.parentNode !== null)) {
        const nextText = new Array<string>(node.template.slotCount)
        let valid = true
        for (let index = 0; index < node.template.slotCount; index += 1) {
          // The compiler proved this slot came from Text's primitive value
          // initializer. Read the graph slot directly instead of materializing a
          // throwaway Text node just to discover the next text payload.
          const slot = compiledTextSlotValue(node.slots[index])
          if (!slot.ok) {
            valid = false
            break
          }
          nextText[index] = slot.value
        }
        if (valid) {
          let patched = false
          const patch = () => {
            if (patched) return
            patched = true
            if (program) applyCompiledPatch(previous, program, fullPatchCandidates(program, nextText), context)
            else for (let index = 0; index < nextText.length; index += 1) {
                const live = previous.textSlots[index]
                if (live && live.nodeValue !== nextText[index]) live.nodeValue = nextText[index]
              }
          }
          if (previous.roots.length === 1) {
            const candidate = reusableCompiledTemplateCandidate(previous.roots[0], previous.rootProps[0] ?? null, context)
            runtime.compiledTemplatePatches.set(candidate, patch)
            return candidate
          }
          const fragment = context.document.createDocumentFragment()
          for (let index = 0; index < previous.roots.length; index += 1) {
            const candidate = reusableCompiledTemplateCandidate(previous.roots[index], previous.rootProps[index] ?? null, context)
            runtime.compiledTemplatePatches.set(candidate, patch)
            fragment.appendChild(candidate)
          }
          return fragment
        }
      }

      const renderedSlots = new Array<Node | undefined>(node.template.slotCount)
      const slotNodes = new Array<Text | undefined>(node.template.slotCount)
      const viewSlotNodes = new Array<Node[] | undefined>(node.template.slotCount)
      const renderCachedSlot = (index: number): Node => {
        const cached = renderedSlots[index]
        if (cached) return cached
        const slot = renderSlot(index)
        renderedSlots[index] = slot
        if (runtime && node.template.slotKinds[index] === "text" && slot.nodeType === 3) {
          slotNodes[index] = slot as Text
          runtime.compiledTemplateTextSlots.set(slot, { key, index })
        } else if (runtime && node.template.slotKinds[index] === "view") {
          const nodes = outputNodes(slot)
          viewSlotNodes[index] = nodes
          for (const root of nodes) runtime.compiledTemplateViewSlots.set(root, { key, index })
        }
        return slot
      }
      const output = factory(renderCachedSlot)
      if (runtime) {
        const roots = outputNodes(output)
        const nodes = templateNodeTable(output)
        const rootProps = roots.map(root => root.nodeType === 1
          ? cloneStoredDomProps(context.domProps.get(root as Element))
          : null)
        const instance: DomCompiledTemplateInstance = { template: node.template, roots: [...roots], rootProps, textSlots: slotNodes, viewSlots: viewSlotNodes, nodes }
        runtime.compiledTemplates.set(key, instance)
        roots.forEach((root, index) => runtime.compiledTemplateRoots.set(root, { key, index }))
        nodes.forEach((item, index) => runtime.compiledTemplateNodes.set(item, { key, index }))
      }
      return output
    },
    collection(node, renderEntry, identity) {
      const ownerKey = runtime?.stack.at(-1)
      const owner = ownerKey ? runtime?.boundaries.get(ownerKey) : undefined
      const canTrackCollection = Boolean(runtime && ownerKey && owner
        && !context.hydrating && !context.stagingProps && !context.stagingEvents)
      if (canTrackCollection && runtime && ownerKey && owner) {
        if (!runtime.suppressCollectionDirect && !owner.mounted && owner.currentNodes.length === 0) {
          const direct = materializeDirectCollection(node, identity, ownerKey, context, runtime)
          if (direct) return direct
        }
        // Candidate fallback rendering suppresses direct DOM ownership, but a
        // compiler-isolated State source still needs a fresh invalidation
        // subscription after the previous executor is discarded.
        registerGenericStateCollection(node, identity, ownerKey, context, runtime)
      }
      if (runtime?.hydrationReuse) {
        const direct = renderHydratedCompiledCollection(node, identity, ownerKey)
        if (direct) return direct
        const children: Node[] = []
        for (const entry of keyedCollectionEntries(node)) children.push(renderEntry(entry))
        return renderFragment(children)
      }
      const fragment = context.document.createDocumentFragment()
      for (const entry of keyedCollectionEntries(node)) appendDomChild(fragment, renderEntry(entry), context)
      return fragment
    },
    lazy(node, render, identity, renderItem) {
      markUnsafeViewAncestors(context)
      const key = viewIdentityKey(identity)
      context.visitedLazyIdentities.add(key)
      context.lazyNodes.set(key, node)
      const element = context.document.createElement("div")
      applyDomProps(element, node.props, context)
      context.lazyKeys.set(element, key)
      const measurement = lazyMeasurementIndex(context, key, node)
      const requested = context.lazyRanges.get(key) ?? lazyRangeForElement(element, node, measurement)
      const range = boundedLazyRange(requested, node.children.length)
      context.lazyRanges.set(key, range)
      const preserved = new Set<string>()
      node.children.forEach((child, index) => {
        if (index >= range.start && index < range.end) return
        for (const logicalIdentity of collectLogicalViewIdentities(child, [...identity, "lazy", index])) {
          preserved.add(viewIdentityKey(logicalIdentity))
        }
      })
      context.preservedLazyStatePrefixes.set(key, preserved)
      if (range.start > 0) appendDomChild(element, lazySpacer(context, node, measurement.hiddenBeforeSize(range.start), "before"), context)
      if (renderItem) {
        for (let index = range.start; index < range.end; index += 1) {
          const wrapper = context.document.createElement("div")
          wrapper.setAttribute("data-mun-lazy-item", "")
          wrapper.setAttribute("data-mun-lazy-index", String(index))
          wrapper.style.boxSizing = "border-box"
          wrapper.style.flex = "0 0 auto"
          if (node.axis !== "horizontal") wrapper.style.width = "100%"
          context.lazyItemMetadata.set(wrapper, { key, index })
          appendDomChild(wrapper, renderItem(index), context)
          appendDomChild(element, wrapper, context)
        }
      } else {
        appendDomChild(element, render(range), context)
      }
      if (range.end < node.children.length) appendDomChild(element, lazySpacer(context, node, measurement.hiddenAfterSize(range.end), "after"), context)
      return element
    },
    modifier(content, modifier, renderArgument) {
      return applyModifier(content, modifier, renderArgument)
    },
    view(node, render, identity) {
      return materializeView(node, render, identity)
    },
    geometry(_node, render) {
      markUnsafeViewAncestors(context)
      const index = context.geometryIndex++
      const wrapper = context.document.createElement("div")
      wrapper.dataset.mun = "GeometryReader"
      wrapper.dataset.munGeometry = String(index)
      wrapper.style.boxSizing = "border-box"
      wrapper.style.width = "100%"
      appendDomChild(wrapper, render(context.geometries.get(index) ?? zeroGeometry), context)
      return wrapper
    },
  }
  return renderer
}

function geometryFromElement(element: Element, persistentProbe?: HTMLElement): GeometryProxy {
  const rect = safeBoundingRect(element)
  if (!rect) return zeroGeometry
  const frame = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left }
  const document = element.ownerDocument
  const view = document.defaultView
  const fallback = { frame, size: { width: rect.width, height: rect.height }, safeAreaInsets: zeroGeometry.safeAreaInsets }
  if (!view?.getComputedStyle || !document.body) return fallback
  const probe = persistentProbe ?? document.createElement("div")
  const ownsProbe = persistentProbe === undefined
  let measured = false
  probe.style.cssText = "position:fixed;inset:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"
  try {
    if (!probe.parentNode) document.body.appendChild(probe)
    const style = view.getComputedStyle(probe)
    const safeAreaInsets = edgeInsetsFromCss({ top: style.paddingTop, right: style.paddingRight, bottom: style.paddingBottom, left: style.paddingLeft })
    measured = true
    return { frame, size: { width: rect.width, height: rect.height }, safeAreaInsets }
  } catch {
    // Geometry is still useful when CSSOM access is unavailable (sandboxed or
    // synthetic documents). Safe-area measurement is optional, not fatal.
    return fallback
  } finally {
    if (ownsProbe || !measured) {
      try { probe.remove() } catch { /* detached/synthetic DOM cleanup is best-effort */ }
    }
  }
}

function sameGeometry(left: GeometryProxy, right: GeometryProxy): boolean {
  return left.frame.x === right.frame.x
    && left.frame.y === right.frame.y
    && left.frame.width === right.frame.width
    && left.frame.height === right.frame.height
    && left.safeAreaInsets.top === right.safeAreaInsets.top
    && left.safeAreaInsets.right === right.safeAreaInsets.right
    && left.safeAreaInsets.bottom === right.safeAreaInsets.bottom
    && left.safeAreaInsets.left === right.safeAreaInsets.left
}

export interface WebMountOptions {
  readonly hydrate?: boolean
  readonly disablesAnimations?: boolean | (() => boolean)
  /** Opt in to experimental Resident Compute WASM/Worker/GPU paths. */
  readonly experimentalResidentCompute?: boolean | Readonly<{ enabled?: boolean; gpu?: boolean }>
}

export function mount(value: ViewGraphValue, container: Element, options: WebMountOptions = {}): () => void {
  const experimentalResidentCompute = options.experimentalResidentCompute === true
    || (typeof options.experimentalResidentCompute === "object"
      && options.experimentalResidentCompute.enabled === true
      && options.experimentalResidentCompute.gpu !== false)
  let stopped = false
  let scheduled = false
  let pendingTransaction: Transaction | undefined
  const animationsDisabled = (): boolean => typeof options.disablesAnimations === "function"
    ? options.disablesAnimations()
    : options.disablesAnimations === true
  const hostTransaction = (transaction: Transaction | undefined): Transaction | undefined => {
    if (!animationsDisabled()) return transaction
    return new Transaction({
      animation: transaction?.animation ?? null,
      disablesAnimations: true,
      isContinuous: transaction?.isContinuous ?? false,
    })
  }
  const subscriptions = new Map<StateRef<unknown>, () => void>()
  const syncSubscriptions = (dependencies: Set<StateRef<unknown>>, schedule: (transaction: Transaction) => void) => {
    for (const [dependency, unsubscribe] of subscriptions) {
      if (dependencies.has(dependency)) continue
      unsubscribe()
      subscriptions.delete(dependency)
    }
    for (const dependency of dependencies) {
      if (subscriptions.has(dependency)) continue
      subscriptions.set(dependency, subscribeState(dependency, schedule))
    }
  }
  const document = container.ownerDocument
  const canMaterializeDOM = typeof document?.createElement === "function" && typeof (container as Element & { replaceChildren?: unknown }).replaceChildren === "function"

  if (canMaterializeDOM) {
    const context: DomRenderContext = {
      document,
      experimentalResidentCompute,
      states: new Map(),
      visitedStateIdentities: new Set(),
      geometries: new Map(),
      hydrationProps: new WeakMap(),
      domProps: new WeakMap(),
      eventListeners: new WeakMap(),
      eventTargetCount: 0,
      domKeys: new WeakMap(),
      keyedParents: new WeakSet(),
      hasDomKeys: false,
      domTags: new WeakMap(),
      lazyRanges: new Map(),
      lazyMeasurements: new Map(),
      lazySizeIndexes: new Map(),
      lazyItemMetadata: new WeakMap(),
      lazyNodes: new Map(),
      preservedLazyStatePrefixes: new Map(),
      visitedLazyIdentities: new Set(),
      lazyKeys: new WeakMap(),
      geometryIndex: 0,
      hasRefs: false,
      refElements: new Set(),
      hydrating: false,
      stagingEvents: true,
      stagingProps: true,
      activeTransaction: undefined,
    }
    const viewRuntime: DomViewRuntime = {
      boundaries: new Map(),
      nodeKeys: new WeakMap(),
      reuseCandidates: new WeakMap(),
      reuseCandidateBaseProps: new WeakMap(),
      compiledTemplates: new Map(),
      compiledTemplateRoots: new WeakMap(),
      compiledTemplateTextSlots: new WeakMap(),
      compiledTemplateViewSlots: new WeakMap(),
      compiledTemplateNodes: new WeakMap(),
      compiledTemplatePatches: new WeakMap(),
      collections: new Map(),
      collectionKeysByOwner: new Map(),
      motionStates: new WeakMap(),
      transitionStates: new WeakMap(),
      contentTransitionStates: new WeakMap(),
      enteredTransitions: new WeakSet(),
      exitTransitions: new Map(),
      animationsDisabled,
      layoutSnapshots: new Map(),
      layoutNeighborhoodAnimations: new Map(),
      stack: [],
      renderedKeys: new Set(),
      passVisitedStates: new Set(),
      rootChildren: new Set(),
      rootNextChildren: new Set(),
      forceAll: false,
      replayingModifiers: false,
      suppressCollectionDirect: false,
    }
    domViewRuntimes.set(context, viewRuntime)
    const renderer = createDomRenderer(context)
    let activeRefs = new Map<Element, { readonly reference: unknown; readonly cleanup: () => void }>()
    let geometryScheduled = false
    let lazyMeasureScheduled = false
    let lazyItemObserver: ResizeObserver | undefined
    const lazyViewportTargets = new Set<EventTarget>()
    const lazyViewportCleanups: Array<() => void> = []
    let hasMounted = false
    let update: () => void
    // Reuse one hidden safe-area probe for every GeometryReader in this mount.
    // Appending/removing a probe per reader forces avoidable style/layout work.
    const geometryProbe = document.createElement("div")
    geometryProbe.style.cssText = "position:fixed;inset:0;visibility:hidden;pointer-events:none"

    const collectPreservedStatePrefixes = (): Set<string> => {
      const result = new Set<string>()
      for (const prefixes of context.preservedLazyStatePrefixes.values()) {
        for (const prefix of prefixes) result.add(prefix)
      }
      return result
    }
    const isPreservedStateKey = (key: string, prefixes: ReadonlySet<string>): boolean => {
      if (prefixes.has(key)) return true
      // View identity keys are segment-delimited with '|'. Probe the few
      // segment boundaries in this key instead of comparing against every
      // offscreen lazy-row prefix. This turns cleanup from O(states * hidden
      // rows) into O(states * identity depth).
      for (let separator = key.indexOf("|"); separator >= 0; separator = key.indexOf("|", separator + 1)) {
        if (prefixes.has(key.slice(0, separator))) return true
      }
      return false
    }
    const disposeBoundary = (key: string, preserveState = false, preservedPrefixes?: ReadonlySet<string>): void => {
      const boundary = viewRuntime.boundaries.get(key)
      if (!boundary) {
        if (!preserveState) context.states.delete(key)
        return
      }
      for (const child of [...boundary.children]) {
        const preserveChild = preserveState || Boolean(preservedPrefixes && isPreservedStateKey(child, preservedPrefixes))
        disposeBoundary(child, preserveChild, preservedPrefixes)
      }
      boundary.subscriptions.forEach(unsubscribe => unsubscribe())
      boundary.subscriptions.clear()
      boundary.pendingMutations.length = 0
      discardDomCollections(viewRuntime, key)
      boundary.scheduled = false
      boundary.currentNodes = []
      viewRuntime.boundaries.delete(key)
      recordMunBoundaryDisposed(key)
      if (!preserveState) context.states.delete(key)
    }
    const beginViewPass = (boundaryRootKey?: string): void => {
      viewRuntime.renderedKeys = new Set()
      viewRuntime.passVisitedStates = new Set()
      viewRuntime.boundaryRootKey = boundaryRootKey
      if (!boundaryRootKey) viewRuntime.rootNextChildren.clear()
    }
    const scheduledBoundaryUpdates = new Set<DomViewBoundary>()
    let boundaryFlushScheduled = false
    let updateBoundary!: (boundary: DomViewBoundary) => void
    const flushBoundaryUpdates = (): void => {
      boundaryFlushScheduled = false
      if (stopped || scheduledBoundaryUpdates.size === 0) return
      const batch = [...scheduledBoundaryUpdates]
      scheduledBoundaryUpdates.clear()
      recordMunRuntimeEvent("boundaryFlushes")
      // Parent-first processing lets one ancestor reconciliation absorb all of
      // its dirty descendants instead of running N independent microtasks.
      // Cached depth preserves the parent-first order without allocating a
      // cycle-detection Set and walking every boundary's ancestors per flush.
      batch.sort((left, right) => left.depth - right.depth)
      for (const boundary of batch) {
        if (!boundary.scheduled) continue
        updateBoundary(boundary)
      }
      if (scheduledBoundaryUpdates.size > 0 && !boundaryFlushScheduled) {
        boundaryFlushScheduled = true
        queueMicrotask(flushBoundaryUpdates)
      }
    }
    const enqueueBoundaryUpdate = (boundary: DomViewBoundary): void => {
      scheduledBoundaryUpdates.add(boundary)
      if (boundaryFlushScheduled || stopped) return
      boundaryFlushScheduled = true
      queueMicrotask(flushBoundaryUpdates)
    }

    const requestRootUpdate = (transaction?: Transaction, forceAll = true): void => {
      if (transaction || animationsDisabled()) pendingTransaction = hostTransaction(transaction)
      if (forceAll) viewRuntime.forceAll = true
      if (scheduled || stopped) return
      scheduled = true
      recordMunRuntimeEvent("rootRequests")
      queueMicrotask(() => update())
    }
    const syncBoundarySubscriptions = (boundary: DomViewBoundary): void => {
      for (const [dependency, unsubscribe] of boundary.subscriptions) {
        if (boundary.dependencies.has(dependency)) continue
        unsubscribe()
        boundary.subscriptions.delete(dependency)
      }
      for (const dependency of boundary.dependencies) {
        if (boundary.subscriptions.has(dependency)) continue
        boundary.subscriptions.set(dependency, subscribeState(dependency, (transaction, batch) => {
          recordMunRuntimeEvent("boundaryInvalidations")
          boundary.pendingTransaction = hostTransaction(transaction)
          boundary.pendingMutations.push(...batch.mutations)
          boundary.pendingDependencies.add(dependency)
          if (boundary.scheduled || stopped) return
          boundary.scheduled = true
          if (!boundary.mounted || boundary.currentNodes.length === 0) {
            recordMunRuntimeEvent("rootEscalations")
            // A View that currently renders no DOM has no stable local range
            // to patch. Schedule the root pass immediately so a single state
            // microtask can materialize the newly-visible branch. Force the
            // pass because an unchanged mounted ancestor could otherwise be
            // reused before traversal reaches this empty descendant.
            requestRootUpdate(transaction, true)
            return
          }
          if (!boundary.localSafe) {
            recordMunRuntimeEvent("rootEscalations")
            // The owning boundary itself must be re-evaluated at the root so
            // geometry/lazy indexes stay globally coherent, but unaffected
            // child View boundaries can still be reused.
            requestRootUpdate(transaction, false)
            return
          }
          enqueueBoundaryUpdate(boundary)
        }))
      }
    }
    const commitViewPass = (rootPass: boolean): void => {
      const preservedPrefixes = collectPreservedStatePrefixes()
      for (const key of viewRuntime.renderedKeys) {
        const boundary = viewRuntime.boundaries.get(key)
        if (!boundary) continue
        // Reused boundaries keep the same live node range, dependency set, and
        // child boundary graph. Their parent/key metadata was already updated
        // during materialization, so rebuilding Sets and resyncing subscribers
        // here is pure list-size-proportional bookkeeping.
        if (!boundary.renderedBody) continue
        const uniqueNodes = [...new Set(boundary.nextNodes)]
        boundary.currentNodes = uniqueNodes
        boundary.mounted = boundary.currentNodes.length > 0 && boundary.currentNodes.some(node => node.parentNode !== null)
        syncBoundarySubscriptions(boundary)
        if (boundary.renderedBody) {
          for (const child of [...boundary.children]) {
            if (boundary.nextChildren.has(child)) continue
            disposeBoundary(child, isPreservedStateKey(child, preservedPrefixes), preservedPrefixes)
          }
          boundary.children.clear()
          boundary.nextChildren.forEach(child => boundary.children.add(child))
        }
      }
      if (rootPass) {
        for (const child of [...viewRuntime.rootChildren]) {
          if (viewRuntime.rootNextChildren.has(child)) continue
          disposeBoundary(child, isPreservedStateKey(child, preservedPrefixes), preservedPrefixes)
        }
        viewRuntime.rootChildren.clear()
        viewRuntime.rootNextChildren.forEach(child => viewRuntime.rootChildren.add(child))
      }
      viewRuntime.boundaryRootKey = undefined
    }
    const refElementBelongsToMount = (element: Element): boolean => {
      if (container.contains(element)) return true
      // HTMLTemplateElement.content is a detached DocumentFragment by DOM
      // design, so container.contains() is false for a live ref inside a
      // mounted template. Refs are normally sparse; inspect only template
      // content roots rather than returning to a whole-tree element scan.
      const pending = [...container.querySelectorAll<HTMLTemplateElement>("template")]
      const seen = new Set<HTMLTemplateElement>()
      while (pending.length > 0) {
        const template = pending.pop()!
        if (seen.has(template)) continue
        seen.add(template)
        if (template.content.contains(element)) return true
        pending.push(...template.content.querySelectorAll<HTMLTemplateElement>("template"))
      }
      return false
    }
    const commitRefs = () => {
      if (!context.hasRefs && activeRefs.size === 0) return
      const desired = new Map<Element, unknown>()
      for (const element of context.refElements) {
        if (!refElementBelongsToMount(element)) {
          context.refElements.delete(element)
          continue
        }
        const reference = context.domProps.get(element)?.ref
        if (reference !== undefined && reference !== null) desired.set(element, reference)
      }
      const next = new Map<Element, { readonly reference: unknown; readonly cleanup: () => void }>()
      for (const [element, reference] of desired) {
        const previous = activeRefs.get(element)
        if (previous && previous.reference === reference) {
          next.set(element, previous)
          continue
        }
        previous?.cleanup()
        next.set(element, { reference, cleanup: setDomRef(reference, element) })
      }
      for (const [element, previous] of activeRefs) {
        if (!desired.has(element)) previous.cleanup()
      }
      activeRefs = next
    }
    const updateGeometry = () => {
      if (stopped || context.geometryIndex === 0) {
        // GeometryReaders removed since the last pass must not leave stale
        // frames behind: a recycled render-order index would otherwise
        // inherit the removed reader's measurements.
        if (context.geometries.size > 0) context.geometries.clear()
        return
      }
      let changed = false
      const seen = new Set<number>()
      container.querySelectorAll<HTMLElement>('[data-mun="GeometryReader"][data-mun-geometry]').forEach(element => {
        const index = Number(element.dataset.munGeometry)
        if (!Number.isInteger(index)) return
        seen.add(index)
        const next = geometryFromElement(element, geometryProbe)
        const previous = context.geometries.get(index)
        if (!previous || !sameGeometry(previous, next)) {
          context.geometries.set(index, next)
          changed = true
        }
      })
      for (const index of [...context.geometries.keys()]) {
        if (!seen.has(index)) {
          context.geometries.delete(index)
          changed = true
        }
      }
      if (changed && !geometryScheduled) {
        geometryScheduled = true
        queueMicrotask(() => {
          geometryScheduled = false
          requestRootUpdate(undefined, true)
        })
      }
    }
    const refreshLazyRanges = (): boolean => {
      if (context.lazyNodes.size === 0) return false
      let changed = false
      const elements = [...container.querySelectorAll<HTMLElement>("[data-mun-lazy]")]
      for (const element of elements) {
        const key = context.lazyKeys.get(element)
        if (!key) continue
        const node = context.lazyNodes.get(key)
        if (!node) continue
        const measurement = lazyMeasurementIndex(context, key, node)
        const next = lazyRangeForElement(element, node, measurement)
        if (!sameLazyRange(context.lazyRanges.get(key), next)) {
          context.lazyRanges.set(key, next)
          changed = true
        }
      }
      return changed
    }
    const scheduleLazyMeasure = () => {
      if (stopped || lazyMeasureScheduled) return
      lazyMeasureScheduled = true
      queueMicrotask(() => {
        lazyMeasureScheduled = false
        if (stopped || !refreshLazyRanges() || scheduled) return
        requestRootUpdate(undefined, true)
      })
    }
    const measureLazyItem = (element: HTMLElement): boolean => {
      const metadata = context.lazyItemMetadata.get(element)
      if (!metadata) return false
      const node = context.lazyNodes.get(metadata.key)
      const measurement = context.lazySizeIndexes.get(metadata.key)
      if (!node || !measurement) return false
      const rect = safeBoundingRect(element)
      let size = node.axis === "horizontal" ? rect?.width : rect?.height
      if (!size || !Number.isFinite(size) || size <= 0) {
        // The wrapper can be temporarily unmeasurable while its rendered
        // child already has a stable intrinsic box. This also keeps lazy
        // measurement useful in lightweight DOM implementations that do
        // not lay wrapper elements out themselves.
        const childRect = element.firstElementChild ? safeBoundingRect(element.firstElementChild) : undefined
        size = node.axis === "horizontal" ? childRect?.width : childRect?.height
      }
      if (!size || !Number.isFinite(size) || size <= 0) return false
      const delta = measurement.set(metadata.index, size)
      if (Math.abs(delta) < 0.01) return false

      // Keep the same logical content under the viewport when an overscan row
      // above it changes height. The normal root pass snapshots this adjusted
      // position and therefore does not undo the correction.
      const containerElement = element.parentElement
      if (!containerElement) return true
      const scrollParent = lazyScrollParent(containerElement, node.axis)
      const elementRect = safeBoundingRect(element)
      const logicalStart = context.lazyRanges.get(metadata.key)?.start ?? 0
      if (scrollParent) {
        const parentRect = safeBoundingRect(scrollParent)
        const measuredAxis = node.axis === "horizontal"
          ? Math.max(elementRect?.width ?? 0, parentRect?.width ?? 0)
          : Math.max(elementRect?.height ?? 0, parentRect?.height ?? 0)
        const beforeViewport = measuredAxis > 0
          ? node.axis === "horizontal"
            ? (elementRect?.right ?? 0) <= (parentRect?.left ?? 0)
            : (elementRect?.bottom ?? 0) <= (parentRect?.top ?? 0)
          : metadata.index < logicalStart
        if (beforeViewport) {
          if (node.axis === "horizontal") scrollParent.scrollLeft += delta
          else scrollParent.scrollTop += delta
        }
      } else {
        const window = document.defaultView
        const measuredAxis = node.axis === "horizontal" ? elementRect?.width ?? 0 : elementRect?.height ?? 0
        const beforeViewport = measuredAxis > 0
          ? node.axis === "horizontal" ? (elementRect?.right ?? 0) <= 0 : (elementRect?.bottom ?? 0) <= 0
          : metadata.index < logicalStart
        if (window && beforeViewport) {
          window.scrollBy(node.axis === "horizontal" ? delta : 0, node.axis === "horizontal" ? 0 : delta)
        }
      }
      return true
    }
    const observeLazyItems = () => {
      if (context.lazyNodes.size === 0) {
        lazyItemObserver?.disconnect()
        return
      }
      if (typeof ResizeObserver === "undefined") {
        let changed = false
        container.querySelectorAll<HTMLElement>("[data-mun-lazy-item]").forEach(element => {
          if (measureLazyItem(element)) changed = true
        })
        if (changed) scheduleLazyMeasure()
        return
      }
      lazyItemObserver ??= new ResizeObserver(entries => {
        let changed = false
        for (const entry of entries) {
          if (measureLazyItem(entry.target as HTMLElement)) changed = true
        }
        if (changed) scheduleLazyMeasure()
      })
      lazyItemObserver.disconnect()
      container.querySelectorAll<HTMLElement>("[data-mun-lazy-item]").forEach(element => lazyItemObserver!.observe(element))
    }

    const observeLazyViewport = () => {
      const listener = scheduleLazyMeasure as EventListener
      if (context.lazyNodes.size === 0) {
        for (const target of lazyViewportTargets) {
          target.removeEventListener("scroll", listener)
          target.removeEventListener("resize", listener)
        }
        lazyViewportTargets.clear()
        return
      }
      const targets = new Set<EventTarget>()
      const window = document.defaultView
      if (window) targets.add(window)
      targets.add(container)
      container.querySelectorAll<HTMLElement>("[data-mun-lazy]").forEach(element => {
        const key = context.lazyKeys.get(element)
        const node = key ? context.lazyNodes.get(key) : undefined
        const parent = node ? lazyScrollParent(element, node.axis) : null
        if (parent) targets.add(parent)
      })
      // Detached or replaced scroll parents keep handler references alive
      // until unmount unless pruned on every pass.
      for (const target of [...lazyViewportTargets]) {
        if (targets.has(target)) continue
        lazyViewportTargets.delete(target)
        target.removeEventListener("scroll", listener)
        target.removeEventListener("resize", listener)
      }
      for (const target of targets) {
        if (lazyViewportTargets.has(target)) continue
        target.addEventListener("scroll", listener, { passive: true })
        target.addEventListener("resize", listener)
        lazyViewportTargets.add(target)
      }
      // The cleanup list mirrors the live target set; the shared listener is
      // removed per remaining target when the mount is disposed.
      lazyViewportCleanups.length = 0
      if (lazyViewportTargets.size > 0) {
        lazyViewportCleanups.push(() => {
          for (const target of lazyViewportTargets) {
            target.removeEventListener("scroll", listener)
            target.removeEventListener("resize", listener)
          }
          lazyViewportTargets.clear()
        })
      }
    }
    const captureLazyScrollPositions = () => {
      const positions = new Map<HTMLElement, { readonly top: number; readonly left: number }>()
      if (context.lazyNodes.size === 0) return positions
      container.querySelectorAll<HTMLElement>("[data-mun-lazy]").forEach(element => {
        const key = context.lazyKeys.get(element)
        const node = key ? context.lazyNodes.get(key) : undefined
        const parent = node ? lazyScrollParent(element, node.axis) : null
        if (parent && !positions.has(parent)) positions.set(parent, { top: parent.scrollTop, left: parent.scrollLeft })
      })
      return positions
    }
    const patchCompiledBoundary = (boundary: DomViewBoundary, transaction?: Transaction): boolean => {
      const plan = boundary.node.compiledBody
      if (!plan || boundary.node.dependenciesComplete !== true) return false
      // Outer modifiers are applied after the View body. Safe non-structural
      // modifiers can be replayed directly on top of the compiled body plan;
      // anything structural or effectful keeps the conservative generic path.
      const directOuterModifiers = plan.patchesModifiers ? boundary.outerModifiers : []
      if (directOuterModifiers.some(modifier => !directCompiledBodyModifierNames.has(modifier.name))) return false
      const template = plan.template
      const textOnly = template.slotKinds.length === template.slotCount && template.slotKinds.every(kind => kind === "text")
      const program = patchProgram(template)
      if (!program && !textOnly) return false

      const templateKey = viewIdentityKey([...boundary.identity, "body", "compiled-template"])
      const instance = viewRuntime.compiledTemplates.get(templateKey)
      if (!instance || instance.template !== template
        || instance.roots.length === 0
        || instance.roots.some(root => root.parentNode === null)
        || (textOnly && (instance.textSlots.length !== template.slotCount
          || instance.textSlots.some(slot => slot?.parentNode === null)))
        || (program && (instance.nodes.length === 0 || instance.nodes.some(node => node.parentNode === null)))) return false

      const previousTransaction = context.activeTransaction
      context.activeTransaction = transaction
      try {
        for (const root of instance.roots) {
          if (root.nodeType === 1) captureLayoutNeighborhood(root as Element, undefined, context)
        }
        const patched = withRenderTransaction(transaction, () => {
          const sparseDirty = program && !plan.patchesModifiers
            ? dependencyPatchCandidates(boundary, plan, program)
            : undefined
          let evaluation: ReturnType<typeof plan.evaluate> | undefined
          let nextText = new Array<string>(0)
          let candidatePatch: CompiledPatchValues | undefined
          if (program && sparseDirty && plan.evaluatePatch) {
            const scratch = instance.patchScratch ?? (instance.patchScratch = new Array(program.locations.length))
            plan.evaluatePatch(boundary.resolvedProps, sparseDirty, scratch)
            candidatePatch = { dirty: sparseDirty, values: scratch }
          } else {
            evaluation = plan.evaluate(boundary.resolvedProps)
            if (!evaluation || typeof evaluation !== "object" || !Array.isArray(evaluation.slots)
              || evaluation.slots.length !== template.slotCount) return false

            nextText = new Array<string>(textOnly ? template.slotCount : 0)
            if (textOnly) for (let index = 0; index < template.slotCount; index += 1) {
                const value = compiledTextSlotValue(evaluation.slots[index])
                if (!value.ok) return false
                nextText[index] = value.value
              }
            candidatePatch = program
              ? evaluation.patch ?? (textOnly && program.locations.length === nextText.length
                ? fullPatchCandidates(program, nextText)
                : undefined)
              : undefined
            if (evaluation.patch !== undefined && !program) return false
          }
          if (program && !candidatePatch) return false

          let nextRootProps: Array<Record<string, unknown> | null> | undefined
          let nextMotionStates: Array<DomMotionRenderState | null> | undefined
          if (plan.patchesModifiers) {
            if (!evaluation) return false
            if (evaluation.modifiers !== undefined && !Array.isArray(evaluation.modifiers)) return false
            nextRootProps = instance.roots.map((root, index) => root.nodeType === 1
              ? cloneStoredDomProps(instance.rootProps[index] ?? null)
              : null)
            nextMotionStates = instance.roots.map(root => root.nodeType === 1
              ? { pendingPropertyMask: 0, domains: [], partial: false }
              : null)

            const mergeModifier = (modifier: ViewModifierNode): void => {
              if (modifier.name === "animationAuto") {
                for (const state of nextMotionStates!) {
                  if (!state) continue
                  state.domains.push({ animation: undefined, trigger: undefined, automatic: true, propertyMask: typeof modifier.arguments[0] === "number" ? modifier.arguments[0] >>> 0 : state.pendingPropertyMask, properties: Array.isArray(modifier.arguments[1]) ? modifier.arguments[1] as string[] : (state.pendingProperties?.size ? [...state.pendingProperties] : emptyMotionProperties) })
                  clearPendingMotionProperties(state)
                }
                return
              }
              if (modifier.name === "animation") {
                const domain = animationDomainArguments(modifier.arguments)
                for (const state of nextMotionStates!) {
                  if (!state) continue
                  state.domains.push({ ...domain, ...takePendingMotionProperties(state) })
                }
                return
              }

              const extraStyle = styleOf(modifier, false)
              const extraProps = propsOf(modifier)
              const motionProperties = Object.keys(extraStyle).map(cssPropertyName)
              for (const state of nextMotionStates!) {
                if (!state) continue
                for (const property of motionProperties) recordMotionProperty(state, property)
              }
              for (let index = 0; index < instance.roots.length; index += 1) {
                const root = instance.roots[index]
                if (root.nodeType !== 1) continue
                const element = root as Element
                const previous = nextRootProps![index]
                const style = Object.keys(extraStyle).length > 0 ? { ...extraStyle } : undefined
                if (style && typeof style.transform === "string") {
                  const remembered = previous?.style
                  const currentTransform = remembered && typeof remembered === "object"
                    ? (remembered as Record<string, unknown>).transform
                    : undefined
                  if (typeof currentTransform === "string" && currentTransform) style.transform = `${currentTransform} ${style.transform}`
                }
                const incoming = { ...extraProps, ...(style ? { style } : {}) }
                const applied = element.localName.includes("-") ? incoming : nativeElementProps(incoming)
                nextRootProps![index] = mergeReusableCandidateProps(previous, applied)
              }
            }

            for (const spec of evaluation.modifiers ?? []) {
              if (!Array.isArray(spec) || spec.length !== 2 || typeof spec[0] !== "string"
                || !directCompiledBodyModifierNames.has(spec[0]) || !Array.isArray(spec[1])) return false
              mergeModifier({ name: spec[0], arguments: spec[1] } as ViewModifierNode)
            }
            // Preserve normal modifier precedence: template props → body
            // modifiers → modifiers attached to the View at the call site.
            for (const modifier of directOuterModifiers) mergeModifier(modifier)
          } else if (evaluation?.modifiers !== undefined) {
            return false
          }

          const resolvedRootMotion = instance.roots.map((root, index) => {
            if (root.nodeType !== 1 || !nextMotionStates?.[index]) return undefined
            const resolved = resolveMotionRenderState(root as Element, nextMotionStates[index]!, context, nextRootProps?.[index])
            captureLayoutNeighborhood(root as Element, resolved.layoutAnimation, context)
            return resolved
          })

          if (program) {
            if (!applyCompiledPatch(instance, program, candidatePatch!, context)) return false
          } else for (let index = 0; index < nextText.length; index += 1) {
              const live = instance.textSlots[index]
              if (live && live.nodeValue !== nextText[index]) live.nodeValue = nextText[index]
            }
          if (nextRootProps) {
            for (let index = 0; index < instance.roots.length; index += 1) {
              const root = instance.roots[index]
              if (root.nodeType !== 1) continue
              const resolved = resolvedRootMotion[index]
              patchDomProps(root as Element, nextRootProps[index], context, resolved?.policy)
              if (resolved) commitResolvedMotionState(root as Element, resolved, context)
            }
          }
          return true
        })
        if (!patched) return false
        flushLayoutMotion(context)
      } finally {
        context.activeTransaction = previousTransaction
      }
      boundary.scheduled = false
      boundary.pendingTransaction = undefined
      boundary.pendingMutations.length = 0
      boundary.pendingDependencies.clear()
      return true
    }

    updateBoundary = (boundary: DomViewBoundary): void => {
      if (stopped || viewRuntime.boundaries.get(boundary.key) !== boundary || !boundary.scheduled) return
      recordMunRuntimeEvent("boundaryUpdates")
      const profile = munDevtoolsEnabled()
      const startedAt = profile ? performance.now() : 0
      let parentKey = boundary.parentKey
      while (parentKey) {
        const parentBoundary = viewRuntime.boundaries.get(parentKey)
        if (parentBoundary?.scheduled) return
        parentKey = parentBoundary?.parentKey
      }
      const currentNodes = [...boundary.currentNodes]
      const parent = currentNodes[0]?.parentNode
      if (!parent || currentNodes.some(node => node.parentNode !== parent)) {
        boundary.scheduled = false
        recordMunRuntimeEvent("rootEscalations")
        requestRootUpdate(boundary.pendingTransaction, true)
        return
      }
      const renderTransaction = boundary.pendingTransaction
      if (patchCompiledBoundary(boundary, renderTransaction)) {
        recordMunRuntimeEvent("compiledPatches")
        if (profile) recordMunBoundaryRender({
          key: boundary.key,
          name: boundary.node.name,
          parentKey: boundary.parentKey,
          durationMs: performance.now() - startedAt,
          dependencyCount: boundary.dependencies.size,
          nodeCount: boundary.currentNodes.length,
          mode: "compiled",
          element: boundary.currentNodes.find(node => node.nodeType === 1) as Element | undefined,
        })
        return
      }
      context.activeTransaction = renderTransaction
      beginViewPass(boundary.key)
      context.hasRefs = false
      const materialize = viewRuntime.materializeView
      if (!materialize) {
        boundary.scheduled = false
        recordMunRuntimeEvent("rootEscalations")
        requestRootUpdate(renderTransaction, true)
        return
      }
      const output = materialize(boundary.node, boundary.render, boundary.identity, true)
      if (!boundary.localSafe) {
        // A branch introduced GeometryReader/Lazy content that was not present
        // when this boundary was classified. Do not commit with local indexes;
        // rerun it through the root transaction instead.
        // Discard any pre-mutation layout captures from the abandoned local
        // pass. The root pass will take a fresh coherent snapshot.
        clearLayoutCaptures(viewRuntime)
        context.activeTransaction = undefined
        recordMunRuntimeEvent("rootEscalations")
        requestRootUpdate(renderTransaction, false)
        return
      }
      reconcileDomRange(parent, currentNodes, outputNodes(output), context)
      recordMunRuntimeEvent("reconcilePasses")
      flushLayoutMotion(context)
      commitViewPass(false)
      commitRefs()
      context.activeTransaction = undefined
      if (profile) recordMunBoundaryRender({
        key: boundary.key,
        name: boundary.node.name,
        parentKey: boundary.parentKey,
        durationMs: performance.now() - startedAt,
        dependencyCount: boundary.dependencies.size,
        nodeCount: boundary.currentNodes.length,
        mode: "reconcile",
        element: boundary.currentNodes.find(node => node.nodeType === 1) as Element | undefined,
      })
    }


    viewRuntime.invalidateBoundary = (key, transaction, mutations) => {
      const boundary = viewRuntime.boundaries.get(key)
      recordMunRuntimeEvent("collectionFallbacks")
      recordMunRuntimeEvent("boundaryInvalidations")
      if (!boundary) {
        recordMunRuntimeEvent("rootEscalations")
        requestRootUpdate(transaction, true)
        return
      }
      boundary.pendingTransaction = hostTransaction(transaction)
      boundary.pendingMutations.push(...mutations)
      // This invalidation route does not carry the originating StateRef, so a
      // compiler sparse mask cannot safely narrow the update.
      boundary.pendingDependencies.clear()
      if (boundary.scheduled || stopped) return
      boundary.scheduled = true
      // Collection fallbacks and direct runtime invalidations share the same
      // parent-first batch as ordinary State subscriptions. This lets one dirty
      // ancestor absorb its descendants instead of creating a microtask/update
      // per fallback boundary in the same turn.
      enqueueBoundaryUpdate(boundary)
    }

    update = () => {
      if (stopped) return
      recordMunRuntimeEvent("rootPasses")
      scheduled = false
      // A root pass owns its before/after geometry snapshot as one atomic
      // unit. Never let a capture from an aborted local pass leak into it.
      clearLayoutCaptures(viewRuntime)
      const scrollPositions = captureLazyScrollPositions()
      context.geometryIndex = 0
      context.hasRefs = false
      context.visitedStateIdentities.clear()
      context.visitedLazyIdentities.clear()
      context.lazyNodes.clear()
      context.preservedLazyStatePrefixes.clear()
      beginViewPass()
      const dependencies = new Set<StateRef<unknown>>()
      context.hydrating = Boolean(options.hydrate && !hasMounted)
      const attemptedHydration = context.hydrating
      const existingChildren = attemptedHydration ? directChildNodes(container) : directChildNodes(container)
      if (attemptedHydration) {
        context.hydrationLiveNodes = new WeakSet<Node>()
        const hydrationReuse: DomHydrationReuseState = {
          ancestors: [],
          failed: false,
          elements: new Set(),
          pendingCollections: [],
        }
        if (container.firstChild) hydrationReuse.next = descendHydrationPostorder(container.firstChild, hydrationReuse)
        viewRuntime.hydrationReuse = hydrationReuse
      } else {
        context.hydrationLiveNodes = undefined
        viewRuntime.hydrationReuse = undefined
      }
      const renderTransaction = hostTransaction(pendingTransaction)
      pendingTransaction = undefined
      context.activeTransaction = renderTransaction
      const directInitialMount = !hasMounted && !options.hydrate && container.childNodes.length === 0
      const previousStagingProps = context.stagingProps
      const previousStagingEvents = context.stagingEvents
      let output: Node
      if (directInitialMount) {
        // There is no live tree to reconcile against. Apply props/events once
        // while constructing the detached tree, then append it directly rather
        // than staging every element and walking the whole subtree again.
        context.stagingProps = false
        context.stagingEvents = false
      }
      try {
        output = withRenderTransaction(renderTransaction, () => collectStateReads(() => renderViewNode(value, renderer), dependency => dependencies.add(dependency)))
      } finally {
        context.stagingProps = previousStagingProps
        context.stagingEvents = previousStagingEvents
      }
      const hydrationReuse = viewRuntime.hydrationReuse
      let hydrationReuseMatched = true
      if (hydrationReuse) {
        if (hydrationReuse.failed || hydrationReuse.next !== undefined) hydrationReuseMatched = false
        if (hydrationReuseMatched) {
          for (const element of hydrationReuse.elements) {
            if (hydratedPropsMatch(element, context.domProps.get(element))) continue
            hydrationReuse.failed = true
            hydrationReuseMatched = false
            break
          }
        }
        viewRuntime.hydrationReuse = undefined
        context.hydrationLiveNodes = undefined
      }
      if (attemptedHydration && !hydrationReuseMatched) {
        // Fast live-node reuse is only an optimization. Unsupported props,
        // parser-inserted structure, form controls, SVG, or any other
        // conservative rejection must still get the original identity-
        // preserving candidate hydrator before we consider replacement.
        context.geometryIndex = 0
        context.hasRefs = false
        context.visitedLazyIdentities.clear()
        context.lazyNodes.clear()
        output = withRenderTransaction(renderTransaction, () => collectStateReads(() => renderViewNode(value, renderer), dependency => dependencies.add(dependency)))
      }
      const preservedStatePrefixes = collectPreservedStatePrefixes()
      for (const key of context.states.keys()) {
        if (context.visitedStateIdentities.has(key)) continue
        if (isPreservedStateKey(key, preservedStatePrefixes)) continue
        context.states.delete(key)
      }
      let outputChildren = outputNodes(output)
      const reusedHydration = attemptedHydration
        && hydrationReuseMatched
        && existingChildren.length === outputChildren.length
        && outputChildren.every((child, index) => child === existingChildren[index])
      let hydrated = reusedHydration
      if (reusedHydration) {
        if (hydrationReuse) {
          for (const instance of hydrationReuse.pendingCollections) {
            registerDomCollection(viewRuntime, instance)
            subscribeDomCollection(instance, context, viewRuntime)
          }
        }
        for (const child of existingChildren) {
          activateReusedHydratedTree(child, context, node => bindCandidateNode(node, node, context))
        }
      } else {
        hydrated = attemptedHydration
          && existingChildren.length === outputChildren.length
          && outputChildren.every((child, index) => hydrateNode(child, existingChildren[index], context))
        if (hydrated) {
          outputChildren.forEach((child, index) => bindHydratedSubtree(child, existingChildren[index], context))
        }
      }
      if (!hydrated) {
        context.hydrating = false
        // Ordinary client rendering can reconcile the first candidate tree
        // directly. A failed hydration attempt is the exception: its
        // candidate intentionally skipped event activation, and the partial
        // hydration walk may already have touched live nodes, so materialize
        // one clean client candidate only for that rare fallback path.
        if (attemptedHydration) {
          context.geometryIndex = 0
          context.hasRefs = false
          context.visitedLazyIdentities.clear()
          context.lazyNodes.clear()
          output = withRenderTransaction(renderTransaction, () => collectStateReads(() => renderViewNode(value, renderer), dependency => dependencies.add(dependency)))
          outputChildren = outputNodes(output)
        }
        if (attemptedHydration) {
          // Once structural hydration fails, some live descendants may never
          // have been visited, so their server-only attributes are unknown to
          // the normal prop diff. Reusing that partially inspected tree can
          // preserve stale nodes/attributes. Commit one clean client tree and
          // replace the failed hydration boundary atomically instead.
          for (const child of outputChildren) commitStagedSubtree(child, context)
          removeNodeBatch(container, [...container.childNodes], context)
          appendNodeBatch(container, outputChildren)
          for (const child of outputChildren) bindInsertedSubtree(child, context)
        } else if (directInitialMount) {
          appendNodeBatch(container, outputChildren)
          for (const child of outputChildren) bindInsertedSubtree(child, context)
        } else {
          reconcileDomChildren(container, outputChildren, context)
        }
      }
      flushLayoutMotion(context)
      commitViewPass(true)
      for (const [parent, position] of scrollPositions) {
        parent.scrollTop = position.top
        parent.scrollLeft = position.left
      }
      for (const key of context.lazyRanges.keys()) {
        if (!context.visitedLazyIdentities.has(key)) context.lazyRanges.delete(key)
      }
      for (const key of context.lazyMeasurements.keys()) {
        if (!context.visitedLazyIdentities.has(key)) context.lazyMeasurements.delete(key)
      }
      for (const key of context.lazySizeIndexes.keys()) {
        if (!context.visitedLazyIdentities.has(key)) context.lazySizeIndexes.delete(key)
      }
      commitRefs()
      syncSubscriptions(dependencies, transaction => {
        requestRootUpdate(transaction, true)
      })
      updateGeometry()
      observeLazyItems()
      observeLazyViewport()
      if (refreshLazyRanges() && !scheduled) {
        requestRootUpdate(undefined, true)
      }
      hasMounted = true
      // A geometry/lazy measurement may have queued the next root pass while
      // this one was committing. Keep the force flag for that queued pass;
      // otherwise the top View could be reused and the changed range would
      // never be materialized.
      if (!scheduled) viewRuntime.forceAll = false
      context.activeTransaction = undefined
    }
    update()
    return () => {
      if (stopped) return
      stopped = true
      let failed = false
      let failure: unknown
      const cleanup = (action: () => void) => {
        try { action() } catch (error) {
          if (!failed) { failed = true; failure = error }
        }
      }
      subscriptions.forEach(unsubscribe => cleanup(unsubscribe))
      subscriptions.clear()
      for (const key of [...viewRuntime.rootChildren]) cleanup(() => disposeBoundary(key))
      viewRuntime.rootChildren.clear()
      viewRuntime.rootNextChildren.clear()
      for (const boundary of viewRuntime.boundaries.values()) {
        boundary.subscriptions.forEach(unsubscribe => cleanup(unsubscribe))
        boundary.subscriptions.clear()
      }
      viewRuntime.boundaries.clear()
      for (const key of [...viewRuntime.collections.keys()]) cleanup(() => disposeDomCollection(viewRuntime, key))
      viewRuntime.collections.clear()
      viewRuntime.collectionKeysByOwner.clear()
      clearLayoutCaptures(viewRuntime)
      for (const playback of [...viewRuntime.exitTransitions.values()]) cleanup(playback.cancel)
      viewRuntime.exitTransitions.clear()
      cleanup(() => viewRuntime.transitionLayer?.remove())
      viewRuntime.transitionLayer = undefined
      activeRefs.forEach(entry => cleanup(entry.cleanup))
      activeRefs.clear()
      cleanup(() => lazyItemObserver?.disconnect())
      lazyItemObserver = undefined
      lazyViewportCleanups.forEach(action => cleanup(action))
      lazyViewportCleanups.length = 0
      cleanup(() => geometryProbe.remove())
      for (const child of [...container.childNodes]) cleanup(() => releaseDomSubtree(child, context))
      cleanup(() => (container as Element & { replaceChildren(...nodes: Node[]): void }).replaceChildren())
      if (failed) throw failure
    }
  }

  const update = () => {
    if (stopped) return
    scheduled = false
    const dependencies = new Set<StateRef<unknown>>()
    const renderTransaction = hostTransaction(pendingTransaction)
    pendingTransaction = undefined
    const html = withRenderTransaction(renderTransaction, () => collectStateReads(() => renderToHTML(value), dependency => dependencies.add(dependency)))
    container.innerHTML = html
    syncSubscriptions(dependencies, transaction => {
      pendingTransaction = hostTransaction(transaction)
      if (scheduled || stopped) return
      scheduled = true
      queueMicrotask(update)
    })
  }
  update()
  return () => {
    if (stopped) return
    stopped = true
    subscriptions.forEach(unsubscribe => unsubscribe())
    subscriptions.clear()
    if (container.innerHTML) container.innerHTML = ""
  }
}
