/** Backend-neutral Semantic UI IR shared by every Mün backend. */

export type MunUiScalar = string | number | boolean | null

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
  | { readonly kind: "literal"; readonly value: MunUiScalar }
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

export interface MunUiState {
  /**
   * State identity is semantic storage identity, not a diagnostic label. Component-owned
   * state must derive from the component's structural instance identity rather than
   * compiler encounter order.
   */
  readonly name: MunUiStateId
  readonly initial: MunUiScalar
}

export type MunAccessibilityRole = "window" | "group" | "text" | "button"

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

export interface MunUiLayout {
  readonly width?: MunUiExpression
  readonly height?: MunUiExpression
  readonly padding?: number
  readonly spacing?: number
  readonly alignment?: MunUiAlignment
}

export interface MunUiVisual {
  readonly background?: string
  readonly foreground?: string
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

export type MunUiAction =
  | { readonly kind: "toggle-state"; readonly state: MunUiStateId; readonly transaction?: MunUiTransaction }
  | { readonly kind: "set-state"; readonly state: MunUiStateId; readonly value: MunUiExpression; readonly transaction?: MunUiTransaction }

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
}

export interface MunUiWindowNode extends MunUiNodeBase {
  readonly kind: "window"
  readonly title: string
  readonly child: MunUiNode
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

export interface MunUiTextNode extends MunUiNodeBase {
  readonly kind: "text"
  readonly value: MunUiExpression
}

export interface MunUiPanelNode extends MunUiNodeBase {
  readonly kind: "panel"
}

export interface MunUiActionNode extends MunUiNodeBase {
  readonly kind: "action"
  readonly label: string
  readonly action: MunUiAction
}

export type MunUiNode =
  | MunUiWindowNode
  | MunUiStackNode
  | MunUiOverlayNode
  | MunUiConditionalNode
  | MunUiTextNode
  | MunUiPanelNode
  | MunUiActionNode

export interface MunUiProgram {
  readonly version: 1
  readonly sourceLanguage: "mun"
  readonly entry: string
  readonly states: readonly MunUiState[]
  readonly root: MunUiWindowNode
}
