/** Backend-neutral Semantic UI IR shared by every Mün backend. */

export type MunUiScalar = string | number | boolean | null

/**
 * Structured state values. Collections are arrays of records (or scalars) whose
 * items are addressed by a stable key path, never by array index.
 */
export type MunUiValue = MunUiScalar | readonly MunUiValue[] | { readonly [field: string]: MunUiValue }

/** Stable program-local identity for semantic state storage. */
export type MunUiStateId = string

/** Stable program-local identity for retained semantic nodes across runtime reconciliation. */
export type MunUiNodeId = string

export type MunUiBinaryOperator =
  | "add"
  | "subtract"
  | "multiply"
  | "divide"
  | "modulo"
  | "equal"
  | "notEqual"
  | "less"
  | "lessOrEqual"
  | "greater"
  | "greaterOrEqual"
  | "and"
  | "or"

export type MunUiExpression =
  | { readonly kind: "literal"; readonly value: MunUiValue }
  | { readonly kind: "state"; readonly state: MunUiStateId }
  | { readonly kind: "not"; readonly value: MunUiExpression }
  | { readonly kind: "stringify"; readonly value: MunUiExpression }
  | {
      readonly kind: "binary"
      readonly operator: MunUiBinaryOperator
      readonly left: MunUiExpression
      readonly right: MunUiExpression
    }
  | {
      readonly kind: "conditional"
      readonly condition: MunUiExpression
      readonly then: MunUiExpression
      readonly otherwise: MunUiExpression
    }
  /** The current item (or a field path inside it) of an enclosing `forEach`. */
  | { readonly kind: "item"; readonly forEach: MunUiNodeId; readonly path: readonly string[] }
  /** A record value built from field expressions. */
  | { readonly kind: "record"; readonly fields: { readonly [field: string]: MunUiExpression } }
  /** Number of items in a collection. */
  | { readonly kind: "count"; readonly collection: MunUiExpression }
  /** Items whose field at `path` compares to `value`; order is preserved. */
  | {
      readonly kind: "filter"
      readonly collection: MunUiExpression
      readonly path: readonly string[]
      readonly operator: "equal" | "notEqual"
      readonly value: MunUiExpression
    }

export interface MunUiState {
  /**
   * State identity is semantic storage identity, not a diagnostic label. Component-owned
   * state must derive from the component's structural instance identity rather than
   * compiler encounter order.
   */
  readonly name: MunUiStateId
  readonly initial: MunUiValue
  /**
   * Present for View-local state declared inside a `forEach` template. The
   * runtime owns one instance of this state per stable item key of that
   * `forEach` (and of every enclosing one), creates it on first appearance of
   * the key and releases it when the key leaves the collection.
   */
  readonly scope?: MunUiNodeId
}

export type MunAccessibilityRole = "window" | "group" | "text" | "button" | "textField" | "radioGroup" | "checkBox" | "progressIndicator"

export interface MunAccessibilitySemantics {
  readonly role: MunAccessibilityRole
  readonly label?: string
  readonly enabled?: MunUiExpression
}

export type MunUiAlignment = "leading" | "center" | "trailing" | "stretch"

export type MunUiOverlayAlignment =
  | "center"
  | "leading"
  | "trailing"
  | "top"
  | "bottom"
  | "topLeading"
  | "topTrailing"
  | "bottomLeading"
  | "bottomTrailing"

export type MunUiUnitPoint = MunUiOverlayAlignment

export type MunUiPaint =
  | string // Semantic UI IR v1 compatibility: legacy solid paint encoding.
  | { readonly kind: "solid"; readonly color: string }
  | {
      readonly kind: "linearGradient"
      readonly start: string
      readonly end: string
      readonly startPoint: MunUiUnitPoint
      readonly endPoint: MunUiUnitPoint
    }

/** Per-edge insets; leading/trailing follow the layout direction. */
export interface MunUiEdgeInsets {
  readonly top: number
  readonly leading: number
  readonly bottom: number
  readonly trailing: number
}

export interface MunUiLayout {
  readonly width?: MunUiExpression
  readonly height?: MunUiExpression
  readonly padding?: number | MunUiEdgeInsets
  readonly spacing?: number
  readonly alignment?: MunUiAlignment
  /**
   * Flexible frame bounds. A max on an axis makes the view take the space its
   * parent offers on that axis, up to the bound ("infinity" = unbounded).
   */
  readonly minWidth?: number
  readonly maxWidth?: number | "infinity"
  readonly minHeight?: number
  readonly maxHeight?: number | "infinity"
}

export interface MunUiVisual {
  readonly background?: MunUiPaint
  readonly foreground?: MunUiPaint
  readonly cornerRadius?: number
  /** Presentation-only properties. They do not participate in layout sizing. */
  readonly opacity?: MunUiExpression
  readonly translationX?: MunUiExpression
  readonly translationY?: MunUiExpression
}

/**
 * Renderer-independent motion properties. Backends translate these semantic
 * channels into their platform animation capabilities.
 */
export const munMotionPropertyNames = Object.freeze([
  "opacity",
  "translationX",
  "translationY",
  "scaleX",
  "scaleY",
  "rotation",
  "foregroundColor",
  "backgroundColor",
  "borderColor",
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxWidth",
  "maxHeight",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "rowGap",
  "columnGap",
  "fontSize",
  "lineHeight",
  "letterSpacing",
] as const)

export type MunMotionProperty = typeof munMotionPropertyNames[number]

const munMotionPropertyBits = new Map<MunMotionProperty, number>(
  munMotionPropertyNames.map((name, index) => [name, (2 ** index) >>> 0]),
)

export function munMotionPropertyBit(name: MunMotionProperty): number {
  return munMotionPropertyBits.get(name) ?? 0
}

export function munMotionPropertyMask(properties: Iterable<MunMotionProperty>): number {
  let mask = 0
  for (const property of properties) mask = (mask | munMotionPropertyBit(property)) >>> 0
  return mask
}

export interface MunSpringExecutionPlan {
  readonly kind: "spring"
  /** Angular frequency derived from the response-based spring model. */
  readonly omega: number
  readonly dampingRatio: number
  readonly blendDuration: number
  readonly delayMs: number
  readonly repeatCount: number | "infinite"
  readonly autoreverses: boolean
}

export interface MunTimingExecutionPlan {
  readonly kind: "timing"
  readonly duration: number
  readonly curve: readonly [number, number, number, number]
  readonly delayMs: number
  readonly repeatCount: number | "infinite"
  readonly autoreverses: boolean
}

export type MunMotionExecutionPlan = MunSpringExecutionPlan | MunTimingExecutionPlan

export type MunTransitionEdge = "top" | "bottom" | "leading" | "trailing" | "left" | "right"

export type MunTransitionEffect =
  | { readonly kind: "opacity" }
  | { readonly kind: "scale"; readonly scale: number }
  | { readonly kind: "move"; readonly edge: MunTransitionEdge; readonly distance: number }

export interface MunUiTransition {
  readonly insertion: readonly MunTransitionEffect[]
  readonly removal: readonly MunTransitionEffect[]
  readonly animation?: MunMotionExecutionPlan
}

export interface MunUiMotionBinding {
  readonly property: MunMotionProperty
  readonly propertyMask: number
  readonly value: MunUiExpression
  /** Present only for a property-local .animation(..., value:) override. */
  readonly trigger?: MunUiExpression
  /** Absent means the property participates in motion but uses the active transaction as fallback. */
  readonly plan?: MunMotionExecutionPlan
}

export interface MunUiTransaction {
  readonly animation?: MunMotionExecutionPlan | null
  readonly disablesAnimations: boolean
  readonly isContinuous: boolean
}

/** Keyed collection mutation; items are always addressed by key, never index. */
export type MunUiCollectionOperation =
  | { readonly operation: "insert"; readonly index: MunUiExpression; readonly value: MunUiExpression }
  | { readonly operation: "append"; readonly value: MunUiExpression }
  | { readonly operation: "remove"; readonly key: MunUiExpression }
  | { readonly operation: "move"; readonly key: MunUiExpression; readonly offset: MunUiExpression }
  | {
      readonly operation: "update"
      readonly key: MunUiExpression
      readonly path: readonly string[]
      readonly value: MunUiExpression
    }

export type MunUiAction =
  | { readonly kind: "toggle-state"; readonly state: MunUiStateId; readonly transaction?: MunUiTransaction }
  | { readonly kind: "set-state"; readonly state: MunUiStateId; readonly value: MunUiExpression; readonly transaction?: MunUiTransaction }
  | ({
      readonly kind: "collection"
      readonly state: MunUiStateId
      /** Key path of the collection's item identity (same as its `forEach`). */
      readonly keyPath: readonly string[]
      readonly transaction?: MunUiTransaction
    } & MunUiCollectionOperation)
  /** Several mutations applied as one transaction, evaluated in order. */
  | { readonly kind: "sequence"; readonly actions: readonly MunUiAction[]; readonly transaction?: MunUiTransaction }

interface MunUiNodeBase {
  /**
   * Compiler-derived structural anchor for this semantic node. It is stable across
   * unrelated lowering changes and is never derived from a renderer object.
   */
  readonly id: MunUiNodeId
  /**
   * Source-level .id(_:) identity boundary. When present, retained runtimes compose
   * this value with the parent identity rather than replacing the structural anchor.
   * The expression must resolve to a string or finite number.
   */
  readonly identityKey?: MunUiExpression
  readonly layout?: MunUiLayout
  readonly visual?: MunUiVisual
  /**
   * Accessibility is deliberately separate from visual representation so
   * every backend can build its platform accessibility tree from the same node.
   */
  readonly accessibility?: MunAccessibilitySemantics
  readonly motion?: readonly MunUiMotionBinding[]
  readonly transition?: MunUiTransition
  /**
   * Actions run when the View starts or stops being semantically present
   * (an active conditional branch, a live collection item, a new `.id(_:)`
   * identity) — once per change, never per frame.
   */
  readonly lifecycle?: MunUiLifecycle
}

export interface MunUiLifecycle {
  readonly appear?: MunUiAction
  readonly disappear?: MunUiAction
}

export interface MunUiWindowNode extends MunUiNodeBase {
  readonly kind: "window"
  readonly title: string
  readonly child: MunUiNode
}

export interface MunUiScrollNode extends MunUiNodeBase {
  readonly kind: "scroll"
  readonly axis: "vertical" | "horizontal"
  readonly children: readonly MunUiNode[]
}

export interface MunUiStackNode extends MunUiNodeBase {
  readonly kind: "column" | "row"
  readonly children: readonly MunUiNode[]
}

export interface MunUiOverlayNode extends MunUiNodeBase {
  readonly kind: "overlay"
  readonly alignment?: MunUiOverlayAlignment
  readonly children: readonly MunUiNode[]
}

export interface MunUiConditionalNode extends MunUiNodeBase {
  readonly kind: "conditional"
  readonly condition: MunUiExpression
  /** Builder branches are transparent fragments, not layout containers. */
  readonly then: readonly MunUiNode[]
  readonly otherwise: readonly MunUiNode[]
}

/**
 * Keyed dynamic children. `children` is a template instantiated once per item
 * of `collection`; each instance's identity is the template identity composed
 * with the item's key at `keyPath`. Like `conditional`, it is a transparent
 * fragment rather than a layout container. Duplicate keys are rejected.
 */
export interface MunUiForEachNode extends MunUiNodeBase {
  readonly kind: "forEach"
  readonly collection: MunUiExpression
  readonly keyPath: readonly string[]
  readonly children: readonly MunUiNode[]
}

export interface MunUiTextNode extends MunUiNodeBase {
  readonly kind: "text"
  readonly value: MunUiExpression
}

export type MunUiShapeKind = "rectangle" | "roundedRectangle" | "circle" | "capsule"

export interface MunUiPanelNode extends MunUiNodeBase {
  readonly kind: "panel"
  readonly shape?: MunUiShapeKind
}

export interface MunUiTextFieldNode extends MunUiNodeBase {
  readonly kind: "textField"
  readonly state: MunUiStateId
  readonly placeholder?: string
  /** A secure field: presented masked, never copied or exposed to assistive technology. */
  readonly secure?: boolean
}

/** A Bool control; native presents the macOS checkbox style. */
export interface MunUiToggleNode extends MunUiNodeBase {
  readonly kind: "toggle"
  readonly state: MunUiStateId
  readonly label: string
}

/** Determinate linear progress: `value` of `total` (default 1). */
export interface MunUiProgressNode extends MunUiNodeBase {
  readonly kind: "progress"
  readonly value: MunUiExpression
  readonly total?: MunUiExpression
  readonly label?: string
}

/** Flexible space along the containing stack's axis (both axes outside a stack). */
export interface MunUiSpacerNode extends MunUiNodeBase {
  readonly kind: "spacer"
  readonly minLength?: number
}

/** A 1pt separator across the containing stack's axis. */
export interface MunUiDividerNode extends MunUiNodeBase {
  readonly kind: "divider"
}

export interface MunUiSelectionOption {
  readonly label: string
  readonly value: MunUiScalar
  readonly disabled?: boolean
}

export interface MunUiRadioGroupNode extends MunUiNodeBase {
  readonly kind: "radioGroup"
  readonly state: MunUiStateId
  readonly options: readonly MunUiSelectionOption[]
}

export interface MunUiActionNode extends MunUiNodeBase {
  readonly kind: "action"
  readonly label: string
  readonly action: MunUiAction
}

export type MunUiNode =
  | MunUiWindowNode
  | MunUiStackNode
  | MunUiScrollNode
  | MunUiOverlayNode
  | MunUiConditionalNode
  | MunUiForEachNode
  | MunUiTextNode
  | MunUiPanelNode
  | MunUiTextFieldNode
  | MunUiRadioGroupNode
  | MunUiActionNode
  | MunUiToggleNode
  | MunUiProgressNode
  | MunUiSpacerNode
  | MunUiDividerNode

export interface MunUiProgram {
  readonly version: 1
  readonly sourceLanguage: "mun"
  readonly entry: string
  readonly states: readonly MunUiState[]
  readonly root: MunUiWindowNode
}
