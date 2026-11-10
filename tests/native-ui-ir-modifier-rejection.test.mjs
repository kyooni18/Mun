import assert from "node:assert/strict"
import test from "node:test"

import { compileMunUiProgram } from "../packages/compiler/dist/index.js"

test("native modifier lowering preserves supported frame and corner-radius parameters", () => {
  const unsupportedFrameParameter = `import { Rectangle } from "@mun-ui/core"
struct App: View {
  var body: some View {
    Rectangle().frame(minWidth: 120)
  }
}
export default App()`

  const panel = compileMunUiProgram(unsupportedFrameParameter, "supported-frame-parameter.mun").root.child
  assert.equal(panel.kind, "panel")
  assert.equal(panel.layout.minWidth, 120)

  const ignoredCornerRadiusParameter = `import { Rectangle } from "@mun-ui/core"
struct App: View {
  var body: some View {
    Rectangle().cornerRadius(12, antialiased: true)
  }
}
export default App()`

  const rounded = compileMunUiProgram(ignoredCornerRadiusParameter, "supported-corner-radius-parameter.mun").root.child
  assert.equal(rounded.kind, "panel")
  assert.equal(rounded.visual.cornerRadius, 12)
})


test("native frame ideals and layout priority survive semantic compilation", () => {
  const source = `@main
struct App: View {
  var body: some View {
    Text("Priority").frame(idealWidth: 140, idealHeight: 38).layoutPriority(2)
  }
}`
  const node = compileMunUiProgram(source, "ideal-priority.mun").root.child
  assert.equal(node.layout?.idealWidth, 140)
  assert.equal(node.layout?.idealHeight, 38)
  assert.equal(node.layout?.layoutPriority, 2)
})
