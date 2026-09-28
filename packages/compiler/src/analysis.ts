import * as ts from "typescript"
import { createSemanticModel } from "./semantic.js"
import { transformMunSource } from "./pipeline.js"
import { findRawHtml, validateRawHtmlSyntax } from "./scanner.js"

export interface MunSourceAnalysis {
  readonly interactive: boolean
  readonly usesState: boolean
  readonly usesBinding: boolean
  readonly usesAction: boolean
  readonly usesClientEffect: boolean
}


const stateCallNames = new Set([
  "State",
  "Binding",
  "FocusState",
  "GestureState",
  "ObservedObject",
  "StateObject",
  "EnvironmentObject",
])

const clientEffectNames = new Set([
  "onAppear",
  "onDisappear",
  "onChange",
  "onReceive",
  "onTapGesture",
  "onLongPressGesture",
  "onHover",
  "onSubmit",
  "task",
  "refreshable",
  "gesture",
  "simultaneousGesture",
  "highPriorityGesture",
  "focused",
])

function canonicalFile(fileName: string): boolean {
  return /\.mun$/i.test(fileName) && !/\.mun\.[cm]?[jt]sx?$/i.test(fileName)
}


export function assertCanonicalMunSource(source: string, fileName = "mun-source.mun"): void {
  if (!canonicalFile(fileName)) return
  validateRawHtmlSyntax(source)
  const rawHtml = findRawHtml(source)
  if (!rawHtml) return
  const error = new SyntaxError("Raw HTML is not part of the Mün language. Use Mün Views instead.") as SyntaxError & { offset: number }
  error.offset = rawHtml.start
  throw error
}


export function analyzeMunSource(source: string, fileName = "mun-source.mun"): MunSourceAnalysis {
  assertCanonicalMunSource(source, fileName)
  const generated = transformMunSource(source, fileName)
  const semantic = createSemanticModel(source, fileName, generated)
  const file = ts.createSourceFile(fileName, generated, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  let usesState = false
  let usesBinding = false
  let usesClientEffect = false

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      const name = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : undefined
      if (name && stateCallNames.has(name)) {
        usesState = true
        if (name === "Binding") usesBinding = true
      }
      if (name && clientEffectNames.has(name)) usesClientEffect = true
    }
    ts.forEachChild(node, visit)
  }
  visit(file)


  const usesAction = semantic.calls.some(call =>
    call.resolution.closureRoles.some(role => role === "action" || role === "binding"),
  )

  return {
    interactive: usesState || usesBinding || usesAction || usesClientEffect,
    usesState,
    usesBinding,
    usesAction,
    usesClientEffect,
  }
}
