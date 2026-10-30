import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import ts from "typescript"
import { JSDOM } from "jsdom"
import { compileMunFile, diagnoseMunSource, mapGeneratedPosition, parseMunStructs, createMunSemanticModel } from "../packages/compiler/dist/index.js"
import { LanguageService } from "../editors/lsp/service.mjs"
import { mount, renderToHTML } from "../packages/web/dist/index.js"

const lineOf = (source, token) => source.slice(0, source.indexOf(token)).split("\n").length
const example = name => readFileSync(new URL(`../examples/language-web/${name}.mun`, import.meta.url), "utf8")
const moduleCache = new Map()
async function load(name) {
  if (moduleCache.has(name)) return moduleCache.get(name)
  const { code } = compileMunFile(example(name), `${name}.mun`)
  let js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  for (const dependency of ["Counter", "Profile"]) {
    if (!js.includes(`./${dependency}.mun`)) continue
    const loaded = await load(dependency)
    js = js.replace(`./${dependency}.mun`, loaded.url)
  }
  js = js.replaceAll('"@mun-ui/core/compat"', JSON.stringify(new URL("../packages/core/dist/compat.js", import.meta.url).href))
    .replaceAll('"@mun-ui/core"', JSON.stringify(new URL("../packages/core/dist/index.js", import.meta.url).href))
  const url = `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
  const result = { url, module: await import(url) }
  moduleCache.set(name, result)
  return result
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const button = (root, text) => [...root.querySelectorAll("button")].find(node => node.textContent === text)
const submit = root => root.querySelector("form").dispatchEvent(new root.ownerDocument.defaultView.Event("submit", { bubbles: true, cancelable: true }))
function input(root, value) {
  const field = root.querySelector("input")
  field.value = value
  field.dispatchEvent(new root.ownerDocument.defaultView.Event("input", { bubbles: true }))
}

test("web language contract: shared compilation, bindings, async diagnostics and source ranges", () => {
  for (const name of ["Counter", "Profile", "App"]) assert.deepEqual(diagnoseMunSource(example(name), `${name}.mun`), [])
  const invalid = example("Profile").replace('text: $name', 'text: name')
  const diagnostic = diagnoseMunSource(invalid, "Profile.mun")[0]
  assert.match(diagnostic.message, /requires a Binding.*Pass \$name/)
  assert.equal(diagnostic.line, 7)
  assert.throws(() => compileMunFile(invalid, "Profile.mun"), /Binding/)
  assert.throws(() => compileMunFile(example("Profile").replace('text: $name', 'text: 42'), "Profile.mun"), /requires a Binding, not a literal/)
  assert.doesNotThrow(() => compileMunFile(example("Profile").replace('text: $name', 'text: true ? $name : $name'), "Profile.mun"))
  assert.match(diagnoseMunSource('struct App: View { var body: some View { <div /> } }', "App.mun")[0].message, /Raw HTML/)
  const service = new LanguageService()
  service.update("file:///Profile.mun", example("Profile"))
  assert.deepEqual(service.diagnostics("file:///Profile.mun"), [])
  const sync = example("Profile").replace('func save(signal) async', 'func save(signal)')
  assert.match(diagnoseMunSource(sync, "Profile.mun")[0].message, /await requires an async/)
  assert.equal(diagnoseMunSource(sync, "Profile.mun")[0].line, lineOf(sync, "await fetch"))
  const unsupported = example("Profile").replace('func save(signal) async', 'func save(signal) async throws')
  assert.match(diagnoseMunSource(unsupported, "Profile.mun")[0].message, /Unsupported method effects/)
  assert.equal(diagnoseMunSource(unsupported, "Profile.mun")[0].line, lineOf(unsupported, "func save"))
  const typed = example("Profile").replace('func save(signal) async', 'func save(signal) async -> void')
  const parsed = parseMunStructs(typed).find(view => view.name === "Profile").methods.find(method => method.name === "save")
  assert.equal(parsed.returnType, "void")
  assert.match(typed.slice(parsed.bodyRange.start, parsed.bodyRange.end), /await fetch/)
  assert.match(compileMunFile(typed, "Profile.mun").code, /async function save\(signal\): Promise<void>/)
  const { code, map } = compileMunFile(example("Profile"), "Profile.mun")
  const offset = code.indexOf('await fetch')
  const line = code.slice(0, offset).split("\n").length
  const column = offset - code.lastIndexOf("\n", offset)
  assert.equal(mapGeneratedPosition(map, { line, column }).line, lineOf(example("Profile"), "await fetch"))
  assert.equal(createMunSemanticModel(example("Profile"), "Profile.mun").calls.find(call => call.callee === "TextField").resolution.resolvedInitializer.parameters[1].kind, "binding")
})

test("compiled Mun profile validates, retries, cancels, suppresses stale results and disposes", async () => {
  const App = (await load("App")).module.default
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, options) => new Promise(resolve => requests.push({ options, resolve })) // deliberately ignores abort
  const dom = new JSDOM("<div id=app></div><div id=other></div>")
  const root = dom.window.document.querySelector("#app")
  const other = dom.window.document.querySelector("#other")
  const dispose = mount(App, root)
  const disposeOther = mount(App, other)
  try {
    await flush()
    assert.equal(requests.length, 0)
    button(root, "Increment").click()
    await flush()
    assert.match(root.textContent, /Count: 1/)
    assert.match(other.textContent, /Count: 0/)
    submit(root)
    await flush()
    assert.match(root.textContent, /Enter a display name/)
    assert.equal(requests.length, 0)
    input(root, "Ada")
    await flush()
    const field = root.querySelector("input")
    field.focus()
    field.setSelectionRange(1, 2)
    button(root, "Update unrelated count").click()
    await flush()
    assert.equal(root.querySelector("input"), field)
    assert.equal(dom.window.document.activeElement, field)
    assert.deepEqual([field.selectionStart, field.selectionEnd, field.value], [1, 2, "Ada"])
    submit(root)
    await flush()
    requests[0].resolve({ ok: false })
    await flush()
    assert.match(root.textContent, /Save failed. Try again/)
    submit(root)
    await flush()
    input(root, "Grace")
    submit(root)
    await flush()
    assert.equal(requests[1].options.signal.aborted, true)
    requests[2].resolve({ ok: true, json: async () => ({ name: "Grace" }) })
    await flush()
    requests[1].resolve({ ok: true, json: async () => ({ name: "Ada" }) })
    await flush()
    assert.match(root.textContent, /Saved: Grace/)
    assert.doesNotMatch(root.textContent, /Saved: Ada/)
    submit(root)
    await flush()
    button(root, "Cancel").click()
    await flush()
    assert.equal(requests[3].options.signal.aborted, true)
    requests[3].resolve({ ok: true, json: async () => ({ name: "Late" }) })
    await flush()
    assert.match(root.textContent, /Cancelled/)
    submit(root)
    await flush()
    button(root, "Toggle profile").click()
    await flush()
    assert.equal(requests[4].options.signal.aborted, true)
    requests[4].resolve({ ok: true, json: async () => ({ name: "Removed" }) })
    await flush()
    button(root, "Toggle profile").click()
    await flush()
    assert.equal(root.querySelector("input").value, "")
    assert.match(root.textContent, /Ready/)
    assert.equal(other.querySelector("input").value, "")
  } finally {
    dispose(); disposeOther(); dom.window.close(); globalThis.fetch = originalFetch
  }
})

test("compiled Mun SSR is request-isolated and hydration adopts early input without submitting", async () => {
  const Profile = (await load("Profile")).module.default
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests++; return { ok: true, json: async () => ({ name: "Early edit" }) } }
  const html = renderToHTML(Profile)
  const dom = new JSDOM(`<div id=app>${html}</div>`)
  const root = dom.window.document.querySelector("#app")
  const field = root.querySelector("input")
  field.value = "Early edit"
  field.focus()
  field.setSelectionRange(2, 5)
  const dispose = mount(Profile, root, { hydrate: true })
  try {
    await flush()
    assert.equal(requests, 0)
    assert.equal(root.querySelector("input"), field)
    assert.equal(dom.window.document.activeElement, field)
    assert.deepEqual([field.value, field.selectionStart, field.selectionEnd], ["Early edit", 2, 5])
    button(root, "Update unrelated count").click()
    await flush()
    assert.equal(field.value, "Early edit")
    submit(root)
    await flush()
    assert.equal(requests, 1)
    assert.match(root.textContent, /Saved: Early edit/)
    assert.equal(renderToHTML(Profile), html)
  } finally { dispose(); dom.window.close(); globalThis.fetch = originalFetch }
})
