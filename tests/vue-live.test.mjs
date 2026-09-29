import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { ForEach, GeometryReader, State, Text, defineView, initializer, viewElement } from "../packages/core/dist/compat.js"
import { compiledCollectionContent } from "../packages/core/dist/internal-runtime.js"

test("Vue consumes core keyed View identity for reorder and remount State semantics", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>")
  const previous = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element, SVGElement: globalThis.SVGElement, Node: globalThis.Node }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Element = dom.window.Element
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Node = dom.window.Node
  try {
    const { createApp, nextTick } = await import("vue")
    const { MunView } = await import("../packages/vue/dist/index.js")
    const items = State([{ id: "a" }, { id: "b" }])
    const Row = defineView("VueIdentityRow", {
      initializers: [initializer("Row(id)", args => args.length === 1, args => ({ id: args[0] }))],
      state: () => ({ count: State(0) }),
      body: ({ id, count }) => viewElement("button", { "data-row": id, onclick: () => { count.value += 1 } }, [`${id}:${count.value}`]),
    })
    const App = defineView("VueIdentityApp", {
      initializers: [initializer("App()", args => args.length === 0)],
      body: () => viewElement("section", null, [ForEach(items.value, item => item.id, item => Row(item.id))]),
    })
    const app = createApp(MunView, { render: () => App() })
    app.mount(dom.window.document.getElementById("app"))
    dom.window.document.querySelector('[data-row="a"]')?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
    await nextTick()
    assert.equal(dom.window.document.querySelector('[data-row="a"]')?.textContent, "a:1")
    items.value = [items.value[1], items.value[0]]
    await nextTick()
    assert.deepEqual([...dom.window.document.querySelectorAll("button")].map(button => button.textContent), ["b:0", "a:1"])
    items.value = items.value.filter(item => item.id !== "a")
    await nextTick()
    items.value = [{ id: "a" }, ...items.value]
    await nextTick()
    assert.equal(dom.window.document.querySelector('[data-row="a"]')?.textContent, "a:0")
    app.unmount()
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.Element = previous.Element
    globalThis.SVGElement = previous.SVGElement
    globalThis.Node = previous.Node
    dom.window.close()
  }
})

test("Vue owns compiler-planned State collections without rebuilding the parent View graph", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>")
  const previous = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element, SVGElement: globalThis.SVGElement, Node: globalThis.Node }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Element = dom.window.Element
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Node = dom.window.Node
  try {
    const { createApp, nextTick } = await import("vue")
    const { MunView } = await import("../packages/vue/dist/index.js")
    const items = State([{ id: "a", value: "A" }, { id: "b", value: "B" }])
    let parentRuns = 0
    let genericRuns = 0
    let rowRuns = 0
    const content = compiledCollectionContent(item => {
      genericRuns += 1
      return viewElement("span", { "data-row": item.id }, [item.value])
    }, {
      kind: "flat-text-host",
      indexIndependent: true,
      evaluateKey: item => item.id,
      evaluate: item => {
        rowRuns += 1
        return { type: "span", props: { "data-row": item.id, class: item.value, style: { opacity: item.id === "a" ? 0.5 : 1 } }, text: item.value }
      },
    })
    const App = defineView("VueCompiledCollectionApp", {
      initializers: [initializer("App()", args => args.length === 0)],
      body: () => {
        parentRuns += 1
        return viewElement("section", null, [ForEach.viewType.createNodeCompiled(1, [items, item => item.id, content])])
      },
    })
    const app = createApp(MunView, { render: () => App() })
    app.mount(dom.window.document.getElementById("app"))
    assert.equal(parentRuns, 1)
    assert.equal(genericRuns, 0)
    assert.equal(rowRuns, 2)
    const a = dom.window.document.querySelector('[data-row="a"]')

    rowRuns = 0
    items.value[1] = { id: "b", value: "B1" }
    await nextTick()
    assert.equal(parentRuns, 1)
    assert.equal(genericRuns, 0)
    assert.equal(rowRuns, 1)
    assert.equal(dom.window.document.querySelector('[data-row="b"]')?.textContent, "B1")

    rowRuns = 0
    const next = [...items.value]
    next[1] = { id: "b", value: "B2" }
    items.value = next
    await nextTick()
    assert.equal(parentRuns, 1)
    assert.equal(genericRuns, 0)
    assert.equal(rowRuns, 1)
    assert.equal(dom.window.document.querySelector('[data-row="b"]')?.textContent, "B2")

    rowRuns = 0
    items.value[0].value = "A1"
    await nextTick()
    assert.equal(parentRuns, 1)
    assert.equal(genericRuns, 0)
    assert.equal(rowRuns, 1)
    assert.equal(dom.window.document.querySelector('[data-row="a"]')?.textContent, "A1")

    rowRuns = 0
    items.value.reverse()
    await nextTick()
    assert.equal(parentRuns, 1)
    assert.equal(genericRuns, 0)
    assert.equal(rowRuns, 0)
    assert.deepEqual([...dom.window.document.querySelectorAll("span")].map(node => node.textContent), ["B2", "A1"])
    assert.strictEqual(dom.window.document.querySelector('[data-row="a"]'), a)

    rowRuns = 0
    items.value.push({ id: "c", value: "C" })
    await nextTick()
    assert.equal(rowRuns, 1)
    assert.deepEqual([...dom.window.document.querySelectorAll("span")].map(node => node.textContent), ["B2", "A1", "C"])

    rowRuns = 0
    items.value.pop()
    await nextTick()
    assert.equal(rowRuns, 0)
    assert.deepEqual([...dom.window.document.querySelectorAll("span")].map(node => node.textContent), ["B2", "A1"])
    app.unmount()
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.Element = previous.Element
    globalThis.SVGElement = previous.SVGElement
    globalThis.Node = previous.Node
    dom.window.close()
  }
})

test("Vue prunes conservative declared State dependencies owned by compiled collections", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>")
  const previous = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element, SVGElement: globalThis.SVGElement, Node: globalThis.Node }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Element = dom.window.Element
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Node = dom.window.Node
  try {
    const { createApp, nextTick } = await import("vue")
    const { MunView } = await import("../packages/vue/dist/index.js")
    const items = State([{ id: "a", value: "A" }, { id: "b", value: "B" }])
    let parentRuns = 0
    let rowRuns = 0
    const content = compiledCollectionContent(item => viewElement("span", { "data-row": item.id }, [item.value]), {
      kind: "flat-text-host",
      indexIndependent: true,
      evaluateKey: item => item.id,
      evaluate: item => { rowRuns += 1; return { type: "span", props: { "data-row": item.id }, text: item.value } },
    })
    const App = defineView("VueDeclaredOwnedCollectionApp", {
      initializers: [initializer("App()", args => args.length === 0)],
      dependencies: () => [items],
      dependenciesComplete: true,
      body: () => {
        parentRuns += 1
        return viewElement("section", null, [ForEach.viewType.createNodeCompiled(1, [items, item => item.id, content])])
      },
    })
    const app = createApp(MunView, { render: () => App() })
    app.mount(dom.window.document.getElementById("app"))
    rowRuns = 0
    items.value[1].value = "B2"
    await nextTick()
    assert.equal(parentRuns, 1)
    assert.equal(rowRuns, 1)
    assert.equal(dom.window.document.querySelector('[data-row="b"]')?.textContent, "B2")
    app.unmount()
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.Element = previous.Element
    globalThis.SVGElement = previous.SVGElement
    globalThis.Node = previous.Node
    dom.window.close()
  }
})

test("Vue collection fallback keeps source and row State dependencies below the parent View", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>")
  const previous = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element, SVGElement: globalThis.SVGElement, Node: globalThis.Node }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Element = dom.window.Element
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Node = dom.window.Node
  try {
    const { createApp, nextTick } = await import("vue")
    const { MunView } = await import("../packages/vue/dist/index.js")
    const items = State([{ id: "a" }])
    const suffix = State("0")
    let parentRuns = 0
    let rowRuns = 0
    const App = defineView("VueGenericCollectionDependencies", {
      initializers: [initializer("App()", args => args.length === 0)],
      body: () => {
        parentRuns += 1
        return viewElement("section", null, [ForEach(items, item => item.id, item => {
          rowRuns += 1
          return viewElement("span", { "data-row": item.id }, [`${item.id}:${suffix.value}`])
        })])
      },
    })
    const app = createApp(MunView, { render: () => App() })
    app.mount(dom.window.document.getElementById("app"))
    assert.equal(parentRuns, 1)
    assert.equal(rowRuns, 1)
    assert.equal(dom.window.document.querySelector('[data-row="a"]')?.textContent, "a:0")

    suffix.value = "1"
    await nextTick()
    assert.equal(parentRuns, 1)
    assert.equal(rowRuns, 2)
    assert.equal(dom.window.document.querySelector('[data-row="a"]')?.textContent, "a:1")

    items.value.push({ id: "b" })
    await nextTick()
    assert.equal(parentRuns, 1)
    assert.equal(rowRuns, 4)
    assert.deepEqual([...dom.window.document.querySelectorAll("span")].map(node => node.textContent), ["a:1", "b:1"])
    app.unmount()
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.Element = previous.Element
    globalThis.SVGElement = previous.SVGElement
    globalThis.Node = previous.Node
    dom.window.close()
  }
})

test("Vue reevaluates a Mun body when an independently-owned State changes", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>")
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousElement = globalThis.Element
  const previousHTMLElement = globalThis.HTMLElement
  const previousSVGElement = globalThis.SVGElement
  const previousNode = globalThis.Node
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Element = dom.window.Element
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Node = dom.window.Node
  try {
    const { createApp, nextTick } = await import("vue")
    const { MunView } = await import("../packages/vue/dist/index.js")
    const state = State(0)
    const app = createApp(MunView, { render: () => Text(`Count: ${state.value}`) })
    app.mount(dom.window.document.getElementById("app"))
    assert.match(dom.window.document.body.textContent ?? "", /Count: 0/)
    state.value = 1
    await nextTick()
    assert.match(dom.window.document.body.textContent ?? "", /Count: 1/)
    app.unmount()
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
    globalThis.Element = previousElement
    globalThis.HTMLElement = previousHTMLElement
    globalThis.SVGElement = previousSVGElement
    globalThis.Node = previousNode
    dom.window.close()
  }
})

test("Vue drops stale Mun State subscriptions and releases them on unmount", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>")
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    SVGElement: globalThis.SVGElement,
    Node: globalThis.Node,
  }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Element = dom.window.Element
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Node = dom.window.Node
  try {
    const { createApp, nextTick } = await import("vue")
    const { MunView } = await import("../packages/vue/dist/index.js")
    const usePrimary = State(true)
    const primary = State("primary-0")
    const secondary = State("secondary-0")
    let renders = 0
    const app = createApp(MunView, {
      render: () => {
        renders += 1
        return Text(usePrimary.value ? primary.value : secondary.value)
      },
    })
    app.mount(dom.window.document.getElementById("app"))
    assert.match(dom.window.document.body.textContent ?? "", /primary-0/)

    primary.value = "primary-1"
    await nextTick()
    assert.match(dom.window.document.body.textContent ?? "", /primary-1/)

    usePrimary.value = false
    await nextTick()
    assert.match(dom.window.document.body.textContent ?? "", /secondary-0/)
    const rendersAfterSwitch = renders

    primary.value = "primary-stale"
    await nextTick()
    assert.equal(renders, rendersAfterSwitch)
    assert.match(dom.window.document.body.textContent ?? "", /secondary-0/)

    secondary.value = "secondary-1"
    await nextTick()
    assert.ok(renders > rendersAfterSwitch)
    assert.match(dom.window.document.body.textContent ?? "", /secondary-1/)

    app.unmount()
    const rendersAfterUnmount = renders
    secondary.value = "secondary-after-unmount"
    await nextTick()
    assert.equal(renders, rendersAfterUnmount)
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.Element = previous.Element
    globalThis.HTMLElement = previous.HTMLElement
    globalThis.SVGElement = previous.SVGElement
    globalThis.Node = previous.Node
    dom.window.close()
  }
})

test("Vue materialization preserves Mun events and refs at the live DOM boundary", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>")
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousElement = globalThis.Element
  const previousSVGElement = globalThis.SVGElement
  const previousNode = globalThis.Node
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Element = dom.window.Element
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Node = dom.window.Node
  try {
    const { createApp, nextTick, ref } = await import("vue")
    const { MunView } = await import("../packages/vue/dist/index.js")
    const state = State(0)
    const buttonRef = ref(null)
    const app = createApp(MunView, {
      render: () => viewElement("button", { onclick: () => { state.value += 1 }, ref: buttonRef }, [`Count: ${state.value}`]),
    })
    app.mount(dom.window.document.getElementById("app"))
    assert.equal(buttonRef.value, dom.window.document.querySelector("button"))
    buttonRef.value.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
    await nextTick()
    assert.match(dom.window.document.body.textContent ?? "", /Count: 1/)
    app.unmount()
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
    globalThis.Element = previousElement
    globalThis.SVGElement = previousSVGElement
    globalThis.Node = previousNode
    dom.window.close()
  }
})

test("Vue GeometryReader measures CSS safe-area insets at the DOM boundary", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>")
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousElement = globalThis.Element
  const previousSVGElement = globalThis.SVGElement
  const previousNode = globalThis.Node
  const previousResizeObserver = globalThis.ResizeObserver
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Element = dom.window.Element
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Node = dom.window.Node
  dom.window.getComputedStyle = () => ({ paddingTop: "12px", paddingRight: "8px", paddingBottom: "4px", paddingLeft: "2px" })
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback }
    observe(element) {
      element.getBoundingClientRect = () => ({ x: 0, y: 0, width: 320, height: 48, top: 0, right: 320, bottom: 48, left: 0 })
      this.callback([])
    }
    disconnect() {}
  }
  try {
    const { createApp, nextTick } = await import("vue")
    const { MunView } = await import("../packages/vue/dist/index.js")
    const app = createApp(MunView, { render: () => GeometryReader(geometry => Text(String(geometry.safeAreaInsets.top))) })
    app.mount(dom.window.document.getElementById("app"))
    await nextTick()
    await nextTick()
    assert.match(dom.window.document.body.textContent ?? "", /12/)
    app.unmount()
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
    globalThis.Element = previousElement
    globalThis.SVGElement = previousSVGElement
    globalThis.Node = previousNode
    if (previousResizeObserver === undefined) delete globalThis.ResizeObserver
    else globalThis.ResizeObserver = previousResizeObserver
    dom.window.close()
  }
})

test("Vue GeometryReader falls back to zero geometry when layout measurement throws", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>")
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousElement = globalThis.Element
  const previousSVGElement = globalThis.SVGElement
  const previousNode = globalThis.Node
  const previousResizeObserver = globalThis.ResizeObserver
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Element = dom.window.Element
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Node = dom.window.Node
  globalThis.ResizeObserver = class { constructor() { throw new Error("observer unavailable") } }
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => { throw new Error("layout unavailable") }
  try {
    const { createApp, nextTick } = await import("vue")
    const { MunView } = await import("../packages/vue/dist/index.js")
    const app = createApp(MunView, { render: () => GeometryReader(geometry => Text(`${geometry.size.width}:${geometry.safeAreaInsets.top}`)) })
    app.mount(dom.window.document.getElementById("app"))
    await nextTick()
    await nextTick()
    assert.match(dom.window.document.body.textContent ?? "", /0:0/)
    app.unmount()
  } finally {
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect
    globalThis.window = previousWindow
    globalThis.document = previousDocument
    globalThis.Element = previousElement
    globalThis.SVGElement = previousSVGElement
    globalThis.Node = previousNode
    if (previousResizeObserver === undefined) delete globalThis.ResizeObserver
    else globalThis.ResizeObserver = previousResizeObserver
    dom.window.close()
  }
})

test("Vue component lifecycle remains Vue-owned inside a Mün graph", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>")
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousElement = globalThis.Element
  const previousSVGElement = globalThis.SVGElement
  const previousNode = globalThis.Node
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Element = dom.window.Element
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Node = dom.window.Node
  try {
    const { createApp, defineComponent, h, nextTick, onBeforeUnmount, onMounted } = await import("vue")
    const { Component, MunView } = await import("../packages/vue/dist/index.js")
    let mounted = 0
    let unmounted = 0
    const Child = defineComponent({
      setup() {
        onMounted(() => { mounted += 1 })
        onBeforeUnmount(() => { unmounted += 1 })
        return () => h("strong", null, "Vue child")
      },
    })
    const app = createApp(MunView, { value: Component(Child) })
    app.mount(dom.window.document.getElementById("app"))
    await nextTick()
    assert.equal(mounted, 1)
    app.unmount()
    assert.equal(unmounted, 1)
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
    globalThis.Element = previousElement
    globalThis.SVGElement = previousSVGElement
    globalThis.Node = previousNode
    dom.window.close()
  }
})

test("Vue Transition and Teleport remain native boundaries inside a Mün graph", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div><div id=portal></div>")
  const previous = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element, SVGElement: globalThis.SVGElement, Node: globalThis.Node }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Element = dom.window.Element
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Node = dom.window.Node
  try {
    const { Teleport, Transition, createApp, nextTick } = await import("vue")
    const { Component, MunView } = await import("../packages/vue/dist/index.js")
    const value = viewElement("main", null, [
      Component(Transition, { name: "fade" }, Component("span", { "data-transition": true }, "Transitioned")),
      Component(Teleport, { to: dom.window.document.getElementById("portal") }, Component("strong", { "data-teleport": true }, "Teleported")),
    ])
    const app = createApp(MunView, { value })
    app.mount(dom.window.document.getElementById("app"))
    await nextTick()
    assert.equal(dom.window.document.querySelector('[data-transition]')?.textContent, "Transitioned")
    assert.equal(dom.window.document.querySelector('#portal [data-teleport]')?.textContent, "Teleported")
    assert.equal(dom.window.document.querySelector('#app [data-teleport]'), null)
    app.unmount()
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.Element = previous.Element
    globalThis.SVGElement = previous.SVGElement
    globalThis.Node = previous.Node
    dom.window.close()
  }
})

test("Vue mount can hydrate SSR Mun markup and keep State updates live", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>")
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousElement = globalThis.Element
  const previousHTMLElement = globalThis.HTMLElement
  const previousSVGElement = globalThis.SVGElement
  const previousNode = globalThis.Node
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Element = dom.window.Element
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Node = dom.window.Node
  try {
    const { createSSRApp, h, nextTick } = await import("vue")
    const { renderToString } = await import("@vue/server-renderer")
    const { MunView, mount } = await import("../packages/vue/dist/index.js")
    const Counter = defineView("HydrateCounter", {
      initializers: [initializer("HydrateCounter()", args => args.length === 0)],
      state: () => ({ count: State(0) }),
      body: ({ count }) => viewElement("button", {
        "data-counter": "vue",
        onclick: () => { count.value += 1 },
      }, [Text(`Hydrate ${count.value}`)]),
    })
    const value = Counter()
    const markup = await renderToString(createSSRApp({ render: () => h(MunView, { value }) }))
    const target = dom.window.document.getElementById("app")
    target.innerHTML = markup
    const serverButton = target.querySelector("button")
    const unmount = mount(value, target, { hydrate: true })
    assert.equal(target.querySelector("button"), serverButton)
    assert.match(target.textContent ?? "", /Hydrate 0/)
    serverButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
    await nextTick()
    assert.match(target.textContent ?? "", /Hydrate 1/)
    unmount()
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
    globalThis.Element = previousElement
    globalThis.HTMLElement = previousHTMLElement
    globalThis.SVGElement = previousSVGElement
    globalThis.Node = previousNode
    dom.window.close()
  }
})
