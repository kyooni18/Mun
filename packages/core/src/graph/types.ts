import type { Animation } from "../animation.js"
import type { EdgeSet, FrameAlignment, FrameOptions, LayoutEdgeInsets } from "../layout.js"
import type { MunStyleProperties } from "../html.js"
import type { ViewIdentity, ViewIdentitySegment } from "../identity.js"
import type { StateRef } from "../state.js"
import type { ViewType } from "./initializers.js"
import type { munForeignComponent, munInitializers, munView } from "./symbols.js"
import type { Transition } from "../transition.js"
import type { ContentTransition } from "../content-transition.js"

export type ViewGraphLeaf = string | number | bigint | boolean | null | undefined
export type ViewGraphValue = ViewGraphLeaf | ViewNode | readonly ViewGraphValue[]
export type ViewGraphChild = ViewGraphValue
export type ViewValue = ViewGraphValue
export type Length = number | string
export type ClassValue = string | false | null | undefined | readonly ClassValue[]
export type Axis = "horizontal" | "vertical"
export type AxisSet = Axis | "all" | readonly Axis[]
export type ContentMode = "fit" | "fill"
export type TextAlignment = "leading" | "center" | "trailing"
export type TruncationMode = "head" | "middle" | "tail"
export type TextCase = "uppercase" | "lowercase" | null
export type FontWeight = "ultraLight" | "thin" | "light" | "regular" | "medium" | "semibold" | "bold" | "heavy" | "black" | number
export type FontDesign = "default" | "serif" | "rounded" | "monospaced"
export type FontWidth = "compressed" | "condensed" | "standard" | "expanded"
export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "colorDodge" | "colorBurn" | "softLight" | "hardLight" | "difference" | "exclusion" | "hue" | "saturation" | "color" | "luminosity" | "plusDarker" | "plusLighter"
export type Visibility = "automatic" | "visible" | "hidden"
export interface AffineTransform {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly d: number
  readonly tx: number
  readonly ty: number
}
export interface Axis3D { readonly x: number; readonly y: number; readonly z: number }

export interface Point { readonly x: number; readonly y: number }
export interface Size { readonly width: number; readonly height: number }
export type ScaleEffectValue = number | Point | Size
export type OffsetValue = Point | Size
export type UnitPointName = FrameAlignment

export interface GeometryFrame {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

export interface EdgeInsets {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

export interface GeometryProxy {
  readonly frame: GeometryFrame
  readonly size: Readonly<Pick<GeometryFrame, "width" | "height">>
  readonly safeAreaInsets: EdgeInsets
}

export interface ViewModifierNode {
  readonly name: string
  readonly arguments: readonly unknown[]
  /** Optional renderer-facing props supplied by a compatibility adapter. */
  readonly props?: object | null
}

export interface ElementViewNode {
  readonly kind: "element"
  readonly type: unknown
  readonly props: Record<string, unknown> | null
  readonly children: readonly ViewGraphChild[]
}

export type ForeignComponentSlot = ViewGraphValue | ((...args: any[]) => ViewGraphValue)

export interface ForeignComponentSchema {
  readonly props?: Record<string, unknown>
  readonly events?: Record<string, unknown>
  readonly slots?: Record<string, unknown>
}

export interface ForeignComponentOptions {
  readonly props?: Record<string, unknown>
  readonly events?: Record<string, unknown>
  readonly slots?: Record<string, ForeignComponentSlot>
  readonly ref?: unknown
  readonly key?: string | number
  /** Renderer-owned adapter metadata; core never invokes it. */
  readonly adapter?: unknown
  readonly schema?: ForeignComponentSchema
  readonly name?: string
}

export interface ForeignComponentDescriptor {
  readonly [munForeignComponent]: true
  readonly component: unknown
  readonly props: Record<string, unknown>
  readonly events: Record<string, unknown>
  readonly slots: Record<string, ForeignComponentSlot>
  readonly ref?: unknown
  readonly key?: string | number
  readonly adapter?: unknown
  readonly schema?: ForeignComponentSchema
  readonly name: string
}

export interface FragmentViewNode {
  readonly kind: "fragment"
  readonly children: readonly ViewGraphChild[]
}

/** A dynamic child position inside a compiler-generated immutable template. */
export interface CompiledTemplateSlot {
  readonly kind: "slot"
  readonly index: number
  /** Original graph-identity path from the template root to this dynamic slot. */
  readonly identity: readonly ViewIdentitySegment[]
}

/** Static host element emitted by the compiler after evaluating intrinsic View semantics. */
export interface CompiledTemplateElement {
  readonly kind: "element"
  readonly type: string
  readonly props: Record<string, unknown> | null
  readonly children: readonly CompiledTemplateValue[]
}

export interface CompiledTemplateFragment {
  readonly kind: "fragment"
  readonly children: readonly CompiledTemplateValue[]
}

export type CompiledTemplateValue = ViewGraphLeaf | CompiledTemplateSlot | CompiledTemplateElement | CompiledTemplateFragment

export type CompiledTemplateSlotKind = "view" | "text"

/** Renderer-neutral location inside the stable host-node table of a compiled template. */
export type CompiledPatchLocation =
  | { readonly node: number; readonly kind: "text" }
  | { readonly node: number; readonly kind: "attribute"; readonly key: string }
  | { readonly node: number; readonly kind: "property"; readonly key: string }
  | { readonly node: number; readonly kind: "style"; readonly key: string }
  | { readonly node: number; readonly kind: "class"; readonly key?: string }
  | { readonly node: number; readonly kind: "child-range"; readonly endNode: number }

/** Compact renderer-neutral patch program. Renderers retain ownership of materialization. */
export interface CompiledPatchIR {
  readonly version: 1
  readonly locations: readonly CompiledPatchLocation[]
  readonly dirtyWordCount: number
}

/** Values produced by a compiler plan; dirty is a packed candidate bitset. */
export interface CompiledPatchValues {
  readonly dirty: Uint32Array
  readonly values: readonly unknown[]
}

/** Immutable static tree plus the number of runtime graph/value slots it consumes. */
export interface CompiledTemplateDescriptor {
  readonly root: CompiledTemplateValue
  readonly slotCount: number
  /** Prevalidated original graph-identity path for each runtime slot. */
  readonly slotIdentities: readonly (readonly ViewIdentitySegment[])[]
  /** Compiler-proven slot shape. Older/manual templates default to generic view slots. */
  readonly slotKinds: readonly CompiledTemplateSlotKind[]
  /** Optional compact host patch program. Ordinary framework renderers may ignore it. */
  readonly patchIR?: CompiledPatchIR
}

/** Runtime instance of a compiler template. Only its slot array changes between evaluations. */
export interface CompiledTemplateViewNode {
  readonly kind: "template"
  readonly template: CompiledTemplateDescriptor
  readonly slots: readonly ViewGraphValue[]
}

/**
 * Compiler-proven View body fast path. The template is immutable and the
 * evaluator computes only its dynamic slots from the already-resolved View
 * props, allowing renderers to bypass the generic body/reconciliation path.
 */
export type CompiledViewModifierSpec = readonly [name: string, arguments: readonly unknown[]]

export interface CompiledViewBodyEvaluation {
  readonly slots: readonly ViewGraphValue[]
  /** Compiler-emitted candidate patches. The renderer filters unchanged values. */
  readonly patch?: CompiledPatchValues
  /** Optional non-structural modifier graph proven safe for direct renderer patching. */
  readonly modifiers?: readonly CompiledViewModifierSpec[]
}

export interface CompiledViewBodyPlan<Props extends object = Record<string, unknown>> {
  readonly template: CompiledTemplateDescriptor
  /** Lets renderers reject modifier patching before evaluating a plan when the surrounding graph makes it unsafe. */
  readonly patchesModifiers?: boolean
  /**
   * Compiler-proven mapping from a State-bearing View prop to Patch IR
   * locations affected by that dependency. Renderers may resolve the prop to
   * a StateRef once and keep a reusable dirty mask per mounted boundary.
   */
  readonly patchDependencyIndices?: Readonly<Record<string, readonly number[]>>
  /**
   * Optional sparse patch evaluator. `values` is renderer-owned scratch
   * storage and only indices selected by `dirty` need to be written.
   */
  readonly evaluatePatch?: (props: Props, dirty: Uint32Array, values: unknown[]) => void
  /** Re-evaluate only dynamic slots/modifier arguments, never the immutable View body graph. */
  readonly evaluate: (props: Props) => CompiledViewBodyEvaluation
}

/** Compiler/runtime-neutral identity for one logical collection item. */
export interface KeyedCollectionIdentity {
  readonly identity: string
  readonly display: string
}

/** Lightweight collection entry. It deliberately contains no row View graph. */
export interface KeyedCollectionEntry {
  /** Unique collection-item identity, including duplicate occurrence. */
  readonly key: string
  readonly baseKey: string
  readonly displayKey: string
  readonly occurrence: number
  readonly item: unknown
  readonly index: number
}

/** One compiler-proven flat host row with one primitive text slot. */
export interface CompiledCollectionRow {
  readonly type: string
  readonly props: Record<string, unknown> | null
  readonly text: ViewGraphLeaf
}

/** Persistent collection execution metadata emitted once by the compiler. */
export interface CompiledCollectionPlan {
  readonly kind: "flat-text-host"
  /** True when moving an existing item cannot change its row output. */
  readonly indexIndependent: boolean
  /** Compiler-proven pure stable-key evaluator. Required for collection-owned State invalidation. */
  readonly evaluateKey?: (item: unknown, index: number) => string | number
  /** Static ordinary host tag emitted by the compiler for allocation-light adapters. */
  readonly hostType?: string
  /** Static host props when no row-local evaluation is necessary. */
  readonly staticProps?: Record<string, unknown> | null
  /** Row-local props evaluator paired with hostType when props are dynamic. */
  readonly evaluateProps?: (item: unknown, index: number) => Record<string, unknown> | null
  /** Row-local primitive text evaluator paired with hostType. */
  readonly evaluateText?: (item: unknown, index: number) => ViewGraphLeaf
  /**
   * Pure row-local evaluator. Renderers may memoize its result and skip calls
   * for items proven unchanged by State mutation metadata.
   */
  readonly evaluate: (item: unknown, index: number) => CompiledCollectionRow
}

/**
 * A keyed collection remains compact until a renderer asks for rows. The
 * compatibility children view is lazy, while execution-capable renderers can
 * retain native rows and evaluate only changed entries.
 */
export interface KeyedCollectionViewNode {
  readonly kind: "collection"
  readonly items: readonly unknown[]
  /** Deferred strict snapshot for a State-backed source. */
  readonly readItems?: () => readonly unknown[]
  /** Original collection identity before the descriptor-only snapshot. */
  readonly source: unknown
  readonly key: (item: unknown, index: number) => KeyedCollectionIdentity
  readonly content: (item: unknown, index: number, entryKey: string) => ViewGraphValue
  readonly indexIndependent: boolean
  readonly compiled?: CompiledCollectionPlan
  readonly onDuplicateKey?: (displayKey: string, occurrence: number) => void
  /** Compatibility materialization. Renderers should use collection(). */
  readonly children: readonly ViewGraphChild[]
}

export interface ViewHostNode {
  readonly kind: "view"
  readonly name: string
  readonly host: unknown
  readonly props: Record<string, unknown>
  readonly state?: (props: Record<string, unknown>) => Record<string, unknown>
  /** Compiler-proven State dependencies. Omitted when runtime discovery is required. */
  readonly dependencies?: (props: Record<string, unknown>) => readonly StateRef<unknown>[]
  /** Whether dependencies is a compiler-proven exhaustive set. */
  readonly dependenciesComplete?: boolean
  /** Optional compiler-proven body plan used by renderer-specific direct patch paths. */
  readonly compiledBody?: CompiledViewBodyPlan<Record<string, unknown>>
  readonly render: (props: Record<string, unknown>) => ViewGraphValue
}

export interface GeometryViewNode {
  readonly kind: "geometry"
  readonly content: (geometry: GeometryProxy) => ViewGraphValue
}

export interface LazyViewRange {
  readonly start: number
  readonly end: number
}

export interface LazyViewNode {
  readonly kind: "lazy"
  readonly name: string
  readonly axis: "vertical" | "horizontal" | "grid"
  readonly props: Record<string, unknown>
  readonly children: readonly ViewGraphChild[]
}

/**
 * The renderer-facing subset of compiler-owned GPU Island IR. Core transports
 * this proof but never selects a device, creates a canvas, or executes a pass.
 */
export interface GPUIslandGraphIR {
  readonly version: 1
  readonly id: string
  readonly kind: "particle-field" | "line-chart"
  readonly typeProof: "numeric-packed"
  readonly inputResidency: "gpu"
  readonly outputResidency: "gpu"
  readonly readback: "forbidden"
  readonly materialization: "renderer-owned"
  readonly lifetime: "frame-persistent"
  readonly buffers: readonly {
    readonly name: string
    readonly byteLength: number
    readonly stride: number
    readonly usages: readonly ("storage" | "vertex" | "uniform" | "copy-dst")[]
    readonly authority: "gpu"
    readonly cpuReadable: false
  }[]
  readonly compute: {
    readonly workgroupSize: number
    readonly dispatchCount: number
    readonly reads: readonly string[]
    readonly writes: readonly string[]
  }
  readonly render: {
    readonly topology?: "point-list" | "line-list" | "line-strip" | "triangle-list"
    readonly vertexCount: number
    readonly reads: readonly string[]
    readonly target: "gpu-canvas"
  }
  readonly fallback: "canvas" | "static"
}

export interface GPUIslandViewOptions {
  /** Explicit per-island opt-in; mount-level policy may still disable it. */
  readonly experimentalResidentCompute?: boolean
  readonly width?: number
  readonly height?: number
  readonly class?: string
  readonly style?: Readonly<Record<string, unknown>>
  readonly ariaLabel?: string
  /** One initial upload. Per-frame GPU-to-CPU materialization is forbidden. */
  readonly initialData?: Float32Array
  readonly clearColor?: readonly [number, number, number, number]
}

/** Internal graph boundary whose materialization and lifetime belong to the renderer. */
export interface GPUIslandViewNode {
  readonly kind: "gpu-island"
  readonly ir: GPUIslandGraphIR
  readonly options: GPUIslandViewOptions
}

export interface ModifiedContent {
  readonly kind: "modified"
  /** The unmodified graph node; modifiers are stored in one flat sequence. */
  readonly content: ViewNode
  readonly modifiers: readonly ViewModifierNode[]
  /** Compatibility view of the final modifier in the flat sequence. */
  readonly modifier: ViewModifierNode
  readonly name: string
  readonly arguments: readonly unknown[]
}

export type ViewNode = ElementViewNode | FragmentViewNode | CompiledTemplateViewNode | KeyedCollectionViewNode | ViewHostNode | GeometryViewNode | LazyViewNode | GPUIslandViewNode | ModifiedContent
/** Public View value: an immutable graph node with value-semantic modifiers. */
export type View = ViewNode & Modifiers
export type ViewModifier = ViewModifierNode
type MaskValue = ViewNode | string
type StructuralModifierValue = ViewGraphValue | (() => ViewGraphValue)

export interface Modifiers {
  padding(value?: Length | LayoutEdgeInsets): ModifiableViewNode
  padding(edges: EdgeSet, length?: Length): ModifiableViewNode
  margin(value?: Length): ModifiableViewNode
  gap(value: Length): ModifiableViewNode
  frame(options?: FrameOptions): ModifiableViewNode
  font(value: string): ModifiableViewNode
  fontSize(value: Length): ModifiableViewNode
  bold(isActive?: boolean): ModifiableViewNode
  fontWeight(value: FontWeight | null): ModifiableViewNode
  fontDesign(value: FontDesign | null): ModifiableViewNode
  fontWidth(value: FontWidth): ModifiableViewNode
  italic(isActive?: boolean): ModifiableViewNode
  underline(isActive?: boolean, pattern?: string, color?: string | null): ModifiableViewNode
  strikethrough(isActive?: boolean, pattern?: string, color?: string | null): ModifiableViewNode
  monospaced(isActive?: boolean): ModifiableViewNode
  monospacedDigit(): ModifiableViewNode
  kerning(value: number): ModifiableViewNode
  tracking(value: number): ModifiableViewNode
  baselineOffset(value: number): ModifiableViewNode
  lineSpacing(value: number): ModifiableViewNode
  lineLimit(value: number | null, reservesSpace?: boolean): ModifiableViewNode
  minimumScaleFactor(value: number): ModifiableViewNode
  multilineTextAlignment(value: TextAlignment): ModifiableViewNode
  truncationMode(value: TruncationMode): ModifiableViewNode
  textCase(value: TextCase): ModifiableViewNode
  allowsTightening(value: boolean): ModifiableViewNode
  foreground(value: string): ModifiableViewNode
  foregroundStyle(primary: string, secondary?: string, tertiary?: string): ModifiableViewNode
  background(value: string | ViewNode, alignment?: FrameAlignment): ModifiableViewNode
  background(alignment: FrameAlignment, content: () => ViewGraphValue): ModifiableViewNode
  overlay(value: StructuralModifierValue, alignment?: FrameAlignment): ModifiableViewNode
  opacity(value: number): ModifiableViewNode
  aspectRatio(ratio: number | Size | null, contentMode: ContentMode): ModifiableViewNode
  scaledToFit(): ModifiableViewNode
  scaledToFill(): ModifiableViewNode
  fixedSize(): ModifiableViewNode
  fixedSize(horizontal: boolean, vertical: boolean): ModifiableViewNode
  layoutPriority(value: number): ModifiableViewNode
  position(value: Point): ModifiableViewNode
  position(x: number, y: number): ModifiableViewNode
  zIndex(value: number): ModifiableViewNode
  ignoresSafeArea(regions?: string, edges?: EdgeSet, alignment?: FrameAlignment): ModifiableViewNode
  safeAreaPadding(value?: Length): ModifiableViewNode
  safeAreaPadding(edges: EdgeSet, length?: Length): ModifiableViewNode
  gridCellColumns(count: number): ModifiableViewNode
  gridCellUnsizedAxes(axes: AxisSet): ModifiableViewNode
  gridCellAnchor(anchor: UnitPointName): ModifiableViewNode
  gridColumnAlignment(alignment: "leading" | "center" | "trailing"): ModifiableViewNode
  scaleEffect(value: ScaleEffectValue, anchor?: UnitPointName): ModifiableViewNode
  rotationEffect(value: number, anchor?: UnitPointName): ModifiableViewNode
  rotation3DEffect(angle: number, axis: Axis3D, anchor?: UnitPointName, anchorZ?: number, perspective?: number): ModifiableViewNode
  transformEffect(transform: AffineTransform): ModifiableViewNode
  projectionEffect(transform: string | readonly number[]): ModifiableViewNode
  offset(value: OffsetValue): ModifiableViewNode
  offset(x: number, y: number): ModifiableViewNode
  mask(value: MaskValue, alignment?: FrameAlignment): ModifiableViewNode
  clipShape(value: MaskValue, style?: unknown): ModifiableViewNode
  clipped(antialiased?: boolean): ModifiableViewNode
  border(style: string, width?: Length): ModifiableViewNode
  shadow(color: string | undefined, radius: number, x?: number, y?: number): ModifiableViewNode
  blur(radius: number, opaque?: boolean): ModifiableViewNode
  brightness(value: number): ModifiableViewNode
  contrast(value: number): ModifiableViewNode
  saturation(value: number): ModifiableViewNode
  grayscale(value: number): ModifiableViewNode
  hueRotation(value: number): ModifiableViewNode
  colorInvert(): ModifiableViewNode
  colorMultiply(value: string): ModifiableViewNode
  blendMode(value: BlendMode): ModifiableViewNode
  compositingGroup(): ModifiableViewNode
  drawingGroup(opaque?: boolean, colorMode?: string): ModifiableViewNode
  luminanceToAlpha(): ModifiableViewNode
  tint(value: string | null): ModifiableViewNode
  backgroundStyle(value: string): ModifiableViewNode
  dynamicTypeSize(value: string): ModifiableViewNode
  disabled(value: boolean): ModifiableViewNode
  hidden(): ModifiableViewNode
  allowsHitTesting(value: boolean): ModifiableViewNode
  onTapGesture(action: () => void): ModifiableViewNode
  onTapGesture(count: number, action: () => void): ModifiableViewNode
  onTapGesture(count: undefined, action: () => void): ModifiableViewNode
  onLongPressGesture(minimumDuration: number | undefined, maximumDistance: number | undefined, action: () => void, onPressingChanged?: (pressing: boolean) => void): ModifiableViewNode
  onHover(action: (hovering: boolean) => void): ModifiableViewNode
  onSubmit(action: () => void): ModifiableViewNode
  focusable(isFocusable?: boolean, onFocusChange?: (focused: boolean) => void): ModifiableViewNode
  id(value: string | number): ModifiableViewNode
  preferredColorScheme(value: "light" | "dark" | null): ModifiableViewNode
  controlSize(value: string): ModifiableViewNode
  buttonStyle(value: string): ModifiableViewNode
  toggleStyle(value: string): ModifiableViewNode
  pickerStyle(value: string): ModifiableViewNode
  textFieldStyle(value: string): ModifiableViewNode
  textEditorStyle(value: string): ModifiableViewNode
  listStyle(value: string): ModifiableViewNode
  labelStyle(value: string): ModifiableViewNode
  progressViewStyle(value: string): ModifiableViewNode
  scrollDisabled(value: boolean): ModifiableViewNode
  scrollIndicators(value: Visibility, axes?: AxisSet): ModifiableViewNode
  scrollBounceBehavior(value: string, axes?: AxisSet): ModifiableViewNode
  scrollClipDisabled(value?: boolean): ModifiableViewNode
  scrollDismissesKeyboard(value: string): ModifiableViewNode
  listRowInsets(value: LayoutEdgeInsets | null): ModifiableViewNode
  listRowInsets(edges: EdgeSet, length?: Length): ModifiableViewNode
  listRowBackground(value: StructuralModifierValue | null): ModifiableViewNode
  listRowSeparator(value: Visibility, edges?: string): ModifiableViewNode
  listSectionSeparator(value: Visibility, edges?: string): ModifiableViewNode
  symbolRenderingMode(value: string | null): ModifiableViewNode
  symbolVariant(value: string): ModifiableViewNode
  draggable(payload: unknown): ModifiableViewNode
  dropDestination(payloadType: unknown, action: (items: unknown[], point: Point) => boolean, isTargeted?: (targeted: boolean) => void): ModifiableViewNode
  accessibilityLabel(value: string): ModifiableViewNode
  accessibilityHint(value: string): ModifiableViewNode
  accessibilityValue(value: string): ModifiableViewNode
  accessibilityHidden(value: boolean): ModifiableViewNode
  accessibilityIdentifier(value: string): ModifiableViewNode
  accessibilityHeading(value?: string): ModifiableViewNode
  accessibilitySortPriority(value: number): ModifiableViewNode
  accessibilityElement(children?: string): ModifiableViewNode
  accessibilityAction(kind: string, action: () => void): ModifiableViewNode
  /**
   * Animate changes owned by the modifiers before this call. With no value,
   * Mun automatically derives the changed factors and timing domain.
   */
  animation(): ModifiableViewNode
  animation(animation: Animation | null): ModifiableViewNode
  animation(animation: Animation | null, value: unknown): ModifiableViewNode
  transition(transition: Transition): ModifiableViewNode
  contentTransition(transition: ContentTransition): ModifiableViewNode
  style(value: MunStyleProperties): ModifiableViewNode
  className(value: ClassValue): ModifiableViewNode
  withProps(value: Record<string, unknown>): ModifiableViewNode
  keyed(value: string | number): ModifiableViewNode
  elementRef(value: unknown): ModifiableViewNode
  continuousCorners(smoothing?: number): ModifiableViewNode
}

export type ModifiableViewNode = ViewNode & Modifiers

export interface MunRenderer<Output = unknown> {
  element(type: unknown, props: Record<string, unknown> | null, ...children: Output[]): Output
  fragment(children: Output[]): Output
  value?(value: unknown): Output
  modifier(content: Output, modifier: ViewModifierNode, renderArgument?: (index: number) => Output): Output
  /** Materialize a compiler-generated static template without generic graph traversal. */
  template?(node: CompiledTemplateViewNode, renderSlot: (index: number) => Output, identity: ViewIdentity): Output
  /**
   * Execute a compact keyed collection without requiring eager row graphs.
   * Renderers without this hook receive the exact compatibility graph.
   */
  collection?(node: KeyedCollectionViewNode, renderEntry: (entry: KeyedCollectionEntry) => Output, identity: ViewIdentity): Output
  /** Render a View host with an optional renderer-owned resolved prop set. */
  view?(node: ViewHostNode, render: (props?: Record<string, unknown>) => Output, identity: ViewIdentity): Output
  /** Materialize a geometry boundary and feed its measured proxy to the body. */
  geometry?(node: GeometryViewNode, render: (geometry: GeometryProxy) => Output): Output
  /** Materialize a lazy container; `render` may request a visible child range. */
  lazy?(node: LazyViewNode, render: (range?: LazyViewRange) => Output, identity: ViewIdentity, renderItem?: (index: number) => Output): Output
  /** Materialize and own a compiler-proven GPU compute-to-render island. */
  gpuIsland?(node: GPUIslandViewNode, identity: ViewIdentity): Output
}
