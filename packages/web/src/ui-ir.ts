import type {
  MunUiBinaryOperator,
  MunUiExpression,
  MunUiNode,
  MunUiProgram,
  MunUiScalar,
} from "@mun/core"

export interface MunWebIrRenderOptions {
  readonly state?: Readonly<Record<string, MunUiScalar>>
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function stringifyScalar(value: MunUiScalar): string {
  return value === null ? "null" : String(value)
}

function numericResult(value: number): number | null {
  return Number.isFinite(value) ? value : null
}

function orderedComparison(
  left: MunUiScalar,
  right: MunUiScalar,
  compare: (left: number | string, right: number | string) => boolean,
): boolean {
  if (typeof left === "number" && typeof right === "number") return compare(left, right)
  if (typeof left === "string" && typeof right === "string") return compare(left, right)
  return false
}

function evaluateBinary(
  operator: MunUiBinaryOperator,
  left: MunUiScalar,
  right: MunUiScalar,
): MunUiScalar {
  switch (operator) {
    case "add":
      if (typeof left === "number" && typeof right === "number") return numericResult(left + right)
      if (typeof left === "string" && typeof right === "string") return left + right
      return null
    case "subtract":
      return typeof left === "number" && typeof right === "number" ? numericResult(left - right) : null
    case "multiply":
      return typeof left === "number" && typeof right === "number" ? numericResult(left * right) : null
    case "divide":
      return typeof left === "number" && typeof right === "number" ? numericResult(left / right) : null
    case "modulo":
      return typeof left === "number" && typeof right === "number" ? numericResult(left % right) : null
    case "equal": return left === right
    case "notEqual": return left !== right
    case "less": return orderedComparison(left, right, (a, b) => a < b)
    case "lessOrEqual": return orderedComparison(left, right, (a, b) => a <= b)
    case "greater": return orderedComparison(left, right, (a, b) => a > b)
    case "greaterOrEqual": return orderedComparison(left, right, (a, b) => a >= b)
    case "and": return left === true && right === true
    case "or": return left === true || right === true
  }
}
function evaluate(
  expression: MunUiExpression,
  state: Readonly<Record<string, MunUiScalar>>,
): MunUiScalar {
  switch (expression.kind) {
    case "literal":
      return expression.value
    case "state":
      return state[expression.state] ?? null
    case "not":
      return !Boolean(evaluate(expression.value, state))
    case "stringify":
      return stringifyScalar(evaluate(expression.value, state))
    case "binary":
      return evaluateBinary(
        expression.operator,
        evaluate(expression.left, state),
        evaluate(expression.right, state),
      )
    case "conditional":
      return Boolean(evaluate(expression.condition, state))
        ? evaluate(expression.then, state)
        : evaluate(expression.otherwise, state)
  }
}

function cssValue(value: MunUiScalar): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return `${value}px`
  if (typeof value === "string" && value.length > 0) return value
  return undefined
}

function styleFor(
  node: MunUiNode,
  state: Readonly<Record<string, MunUiScalar>>,
): string | undefined {
  const declarations: string[] = []
  const layout = node.layout
  const visual = node.visual

  if (node.kind === "column" || node.kind === "row") {
    declarations.push("display:flex")
    declarations.push(`flex-direction:${node.kind === "column" ? "column" : "row"}`)
  }

  if (node.kind === "overlay") {
    const [alignItems, justifyItems] = {
      center: ["center", "center"],
      leading: ["center", "start"],
      trailing: ["center", "end"],
      top: ["start", "center"],
      bottom: ["end", "center"],
      topLeading: ["start", "start"],
      topTrailing: ["start", "end"],
      bottomLeading: ["end", "start"],
      bottomTrailing: ["end", "end"],
    }[node.alignment ?? "center"]
    declarations.push("display:grid")
    declarations.push(`align-items:${alignItems}`)
    declarations.push(`justify-items:${justifyItems}`)
  }

  if (layout?.width) {
    const value = cssValue(evaluate(layout.width, state))
    if (value) declarations.push(`width:${value}`)
  }
  if (layout?.height) {
    const value = cssValue(evaluate(layout.height, state))
    if (value) declarations.push(`height:${value}`)
  }
  if (layout?.padding !== undefined) declarations.push(`padding:${layout.padding}px`)
  if (layout?.spacing !== undefined && (node.kind === "column" || node.kind === "row")) {
    declarations.push(`gap:${layout.spacing}px`)
  }
  if (layout?.alignment !== undefined && (node.kind === "column" || node.kind === "row")) {
    const alignItems = {
      leading: "flex-start",
      center: "center",
      trailing: "flex-end",
      stretch: "stretch",
    }[layout.alignment]
    declarations.push(`align-items:${alignItems}`)
  }

  if (visual?.background) declarations.push(`background:${visual.background}`)
  if (visual?.foreground) declarations.push(`color:${visual.foreground}`)
  if (visual?.cornerRadius !== undefined) declarations.push(`border-radius:${visual.cornerRadius}px`)

  return declarations.length > 0 ? declarations.join(";") : undefined
}

function attributesFor(
  node: MunUiNode,
  state: Readonly<Record<string, MunUiScalar>>,
): string {
  const attributes = [`data-mun-node="${escapeText(node.id)}"`]
  const style = styleFor(node, state)
  if (style) attributes.push(`style="${escapeText(style)}"`)

  if (node.accessibility?.role === "group") attributes.push('role="group"')
  if (
    node.accessibility?.label
    && node.kind !== "text"
    && node.kind !== "action"
  ) {
    attributes.push(`aria-label="${escapeText(node.accessibility.label)}"`)
  }

  if (node.motion && node.motion.length > 0) {
    const mask = node.motion.reduce((combined, binding) => (combined | binding.propertyMask) >>> 0, 0)
    attributes.push(`data-mun-motion-mask="${mask}"`)
  }

  return attributes.join(" ")
}

function renderNode(
  node: MunUiNode,
  state: Readonly<Record<string, MunUiScalar>>,
): string {
  const attributes = attributesFor(node, state)

  switch (node.kind) {
    case "window":
      return renderNode(node.child, state)
    case "column":
    case "row":
      return `<div ${attributes}>${node.children.map(child => renderNode(child, state)).join("")}</div>`
    case "overlay":
      return `<div ${attributes}>${node.children.map(child => `<div style="grid-area:1 / 1">${renderNode(child, state)}</div>`).join("")}</div>`
    case "conditional": {
      const branch = evaluate(node.condition, state) ? node.then : node.otherwise
      return branch.map(child => renderNode(child, state)).join("")
    }
    case "text":
      return `<span ${attributes}>${escapeText(String(evaluate(node.value, state) ?? ""))}</span>`
    case "panel":
      return `<div ${attributes}></div>`
    case "action":
      return `<button type="button" ${attributes}>${escapeText(node.label)}</button>`
  }
}

/**
 * Web-target lowering for the shared Mün Semantic UI IR.
 *
 * HTML and CSS are deliberately introduced here, after semantic compilation.
 * They are target-platform representation, not Mün language semantics.
 */
export function renderMunUiProgramToHTML(
  program: MunUiProgram,
  options: MunWebIrRenderOptions = {},
): string {
  const state: Record<string, MunUiScalar> = Object.fromEntries(
    program.states.map(item => [item.name, item.initial]),
  )
  Object.assign(state, options.state)
  return renderNode(program.root.child, state)
}
