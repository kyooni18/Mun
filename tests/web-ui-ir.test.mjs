import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import { compileMunUiProgram } from "../packages/compiler/dist/index.js"
import { renderMunUiProgramToHTML } from "../packages/web/dist/index.js"

test("web backend lowers the same semantic UI IR instead of defining Mün semantics", () => {
  const file = new URL("../examples/NativeDemo.mun", import.meta.url)
  const source = fs.readFileSync(file, "utf8")
  const program = compileMunUiProgram(source, file.pathname)
  const collapsed = renderMunUiProgramToHTML(program)
  const expandedState = program.states.find(item => item.name.endsWith("/expanded"))?.name
  assert.ok(expandedState)
  const expanded = renderMunUiProgramToHTML(program, { state: { [expandedState]: true } })

  assert.match(collapsed, /<button type="button"/)
  assert.match(collapsed, />Toggle<\/button>/)
  assert.match(collapsed, /width:160px/)
  assert.match(expanded, /width:320px/)
  assert.match(collapsed, /data-mun-motion-mask="512"/)
  assert.equal(JSON.stringify(program).includes("<button"), false)
})


test("web backend preserves native overlay semantics from shared IR", () => {
  const file = new URL("../examples/NativeLayoutStyle.mun", import.meta.url)
  const source = fs.readFileSync(file, "utf8")
  const program = compileMunUiProgram(source, file.pathname)
  const html = renderMunUiProgramToHTML(program)

  assert.match(html, /display:grid/)
  assert.match(html, /align-items:center/)
  assert.match(html, /justify-items:center/)
  assert.equal((html.match(/grid-area:1 \/ 1/g) ?? []).length, 2)
  assert.match(html, /background:#112233/)
  assert.match(html, /border-radius:12px/)
})
