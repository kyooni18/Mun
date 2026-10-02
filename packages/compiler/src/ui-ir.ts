import ts from "typescript"
import { compileMotionPlan as compileInheritedMotionPlan, curves as inheritedCurves, spring as inheritedSpring, timing as inheritedTiming } from "@mun/animation/core"
import {
  Animation,
  munMotionPropertyBit,
  resolveSemanticInitializer,
  type MunMotionExecutionPlan,
  type MunMotionProperty,
  type MunUiAction,
  type MunUiAlignment,
  type MunUiBinaryOperator,
  type MunUiExpression,
  type MunUiLayout,
  type MunUiNode,
  type MunUiOverlayAlignment,
  type MunUiPaint,
  type MunUiSelectionOption,
  type MunUiProgram,
  type MunUiScalar,
  type MunUiState,
  type MunUiValue,
  type MunUiTransition,
  type MunUiVisual,
  type MunUiShapeKind,
  type MunUiWindowNode,
  type SemanticArgument,
  type SemanticInitializerSymbol,
} from "@mun/core"
import {
  munExtension,
  nativeModifierSymbols,
  nativeViewInitializerSymbols,
  swiftUIApiManifest,
  swiftUIUnsupportedInitializerSignatures,
  swiftUIUnsupportedModifierSignatures,
  type SwiftUIViewSpec,
} from "@mun/core/swiftui-manifest"
import {
  parseMunBuilder,
  parseMunStructs,
  type MunArgument,
  type MunBuilderNode,
  type MunBuilderProgram,
  type MunCallExpression,
  type MunClosureExpression,
  type MunConditionalExpression,
  type MunStructDeclaration,
} from "./ast.js"
import { assertCanonicalMunSource } from "./analysis.js"
import { describeValueType, displayMunType, parseMunType, runtimeTypeName, validateCanonicalDeclarations, valueMatchesType, type MunType } from "./value-types.js"
import { resolveContractCall, swiftTypeName } from "./native-contract.js"
import { lowerAnimationValue, lowerColor, lowerPaint, lowerTransitionValue, nativeValueImplementations, parseMemberChain } from "./native-values.js"
import {
  semanticViewLookupCandidates,
  semanticViewsForStructs,
  type MunSemanticView,
} from "./semantic.js"
import { splitStatements, splitTopLevel } from "./scanner.js"

export interface MunUiCompileOptions {
  readonly windowTitle?: string
  readonly windowWidth?: number
  readonly windowHeight?: number
}

interface ModifierCall {
  readonly name: string
  readonly arguments: readonly MunArgument[]
  /** `.name(…) { … }` / `.name { … }`. */
  readonly trailing?: MunClosureExpression
}

interface MutableNodeParts {
  identityKey?: MunUiExpression
  layout?: MunUiLayout
  visual?: MunUiVisual
  motion?: MunUiNode["motion"]
  transition?: MunUiTransition
}

type UiBindings = ReadonlyMap<string, MunUiExpression>

interface ComponentSemanticArgument extends SemanticArgument {
  readonly sourceArgument?: MunArgument
  readonly trailingBodySource?: string
  readonly trailingClosure?: MunClosureExpression
}

const emptyBindings: UiBindings = new Map()
const literal = (value: MunUiValue): MunUiExpression => ({ kind: "literal", value })

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

function parsedExpression(source: string): ts.Expression {
  const file = ts.createSourceFile(
    "mun-ui-expression.ts",
    `(${swiftDictionaryLiterals(source)})`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const statement = file.statements[0]
  if (!statement || !ts.isExpressionStatement(statement)) {
    throw new SyntaxError(`Expected Mün UI expression, received: ${source}`)
  }
  return unwrap(statement.expression)
}

/**
 * TypeScript recovers from syntax errors (`[` parses as `[]`). State initial
 * values are stored data, so a recovered tree must never become one.
 */
/**
 * Swift dictionary literals (`[:]`, `["a": 1, "b": 2]`) as record literals, so
 * value expressions keep one parser. Array literals and ternaries are untouched.
 */
function swiftDictionaryLiterals(source: string): string {
  let output = ""
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === "\"" || character === "'" || character === "`") {
      let end = index + 1
      while (end < source.length && source[end] !== character) {
        // Swift interpolation `\(…)` may itself contain quotes.
        if (character === "\"" && source[end] === "\\" && source[end + 1] === "(") {
          end = matchingParenthesis(source, end + 1) + 1
          continue
        }
        end += source[end] === "\\" ? 2 : 1
      }
      const literal = source.slice(index, end + 1)
      output += character === "\"" ? swiftInterpolation(literal) : literal
      index = end
      continue
    }
    if (character !== "[") { output += character; continue }
    let depth = 0
    let close = -1
    for (let scan = index; scan < source.length; scan += 1) {
      const next = source[scan]
      if (next === "\"" || next === "'") { scan += 1; while (scan < source.length && source[scan] !== next) scan += source[scan] === "\\" ? 2 : 1; continue }
      if ("([{".includes(next)) depth += 1
      else if (")]}".includes(next) && --depth === 0) { close = scan; break }
    }
    if (close < 0) { output += character; continue }
    const inner = source.slice(index + 1, close)
    if (inner.trim() === ":") {
      output += "{}"
      index = close
      continue
    }
    const entries = splitTopLevel(inner).filter(entry => entry.trim())
    const pairs = entries.map(entry => {
      let level = 0
      for (let scan = 0; scan < entry.length; scan += 1) {
        const next = entry[scan]
        if (next === "\"" || next === "'") { scan += 1; while (scan < entry.length && entry[scan] !== next) scan += entry[scan] === "\\" ? 2 : 1; continue }
        if ("([{".includes(next)) level += 1
        else if (")]}".includes(next)) level -= 1
        else if (level === 0 && next === "?") return undefined
        else if (level === 0 && next === ":") return [entry.slice(0, scan).trim(), entry.slice(scan + 1).trim()] as const
      }
      return undefined
    })
    if (entries.length > 0 && pairs.every(pair => pair !== undefined)) {
      output += `{ ${pairs.map(pair => `${pair![0]}: ${swiftDictionaryLiterals(pair![1])}`).join(", ")} }`
    } else {
      output += `[${swiftDictionaryLiterals(inner)}]`
    }
    index = close
  }
  return output
}

function matchingParenthesis(source: string, open: number): number {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]
    if (character === "\"") {
      index += 1
      while (index < source.length && source[index] !== "\"") {
        if (source[index] === "\\" && source[index + 1] === "(") { index = matchingParenthesis(source, index + 1) + 1; continue }
        index += source[index] === "\\" ? 2 : 1
      }
      continue
    }
    if (character === "(") depth += 1
    else if (character === ")" && --depth === 0) return index
  }
  throw new SyntaxError(`Unclosed string interpolation in Mün source: ${source}`)
}

/** `"Total: \(count) items"` → `("Total: " + String(count) + " items")`. */
function swiftInterpolation(literal: string): string {
  if (!literal.includes("\\(")) return literal
  const body = literal.slice(1, -1)
  const parts: string[] = []
  let segment = ""
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "\\" && body[index + 1] === "(") {
      const close = matchingParenthesis(body, index + 1)
      if (segment) parts.push(`"${segment}"`)
      segment = ""
      parts.push(`String(${swiftDictionaryLiterals(body.slice(index + 2, close))})`)
      index = close
      continue
    }
    if (body[index] === "\\") {
      segment += body.slice(index, index + 2)
      index += 1
      continue
    }
    segment += body[index]
  }
  if (segment) parts.push(`"${segment}"`)
  return `(${parts.join(" + ")})`
}

function assertWellFormedValueSource(source: string, owner: string): void {
  const file = ts.createSourceFile("mun-ui-value.ts", `(${swiftDictionaryLiterals(source)})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const diagnostics = (file as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics
  if (file.statements.length !== 1 || (diagnostics?.length ?? 0) > 0) {
    throw new SyntaxError(`${owner} has a malformed initial value: ${source}`)
  }
}

function scalarFromExpression(expression: ts.Expression): MunUiScalar | undefined {
  const value = unwrap(expression)
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text
  if (ts.isNumericLiteral(value)) return Number(value.text)
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false
  if (value.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(unwrap(value.operand))) {
    return -Number((unwrap(value.operand) as ts.NumericLiteral).text)
  }
  return undefined
}

/** Fully static array/object/scalar literal values (collection initial state). */
function staticValueFromExpression(expression: ts.Expression): MunUiValue | undefined {
  const value = unwrap(expression)
  const scalar = scalarFromExpression(value)
  if (scalar !== undefined || value.kind === ts.SyntaxKind.NullKeyword) return scalar ?? null
  if (ts.isArrayLiteralExpression(value)) {
    const items: MunUiValue[] = []
    for (const element of value.elements) {
      const item = staticValueFromExpression(element)
      if (item === undefined) return undefined
      items.push(item)
    }
    return items
  }
  if (ts.isObjectLiteralExpression(value)) {
    const record: Record<string, MunUiValue> = {}
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined
      const name = propertyName(property.name)
      if (name === undefined) return undefined
      const field = staticValueFromExpression(property.initializer)
      if (field === undefined) return undefined
      record[name] = field
    }
    return record
  }
  return undefined
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

/** `\.a.b` key paths; `\.self` (or absent) is the item itself. */
function keyPathFromSource(source: string | undefined): readonly string[] {
  if (!source) return ["id"]
  const match = /^\\\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/.exec(source.trim())
  if (!match) throw new SyntaxError(`ForEach id must be a key path such as \\.id: ${source}`)
  return match[1] === "self" ? [] : match[1].split(".")
}

function binaryOperator(kind: ts.SyntaxKind): MunUiBinaryOperator | undefined {
  switch (kind) {
    case ts.SyntaxKind.PlusToken: return "add"
    case ts.SyntaxKind.MinusToken: return "subtract"
    case ts.SyntaxKind.AsteriskToken: return "multiply"
    case ts.SyntaxKind.SlashToken: return "divide"
    case ts.SyntaxKind.PercentToken: return "modulo"
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken: return "equal"
    case ts.SyntaxKind.ExclamationEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken: return "notEqual"
    case ts.SyntaxKind.LessThanToken: return "less"
    case ts.SyntaxKind.LessThanEqualsToken: return "lessOrEqual"
    case ts.SyntaxKind.GreaterThanToken: return "greater"
    case ts.SyntaxKind.GreaterThanEqualsToken: return "greaterOrEqual"
    case ts.SyntaxKind.AmpersandAmpersandToken: return "and"
    case ts.SyntaxKind.BarBarToken: return "or"
    default: return undefined
  }
}

function lowerValueExpression(source: string, bindings: UiBindings = emptyBindings): MunUiExpression {
  const expression = unwrap(parsedExpression(source))
  const scalar = scalarFromExpression(expression)
  if (scalar !== undefined || expression.kind === ts.SyntaxKind.NullKeyword) return literal(scalar ?? null)
  const staticValue = staticValueFromExpression(expression)
  if (staticValue !== undefined) return literal(staticValue)

  if (ts.isIdentifier(expression)) {
    const binding = bindings.get(expression.text)
    if (binding) return binding
    // Swift's `nil` is Mün's absent optional value.
    if (expression.text === "nil") return literal(null)
  }

  if (ts.isObjectLiteralExpression(expression)) {
    const fields: Record<string, MunUiExpression> = {}
    for (const property of expression.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        fields[property.name.text] = lowerValueExpression(property.name.text, bindings)
        continue
      }
      const name = ts.isPropertyAssignment(property) ? propertyName(property.name) : undefined
      if (!ts.isPropertyAssignment(property) || name === undefined) {
        throw new SyntaxError(`Native record fields must be plain property assignments: ${source}`)
      }
      fields[name] = lowerValueExpression(property.initializer.getText(), bindings)
    }
    return { kind: "record", fields }
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const base = expression.expression
    const name = expression.name.text
    const baseBinding = ts.isIdentifier(base) ? bindings.get(base.text) : undefined
    if (name !== "value" || baseBinding?.kind === "item") {
      if (name === "count" || name === "length") {
        const collection = lowerValueExpression(base.getText(), bindings)
        if (collection.kind !== "item" || collection.path.length > 0 || name === "count") {
          return { kind: "count", collection }
        }
      }
      const lowered = name === "value" && baseBinding?.kind !== "item"
        ? undefined
        : lowerValueExpression(base.getText(), bindings)
      if (lowered?.kind === "item") return { ...lowered, path: [...lowered.path, name] }
    }
  }

  if (
    ts.isCallExpression(expression)
    && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === "filter"
    && expression.arguments.length === 1
  ) {
    const predicate = unwrap(expression.arguments[0])
    const parameter = ts.isArrowFunction(predicate) && predicate.parameters.length === 1
      && ts.isIdentifier(predicate.parameters[0].name)
      ? predicate.parameters[0].name.text
      : undefined
    const body = parameter && ts.isArrowFunction(predicate) && !ts.isBlock(predicate.body)
      ? unwrap(predicate.body)
      : undefined
    const operator = body && ts.isBinaryExpression(body) ? binaryOperator(body.operatorToken.kind) : undefined
    const fieldPath = (side: ts.Expression): string[] | undefined => {
      const path: string[] = []
      let current = unwrap(side)
      while (ts.isPropertyAccessExpression(current)) {
        path.unshift(current.name.text)
        current = unwrap(current.expression)
      }
      return ts.isIdentifier(current) && current.text === parameter && path.length > 0 ? path : undefined
    }
    if (body && ts.isBinaryExpression(body) && (operator === "equal" || operator === "notEqual")) {
      const leftPath = fieldPath(body.left)
      const rightPath = fieldPath(body.right)
      const path = leftPath ?? rightPath
      const other = leftPath ? body.right : body.left
      if (path && !(leftPath && rightPath)) {
        return {
          kind: "filter",
          collection: lowerValueExpression(expression.expression.expression.getText(), bindings),
          path,
          operator,
          value: lowerValueExpression(other.getText(), bindings),
        }
      }
    }
    throw new SyntaxError(
      `Native collection filters must compare one item field with a value, e.g. items.filter(item => item.done == false): ${source}`,
    )
  }

  if (
    ts.isPropertyAccessExpression(expression)
    && expression.name.text === "value"
    && ts.isIdentifier(expression.expression)
  ) {
    const binding = bindings.get(expression.expression.text)
    if (binding?.kind === "state") return binding
    return { kind: "state", state: expression.expression.text }
  }

  if (
    ts.isCallExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === "String"
    && expression.arguments.length === 1
  ) {
    return {
      kind: "stringify",
      value: lowerValueExpression(expression.arguments[0].getText(), bindings),
    }
  }

  if (ts.isBinaryExpression(expression)) {
    const operator = binaryOperator(expression.operatorToken.kind)
    if (operator) {
      return {
        kind: "binary",
        operator,
        left: lowerValueExpression(expression.left.getText(), bindings),
        right: lowerValueExpression(expression.right.getText(), bindings),
      }
    }
  }
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    return { kind: "not", value: lowerValueExpression(expression.operand.getText(), bindings) }
  }

  if (ts.isConditionalExpression(expression)) {
    return {
      kind: "conditional",
      condition: lowerValueExpression(expression.condition.getText(), bindings),
      then: lowerValueExpression(expression.whenTrue.getText(), bindings),
      otherwise: lowerValueExpression(expression.whenFalse.getText(), bindings),
    }
  }

  throw new SyntaxError(`Expression is not yet representable in Mün semantic UI IR: ${source}`)
}

function semanticTypeForUiExpression(
  expression: MunUiExpression,
  stateTypes: ReadonlyMap<string, string>,
): string | undefined {
  if (expression.kind === "literal") return expression.value === null ? "null" : typeof expression.value
  if (expression.kind === "state") return stateTypes.get(expression.state)
  if (expression.kind === "not") return "boolean"
  if (expression.kind === "stringify") return "string"
  if (expression.kind === "binary") {
    if (["equal", "notEqual", "less", "lessOrEqual", "greater", "greaterOrEqual", "and", "or"].includes(expression.operator)) {
      return "boolean"
    }
    if (expression.operator === "add") {
      const left = semanticTypeForUiExpression(expression.left, stateTypes)
      const right = semanticTypeForUiExpression(expression.right, stateTypes)
      if (left === "string" && right === "string") return "string"
    }
    return "number"
  }
  if (expression.kind === "conditional") {
    const thenType = semanticTypeForUiExpression(expression.then, stateTypes)
    const otherwiseType = semanticTypeForUiExpression(expression.otherwise, stateTypes)
    return thenType && thenType === otherwiseType ? thenType : undefined
  }
  if (expression.kind === "item") return "dynamic"
  if (expression.kind === "record") return "object"
  if (expression.kind === "count") return "number"
  if (expression.kind === "filter") return "array"
  return undefined
}

function componentSemanticArgument(
  argument: MunArgument,
  bindings: UiBindings,
  stateTypes: ReadonlyMap<string, string>,
): ComponentSemanticArgument {
  if (argument.value.kind === "closure") {
    return { label: argument.label, type: "function", sourceArgument: argument }
  }

  if (isBindingSource(argument.value.source)) {
    const binding = bindingStateExpression(argument.value.source, bindings)
    const underlyingType = stateTypes.get(binding.state)
    return {
      label: argument.label,
      kind: "binding",
      type: "binding",
      ...(underlyingType ? { underlyingType } : {}),
      sourceArgument: argument,
    }
  }

  const implicitMember = /^\.([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(argument.value.source.trim())
  if (implicitMember) {
    return {
      label: argument.label,
      // `.infinity` is CGFloat.infinity; other implicit members are enum cases.
      type: implicitMember[1] === "infinity" ? "number" : "string",
      value: implicitMember[1],
      sourceArgument: argument,
    }
  }

  const source = argument.value.source.trim()
  if (/^(?:\[|Array\s*\()/.test(source)) {
    return { label: argument.label, type: "array", sourceArgument: argument }
  }
  if (/^\{[\s\S]*\}$/.test(source)) {
    return { label: argument.label, type: "object", sourceArgument: argument }
  }

  let type: string | undefined
  try {
    type = semanticTypeForUiExpression(lowerValueExpression(argument.value.source, bindings), stateTypes)
  } catch {
    type = undefined
  }
  return {
    label: argument.label,
    ...(type ? { type } : {}),
    sourceArgument: argument,
  }
}

/**
 * Collection state is typed structurally at runtime ("array"); a declared
 * element type (`Task[]`, `Array<Task>`) is accepted for it. Element shapes are
 * not checked here: the runtime validates keys when it materializes items.
 */
function bindingTypeMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true
  let declared: MunType
  try {
    declared = parseMunType(expected, { canonical: false, what: "@Binding" })
  } catch {
    return false
  }
  if (actual === "null") return declared.kind === "optional"
  return runtimeTypeName(declared) === actual
}

function stateTypeMap(states: readonly MunUiState[]): Map<string, string> {
  return new Map(states.map(state => [
    state.name,
    state.initial === null ? "null" : typeof state.initial,
  ] as const))
}

function stateTarget(name: string, bindings: UiBindings): string {
  const binding = bindings.get(name)
  return binding?.kind === "state" ? binding.state : name
}

function isBindingSource(source: string): boolean {
  const trimmed = source.trim()
  return /^\$[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed)
    || /^Binding\s*\(/.test(trimmed)
}

function bindingStateExpression(
  source: string,
  bindings: UiBindings,
): Extract<MunUiExpression, { readonly kind: "state" }> {
  const trimmed = source.trim()
  const shorthand = /^\$([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(trimmed)
  const constructor = /^Binding\s*\(\s*\$?([A-Za-z_$][A-Za-z0-9_$]*)\s*\)$/.exec(trimmed)
  const name = shorthand?.[1] ?? constructor?.[1]
  if (!name) {
    const plain = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed) ? ` — pass $${trimmed}` : ""
    throw new SyntaxError(`A Binding is required, but '${trimmed}' is a value${plain}. Use $state or Binding(state).`)
  }
  const bound = bindings.get(name)
  if (bound?.kind === "state") return bound
  return { kind: "state", state: name }
}

function initializerDefaultSources(
  parametersSource: string,
  parameters: readonly { readonly name?: string }[],
): ReadonlyMap<string, string> {
  const declarations = splitTopLevel(parametersSource)
  const defaults = new Map<string, string>()
  for (let index = 0; index < parameters.length; index += 1) {
    const name = parameters[index]?.name
    const declaration = declarations[index]
    if (!name || !declaration) continue
    const equals = declaration.search(/=(?!>)/)
    if (equals < 0) continue
    defaults.set(name, declaration.slice(equals + 1).trim())
  }
  return defaults
}

function explicitInitializerAssignments(bodySource: string): ReadonlyMap<string, string> {
  const assignments = new Map<string, string>()
  for (const statement of splitStatements(bodySource)) {
    if (/^self\.init\s*\(/.test(statement)) {
      throw new SyntaxError("Native explicit initializer delegation is not implemented yet")
    }
    const match = /^self\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=(?!=|>)\s*([\s\S]+)$/.exec(statement)
    if (!match) {
      throw new SyntaxError(
        `Native explicit initializer supports direct self.field assignments only: ${statement}`,
      )
    }
    assignments.set(match[1], match[2].trim())
  }
  return assignments
}

function numberValue(source: string | undefined, fallback?: number, bindings: UiBindings = emptyBindings): number | undefined {
  if (source === undefined) return fallback
  const value = lowerValueExpression(source, bindings)
  if (value.kind === "literal" && typeof value.value === "number" && Number.isFinite(value.value)) {
    return value.value
  }
  throw new SyntaxError(`Native semantic numeric value must be a finite static number: ${source}`)
}

function stringValue(source: string | undefined, fallback?: string, bindings: UiBindings = emptyBindings): string | undefined {
  if (source === undefined) return fallback
  const value = lowerValueExpression(source, bindings)
  if (value.kind === "literal" && typeof value.value === "string") return value.value
  throw new SyntaxError(`Native semantic string value must be static: ${source}`)
}

function bindingState(source: string | undefined, bindings: UiBindings, control: string): string {
  if (!source) throw new SyntaxError(`${control} requires a Binding`)
  return bindingStateExpression(source, bindings).state
}

function rawArgument(call: MunCallExpression, label: string, positionalIndex: number): string | undefined {
  const labeled = call.arguments.find(argument => argument.label === label)
  const argument = labeled ?? call.arguments.filter(item => item.label === undefined)[positionalIndex]
  return argument?.value.kind === "raw" ? argument.value.source.trim() : undefined
}

function stateDeclarations(source: string): MunUiState[] {
  const states: MunUiState[] = []
  const pattern = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*State\s*\(\s*([^\n;]+?)\s*\)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    const expression = parsedExpression(match[2])
    const initial = scalarFromExpression(expression)
    if (initial === undefined && expression.kind !== ts.SyntaxKind.NullKeyword) {
      throw new SyntaxError(`Native semantic state '${match[1]}' requires a scalar initial value for now`)
    }
    states.push({ name: match[1], initial: initial ?? null })
  }
  return states
}

/**
 * The entry View: `@main struct App: View` (canonical, as in Swift) or the
 * compatibility spelling `export default App()`. Without either, the first View.
 */
function entryName(source: string, fallback: string): string {
  const main = [...source.matchAll(/@main\s+struct\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1])
  if (main.length > 1) throw new SyntaxError(`Only one View can be @main; found ${main.join(", ")}`)
  const exported = source.match(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*\(/)?.[1]
  if (main[0] && exported && main[0] !== exported) {
    throw new SyntaxError(`@main ${main[0]} and export default ${exported}() name different entry Views`)
  }
  return main[0] ?? exported ?? fallback
}

/** Labeled/positional arguments of a collection method call. */
function collectionArguments(source: string): { readonly label?: string; readonly source: string }[] {
  if (!source.trim()) return []
  return splitTopLevel(source).map(part => {
    const labeled = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(part.trim())
    return labeled ? { label: labeled[1], source: labeled[2] } : { source: part.trim() }
  })
}

function collectionAction(
  state: string,
  method: string,
  argumentSource: string,
  bindings: UiBindings,
): MunUiAction {
  const args = collectionArguments(argumentSource)
  const positional = args.filter(argument => argument.label === undefined)
  const labeled = (label: string) => args.find(argument => argument.label === label)?.source
  const value = (expression: string | undefined, role: string): MunUiExpression => {
    if (!expression) throw new SyntaxError(`Collection ${method} requires ${role}: ${state}.${method}(${argumentSource})`)
    return lowerValueExpression(expression, bindings)
  }
  // Key paths are stamped from the rendering ForEach after lowering.
  const base = { kind: "collection" as const, state, keyPath: [] as readonly string[] }
  switch (method) {
    case "insert":
      return { ...base, operation: "insert", value: value(positional[0]?.source, "a value"), index: value(labeled("at"), "at: index") }
    case "append":
      return { ...base, operation: "append", value: value(positional[0]?.source, "a value") }
    case "remove":
      return { ...base, operation: "remove", key: value(positional[0]?.source ?? labeled("id"), "an item key") }
    case "move":
      return { ...base, operation: "move", key: value(positional[0]?.source, "an item key"), offset: value(labeled("by"), "by: offset") }
    case "update": {
      const key = value(positional[0]?.source, "an item key")
      const fields = args.filter(argument => argument.label !== undefined)
      if (fields.length === 0) throw new SyntaxError(`Collection update requires field: value arguments: ${state}.update(${argumentSource})`)
      const updates = fields.map(field => ({
        ...base,
        operation: "update" as const,
        key,
        path: [field.label as string],
        value: lowerValueExpression(field.source, bindings),
      }))
      return updates.length === 1 ? updates[0] : { kind: "sequence", actions: updates }
    }
    default:
      throw new SyntaxError(`Unsupported native collection operation '${method}'`)
  }
}

function actionFromClosure(source: string, bindings: UiBindings = emptyBindings): MunUiAction {
  const body = source.trim().replace(/;$/, "").trim()
  const statements = splitStatements(body)
  if (statements.length > 1) {
    return { kind: "sequence", actions: statements.map(statement => actionFromClosure(statement, bindings)) }
  }
  const actionProgram = parseMunBuilder(body)
  if (actionProgram.statements.length === 1) {
    const statement = actionProgram.statements[0]
    if (statement.kind === "call" && statement.callee === "withAnimation" && statement.trailing) {
      const animationSource = statement.arguments[0]?.value.kind === "raw"
        ? statement.arguments[0].value.source.trim()
        : undefined
      const animation = animationSource === "null"
        ? null
        : animationPlan(animationSource ?? "Animation.default")
      const nested = actionFromClosure(statement.trailing.bodySource, bindings)
      if (nested.transaction) return nested
      return {
        ...nested,
        transaction: {
          animation,
          disablesAnimations: false,
          isContinuous: false,
        },
      }
    }
    if (statement.kind === "call" && statement.callee === "withTransaction" && statement.trailing) {
      const transactionSource = statement.arguments[0]?.value.kind === "raw"
        ? statement.arguments[0].value.source.trim()
        : undefined
      if (!transactionSource) {
        throw new SyntaxError("withTransaction requires a statically representable Transaction")
      }
      const nested = actionFromClosure(statement.trailing.bodySource, bindings)
      if (nested.transaction) return nested
      return { ...nested, transaction: transactionPlan(transactionSource) }
    }
  }

  const toggleAssignment = body.match(/^([A-Za-z_$][\w$]*)\.value\s*=\s*!\s*\1\.value$/)
  if (toggleAssignment) return { kind: "toggle-state", state: stateTarget(toggleAssignment[1], bindings) }

  const toggleCall = body.match(/^([A-Za-z_$][\w$]*)\.toggle\s*\(\s*\)$/)
  if (toggleCall) return { kind: "toggle-state", state: stateTarget(toggleCall[1], bindings) }

  const compoundAssignment = body.match(/^([A-Za-z_$][\w$]*)\.value\s*(\+=|-=|\*=|\/=|%=)\s*(.+)$/s)
  if (compoundAssignment) {
    const operator = compoundAssignment[2][0]
    return {
      kind: "set-state",
      state: stateTarget(compoundAssignment[1], bindings),
      value: lowerValueExpression(
        `${compoundAssignment[1]}.value ${operator} (${compoundAssignment[3]})`,
        bindings,
      ),
    }
  }
  const assignment = body.match(/^([A-Za-z_$][\w$]*)\.value\s*=\s*(.+)$/s)
  if (assignment) {
    return {
      kind: "set-state",
      state: stateTarget(assignment[1], bindings),
      value: lowerValueExpression(assignment[2], bindings),
    }
  }

  const collectionCall = /^([A-Za-z_$][\w$]*)\.(insert|append|remove|move|update)\s*\(([\s\S]*)\)$/.exec(body)
  if (collectionCall) {
    return collectionAction(stateTarget(collectionCall[1], bindings), collectionCall[2], collectionCall[3], bindings)
  }

  const plainAssignment = /^([A-Za-z_$][\w$]*)\s*(\+=|-=|\*=|\/=|%=|=)(?!=)\s*([\s\S]+)$/.exec(body)
  if (plainAssignment && bindings.get(plainAssignment[1])?.kind === "state") {
    const [, name, operator, valueSource] = plainAssignment
    return {
      kind: "set-state",
      state: stateTarget(name, bindings),
      value: lowerValueExpression(
        operator === "=" ? valueSource : `${name} ${operator[0]} (${valueSource})`,
        bindings,
      ),
    }
  }

  throw new SyntaxError(`Action body is not yet representable in native Mün IR: ${source.trim()}`)
}

function lowerAnimation(animation: Animation, source: string): MunMotionExecutionPlan {
  const descriptor = animation.descriptor
  const repeatCount: number | "infinite" = descriptor.repeatCount === Number.POSITIVE_INFINITY
    ? "infinite"
    : Math.max(1, Math.floor(Number.isFinite(descriptor.repeatCount) ? descriptor.repeatCount ?? 1 : 1))

  const speed = descriptor.speed > 0 && Number.isFinite(descriptor.speed) ? descriptor.speed : 1
  const delayMs = Math.max(0, descriptor.delay) / speed * 1000

  if (descriptor.kind === "spring") {
    const response = Math.max(0.05, descriptor.response ?? descriptor.duration) / speed
    const dampingRatio = Math.max(0, descriptor.dampingFraction ?? 0.825)
    const blendDuration = Math.max(0, descriptor.blendDuration ?? 0) / speed
    const inherited = compileInheritedMotionPlan(inheritedSpring({ response, dampingRatio, blendDuration }))
    if (inherited.route !== "spring") {
      throw new SyntaxError(`Inherited motion planner did not produce a spring plan for ${source}`)
    }
    return {
      kind: "spring",
      omega: inherited.omega,
      dampingRatio: inherited.dampingRatio,
      blendDuration: inherited.spec.blendDuration ?? blendDuration,
      delayMs,
      repeatCount,
      autoreverses: descriptor.autoreverses ?? true,
    }
  }

  const curve = descriptor.kind === "linear" ? inheritedCurves.linear
    : descriptor.kind === "easeIn" ? inheritedCurves.easeIn
      : descriptor.kind === "easeOut" ? inheritedCurves.easeOut
        : inheritedCurves.easeInOut
  const duration = Math.max(0, descriptor.duration) / speed
  const inherited = compileInheritedMotionPlan(inheritedTiming({ duration, curve }))
  if (inherited.route !== "timing") {
    throw new SyntaxError(`Inherited motion planner did not produce a timing plan for ${source}`)
  }
  return {
    kind: "timing",
    duration: inherited.spec.duration,
    curve: [inherited.spec.curve.x1, inherited.spec.curve.y1, inherited.spec.curve.x2, inherited.spec.curve.y2],
    delayMs,
    repeatCount,
    autoreverses: descriptor.autoreverses ?? true,
  }
}

function animationPlan(source: string): MunMotionExecutionPlan {
  return lowerAnimation(lowerAnimationValue(source), source)
}

function lowerTransition(source: string): MunUiTransition {
  const transition = lowerTransitionValue(source)
  return {
    insertion: transition.insertion.map(effect => ({ ...effect })),
    removal: transition.removal.map(effect => ({ ...effect })),
    ...(transition.animation ? { animation: lowerAnimation(transition.animation, `${source}.animation`) } : {}),
  }
}

/** `Transaction(animation: .linear(duration: 1))`. */
function transactionPlan(source: string): MunUiAction["transaction"] & {} {
  const trimmed = source.trim()
  if (/^new\s/.test(trimmed)) throw new SyntaxError(`'new' is TypeScript syntax. Use Transaction(animation: …): ${source}`)
  const statement = parseMunBuilder(trimmed).statements[0]
  const argument = statement?.kind === "call" && statement.callee === "Transaction" && !statement.trailing && statement.arguments.length === 1
    ? statement.arguments[0]
    : undefined
  if (!argument || argument.label !== "animation" || argument.value.kind !== "raw") {
    throw new SyntaxError(`withTransaction requires Transaction(animation: …): ${source}`)
  }
  const animationSource = argument.value.source.trim()
  const animation = animationSource === "nil" ? null : lowerAnimationValue(animationSource)
  return { animation: animation ? lowerAnimation(animation, source) : null, disablesAnimations: false, isContinuous: false }
}

function skipQuoted(source: string, index: number): number {
  const quote = source[index]
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") { cursor += 1; continue }
    if (source[cursor] === quote) return cursor + 1
  }
  throw new SyntaxError("Unclosed string while reading Mün view modifiers")
}

function findMatchingParenthesis(source: string, openIndex: number, open = "(", close = ")"): number {
  let depth = 1
  for (let cursor = openIndex + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    if (character === "\"" || character === "'" || character === "`") {
      cursor = skipQuoted(source, cursor) - 1
      continue
    }
    if (character === open) depth += 1
    else if (character === close) {
      depth -= 1
      if (depth === 0) return cursor
    }
  }
  throw new SyntaxError(open === "(" ? "Unclosed modifier argument list in Mün source" : "Unclosed modifier closure in Mün source")
}

function firstTopLevelModifier(source: string): number {
  const stack: string[] = []
  const closes: Record<string, string> = { "(": ")", "{": "}", "[": "]" }
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    if (character === "\"" || character === "'" || character === "`") {
      cursor = skipQuoted(source, cursor) - 1
      continue
    }
    if (character === "(" || character === "{" || character === "[") {
      stack.push(character)
      continue
    }
    if (character === ")" || character === "}" || character === "]") {
      const open = stack.at(-1)
      if (open && closes[open] === character) stack.pop()
      continue
    }
    if (character === "." && stack.length === 0 && /[A-Za-z_$]/.test(source[cursor + 1] ?? "")) return cursor
  }
  return -1
}

function modifierArguments(source: string, trailing?: string): Pick<ModifierCall, "arguments" | "trailing"> {
  if (!source.trim() && trailing === undefined) return { arguments: [] }
  const program = parseMunBuilder(`M(${source})${trailing === undefined ? "" : ` ${trailing}`}`)
  const statement = program.statements[0]
  if (!statement || statement.kind !== "call") throw new SyntaxError(`Invalid Mün modifier arguments: ${source}`)
  return { arguments: statement.arguments, ...(statement.trailing ? { trailing: statement.trailing } : {}) }
}

function splitViewChain(source: string): { readonly base: MunBuilderNode; readonly modifiers: readonly ModifierCall[] } {
  const trimmed = source.trim()
  const firstDot = firstTopLevelModifier(trimmed)
  if (firstDot < 0) {
    const program = parseMunBuilder(trimmed)
    if (program.statements.length !== 1) throw new SyntaxError(`Expected one Mün view expression: ${trimmed}`)
    return { base: program.statements[0], modifiers: [] }
  }

  const baseSource = trimmed.slice(0, firstDot).trim()
  const program = parseMunBuilder(baseSource)
  if (program.statements.length !== 1) throw new SyntaxError(`Expected one Mün base view expression: ${baseSource}`)

  const modifiers: ModifierCall[] = []
  let cursor = firstDot
  while (cursor < trimmed.length) {
    while (/\s/.test(trimmed[cursor] ?? "")) cursor += 1
    if (trimmed[cursor] !== ".") throw new SyntaxError(`Expected Mün view modifier near: ${trimmed.slice(cursor)}`)
    cursor += 1
    while (/\s/.test(trimmed[cursor] ?? "")) cursor += 1
    const nameStart = cursor
    while (/[A-Za-z0-9_$]/.test(trimmed[cursor] ?? "")) cursor += 1
    const name = trimmed.slice(nameStart, cursor)
    while (/\s/.test(trimmed[cursor] ?? "")) cursor += 1
    // `.name(args)`, `.name(args) { … }` or `.name { … }` (trailing closure).
    let argumentSource = ""
    const hasArgumentList = trimmed[cursor] === "("
    if (hasArgumentList) {
      const close = findMatchingParenthesis(trimmed, cursor)
      argumentSource = trimmed.slice(cursor + 1, close)
      cursor = close + 1
    }
    let lookahead = cursor
    while (/\s/.test(trimmed[lookahead] ?? "")) lookahead += 1
    let trailing: string | undefined
    if (trimmed[lookahead] === "{") {
      const close = findMatchingParenthesis(trimmed, lookahead, "{", "}")
      trailing = trimmed.slice(lookahead, close + 1)
      cursor = close + 1
    } else if (!hasArgumentList) {
      throw new SyntaxError(`Modifier .${name} requires an argument list`)
    }
    modifiers.push({ name, ...modifierArguments(argumentSource, trailing) })
  }

  return { base: program.statements[0], modifiers }
}

function expressionIsDynamic(value: MunUiExpression | undefined): value is MunUiExpression {
  return !!value && value.kind !== "literal"
}

interface StructDeclarationIndex {
  readonly byQualifiedName: ReadonlyMap<string, MunStructDeclaration>
  readonly qualifiedNameByDeclaration: ReadonlyMap<MunStructDeclaration, string>
}

function collectStructDeclarations(
  declarations: readonly MunStructDeclaration[],
  prefix = "",
  byQualifiedName = new Map<string, MunStructDeclaration>(),
  qualifiedNameByDeclaration = new Map<MunStructDeclaration, string>(),
): StructDeclarationIndex {
  for (const declaration of declarations) {
    const qualifiedName = prefix ? `${prefix}.${declaration.name}` : declaration.name
    byQualifiedName.set(qualifiedName, declaration)
    qualifiedNameByDeclaration.set(declaration, qualifiedName)
    collectStructDeclarations(
      declaration.nested ?? [],
      qualifiedName,
      byQualifiedName,
      qualifiedNameByDeclaration,
    )
  }
  return { byQualifiedName, qualifiedNameByDeclaration }
}

type UiIdentitySegment = string | number
type UiIdentityPath = readonly UiIdentitySegment[]
type UiStateIdentityPath = UiIdentityPath | null

function identityPathKey(path: UiIdentityPath): string {
  return path.map(segment => typeof segment === "number" ? `#${segment}` : segment).join("/")
}

function childIdentityPath(path: UiStateIdentityPath, ...segments: UiIdentitySegment[]): UiStateIdentityPath {
  return path ? [...path, ...segments] : null
}

function encodedIdentityKeySegment(key: string | number): string {
  return typeof key === "number"
    ? `n:${Object.is(key, -0) ? "0" : String(key)}`
    : `s:${encodeURIComponent(key)}`
}

function keyedIdentityPath(path: UiIdentityPath, key: string | number): UiIdentityPath {
  const parent = path.at(-2) === "child" ? path.slice(0, -2) : path
  return [...parent, "key", encodedIdentityKeySegment(key)]
}

function keyedStateIdentityPath(path: UiStateIdentityPath, key: string | number): UiStateIdentityPath {
  return path ? keyedIdentityPath(path, key) : null
}

function nodeIdentityPathForModifiers(
  path: UiIdentityPath,
  modifiers: readonly ModifierCall[],
  bindings: UiBindings,
): UiIdentityPath {
  let current = path
  for (const modifier of modifiers) {
    if (modifier.name !== "id") continue
    const identityKey = semanticIdentityKey(idModifierSource(modifier), bindings)
    if (identityKey.kind !== "literal") continue
    if (typeof identityKey.value !== "string" && typeof identityKey.value !== "number") continue
    current = keyedIdentityPath(current, identityKey.value)
  }
  return current
}

function stateIdentityPathForModifiers(
  path: UiStateIdentityPath,
  modifiers: readonly ModifierCall[],
  bindings: UiBindings,
): UiStateIdentityPath {
  let current = path
  for (const modifier of modifiers) {
    if (modifier.name !== "id") continue
    const identityKey = semanticIdentityKey(idModifierSource(modifier), bindings)
    if (identityKey.kind !== "literal") return null
    if (typeof identityKey.value !== "string" && typeof identityKey.value !== "number") return null
    current = keyedStateIdentityPath(current, identityKey.value)
  }
  return current
}

interface NativeCallContext {
  readonly lowerer: UiLowerer
  readonly call: MunCallExpression
  readonly args: ReadonlyMap<string, ComponentSemanticArgument>
  readonly bindings: UiBindings
  readonly path: UiIdentityPath
  readonly statePath: UiStateIdentityPath
}

function argumentSource(context: { readonly args: ReadonlyMap<string, ComponentSemanticArgument> }, name: string): string | undefined {
  const argument = context.args.get(name)?.sourceArgument
  return argument?.value.kind === "raw" ? argument.value.source.trim() : undefined
}

function argumentClosure(context: { readonly args: ReadonlyMap<string, ComponentSemanticArgument> }, name: string): MunClosureExpression | undefined {
  const argument = context.args.get(name)
  if (argument?.trailingClosure) return argument.trailingClosure
  return argument?.sourceArgument?.value.kind === "closure" ? argument.sourceArgument.value : undefined
}

function staticTitle(source: string | undefined, bindings: UiBindings, what: string): string {
  const value = source === undefined ? undefined : lowerValueExpression(source, bindings)
  if (value?.kind === "literal" && typeof value.value === "string") return value.value
  throw new SyntaxError(`${what} must be a string literal in native Mün: ${source}`)
}

/** `Text("literal")` as a prompt or label. */
function staticTextView(source: string, what: string): string {
  const statement = parseMunBuilder(source.trim()).statements[0]
  const argument = statement?.kind === "call" && statement.callee === "Text" && !statement.trailing && statement.arguments.length === 1
    ? statement.arguments[0]
    : undefined
  const text = argument && argument.label === undefined && argument.value.kind === "raw" ? argument.value.source.trim() : undefined
  if (text && /^"(?:[^"\\]|\\.)*"$/.test(text)) return JSON.parse(text) as string
  throw new SyntaxError(`${what} must be Text with a string literal in native Mün: ${source.trim()}`)
}

function closureLabel(closure: MunClosureExpression | undefined, what: string): string {
  if (!closure || closure.body.statements.length !== 1) throw new SyntaxError(`${what} must contain exactly one Text`)
  const statement = closure.body.statements[0]
  return staticTextView(statement.kind === "raw" || statement.kind === "call" ? closure.bodySource : "", what)
}

function horizontalAlignment(source: string | undefined): MunUiAlignment | undefined {
  if (source === undefined) return undefined
  const value = source.trim().replace(/^(?:HorizontalAlignment)?\./, "")
  if (value === "leading" || value === "center" || value === "trailing") return value
  throw new SyntaxError(`VStack alignment must be .leading, .center or .trailing: ${source}`)
}

function verticalAlignment(source: string | undefined): MunUiAlignment | undefined {
  if (source === undefined) return undefined
  const value = source.trim().replace(/^(?:VerticalAlignment)?\./, "")
  if (value === "top") return "leading"
  if (value === "bottom") return "trailing"
  if (value === "center") return "center"
  if (value === "firstTextBaseline" || value === "lastTextBaseline") {
    throw new SyntaxError(`HStack text-baseline alignment is not implemented by native Mün: ${source}`)
  }
  throw new SyntaxError(`HStack alignment must be .top, .center or .bottom: ${source}`)
}

const alignments: readonly MunUiOverlayAlignment[] = ["center", "leading", "trailing", "top", "bottom", "topLeading", "topTrailing", "bottomLeading", "bottomTrailing"]

function alignment(source: string | undefined, what: string): MunUiOverlayAlignment | undefined {
  if (source === undefined) return undefined
  const value = source.trim().replace(/^(?:Alignment)?\./, "")
  if ((alignments as readonly string[]).includes(value)) return value as MunUiOverlayAlignment
  throw new SyntaxError(`${what} must be an Alignment such as .center or .topLeading: ${source}`)
}

/** System-default metrics (global divergence `defaultMetrics`). */
const defaultStackSpacing = 8
const defaultPadding = 16

const flexibleBoth: MunUiLayout = { maxWidth: "infinity", maxHeight: "infinity" }

function shapeNode(context: NativeCallContext, shape: MunUiShapeKind, cornerRadius?: number): MunUiNode {
  return {
    kind: "panel",
    id: context.lowerer.id("panel", context.path),
    shape,
    // Shapes fill the space they are offered, like SwiftUI shapes.
    layout: flexibleBoth,
    ...(cornerRadius !== undefined ? { visual: { cornerRadius } } : {}),
  }
}

function cornerStyle(source: string | undefined): void {
  if (source === undefined) return
  const value = source.trim().replace(/^(?:RoundedCornerStyle)?\./, "")
  if (value !== "continuous" && value !== "circular") throw new SyntaxError(`Corner style must be .continuous or .circular: ${source}`)
}

/** Picker content: `Text("Label").tag(value)` rows, optionally `.disabled(true)`. */
function pickerOptions(closure: MunClosureExpression | undefined): readonly MunUiSelectionOption[] {
  if (!closure) throw new SyntaxError("Picker requires content")
  const seen = new Set<string>()
  return closure.body.statements.map((statement, index) => {
    if (statement.kind === "conditional") throw new SyntaxError(`Picker content #${index + 1} must be Text(…).tag(…); conditionals are not supported`)
    const source = statement.kind === "raw"
      ? statement.source.trim()
      : closure.bodySource.slice(statement.range.start - closure.body.range.start, statement.range.end - closure.body.range.start).trim()
    const dot = firstTopLevelModifier(source)
    const label = staticTextView(dot < 0 ? source : source.slice(0, dot), `Picker content #${index + 1}`)
    const modifiers = dot < 0 ? [] : splitViewChain(source).modifiers
    let value: MunUiScalar | undefined
    let disabled = false
    for (const modifier of modifiers) {
      const argument = modifier.arguments[0]
      const raw = argument?.value.kind === "raw" ? argument.value.source.trim() : undefined
      if (modifier.name === "tag" && modifier.arguments.length === 1 && argument.label === undefined && raw !== undefined) {
        const lowered = lowerValueExpression(raw)
        if (lowered.kind !== "literal" || (typeof lowered.value !== "string" && (typeof lowered.value !== "number" || !Number.isFinite(lowered.value)))) {
          throw new SyntaxError(`Picker tag must be a static string or number: ${raw}`)
        }
        value = lowered.value
      } else if (modifier.name === "disabled" && modifier.arguments.length === 1 && raw !== undefined) {
        if (raw !== "true" && raw !== "false") throw new SyntaxError(`Picker option .disabled(_:) must be a static Bool: ${raw}`)
        disabled = raw === "true"
      } else {
        throw new SyntaxError(`Picker content supports only .tag(_:) and .disabled(_:), found .${modifier.name}`)
      }
    }
    if (value === undefined) throw new SyntaxError(`Picker content #${index + 1} requires .tag(_:)`)
    const key = `${typeof value}:${String(value)}`
    if (seen.has(key)) throw new SyntaxError("Picker tags must be unique")
    seen.add(key)
    return { label, value, ...(disabled ? { disabled } : {}) }
  })
}

function stackChildren(context: NativeCallContext): MunUiNode[] {
  const closure = argumentClosure(context, "content")
  return closure ? context.lowerer.lowerProgram(closure.body, context.bindings, [...context.path, "content"], childIdentityPath(context.statePath, "content")) : []
}

/**
 * Native implementations of manifest View overloads, keyed `View.signature`.
 * Their keys are the compiler's implementation metadata (nativeLoweringMetadata).
 */
const nativeViews: Readonly<Record<string, (context: NativeCallContext) => MunUiNode[]>> = {
  "Text.init(_:)": context => [textNode(context, argumentSource(context, "content"))],
  "Text.init(verbatim:)": context => [textNode(context, argumentSource(context, "verbatim"))],
  "Button.init(_:action:)": context => [actionNode(context, staticTitle(argumentSource(context, "title"), context.bindings, "Button title"), argumentClosure(context, "action"))],
  "Button.init(action:label:)": context => [actionNode(context, closureLabel(argumentClosure(context, "label"), "Button label"), argumentClosure(context, "action"))],
  "TextField.init(_:text:)": context => [textFieldNode(context, staticTitle(argumentSource(context, "title"), context.bindings, "TextField title"))],
  "TextField.init(_:text:prompt:)": context => [textFieldNode(context, staticTitle(argumentSource(context, "title"), context.bindings, "TextField title"), staticTextView(argumentSource(context, "prompt") ?? "", "TextField prompt"))],
  "SecureField.init(_:text:)": context => [textFieldNode(context, staticTitle(argumentSource(context, "title"), context.bindings, "SecureField title"), undefined, true)],
  "SecureField.init(_:text:prompt:)": context => [textFieldNode(context, staticTitle(argumentSource(context, "title"), context.bindings, "SecureField title"), staticTextView(argumentSource(context, "prompt") ?? "", "SecureField prompt"), true)],
  "Toggle.init(_:isOn:)": context => [toggleNode(context, staticTitle(argumentSource(context, "title"), context.bindings, "Toggle title"))],
  "Toggle.init(isOn:label:)": context => [toggleNode(context, closureLabel(argumentClosure(context, "label"), "Toggle label"))],
  "ProgressView.init(value:total:)": context => [progressNode(context)],
  "ProgressView.init(_:value:total:)": context => [progressNode(context, staticTitle(argumentSource(context, "title"), context.bindings, "ProgressView title"))],
  "Spacer.init(minLength:)": context => {
    const minLength = numberValue(argumentSource(context, "minLength"), undefined, context.bindings)
    if (minLength !== undefined && minLength < 0) throw new SyntaxError(`Spacer minLength must not be negative: ${minLength}`)
    return [{ kind: "spacer", id: context.lowerer.id("spacer", context.path), ...(minLength !== undefined ? { minLength } : {}) }]
  },
  "Divider.init()": context => [{ kind: "divider", id: context.lowerer.id("divider", context.path) }],
  "Picker.init(_:selection:content:)": context => {
    const title = staticTitle(argumentSource(context, "title"), context.bindings, "Picker title")
    return [{
      kind: "radioGroup",
      id: context.lowerer.id("radioGroup", context.path),
      state: bindingState(argumentSource(context, "selection"), context.bindings, "Picker"),
      options: pickerOptions(argumentClosure(context, "content")),
      accessibility: { role: "radioGroup", label: title },
    }]
  },
  "VStack.init(alignment:spacing:content:)": context => {
    const spacing = numberValue(argumentSource(context, "spacing"), defaultStackSpacing, context.bindings)
    const align = horizontalAlignment(argumentSource(context, "alignment"))
    return [{ kind: "column", id: context.lowerer.id("column", context.path), layout: { spacing, ...(align ? { alignment: align } : {}) }, accessibility: { role: "group" }, children: stackChildren(context) }]
  },
  "HStack.init(alignment:spacing:content:)": context => {
    const spacing = numberValue(argumentSource(context, "spacing"), defaultStackSpacing, context.bindings)
    const align = verticalAlignment(argumentSource(context, "alignment"))
    return [{ kind: "row", id: context.lowerer.id("row", context.path), layout: { spacing, ...(align ? { alignment: align } : {}) }, accessibility: { role: "group" }, children: stackChildren(context) }]
  },
  "ZStack.init(alignment:content:)": context => {
    const align = alignment(argumentSource(context, "alignment"), "ZStack alignment")
    return [{ kind: "overlay", id: context.lowerer.id("overlay", context.path), ...(align ? { alignment: align } : {}), accessibility: { role: "group" }, children: stackChildren(context) }]
  },
  "ScrollView.init(_:content:)": context => {
    const raw = argumentSource(context, "axes")?.replace(/^(?:Axis\.Set)?\./, "")
    if (raw !== undefined && raw !== "vertical" && raw !== "horizontal") {
      throw new SyntaxError(`ScrollView axes must be .vertical or .horizontal in native Mün: ${argumentSource(context, "axes")}`)
    }
    return [{
      kind: "scroll",
      id: context.lowerer.id("scroll", context.path),
      axis: raw === "horizontal" ? "horizontal" : "vertical",
      // A ScrollView takes the space it is offered, like SwiftUI's.
      layout: flexibleBoth,
      accessibility: { role: "group" },
      children: stackChildren(context),
    }]
  },
  "ForEach.init(_:id:content:)": context => [context.lowerer.lowerForEach(context, keyPathFromSource(argumentSource(context, "id")))],
  "ForEach.init(_:content:)": context => [context.lowerer.lowerForEach(context, ["id"])],
  "Group.init(content:)": context => stackChildren(context),
  "Rectangle.init()": context => [shapeNode(context, "rectangle")],
  "RoundedRectangle.init(cornerRadius:style:)": context => {
    cornerStyle(argumentSource(context, "style"))
    const radius = numberValue(argumentSource(context, "cornerRadius"), undefined, context.bindings)
    return [shapeNode(context, "roundedRectangle", radius)]
  },
  "Circle.init()": context => [shapeNode(context, "circle")],
  "Capsule.init(style:)": context => {
    cornerStyle(argumentSource(context, "style"))
    return [shapeNode(context, "capsule")]
  },
}

function textNode(context: NativeCallContext, source: string | undefined): MunUiNode {
  if (!source) throw new SyntaxError("Text requires content")
  const value = lowerValueExpression(source, context.bindings)
  return {
    kind: "text",
    id: context.lowerer.id("text", context.path),
    value,
    accessibility: {
      role: "text",
      ...(value.kind === "literal" && typeof value.value === "string" ? { label: value.value } : {}),
    },
  }
}

function actionNode(context: NativeCallContext, label: string, closure: MunClosureExpression | undefined): MunUiNode {
  if (!closure) throw new SyntaxError("Button requires an action closure")
  return {
    kind: "action",
    id: context.lowerer.id("action", context.path),
    label,
    action: actionFromClosure(closure.bodySource, context.bindings),
    accessibility: { role: "button", label },
  }
}

function textFieldNode(context: NativeCallContext, title: string, prompt?: string, secure = false): MunUiNode {
  const placeholder = prompt ?? title
  return {
    kind: "textField",
    id: context.lowerer.id("textField", context.path),
    state: bindingState(argumentSource(context, "text"), context.bindings, secure ? "SecureField" : "TextField"),
    ...(placeholder ? { placeholder } : {}),
    ...(secure ? { secure } : {}),
    // A TextField takes the width it is offered, like SwiftUI's.
    layout: { maxWidth: "infinity" },
    accessibility: { role: "textField", ...(title ? { label: title } : {}) },
  }
}

function toggleNode(context: NativeCallContext, label: string): MunUiNode {
  return {
    kind: "toggle",
    id: context.lowerer.id("toggle", context.path),
    state: bindingState(argumentSource(context, "isOn"), context.bindings, "Toggle"),
    label,
    accessibility: { role: "checkBox", label },
  }
}

function progressNode(context: NativeCallContext, label?: string): MunUiNode {
  const total = argumentSource(context, "total")
  return {
    kind: "progress",
    id: context.lowerer.id("progress", context.path),
    value: lowerValueExpression(argumentSource(context, "value")!, context.bindings),
    ...(total !== undefined ? { total: lowerValueExpression(total, context.bindings) } : {}),
    ...(label ? { label } : {}),
    accessibility: { role: "progressIndicator", ...(label ? { label } : {}) },
  }
}

/** `Window(_:width:height:content:)` — the Mün desktop window extension. */
const windowSymbols: readonly SemanticInitializerSymbol[] = [{
  kind: "initializer",
  index: 0,
  signature: "init(_:width:height:content:)",
  parameters: [
    { kind: "value", name: "title", labelRequired: false, required: true, type: "string" },
    { kind: "value", name: "width", label: "width", labelRequired: true, required: false, type: "number" },
    { kind: "value", name: "height", label: "height", labelRequired: true, required: false, type: "number" },
    { kind: "viewBuilder", name: "content", label: "content", labelRequired: true, required: true, trailing: true },
  ],
}]

interface ModifierStep {
  readonly modifier: ModifierCall
  readonly signature: string
  readonly args: ReadonlyMap<string, ComponentSemanticArgument>
}

/**
 * Inside-out stages of Mün's native box model. A modifier applied after a
 * later-stage one wraps the View, so SwiftUI's modifier order is observable:
 * `.padding().background(c)` paints the padding, `.background(c).padding()`
 * does not.
 */
const modifierStages: Readonly<Record<string, number>> = { padding: 1, frame: 2, background: 3, cornerRadius: 4, opacity: 5, offset: 5 }

const controlKinds = new Set<MunUiNode["kind"]>(["action", "textField", "radioGroup", "toggle"])
const foregroundKinds = new Set<MunUiNode["kind"]>(["text", "panel", "action", "textField", "toggle", "progress"])

function flexibleOn(node: MunUiNode, horizontal: boolean): boolean {
  const layout = node.layout
  return horizontal
    ? layout?.width === undefined && layout?.maxWidth !== undefined
    : layout?.height === undefined && layout?.maxHeight !== undefined
}

function childrenOf(node: MunUiNode): readonly MunUiNode[] {
  switch (node.kind) {
    case "column": case "row": case "overlay": case "scroll": case "forEach": return node.children
    case "conditional": return [...node.then, ...node.otherwise]
    case "window": return [node.child]
    default: return []
  }
}

function withChildren(node: MunUiNode, map: (child: MunUiNode) => MunUiNode): MunUiNode {
  switch (node.kind) {
    case "column": case "row": case "overlay": case "scroll": case "forEach":
      return { ...node, children: node.children.map(map) } as MunUiNode
    case "conditional":
      return { ...node, then: node.then.map(map), otherwise: node.otherwise.map(map) }
    case "window":
      return { ...node, child: map(node.child) }
    default:
      return node
  }
}

/** Lexical environment values written by modifiers and inherited by descendants. */
function inheritEnvironment(node: MunUiNode, environment: { readonly disabled?: MunUiExpression; readonly foreground?: MunUiPaint }): MunUiNode {
  let current = node
  if (environment.disabled && controlKinds.has(current.kind)) {
    const enabled: MunUiExpression = { kind: "not", value: environment.disabled }
    const existing = current.accessibility?.enabled
    current = {
      ...current,
      accessibility: {
        ...(current.accessibility ?? { role: "group" }),
        enabled: existing ? { kind: "binary", operator: "and", left: existing, right: enabled } : enabled,
      },
    } as MunUiNode
  }
  if (environment.foreground && foregroundKinds.has(current.kind) && !current.visual?.foreground) {
    current = { ...current, visual: { ...current.visual, foreground: environment.foreground } } as MunUiNode
  }
  return withChildren(current, child => inheritEnvironment(child, environment))
}

/** The innermost semantic node under compiler-made wrappers. */
function semanticCore(node: MunUiNode, wrappers: ReadonlySet<MunUiNode>, update: (node: MunUiNode) => MunUiNode): MunUiNode {
  if (wrappers.has(node) && node.kind === "overlay" && node.children.length === 1) {
    return { ...node, children: [semanticCore(node.children[0], wrappers, update)] }
  }
  return update(node)
}

class NodeComposer {
  node: MunUiNode
  #stage = 0
  #wrapperCount = 0
  readonly #wrappers = new Set<MunUiNode>()
  /** Modifier index at which each dynamic property was last written on the current level. */
  #setAt = new Map<MunMotionProperty, number>()

  constructor(node: MunUiNode, private readonly animations: readonly { readonly index: number; readonly plan: MunMotionExecutionPlan; readonly trigger?: MunUiExpression }[]) {
    this.node = node
  }

  get stage(): number { return this.#stage }

  isWrapper(node = this.node): boolean { return this.#wrappers.has(node) }

  /** Begin a new layer around the current node. */
  wrap(alignment?: MunUiOverlayAlignment): void {
    const inner = this.#finalize(this.node)
    const { identityKey, transition, ...rest } = inner
    this.#wrapperCount += 1
    const wrapper: MunUiNode = {
      kind: "overlay",
      id: `${inner.id}~${this.#wrapperCount}`,
      ...(identityKey ? { identityKey } : {}),
      ...(transition ? { transition } : {}),
      ...(alignment && alignment !== "center" ? { alignment } : {}),
      children: [rest as MunUiNode],
    }
    this.#wrappers.add(wrapper)
    this.node = wrapper
    this.#stage = 0
    this.#setAt = new Map()
  }

  enter(stage: number): void {
    if (this.#stage > stage) this.wrap()
    this.#stage = Math.max(this.#stage, stage)
  }

  layout(update: MunUiLayout, index: number): void {
    this.node = { ...this.node, layout: { ...this.node.layout, ...update } } as MunUiNode
    if (update.width !== undefined) this.#setAt.set("width", index)
    if (update.height !== undefined) this.#setAt.set("height", index)
  }

  visual(update: MunUiNode["visual"] & {}, index: number): void {
    this.node = { ...this.node, visual: { ...this.node.visual, ...update } } as MunUiNode
    if (update.opacity !== undefined) this.#setAt.set("opacity", index)
    if (update.translationX !== undefined) this.#setAt.set("translationX", index)
    if (update.translationY !== undefined) this.#setAt.set("translationY", index)
  }

  /** Apply to the innermost semantic node (labels, enabled state). */
  semantic(update: (node: MunUiNode) => MunUiNode): void {
    this.node = semanticCore(this.node, this.#wrappers, update)
  }

  meta(update: Partial<Pick<MunUiNode, "identityKey" | "transition" | "lifecycle">>): void {
    this.node = { ...this.node, ...update } as MunUiNode
  }

  /** Rewrite the current node in place (environment inheritance). */
  transform(update: (node: MunUiNode) => MunUiNode): void {
    const wrapper = this.#wrappers.has(this.node)
    this.node = update(this.node)
    if (wrapper) this.#wrappers.add(this.node)
  }

  /** Replace the current node with a new outer layer built from `finish()`. */
  layer(node: MunUiNode): void {
    this.node = node
    this.#wrappers.add(node)
    this.#stage = 0
    this.#setAt = new Map()
  }

  finish(): MunUiNode {
    return this.#finalize(this.node)
  }

  #finalize(node: MunUiNode): MunUiNode {
    const motion: Array<NonNullable<MunUiNode["motion"]>[number]> = [...(node.motion ?? [])]
    const candidates: readonly [MunMotionProperty, MunUiExpression | undefined][] = [
      ["width", node.layout?.width],
      ["height", node.layout?.height],
      ["opacity", node.visual?.opacity],
      ["translationX", node.visual?.translationX],
      ["translationY", node.visual?.translationY],
    ]
    for (const [property, value] of candidates) {
      if (!expressionIsDynamic(value) || motion.some(binding => binding.property === property)) continue
      // The innermost `.animation(_:value:)` after the write animates it.
      const writtenAt = this.#setAt.get(property) ?? -1
      const animation = this.animations.find(candidate => candidate.index > writtenAt)
      motion.push({
        property,
        propertyMask: munMotionPropertyBit(property),
        value,
        ...(animation?.trigger ? { trigger: animation.trigger } : {}),
        ...(animation ? { plan: animation.plan } : {}),
      })
    }
    return motion.length > 0 ? { ...node, motion } as MunUiNode : node
  }
}

function frameBound(source: string | undefined, label: string, bindings: UiBindings, allowInfinity: boolean): number | "infinity" | undefined {
  if (source === undefined) return undefined
  if (/^(?:\.infinity|CGFloat\.infinity|Double\.infinity)$/.test(source)) {
    if (!allowInfinity) throw new SyntaxError(`.frame(${label}:) must be finite`)
    return "infinity"
  }
  const value = numberValue(source, undefined, bindings)
  if (value === undefined || value < 0) throw new SyntaxError(`.frame(${label}:) must be a static non-negative number${allowInfinity ? " or .infinity" : ""}: ${source}`)
  return value
}

function edgeInsets(edges: string | undefined, length: number): MunUiLayout["padding"] {
  if (edges === undefined) return length
  const sets: Readonly<Record<string, readonly ("top" | "leading" | "bottom" | "trailing")[]>> = {
    all: ["top", "leading", "bottom", "trailing"],
    horizontal: ["leading", "trailing"],
    vertical: ["top", "bottom"],
    top: ["top"], bottom: ["bottom"], leading: ["leading"], trailing: ["trailing"],
  }
  const names = edges.trim().startsWith("[")
    ? splitTopLevel(edges.trim().slice(1, -1)).map(item => item.trim())
    : [edges.trim()]
  const chosen = new Set<string>()
  for (const name of names) {
    const edge = sets[name.replace(/^(?:Edge\.Set)?\./, "")]
    if (!edge) throw new SyntaxError(`padding edges must be Edge.Set members such as .horizontal or [.top, .leading]: ${edges}`)
    for (const item of edge) chosen.add(item)
  }
  if (chosen.size === 4) return length
  return {
    top: chosen.has("top") ? length : 0,
    leading: chosen.has("leading") ? length : 0,
    bottom: chosen.has("bottom") ? length : 0,
    trailing: chosen.has("trailing") ? length : 0,
  }
}

function addPadding(existing: MunUiLayout["padding"], added: MunUiLayout["padding"]): MunUiLayout["padding"] {
  if (existing === undefined) return added
  const edges = (value: MunUiLayout["padding"]) => typeof value === "number" || value === undefined
    ? { top: value ?? 0, leading: value ?? 0, bottom: value ?? 0, trailing: value ?? 0 }
    : value
  const left = edges(existing)
  const right = edges(added)
  const sum = { top: left.top + right.top, leading: left.leading + right.leading, bottom: left.bottom + right.bottom, trailing: left.trailing + right.trailing }
  return sum.top === sum.leading && sum.top === sum.bottom && sum.top === sum.trailing ? sum.top : sum
}

interface NativeModifierContext {
  readonly lowerer: UiLowerer
  readonly composer: NodeComposer
  readonly args: ReadonlyMap<string, ComponentSemanticArgument>
  readonly bindings: UiBindings
  readonly index: number
  readonly modifier: ModifierCall
  readonly path: UiIdentityPath
}

const isContainer = (node: MunUiNode): boolean => node.kind === "column" || node.kind === "row" || node.kind === "overlay" || node.kind === "scroll"

function applyFrame(context: NativeModifierContext, update: MunUiLayout, align: MunUiOverlayAlignment | undefined): void {
  const { composer } = context
  const horizontal = update.width !== undefined || update.minWidth !== undefined || update.maxWidth !== undefined
  const vertical = update.height !== undefined || update.minHeight !== undefined || update.maxHeight !== undefined
  const node = composer.node
  const occupied = (axis: "width" | "height") => axis === "width"
    ? node.layout?.width !== undefined || node.layout?.minWidth !== undefined || (node.layout?.maxWidth !== undefined && !flexibleOn(node, true))
    : node.layout?.height !== undefined || node.layout?.minHeight !== undefined || (node.layout?.maxHeight !== undefined && !flexibleOn(node, false))
  // A frame merges into the View only where the result is identical: a
  // shape or color fills any frame; a View already flexible on an axis fills
  // it; a compiler wrapper is itself a frame. Everything else is wrapped so
  // the View is placed inside the frame by `alignment` (default .center).
  const fills = node.kind === "panel"
    || composer.isWrapper()
    || ((!horizontal || flexibleOn(node, true)) && (!vertical || flexibleOn(node, false)))
  const merge = fills
    && composer.stage <= 2
    && !(horizontal && occupied("width"))
    && !(vertical && occupied("height"))
    && (align === undefined || align === "center" || composer.isWrapper())
  if (!merge) composer.wrap(align)
  else if (align && align !== "center" && node.kind === "overlay" && composer.isWrapper()) {
    composer.transform(current => ({ ...current, alignment: align }) as MunUiNode)
  }
  composer.enter(2)
  composer.layout(update, context.index)
}

/**
 * Native implementations of manifest modifier overloads, keyed by signature.
 * Their keys are the compiler's implementation metadata (nativeLoweringMetadata).
 */
const nativeModifiers: Readonly<Record<string, (context: NativeModifierContext) => void>> = {
  "frame(width:height:alignment:)": context => {
    const width = argumentSource(context, "width")
    const height = argumentSource(context, "height")
    const update: { width?: MunUiExpression; height?: MunUiExpression } = {}
    if (width !== undefined) update.width = lowerValueExpression(width, context.bindings)
    if (height !== undefined) update.height = lowerValueExpression(height, context.bindings)
    applyFrame(context, update, alignment(argumentSource(context, "alignment"), "frame alignment"))
  },
  "frame(minWidth:idealWidth:maxWidth:minHeight:idealHeight:maxHeight:alignment:)": context => {
    for (const ideal of ["idealWidth", "idealHeight"]) {
      if (context.args.has(ideal)) throw new SyntaxError(`.frame(${ideal}:) is not implemented in native Mün: layout has no ideal-size proposal. Use width/height or min/max bounds.`)
    }
    const update: { minWidth?: number; maxWidth?: number | "infinity"; minHeight?: number; maxHeight?: number | "infinity" } = {}
    const minWidth = frameBound(argumentSource(context, "minWidth"), "minWidth", context.bindings, false)
    const maxWidth = frameBound(argumentSource(context, "maxWidth"), "maxWidth", context.bindings, true)
    const minHeight = frameBound(argumentSource(context, "minHeight"), "minHeight", context.bindings, false)
    const maxHeight = frameBound(argumentSource(context, "maxHeight"), "maxHeight", context.bindings, true)
    if (typeof minWidth === "number") update.minWidth = minWidth
    if (maxWidth !== undefined) update.maxWidth = maxWidth
    if (typeof minHeight === "number") update.minHeight = minHeight
    if (maxHeight !== undefined) update.maxHeight = maxHeight
    applyFrame(context, update, alignment(argumentSource(context, "alignment"), "frame alignment"))
  },
  "padding(_:)": context => padding(context, undefined, numberValue(argumentSource(context, "length"), undefined, context.bindings) ?? defaultPadding),
  "padding(_:_:)": context => padding(context, argumentSource(context, "edges"), numberValue(argumentSource(context, "length"), defaultPadding, context.bindings) ?? defaultPadding),
  "background(_:ignoresSafeAreaEdges:)": context => {
    const edges = argumentSource(context, "ignoresSafeAreaEdges")?.replace(/^(?:Edge\.Set)?\./, "")
    if (edges !== undefined && edges !== "all") throw new SyntaxError(`.background(_:ignoresSafeAreaEdges:) accepts only .all in native Mün (windows have no safe-area insets): ${argumentSource(context, "ignoresSafeAreaEdges")}`)
    const paint = lowerPaint(argumentSource(context, "style")!)
    // Text and containers paint their own box; anything else (shapes,
    // controls) gets the background as a separate layer behind it.
    const node = context.composer.node
    if (node.visual?.background || !(node.kind === "text" || isContainer(node))) context.composer.wrap()
    context.composer.enter(3)
    context.composer.visual({ background: paint }, context.index)
  },
  "background(alignment:content:)": context => layered(context, "background"),
  "overlay(alignment:content:)": context => layered(context, "overlay"),
  "foregroundStyle(_:)": context => {
    const foreground = lowerPaint(argumentSource(context, "style")!)
    context.composer.transform(node => inheritEnvironment(node, { foreground }))
  },
  "fill(_:style:)": context => {
    if (context.composer.node.kind !== "panel") throw new SyntaxError(".fill(_:style:) applies to a Shape")
    if (context.args.has("style")) throw new SyntaxError(".fill(_:style:) with a FillStyle is not implemented in native Mün")
    const foreground = lowerPaint(argumentSource(context, "content")!)
    context.composer.visual({ foreground }, context.index)
  },
  "cornerRadius(_:antialiased:)": context => {
    context.composer.enter(4)
    context.composer.visual({ cornerRadius: numberValue(argumentSource(context, "radius"), 0, context.bindings) }, context.index)
  },
  "opacity(_:)": context => {
    if (context.composer.node.visual?.opacity !== undefined) context.composer.wrap()
    context.composer.enter(5)
    context.composer.visual({ opacity: lowerValueExpression(argumentSource(context, "opacity")!, context.bindings) }, context.index)
  },
  "offset(x:y:)": context => {
    if (context.composer.node.visual?.translationX !== undefined) context.composer.wrap()
    context.composer.enter(5)
    const x = argumentSource(context, "x")
    const y = argumentSource(context, "y")
    context.composer.visual({
      translationX: x ? lowerValueExpression(x, context.bindings) : literal(0),
      translationY: y ? lowerValueExpression(y, context.bindings) : literal(0),
    }, context.index)
  },
  "onAppear(perform:)": context => lifecycle(context, "appear"),
  "onDisappear(perform:)": context => lifecycle(context, "disappear"),
  "transition(_:)": context => context.composer.meta({ transition: lowerTransition(argumentSource(context, "transition")!) }),
  // Resolved up front; it annotates the motion of what precedes it.
  "animation(_:value:)": () => {},
  "id(_:)": context => context.composer.meta({ identityKey: semanticIdentityKey(argumentSource(context, "id"), context.bindings) }),
  "disabled(_:)": context => {
    const disabled = lowerValueExpression(argumentSource(context, "disabled")!, context.bindings)
    context.composer.transform(node => inheritEnvironment(node, { disabled }))
  },
  "accessibilityLabel(_:)": context => {
    const label = staticTitle(argumentSource(context, "label"), context.bindings, "accessibilityLabel")
    context.composer.semantic(node => ({ ...node, accessibility: { ...(node.accessibility ?? { role: "group" }), label } }) as MunUiNode)
  },
  "pickerStyle(_:)": context => {
    const style = argumentSource(context, "style")?.replace(/^\./, "")
    if (context.composer.node.kind !== "radioGroup") throw new SyntaxError(".pickerStyle(_:) applies to a Picker")
    if (style !== "radioGroup" && style !== "RadioGroupPickerStyle()") {
      throw new SyntaxError(`Native Mün renders Picker as a radio group; .pickerStyle(.${style}) is not implemented. Use .pickerStyle(.radioGroup).`)
    }
  },
  "tag(_:includeOptional:)": () => {
    throw new SyntaxError(".tag(_:) is only meaningful on Picker content rows in native Mün")
  },
}

/**
 * `.onAppear` / `.onDisappear`: run when the View becomes / stops being
 * semantically present. Repeated modifiers all run, in source order.
 */
function lifecycle(context: NativeModifierContext, phase: "appear" | "disappear"): void {
  const closure = argumentClosure(context, "perform")
  if (!closure) return
  const action = actionFromClosure(closure.bodySource, context.bindings)
  const existing = context.composer.node.lifecycle
  const previous = existing?.[phase]
  const combined: MunUiAction = previous ? { kind: "sequence", actions: [previous, action] } : action
  context.composer.meta({ lifecycle: { ...existing, [phase]: combined } })
}

function padding(context: NativeModifierContext, edges: string | undefined, length: number): void {
  const { composer } = context
  const insets = edgeInsets(edges, length)
  // Containers inset their children; a leaf draws at its own origin, so its
  // padding is a wrapper.
  if (!isContainer(composer.node) || composer.stage > 1) composer.wrap()
  composer.enter(1)
  composer.layout({ padding: addPadding(composer.node.layout?.padding, insets) }, context.index)
}

function layered(context: NativeModifierContext, layer: "background" | "overlay"): void {
  const closure = argumentClosure(context, "content")
  const align = alignment(argumentSource(context, "alignment"), `${layer} alignment`)
  const base = context.composer.finish()
  const content = closure
    ? context.lowerer.lowerProgram(closure.body, context.bindings, [...context.path, "modifier", context.index, layer], null)
    : []
  const layerNode: MunUiNode = content.length === 1
    ? content[0]
    : { kind: "overlay", id: context.lowerer.id(`${layer}Content`, [...context.path, "modifier", context.index]), children: content }
  const { identityKey, transition, ...inner } = base
  const node: MunUiNode = {
    kind: "overlay",
    id: context.lowerer.id(layer, [...context.path, "modifier", context.index]),
    ...(identityKey ? { identityKey } : {}),
    ...(transition ? { transition } : {}),
    ...(align && align !== "center" ? { alignment: align } : {}),
    children: layer === "background" ? [layerNode, inner as MunUiNode] : [inner as MunUiNode, layerNode],
  }
  context.composer.layer(node)
}

function semanticIdentityKey(source: string | undefined, bindings: UiBindings): MunUiExpression {
  if (!source) throw new SyntaxError("id requires a semantic identity value")
  const identityKey = lowerValueExpression(source, bindings)
  if (
    identityKey.kind === "literal"
    && (
      (typeof identityKey.value !== "string" && typeof identityKey.value !== "number")
      || (typeof identityKey.value === "number" && !Number.isFinite(identityKey.value))
    )
  ) {
    throw new SyntaxError("Mün semantic identity keys must resolve to a string or finite number")
  }
  return identityKey
}

function idModifierSource(modifier: ModifierCall): string | undefined {
  const argument = modifier.arguments[0]
  return argument?.value.kind === "raw" ? argument.value.source.trim() : undefined
}

function unsupportedModifier(name: string): string {
  const spec = swiftUIApiManifest.modifiers.find(modifier => modifier.name === name)
  if (spec && spec.signatures.length > 0) {
    return `View modifier .${spec.signatures.map(signature => signature.signature).join(" / .")} is a SwiftUI modifier implemented only by the compatibility Web graph; native Semantic UI IR does not support it`
  }
  const extension = munExtension("modifier", name)
  if (extension) return `.${extension.signatures[0]} is a compatibility-only Mün spelling.${extension.replacement ? ` Use ${extension.replacement}.` : ""}`
  if (spec) return `.${name}(…) is a compatibility-only Mün modifier, not SwiftUI; canonical .mun does not accept it`
  const unsupported = swiftUIApiManifest.unsupported.modifiers.find(item => item.name === name)
  if (unsupported) return `.${name}(…) is a SwiftUI modifier Mün does not implement yet: ${unsupported.reason}`
  return `.${name}(…) is not a SwiftUI View modifier known to Mün`
}

function unsupportedView(name: string): string | undefined {
  const spec = (swiftUIApiManifest.views as Readonly<Record<string, SwiftUIViewSpec>>)[name]
  if (spec) return `SwiftUI View '${name}' is implemented only by the compatibility Web graph; native Semantic UI IR does not support it`
  const extension = munExtension("view", name)
  if (extension?.status === "compatibility") return `'${name}' is a compatibility-only Mün View.${extension.replacement ? ` Use ${extension.replacement}.` : ""}`
  const unsupported = swiftUIApiManifest.unsupported.views.find(item => item.name === name)
  if (unsupported) return `SwiftUI View '${name}' is not implemented by Mün yet: ${unsupported.reason}`
  return undefined
}

/** The compiler's native implementation inventory, checked against the parity manifest. */
export function nativeLoweringMetadata(): {
  readonly views: readonly string[]
  readonly modifiers: readonly string[]
  readonly values: readonly string[]
  readonly extensions: readonly string[]
} {
  return {
    views: Object.keys(nativeViews).sort(),
    modifiers: Object.keys(nativeModifiers).sort(),
    values: nativeValueImplementations(),
    extensions: ["Window.init(_:width:height:content:)", "Color.init(_:)"],
  }
}

class UiLowerer {
  readonly #structs: ReadonlyMap<string, MunStructDeclaration>
  readonly #qualifiedNameByDeclaration: ReadonlyMap<MunStructDeclaration, string>
  readonly #semanticViews = new Map<string, MunSemanticView>()
  readonly #componentStack: string[] = []
  readonly #states: MunUiState[]
  readonly #stateTypes: Map<string, string>
  /** Enclosing ForEach templates; View-local state inside them is item-scoped. */
  readonly #forEachScopes: string[] = []
  /** Key path per collection state, recorded by the ForEach that renders it. */
  readonly #collectionKeyPaths = new Map<string, readonly string[]>()

  constructor(structs: readonly MunStructDeclaration[], states: readonly MunUiState[]) {
    const declarationIndex = collectStructDeclarations(structs)
    this.#structs = declarationIndex.byQualifiedName
    this.#qualifiedNameByDeclaration = declarationIndex.qualifiedNameByDeclaration
    this.#states = [...states]
    this.#stateTypes = stateTypeMap(states)
    for (const view of semanticViewsForStructs(structs)) this.#semanticViews.set(view.qualifiedName, view)
  }

  resolveComponent(name: string): { declaration: MunStructDeclaration; semanticView: MunSemanticView } | undefined {
    const scope = this.#componentStack.at(-1)
    for (const candidate of semanticViewLookupCandidates(name, scope)) {
      const declaration = this.#structs.get(candidate)
      const semanticView = this.#semanticViews.get(candidate)
      if (declaration && semanticView) return { declaration, semanticView }
    }
    return undefined
  }

  qualifiedName(declaration: MunStructDeclaration): string {
    const qualifiedName = this.#qualifiedNameByDeclaration.get(declaration)
    if (!qualifiedName) throw new SyntaxError(`Native View '${declaration.name}' has no qualified semantic identity`)
    return qualifiedName
  }

  states(): readonly MunUiState[] {
    return this.#states
  }

  collectionKeyPath(state: string): readonly string[] {
    return this.#collectionKeyPaths.get(state) ?? ["id"]
  }

  lowerForEach(context: NativeCallContext, keyPath: readonly string[]): MunUiNode {
    const collectionSource = argumentSource(context, "data")
    if (!collectionSource) throw new SyntaxError("ForEach requires a collection")
    const closure = argumentClosure(context, "content")
    if (!closure?.parameter) {
      throw new SyntaxError("ForEach requires a content closure with an item parameter: ForEach(items, id: \\.id) { item in ... }")
    }
    const { bindings, path, statePath } = context
    const id = this.id("forEach", path)
    const collection = lowerValueExpression(collectionSource, bindings)
    let source: MunUiExpression = collection
    while (source.kind === "filter") source = source.collection
    if (source.kind === "state") {
      const existing = this.#collectionKeyPaths.get(source.state)
      if (existing && existing.join(".") !== keyPath.join(".")) {
        throw new SyntaxError(`Collection '${source.state}' is rendered with conflicting ForEach id key paths`)
      }
      this.#collectionKeyPaths.set(source.state, keyPath)
    } else if (source.kind !== "item") {
      throw new SyntaxError(`ForEach collection must be @State, an item field, or a filter of one: ${collectionSource}`)
    }
    const itemBindings = new Map(bindings)
    itemBindings.set(closure.parameter, { kind: "item", forEach: id, path: [] })
    // Template identities are static; the runtime composes each instance with
    // its item key. Item-scoped View state therefore keeps a static template
    // path here and is instantiated per key by the runtime.
    this.#forEachScopes.push(id)
    try {
      return {
        kind: "forEach",
        id,
        collection,
        keyPath,
        children: this.lowerProgram(
          closure.body,
          itemBindings,
          [...path, "each"],
          statePath ? [...statePath, "each"] : [...path, "each"],
        ),
      }
    } finally {
      this.#forEachScopes.pop()
    }
  }

  id(prefix: string, path: UiIdentityPath): string {
    return `@node/${identityPathKey([...path, "kind", prefix])}`
  }

  bindLocalStates(
    declaration: MunStructDeclaration,
    bindings: Map<string, MunUiExpression>,
    instancePath: UiStateIdentityPath,
  ): void {
    const fields = declaration.fields.filter(field => field.kind === "state")
    if (fields.length === 0) return
    if (!instancePath) {
      throw new SyntaxError(
        `Stateful native View '${declaration.name}' cannot use a dynamic .id(_:) identity until runtime-owned state scopes are available`,
      )
    }

    const instanceId = identityPathKey(instancePath)
    for (const field of fields) {
      if (field.initializer === undefined) {
        throw new SyntaxError(
          `Native @State member '${declaration.name}.${field.name}' requires an initial value`,
        )
      }
      assertWellFormedValueSource(field.initializer, `Native @State member '${declaration.name}.${field.name}'`)
      const initial = lowerValueExpression(field.initializer, bindings)
      if (initial.kind !== "literal") {
        throw new SyntaxError(
          `Native @State member '${declaration.name}.${field.name}' requires a scalar initial value for now`,
        )
      }
      if (field.type) {
        const declared = parseMunType(field.type, { canonical: false, what: `${declaration.name}.${field.name}` })
        if (!valueMatchesType(initial.value, declared)) {
          throw new SyntaxError(
            `@State '${declaration.name}.${field.name}' is declared ${displayMunType(declared)} but its initial value is ${describeValueType(initial.value)}`,
          )
        }
      }
      const stateName = `@component/${instanceId}/${field.name}`
      const scope = this.#forEachScopes.at(-1)
      this.#states.push({ name: stateName, initial: initial.value, ...(scope ? { scope } : {}) })
      this.#stateTypes.set(
        stateName,
        initial.value === null ? "null" : Array.isArray(initial.value) ? "array" : typeof initial.value,
      )
      bindings.set(field.name, { kind: "state", state: stateName })
    }
  }

  lowerEntry(declaration: MunStructDeclaration): MunUiNode {
    const bindings = new Map<string, MunUiExpression>()
    for (const field of declaration.fields) {
      if (field.kind === "binding") {
        throw new SyntaxError(
          `Native entry View '${declaration.name}' member '${field.name}' uses @Binding without an owning parent`,
        )
      }
      if (field.kind === "stored") {
        if (field.initializer === undefined) {
          throw new SyntaxError(
            `Native entry View '${declaration.name}' stored member '${field.name}' requires a default value`,
          )
        }
        bindings.set(field.name, lowerValueExpression(field.initializer, bindings))
      }
    }
    const qualifiedName = this.qualifiedName(declaration)
    const instancePath: UiIdentityPath = ["entry", qualifiedName]
    this.bindLocalStates(declaration, bindings, instancePath)
    this.#componentStack.push(qualifiedName)
    try {
      return this.lowerBody(declaration, bindings, [...instancePath, "body"])
    } finally {
      this.#componentStack.pop()
    }
  }

  lowerBody(declaration: MunStructDeclaration, bindings: UiBindings, path: UiIdentityPath, statePath: UiStateIdentityPath = path): MunUiNode {
    const program = parseMunBuilder(declaration.bodyExpressionSource, declaration.bodyExpressionRange.start)
    const nodes = this.lowerProgram(program, bindings, path, statePath)
    if (nodes.length !== 1) {
      throw new SyntaxError(`Native custom View '${declaration.name}' body produces ${nodes.length} root views; wrap them in a VStack, HStack or ZStack`)
    }
    return nodes[0]
  }

  lowerNodes(
    node: MunBuilderNode,
    bindings: UiBindings,
    path: UiIdentityPath,
    statePath: UiStateIdentityPath = path,
  ): MunUiNode[] {
    if (node.kind === "raw") {
      const color = colorViewChain(node.source)
      const chain = color ?? splitViewChain(node.source)
      if (chain.base.kind === "raw" && !color) {
        throw new SyntaxError(`Unsupported native view expression: ${chain.base.source}`)
      }
      const scopedPath = nodeIdentityPathForModifiers(path, chain.modifiers, bindings)
      const scopedStatePath = stateIdentityPathForModifiers(statePath, chain.modifiers, bindings)
      const bases = color
        ? [colorView(this, color.colorSource, scopedPath)]
        : this.lowerNodes(chain.base, bindings, scopedPath, scopedStatePath)
      // Modifiers on a Group apply to each of its Views, as in SwiftUI.
      return bases.map((base, index) => this.applyModifiers(base, chain.modifiers, bindings, bases.length > 1 ? [...scopedPath, "group", index] : scopedPath))
    }
    if (node.kind === "conditional") return [this.lowerConditional(node, bindings, path, statePath)]
    return this.lowerCall(node, bindings, path, statePath)
  }

  lower(
    node: MunBuilderNode,
    bindings: UiBindings = emptyBindings,
    path: UiIdentityPath,
    statePath: UiStateIdentityPath = path,
  ): MunUiNode {
    const nodes = this.lowerNodes(node, bindings, path, statePath)
    if (nodes.length !== 1) throw new SyntaxError("Expected exactly one View here; a Group expands to several")
    return nodes[0]
  }

  lowerProgram(
    program: MunBuilderProgram,
    bindings: UiBindings,
    path: UiIdentityPath,
    statePath: UiStateIdentityPath = path,
  ): MunUiNode[] {
    return program.statements.flatMap((statement, index) =>
      this.lowerNodes(
        statement,
        bindings,
        [...path, "child", index],
        childIdentityPath(statePath, "child", index),
      )
    )
  }

  lowerConditional(
    node: MunConditionalExpression,
    bindings: UiBindings,
    path: UiIdentityPath,
    statePath: UiStateIdentityPath,
  ): MunUiNode {
    const otherwise = node.otherwise
    return {
      kind: "conditional",
      id: this.id("conditional", path),
      condition: lowerValueExpression(node.condition.source, bindings),
      then: this.lowerProgram(
        node.then,
        bindings,
        [...path, "then"],
        childIdentityPath(statePath, "then"),
      ),
      otherwise: !otherwise
        ? []
        : otherwise.kind === "program"
          ? this.lowerProgram(
              otherwise,
              bindings,
              [...path, "otherwise"],
              childIdentityPath(statePath, "otherwise"),
            )
          : [this.lowerConditional(
              otherwise,
              bindings,
              [...path, "otherwise"],
              childIdentityPath(statePath, "otherwise"),
            )],
    }
  }

  applyModifiers(node: MunUiNode, modifiers: readonly ModifierCall[], bindings: UiBindings, path: UiIdentityPath): MunUiNode {
    if (modifiers.length === 0) return node
    const steps: ModifierStep[] = modifiers.map(modifier => {
      const symbols = nativeModifierSymbols(modifier.name)
      if (!symbols) throw new SyntaxError(unsupportedModifier(modifier.name))
      const supplied: ComponentSemanticArgument[] = modifier.arguments.map(argument => componentSemanticArgument(argument, bindings, this.#stateTypes))
      if (modifier.trailing) supplied.push({ type: "function", trailing: true, trailingClosure: modifier.trailing })
      const resolution = resolveContractCall(symbols, supplied, { kind: "modifier", owner: modifier.name, unsupported: swiftUIUnsupportedModifierSignatures(modifier.name) })
      if (!nativeModifiers[resolution.signature]) throw new SyntaxError(`Internal error: no native implementation for .${resolution.signature}`)
      return { modifier, signature: resolution.signature, args: resolution.arguments }
    })
    const animations = steps.flatMap((step, index) => {
      if (step.signature !== "animation(_:value:)") return []
      const plan = animationPlan(argumentSource(step, "animation")!)
      const trigger = argumentSource(step, "value")
      return [{ index, plan, ...(trigger ? { trigger: lowerValueExpression(trigger, bindings) } : {}) }]
    })
    const composer = new NodeComposer(node, animations)
    steps.forEach((step, index) => {
      nativeModifiers[step.signature]({ lowerer: this, composer, args: step.args, bindings, index, modifier: step.modifier, path })
    })
    return composer.finish()
  }

  lowerComponent(
    call: MunCallExpression,
    declaration: MunStructDeclaration,
    semanticView: MunSemanticView,
    callerBindings: UiBindings,
    path: UiIdentityPath,
    statePath: UiStateIdentityPath,
  ): MunUiNode {
    const qualifiedName = semanticView.qualifiedName
    if (this.#componentStack.includes(qualifiedName)) {
      throw new SyntaxError(
        `Recursive native View expansion is not supported: ${[...this.#componentStack, qualifiedName].join(" -> ")}`,
      )
    }

    const supplied: ComponentSemanticArgument[] = call.arguments.map(argument =>
      componentSemanticArgument(argument, callerBindings, this.#stateTypes)
    )
    if (call.trailing) {
      supplied.push({
        type: "function",
        trailing: true,
        trailingBodySource: call.trailing.bodySource,
      })
    }

    const result = resolveSemanticInitializer(
      semanticView.symbol.initializers,
      supplied,
      semanticView.genericParameters,
    )
    if (!result.ok) {
      const hidden = call.arguments.find(argument => argument.label !== undefined && declaration.fields.some(field =>
        field.name === argument.label && (field.access === "private" || field.access === "fileprivate" || field.kind === "state")))
      if (hidden?.label) {
        const field = declaration.fields.find(item => item.name === hidden.label)!
        throw new SyntaxError(field.kind === "state"
          ? `'${declaration.name}.${hidden.label}' is @State, owned by the View; a caller cannot initialize it (pass a @Binding instead)`
          : `'${declaration.name}.${hidden.label}' is ${field.access}; a caller cannot initialize it`)
      }
      const candidates = result.failure.candidates.map(candidate => candidate.signature).join("; ")
      const prefix = result.failure.kind === "ambiguous"
        ? "Ambiguous initializer"
        : "No matching initializer"
      throw new SyntaxError(
        `${prefix} for native View '${declaration.name}'.${candidates ? ` Available initializers: ${candidates}.` : ""}`,
      )
    }

    const selected = semanticView.initializers[result.resolution.initializerIndex]
    if (!selected) {
      throw new SyntaxError(`Native View '${declaration.name}' resolved an unknown initializer`)
    }


    const fieldBindings = new Map<string, MunUiExpression>()
    if (selected.synthesized === "memberwise") {
      for (let index = 0; index < selected.parameters.length; index += 1) {
        const parameter = selected.parameters[index]
        const field = declaration.fields.find(candidate => candidate.name === parameter.name)
        if (!field) continue

        const normalized = result.resolution.arguments[index] as ComponentSemanticArgument | undefined
        const sourceArgument = normalized?.sourceArgument
        if (field.kind === "binding" && sourceArgument?.value.kind === "raw") {
          const binding = bindingStateExpression(sourceArgument.value.source, callerBindings)
          const actualType = this.#stateTypes.get(binding.state)
          if (!actualType) {
            throw new SyntaxError(
              `Native @Binding '${declaration.name}.${field.name}' does not reference known state '${binding.state}'`,
            )
          }
          const expectedType = field.type?.trim()
          if (expectedType && !bindingTypeMatches(expectedType, actualType)) {
            throw new SyntaxError(
              `Native @Binding '${declaration.name}.${field.name}' expects ${expectedType} state, received ${swiftTypeName(actualType)}`,
            )
          }
          fieldBindings.set(field.name, binding)
          continue
        }
        if (sourceArgument?.value.kind === "raw") {
          fieldBindings.set(field.name, lowerValueExpression(sourceArgument.value.source, callerBindings))
          continue
        }
        if (field.initializer !== undefined) {
          fieldBindings.set(field.name, lowerValueExpression(field.initializer, fieldBindings))
          continue
        }
        throw new SyntaxError(
          `Initializer ${selected.signature} did not bind required field '${field.name}'`,
        )
      }
      // Private stored members are not parameters; they keep their defaults.
      for (const field of declaration.fields) {
        if (field.kind === "stored" && !fieldBindings.has(field.name) && field.initializer !== undefined) {
          fieldBindings.set(field.name, lowerValueExpression(field.initializer, fieldBindings))
        }
      }
    } else {
      const initializer = declaration.initializers[selected.index]
      if (!initializer) {
        throw new SyntaxError(`Native View '${declaration.name}' resolved an unknown explicit initializer`)
      }
      const parameterBindings = new Map<string, MunUiExpression>()
      const defaults = initializerDefaultSources(initializer.parametersSource, selected.parameters)
      for (let index = 0; index < selected.parameters.length; index += 1) {
        const parameter = selected.parameters[index]
        const name = parameter.name
        if (!name) throw new SyntaxError(`Native initializer ${selected.signature} has an unnamed parameter`)
        const normalized = result.resolution.arguments[index] as ComponentSemanticArgument | undefined
        const sourceArgument = normalized?.sourceArgument
        const source = sourceArgument?.value.kind === "raw"
          ? sourceArgument.value.source
          : defaults.get(name)
        if (!source) {
          throw new SyntaxError(`Native initializer ${selected.signature} could not resolve parameter '${name}'`)
        }
        if (parameter.kind === "binding") {
          const binding = bindingStateExpression(source, callerBindings)
          const actualType = this.#stateTypes.get(binding.state)
          if (!actualType) {
            throw new SyntaxError(`Native initializer binding '${name}' does not reference known state '${binding.state}'`)
          }
          const expectedType = parameter.type?.trim()
          if (expectedType && !bindingTypeMatches(expectedType, actualType)) {
            throw new SyntaxError(
              `Native initializer binding '${name}' expects ${expectedType} state, received ${actualType}`,
            )
          }
          parameterBindings.set(name, binding)
        } else {
          const scope = new Map<string, MunUiExpression>([...callerBindings, ...parameterBindings])
          parameterBindings.set(name, lowerValueExpression(source, scope))
        }
      }

      const initializerScope = new Map<string, MunUiExpression>([...callerBindings, ...parameterBindings])
      for (const [fieldName, expression] of explicitInitializerAssignments(initializer.bodySource)) {
        const field = declaration.fields.find(candidate => candidate.name === fieldName)
        if (!field) {
          throw new SyntaxError(`Native initializer ${selected.signature} assigns unknown field '${fieldName}'`)
        }
        if (field.kind === "state") {
          throw new SyntaxError(`Native initializer ${selected.signature} cannot replace @State storage '${fieldName}'`)
        }
        const value = lowerValueExpression(expression, initializerScope)
        if (field.kind === "binding" && value.kind !== "state") {
          throw new SyntaxError(`Native initializer ${selected.signature} must bind @Binding field '${fieldName}' to state`)
        }
        fieldBindings.set(fieldName, value)
      }

      for (const field of declaration.fields) {
        if (field.kind === "state" || fieldBindings.has(field.name)) continue
        const parameterValue = parameterBindings.get(field.name)
        if (parameterValue) {
          fieldBindings.set(field.name, parameterValue)
          continue
        }
        if (field.initializer !== undefined) {
          const scope = new Map<string, MunUiExpression>([...parameterBindings, ...fieldBindings])
          fieldBindings.set(field.name, lowerValueExpression(field.initializer, scope))
          continue
        }
        throw new SyntaxError(
          `Initializer ${selected.signature} did not initialize field '${field.name}'`,
        )
      }
    }
    const instancePath = childIdentityPath(statePath, "component", qualifiedName)
    this.bindLocalStates(declaration, fieldBindings, instancePath)

    this.#componentStack.push(qualifiedName)
    try {
      return this.lowerBody(
        declaration,
        fieldBindings,
        [...path, "component", qualifiedName, "body"],
        childIdentityPath(instancePath, "body"),
      )
    } finally {
      this.#componentStack.pop()
    }
  }

  lowerCall(
    call: MunCallExpression,
    bindings: UiBindings,
    path: UiIdentityPath,
    statePath: UiStateIdentityPath,
  ): MunUiNode[] {
    const component = this.resolveComponent(call.callee)
    if (component) {
      return [this.lowerComponent(call, component.declaration, component.semanticView, bindings, path, statePath)]
    }
    const supplied: ComponentSemanticArgument[] = call.arguments.map(argument =>
      componentSemanticArgument(argument, bindings, this.#stateTypes)
    )
    if (call.trailing) supplied.push({ type: "function", trailing: true, trailingClosure: call.trailing })

    if (call.callee === "Color") return [colorView(this, rawCallSource(call), path)]
    if (call.callee === "Window") {
      const resolution = resolveContractCall(windowSymbols, supplied, { kind: "view", owner: "Window" })
      const context: NativeCallContext = { lowerer: this, call, args: resolution.arguments, bindings, path, statePath }
      const title = staticTitle(argumentSource(context, "title"), bindings, "Window title")
      const children = stackChildren(context)
      if (children.length !== 1) throw new SyntaxError("Window requires exactly one root content view")
      return [{
        kind: "window",
        id: this.id("window", path),
        title,
        layout: {
          width: lowerValueExpression(argumentSource(context, "width") ?? "640", bindings),
          height: lowerValueExpression(argumentSource(context, "height") ?? "420", bindings),
        },
        accessibility: { role: "window", label: title },
        child: children[0],
      }]
    }

    const symbols = nativeViewInitializerSymbols(call.callee)
    if (symbols) {
      const resolution = resolveContractCall(symbols, supplied, {
        kind: "view",
        owner: call.callee,
        unsupported: swiftUIUnsupportedInitializerSignatures(call.callee),
      })
      const implementation = nativeViews[`${call.callee}.${resolution.signature}`]
      if (!implementation) throw new SyntaxError(`Internal error: no native implementation for ${call.callee}.${resolution.signature}`)
      return implementation({ lowerer: this, call, args: resolution.arguments, bindings, path, statePath })
    }

    throw new SyntaxError(
      unsupportedView(call.callee)
        ?? `View '${call.callee}' is neither a SwiftUI View implemented by Mün nor a View declared in this file`,
    )
  }
}

/** `Color.red`, `Color(red: …)`, `Color.red.opacity(0.5)` used as a View, followed by View modifiers. */
function colorViewChain(source: string): { readonly base: MunBuilderNode; readonly colorSource: string; readonly modifiers: readonly ModifierCall[] } | undefined {
  const text = source.trim()
  if (!/^Color\b/.test(text)) return undefined
  const chain = parseMemberChain(text)
  if (!chain) return undefined
  // Color members (named colors, opacity) bind to the Color; the rest are View modifiers.
  let consumed = 0
  if (!chain.ownerCall) {
    if (!chain.members[0] || chain.members[0].arguments) return undefined
    consumed = 1
  }
  while (chain.members[consumed]?.name === "opacity" && consumed > 0 && !chain.ownerCall) consumed += 1
  const colorLength = colorPrefixLength(text, chain.ownerCall ? 0 : consumed)
  const colorSource = text.slice(0, colorLength)
  const rest = text.slice(colorLength)
  const modifiers = rest.trim() ? splitViewChain(`M()${rest}`).modifiers : []
  return { base: { kind: "raw", source: colorSource, range: { start: 0, end: colorLength } }, colorSource, modifiers }
}

function colorPrefixLength(text: string, members: number): number {
  let cursor = "Color".length
  if (text[cursor] === "(") cursor = findMatchingParenthesis(text, cursor) + 1
  for (let index = 0; index < members; index += 1) {
    const name = /^\.[A-Za-z_]\w*/.exec(text.slice(cursor))
    if (!name) break
    cursor += name[0].length
    if (text[cursor] === "(") cursor = findMatchingParenthesis(text, cursor) + 1
  }
  return cursor
}

function rawCallSource(call: MunCallExpression): string {
  return `Color(${call.arguments.map(argument => `${argument.label ? `${argument.label}: ` : ""}${argument.value.kind === "raw" ? argument.value.source.trim() : ""}`).join(", ")})`
}

/** A SwiftUI Color used as a View: a rectangle filled with the color that fills its space. */
function colorView(lowerer: UiLowerer, source: string, path: UiIdentityPath): MunUiNode {
  return {
    kind: "panel",
    id: lowerer.id("panel", path),
    shape: "rectangle",
    layout: flexibleBoth,
    visual: { foreground: { kind: "solid", color: lowerColor(source) } },
  }
}

function stampAction(action: MunUiAction, lowerer: UiLowerer): MunUiAction {
  if (action.kind === "collection") return { ...action, keyPath: lowerer.collectionKeyPath(action.state) }
  if (action.kind === "sequence") {
    return { ...action, actions: action.actions.map(item => stampAction(item, lowerer)) }
  }
  return action
}

/** Give every collection mutation the key path of the ForEach rendering it. */
function withCollectionKeyPaths<T extends MunUiNode>(node: T, lowerer: UiLowerer): T {
  const visit = (current: MunUiNode): MunUiNode => {
    switch (current.kind) {
      case "action":
        return { ...current, action: stampAction(current.action, lowerer) }
      case "window":
        return { ...current, child: visit(current.child) }
      case "conditional":
        return { ...current, then: current.then.map(visit), otherwise: current.otherwise.map(visit) }
      case "column":
      case "row":
      case "overlay":
      case "scroll":
      case "forEach":
        return { ...current, children: current.children.map(visit) } as MunUiNode
      default:
        return current
    }
  }
  return visit(node) as T
}

/**
 * Lower canonical Mün source into renderer-independent semantic UI IR.
 *
 * This pass intentionally runs from Mün's parsed builder/struct representation,
 * before the legacy web compiler materializes div/span/style templates.
 */
export function compileMunUiProgram(
  source: string,
  fileName = "mun-source.mun",
  options: MunUiCompileOptions = {},
): MunUiProgram {
  assertCanonicalMunSource(source, fileName)
  const structs = parseMunStructs(source)
  if (structs.length === 0) throw new SyntaxError("Native Mün requires a View struct entry point")
  // Canonical declaration rules (Swift type spellings, access levels). The
  // legacy compatibility pipelines keep accepting TypeScript spellings.
  validateCanonicalDeclarations(structs)

  const requestedEntry = entryName(source, structs[0].name)
  const entry = structs.find(structure => structure.name === requestedEntry) ?? structs[0]
  const states = stateDeclarations(source)
  const lowerer = new UiLowerer(structs, states)
  const lowered = withCollectionKeyPaths(lowerer.lowerEntry(entry), lowerer)
  const title = options.windowTitle ?? "Mün"
  const root: MunUiWindowNode = lowered.kind === "window"
    ? lowered
    : {
        kind: "window",
        id: "window-root",
        title,
        layout: {
          width: literal(options.windowWidth ?? 640),
          height: literal(options.windowHeight ?? 420),
        },
        accessibility: { role: "window", label: title },
        child: lowered,
      }

  return {
    version: 1,
    sourceLanguage: "mun",
    entry: entry.name,
    states: lowerer.states(),
    root,
  }
}
