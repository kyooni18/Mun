import * as ts from "typescript"
import { createMunSourceMap, mapGeneratedPosition } from "./source-map.js"
import { createSemanticModel } from "./semantic.js"
import { transformMunSource } from "./pipeline.js"
import { matching, regexCanStart, skipComment, skipRegex, skipString, validateRawHtmlSyntax } from "./scanner.js"
import type { MunDiagnostic } from "./types.js"



function isMunPackageSource(value: string): boolean {
  return value.startsWith("@mun/")
}

function unwrapDiagnosticExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)) current = current.expression
  return current
}

function topLevelStateScopeDiagnostics(source: string): MunDiagnostic[] {
  const file = ts.createSourceFile("mun-state-scope.mun.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const stateNames = new Set<string>()
  const namespaces = new Set<string>()
  let blockedCanonicalState = false

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause && ts.isStringLiteral(statement.moduleSpecifier)) {
      const fromMun = isMunPackageSource(statement.moduleSpecifier.text)
      const bindings = statement.importClause.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text
          if (fromMun && imported === "State") stateNames.add(element.name.text)
          else if (!fromMun && element.name.text === "State") blockedCanonicalState = true
        }
      } else if (bindings && ts.isNamespaceImport(bindings) && fromMun) {
        namespaces.add(bindings.name.text)
      }
      if (statement.importClause.name?.text === "State") blockedCanonicalState = true
      continue
    }
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === "State") blockedCanonicalState = true
    if (ts.isClassDeclaration(statement) && statement.name?.text === "State") blockedCanonicalState = true
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === "State") blockedCanonicalState = true
      }
    }
  }

  const isStateCall = (expression: ts.Expression): boolean => {
    const unwrapped = unwrapDiagnosticExpression(expression)
    if (!ts.isCallExpression(unwrapped)) return false
    const callee = unwrapDiagnosticExpression(unwrapped.expression)
    if (ts.isIdentifier(callee)) {
      if (stateNames.has(callee.text)) return true
      return callee.text === "State" && stateNames.size === 0 && !blockedCanonicalState
    }
    return ts.isPropertyAccessExpression(callee)
      && callee.name.text === "State"
      && ts.isIdentifier(callee.expression)
      && namespaces.has(callee.expression.text)
  }

  const diagnostics: MunDiagnostic[] = []
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const exported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer || !isStateCall(declaration.initializer)) continue
      if (!exported && isConst && ts.isIdentifier(declaration.name)) continue
      const name = ts.isIdentifier(declaration.name) ? declaration.name.text : declaration.name.getText(file)
      const reason = exported
        ? "is exported"
        : !isConst
          ? "is mutable (let/var)"
          : "uses a destructuring binding"
      const start = declaration.name.getStart(file)
      const position = file.getLineAndCharacterOfPosition(start)
      diagnostics.push({
        severity: "warning",
        code: "MUN_STATE_SCOPE",
        message: `Top-level State ${JSON.stringify(name)} ${reason}, so it remains module-shared instead of becoming View instance-local.`,
        line: position.line + 1,
        column: position.character + 1,
      })
    }
  }
  return diagnostics
}

export function diagnoseMunSource(source: string): readonly MunDiagnostic[] {
  try {
    validateRawHtmlSyntax(source)
    for (let cursor = 0; cursor < source.length; cursor += 1) {
      if (source[cursor] === "\"" || source[cursor] === "'" || source[cursor] === "`") cursor = skipString(source, cursor) - 1
      else if (source[cursor] === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*")) cursor = skipComment(source, cursor) - 1
      else if (source[cursor] === "/" && regexCanStart(source, cursor)) cursor = skipRegex(source, cursor) - 1
      else if (source[cursor] === "(") matching(source, cursor, "(", ")")
      else if (source[cursor] === "{") matching(source, cursor, "{", "}")
    }
    const fileName = "mun-source.mun.ts"
    const generatedSource = transformMunSource(source, fileName)
    const model = createSemanticModel(source, fileName, generatedSource)
    const map = createMunSourceMap(source, generatedSource, fileName)
    const typescriptDiagnostics = model.typescriptDiagnostics.map(diagnostic => {
      const start = diagnostic.start ?? 0
      const position = model.typescript.getLineAndCharacterOfPosition(start)
      const mapped = mapGeneratedPosition(map, { line: position.line + 1, column: position.character + 1 })
      return {
        severity: "error" as const,
        code: "MUN_TYPESCRIPT" as const,
        message: tsDiagnosticMessage(diagnostic),
        line: mapped.line,
        column: mapped.column,
      }
    })
    const initializerDiagnostics = model.calls.flatMap(call => call.resolution.diagnostics.map(diagnostic => {
      const position = sourcePositionAt(source, call.range.start)
      return {
        severity: "error" as const,
        // Keep the public diagnostic code stable while preserving ambiguity
        // as a richer code in the shared semantic call result.
        code: "MUN_INITIALIZER" as const,
        message: diagnostic.message,
        line: position.line,
        column: position.column,
      }
    }))
    return [...typescriptDiagnostics, ...initializerDiagnostics, ...topLevelStateScopeDiagnostics(source)]
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const offset = typeof error === "object" && error !== null && "offset" in error && typeof error.offset === "number" ? error.offset : 0
    const code = typeof error === "object" && error !== null && "code" in error && error.code === "MUN_INITIALIZER"
      ? "MUN_INITIALIZER" as const
      : "MUN_SYNTAX" as const
    const before = source.slice(0, offset)
    return [{ severity: "error", code, message, line: before.split("\n").length, column: offset - before.lastIndexOf("\n") }]
  }
}

function tsDiagnosticMessage(diagnostic: { readonly messageText: unknown }): string {
  if (typeof diagnostic.messageText === "string") return diagnostic.messageText
  if (!diagnostic.messageText || typeof diagnostic.messageText !== "object") return String(diagnostic.messageText)
  const chain = diagnostic.messageText as { readonly messageText?: unknown; readonly next?: readonly { readonly messageText?: unknown }[] }
  return [chain.messageText, ...(chain.next ?? []).map(item => item.messageText)].filter(Boolean).join(" ")
}

function sourcePositionAt(source: string, offset: number): { line: number; column: number } {
  const bounded = Math.max(0, Math.min(source.length, offset))
  const lines = source.slice(0, bounded).split("\n")
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
}
