import * as ts from "typescript"
import { matching, skipComment, skipString } from "./scanner.js"

/**
 * Swift string interpolation: `"Count: \(count)"` becomes a template literal.
 * Only double-quoted strings that contain `\(` are rewritten; every other
 * string, template, and comment is copied verbatim.
 */
export function lowerSwiftInterpolation(source: string): string {
  if (!source.includes("\\(")) return source
  let output = ""
  let cursor = 0
  while (cursor < source.length) {
    const character = source[cursor]
    if (character === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*")) {
      const end = skipComment(source, cursor)
      output += source.slice(cursor, end)
      cursor = end
      continue
    }
    if (character === "'" || character === "`") {
      const end = skipString(source, cursor)
      output += source.slice(cursor, end)
      cursor = end
      continue
    }
    if (character !== "\"") { output += character; cursor += 1; continue }
    const end = skipString(source, cursor)
    const literal = source.slice(cursor, end)
    output += literal.includes("\\(") ? interpolatedTemplate(literal) : literal
    cursor = end
  }
  return output
}

function interpolatedTemplate(literal: string): string {
  const body = literal.slice(1, -1)
  let output = "`"
  let cursor = 0
  while (cursor < body.length) {
    const character = body[cursor]
    if (character === "\\" && body[cursor + 1] === "(") {
      const close = matching(body, cursor + 1, "(", ")")
      output += "${" + lowerSwiftInterpolation(body.slice(cursor + 2, close)) + "}"
      cursor = close + 1
      continue
    }
    if (character === "\\") { output += body.slice(cursor, cursor + 2); cursor += 2; continue }
    if (character === "`") output += "\\`"
    else if (character === "$" && body[cursor + 1] === "{") output += "\\$"
    else output += character
    cursor += 1
  }
  return output + "`"
}

function declaresName(node: ts.Node, name: string): boolean {
  let found = false
  const visitName = (binding: ts.BindingName): void => {
    if (ts.isIdentifier(binding)) { if (binding.text === name) found = true; return }
    for (const element of binding.elements) if (!ts.isOmittedExpression(element)) visitName(element.name)
  }
  if (ts.isFunctionLike(node)) for (const parameter of node.parameters) visitName(parameter.name)
  if (ts.isBlock(node) || ts.isSourceFile(node)) {
    for (const statement of node.statements) {
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) visitName(declaration.name)
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) found = true
    }
  }
  if ((ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
    for (const declaration of node.initializer.declarations) visitName(declaration.name)
  }
  if (ts.isCatchClause(node) && node.variableDeclaration) visitName(node.variableDeclaration.name)
  return found
}

function isStorageReference(node: ts.Identifier, stop: ts.Node): boolean {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
  // `count.value` is the explicit storage spelling and stays valid.
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "value") return false
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return false
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) && parent.name === node) return false
  // `$count` lowers to `Binding(count)`, which needs the storage itself.
  if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "Binding" && parent.arguments[0] === node) return false
  for (let scope: ts.Node = parent; scope !== stop; scope = scope.parent) {
    if (ts.isTypeNode(scope)) return false
    if (declaresName(scope, node.text)) return false
  }
  return true
}

/**
 * SwiftUI reads and writes `@State`/`@Binding` members as plain values:
 * `Text("\(count)")`, `count += 1`. Rewrite those references in a lowered
 * struct body to the member's storage (`count.value`). Explicit `.value`,
 * `$count` projections, shadowing locals, and member names are left alone.
 */
export function lowerStructStateAccess(source: string, names: ReadonlySet<string>): string {
  if (names.size === 0) return source
  const prefix = "const __munBody = ("
  const file = ts.createSourceFile("mun-struct-state.ts", `${prefix}${source})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  if (((file as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length ?? 0) > 0) return source
  const edits: { start: number; end: number; text: string }[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isShorthandPropertyAssignment(node) && names.has(node.name.text) && isStorageReference(node.name, file)) {
      edits.push({ start: node.name.getStart(file), end: node.name.end, text: `${node.name.text}: ${node.name.text}.value` })
      return
    }
    if (ts.isIdentifier(node) && names.has(node.text) && isStorageReference(node, file)) {
      edits.push({ start: node.end, end: node.end, text: ".value" })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  let output = `${prefix}${source})`
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
  }
  return output.slice(prefix.length, -1)
}
