import ts from "typescript"
import { compileMotionPlan as compileInheritedMotionPlan, curves as inheritedCurves, spring as inheritedSpring, timing as inheritedTiming } from "@mun/animation/core"
import {
  Animation,
  Transition,
  Transaction as CoreTransaction,
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
  type MunUiProgram,
  type MunUiScalar,
  type MunUiState,
  type MunUiTransition,
  type MunUiVisual,
  type MunUiWindowNode,
  type SemanticArgument,
} from "@mun/core"
import {
  parseMunBuilder,
  parseMunStructs,
  type MunArgument,
  type MunBuilderNode,
  type MunBuilderProgram,
  type MunCallExpression,
  type MunConditionalExpression,
  type MunStructDeclaration,
} from "./ast.js"
import { assertCanonicalMunSource } from "./analysis.js"
import {
  canonicalViewSymbols,
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
}

const emptyBindings: UiBindings = new Map()
const literal = (value: MunUiScalar): MunUiExpression => ({ kind: "literal", value })
const canonicalUiViewSymbols = canonicalViewSymbols()

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

function parsedExpression(source: string): ts.Expression {
  const file = ts.createSourceFile(
    "mun-ui-expression.ts",
    `(${source})`,
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

  if (ts.isIdentifier(expression)) {
    const binding = bindings.get(expression.text)
    if (binding) return binding
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
    throw new SyntaxError(`Native @Binding requires $state or Binding(state): ${source}`)
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

function validateCanonicalBuiltinCall(
  call: MunCallExpression,
  bindings: UiBindings,
  stateTypes: ReadonlyMap<string, string>,
): void {
  const initializers = canonicalUiViewSymbols.get(call.callee)?.initializers
  if (!initializers) return

  const supplied: ComponentSemanticArgument[] = call.arguments.map(argument =>
    componentSemanticArgument(argument, bindings, stateTypes)
  )
  if (call.trailing) supplied.push({ type: "function", trailing: true })

  const result = resolveSemanticInitializer(initializers, supplied)
  if (result.ok) return

  const candidates = result.failure.candidates.map(candidate => candidate.signature).join("; ")
  const prefix = result.failure.kind === "ambiguous"
    ? "Ambiguous initializer"
    : "No matching initializer"
  throw new SyntaxError(
    `${prefix} for native View '${call.callee}'.${candidates ? ` Available initializers: ${candidates}.` : ""}`,
  )
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

function entryName(source: string, fallback: string): string {
  return source.match(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*\(/)?.[1] ?? fallback
}

function actionFromClosure(source: string, bindings: UiBindings = emptyBindings): MunUiAction {
  const body = source.trim().replace(/;$/, "").trim()
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

  throw new SyntaxError(`Action body is not yet representable in native Mün IR: ${source.trim()}`)
}

function scalarAnimationArgument(expression: ts.Expression, source: string): MunUiScalar {
  const value = scalarFromExpression(unwrap(expression))
  if (value === undefined) {
    throw new SyntaxError(`Native Animation arguments must be compile-time scalars: ${source}`)
  }
  return value
}

function animationNumber(value: MunUiScalar | undefined, fallback: number, source: string): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SyntaxError(`Native Animation numeric argument must be finite: ${source}`)
  }
  return value
}

function animationBoolean(value: MunUiScalar | undefined, fallback: boolean, source: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") {
    throw new SyntaxError(`Native Animation boolean argument must be literal: ${source}`)
  }
  return value
}

function resolveCoreAnimation(expression: ts.Expression, source: string): Animation {
  const current = unwrap(expression)
  if (ts.isPropertyAccessExpression(current)) {
    const owner = unwrap(current.expression)
    if (ts.isIdentifier(owner) && owner.text === "Animation" && current.name.text === "default") {
      return Animation.default
    }
  }
  if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) {
    throw new SyntaxError(`Expected an Animation factory/modifier call, received: ${source}`)
  }

  const method = current.expression.name.text
  const owner = unwrap(current.expression.expression)
  const args = current.arguments.map(argument => scalarAnimationArgument(argument, source))

  if (ts.isIdentifier(owner) && owner.text === "Animation") {
    switch (method) {
      case "linear": return Animation.linear(animationNumber(args[0], 0.35, source))
      case "easeIn": return Animation.easeIn(animationNumber(args[0], 0.35, source))
      case "easeOut": return Animation.easeOut(animationNumber(args[0], 0.35, source))
      case "easeInOut": return Animation.easeInOut(animationNumber(args[0], 0.35, source))
      case "spring": return Animation.spring(
        animationNumber(args[0], 0.55, source),
        animationNumber(args[1], 0.825, source),
        animationNumber(args[2], 0, source),
      )
      case "interactiveSpring": return Animation.interactiveSpring(
        animationNumber(args[0], 0.15, source),
        animationNumber(args[1], 0.86, source),
        animationNumber(args[2], 0.25, source),
      )
      case "smooth": return Animation.smooth(
        animationNumber(args[0], 0.5, source),
        animationNumber(args[1], 0, source),
      )
      case "snappy": return Animation.snappy(
        animationNumber(args[0], 0.5, source),
        animationNumber(args[1], 0, source),
      )
      case "bouncy": return Animation.bouncy(
        animationNumber(args[0], 0.5, source),
        animationNumber(args[1], 0, source),
      )
      default:
        throw new SyntaxError(`Unsupported native Animation factory: ${method}`)
    }
  }

  const base = resolveCoreAnimation(owner, source)
  switch (method) {
    case "delay": return base.delay(animationNumber(args[0], 0, source))
    case "speed": return base.speed(animationNumber(args[0], 1, source))
    case "repeatCount": return base.repeatCount(
      animationNumber(args[0], 1, source),
      animationBoolean(args[1], true, source),
    )
    case "repeatForever": return base.repeatForever(animationBoolean(args[0], true, source))
    default:
      throw new SyntaxError(`Unsupported native Animation modifier: ${method}`)
  }
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
  return lowerAnimation(resolveCoreAnimation(parsedExpression(source), source), source)
}

function transitionNumberArgument(
  expression: ts.Expression | undefined,
  fallback: number,
  source: string,
  label: string,
): number {
  if (!expression) return fallback
  const value = scalarFromExpression(unwrap(expression))
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SyntaxError(`Native Transition ${label} must be a finite static number: ${source}`)
  }
  return value
}

function transitionEdge(expression: ts.Expression, source: string): "top" | "bottom" | "leading" | "trailing" | "left" | "right" {
  const scalar = scalarFromExpression(unwrap(expression))
  if (typeof scalar === "string" && ["top", "bottom", "leading", "trailing", "left", "right"].includes(scalar)) {
    return scalar as "top" | "bottom" | "leading" | "trailing" | "left" | "right"
  }
  const current = unwrap(expression)
  if (ts.isPropertyAccessExpression(current) && ts.isIdentifier(current.expression)) {
    const value = current.name.text
    if (["top", "bottom", "leading", "trailing", "left", "right"].includes(value)) {
      return value as "top" | "bottom" | "leading" | "trailing" | "left" | "right"
    }
  }
  throw new SyntaxError("Native Transition edge must be a static edge: " + source)
}

function resolveCoreTransition(expression: ts.Expression, source: string): Transition {
  const current = unwrap(expression)
  if (ts.isPropertyAccessExpression(current)) {
    const owner = unwrap(current.expression)
    if (ts.isIdentifier(owner) && owner.text === "Transition") {
      if (current.name.text === "identity") return Transition.identity
      if (current.name.text === "opacity") return Transition.opacity
    }
  }

  if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) {
    throw new SyntaxError("Expected a Transition expression, received: " + source)
  }

  const method = current.expression.name.text
  const owner = unwrap(current.expression.expression)
  if (ts.isIdentifier(owner) && owner.text === "Transition") {
    switch (method) {
      case "scale":
        return Transition.scale(transitionNumberArgument(current.arguments[0], 0.95, source, "scale"))
      case "move": {
        const edge = current.arguments[0]
        if (!edge) throw new SyntaxError("Transition.move requires an edge: " + source)
        const distance = transitionNumberArgument(current.arguments[1], 24, source, "distance")
        return Transition.move(transitionEdge(edge, source), distance)
      }
      case "asymmetric": {
        const insertion = current.arguments[0]
        const removal = current.arguments[1]
        if (!insertion || !removal) throw new SyntaxError("Transition.asymmetric requires insertion and removal: " + source)
        return Transition.asymmetric(
          resolveCoreTransition(insertion, insertion.getText()),
          resolveCoreTransition(removal, removal.getText()),
        )
      }
      default:
        throw new SyntaxError("Unsupported native Transition factory: " + method)
    }
  }

  const base = resolveCoreTransition(owner, source)
  switch (method) {
    case "combined": {
      const next = current.arguments[0]
      if (!next) throw new SyntaxError("Transition.combined requires another transition: " + source)
      return base.combined(resolveCoreTransition(next, next.getText()))
    }
    case "animation": {
      const animation = current.arguments[0]
      if (!animation) throw new SyntaxError("Transition.animation requires an Animation: " + source)
      return base.animation(resolveCoreAnimation(animation, animation.getText()))
    }
    default:
      throw new SyntaxError("Unsupported native Transition modifier: " + method)
  }
}

function lowerTransition(source: string): MunUiTransition {
  const transition = resolveCoreTransition(parsedExpression(source), source)
  const descriptor = transition.descriptor
  return {
    insertion: descriptor.insertion.map(effect => ({ ...effect })),
    removal: descriptor.removal.map(effect => ({ ...effect })),
    ...(descriptor.animation ? { animation: lowerAnimation(descriptor.animation, source + ".animation") } : {}),
  }
}

function transactionPlan(source: string): MunUiAction["transaction"] & {} {
  const expression = unwrap(parsedExpression(source))
  if (!ts.isNewExpression(expression) || !ts.isIdentifier(expression.expression) || expression.expression.text !== "Transaction") {
    throw new SyntaxError(`Native withTransaction requires new Transaction(...), received: ${source}`)
  }

  const argument = expression.arguments?.[0]
  let transaction: CoreTransaction
  if (!argument || argument.kind === ts.SyntaxKind.NullKeyword) {
    transaction = new CoreTransaction(null)
  } else if (ts.isObjectLiteralExpression(argument)) {
    let animation: Animation | null | undefined
    let disablesAnimations: boolean | undefined
    let isContinuous: boolean | undefined
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new SyntaxError(`Native Transaction options must use static property assignments: ${source}`)
      }
      const name = property.name.getText().replace(/^['"]|['"]$/g, "")
      if (name === "animation") {
        animation = property.initializer.kind === ts.SyntaxKind.NullKeyword
          ? null
          : resolveCoreAnimation(property.initializer, property.initializer.getText())
      } else if (name === "disablesAnimations" || name === "isContinuous") {
        const value = scalarFromExpression(unwrap(property.initializer))
        if (typeof value !== "boolean") {
          throw new SyntaxError(`Transaction ${name} must be a static boolean: ${source}`)
        }
        if (name === "disablesAnimations") disablesAnimations = value
        else isContinuous = value
      } else {
        throw new SyntaxError(`Unsupported native Transaction option '${name}'`)
      }
    }
    transaction = new CoreTransaction({ animation, disablesAnimations, isContinuous })
  } else {
    transaction = new CoreTransaction(resolveCoreAnimation(argument, argument.getText()))
  }

  return {
    animation: transaction.animation ? lowerAnimation(transaction.animation, source) : null,
    disablesAnimations: transaction.disablesAnimations,
    isContinuous: transaction.isContinuous,
  }
}

function skipQuoted(source: string, index: number): number {
  const quote = source[index]
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") { cursor += 1; continue }
    if (source[cursor] === quote) return cursor + 1
  }
  throw new SyntaxError("Unclosed string while reading Mün view modifiers")
}

function findMatchingParenthesis(source: string, openIndex: number): number {
  let depth = 1
  for (let cursor = openIndex + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    if (character === "\"" || character === "'" || character === "`") {
      cursor = skipQuoted(source, cursor) - 1
      continue
    }
    if (character === "(") depth += 1
    else if (character === ")") {
      depth -= 1
      if (depth === 0) return cursor
    }
  }
  throw new SyntaxError("Unclosed modifier argument list in Mün source")
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

function modifierArguments(source: string): readonly MunArgument[] {
  if (!source.trim()) return []
  const program = parseMunBuilder(`M(${source})`)
  const statement = program.statements[0]
  if (!statement || statement.kind !== "call") throw new SyntaxError(`Invalid Mün modifier arguments: ${source}`)
  return statement.arguments
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
    if (trimmed[cursor] !== "(") throw new SyntaxError(`Modifier .${name} requires an argument list`)
    const close = findMatchingParenthesis(trimmed, cursor)
    modifiers.push({ name, arguments: modifierArguments(trimmed.slice(cursor + 1, close)) })
    cursor = close + 1
  }

  return { base: program.statements[0], modifiers }
}

function modifierRaw(modifier: ModifierCall, label: string, positionalIndex: number): string | undefined {
  const labeled = modifier.arguments.find(argument => argument.label === label)
  const argument = labeled ?? modifier.arguments.filter(item => item.label === undefined)[positionalIndex]
  return argument?.value.kind === "raw" ? argument.value.source.trim() : undefined
}

function normalizedAlignment(source: string | undefined): MunUiAlignment | undefined {
  if (source === undefined) return undefined
  const value = source.trim().replace(/^\./, "")
  if (value === "leading" || value === "center" || value === "trailing" || value === "stretch") return value
  throw new SyntaxError(`Native alignment must be a static semantic alignment: ${source}`)
}

function offsetSources(modifier: ModifierCall): { readonly x?: string; readonly y?: string } {
  const labeledX = modifier.arguments.find(argument => argument.label === "x")
  const labeledY = modifier.arguments.find(argument => argument.label === "y")
  if (labeledX || labeledY) {
    return {
      x: labeledX?.value.kind === "raw" ? labeledX.value.source.trim() : undefined,
      y: labeledY?.value.kind === "raw" ? labeledY.value.source.trim() : undefined,
    }
  }

  const positional = modifier.arguments.filter(argument => argument.label === undefined)
  const first = positional[0]?.value.kind === "raw" ? positional[0].value.source.trim() : undefined
  const second = positional[1]?.value.kind === "raw" ? positional[1].value.source.trim() : undefined
  if (second !== undefined) return { x: first, y: second }
  if (!first) return {}

  const expression = unwrap(parsedExpression(first))
  if (ts.isObjectLiteralExpression(expression)) {
    const member = (name: string): string | undefined => {
      const property = expression.properties.find(property => {
        if (!ts.isPropertyAssignment(property)) return false
        const key = property.name
        return (ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === name
      })
      return property && ts.isPropertyAssignment(property) ? property.initializer.getText() : undefined
    }
    const x = member("x")
    const y = member("y")
    if (x !== undefined || y !== undefined) return { x, y }
  }

  // The runtime graph API treats a single numeric/expression argument as x.
  return { x: first, y: "0" }
}

function expressionIsDynamic(value: MunUiExpression | undefined): value is MunUiExpression {
  return !!value && value.kind !== "literal"
}

function semanticIdentityKey(modifier: ModifierCall, bindings: UiBindings): MunUiExpression {
  const source = modifierRaw(modifier, "value", 0)
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

function applyModifiers(
  node: MunUiNode,
  modifiers: readonly ModifierCall[],
  bindings: UiBindings = emptyBindings,
): MunUiNode {
  let parts: MutableNodeParts = {
    identityKey: node.identityKey,
    layout: node.layout,
    visual: node.visual,
    motion: node.motion,
    transition: node.transition,
  }
  let pendingAnimation: { readonly plan: MunMotionExecutionPlan; readonly trigger?: MunUiExpression } | undefined

  for (const modifier of modifiers) {
    if (modifier.name === "id") {
      parts = { ...parts, identityKey: semanticIdentityKey(modifier, bindings) }
      continue
    }

    if (modifier.name === "frame") {
      parts = {
        ...parts,
        layout: {
          ...parts.layout,
          width: modifierRaw(modifier, "width", 0) ? lowerValueExpression(modifierRaw(modifier, "width", 0)!, bindings) : parts.layout?.width,
          height: modifierRaw(modifier, "height", 1) ? lowerValueExpression(modifierRaw(modifier, "height", 1)!, bindings) : parts.layout?.height,
        },
      }
      continue
    }

    if (modifier.name === "padding") {
      parts = {
        ...parts,
        layout: {
          ...parts.layout,
          padding: numberValue(modifierRaw(modifier, "length", 0), 8, bindings),
        },
      }
      continue
    }

    if (modifier.name === "background" || modifier.name === "fill") {
      const background = stringValue(
        modifierRaw(modifier, "style", 0) ?? modifierRaw(modifier, "color", 0),
        undefined,
        bindings,
      )
      if (background) parts = { ...parts, visual: { ...parts.visual, background } }
      continue
    }

    if (modifier.name === "foregroundStyle" || modifier.name === "foregroundColor") {
      const foreground = stringValue(
        modifierRaw(modifier, "style", 0) ?? modifierRaw(modifier, "color", 0),
        undefined,
        bindings,
      )
      if (foreground) parts = { ...parts, visual: { ...parts.visual, foreground } }
      continue
    }

    if (modifier.name === "cornerRadius") {
      parts = {
        ...parts,
        visual: {
          ...parts.visual,
          cornerRadius: numberValue(modifierRaw(modifier, "radius", 0), 0, bindings),
        },
      }
      continue
    }

    if (modifier.name === "opacity") {
      const source = modifierRaw(modifier, "value", 0)
      if (!source) throw new SyntaxError("opacity requires a value")
      parts = {
        ...parts,
        visual: {
          ...parts.visual,
          opacity: lowerValueExpression(source, bindings),
        },
      }
      continue
    }

    if (modifier.name === "offset") {
      const { x, y } = offsetSources(modifier)
      parts = {
        ...parts,
        visual: {
          ...parts.visual,
          translationX: x ? lowerValueExpression(x, bindings) : literal(0),
          translationY: y ? lowerValueExpression(y, bindings) : literal(0),
        },
      }
      continue
    }

    if (modifier.name === "transition") {
      const source = modifierRaw(modifier, "transition", 0) ?? modifierRaw(modifier, "value", 0)
      if (!source) throw new SyntaxError("transition requires a Transition value")
      parts = { ...parts, transition: lowerTransition(source) }
      continue
    }

    if (modifier.name === "animation") {
      const planSource = modifierRaw(modifier, "animation", 0)
      if (!planSource) throw new SyntaxError("animation requires an Animation value")
      const triggerSource = modifierRaw(modifier, "value", 1)
      pendingAnimation = {
        plan: animationPlan(planSource),
        trigger: triggerSource ? lowerValueExpression(triggerSource, bindings) : undefined,
      }
      continue
    }

    throw new SyntaxError(`View modifier '.${modifier.name}' is not representable in Mün semantic UI IR`)
  }

  const motionBindings: Array<NonNullable<MunUiNode["motion"]>[number]> = [...(parts.motion ?? [])]
  const candidates: readonly [MunMotionProperty, MunUiExpression | undefined][] = [
    ["width", parts.layout?.width],
    ["height", parts.layout?.height],
    ["opacity", parts.visual?.opacity],
    ["translationX", parts.visual?.translationX],
    ["translationY", parts.visual?.translationY],
  ]
  for (const [property, value] of candidates) {
    if (!expressionIsDynamic(value)) continue
    const existing = motionBindings.findIndex(binding => binding.property === property)
    const binding = {
      property,
      propertyMask: munMotionPropertyBit(property),
      value,
      ...(pendingAnimation?.trigger ? { trigger: pendingAnimation.trigger } : {}),
      ...(pendingAnimation ? { plan: pendingAnimation.plan } : {}),
    }
    if (existing >= 0) motionBindings[existing] = binding
    else motionBindings.push(binding)
  }
  if (motionBindings.length > 0) parts = { ...parts, motion: motionBindings }

  return {
    ...node,
    ...(parts.identityKey ? { identityKey: parts.identityKey } : {}),
    ...(parts.layout ? { layout: parts.layout } : {}),
    ...(parts.visual ? { visual: parts.visual } : {}),
    ...(parts.motion ? { motion: parts.motion } : {}),
    ...(parts.transition ? { transition: parts.transition } : {}),
  }
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

function keyedStateIdentityPath(path: UiStateIdentityPath, key: string | number): UiStateIdentityPath {
  if (!path) return null
  const parent = path.at(-2) === "child" ? path.slice(0, -2) : path
  return [...parent, "key", key]
}

function stateIdentityPathForModifiers(
  path: UiStateIdentityPath,
  modifiers: readonly ModifierCall[],
  bindings: UiBindings,
): UiStateIdentityPath {
  let current = path
  for (const modifier of modifiers) {
    if (modifier.name !== "id") continue
    const identityKey = semanticIdentityKey(modifier, bindings)
    if (identityKey.kind !== "literal") return null
    if (typeof identityKey.value !== "string" && typeof identityKey.value !== "number") return null
    current = keyedStateIdentityPath(current, identityKey.value)
  }
  return current
}

class UiLowerer {
  readonly #structs: ReadonlyMap<string, MunStructDeclaration>
  readonly #qualifiedNameByDeclaration: ReadonlyMap<MunStructDeclaration, string>
  readonly #semanticViews = new Map<string, MunSemanticView>()
  readonly #componentStack: string[] = []
  readonly #states: MunUiState[]
  readonly #stateTypes: Map<string, string>

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
      const initial = lowerValueExpression(field.initializer, bindings)
      if (initial.kind !== "literal") {
        throw new SyntaxError(
          `Native @State member '${declaration.name}.${field.name}' requires a scalar initial value for now`,
        )
      }
      const stateName = `@component/${instanceId}/${field.name}`
      this.#states.push({ name: stateName, initial: initial.value })
      this.#stateTypes.set(stateName, initial.value === null ? "null" : typeof initial.value)
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
    const program = parseMunBuilder(declaration.bodyExpressionSource, declaration.bodyExpressionRange.start)
    if (program.statements.length !== 1) {
      throw new SyntaxError(`Native custom View '${qualifiedName}' body must contain one root view`)
    }
    this.#componentStack.push(qualifiedName)
    try {
      return this.lower(program.statements[0], bindings, [...instancePath, "body"])
    } finally {
      this.#componentStack.pop()
    }
  }

  lower(
    node: MunBuilderNode,
    bindings: UiBindings = emptyBindings,
    path: UiIdentityPath,
    statePath: UiStateIdentityPath = path,
  ): MunUiNode {
    if (node.kind === "raw") {
      const chain = splitViewChain(node.source)
      const scopedStatePath = stateIdentityPathForModifiers(statePath, chain.modifiers, bindings)
      return applyModifiers(this.lower(chain.base, bindings, path, scopedStatePath), chain.modifiers, bindings)
    }
    if (node.kind === "conditional") return this.lowerConditional(node, bindings, path, statePath)
    return this.lowerCall(node, bindings, path, statePath)
  }

  lowerProgram(
    program: MunBuilderProgram,
    bindings: UiBindings,
    path: UiIdentityPath,
    statePath: UiStateIdentityPath = path,
  ): MunUiNode[] {
    return program.statements.map((statement, index) =>
      this.lower(
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

  children(
    call: MunCallExpression,
    bindings: UiBindings,
    path: UiIdentityPath,
    statePath: UiStateIdentityPath,
  ): MunUiNode[] {
    const body = call.trailing?.body
    return body
      ? this.lowerProgram(
          body,
          bindings,
          [...path, "content"],
          childIdentityPath(statePath, "content"),
        )
      : []
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
          if (expectedType && expectedType !== actualType) {
            throw new SyntaxError(
              `Native @Binding '${declaration.name}.${field.name}' expects ${expectedType} state, received ${actualType}`,
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
          if (expectedType && expectedType !== actualType) {
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

    const program = parseMunBuilder(declaration.bodyExpressionSource, declaration.bodyExpressionRange.start)
    if (program.statements.length !== 1) {
      throw new SyntaxError(`Native custom View '${qualifiedName}' body must contain one root view`)
    }

    this.#componentStack.push(qualifiedName)
    try {
      return this.lower(
        program.statements[0],
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
  ): MunUiNode {
    validateCanonicalBuiltinCall(call, bindings, this.#stateTypes)
    if (call.callee === "VStack" || call.callee === "Column") {
      const spacing = numberValue(rawArgument(call, "spacing", 0), 0, bindings)
      const alignment = normalizedAlignment(rawArgument(call, "alignment", 1))
      return {
        kind: "column",
        id: this.id("column", path),
        layout: { spacing, ...(alignment ? { alignment } : {}) },
        accessibility: { role: "group" },
        children: this.children(call, bindings, path, statePath),
      }
    }

    if (call.callee === "HStack" || call.callee === "Row") {
      const spacing = numberValue(rawArgument(call, "spacing", 0), 0, bindings)
      const alignment = normalizedAlignment(rawArgument(call, "alignment", 1))
      return {
        kind: "row",
        id: this.id("row", path),
        layout: { spacing, ...(alignment ? { alignment } : {}) },
        accessibility: { role: "group" },
        children: this.children(call, bindings, path, statePath),
      }
    }

    if (call.callee === "Text") {
      const source = rawArgument(call, "content", 0)
      if (!source) throw new SyntaxError("Text requires content")
      const value = lowerValueExpression(source, bindings)
      return {
        kind: "text",
        id: this.id("text", path),
        value,
        accessibility: {
          role: "text",
          ...(value.kind === "literal" && typeof value.value === "string" ? { label: value.value } : {}),
        },
      }
    }

    if (call.callee === "Button" || call.callee === "Action") {
      const labelSource = rawArgument(call, "label", 0)
      const label = stringValue(labelSource, undefined, bindings)
      if (!label) throw new SyntaxError(`${call.callee} requires a static string label in the first native slice`)
      if (!call.trailing) throw new SyntaxError(`${call.callee} requires an action closure`)
      return {
        kind: "action",
        id: this.id("action", path),
        label,
        action: actionFromClosure(call.trailing.bodySource, bindings),
        accessibility: { role: "button", label },
      }
    }

    if (call.callee === "Rectangle" || call.callee === "RoundedRectangle" || call.callee === "Panel") {
      const cornerRadius = call.callee === "RoundedRectangle"
        ? numberValue(rawArgument(call, "radius", 0), 8, bindings)
        : undefined
      return {
        kind: "panel",
        id: this.id("panel", path),
        ...(cornerRadius !== undefined ? { visual: { cornerRadius } } : {}),
      }
    }

    if (call.callee === "Window") {
      const title = stringValue(rawArgument(call, "title", 0), "Mün", bindings) ?? "Mün"
      const children = this.children(call, bindings, path, statePath)
      if (children.length !== 1) throw new SyntaxError("Window requires exactly one root content view")
      return {
        kind: "window",
        id: this.id("window", path),
        title,
        layout: {
          width: lowerValueExpression(rawArgument(call, "width", 1) ?? "640", bindings),
          height: lowerValueExpression(rawArgument(call, "height", 2) ?? "420", bindings),
        },
        accessibility: { role: "window", label: title },
        child: children[0],
      }
    }

    const component = this.resolveComponent(call.callee)
    if (component) {
      return this.lowerComponent(
        call,
        component.declaration,
        component.semanticView,
        bindings,
        path,
        statePath,
      )
    }

    throw new SyntaxError(`View '${call.callee}' is not part of the native Mün semantic component graph`)
  }
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

  const requestedEntry = entryName(source, structs[0].name)
  const entry = structs.find(structure => structure.name === requestedEntry) ?? structs[0]
  const states = stateDeclarations(source)
  const lowerer = new UiLowerer(structs, states)
  const lowered = lowerer.lowerEntry(entry)
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
