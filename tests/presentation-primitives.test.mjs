import assert from "node:assert/strict"
import test from "node:test"
import { Alert, Binding, Menu, NavigationLink, NavigationStack, Sheet, State, Text } from "../packages/core/dist/compat.js"
import { mount } from "../packages/web/dist/index.js"

async function optionalImport(specifier) {
	try {
		return await import(specifier)
	} catch (error) {
		if (error?.code === "ERR_MODULE_NOT_FOUND") return null
		throw error
	}
}

test("presentation primitives keep visibility and navigation state in graph props", async t => {
	const reactDom = await optionalImport("react-dom/server")
	const react = await optionalImport("../packages/react/dist/index.js")
	if (!reactDom || !react) {
		t.skip("React compatibility dependencies are not installed")
		return
	}
	const { renderToStaticMarkup } = reactDom
	const { render } = react
  const presented = State(true)
  const html = renderToStaticMarkup(render(NavigationStack(() => [
    NavigationLink("/settings", "Settings"),
    Sheet(Binding(presented), () => Text("Sheet")),
    Alert(Binding(presented), "Notice", "Message"),
    Menu("More", () => Text("Action")),
  ])))
  assert.match(html, /data-mun="NavigationStack"/)
  assert.match(html, /href="\/settings".*Settings/)
  assert.match(html, /role="dialog".*Sheet/)
  assert.match(html, /role="alertdialog".*Notice/)
  assert.match(html, /data-mun="Menu"/)
  presented.value = false
  assert.equal(renderToStaticMarkup(render(Sheet(Binding(presented), () => Text("Hidden")))), "")
})

test("top-level presentation Views reevaluate Binding state through the core ViewHost", async t => {
	const jsdom = await optionalImport("jsdom")
	if (!jsdom) {
		t.skip("jsdom is not installed")
		return
	}
	const { JSDOM } = jsdom
  const dom = new JSDOM("<div id=app></div>")
  const target = dom.window.document.querySelector("#app")
  const presented = State(false)
  const value = Sheet(Binding(presented), () => Text("Live sheet"))
  assert.equal(value.kind, "view")
  const unmount = mount(value, target)
  assert.equal(target.textContent, "")
  presented.value = true
  await Promise.resolve()
  assert.equal(target.textContent, "Live sheet")
  presented.value = false
  await Promise.resolve()
  assert.equal(target.textContent, "")
  unmount()
  dom.window.close()
})

test("@mun/react presentation Views are compatibility aliases of core Views", async t => {
	const react = await optionalImport("../packages/react/dist/index.js")
	if (!react) {
		t.skip("React compatibility dependencies are not installed")
		return
	}
	const { Sheet: ReactSheet } = react
  assert.equal(ReactSheet, Sheet)
})
