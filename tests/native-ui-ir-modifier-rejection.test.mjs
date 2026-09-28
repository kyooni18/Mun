import assert from "node:assert/strict"
import test from "node:test"

import { compileMunUiProgram } from "../packages/compiler/dist/index.js"

test("native modifier lowering rejects parameters outside its semantic subset", () => {
  const unsupportedFrameParameter = `import { Rectangle } from "@mun/core"
struct App: View {
  var body: some View {
    Rectangle().frame(minWidth: 120)
  }
}
export default App()`

  assert.throws(
    () => compileMunUiProgram(unsupportedFrameParameter, "unsupported-frame-parameter.mun"),
    /View modifier '\.frame' argument 'minWidth' is not representable in native Semantic UI IR/,
  )

  const ignoredCornerRadiusParameter = `import { Rectangle } from "@mun/core"
struct App: View {
  var body: some View {
    Rectangle().cornerRadius(12, antialiased: true)
  }
}
export default App()`

  assert.throws(
    () => compileMunUiProgram(ignoredCornerRadiusParameter, "unsupported-corner-radius-parameter.mun"),
    /View modifier '\.cornerRadius' argument 'antialiased' is not representable in native Semantic UI IR/,
  )
})
