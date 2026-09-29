import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  Component,
  List,
  Section,
  Text,
  VStack,
  render,
} from "../packages/react/dist/index.js"

function Badge({ label }) {
  return createElement("strong", null, label)
}

test("migrated collection primitives compose graph children", () => {
  const html = renderToStaticMarkup(render(VStack(
    Section("Header", () => Text("Body")),
    List(() => [Text("One"), Text("Two")]),
  )))
  assert.match(html, /data-mun="Section"/)
  assert.match(html, /Header.*Body/)
  assert.match(html, /<ul data-mun="List"/)
})

test("React interop enters the same graph before materialization", () => {
  const value = VStack(Component(Badge, { label: "Mun" }))
  assert.equal(value.kind, "element")
  assert.match(renderToStaticMarkup(render(value)), /<strong>Mun<\/strong>/)
})
