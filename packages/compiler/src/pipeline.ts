import * as ts from "typescript"
import { parseMunBuilder, parseMunStructs, lowerMunBuilderAst, type MunBuilderNode, type MunBuilderProgram, type MunCallExpression } from "./ast.js"
import {
  findBuilder,
  findRawHtml,
  identifierAt,
  matching,
  previousSignificantCharacter,
  previousWord,
  regexCanStart,
  rawHtmlAt,
  skipComment,
  skipRegex,
  skipString,
  skipTrivia,
  splitStatements,
  splitTopLevel,
  syntaxError,
  topLevelColon,
  type BuilderCall,
} from "./scanner.js"
import * as Core from "@mun/core/compat"
import { resolveSemanticCall, swiftUIModifierLowering, type SemanticArgument, type SemanticCallResolution, type SemanticInitializerSymbol, type SemanticViewTypeSymbol } from "@mun/core/compat"
import { lowerImplicitMemberShorthand, lowerNamedAnimationFactoryCalls, lowerShorthand } from "./shorthand.js"
import { foldStaticResults, hoistStaticViewSubtrees, lowerCompiledViewTemplates, lowerContentTransitionArgument, lowerStaticSemanticSpecializations, staticModifierNames } from "./specialization.js"
import { lowerCompiledCollections } from "./collection-specialization.js"
import { lowerStateArrayMaps } from "./state-specialization.js"
import { canonicalViewSymbols } from "./semantic.js"

// Nested named calls are uncommon in ordinary argument expressions. Keep the
// recursive lowering path behind a cheap lexical hint so every positional
// argument does not rescan itself with the full balanced-call scanner.
const nestedNamedMunCallHint = /\b(?:[A-Z][A-Za-z0-9_$]*\.)*[A-Z][A-Za-z0-9_$]*\s*\([^()\n]*:[^()\n]*\)/
const validationSourceFileCache = new Map<string, ts.SourceFile>()
const maximumValidationSourceFiles = 32

function validationSourceFile(source: string): ts.SourceFile {
  const cached = validationSourceFileCache.get(source)
  if (cached) {
    validationSourceFileCache.delete(source)
    validationSourceFileCache.set(source, cached)
    return cached
  }
  const file = ts.createSourceFile("mun-call-validation.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  validationSourceFileCache.set(source, file)
  while (validationSourceFileCache.size > maximumValidationSourceFiles) {
    const oldest = validationSourceFileCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    validationSourceFileCache.delete(oldest)
  }
  return file
}

/**
 * Compiler-facing view metadata starts with every runtime View so Mun-native
 * and compatibility APIs remain usable. Canonical SwiftUI Views are then
 * replaced by the SDK-audited manifest contract, preventing runtime-only
 * overloads from silently becoming SwiftUI source syntax.
 */
const canonicalInitializerSymbols = new Map<string, readonly SemanticInitializerSymbol[]>()
for (const [name, value] of Object.entries(Core)) {
  if (typeof value !== "function") continue
  const viewType = (value as { readonly viewType?: { readonly name?: string; readonly semanticSymbol?: { readonly initializers: readonly SemanticInitializerSymbol[] } } }).viewType
  if (viewType?.name && viewType.semanticSymbol) canonicalInitializerSymbols.set(name, viewType.semanticSymbol.initializers)
}
for (const [name, symbol] of canonicalViewSymbols()) {
  canonicalInitializerSymbols.set(name, symbol.initializers)
}
type InitializerSymbolRegistry = ReadonlyMap<string, readonly SemanticInitializerSymbol[]>

function symbolsForCall(call: MunCallExpression, registry: InitializerSymbolRegistry = canonicalInitializerSymbols): readonly SemanticInitializerSymbol[] | undefined {
  return registry.get(call.callee)
}

class MunInitializerSyntaxError extends SyntaxError {
  readonly code = "MUN_INITIALIZER" as const
  readonly offset: number

  constructor(message: string, offset: number) {
    super(message)
    this.name = "MunInitializerSyntaxError"
    this.offset = offset
  }
}

function buttonInitializerMessage(call: MunCallExpression): string {
  const labels = call.arguments.flatMap(argument => argument.label ? [argument.label] : [])
  if (labels.includes("label") && labels.includes("action") && labels.indexOf("label") < labels.indexOf("action")) {
    return "Button arguments must follow declaration order: action:, label:."
  }
  return "Button must use either Button(\"Title\") { action } or Button(action: { ... }) { label }."
}

function knownCallArguments(call: MunCallExpression): readonly SemanticArgument[] {
  const arguments_ = call.arguments.flatMap((argument, argumentIndex) => {
    if (argument.value.kind === "closure") return [{ label: argument.label, type: "function" }]
    if (call.callee === "ForEach" && argumentIndex === 1 && /^\{\s*(?:id|key)\s*:/.test(argument.value.source) && /=>/.test(argument.value.source)) {
      return [{ label: "key", type: "function" }]
    }
    const named = /^namedArguments\s*\(\s*\{([\s\S]*)\}\s*\)$/.exec(argument.value.source.trim())
    if (named) return splitTopLevel(named[1]).map(value => compilerSemanticArgument(value))
    return [compilerSemanticArgument(argument.label ? `${argument.label}: ${argument.value.source}` : argument.value.source)]
  })
  return call.trailing ? [...arguments_, { type: "function", trailing: true }] : arguments_
}

function canDeferDynamicButton(call: MunCallExpression, arguments_: readonly SemanticArgument[]): boolean {
  if (!arguments_.some(argument => argument.type === "unknown")) return false
  if (call.trailing) return call.arguments.length === 1 && (!call.arguments[0]?.label || call.arguments[0]?.label === "action")
  const labels = call.arguments.map(argument => argument.label)
  return labels.length === 2 && labels[0] === "action" && labels[1] === "label"
}

function resolveKnownCall(call: MunCallExpression, registry: InitializerSymbolRegistry = canonicalInitializerSymbols): {
  readonly symbols: readonly SemanticInitializerSymbol[]
  readonly initializerIndex: number
  readonly resolution: SemanticCallResolution
} | undefined {
  const symbols = symbolsForCall(call, registry)
  if (!symbols) return undefined
  const viewType: SemanticViewTypeSymbol = {
    kind: "view",
    name: call.callee,
    qualifiedName: call.callee,
    initializers: symbols,
    fields: [],
  }
  const arguments_ = knownCallArguments(call)
  const result = resolveSemanticCall(viewType, arguments_)
  if (!result.resolvedInitializer) {
    if (call.callee === "Button" && canDeferDynamicButton(call, arguments_)) return undefined
    if (call.callee === "Button") throw new MunInitializerSyntaxError(buttonInitializerMessage(call), call.range.start)
    if (call.trailing && canonicalInitializerSymbols.get(call.callee) !== symbols) {
      throw new MunInitializerSyntaxError(
        result.diagnostics[0]?.message ?? `No matching initializer for ${call.callee}.`,
        call.range.start,
      )
    }
    return undefined
  }
  return { symbols, initializerIndex: result.resolvedInitializer.index, resolution: result }
}

function validateKnownCalls(program: MunBuilderProgram, registry: InitializerSymbolRegistry = canonicalInitializerSymbols): void {
  const visit = (node: MunBuilderNode): void => {
    if (node.kind === "call") {
      if (node.callee === "Button" || node.trailing) resolveKnownCall(node, registry)
      for (const argument of node.arguments) if (argument.value.kind === "closure") validateKnownCalls(argument.value.body, registry)
      if (node.trailing) validateKnownCalls(node.trailing.body, registry)
      return
    }
    if (node.kind === "conditional") {
      validateKnownCalls(node.then, registry)
      if (node.otherwise) {
        if (node.otherwise.kind === "conditional") validateKnownCalls({ ...node.then, statements: [node.otherwise] }, registry)
        else validateKnownCalls(node.otherwise, registry)
      }
    }
  }
  for (const node of program.statements) visit(node)
}

function validateKnownTypeScriptCalls(
  source: string,
  registry: InitializerSymbolRegistry = canonicalInitializerSymbols,
  parsedSource?: ts.SourceFile,
): void {
  // SwiftUI-style labels/trailing closures are scanner-owned. Plain positional
  // JS/TS calls deliberately remain the compatibility surface; only Button's
  // constrained positional form needs this AST-side validation.
  if (!/\bButton\s*\(/.test(source)) return
  const file = parsedSource ?? validationSourceFile(source)
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Button" && registry.has("Button")) {
      // The Mun scanner owns trailing closures. TypeScript sees the call
      // prefix as a complete call, so leave that shape to validateKnownCalls.
      const callText = source.slice(node.expression.end, node.end)
      const hasMunLabels = /(?:^|,)\s*[A-Za-z_$][A-Za-z0-9_$]*\s*:/.test(callText)
      if (!hasMunLabels && source[skipTrivia(source, node.end)] !== "{") {
        const callSource = `Button(${node.arguments.map(argument => argument.getText(file)).join(", ")})`
        const parsed = parseMunBuilder(callSource, node.expression.getStart(file)).statements[0]
        if (parsed?.kind === "call") resolveKnownCall(parsed, registry)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
}

function closureRoleForKnownCall(
  call: MunCallExpression,
  context: { readonly position: "argument" | "trailing"; readonly argumentIndex?: number; readonly label?: string },
  registry: InitializerSymbolRegistry = canonicalInitializerSymbols,
): "value" | "viewBuilder" | "action" | undefined {
  if ((call.callee === "withAnimation" || call.callee === "withTransaction") && context.position === "trailing") return "action"
  // This helper is also called while lowering the argument list of a call
  // whose trailing closure has already been split off by the scanner. Such a
  // synthetic prefix can be incomplete (notably Button(action:) before its
  // trailing label), so role inference must fall back to manifest metadata
  // rather than re-diagnosing the partial call.
  let resolved: ReturnType<typeof resolveKnownCall>
  try { resolved = resolveKnownCall(call, registry) } catch (error) {
    if (!(error instanceof MunInitializerSyntaxError)) throw error
    resolved = undefined
  }
  const resolvedArgumentIndex = context.position === "trailing"
    ? Math.max(0, knownCallArguments(call).length - 1)
    : context.label
      ? call.arguments.findIndex(argument => argument.label === context.label)
      : context.argumentIndex ?? 0
  const sharedRole = resolved?.resolution.closureRoles[resolvedArgumentIndex]
  if (sharedRole) return sharedRole === "binding" ? undefined : sharedRole
  const symbols = resolved?.symbols ?? symbolsForCall(call, registry) ?? []
  const parameters = resolved?.symbols[resolved.initializerIndex]?.parameters
    ?? (context.position === "trailing"
      ? symbols.find(symbol => symbol.parameters.at(-1)?.trailing)?.parameters
      : context.label
        ? symbols.find(symbol => symbol.parameters.some(parameter => parameter.label === context.label))?.parameters
        : undefined)
    ?? []
  const role = (kind: SemanticInitializerSymbol["parameters"][number]["kind"] | undefined): "value" | "viewBuilder" | "action" | undefined => kind === "binding" ? undefined : kind
  if (context.position === "trailing") return role(parameters.at(-1)?.kind)
  if (context.label) return role(parameters.find(parameter => parameter.label === context.label)?.kind)
  const index = context.argumentIndex ?? 0
  let positional = 0
  for (const argument of call.arguments.slice(0, index)) if (!argument.label) positional += 1
  return role(parameters[positional]?.kind)
}

function containsAwaitKeyword(source: string): boolean {
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    if (character === "\"" || character === "'" || character === "`") { cursor = skipString(source, cursor) - 1; continue }
    if (character === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*")) { cursor = skipComment(source, cursor) - 1; continue }
    if (character === "/" && regexCanStart(source, cursor)) { cursor = skipRegex(source, cursor) - 1; continue }
    const identifier = identifierAt(source, cursor)
    if (!identifier) continue
    if (identifier.name === "await") return true
    cursor = identifier.end - 1
  }
  return false
}

function isViewBuilderExpression(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isAwaitExpression(expression)) {
    return isViewBuilderExpression(expression.expression)
  }
  if (ts.isConditionalExpression(expression)) {
    return isViewBuilderExpression(expression.whenTrue) || isViewBuilderExpression(expression.whenFalse)
  }
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken
      || operator === ts.SyntaxKind.BarBarToken
      || operator === ts.SyntaxKind.QuestionQuestionToken) {
      return isViewBuilderExpression(expression.left) || isViewBuilderExpression(expression.right)
    }
    return false
  }
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.some(item => ts.isExpression(item) && isViewBuilderExpression(item))
  if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) return true
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return true
  return false
}

function lowerViewBuilderAstStatements(source: string, registry: InitializerSymbolRegistry, childrenName: string): string {
  // First lower nested Mun-only expressions (trailing closures, raw HTML,
  // binding shorthand) so the statement tree is valid TypeScript. Then let
  // TypeScript own control-flow parsing instead of maintaining a second,
  // incomplete statement grammar in Mun.
  // Labeled Mun arguments are not valid TypeScript syntax. They must be
  // converted before the TypeScript parser sees statement-bearing builders;
  // otherwise parser recovery rewrites `Foo(value, label: other)` into the
  // semantically different `Foo(value, label, other)` and leaks `label` as an
  // undeclared runtime identifier.
  const lowered = lowerRange(lowerNamedMunCalls(source, registry), registry)
  const wrapper = `function __mun_builder__() {\n${lowered}\n}`
  const file = ts.createSourceFile("mun-view-builder.ts", wrapper, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const fn = file.statements.find(ts.isFunctionDeclaration)
  if (!fn?.body) return lowered

  const factory = ts.factory
  const pushExpression = (expression: ts.Expression): ts.Statement => factory.createExpressionStatement(
    factory.createCallExpression(
      factory.createPropertyAccessExpression(factory.createIdentifier(childrenName), "push"),
      undefined,
      [expression],
    ),
  )

  const transformStatement = (statement: ts.Statement): ts.Statement => {
    if (ts.isExpressionStatement(statement)) {
      return isViewBuilderExpression(statement.expression) ? pushExpression(statement.expression) : statement
    }
    if (ts.isBlock(statement)) return factory.updateBlock(statement, statement.statements.map(transformStatement))
    if (ts.isIfStatement(statement)) {
      return factory.updateIfStatement(
        statement,
        statement.expression,
        transformStatement(statement.thenStatement),
        statement.elseStatement ? transformStatement(statement.elseStatement) : undefined,
      )
    }
    if (ts.isForStatement(statement)) {
      return factory.updateForStatement(statement, statement.initializer, statement.condition, statement.incrementor, transformStatement(statement.statement))
    }
    if (ts.isForInStatement(statement)) {
      return factory.updateForInStatement(statement, statement.initializer, statement.expression, transformStatement(statement.statement))
    }
    if (ts.isForOfStatement(statement)) {
      return factory.updateForOfStatement(statement, statement.awaitModifier, statement.initializer, statement.expression, transformStatement(statement.statement))
    }
    if (ts.isWhileStatement(statement)) return factory.updateWhileStatement(statement, statement.expression, transformStatement(statement.statement))
    if (ts.isDoStatement(statement)) return factory.updateDoStatement(statement, transformStatement(statement.statement), statement.expression)
    if (ts.isSwitchStatement(statement)) {
      const clauses = statement.caseBlock.clauses.map(clause => ts.isCaseClause(clause)
        ? factory.updateCaseClause(clause, clause.expression, clause.statements.map(transformStatement))
        : factory.updateDefaultClause(clause, clause.statements.map(transformStatement)))
      return factory.updateSwitchStatement(statement, statement.expression, factory.updateCaseBlock(statement.caseBlock, clauses))
    }
    if (ts.isTryStatement(statement)) {
      const tryBlock = factory.updateBlock(statement.tryBlock, statement.tryBlock.statements.map(transformStatement))
      const catchClause = statement.catchClause
        ? factory.updateCatchClause(
            statement.catchClause,
            statement.catchClause.variableDeclaration,
            factory.updateBlock(statement.catchClause.block, statement.catchClause.block.statements.map(transformStatement)),
          )
        : undefined
      const finallyBlock = statement.finallyBlock
        ? factory.updateBlock(statement.finallyBlock, statement.finallyBlock.statements.map(transformStatement))
        : undefined
      return factory.updateTryStatement(statement, tryBlock, catchClause, finallyBlock)
    }
    if (ts.isLabeledStatement(statement)) return factory.updateLabeledStatement(statement, statement.label, transformStatement(statement.statement))
    if (ts.isWithStatement(statement)) return factory.updateWithStatement(statement, statement.expression, transformStatement(statement.statement))
    // Function/class declarations intentionally remain opaque. A Text() call
    // inside a helper function is not a child of the surrounding ViewBuilder.
    return statement
  }

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false })
  return fn.body.statements
    .map(transformStatement)
    .map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, file))
    .join("\n")
}

function needsStatementAwareViewBody(source: string): boolean {
  return /\b(?:const|let|var|return|throw|if|else|switch|case|for|while|do|try|catch|finally|break|continue|debugger)\b/.test(source)
}

function lowerViewBuilderClosure(body: string, parameter: string | undefined, registry: InitializerSymbolRegistry): string {
  if (!needsStatementAwareViewBody(body)) {
    const lowered = lowerMunBuilderAst(parseMunBuilder(body), {
      transformRaw: value => lowerRange(value, registry),
      transformArgument: (value, call, argumentIndex) => lowerForEachIdentityOptions(value, call, argumentIndex, registry),
      closure: (nestedBody, nestedParameter, nestedRole) => lowerAstClosure(nestedBody, nestedParameter, nestedRole, registry),
      closureRole: (nestedCall, context) => closureRoleForKnownCall(nestedCall, context, registry),
    }).join(", ")
    return `${parameter ? `(${parameter})` : "()"} => [${lowered}]`
  }
  const prefix = parameter ? `(${parameter})` : "()"
  let childrenName = "__munChildren"
  let suffix = 0
  while (new RegExp(`\\b${childrenName}\\b`).test(body)) childrenName = `__munChildren${++suffix}`
  const statements = lowerViewBuilderAstStatements(body, registry, childrenName)
  return `${prefix} => { const ${childrenName} = []; ${statements} return ${childrenName}; }`
}

function lowerClosure(value: string, role?: "value" | "viewBuilder" | "action", registry: InitializerSymbolRegistry = canonicalInitializerSymbols): string {
  const source = value.trim()
  if (!source.startsWith("{") || matching(source, 0, "{", "}") !== source.length - 1) return lowerRange(source, registry)
  const inner = source.slice(1, -1).trim()
  const parameterMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+in\s+([\s\S]*)$/.exec(inner)
  const parameter = parameterMatch?.[1]
  const body = parameterMatch?.[2] ?? inner
  if (role === "viewBuilder") return lowerViewBuilderClosure(body, parameter, registry)
  const lowered = lowerStatements(body, registry)
  const asynchronous = containsAwaitKeyword(body)
  if (role === "action") return `${asynchronous ? "async " : ""}(${parameter ?? ""}) => {${lowerRange(body, registry)}}`
  if (parameter) return `(${parameter}) => [${lowered}]`
  const action = asynchronous || /\b(const|let|var|return|throw)\b/.test(body)
  const builder = action ? "() => []" : `() => [${lowered}]`
  return `overloadClosure(${builder}, ${asynchronous ? "async " : ""}() => {${lowerRange(body, registry)}})`
}

function lowerArguments(source: string, calleeName?: string, registry: InitializerSymbolRegistry = canonicalInitializerSymbols): string {
  const parsed = calleeName ? parseMunBuilder(`${calleeName}(${source})`).statements[0] : undefined
  const call = parsed?.kind === "call" ? parsed : undefined
  const positional: string[] = []
  const named: string[] = []
  for (const [argumentIndex, argument] of splitTopLevel(source).entries()) {
    const colon = topLevelColon(argument)
    const labelStart = skipTrivia(argument, 0)
    if (colon >= 0 && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(argument.slice(labelStart, colon).trim())) {
      const label = argument.slice(labelStart, colon).trim()
      const role = call ? closureRoleForKnownCall(call, { position: "argument", argumentIndex, label }, registry) : undefined
      named.push(`${label}: ${lowerClosureOrExpression(argument.slice(colon + 1), role, registry)}`)
    } else {
      const role = call ? closureRoleForKnownCall(call, { position: "argument", argumentIndex }, registry) : undefined
      positional.push(lowerClosureOrExpression(argument, role, registry))
    }
  }
  if (named.length === 0) return positional.join(", ")
  return [...positional, `namedArguments({ ${named.join(", ")} })`].join(", ")
}

function lowerClosureOrExpression(source: string, role?: "value" | "viewBuilder" | "action", registry: InitializerSymbolRegistry = canonicalInitializerSymbols): string {
  const value = source.trim()
  if (value.startsWith("{") && matching(value, 0, "{", "}") === value.length - 1 && !/^(?:\s*(?:[A-Za-z_$][A-Za-z0-9_$]*|["'][^"']*["']|-?\d+(?:\.\d+)?)\s*:)/.test(value.slice(1, -1))) return lowerClosure(value, role, registry)
  // Named Mun calls can be nested inside an argument expression. Lower them
  // from the already-isolated argument rather than restarting a global scan
  // over the whole module for each inner call.
  const lowered = lowerRange(value, registry)
  return lowerImplicitMemberShorthand(lowerShorthand(
    nestedNamedMunCallHint.test(lowered) ? lowerNamedMunCalls(lowered, registry) : lowered,
  ))
}

function lowerForEachIdentityOptions(source: string, call: MunCallExpression, argumentIndex: number, registry: InitializerSymbolRegistry): string {
  const value = source.trim()
  if (call.callee !== "ForEach" || argumentIndex !== 1 || !value.startsWith("{") || matching(value, 0, "{", "}") !== value.length - 1) {
    return lowerImplicitMemberShorthand(lowerRange(source, registry))
  }
  const entries = splitTopLevel(value.slice(1, -1)).map(entry => {
    const colon = topLevelColon(entry)
    return colon < 0 ? undefined : { name: entry.slice(0, colon).trim(), value: entry.slice(colon + 1).trim() }
  }).filter((entry): entry is { name: string; value: string } => entry !== undefined)
  const identity = entries.find(entry => entry.name === "id" || entry.name === "key")
  if (!identity) return lowerRange(source, registry)
  return `namedArguments({ key: ${lowerRange(identity.value, registry)} })`
}

function lowerConditional(source: string, registry: InitializerSymbolRegistry = canonicalInitializerSymbols): string | undefined {
  const match = /^if\s*\(/.exec(source)
  if (!match) return undefined
  const open = source.indexOf("(", match.index + match[0].length - 1)
  const close = matching(source, open, "(", ")")
  const thenOpen = skipTrivia(source, close + 1)
  if (source[thenOpen] !== "{") return undefined
  const thenClose = matching(source, thenOpen, "{", "}")
  const afterThen = skipTrivia(source, thenClose + 1)
  const condition = source.slice(open + 1, close).trim()
  const thenValue = `[${lowerStatements(source.slice(thenOpen + 1, thenClose), registry)}]`
  if (source.slice(afterThen, afterThen + 4) !== "else"
    || /[A-Za-z0-9_$]/.test(source[afterThen + 4] ?? "")) {
    return afterThen === source.length ? `(${lowerShorthand(condition)} ? ${thenValue} : [])` : undefined
  }
  const elseOpen = skipTrivia(source, afterThen + 4)
  if (source[elseOpen] !== "{") return undefined
  const elseClose = matching(source, elseOpen, "{", "}")
  if (skipTrivia(source, elseClose + 1) !== source.length) return undefined
  return `(${lowerShorthand(condition)} ? ${thenValue} : [${lowerStatements(source.slice(elseOpen + 1, elseClose), registry)}])`
}

function lowerStatements(source: string, registry: InitializerSymbolRegistry = canonicalInitializerSymbols): string {
  const values: string[] = []
  for (const statement of splitStatements(source)) {
    const conditional = lowerConditional(statement, registry)
    if (conditional) values.push(conditional)
    else if (/^\s*(const|let|var|return|throw)\b/.test(statement)) continue
    else values.push(lowerRange(statement, registry))
  }
  return values.join(", ")
}

function lowerAstClosure(body: string, parameter?: string, role?: "value" | "viewBuilder" | "action", registry: InitializerSymbolRegistry = canonicalInitializerSymbols): string {
  if (role === "viewBuilder") return lowerViewBuilderClosure(body, parameter, registry)
  const parsed = parseMunBuilder(body)
  const lowered = lowerMunBuilderAst(parsed, {
    transformRaw: value => lowerRange(value, registry),
    transformArgument: (value, call, argumentIndex) => lowerForEachIdentityOptions(value, call, argumentIndex, registry),
    closure: (nestedBody, nestedParameter, nestedRole) => lowerAstClosure(nestedBody, nestedParameter, nestedRole, registry),
    closureRole: (nestedCall, context) => closureRoleForKnownCall(nestedCall, context, registry),
  }).join(", ")
  const asynchronous = containsAwaitKeyword(body)
  if (role === "action") return `${asynchronous ? "async " : ""}(${parameter ?? ""}) => {${lowerRange(body, registry)}}`
  if (parameter) return `(${parameter}) => [${lowered}]`
  const action = asynchronous || /\b(const|let|var|return|throw)\b/.test(body)
  const builder = action ? "() => []" : `() => [${lowered}]`
  return `overloadClosure(${builder}, ${asynchronous ? "async " : ""}() => {${lowerRange(body, registry)}})`
}

function lowerBuilder(call: BuilderCall, source: string, registry: InitializerSymbolRegistry = canonicalInitializerSymbols): string {
  const parsed = parseMunBuilder(source.slice(call.start, call.end), call.start)
  // The scanner intentionally finds call-shaped blocks before the AST knows
  // whether the block is a Mun closure. If it is an object/ordinary block,
  // preserve it as source instead of feeding the same span back into
  // lowerRange forever.
  if (parsed.statements.length === 1 && parsed.statements[0]?.kind === "raw") {
    return source.slice(call.start, call.end)
  }
  const lowered = lowerMunBuilderAst(parsed, {
    transformRaw: value => lowerRange(value, registry),
    transformArgument: (value, call, argumentIndex) => lowerForEachIdentityOptions(value, call, argumentIndex, registry),
    closure: (body, parameter, role) => lowerAstClosure(body, parameter, role, registry),
    closureRole: (nestedCall, context) => closureRoleForKnownCall(nestedCall, context, registry),
  })
  if (lowered.length === 1) return lowered[0]
  return `${call.name}(${lowerArguments(call.argumentSource, call.name, registry)})`
}

function lowerRange(source: string, registry: InitializerSymbolRegistry = canonicalInitializerSymbols): string {
  let output = ""
  let cursor = 0
  let iterations = 0
  while (cursor < source.length) {
    if (++iterations > source.length + 1) throw syntaxError("Mun lowering did not advance past a builder expression", cursor)
    const call = findBuilder(source, cursor)
    const html = findRawHtml(source, cursor, value => lowerRange(value, registry))
    if (!call && !html) break
    if (html && (!call || html.start < call.start)) {
      output += lowerShorthand(source.slice(cursor, html.start))
      output += html.code
      cursor = html.end
      continue
    }
    output += lowerShorthand(source.slice(cursor, call!.start))
    output += lowerBuilder(call!, source, registry)
    cursor = call!.end
  }
  output += lowerShorthand(source.slice(cursor))
  return output
}

interface StructParameter {
  readonly name: string
  readonly label?: string
  readonly labelRequired?: boolean
  readonly kind: "value" | "binding" | "viewBuilder" | "action"
  readonly required: boolean
  readonly trailing?: boolean
  readonly defaultValue?: string
  readonly type?: string
}

interface StructField {
  readonly name: string
  readonly kind: "value" | "state" | "binding"
  readonly type?: string
  readonly defaultValue?: string
}

function structParameter(source: string): StructParameter {
  const kind = source.includes("@ViewBuilder") ? "viewBuilder" : source.includes("@Action") ? "action" : source.includes("@Binding") ? "binding" : "value"
  const clean = source.replace(/@(?:ViewBuilder|Action|Binding)\s*/g, "").trim()
  const defaultIndex = topLevelEquals(clean)
  const declaration = defaultIndex < 0 ? clean : clean.slice(0, defaultIndex).trim()
  const defaultValue = defaultIndex < 0 ? undefined : clean.slice(defaultIndex + 1).trim()
  const colon = topLevelColon(declaration)
  const head = (colon < 0 ? declaration : declaration.slice(0, colon)).trim()
  const words = head.split(/\s+/).filter(Boolean)
  const name = words[words.length - 1]?.replace(/^_+/, "")
  if (!name) throw new SyntaxError(`Invalid struct initializer parameter: ${source}`)
  return {
    name,
    label: words[0] === "_" ? undefined : words[0],
    kind,
    required: defaultIndex < 0,
    defaultValue,
    type: colon < 0 ? undefined : declaration.slice(colon + 1).trim(),
  }
}

function topLevelEquals(source: string): number {
  let parens = 0
  let brackets = 0
  let braces = 0
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    if (character === "\"" || character === "'" || character === "`") { cursor = skipString(source, cursor) - 1; continue }
    if (character === "(") parens += 1
    else if (character === ")") parens -= 1
    else if (character === "[") brackets += 1
    else if (character === "]") brackets -= 1
    else if (character === "{") braces += 1
    else if (character === "}") braces -= 1
    else if (character === "=" && parens === 0 && brackets === 0 && braces === 0 && source[cursor + 1] !== ">") return cursor
  }
  return -1
}

interface StructInitializerPlan {
  readonly parameters: readonly StructParameter[]
  readonly assignments: ReadonlyMap<string, string>
  readonly delegation?: readonly string[]
}

type MunStruct = ReturnType<typeof parseMunStructs>[number]

function structInitializerPlans(declaration: MunStruct): readonly StructInitializerPlan[] {
  const fields = declaration.fields.map(field => ({
    name: field.name,
    kind: field.kind === "state" ? "state" : field.kind === "binding" ? "binding" : "value",
    type: field.type,
    defaultValue: field.initializer,
  }))
  return declaration.initializers.length > 0
    ? declaration.initializers.map(item => structInitializerPlan(item.parametersSource, item.bodySource))
    : [structInitializerPlan(fields.filter(field => field.kind !== "state").map(field => `${field.name}: unknown${field.defaultValue === undefined ? "" : ` = ${field.defaultValue}`}`).join(", "), "")]
}

function structInitializerPlan(parameterSource: string, bodySource: string): StructInitializerPlan {
  const parsedParameters = splitTopLevel(parameterSource).filter(Boolean).map(structParameter)
  const parameters = parsedParameters.map((parameter, index) => ({
    ...parameter,
    trailing: index === parsedParameters.length - 1 && (parameter.kind === "viewBuilder" || parameter.kind === "action"),
    labelRequired: parameter.label !== undefined && !(index === parsedParameters.length - 1 && (parameter.kind === "viewBuilder" || parameter.kind === "action")),
  }))
  const assignments = structFieldAssignments(bodySource)
  const delegationMatch = /\bself\.init\s*\(/.exec(bodySource)
  if (!delegationMatch) return { parameters, assignments }
  const open = bodySource.indexOf("(", delegationMatch.index)
  const close = matching(bodySource, open, "(", ")")
  return { parameters, assignments, delegation: splitTopLevel(bodySource.slice(open + 1, close)).filter(Boolean) }
}

/**
 * Collect `self.<field> = <value>` assignments from an initializer body with
 * quote-, comment-, and nesting-aware value boundaries. A naive
 * line-oriented capture corrupts single-line bodies such as
 * `{ if (v < 0) { self.v = 0 } else { self.v = v } }` by swallowing the
 * closing braces into the field expression.
 */
function structFieldAssignments(bodySource: string): ReadonlyMap<string, string> {
  const assignments = new Map<string, string>()
  let cursor = 0
  while (cursor < bodySource.length) {
    const character = bodySource[cursor]
    if (character === '"' || character === "'" || character === "`") { cursor = skipString(bodySource, cursor); continue }
    if (character === "/" && (bodySource[cursor + 1] === "/" || bodySource[cursor + 1] === "*")) { cursor = skipComment(bodySource, cursor); continue }
    if (character !== "s") { cursor += 1; continue }
    const header = /^self\.[A-Za-z_$][A-Za-z0-9_$]*\s*=(?![=>])/.exec(bodySource.slice(cursor))
    if (!header || (cursor > 0 && /[\w$.]/.test(bodySource[cursor - 1]))) { cursor += 1; continue }
    const name = /^self\.([A-Za-z_$][A-Za-z0-9_$]*)/.exec(header.input)?.[1]
    if (!name) { cursor += 1; continue }
    let valueStart = cursor + header[0].length
    while (valueStart < bodySource.length && /\s/.test(bodySource[valueStart])) valueStart += 1
    let parens = 0
    let brackets = 0
    let braces = 0
    let end = valueStart
    while (end < bodySource.length) {
      const valueCharacter = bodySource[end]
      if (valueCharacter === '"' || valueCharacter === "'" || valueCharacter === "`") { end = skipString(bodySource, end); continue }
      if (valueCharacter === "/" && (bodySource[end + 1] === "/" || bodySource[end + 1] === "*")) { end = skipComment(bodySource, end); continue }
      if (valueCharacter === "(") { parens += 1 }
      else if (valueCharacter === "[") { brackets += 1 }
      else if (valueCharacter === "{") { braces += 1 }
      else if (valueCharacter === ")") { if (parens === 0) break; parens -= 1 }
      else if (valueCharacter === "]") { if (brackets === 0) break; brackets -= 1 }
      else if (valueCharacter === "}") { if (braces === 0) break; braces -= 1 }
      else if ((valueCharacter === ";" || valueCharacter === "\n") && parens === 0 && brackets === 0 && braces === 0) {
        if (valueCharacter !== "\n") break
        // Continue multi-line expressions whose current line ends with a
        // binary operator or an open assignment (`self.title = "Hello" +\n"`).
        if (!/[+\-*/%&|^<>?:=]$/.test(bodySource.slice(valueStart, end).trimEnd())) break
        let next = end + 1
        while (next < bodySource.length && /\s/.test(bodySource[next])) next += 1
        end = next
        continue
      }
      end += 1
    }
    assignments.set(name, bodySource.slice(valueStart, end).trim())
    cursor = Math.max(end, cursor + header[0].length)
  }
  return assignments
}

function structArgument(source: string): { readonly label?: string; readonly value: string } {
  const colon = topLevelColon(source)
  if (colon < 0) return { value: source.trim() }
  return { label: source.slice(0, colon).trim(), value: source.slice(colon + 1).trim() }
}

function delegatedParameterValues(parameters: readonly StructParameter[], arguments_: readonly string[]): Map<string, string> | undefined {
  const values = new Map<string, string>()
  const used = new Set<number>()
  let nextPositional = 0
  for (const source of arguments_) {
    const argument = structArgument(source)
    let index = argument.label === undefined
      ? (() => {
          while (used.has(nextPositional)) nextPositional += 1
          return nextPositional
        })()
      : parameters.findIndex(parameter => parameter.label === argument.label || parameter.name === argument.label)
    if (index < 0 || index >= parameters.length || used.has(index)) return undefined
    used.add(index)
    if (argument.label === undefined) nextPositional = index + 1
    values.set(parameters[index].name, argument.value)
  }
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index]
    if (!values.has(parameter.name)) {
      if (parameter.required) return undefined
      values.set(parameter.name, parameter.defaultValue ?? "undefined")
    }
  }
  return values
}

function compilerInitializerArguments(source: string): readonly string[] {
  return splitTopLevel(source).flatMap(argument => {
    const named = /^namedArguments\s*\(\s*\{([\s\S]*)\}\s*\)$/.exec(argument.trim())
    return named ? splitTopLevel(named[1]) : [argument]
  })
}

function compilerSemanticArgument(source: string): SemanticArgument {
  const argument = structArgument(source)
  const value = argument.value.trim()
  if (/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)$/.test(value)) return { label: argument.label, type: "string" }
  if (/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return { label: argument.label, type: "number" }
  if (/^(?:true|false)$/.test(value)) return { label: argument.label, type: "boolean" }
  if (/^(?:overloadClosure|function)\s*\(/.test(value) || /=>/.test(value)) return { label: argument.label, type: "function" }
  if (/^Binding\s*\(/.test(value)) return { label: argument.label, kind: "binding", type: "binding" }
  if (/^State\s*\(/.test(value)) return { label: argument.label, type: "state" }
  return { label: argument.label, type: "unknown" }
}

interface CanonicalRuntimeBindings {
  readonly names: ReadonlyMap<string, string>
  readonly namespaces: ReadonlySet<string>
}

function canonicalRuntimeBindings(file: ts.SourceFile): CanonicalRuntimeBindings {
  const names = new Map<string, string>()
  const namespaces = new Set<string>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (statement.moduleSpecifier.text !== "@mun/core/compat"
      && statement.moduleSpecifier.text !== "@mun/react") continue
    const clause = statement.importClause
    if (!clause || clause.isTypeOnly) continue
    const bindings = clause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue
        const exported = element.propertyName?.text ?? element.name.text
        if (canonicalInitializerSymbols.has(exported)) names.set(element.name.text, exported)
      }
    }
  }
  return { names, namespaces }
}

function canonicalCallName(
  call: ts.CallExpression,
  bindings: CanonicalRuntimeBindings,
  shadowed: ReadonlySet<string>,
): { readonly localSource: string; readonly exportedName: string } | undefined {
  const callee = unwrapTsExpression(call.expression)
  if (ts.isIdentifier(callee)) {
    if (shadowed.has(callee.text)) return undefined
    const exportedName = bindings.names.get(callee.text)
    return exportedName ? { localSource: callee.text, exportedName } : undefined
  }
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  const owner = unwrapTsExpression(callee.expression)
  if (!ts.isIdentifier(owner) || shadowed.has(owner.text) || !bindings.namespaces.has(owner.text)) return undefined
  return canonicalInitializerSymbols.has(callee.name.text)
    ? { localSource: `${owner.text}.${callee.name.text}`, exportedName: callee.name.text }
    : undefined
}

/**
 * Resolve the common intrinsic calls that need no TypeChecker from Mun's
 * canonical initializer manifest. Unknown/dynamic arguments deliberately stay
 * untouched for the semantic TypeScript pass below.
 */
function lowerStaticCanonicalCalls(source: string): string {
  if (!/(?:from\s*|import\s*\()\s*["'](?:mun|@mun\/(?:core|react))["']/.test(source)) return source
  const file = ts.createSourceFile("mun-canonical-calls.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bindings = canonicalRuntimeBindings(file)
  if (bindings.names.size === 0 && bindings.namespaces.size === 0) return source
  const edits: Array<{ start: number; end: number; replacement: string }> = []
  const visit = (node: ts.Node, shadowed: ReadonlySet<string>): void => {
    if (ts.isCallExpression(node)) {
      const candidate = canonicalCallName(node, bindings, shadowed)
      if (candidate && !node.arguments.some(argument => /^namedArguments\s*\(/.test(argument.getText(file)))) {
        const semanticArguments = node.arguments.map(argument => compilerSemanticArgument(argument.getText(file)))
        if (semanticArguments.every(argument => argument.type !== "unknown")) {
          const symbols = canonicalInitializerSymbols.get(candidate.exportedName) ?? []
          const viewType: SemanticViewTypeSymbol = {
            kind: "view",
            name: candidate.exportedName,
            qualifiedName: candidate.exportedName,
            initializers: symbols,
            fields: [],
          }
          const resolution = resolveSemanticCall(viewType, semanticArguments)
          const selected = resolution.resolvedInitializer
          if (selected && !selected.parameters.some(parameter => parameter.variadic || parameter.kind === "viewBuilder" || parameter.kind === "binding")) {
            edits.push({
              start: node.getStart(file),
              end: node.end,
              replacement: `${candidate.localSource}.viewType.createNodeCompiled(${selected.index}, [${node.arguments.map(argument => argument.getText(file)).join(", ")}])`,
            })
            return
          }
        }
      }
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      const local = new Set(shadowed)
      for (const parameter of node.parameters) for (const name of bindingNames(parameter.name)) local.add(name)
      if (ts.isFunctionDeclaration(node) && node.name) local.add(node.name.text)
      if (node.body) visit(node.body, local)
      return
    }
    if (ts.isBlock(node)) {
      const local = new Set(shadowed)
      for (const name of directBlockBindings(node)) local.add(name)
      ts.forEachChild(node, child => visit(child, local))
      return
    }
    if (ts.isCatchClause(node)) {
      const local = new Set(shadowed)
      if (node.variableDeclaration) for (const name of bindingNames(node.variableDeclaration.name)) local.add(name)
      visit(node.block, local)
      return
    }
    ts.forEachChild(node, child => visit(child, shadowed))
  }
  visit(file, new Set())
  if (edits.length === 0) return source
  let result = source
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
  }
  return result
}

function legacyHostCoercion(type: string | undefined): "identity" | "boolean" | "number" {
  const normalized = type?.replace(/\s+/g, "") ?? ""
  if (/(?:^|\|)boolean(?:\||$)/.test(normalized)) return "boolean"
  if (/(?:^|\|)number(?:\||$)/.test(normalized)) return "number"
  return "identity"
}

function legacyHostPlanSource(plans: readonly StructInitializerPlan[]): string {
  return `{ initializers: [${plans.map((plan, index) => `{ index: ${index}, parameters: [${plan.parameters.map(parameter => `{ name: ${JSON.stringify(parameter.name)}, label: ${parameter.label === undefined ? "undefined" : JSON.stringify(parameter.label)}, kind: ${JSON.stringify(parameter.kind)}, required: ${parameter.required}, trailing: ${parameter.trailing === true}, coercion: ${JSON.stringify(legacyHostCoercion(parameter.type))} }`).join(", ")}] }`).join(", ")}] }`
}

function semanticInitializerSymbol(name: string, plan: StructInitializerPlan, index: number): SemanticInitializerSymbol {
  return {
    kind: "initializer",
    index,
    signature: `${name}(${plan.parameters.map(parameter => `${parameter.kind === "viewBuilder" ? "@ViewBuilder " : parameter.kind === "action" ? "@Action " : parameter.kind === "binding" ? "@Binding " : ""}${parameter.label ?? parameter.name}`).join(", ")})`,
    parameters: plan.parameters,
  }
}

function staticInitializerIndex(declaration: MunStruct, argumentSource: string, offset = 0): number | undefined {
  const plans = structInitializerPlans(declaration)
  const arguments_ = compilerInitializerArguments(argumentSource).map(compilerSemanticArgument)
  const initializers = plans.map((plan, index) => semanticInitializerSymbol(declaration.name, plan, index))
  const viewType: SemanticViewTypeSymbol = {
    kind: "view",
    name: declaration.name,
    qualifiedName: declaration.name,
    genericParameters: declaration.genericParameters,
    fields: [],
    initializers,
  }
  const result = resolveSemanticCall(viewType, arguments_)
  if (result.resolvedInitializer) return result.resolvedInitializer.index
  if (result.diagnostics[0]?.code === "MUN_INITIALIZER" && arguments_.some(argument => argument.type === "unknown")) return undefined
  throw new MunInitializerSyntaxError(
    result.diagnostics[0]?.message ?? `No matching initializer for ${declaration.name}.`,
    offset,
  )
}

function findDelegatedInitializer(plans: readonly StructInitializerPlan[], arguments_: readonly string[], excludedIndex: number): { plan: StructInitializerPlan; values: Map<string, string> } | undefined {
  for (let index = 0; index < plans.length; index += 1) {
    if (index === excludedIndex) continue
    const plan = plans[index]
    const values = delegatedParameterValues(plan.parameters, arguments_)
    if (values) return { plan, values }
  }
  return undefined
}

function substituteStructParameters(expression: string, values: ReadonlyMap<string, string>): string {
  let result = expression
  for (const [name, value] of values) result = result.replace(new RegExp(`\\b${name}\\b`, "g"), `(${value})`)
  return result
}

function resolvedStructFields(
  index: number,
  plans: readonly StructInitializerPlan[],
  fields: readonly StructField[],
  stack = new Set<number>(),
): Map<string, string> {
  if (stack.has(index)) return new Map()
  const nextStack = new Set(stack).add(index)
  const plan = plans[index]
  const values = new Map<string, string>()
  if (plan.delegation) {
    const delegated = findDelegatedInitializer(plans, plan.delegation, index)
    if (delegated) {
      const targetIndex = plans.indexOf(delegated.plan)
      const targetFields = resolvedStructFields(targetIndex, plans, fields, nextStack)
      for (const [field, expression] of targetFields) values.set(field, substituteStructParameters(expression, delegated.values))
    }
  }
  for (const [field, expression] of plan.assignments) values.set(field, expression)
  for (const field of fields) {
    if (values.has(field.name)) continue
    const parameter = plan.parameters.find(item => item.name === field.name)
    if (parameter) values.set(field.name, parameter.name)
    else if (field.defaultValue !== undefined && field.kind !== "state") values.set(field.name, `(${field.defaultValue})`)
    else values.set(field.name, "undefined")
  }
  return values
}

function delegatedStructInitializer(
  name: string,
  plan: StructInitializerPlan,
  fields: readonly StructField[],
  plans: readonly StructInitializerPlan[],
  index: number,
): string {
  const parameters = plan.parameters
  const assignments = resolvedStructFields(index, plans, fields)
  const checks = parameters.map((parameter, parameterIndex) => parameter.kind === "value"
    ? "true"
    : parameter.kind === "binding"
      ? `(args[${parameterIndex}] && typeof args[${parameterIndex}] === "object" && (Object.getOwnPropertyDescriptor(args[${parameterIndex}], "value")?.get || Object.getOwnPropertyDescriptor(args[${parameterIndex}], "value")?.set))`
      : parameter.required
        ? `typeof args[${parameterIndex}] === "function"`
        : `(args[${parameterIndex}] === undefined || typeof args[${parameterIndex}] === "function")`)
  const values = fields.map(field => {
    const expression = assignments.get(field.name) ?? "undefined"
    const parameter = parameters.find(item => item.name === field.name)
    const resolved = parameter?.kind === "viewBuilder" && (expression === `${parameter.name}()` || expression === `(${parameter.name})()`)
      ? `resolveBuilderInput(${parameter.name})`
      : expression
    return `${field.name}: ${resolved}`
  })
  const signature = `${name}(${parameters.map(parameter => `${parameter.kind === "viewBuilder" ? "@ViewBuilder " : parameter.kind === "action" ? "@Action " : parameter.kind === "binding" ? "@Binding " : ""}${parameter.label ?? parameter.name}${parameter.defaultValue === undefined ? "" : ` = ${parameter.defaultValue}`}`).join(", ")})`
  const metadata = `[${parameters.map(parameter => `{ name: ${JSON.stringify(parameter.name)}, kind: ${JSON.stringify(parameter.kind)}, label: ${parameter.label ? JSON.stringify(parameter.label) : "undefined"}, labelRequired: ${parameter.labelRequired === true}, required: ${parameter.required}, trailing: ${parameter.trailing === true}, type: ${parameter.type ? JSON.stringify(parameter.type) : "undefined"} }`).join(", ")}]`
  const required = parameters.filter(parameter => parameter.required).length
  const maximum = parameters.length
  return `initializer(${JSON.stringify(signature)}, args => args.length >= ${required} && args.length <= ${maximum}${checks.length ? ` && ${checks.join(" && ")}` : ""}, args => { ${parameters.map((parameter, parameterIndex) => `const ${parameter.name} = args[${parameterIndex}]${parameter.defaultValue ? ` === undefined ? (${parameter.defaultValue}) : args[${parameterIndex}]` : ""}` ).join("; ")}; return { ${values.join(", ")} } }, ${metadata})`
}

interface StructStateProofContext {
  readonly values: ReadonlySet<string>
  readonly namespaces: ReadonlySet<string>
}

function parsedCompilerExpression(source: string): ts.Expression | undefined {
  const file = ts.createSourceFile("mun-struct-body.ts", `const __munBody = (${source})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  if (((file as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length ?? 0) > 0) return undefined
  const statement = file.statements[0]
  if (!statement || !ts.isVariableStatement(statement)) return undefined
  const initializer = statement.declarationList.declarations[0]?.initializer
  return initializer ? unwrapTsExpression(initializer) : undefined
}

function lowerStructDefinition(
  declaration: ReturnType<typeof parseMunStructs>[number],
  registry: InitializerSymbolRegistry = canonicalInitializerSymbols,
  stateProof?: StructStateProofContext,
): string {
  const fields: StructField[] = declaration.fields.map(field => ({
    name: field.name,
    kind: field.kind === "state" ? "state" : field.kind === "binding" ? "binding" : "value",
    type: field.type,
    defaultValue: field.initializer,
  }))
  const plans = structInitializerPlans(declaration)
  const initializers = plans.map((plan, index) => delegatedStructInitializer(declaration.name, plan, fields, plans, index))
  const stateFields = fields.filter(field => field.kind === "state")
  const state = stateFields.length === 0
    ? ""
    : `, state: () => ({ ${stateFields.map(field => `${field.name}: ${field.defaultValue !== undefined && /^State\s*\(/.test(field.defaultValue) ? field.defaultValue : `State(${field.defaultValue ?? "undefined"})`}`).join(", ")} })`
  const bodySource = declaration.bodyExpressionSource.trim().replace(/^return\s+/, "").replace(/;\s*$/, "")
  // Struct bodies are lowered before the module-wide named-call pass. Keep
  // SwiftUI-style labels intact by lowering them here as well; otherwise a
  // call such as Button(action: ..., label: { ... }) is consumed by the
  // builder pass and can reach TypeScript as `Button(action, ..., label, ...)`.
  const loweredBody = lowerRange(lowerNamedMunCalls(bodySource, registry), registry)
  const stateNames = new Set(stateFields.map(field => field.name))
  const bodyExpression = stateFields.length > 0 && stateProof ? parsedCompilerExpression(loweredBody) : undefined
  const dependenciesComplete = bodyExpression && stateProof
    ? hasCompleteStaticStateDependencies(bodyExpression, stateNames, stateNames, stateProof.values, stateProof.namespaces)
    : false
  const dependencies = stateFields.length === 0
    ? ""
    : `, dependencies: (props: any) => [${stateFields.map(field => `props.${field.name}`).join(", ")}]${dependenciesComplete ? ", dependenciesComplete: true" : ""}`
  const fieldMetadata = `fields: [${declaration.fields.map(field => `{ name: ${JSON.stringify(field.name)}, kind: ${JSON.stringify(field.kind)}, type: ${field.type === undefined ? "undefined" : JSON.stringify(field.type)}, defaultValue: ${field.initializer === undefined ? "undefined" : JSON.stringify(field.initializer)} }`).join(", ")}]`
  const definitionMetadata = [
    declaration.genericParameters === undefined ? undefined : `genericParameters: ${JSON.stringify(declaration.genericParameters)}`,
    fieldMetadata,
    `legacyHost: ${legacyHostPlanSource(plans)}`,
  ].filter((item): item is string => item !== undefined).join(", ")
  return `defineView(${JSON.stringify(declaration.name)}, { ${definitionMetadata}, initializers: [${initializers.join(", ")}]${state}${dependencies}, body: (__munProps: any) => { const { ${fields.map(field => field.name).join(", ")} } = __munProps; return ${loweredBody} } })`
}

function lowerStructs(
  source: string,
  registry: InitializerSymbolRegistry = canonicalInitializerSymbols,
  stateProof?: StructStateProofContext,
): string {
  const declarations = parseMunStructs(source)
  if (declarations.length === 0) return source
  const proof = stateProof ?? importedMunValueBindings(validationSourceFile(source))
  let output = source
  for (const declaration of [...declarations].sort((left, right) => right.range.start - left.range.start)) {
    const definition = lowerStructDefinition(declaration, registry, proof)
    const nested = declaration.nested ?? []
    const replacement = nested.length === 0
      ? `const ${declaration.name} = ${definition}`
      : `const ${declaration.name} = (() => { ${nested.map(item => `const ${item.name} = ${lowerStructDefinition(item, registry, proof)}`).join("; ")}; return Object.assign(${definition}, { ${nested.map(item => item.name).join(", ")} }); })()`
    output = output.slice(0, declaration.range.start) + replacement + output.slice(declaration.range.end)
  }
  return output
}

function lowerStaticStructCalls(source: string, declarations: readonly MunStruct[]): string {
  if (declarations.length === 0) return source
  const known = new Map<string, MunStruct | undefined>()
  const add = (declaration: MunStruct): void => {
    known.set(declaration.name, known.has(declaration.name) ? undefined : declaration)
    for (const nested of declaration.nested ?? []) add(nested)
  }
  for (const declaration of declarations) add(declaration)

  const file = ts.createSourceFile("mun-specialization.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const edits: Array<{ start: number; end: number; replacement: string }> = []
  const simpleBuilderValue = (value: string): string | undefined => {
    const expression = /^\s*\(\s*\)\s*=>\s*(\[[\s\S]*\])\s*$/.exec(value)
    if (expression) return expression[1]
    const block = /^\s*\(\s*\)\s*=>\s*\{\s*return\s+(\[[\s\S]*\])\s*;?\s*\}\s*$/.exec(value)
    return block?.[1]
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const declaration = known.get(node.expression.text)
      const initializerIndex = declaration && staticInitializerIndex(declaration, node.arguments.map(argument => argument.getText(file)).join(", "), node.expression.getStart(file))
      if (initializerIndex !== undefined && declaration) {
        const plan = structInitializerPlans(declaration)[initializerIndex]
        const flattened = plan
          ? compilerInitializerArguments(node.arguments.map(argument => argument.getText(file)).join(", "))
          : []
        const values = plan ? delegatedParameterValues(plan.parameters, flattened) : undefined
        const compiled = !!plan && !!values
        const argumentsSource = compiled
          ? plan.parameters.map(parameter => {
              const value = values!.get(parameter.name) ?? "undefined"
              return parameter.kind === "viewBuilder" ? simpleBuilderValue(value) ?? value : value
            }).join(", ")
          : node.arguments.map(argument => argument.getText(file)).join(", ")
        const method = compiled ? "createNodeCompiled" : "createNodeSpecialized"
        edits.push({
          start: node.expression.getStart(file),
          end: node.end,
          replacement: `${node.expression.text}.viewType.${method}(${initializerIndex}, [${argumentsSource}])`,
        })
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  let result = source
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
  }
  return result
}

interface TopLevelStateDeclaration {
  readonly name?: string
  readonly statement: ts.VariableStatement
  readonly declaration: ts.VariableDeclaration
  readonly initializer: ts.Expression
  readonly eligible: boolean
}

interface MunApiBindings {
  readonly state: ReadonlySet<string>
  readonly view: ReadonlySet<string>
  readonly namespaces: ReadonlySet<string>
  readonly blockedState: boolean
  readonly blockedView: boolean
}

function isMunPackage(moduleName: string): boolean {
  return moduleName.startsWith("@mun/")
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNames(element.name))
  }
  return []
}

function munApiBindings(file: ts.SourceFile): MunApiBindings {
  const state = new Set<string>()
  const view = new Set<string>()
  const namespaces = new Set<string>()
  let blockedState = false
  let blockedView = false

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const mun = isMunPackage(statement.moduleSpecifier.text)
      const clause = statement.importClause
      if (clause?.name) {
        if (!mun && clause.name.text === "State") blockedState = true
        if (!mun && clause.name.text === "view") blockedView = true
      }
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) {
        if (mun) namespaces.add(bindings.name.text)
        continue
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text
          const local = element.name.text
          if (mun && imported === "State") state.add(local)
          else if (!mun && local === "State") blockedState = true
          if (mun && imported === "view") view.add(local)
          else if (!mun && local === "view") blockedView = true
        }
      }
      continue
    }
    const names: string[] = []
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.push(statement.name.text)
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) names.push(...bindingNames(declaration.name))
    }
    if (names.includes("State")) blockedState = true
    if (names.includes("view")) blockedView = true
  }
  return { state, view, namespaces, blockedState, blockedView }
}

function unwrapTsExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)) {
    current = current.expression
  }
  return current
}

function isMunApiCall(call: ts.CallExpression, api: "State" | "view", bindings: MunApiBindings): boolean {
  const expression = unwrapTsExpression(call.expression)
  const named = api === "State" ? bindings.state : bindings.view
  const blocked = api === "State" ? bindings.blockedState : bindings.blockedView
  if (ts.isIdentifier(expression)) {
    if (named.has(expression.text)) return true
    // `.mun.ts` supports the canonical names without an explicit import; do
    // not claim them when the file has provided an unrelated binding.
    return expression.text === api && !blocked && named.size === 0
  }
  if (ts.isPropertyAccessExpression(expression)
    && expression.name.text === api
    && ts.isIdentifier(expression.expression)
    && bindings.namespaces.has(expression.expression.text)) return true
  return false
}

function collectTopLevelStates(file: ts.SourceFile, bindings: MunApiBindings): TopLevelStateDeclaration[] {
  const states: TopLevelStateDeclaration[] = []
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
    const exported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer) continue
      const initializer = unwrapTsExpression(declaration.initializer)
      if (!ts.isCallExpression(initializer) || !isMunApiCall(initializer, "State", bindings)) continue
      states.push({
        name: ts.isIdentifier(declaration.name) ? declaration.name.text : undefined,
        statement,
        declaration,
        initializer: declaration.initializer,
        eligible: isConst && !exported && ts.isIdentifier(declaration.name),
      })
    }
  }
  return states
}

function isNonReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true
  if (ts.isMethodSignature(parent) && parent.name === node) return true
  if (ts.isPropertySignature(parent) && parent.name === node) return true
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true
  if (ts.isParameter(parent) && parent.name === node) return true
  if (ts.isBindingElement(parent) && parent.name === node) return true
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true
  if (ts.isClassDeclaration(parent) && parent.name === node) return true
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true
  return false
}

function directBlockBindings(node: ts.SourceFile | ts.Block): Set<string> {
  const bindings = new Set<string>()
  for (const statement of node.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) bindings.add(name)
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      bindings.add(statement.name.text)
    }
  }
  return bindings
}

function referencedStateNames(
  root: ts.Node,
  stateNames: ReadonlySet<string>,
  skipped: ReadonlySet<ts.Node> = new Set(),
): Set<string> {
  const result = new Set<string>()
  const visit = (node: ts.Node, shadowed: ReadonlySet<string>): void => {
    if (skipped.has(node)) return
    if (ts.isIdentifier(node) && stateNames.has(node.text) && !shadowed.has(node.text) && !isNonReferenceIdentifier(node)) result.add(node.text)

    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      const local = new Set(shadowed)
      for (const parameter of node.parameters) for (const name of bindingNames(parameter.name)) local.add(name)
      if (ts.isFunctionDeclaration(node) && node.name) local.add(node.name.text)
      if (node.body) visit(node.body, local)
      return
    }
    if (ts.isBlock(node)) {
      const local = new Set(shadowed)
      for (const name of directBlockBindings(node)) local.add(name)
      ts.forEachChild(node, child => visit(child, local))
      return
    }
    if (ts.isCatchClause(node)) {
      const local = new Set(shadowed)
      if (node.variableDeclaration) for (const name of bindingNames(node.variableDeclaration.name)) local.add(name)
      visit(node.block, local)
      return
    }
    ts.forEachChild(node, child => visit(child, shadowed))
  }
  visit(root, new Set())
  return result
}

function collectMunViewCalls(file: ts.SourceFile, bindings: MunApiBindings): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isMunApiCall(node, "view", bindings)) {
      calls.push(node)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls.sort((left, right) => left.getStart(file) - right.getStart(file))
}

function stateDependencies(state: TopLevelStateDeclaration, stateNames: ReadonlySet<string>): Set<string> {
  return referencedStateNames(state.initializer, stateNames)
}

function importedMunValueBindings(file: ts.SourceFile): { readonly values: ReadonlySet<string>; readonly namespaces: ReadonlySet<string> } {
  const values = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !isMunPackage(statement.moduleSpecifier.text)) continue
    const clause = statement.importClause
    if (!clause || clause.isTypeOnly) continue
    if (clause.name) values.add(clause.name.text)
    const named = clause.namedBindings
    if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text)
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) if (!element.isTypeOnly) values.add(element.name.text)
    }
  }
  return { values, namespaces }
}

const compilerPureCallNames = new Set([
  "String", "Number", "Boolean", "BigInt",
  "namedArguments", "overloadClosure", "resolveBuilderInput", "Element",
])

const compilerAnimationFactoryNames = new Set([
  "linear", "easeIn", "easeOut", "easeInOut", "spring",
  "interactiveSpring", "smooth", "snappy", "bouncy",
])
const compilerAnimationTransformNames = new Set(["delay", "speed", "repeatCount", "repeatForever"])

function isProvenAnimationExpression(expression: ts.Expression, munValues: ReadonlySet<string>): boolean {
  const value = unwrapTsExpression(expression)
  if (!ts.isCallExpression(value)) return false
  const callee = unwrapTsExpression(value.expression)
  if (!ts.isPropertyAccessExpression(callee)) return false
  const owner = unwrapTsExpression(callee.expression)
  if (compilerAnimationFactoryNames.has(callee.name.text)) return ts.isIdentifier(owner) && munValues.has(owner.text)
  return compilerAnimationTransformNames.has(callee.name.text) && isProvenAnimationExpression(owner, munValues)
}

function isProvenAnimationMember(expression: ts.PropertyAccessExpression, munValues: ReadonlySet<string>): boolean {
  const owner = unwrapTsExpression(expression.expression)
  if (compilerAnimationFactoryNames.has(expression.name.text)) return ts.isIdentifier(owner) && munValues.has(owner.text)
  return compilerAnimationTransformNames.has(expression.name.text) && isProvenAnimationExpression(owner, munValues)
}

function valueBindingNames(root: ts.Node): Set<string> {
  const names = new Set<string>()
  const addBinding = (name: ts.BindingName): void => {
    for (const value of bindingNames(name)) names.add(value)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) addBinding(node.name)
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) names.add(node.name.text)
    else if (ts.isCatchClause(node) && node.variableDeclaration) addBinding(node.variableDeclaration.name)
    else if (ts.isImportClause(node) && node.name && !node.isTypeOnly) names.add(node.name.text)
    else if (ts.isNamespaceImport(node)) names.add(node.name.text)
    else if (ts.isImportSpecifier(node) && !node.isTypeOnly) names.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return names
}

function isProvenMunViewExpression(
  expression: ts.Expression,
  munValues: ReadonlySet<string>,
  munNamespaces: ReadonlySet<string>,
): boolean {
  const value = unwrapTsExpression(expression)
  if (!ts.isCallExpression(value)) return false
  const callee = unwrapTsExpression(value.expression)
  if (ts.isIdentifier(callee)) return munValues.has(callee.text) && canonicalInitializerSymbols.has(callee.text)
  if (!ts.isPropertyAccessExpression(callee)) return false
  const owner = unwrapTsExpression(callee.expression)
  if (staticModifierNames.has(callee.name.text)) return isProvenMunViewExpression(owner, munValues, munNamespaces)
  return ts.isIdentifier(owner)
    && munNamespaces.has(owner.text)
    && canonicalInitializerSymbols.has(callee.name.text)
}

/**
 * Prove a deliberately small closed world for State reads. A false result is
 * not an error; it simply keeps runtime dependency discovery enabled. This
 * avoids unsoundly skipping a shared/module State that is read through an
 * opaque helper, getter, or other user-controlled call.
 */
function hasCompleteStaticStateDependencies(
  root: ts.Expression,
  ownedStateNames: ReadonlySet<string>,
  allStateNames: ReadonlySet<string>,
  munValues: ReadonlySet<string>,
  munNamespaces: ReadonlySet<string>,
  shadowedPureCalls: ReadonlySet<string> = new Set(),
): boolean {
  const directlyReferenced = referencedStateNames(root, allStateNames)
  if ([...directlyReferenced].some(name => !ownedStateNames.has(name))) return false
  const localBindings = valueBindingNames(root)
  const pureCallAllowed = (name: string): boolean => compilerPureCallNames.has(name)
    && !shadowedPureCalls.has(name)
    && !localBindings.has(name)

  let safe = true
  const visit = (node: ts.Node): void => {
    if (!safe) return
    if (ts.isPropertyAccessExpression(node)) {
      const expression = unwrapTsExpression(node.expression)
      const ownedStateValue = node.name.text === "value" && ts.isIdentifier(expression) && ownedStateNames.has(expression.text)
      const munNamespaceMember = ts.isIdentifier(expression) && munNamespaces.has(expression.text)
      const provenViewModifier = staticModifierNames.has(node.name.text)
        && isProvenMunViewExpression(node.expression, munValues, munNamespaces)
      const provenAnimationMember = isProvenAnimationMember(node, munValues)
      // Modifier names alone are not enough: a user object may expose an
      // `opacity()`/`padding()` method. Only a chain rooted in an imported Mun
      // View constructor is admitted into the static dependency proof. Immutable
      // Animation factory/configuration chains are also closed and pure.
      if (!ownedStateValue && !munNamespaceMember && !provenViewModifier && !provenAnimationMember) { safe = false; return }
    }
    if (ts.isElementAccessExpression(node)) { safe = false; return }
    if (ts.isCallExpression(node)) {
      const callee = unwrapTsExpression(node.expression)
      if (ts.isIdentifier(callee)) {
        if (!munValues.has(callee.text) && !pureCallAllowed(callee.text)) { safe = false; return }
      } else if (ts.isPropertyAccessExpression(callee)) {
        const owner = unwrapTsExpression(callee.expression)
        const namespaceCall = ts.isIdentifier(owner) && munNamespaces.has(owner.text)
        const modifierCall = staticModifierNames.has(callee.name.text)
          && isProvenMunViewExpression(owner, munValues, munNamespaces)
        const animationCall = isProvenAnimationMember(callee, munValues)
        if (!namespaceCall && !modifierCall && !animationCall) { safe = false; return }
      } else { safe = false; return }
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return safe
}


function transitiveStateClosure(
  initial: Iterable<string>,
  eligible: ReadonlySet<string>,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const result = new Set<string>()
  const queue = [...initial]
  while (queue.length > 0) {
    const name = queue.pop()!
    if (!eligible.has(name) || result.has(name)) continue
    result.add(name)
    for (const dependency of dependencies.get(name) ?? []) queue.push(dependency)
  }
  return result
}

function lowerTopLevelState(source: string): string {
  // Aliases still contain the exported name in their import declaration
  // (`State as LocalState`), so this is a safe conservative preflight.
  if (!/\bState\b/.test(source)) return source
  const file = ts.createSourceFile("mun-state.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bindings = munApiBindings(file)
  const munValues = importedMunValueBindings(file)
  const fileValueBindings = valueBindingNames(file)
  const states = collectTopLevelStates(file, bindings)
  const eligibleStates = states.filter((state): state is TopLevelStateDeclaration & { readonly name: string } => state.eligible && state.name !== undefined)
  if (eligibleStates.length === 0) return source
  const byName = new Map(eligibleStates.map(state => [state.name, state] as const))
  const eligibleNames = new Set(byName.keys())
  const allNames = new Set(states.flatMap(state => state.name ? [state.name] : []))
  const dependencies = new Map<string, ReadonlySet<string>>()
  for (const state of eligibleStates) dependencies.set(state.name, stateDependencies(state, allNames))

  const views = collectMunViewCalls(file, bindings)
  if (views.length === 0) return source
  const viewSet = new Set<ts.Node>(views)

  // Any reference outside a Mun view keeps that State module-scoped. This
  // includes helper functions and ineligible/exported/mutable State factories.
  const directOutside = new Set<string>()
  const stateDeclarations = new Set(states.map(state => state.declaration))
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (stateDeclarations.has(declaration)) {
          const state = states.find(item => item.declaration === declaration)
          if (state && !state.eligible) {
            for (const dependency of referencedStateNames(state.initializer, allNames)) directOutside.add(dependency)
          }
          continue
        }
        if (declaration.initializer) for (const name of referencedStateNames(declaration.initializer, allNames, viewSet)) directOutside.add(name)
      }
      continue
    }
    for (const name of referencedStateNames(statement, allNames, viewSet)) directOutside.add(name)
  }
  const outside = transitiveStateClosure(directOutside, eligibleNames, dependencies)

  const owners = new Map<string, Set<number>>()
  const statesByView = new Map<number, TopLevelStateDeclaration[]>()
  views.forEach((view, index) => {
    const direct = referencedStateNames(view.arguments[0] ?? view, allNames)
    const closure = transitiveStateClosure(direct, eligibleNames, dependencies)
    for (const name of closure) {
      const set = owners.get(name) ?? new Set<number>()
      set.add(index)
      owners.set(name, set)
    }
  })

  for (const state of eligibleStates) {
    const stateOwners = owners.get(state.name)
    if (outside.has(state.name) || stateOwners?.size !== 1) continue
    const owner = [...stateOwners][0]
    const list = statesByView.get(owner) ?? []
    list.push(state)
    statesByView.set(owner, list)
  }
  if (statesByView.size === 0) return source

  const hoisted = new Set([...statesByView.values()].flat().map(state => state.declaration))
  const hoistedSpans: Array<{ readonly start: number; readonly end: number }> = []
  const removalEdits: Array<{ start: number; end: number; replacement: string }> = []

  // Remove each hoisted declarator individually instead of rewriting the whole
  // variable statement from original source text. A whole-statement rewrite
  // clobbers any nested view() replacement inside a preserved sibling
  // declarator (e.g. `const count = State(0), app = view(() => Text(count))`).
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const declarations = statement.declarationList.declarations
    const removedIndexes = declarations.map((declaration, index) => hoisted.has(declaration) ? index : -1).filter(index => index >= 0)
    if (removedIndexes.length === 0) continue
    const hasPreserved = declarations.some(declaration => !hoisted.has(declaration))
    if (!hasPreserved) {
      removalEdits.push({ start: statement.getStart(file), end: statement.end, replacement: "" })
      for (const declaration of declarations) {
        if (!hoisted.has(declaration)) continue
        hoistedSpans.push({ start: declaration.getStart(file), end: declaration.end })
      }
      continue
    }
    for (const index of removedIndexes) {
      const declaration = declarations[index]
      let start = declaration.getStart(file)
      let end = declaration.end
      const trailingSeparator = /^\s*,/.exec(source.slice(end))
      if (trailingSeparator) end += trailingSeparator[0].length
      else {
        const leadingSeparator = /,\s*$/.exec(source.slice(0, start))
        if (leadingSeparator) start -= leadingSeparator[0].length
      }
      removalEdits.push({ start, end, replacement: "" })
      hoistedSpans.push({ start: declaration.getStart(file), end: declaration.end })
    }
  }

  // A view replacement lexically inside a removed State declarator cannot be
  // applied safely alongside the removal; leave that call on the runtime path.
  const viewEdits = [...statesByView]
    .flatMap(([viewIndex]) => {
      const call = views[viewIndex]
      if (!call) return []
      if (hoistedSpans.some(span => call.getStart(file) < span.end && span.start < call.end)) return []
      return [viewIndex]
    })
    .map(viewIndex => {
      const call = views[viewIndex]
      const argument = call.arguments[0]
      if (!argument || call.arguments.length !== 1) return undefined
      const callee = call.expression.getText(file)
      const body = argument.getText(file)
      const unwrapped = unwrapTsExpression(argument)
      const functionBody = ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)
      const hasProps = functionBody && unwrapped.parameters.length > 0
      const names = statesByView.get(viewIndex)!.map(state => state.name!)
      const declarations = statesByView.get(viewIndex)!
        .sort((left, right) => left.declaration.getStart(file) - right.declaration.getStart(file))
        .map(state => `const ${state.name} = ${state.initializer.getText(file)};`)
        .join(" ")
      const renderedBody = functionBody ? `((${body})(${hasProps ? "props" : ""}))` : `(${body})`
      const bodyParameters = hasProps ? `({ ${names.join(", ")} }, props)` : `({ ${names.join(", ")} })`
      const dependencyParameters = `({ ${names.join(", ")} })`
      const ownedNames = new Set(names)
      const dependenciesComplete = !hasProps && hasCompleteStaticStateDependencies(
        argument, ownedNames, allNames, munValues.values, munValues.namespaces, fileValueBindings,
      )
      const completeness = dependenciesComplete ? `, dependenciesComplete: true` : ""
      const replacement = `${callee}({ state: () => { ${declarations} return { ${names.join(", ")} } }, dependencies: ${dependencyParameters} => [${names.join(", ")}]${completeness}, body: ${bodyParameters} => ${renderedBody} })`
      return { start: call.getStart(file), end: call.end, replacement }
    })
    .filter((edit): edit is { start: number; end: number; replacement: string } => edit !== undefined)

  const edits = [...removalEdits, ...viewEdits].sort((left, right) => right.start - left.start)
  let result = source
  for (const edit of edits) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
  return result
}

function ensureImports(source: string, includeViewBuiltins = false): string {
  const callableRequired = ["defineView", "initializer", "resolveBuilderInput", "namedArguments", "overloadClosure", "Binding", "State", "Element", "modifiedContent", "modifiedContentCompiled", "compiledTemplate", "defineCompiledTemplate"]
    .filter(name => new RegExp(`\\b${name}(?:<[^()\\n]*>)?\\s*\\(`).test(source) || (name === "defineView" && /const\s+[A-Z]\w*\s*=\s*defineView/.test(source)))
  const valueRequired = ["ContentTransition", "SymbolEffect"].filter(name => {
    if (!new RegExp(`\\b${name}\\s*\\.`).test(source)) return false
    return !new RegExp(`\\b(?:const|let|var|class|function|enum|namespace)\\s+${name}\\b`).test(source)
  })
  const viewRequired = includeViewBuiltins
    ? [...canonicalInitializerSymbols.keys()].filter(name => {
        if (!new RegExp(`\\b${name}\\s*\\(`).test(source)) return false
        return !new RegExp(`\\b(?:const|let|var|class|function|enum|namespace)\\s+${name}\\b`).test(source)
      })
    : []
  const required = [...new Set([...callableRequired, ...valueRequired, ...viewRequired])]
  let result = source
  const internalRequired = ["compiledCollectionContent", "mapStateArrayData"].filter(name => new RegExp(`\\b${name}\\s*\\(`).test(source))
  if (required.length === 0 && internalRequired.length === 0) return result
  const imports = [...result.matchAll(/import\s*\{([^}]*)\}\s*from\s*(["'])(@mun\/core\/compat|@mun\/react)\2[\t ]*;?/g)]
  const imported = new Set(imports.flatMap(match => match[1].split(",").map(value => value.trim()).filter(Boolean)))
  const missing = required.filter(name => !imported.has(name))
  if (missing.length > 0) {
    const existingCore = imports.find(match => match[3] === "@mun/core/compat")
    if (!existingCore) result = `import { ${missing.join(", ")} } from "@mun/core/compat"\n${result}`
    else {
      const names = existingCore[1].split(",").map(value => value.trim()).filter(Boolean)
      for (const name of missing) if (!names.includes(name)) names.push(name)
      const replacement = `import { ${names.join(", ")} } from ${existingCore[2]}@mun/core/compat${existingCore[2]}`
      result = result.slice(0, existingCore.index) + replacement + result.slice(existingCore.index + existingCore[0].length)
    }
  }
  if (internalRequired.length > 0) {
    const internalImport = /import\s*\{([^}]*)\}\s*from\s*(["'])@mun\/core\/internal\/runtime\2[\t ]*;?/.exec(result)
    if (!internalImport) result = `import { ${internalRequired.join(", ")} } from "@mun/core/internal/runtime"\n${result}`
    else {
      const names = internalImport[1].split(",").map(value => value.trim()).filter(Boolean)
      for (const name of internalRequired) if (!names.includes(name)) names.push(name)
      const replacement = `import { ${names.join(", ")} } from ${internalImport[2]}@mun/core/internal/runtime${internalImport[2]}`
      result = result.slice(0, internalImport.index) + replacement + result.slice(internalImport.index + internalImport[0].length)
    }
  }
  return result
}

function lowerNamedMunCalls(source: string, registry: InitializerSymbolRegistry = canonicalInitializerSymbols): string {
  // A labeled call must contain a colon. Most host TypeScript modules do not,
  // so avoid even collecting uppercase call candidates in that common case.
  if (!source.includes(":")) return source
  const candidates: Array<{ start: number; end: number; callee: string; open: number; close: number }> = []
  for (const match of source.matchAll(/\b(?:[A-Z][A-Za-z0-9_$]*\.)*[A-Z][A-Za-z0-9_$]*\s*\(/g)) {
    const start = match.index ?? 0
    const callee = /^(?:[A-Z][A-Za-z0-9_$]*\.)*[A-Z][A-Za-z0-9_$]*/.exec(match[0])?.[0]
    if (!callee) continue
    const previous = previousSignificantCharacter(source, start)
    const word = previousWord(source, start)
    const wordBeforeStar = previous === "*" ? previousWord(source, start - 2) : undefined
    if (previous === "." || word === "function" || word === "class" || word === "interface" || word === "type" || word === "new" || wordBeforeStar === "function") continue
    const open = source.indexOf("(", start + callee.length)
    const close = matching(source, open, "(", ")")
    const argumentSource = source.slice(open + 1, close)
    if (!splitTopLevel(argumentSource).some(argument => topLevelColon(argument) >= 0)) continue
    candidates.push({ start, end: close + 1, callee, open, close })
  }
  if (candidates.length === 0) return source
  if (candidates.length === 1) {
    const candidate = candidates[0]
    const value = `${candidate.callee}(${lowerArguments(source.slice(candidate.open + 1, candidate.close), candidate.callee.split(".").at(-1), registry)})`
    return source.slice(0, candidate.start) + value + source.slice(candidate.end)
  }

  // An outer labeled call owns any nested labeled calls in its arguments.
  // lowerArguments recursively lowers those isolated expressions, so only
  // the maximal candidates become edits and no overlapping slices are kept.
  const maximal: typeof candidates = []
  const active: typeof candidates = []
  for (const candidate of candidates) {
    while (active.length > 0 && candidate.start >= active.at(-1)!.end) active.pop()
    if (active.length === 0) maximal.push(candidate)
    active.push(candidate)
  }
  const edits = maximal
    .map(candidate => ({
      start: candidate.start,
      end: candidate.end,
      value: `${candidate.callee}(${lowerArguments(source.slice(candidate.open + 1, candidate.close), candidate.callee.split(".").at(-1), registry)})`,
    }))
    .sort((left, right) => right.start - left.start)
  let output = source
  for (const edit of edits) output = output.slice(0, edit.start) + edit.value + output.slice(edit.end)
  return output
}

/**
 * SwiftUI modifiers use argument labels even though their JavaScript runtime
 * implementation ultimately receives positional values or an option record.
 * Lower those labels before the source reaches TypeScript so authoring syntax
 * can stay SwiftUI-shaped without teaching TypeScript a second call grammar.
 */
function lowerNamedModifierCalls(source: string): string {
  let output = source
  let iterations = 0
  while (true) {
    if (++iterations > output.length + 1) throw syntaxError("Mun modifier argument lowering did not advance", 0)
    let candidate: { readonly name: string; readonly open: number; readonly close: number } | undefined
    for (let cursor = 0; cursor < output.length; cursor += 1) {
      const character = output[cursor]
      if (character === "\"" || character === "'" || character === "`") { cursor = skipString(output, cursor) - 1; continue }
      // Raw HTML may contain closing tags (`</span>`). Treat the complete tag
      // as an opaque token before the generic slash/regex scanner sees the
      // closing slash as a regular-expression opener.
      if (character === "<") {
        const html = rawHtmlAt(output, cursor)
        if (html) { cursor = html.end - 1; continue }
      }
      if (character === "/" && (output[cursor + 1] === "/" || output[cursor + 1] === "*")) { cursor = skipComment(output, cursor) - 1; continue }
      if (character === "/" && regexCanStart(output, cursor)) { cursor = skipRegex(output, cursor) - 1; continue }
      if (character !== ".") continue
      const identifier = identifierAt(output, cursor + 1)
      if (!identifier || !staticModifierNames.has(identifier.name) || !swiftUIModifierLowering(identifier.name)) continue
      const open = skipTrivia(output, identifier.end)
      if (output[open] !== "(") continue
      const close = matching(output, open, "(", ")")
      const argumentsSource = output.slice(open + 1, close)
      const contentTransitionShorthand = identifier.name === "contentTransition" && /^\s*\./.test(argumentsSource)
      if (!contentTransitionShorthand && !splitTopLevel(argumentsSource).some(argument => topLevelColon(argument) >= 0)) {
        cursor = close
        continue
      }
      candidate = { name: identifier.name, open, close }
      cursor = close
    }
    if (!candidate) return output

    const lowering = swiftUIModifierLowering(candidate.name)!
    const entries = splitTopLevel(output.slice(candidate.open + 1, candidate.close)).map(source => {
      const colon = topLevelColon(source)
      const label = colon < 0 ? undefined : source.slice(skipTrivia(source, 0), colon).trim()
      const validLabel = label && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(label) ? label : undefined
      return {
        label: validLabel,
        value: (validLabel ? source.slice(colon + 1) : source).trim(),
      }
    })
    const lowerCallback = (value: string, parameterized: boolean): string => {
      const source = value.trim()
      if (!source.startsWith("{") || matching(source, 0, "{", "}") !== source.length - 1) {
        return lowerImplicitMemberShorthand(lowerShorthand(source))
      }
      const body = source.slice(1, -1).trim()
      if (parameterized) {
        const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+in\s+([\s\S]*)$/.exec(body)
        if (match) return `(${match[1]}) => {${lowerRange(match[2])}}`
      }
      return `() => {${lowerRange(body)}}`
    }
    const lowerModifierValue = (value: string, label?: string): string => {
      if (candidate.name === "contentTransition") return lowerContentTransitionArgument(value)
      if (candidate.name === "onTapGesture" && label === "perform") return lowerCallback(value, false)
      if (candidate.name === "onLongPressGesture" && label === "perform") return lowerCallback(value, false)
      if (candidate.name === "onLongPressGesture" && label === "onPressingChanged") return lowerCallback(value, true)
      if (candidate.name === "onHover" && label === "perform") return lowerCallback(value, true)
      return lowerImplicitMemberShorthand(lowerShorthand(value))
    }
    const positional = entries.filter(entry => !entry.label).map(entry => lowerModifierValue(entry.value))
    const named = new Map<string, string>()
    for (const entry of entries) {
      if (!entry.label) continue
      if (named.has(entry.label)) throw syntaxError(`Duplicate labeled argument ${entry.label}: in .${candidate.name}(...)`, candidate.open)
      named.set(entry.label, lowerModifierValue(entry.value, entry.label))
    }

    let lowered: string
    if (lowering.kind === "object") {
      if (positional.length > 0) throw syntaxError(`.${candidate.name}(...) does not mix positional and labeled arguments in this overload`, candidate.open)
      for (const label of named.keys()) if (!lowering.labels.includes(label)) throw syntaxError(`Unknown labeled argument ${label}: in .${candidate.name}(...)`, candidate.open)
      lowered = `{ ${lowering.labels.flatMap(label => named.has(label) ? [`${label}: ${named.get(label)}`] : []).join(", ")} }`
    } else if (lowering.kind === "ordered") {
      for (const label of named.keys()) if (!lowering.labels.includes(label)) throw syntaxError(`Unknown labeled argument ${label}: in .${candidate.name}(...)`, candidate.open)
      lowered = [...positional, ...lowering.labels.flatMap(label => named.has(label) ? [named.get(label)!] : [])].join(", ")
    } else if (lowering.kind === "slots") {
      const allowed = new Set(lowering.labels.filter((label): label is string => label !== null))
      for (const label of named.keys()) if (!allowed.has(label)) throw syntaxError(`Unknown labeled argument ${label}: in .${candidate.name}(...)`, candidate.open)
      // Fill explicitly: sparse Array holes are skipped by .map(), which used
      // to serialize omitted leading Swift defaults as `.shadow(, 8)` instead
      // of the intentional `.shadow(undefined, 8)` runtime call.
      const slots = new Array<string | undefined>(lowering.labels.length).fill(undefined)
      let positionalIndex = 0
      for (let index = 0; index < lowering.labels.length; index += 1) {
        const label = lowering.labels[index]
        if (label !== null && named.has(label)) slots[index] = named.get(label)!
        else if (label === null && positionalIndex < positional.length) slots[index] = positional[positionalIndex++]
      }
      if (positionalIndex < positional.length) throw syntaxError(`Too many positional arguments in .${candidate.name}(...)`, candidate.open)
      let last = slots.length - 1
      while (last >= 0 && slots[last] === undefined) last -= 1
      lowered = Array.from({ length: last + 1 }, (_value, index) => slots[index] ?? "undefined").join(", ")
    } else {
      const allowed = new Set([...lowering.objectLabels, ...lowering.orderedLabels])
      for (const label of named.keys()) if (!allowed.has(label)) throw syntaxError(`Unknown labeled argument ${label}: in .${candidate.name}(...)`, candidate.open)
      const objectEntries = lowering.objectLabels.flatMap(label => named.has(label) ? [`${label}: ${named.get(label)}`] : [])
      if (objectEntries.length > 0 && positional.length > 0) throw syntaxError(`.${candidate.name}(...) cannot mix its x/y labeled overload with a positional scale`, candidate.open)
      lowered = [
        ...(objectEntries.length > 0 ? [`{ ${objectEntries.join(", ")} }`] : positional),
        ...lowering.orderedLabels.flatMap(label => named.has(label) ? [named.get(label)!] : []),
      ].join(", ")
    }
    output = output.slice(0, candidate.open + 1) + lowered + output.slice(candidate.close)
  }
}

function initializerRegistryFor(declarations: readonly MunStruct[]): Map<string, readonly SemanticInitializerSymbol[]> {
  const registry = new Map(canonicalInitializerSymbols)
  const add = (declaration: MunStruct): void => {
    registry.set(
      declaration.name,
      structInitializerPlans(declaration).map((plan, index) => semanticInitializerSymbol(declaration.name, plan, index)),
    )
    for (const nested of declaration.nested ?? []) add(nested)
  }
  for (const declaration of declarations) add(declaration)
  return registry
}

function lowerVueComponentImports(source: string): string {
  if (!/\.vue["']/.test(source)) return source
  const file = ts.createSourceFile("mun-vue-imports.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const existingNames = new Set<string>()
  const collectNames = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) existingNames.add(node.text)
    ts.forEachChild(node, collectNames)
  }
  collectNames(file)
  const replacements: Array<{ start: number; end: number; value: string }> = []
  let index = 0
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!/\.vue$/i.test(statement.moduleSpecifier.text) || statement.importClause?.isTypeOnly) continue
    const importedName = statement.importClause?.name?.text
      ?? (statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements.find(element => element.propertyName?.text === "default")?.name.text
        : undefined)
    if (!importedName) continue
    let adapterName = `__munForeignComponent${index++}`
    while (existingNames.has(adapterName)) adapterName = `__munForeignComponent${index++}`
    existingNames.add(adapterName)
    const quote = source[statement.moduleSpecifier.getStart(file)]
    const module = statement.moduleSpecifier.text
    const lineStart = source.lastIndexOf("\n", statement.getStart(file) - 1) + 1
    const indent = source.slice(lineStart, statement.getStart(file)).match(/^[ \t]*/)?.[0] ?? ""
    replacements.push({
      start: statement.getStart(file),
      end: statement.end,
      value: `${indent}import ${adapterName} from ${quote}${module}${quote}\n${indent}const ${importedName} = __munForeignComponent(${adapterName})`,
    })
  }
  if (replacements.length === 0) return source
  let result = source
  for (const replacement of replacements.reverse()) result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end)
  return `import { foreignComponent as __munForeignComponent } from "@mun/vue"\n${result}`
}

function lowerReactComponentImports(source: string): string {
  if (!/\.(?:tsx|jsx)["']/.test(source)) return source
  const file = ts.createSourceFile("mun-react-imports.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const existingNames = new Set<string>()
  const collectNames = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) existingNames.add(node.text)
    ts.forEachChild(node, collectNames)
  }
  collectNames(file)
  const replacements: Array<{ start: number; end: number; value: string }> = []
  let index = 0
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!/\.(?:tsx|jsx)$/i.test(statement.moduleSpecifier.text) || statement.importClause?.isTypeOnly) continue
    const importedName = statement.importClause?.name?.text
    if (!importedName) continue
    let adapterName = `__munReactComponent${index++}`
    while (existingNames.has(adapterName)) adapterName = `__munReactComponent${index++}`
    existingNames.add(adapterName)
    const quote = source[statement.moduleSpecifier.getStart(file)]
    const module = statement.moduleSpecifier.text
    const lineStart = source.lastIndexOf("\n", statement.getStart(file) - 1) + 1
    const indent = source.slice(lineStart, statement.getStart(file)).match(/^[ \t]*/)?.[0] ?? ""
    replacements.push({
      start: statement.getStart(file),
      end: statement.end,
      value: `${indent}import ${adapterName} from ${quote}${module}${quote}\n${indent}const ${importedName} = __munReactComponent(${adapterName})`,
    })
  }
  if (replacements.length === 0) return source
  let result = source
  for (const replacement of replacements.reverse()) result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end)
  return `import { reactComponent as __munReactComponent } from "@mun/react"\n${result}`
}

export function transformMunSource(source: string, fileName = "mun-source.ts"): string {
  const withVueImports = lowerVueComponentImports(source)
  const withForeignImports = lowerReactComponentImports(withVueImports)
  const withAnimationArguments = lowerNamedAnimationFactoryCalls(withForeignImports)
  const withModifierArguments = lowerNamedModifierCalls(withAnimationArguments)
  const declarations = parseMunStructs(withModifierArguments)
  const registry = initializerRegistryFor(declarations)
  // Button validation and struct dependency proof both need the same pre-lowered
  // TypeScript syntax snapshot. Build it at most once and share it rather than
  // reparsing the module independently in two compiler stages.
  const needsValidationSyntax = declarations.length > 0 || /\bButton\s*\(/.test(withModifierArguments)
  const validationSyntax = needsValidationSyntax ? validationSourceFile(withModifierArguments) : undefined
  validateKnownCalls(parseMunBuilder(withModifierArguments), registry)
  validateKnownTypeScriptCalls(withModifierArguments, registry, validationSyntax)
  for (const declaration of declarations) {
    validateKnownCalls(parseMunBuilder(declaration.bodyExpressionSource, declaration.bodyExpressionRange.start), registry)
  }
  const structStateProof = declarations.length > 0 && validationSyntax
    ? importedMunValueBindings(validationSyntax)
    : undefined
  const withStructs = lowerStructs(withModifierArguments, registry, structStateProof)
  const withNamedArguments = lowerNamedMunCalls(withStructs, registry)
  const withBuilderSyntax = lowerRange(withNamedArguments, registry)
  // State ownership is resolved only after Mun-only syntax has become valid
  // TypeScript. This lets the TypeScript AST see complete view() arguments
  // instead of truncating them at trailing builder blocks.
  const lowered = lowerTopLevelState(withBuilderSyntax)
  // Capture common authored collection rows before any later specialization
  // turns Text/Element calls into more opaque compiled templates. A second
  // collection pass below still picks up shapes exposed by constant folding
  // or static struct specialization.
  const withStateArrayMaps = lowerStateArrayMaps(lowered)
  const withAuthoredCollections = lowerCompiledCollections(withStateArrayMaps)
  const withStaticResults = foldStaticResults(withAuthoredCollections)
  const withStaticStructCalls = lowerStaticStructCalls(withStaticResults, declarations)
  // Collection planning must see authored Text/Element rows before general
  // semantic specialization lowers those calls into templates. Otherwise
  // making a core View canonical can accidentally disable the faster keyed
  // flat-row plan. The fallback closure may still be specialized afterwards.
  const withCompiledCollections = lowerCompiledCollections(withStaticStructCalls)
  const withCanonicalCalls = lowerStaticCanonicalCalls(withCompiledCollections)
  const withSemanticSpecializations = lowerStaticSemanticSpecializations(withCanonicalCalls, fileName)
  const withCompiledTemplates = lowerCompiledViewTemplates(withSemanticSpecializations)
  // Hoisting only needs the imports authored/retained by the source. Injecting
  // compiler helper imports first makes the final static pass parse a larger
  // module and can only add irrelevant bindings to its candidate set.
  const withStaticHoists = hoistStaticViewSubtrees(withCompiledTemplates)
  return ensureImports(withStaticHoists, /\.mun$/i.test(fileName))
}

function hasNamedMunArguments(source: string): boolean {
  const calls = /\b[A-Z][A-Za-z0-9_$]*\s*\(/g
  let match: RegExpExecArray | null
  while ((match = calls.exec(source))) {
    const open = source.indexOf("(", match.index)
    const close = matching(source, open, "(", ")")
    if (previousWord(source, match.index) === "function") {
      calls.lastIndex = close + 1
      continue
    }
    if (splitTopLevel(source.slice(open + 1, close)).some(argument => topLevelColon(argument) >= 0)) return true
    calls.lastIndex = close + 1
  }
  return false
}

function hasBindingShorthand(source: string): boolean {
  return lowerShorthand(source) !== source
}

function hasStaticModifierSyntax(source: string): boolean {
  return Array.from(staticModifierNames).some(name => new RegExp(`\\.${name}\\s*\\(`).test(source))
}

export function hasMunSyntax(source: string, allowRawHtml = true): boolean {
  return /\bstruct\s+[A-Z][A-Za-z0-9_$]*(?:\s*<[^>{}]*>)?\s*:\s*View/.test(source)
    || (allowRawHtml && findRawHtml(source) !== undefined)
    || findBuilder(source, 0, true) !== undefined
    || hasBindingShorthand(source)
    || hasNamedMunArguments(source)
    || hasStaticModifierSyntax(source)
}
