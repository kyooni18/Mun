import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { renderToStaticMarkup } from "react-dom/server"
import { createSSRApp } from "vue"
import { renderToString } from "@vue/server-renderer"
import * as core from "../packages/core/dist/compat.js"
import { transformMunSource } from "../packages/compiler/dist/index.js"
import { render as renderReact } from "../packages/react/dist/index.js"
import { render as renderVue } from "../packages/vue/dist/index.js"
import { mount, renderToHTML } from "../packages/web/dist/index.js"

function compileExpression(source, bindings = {}) {
  const output = transformMunSource(source, "Regression.mun.ts")
  const expression = output.replace(/^import[^\n]+\n/gm, "")
  const scope = { ...core, ...bindings }
  return new Function(...Object.keys(scope), `return (${expression})`)(...Object.values(scope))
}

async function outputs(value) {
  return [renderToStaticMarkup(renderReact(value)), await renderToString(createSSRApp({ render: () => renderVue(value) })), renderToHTML(value)]
}

test("compiled frame keeps stack layout inside its alignment wrapper in every renderer", async () => {
  for (const name of ["HStack", "VStack"]) {
    const value = compileExpression(`${name}() { Text("A"); Text("B") }.frame(width: 240, height: 80)`)
    for (const html of await outputs(value)) {
      const document = new JSDOM(html).window.document
      const stack = document.querySelector(`[data-mun="${name}"]`)
      assert.equal(stack.style.display, "flex")
      assert.equal(stack.style.flexDirection, name === "HStack" ? "row" : "column")
      assert.equal(stack.parentElement.style.width, "240px")
      assert.equal(stack.parentElement.style.height, "80px")
      assert.equal(stack.children.length, 2)
    }
  }
})

test("zIndex preserves fixed overlay positioning in both modifier orders", async () => {
  for (const value of [core.Text("Overlay").style({ position: "fixed" }).zIndex(50), core.Text("Overlay").zIndex(50).style({ position: "fixed" })]) {
    for (const html of await outputs(value)) {
      const element = new JSDOM(html).window.document.body.firstElementChild
      assert.equal(element.style.position, "fixed")
      assert.equal(element.style.zIndex, "50")
    }
  }
})

test("adjacent compiled conditionals retain the sidebar when the sheet closes", async () => {
  const dom = new JSDOM("<div id='app'></div>", { pretendToBeVisual: true })
  const target = dom.window.document.querySelector("#app")
  const sheet = core.State(true)
  const sidebar = core.State(true)
  const build = compileExpression(`() => VStack() {
    if (sheet.value) { Text("Settings"); Text("Sheet content") }
    if (sidebar.value) { Text("Sidebar"); Text("Sidebar content") }
  }`, { sheet, sidebar })
  const Host = core.defineView("ConditionalRegression", {
    initializers: [core.initializer("ConditionalRegression()", args => args.length === 0)],
    body: build,
  })
  const unmount = mount(Host(), target)
  const originalSidebar = [...target.querySelectorAll("span")].find(node => node.textContent === "Sidebar")
  try {
    for (const visible of [false, true, false]) {
      sheet.value = visible
      await Promise.resolve()
      assert.equal(target.textContent, visible ? "SettingsSheet contentSidebarSidebar content" : "SidebarSidebar content")
      assert.equal([...target.querySelectorAll("span")].find(node => node.textContent === "Sidebar"), originalSidebar)
    }
  } finally {
    unmount()
    dom.window.close()
  }
})

test("Swift modifier callbacks execute with their parameter and animation helpers import automatically", () => {
  const events = []
  const value = compileExpression('Text("Hover").onHover({ hovering in record(hovering) })', { record: value => events.push(value) })
  value.modifiers.find(modifier => modifier.name === "onHover").arguments[0](true)
  assert.deepEqual(events, [true])
  const output = transformMunSource('Text("Overlay").transition(Transition.opacity); withAnimation(Animation.default, () => update())', "Animation.mun.ts")
  assert.match(output, /import \{[^}]*\bTransition\b[^}]*\} from "@mun\/core\/compat"/)
  assert.match(output, /import \{[^}]*\bwithAnimation\b[^}]*\} from "@mun\/core\/compat"/)
  const explicit = transformMunSource('import { Text, Transition, withAnimation, Animation } from "@mun/core"\nText("x").transition(Transition.opacity); withAnimation(Animation.default, () => update())', "Explicit.mun.ts")
  assert.doesNotMatch(explicit, /import \{[^}]*\b(?:Transition|withAnimation|Animation)\b[^}]*\} from "@mun\/core\/compat"/)

})
