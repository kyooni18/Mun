import type {
  MunUiBinaryOperator,
  MunUiExpression,
  MunUiNode,
  MunUiPaint,
  MunUiProgram,
  MunUiScalar,
  MunUiValue,
} from "@mun/core"

export interface MunWebIrRenderOptions {
  readonly state?: Readonly<Record<string, MunUiValue>>
}

/** Evaluation scope: program state plus the items of enclosing `forEach`s. */
interface WebScope {
  readonly values: Readonly<Record<string, MunUiValue>>
  readonly items: ReadonlyMap<string, MunUiValue>
  /** Keyed instance suffix composed onto every node identity in an item. */
  readonly suffix: string
}

function lookupState(scope: WebScope, name: string): MunUiValue {
  // Item-scoped View state is keyed per instance; static rendering shows each
  // instance's initial value (the template entry) unless the host supplied it.
  return scope.values[`${name}${scope.suffix}`] ?? scope.values[name] ?? null
}

function asScalar(value: MunUiValue): MunUiScalar {
  return value === null || typeof value !== "object" ? value : null
}

function valueAt(value: MunUiValue, path: readonly string[]): MunUiValue {
  let current: MunUiValue = value
  for (const field of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return null
    current = (current as Readonly<Record<string, MunUiValue>>)[field] ?? null
  }
  return current
}

function keySegment(value: MunUiValue): string | undefined {
  if (typeof value === "string") {
    return `s:${Array.from(new TextEncoder().encode(value), byte =>
      /[A-Za-z0-9\-_.]/.test(String.fromCharCode(byte))
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("")}`
  }
  if (typeof value === "number" && Number.isFinite(value)) return `n:${Object.is(value, -0) ? 0 : value}`
  return undefined
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function stringifyScalar(value: MunUiValue): string {
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
  state: WebScope,
): MunUiValue {
  switch (expression.kind) {
    case "literal":
      return expression.value
    case "state":
      return lookupState(state, expression.state)
    case "item":
      return valueAt(state.items.get(expression.forEach) ?? null, expression.path)
    case "record":
      return Object.fromEntries(
        Object.entries(expression.fields).map(([name, field]) => [name, evaluate(field, state)]),
      )
    case "count": {
      const collection = evaluate(expression.collection, state)
      return Array.isArray(collection) ? collection.length : 0
    }
    case "filter": {
      const collection = evaluate(expression.collection, state)
      const expected = evaluate(expression.value, state)
      if (!Array.isArray(collection)) return []
      return collection.filter(item => {
        const matches = valueAt(item, expression.path) === expected
        return expression.operator === "equal" ? matches : !matches
      })
    }
    case "not":
      return !Boolean(evaluate(expression.value, state))
    case "stringify":
      return stringifyScalar(evaluate(expression.value, state))
    case "binary":
      return evaluateBinary(
        expression.operator,
        asScalar(evaluate(expression.left, state)),
        asScalar(evaluate(expression.right, state)),
      )
    case "conditional":
      return Boolean(evaluate(expression.condition, state))
        ? evaluate(expression.then, state)
        : evaluate(expression.otherwise, state)
  }
}

function cssValue(value: MunUiValue): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return `${value}px`
  if (typeof value === "string" && value.length > 0) return value
  return undefined
}

function paintCss(paint: MunUiPaint): string {
  if (typeof paint === "string") return paint
  if (paint.kind === "solid") return paint.color
  const directions: Readonly<Record<string, string>> = {
    "leading:trailing": "to right",
    "trailing:leading": "to left",
    "top:bottom": "to bottom",
    "bottom:top": "to top",
    "topLeading:bottomTrailing": "to bottom right",
    "topTrailing:bottomLeading": "to bottom left",
    "bottomLeading:topTrailing": "to top right",
    "bottomTrailing:topLeading": "to top left",
  }
  const direction = directions[`${paint.startPoint}:${paint.endPoint}`] ?? "to right"
  return `linear-gradient(${direction}, ${paint.start}, ${paint.end})`
}

function styleFor(
  node: MunUiNode,
  state: WebScope,
): string | undefined {
  const declarations: string[] = []
  const layout = node.layout
  const visual = node.visual

  if (node.kind === "column" || node.kind === "row") {
    declarations.push("display:flex")
    declarations.push(`flex-direction:${node.kind === "column" ? "column" : "row"}`)
  }

  if (node.kind === "scroll") {
    declarations.push(node.axis === "horizontal" ? "overflow-x:auto;overflow-y:hidden" : "overflow-y:auto;overflow-x:hidden")
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

  if (visual?.background) declarations.push(`background:${paintCss(visual.background)}`)
  if (visual?.foreground) declarations.push(`color:${paintCss(visual.foreground)}`)
  if (visual?.cornerRadius !== undefined) declarations.push(`border-radius:${visual.cornerRadius}px`)

  return declarations.length > 0 ? declarations.join(";") : undefined
}

function attributesFor(
  node: MunUiNode,
  state: WebScope,
): string {
  const attributes = [`data-mun-node="${escapeText(`${node.id}${state.suffix}`)}"`]
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
  state: WebScope,
): string {
  const attributes = attributesFor(node, state)

  switch (node.kind) {
    case "window":
      return renderNode(node.child, state)
    case "scroll":
    case "column":
    case "row":
      return `<div ${attributes}>${node.children.map(child => renderNode(child, state)).join("")}</div>`
    case "overlay":
      return `<div ${attributes}>${node.children.map(child => `<div style="grid-area:1 / 1">${renderNode(child, state)}</div>`).join("")}</div>`
    case "conditional": {
      const branch = evaluate(node.condition, state) ? node.then : node.otherwise
      return branch.map(child => renderNode(child, state)).join("")
    }
    case "forEach": {
      // Transparent keyed fragment: each instance composes the item key onto
      // template identities, matching the native runtime's materialization.
      const collection = evaluate(node.collection, state)
      if (!Array.isArray(collection)) return ""
      const seen = new Set<string>()
      return collection.map(item => {
        const segment = keySegment(valueAt(item, node.keyPath))
        if (segment === undefined) throw new TypeError(`ForEach '${node.id}' item key must be a string or finite number`)
        if (seen.has(segment)) throw new TypeError(`ForEach '${node.id}' has duplicate key ${segment}`)
        seen.add(segment)
        const items = new Map(state.items)
        items.set(node.id, item)
        const scope: WebScope = { values: state.values, items, suffix: `${state.suffix}[${segment}]` }
        return node.children.map(child => renderNode(child, scope)).join("")
      }).join("")
    }
    case "text":
      return `<span ${attributes}>${escapeText(String(asScalar(evaluate(node.value, state)) ?? ""))}</span>`
    case "panel":
      return `<div ${attributes}></div>`
    case "textField": {
      const value = asScalar(lookupState(state, node.state))
      return `<input type="text" ${attributes} value="${escapeText(value == null ? "" : String(value))}"${node.placeholder ? ` placeholder="${escapeText(node.placeholder)}"` : ""}>`
    }
    case "radioGroup":
      return `<div ${attributes} role="radiogroup">${node.options.map((option, index) => {
        const checked = lookupState(state, node.state) === option.value ? " checked" : ""
        const disabled = option.disabled ? " disabled" : ""
        return `<label><input type="radio" name="${escapeText(node.id)}" value="${escapeText(String(option.value))}"${checked}${disabled}>${escapeText(option.label)}</label>`
      }).join("")}</div>`
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
  const values: Record<string, MunUiValue> = Object.fromEntries(
    program.states.map(item => [item.name, item.initial]),
  )
  Object.assign(values, options.state)
  return renderNode(program.root.child, { values, items: new Map(), suffix: "" })
}
