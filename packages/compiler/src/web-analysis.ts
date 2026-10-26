import * as ts from "typescript"
import { parseMunBuilder, type MunBuilderProgram, type MunStructDeclaration } from "./ast.js"
import type { SemanticInitializerSymbol } from "@mun/core"
import { createMunSourceMap, mapGeneratedPosition } from "./source-map.js"

function fail(message: string, offset: number): never {
  throw Object.assign(new SyntaxError(message), { offset, code: "MUN_SYNTAX" })
}

/** Validate source-owned binding roles before lowering changes their locations. */
export function validateWebBindings(
  declarations: readonly MunStructDeclaration[],
  registry: ReadonlyMap<string, readonly SemanticInitializerSymbol[]>,
): void {
  for (const declaration of declarations) {
    const fields = new Map(declaration.fields.map(field => [field.name, field]))
    const visit = (program: MunBuilderProgram): void => {
      for (const node of program.statements) {
        if (node.kind === "conditional") {
          visit(node.then)
          if (node.otherwise) visit(node.otherwise.kind === "program" ? node.otherwise : { ...node.then, statements: [node.otherwise] })
        } else if (node.kind === "call") {
          for (const [index, argument] of node.arguments.entries()) {
            if (argument.value.kind === "closure") { visit(argument.value.body); continue }
            const name = argument.value.source.trim()
            const field = fields.get(name)
            const candidates = registry.get(node.callee) ?? []
            const parameters = candidates.flatMap(candidate => {
              const parameter = argument.label ? candidate.parameters.find(item => item.label === argument.label) : candidate.parameters[index]
              return parameter ? [parameter] : []
            })
            if (field && parameters.length > 0 && parameters.every(parameter => parameter.kind === "binding")) {
              fail(`${node.callee} requires a Binding; '${name}' is a value. Pass $${name}.`, argument.value.range.start)
            }
          }
          if (node.trailing) visit(node.trailing.body)
        }
      }
    }
    visit(parseMunBuilder(declaration.bodyExpressionSource, declaration.bodyExpressionRange.start))
    validateWebBindings(declaration.nested ?? [], registry)
  }
}

/** Shared web compilation/diagnostic check, independent of DOM versus SSR. */
export function validateWebLowering(source: string, generated: string, fileName: string): void {
  const file = ts.createSourceFile(fileName + ".ts", generated, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const at = (offset: number): number => {
    const position = file.getLineAndCharacterOfPosition(offset)
    const mapped = mapGeneratedPosition(createMunSourceMap(source, generated, fileName), { line: position.line + 1, column: position.character + 1 })
    const lines = source.split("\n")
    return lines.slice(0, mapped.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + mapped.column - 1
  }
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []
  if (diagnostics[0]) fail(`Unsupported or invalid Mun syntax: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " ")}`, at(diagnostics[0].start ?? 0))
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) {
      let owner: ts.Node | undefined = node.parent
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
      if (!owner || !ts.canHaveModifiers(owner) || !ts.getModifiers(owner)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
        fail("await requires an async func or async closure; use .task for View-owned asynchronous work.", at(node.getStart(file)))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
}
