import assert from "node:assert/strict"
import test from "node:test"
import { Icon, VectorSymbol } from "../packages/core/dist/index.js"
import { render } from "../packages/react/dist/index.js"
import { renderToStaticMarkup } from "react-dom/server"

const html = view => renderToStaticMarkup(render(view))
const nodes = [["path", { d: "M0 0L24 24" }]]

test("Icon adapts URLs, SVG nodes, symbols and Lucide data", () => {
  assert.match(html(Icon("/icon.svg", { alt: "Logo" })), /alt="Logo"/)
  for (const source of [nodes, VectorSymbol.fromSVGNodes(nodes), { name: "test", node: nodes }]) {
    const output = html(Icon(source))
    assert.match(output, /<svg/)
    assert.match(output, /aria-hidden="true"/)
    assert.match(output, /d="M0 0L24 24"/)
  }
  assert.match(html(Icon(nodes, { alt: "Menu" })), /aria-label="Menu"/)
})

test("Icon uses the standard modifier pipeline", () => {
  const output = html(Icon({ name: "test", node: nodes }).foregroundStyle("red").frame({ width: 24, height: 24 }).padding(4).opacity(0.5))
  assert.match(output, /color:red/)
  assert.match(output, /stroke="currentColor"/)
  assert.match(output, /width:24px/)
  assert.match(output, /padding:4px/)
  assert.match(output, /opacity:0.5/)
})
