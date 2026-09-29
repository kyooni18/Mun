import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import * as core from "../packages/core/dist/compat.js"
import * as nodes from "../packages/core/dist/graph/nodes.js"
import * as modifiers from "../packages/core/dist/graph/modifiers.js"
import * as renderer from "../packages/core/dist/graph/renderer.js"
import * as initializers from "../packages/core/dist/graph/initializers.js"

test("the graph barrel preserves focused node, modifier, renderer, and initializer boundaries", () => {
  assert.strictEqual(core.viewElement, nodes.viewElement)
  assert.strictEqual(core.compiledTemplate, nodes.compiledTemplate)
  assert.strictEqual(core.defineCompiledTemplate, nodes.defineCompiledTemplate)
  assert.strictEqual(core.ForeignComponent, nodes.ForeignComponent)
  assert.strictEqual(core.modifiedContent, modifiers.modifiedContent)
  assert.strictEqual(core.modifier, modifiers.modifier)
  assert.strictEqual(core.renderViewNode, renderer.renderViewNode)
  assert.strictEqual(core.resolveInitializer, initializers.resolveInitializer)
  assert.strictEqual(core.ViewType, initializers.ViewType)

  const value = nodes.viewElement("section", { "data-boundary": "nodes" }, ["content"])
  const modified = modifiers.modifier(value, "className", "focused")
  assert.equal(modified.kind, "modified")
  assert.deepEqual(modifiers.modifierGraphOf(modified).map(item => item.name), ["className"])
})

test("focused graph modules remain renderer-neutral", () => {
  for (const name of ["nodes.js", "modifiers.js", "renderer.js", "initializers.js"]) {
    const source = readFileSync(new URL(`../packages/core/dist/graph/${name}`, import.meta.url), "utf8")
    assert.doesNotMatch(source, /(?:^|[\\"'])react(?:[-/][^\\"']*)?[\\"']/i, name)
  }
})
