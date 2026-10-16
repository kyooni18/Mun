import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { viewElement } from "../packages/core/dist/compat.js"
import { mount, renderToHTML } from "../packages/web/dist/index.js"

const cases = [
  ["href", "javascript:alert(1)", false],
  ["href", " \u0000JaVa\nScRi\tPt:alert(1)", false],
  ["href", "vbscript:msgbox(1)", false],
  ["href", "data:text/html,<script>alert(1)</script>", false],
  ["href", "https://example.com/javascript:ok", true],
  ["href", "../page?q=javascript:ok", true],
  ["href", "#section", true],
  ["href", "mailto:hello@example.com", true],
  ["href", "tel:+123", true],
  ["href", "//example.com/path", true],
  ["href", "javascript&colon;alert(1)", true],
  ["src", "javascript:alert(1)", false],
  ["src", "data:image/svg+xml,<svg onload='alert(1)'/>", false],
  ["src", "data:image/png;base64,AAAA", true],
  ["src", "blob:https://example.com/id", true],
  ["action", "javascript:alert(1)", false],
  ["formAction", "javascript:alert(1)", false],
  ["xlink:href", "javascript:alert(1)", false],
  ["xlink:href", "#symbol", true],
  ["ping", "https://example.com javascript:alert(1)", false],
  ["data", "data:text/html,hi", false],
]
for (const [attribute, value, safe] of cases) {
  test(`URL policy SSR/client: ${attribute} ${JSON.stringify(value)}`, () => {
    const dom = new JSDOM("<main></main>")
    const name = attribute === "formAction" ? "formaction" : attribute
    const view = viewElement("a", { [attribute]: value }, ["link"])
    const html = renderToHTML(view)
    const parsed = new JSDOM(html).window.document.querySelector("a")
    assert.equal(parsed.hasAttribute(name), safe)
    if (safe) assert.equal(parsed.getAttribute(name), value)
    const container = dom.window.document.querySelector("main")
    const root = mount(view, container)
    assert.equal(container.firstChild.hasAttribute(name), safe)
    if (safe) assert.equal(container.firstChild.getAttribute(name), value)
    root()
    dom.window.close()
  })
}

test("hydration removes unsafe server attributes instead of accepting live matching props", async () => {
  const dom = new JSDOM('<main><a href="javascript:alert(1)">link</a></main>')
  const container = dom.window.document.querySelector("main")
  const stop = mount(viewElement("a", { href: "javascript:alert(1)" }, ["link"]), container, { hydrate: true })
  assert.equal(container.querySelector("a").hasAttribute("href"), false)
  stop()
  dom.window.close()
})

test("Patch IR URL attribute and property writes remove previously safe navigation", async () => {
  const { definePatchIR, allocatePatchValues, markPatchDirty, applyPatchIR } = await import("../packages/web/dist/patch-ir.js")
  const dom = new JSDOM('<a href="/safe">link</a>')
  const element = dom.window.document.querySelector("a")
  for (const kind of ["attribute", "property"]) {
    element.setAttribute("href", "/safe")
    const ir = definePatchIR([{ node: 0, kind, key: "href" }])
    const patch = allocatePatchValues(ir)
    patch.values[0] = "\rJaVaScRiPt:alert(1)"
    markPatchDirty(patch.dirty, 0)
    assert.equal(applyPatchIR([element], ir, patch), 1)
    assert.equal(element.hasAttribute("href"), false)
  }
  dom.window.close()
})

test("compiled templates apply the same static URL policy", async () => {
  const { compiledTemplate, defineCompiledTemplate } = await import("../packages/core/dist/compat.js")
  const template = defineCompiledTemplate({ kind: "element", type: "a", props: { href: "javascript:alert(1)" }, children: ["link"] }, 0)
  const view = compiledTemplate(template, [])
  assert.equal(renderToHTML(view), "<a>link</a>")
  const dom = new JSDOM("<main></main>")
  const container = dom.window.document.querySelector("main")
  const stop = mount(view, container)
  assert.equal(container.firstChild.hasAttribute("href"), false)
  stop()
  dom.window.close()
})

test("reactive URL patches remove unsafe values without replacing keyed nodes; teardown clears listeners", async () => {
  const { State, defineView, initializer } = await import("../packages/core/dist/compat.js")
  const href = State("/safe")
  let clicks = 0
  const App = defineView("URLUpdate", {
    initializers: [initializer("URLUpdate()", args => args.length === 0)],
    body: () => viewElement("a", { key: "link", href: href.value, onClick: () => { clicks++ } }, ["link"]),
  })
  const dom = new JSDOM("<main></main>")
  const container = dom.window.document.querySelector("main")
  const stop = mount(App(), container)
  const element = container.firstChild
  href.value = "javascript:alert(1)"
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(container.firstChild, element)
  assert.equal(element.hasAttribute("href"), false)
  element.dispatchEvent(new dom.window.Event("click"))
  assert.equal(clicks, 1)
  stop()
  element.dispatchEvent(new dom.window.Event("click"))
  href.value = "/after-unmount"
  await Promise.resolve()
  assert.equal(clicks, 1)
  assert.equal(container.childNodes.length, 0)
  dom.window.close()
})
