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
  const expanded = renderMunUiProgramToHTML(program, { state: { expanded: true } })

  assert.match(collapsed, /<button type="button"/)
  assert.match(collapsed, />Toggle<\/button>/)
  assert.match(collapsed, /width:160px/)
  assert.match(expanded, /width:320px/)
  assert.match(collapsed, /data-mun-motion-mask="512"/)
  assert.equal(JSON.stringify(program).includes("<button"), false)
})
