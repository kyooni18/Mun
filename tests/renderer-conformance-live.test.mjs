import assert from "node:assert/strict"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import ts from "typescript"
import { BindingValue, Element, ForEach, ForeignComponent, State, Toggle, defineView, initializer } from "../packages/core/dist/compat.js"
import { compileMunFile } from "../packages/compiler/dist/index.js"

function installDOM() {
  const dom = new JSDOM("<!doctype html><html><body><main id=app></main></body></html>", { url: "http://localhost/" })
  const previous = new Map()
  for (const name of ["window", "document", "Element", "HTMLElement", "SVGElement", "Node", "MutationObserver", "getComputedStyle"]) {
    previous.set(name, globalThis[name])
    globalThis[name] = name === "getComputedStyle" ? dom.window.getComputedStyle : dom.window[name]
  }
  previous.set("navigator", globalThis.navigator)
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator })
  previous.set("IS_REACT_ACT_ENVIRONMENT", globalThis.IS_REACT_ACT_ENVIRONMENT)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return () => {
    dom.window.close()
    for (const [name, value] of previous) {
      if (name === "navigator") Object.defineProperty(globalThis, name, { configurable: true, value })
      else if (value === undefined) delete globalThis[name]
      else globalThis[name] = value
    }
  }
}

function interactiveFixture() {
  const count = State(0)
  let reference
  const Counter = defineView("ConformanceInteractive", {
    initializers: [initializer("Counter()", args => args.length === 0)],
    body: () => Element("button", {
      "data-role": "counter",
      onclick: () => { count.value += 1 },
      ref: value => { reference = value },
    }, `Count: ${count.value}`),
  })
  return { value: Counter(), get count() { return count.value }, get reference() { return reference } }
}

async function mountLiveValue(renderer, value) {
  if (renderer === "react") {
    const { act } = await import("react")
    const { createRoot } = await import("react-dom/client")
    const { render } = await import("../packages/react/dist/index.js")
    const root = createRoot(document.getElementById("app"))
    await act(async () => { root.render(render(value)) })
    return {
      dispatch: async action => act(async () => { action() }),
      unmount: async () => act(async () => { root.unmount() }),
    }
  }
  if (renderer === "vue") {
    const { createApp, nextTick } = await import("vue")
    const { render } = await import("../packages/vue/dist/index.js")
    const app = createApp({ render: () => render(value) })
    app.mount(document.getElementById("app"))
    return {
      dispatch: async action => { action(); await nextTick() },
      unmount: async () => app.unmount(),
    }
  }
  const { mount } = await import("../packages/web/dist/index.js")
  const unmount = mount(value, document.getElementById("app"))
  return {
    dispatch: async action => { action(); await Promise.resolve(); await Promise.resolve() },
    unmount: async () => unmount(),
  }
}

async function compiledSharedGraph() {
  const source = `import { Button, State, Text, VStack } from "@mun/core/compat"
struct SharedCounter: View {
  @State var count = State(0)
  var body: some View {
    VStack() {
      Text(\`Count: \${count.value}\`)
      Button("Increment") { count.value += 1 }
    }
  }
}
export const create = () => SharedCounter()`
  const result = compileMunFile(source, "shared-counter.mun.ts")
  const munUrl = pathToFileURL(new URL("../dist/index.js", import.meta.url).pathname).href
  const coreUrl = pathToFileURL(new URL("../packages/core/dist/compat.js", import.meta.url).pathname).href
  const code = ts.transpileModule(result.code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
    .replaceAll('from "@mun/core/compat"', `from "${coreUrl}"`)
    .replaceAll('from "@mun/core"', `from "${coreUrl}"`)
  return import(`data:text/javascript,${encodeURIComponent(code)}`)
}

test("one compiled .mun.ts graph behaves identically in React, Vue, and Web", async () => {
  const shared = await compiledSharedGraph()
  for (const renderer of ["react", "vue", "web"]) {
    const restore = installDOM()
    try {
      const mounted = await mountLiveValue(renderer, shared.create())
      const button = document.querySelector("button")
      assert.ok(button)
      assert.equal(button.textContent, "Increment")
      assert.match(document.body.textContent ?? "", /Count: 0/)
      await mounted.dispatch(() => button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })))
      assert.match(document.body.textContent ?? "", /Count: 1/)
      await mounted.unmount()
    } finally {
      restore()
    }
  }
})

test("the same live state, event, ref, and DOM identity contract holds in React, Vue, and Web", async () => {
  for (const renderer of ["react", "vue", "web"]) {
    const restore = installDOM()
    try {
      const fixture = interactiveFixture()
      const mounted = await mountLiveValue(renderer, fixture.value)

      const button = document.querySelector("[data-role=counter]")
      assert.ok(button)
      assert.equal(button.textContent, "Count: 0")
      assert.equal(fixture.reference, button)
      await mounted.dispatch(() => button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })))
      assert.equal(fixture.count, 1)
      assert.equal(document.querySelector("[data-role=counter]"), button)
      assert.equal(button.textContent, "Count: 1")
      await mounted.unmount()
      assert.equal(fixture.reference, null)
    } finally {
      restore()
    }
  }
})

function foreignFixture() {
  const count = State(0)
  let reference
  const Host = defineView("ConformanceForeignHost", {
    initializers: [initializer("Host()", args => args.length === 0)],
    body: () => ForeignComponent("button", {
      name: "ConformanceForeignButton",
      props: { "data-role": "foreign", "aria-label": "foreign" },
      events: { onClick: () => { count.value += 1 } },
      ref: value => { reference = value },
    }, `Foreign: ${count.value}`),
  })
  return { value: Host(), get count() { return count.value }, get reference() { return reference } }
}

test("the same foreign component event, ref, state, and identity contract holds in React, Vue, and Web", async () => {
  for (const renderer of ["react", "vue", "web"]) {
    const restore = installDOM()
    try {
      const fixture = foreignFixture()
      const mounted = await mountLiveValue(renderer, fixture.value)
      const button = document.querySelector("[data-role=foreign]")
      assert.ok(button)
      assert.equal(fixture.reference, button)
      assert.equal(button.textContent, "Foreign: 0")
      await mounted.dispatch(() => button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })))
      assert.equal(fixture.count, 1)
      assert.equal(document.querySelector("[data-role=foreign]"), button)
      assert.equal(button.textContent, "Foreign: 1")
      await mounted.unmount()
      assert.equal(fixture.reference, null)
    } finally {
      restore()
    }
  }
})

test("raw HTML attributes, custom CSS properties, children, events, and refs stay identical across renderers", async () => {
  for (const renderer of ["react", "vue", "web"]) {
    const restore = installDOM()
    try {
      const count = State(0)
      let reference
      const Host = defineView("ConformanceRawHtmlHost", {
        initializers: [initializer("Host()", args => args.length === 0)],
        body: () => Element("section", {
          class: "raw-card",
          "aria-label": "raw content",
          "data-kind": "custom",
          style: { "--mun-accent": "rebeccapurple", color: "red" },
          onclick: () => { count.value += 1 },
          ref: value => { reference = value },
        }, Element("strong", null, "Raw"), ` Count: ${count.value}`),
      })
      const mounted = await mountLiveValue(renderer, Host())
      const section = document.querySelector("section[data-kind=custom]")
      assert.ok(section)
      assert.equal(section.className, "raw-card")
      assert.equal(section.getAttribute("aria-label"), "raw content")
      assert.equal(section.textContent, "Raw Count: 0")
      assert.equal(section.style.getPropertyValue("--mun-accent"), "rebeccapurple")
      assert.equal(reference, section)
      await mounted.dispatch(() => section.dispatchEvent(new window.MouseEvent("click", { bubbles: true })))
      assert.equal(count.value, 1)
      assert.equal(document.querySelector("section[data-kind=custom]"), section)
      assert.equal(section.textContent, "Raw Count: 1")
      await mounted.unmount()
      assert.equal(reference, null)
    } finally {
      restore()
    }
  }
})

test("the same writable Binding control contract holds in React, Vue, and Web", async () => {
  for (const renderer of ["react", "vue", "web"]) {
    const restore = installDOM()
    try {
      const state = State(false)
      const Host = defineView("ConformanceBindingHost", {
        initializers: [initializer("Host()", args => args.length === 0)],
        body: () => Toggle("Enabled", BindingValue(state)),
      })
      const mounted = await mountLiveValue(renderer, Host())
      const input = document.querySelector("input[type=checkbox]")
      assert.ok(input)
      assert.equal(input.checked, false)
      await mounted.dispatch(() => input.click())
      assert.equal(state.value, true, renderer)
      assert.equal(input.checked, true, renderer)
      await mounted.unmount()
    } finally {
      restore()
    }
  }
})

function keyedFixture() {
  const items = State([{ id: "a" }, { id: "b" }])
  const Row = defineView("ConformanceIdentityRow", {
    initializers: [initializer("Row(id)", args => args.length === 1, args => ({ id: args[0] }))],
    state: () => ({ count: State(0) }),
    body: ({ id, count }) => Element("button", {
      "data-row": id,
      onclick: () => { count.value += 1 },
    }, `${id}:${count.value}`),
  })
  const App = defineView("ConformanceIdentityApp", {
    initializers: [initializer("App()", args => args.length === 0)],
    body: () => Element("section", null, ForEach(items.value, item => item.id, item => Row(item.id))),
  })
  return { value: App(), items }
}

test("the same keyed State lifetime contract holds across all live renderers", async () => {
  for (const renderer of ["react", "vue", "web"]) {
    const restore = installDOM()
    try {
      const fixture = keyedFixture()
      const mounted = await mountLiveValue(renderer, fixture.value)
      const first = document.querySelector('[data-row="a"]')
      assert.ok(first)
      await mounted.dispatch(() => first.dispatchEvent(new window.MouseEvent("click", { bubbles: true })))
      assert.equal(first.textContent, "a:1")
      await mounted.dispatch(() => { fixture.items.value = [fixture.items.value[1], fixture.items.value[0]] })
      assert.deepEqual([...document.querySelectorAll("button")].map(button => button.textContent), ["b:0", "a:1"])
      await mounted.dispatch(() => { fixture.items.value = [{ id: "b" }, { id: "c" }, { id: "a" }] })
      assert.deepEqual([...document.querySelectorAll("button")].map(button => button.textContent), ["b:0", "c:0", "a:1"])
      const inserted = document.querySelector('[data-row="c"]')
      assert.ok(inserted)
      await mounted.dispatch(() => inserted.dispatchEvent(new window.MouseEvent("click", { bubbles: true })))
      await mounted.dispatch(() => { fixture.items.value = [{ id: "c" }, { id: "a" }] })
      await mounted.dispatch(() => { fixture.items.value = [{ id: "b" }, { id: "c" }, { id: "a" }] })
      assert.deepEqual([...document.querySelectorAll("button")].map(button => button.textContent), ["b:0", "c:1", "a:1"])
      await mounted.dispatch(() => { fixture.items.value = [{ id: "b" }, { id: "c" }] })
      await mounted.dispatch(() => { fixture.items.value = [{ id: "b" }, { id: "c" }, { id: "a" }] })
      assert.deepEqual([...document.querySelectorAll("button")].map(button => button.textContent), ["b:0", "c:1", "a:0"])
      await mounted.unmount()
    } finally {
      restore()
    }
  }
})

function conditionalFixture() {
  const mode = State(false)
  const First = defineView("ConformanceConditionalFirst", {
    initializers: [initializer("First()", args => args.length === 0)],
    state: () => ({ count: State(0) }),
    body: ({ count }) => Element("button", { "data-mode": "first", onclick: () => { count.value += 1 } }, `first:${count.value}`),
  })
  const Second = defineView("ConformanceConditionalSecond", {
    initializers: [initializer("Second()", args => args.length === 0)],
    state: () => ({ count: State(0) }),
    body: ({ count }) => Element("button", { "data-mode": "second", onclick: () => { count.value += 1 } }, `second:${count.value}`),
  })
  const App = defineView("ConformanceConditionalApp", {
    initializers: [initializer("App()", args => args.length === 0)],
    body: () => mode.value ? Second() : First(),
  })
  return { value: App(), mode }
}

test("the same conditional View type remount contract holds across all live renderers", async () => {
  for (const renderer of ["react", "vue", "web"]) {
    const restore = installDOM()
    try {
      const fixture = conditionalFixture()
      const mounted = await mountLiveValue(renderer, fixture.value)
      let button = document.querySelector("[data-mode=first]")
      assert.ok(button)
      await mounted.dispatch(() => button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })))
      assert.equal(button.textContent, "first:1")
      await mounted.dispatch(() => { fixture.mode.value = true })
      button = document.querySelector("[data-mode=second]")
      assert.ok(button)
      assert.equal(button.textContent, "second:0")
      await mounted.dispatch(() => { fixture.mode.value = false })
      button = document.querySelector("[data-mode=first]")
      assert.ok(button)
      assert.equal(button.textContent, "first:0")
      await mounted.unmount()
    } finally {
      restore()
    }
  }
})

test("same-name concrete View type changes remount State identically in React, Vue, and Web", async () => {
  for (const renderer of ["react", "vue", "web"]) {
    const restore = installDOM()
    try {
      const branch = State("a")
      const SameA = defineView("SameConcreteName", {
        name: "SameConcreteName",
        initializers: [initializer("SameConcreteName()", args => args.length === 0)],
        state: () => ({ local: State("A") }),
        body: ({ local }) => Element("span", { "data-branch": "value" }, local.value),
      })
      const SameB = defineView("SameConcreteName", {
        name: "SameConcreteName",
        initializers: [initializer("SameConcreteName()", args => args.length === 0)],
        state: () => ({ local: State("B") }),
        body: ({ local }) => Element("span", { "data-branch": "value" }, local.value),
      })
      const Root = defineView("SameNameRoot", {
        initializers: [initializer("Root()", args => args.length === 0)],
        body: () => Element("section", null, branch.value === "a" ? SameA() : SameB()),
      })
      const mounted = await mountLiveValue(renderer, Root())
      assert.equal(document.querySelector("[data-branch=value]")?.textContent, "A")
      await mounted.dispatch(() => { branch.value = "b" })
      assert.equal(document.querySelector("[data-branch=value]")?.textContent, "B")
      await mounted.unmount()
    } finally {
      restore()
    }
  }
})
