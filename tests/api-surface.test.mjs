import assert from "node:assert/strict"
import { resolve } from "node:path"
import test from "node:test"
import ts from "typescript"
import * as compiler from "../packages/compiler/dist/index.js"
import * as core from "../packages/core/dist/index.js"
import * as compat from "../packages/core/dist/compat.js"
import * as mun from "../dist/index.js"
import * as react from "../packages/react/dist/index.js"
import * as vue from "../packages/vue/dist/index.js"
import * as web from "../packages/web/dist/index.js"

const canonicalRuntimeExports = [
  "Animation",
  "Color",
  "LinearGradient",
  "SemanticModel",
  "Transaction",
  "Transition",
  "actionClosure",
  "closureForKind",
  "closureKindOf",
  "closureVariantsOf",
  "currentTransaction",
  "markMunClosure",
  "munClosureKind",
  "munClosureVariants",
  "munMotionPropertyBit",
  "munMotionPropertyMask",
  "munMotionPropertyNames",
  "overloadClosure",
  "resolveSemanticCall",
  "resolveSemanticInitializer",
  "snapshotTransaction",
  "swiftUIAnimationFactoryArgumentLabels",
  "valueClosure",
  "viewBuilderClosure",
  "withAnimation",
  "withTransaction",
].sort()

function declarationExports(path) {
  const file = resolve(path)
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
  })
  const source = program.getSourceFile(file)
  assert.ok(source, `missing declaration entry point: ${path}`)
  const checker = program.getTypeChecker()
  const symbol = checker.getSymbolAtLocation(source)
  assert.ok(symbol, `missing declaration module symbol: ${path}`)
  return checker.getExportsOfModule(symbol).map(item => item.name).sort()
}

test("canonical runtime exports are backend-neutral", () => {
  assert.deepEqual(Object.keys(core).sort(), canonicalRuntimeExports)
  assert.deepEqual(Object.keys(mun).sort(), canonicalRuntimeExports)

  for (const name of [
    "Element",
    "Text",
    "State",
    "MunInitializerError",
    "semanticHtmlTagNames",
    "mount",
    "renderToHTML",
  ]) {
    assert.equal(name in core, false)
  }
})

test("compatibility graph is explicit and renderer adapters consume it", () => {
  for (const name of ["Element", "Text", "State", "VStack", "viewElement", "renderViewNode"]) {
    assert.equal(typeof compat[name], "function")
  }
  assert.equal(react.Text, compat.Text)
  assert.equal(react.Element, compat.Element)
  assert.equal(typeof react.render, "function")
  assert.equal(typeof vue.render, "function")
})

test("Web and compiler surfaces expose semantic IR routes without redefining core", () => {
  assert.deepEqual(Object.keys(web).sort(), [
    "mount",
    "renderMunUiProgramToHTML",
    "renderToHTML",
  ])

  for (const name of [
    "compileMunFile",
    "compileMunUiProgram",
    "createMunSemanticModel",
    "diagnoseMunSource",
    "transformMunSource",
  ]) {
    assert.equal(typeof compiler[name], "function")
  }

  for (const stale of [
    "semanticHtmlAttributeNames",
    "semanticHtmlAttributeSpec",
    "semanticHtmlTagNames",
    "semanticHtmlTagSpec",
  ]) {
    assert.equal(stale in compiler, false)
  }
})

test("canonical declaration surfaces contain Semantic UI IR and exclude browser graph contracts", () => {
  const coreDeclarations = declarationExports("packages/core/dist/index.d.ts")
  for (const name of [
    "MunUiProgram",
    "MunUiNode",
    "MunUiExpression",
    "MunUiLayout",
    "MunUiVisual",
    "MunUiTransaction",
  ]) {
    assert.ok(coreDeclarations.includes(name), `${name} should be exported by canonical core declarations`)
  }

  for (const name of [
    "Element",
    "MunDOMEvent",
    "MunHtmlTagName",
    "MunStyleProperties",
    "SemanticHtmlElementSymbol",
  ]) {
    assert.equal(coreDeclarations.includes(name), false, `${name} belongs outside canonical core`)
  }

  const compilerDeclarations = declarationExports("packages/compiler/dist/index.d.ts")
  assert.ok(compilerDeclarations.includes("compileMunUiProgram"))
  assert.equal(compilerDeclarations.some(name => name.startsWith("SemanticHtml") || name.startsWith("MunSemanticHtml")), false)

  const compatDeclarations = declarationExports("packages/core/dist/compat.d.ts")
  assert.ok(compatDeclarations.includes("Element"))
  assert.ok(compatDeclarations.includes("MunHtmlTagName"))
})
