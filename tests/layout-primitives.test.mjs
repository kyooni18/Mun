import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { renderToStaticMarkup } from "react-dom/server"
import { createSSRApp } from "vue"
import { renderToString } from "@vue/server-renderer"
import { Capsule, Divider, Element, Grid, Group, HStack, LazyGrid, LazyVStack, RoundedRectangle, SafeArea, ScrollView, Spacer, Text, VStack, ZStack, defineView, initializer } from "../packages/core/dist/compat.js"
import { continuousCornerPath } from "../packages/core/dist/corners.js"
import { render as renderReact } from "../packages/react/dist/index.js"
import { render as renderVue } from "../packages/vue/dist/index.js"
import { mount as mountWeb, renderToHTML } from "../packages/web/dist/index.js"

test("migrated layout primitives keep the graph-first contract", () => {
  const value = HStack(Text("Left"), Spacer(24), Text("Right")).padding(8)
  assert.equal(value.kind, "modified")
  const html = renderToStaticMarkup(renderReact(value))
  assert.match(html, /data-mun="HStack"/)
  assert.match(html, /justify-content:center/)
  assert.match(html, /flex-grow:1/)
  assert.match(html, /padding:8px/)
})

test("stack stretch alignment fills the cross axis", () => {
  const outputs = [
    renderToStaticMarkup(renderReact(VStack({ alignment: "stretch" }, Text("VStack")))),
    renderToStaticMarkup(renderReact(HStack({ alignment: "stretch" }, Text("HStack")))),
  ]
  assert.match(outputs[0], /align-items:stretch/)
  assert.match(outputs[1], /align-items:stretch/)
})

test("Capsule and RoundedRectangle opt into measured continuous corners in every renderer", async () => {
  const values = [
    Capsule().frame({ width: 180, height: 64 }),
    RoundedRectangle(24).frame({ width: 120, height: 80 }),
  ]
  for (const value of values) {
    const outputs = [
      renderToStaticMarkup(renderReact(value)),
      await renderToString(createSSRApp({ render: () => renderVue(value) })),
      renderToHTML(value),
    ]
    for (const html of outputs) {
      assert.match(html, /--mun-corner-style:\s*continuous/)
      assert.match(html, /--mun-corner-smoothing:\s*0\.65/)
      assert.match(html, /corner-shape:\s*squircle/)
    }
  }
})

test("continuous corner paths match the Lisse capsule control geometry", () => {
  const radii = { topLeft: 50, topRight: 50, bottomRight: 50, bottomLeft: 50 }
  const path = continuousCornerPath(300, 100, radii, 0.5, true)
  assert.match(path, /^M 75 0 L 225 0/)
  assert.match(path, /c 23\.2971 0 34\.9456 0 44\.1342 3\.806/)
  assert.match(path, /a 50 50 0 0 1 30\.8658 46\.194/)
  assert.match(path, /a 50 50 0 0 1 -30\.8658 46\.194/)
  assert.doesNotMatch(path, /NaN|Infinity/)
})

test("continuous corner paths blend smoothly before the capsule regime", () => {
  const radii = { topLeft: 50, topRight: 50, bottomRight: 50, bottomLeft: 50 }
  const path = continuousCornerPath(300, 130, radii, 0.6, true)
  assert.match(path, /^M 80 0/)
  assert.match(path, /L 300 65/)
  assert.match(path, /L 0 65/)
  assert.doesNotMatch(path, /NaN|Infinity/)
})

test("the Web renderer materializes a measured continuous clip path for Capsule", () => {
  const dom = new JSDOM("<div id=app></div>", { pretendToBeVisual: true })
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() { return this.getAttribute("data-mun") === "Capsule" ? 180 : 0 },
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() { return this.getAttribute("data-mun") === "Capsule" ? 64 : 0 },
  })
  const container = dom.window.document.querySelector("#app")
  assert.ok(container)
  const unmount = mountWeb(Capsule(), container)
  const capsule = container.firstElementChild
  assert.ok(capsule)
  assert.match(capsule.style.clipPath, /^path\("M /)
  assert.match(capsule.style.clipPath, /a 32 32/)
  assert.doesNotMatch(capsule.style.clipPath, /NaN|Infinity/)
  unmount()
  dom.window.close()
})

test("Group, ZStack, Element, and Divider compose without React elements in core", () => {
  const html = renderToStaticMarkup(renderReact(VStack(
    Group(Text("A"), Text("B")),
    ZStack(Text("Top")),
    Element("section", { id: "native" }, Divider()),
  )))
  assert.match(html, /A.*B/)
  assert.match(html, /data-mun="ZStack"/)
  assert.match(html, /<section id="native"><hr data-mun="Divider"\/?><\/section>/)
})

test("layout semantics stay aligned across React, Vue, and Web renderers", async () => {
  const value = SafeArea(["top", "left"], () => ScrollView("both", () =>
    ZStack({ alignment: "topTrailing" },
      HStack({ alignment: "bottom", spacing: 6 }, Text("A"), Spacer(12), Text("B")),
    ).frame({ minWidth: 120, maxWidth: "infinity", height: 48 }),
  ))
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]

  for (const html of outputs) {
    assert.match(html, /place-items:\s*start end/)
    assert.match(html, /flex-basis:\s*12px/)
    assert.match(html, /flex-shrink:\s*0/)
    assert.match(html, /max-width:\s*100%/)
    assert.match(html, /min-width:\s*120px/)
    assert.match(html, /height:\s*48px/)
    assert.match(html, /overflow-x:\s*auto/)
    assert.match(html, /overflow-y:\s*auto/)
    assert.match(html, /padding-top:\s*env\(safe-area-inset-top\)/)
    assert.match(html, /padding-left:\s*env\(safe-area-inset-left\)/)
  }
})

test("frame creates the same alignment host across React, Vue, and Web renderers", async () => {
  const value = Text("Aligned").frame({ width: 120, height: 48, alignment: "topTrailing" })
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]

  for (const html of outputs) {
    const document = new JSDOM(html).window.document
    const frame = document.body.firstElementChild
    assert.ok(frame)
    assert.equal(frame?.tagName, "DIV")
    assert.equal(frame?.style.display, "grid")
    assert.equal(frame?.style.placeItems, "start end")
    assert.equal(frame?.style.width, "120px")
    assert.equal(frame?.style.height, "48px")
    assert.equal(frame?.firstElementChild?.tagName, "SPAN")
    assert.equal(frame?.firstElementChild?.textContent, "Aligned")
    assert.equal(frame?.firstElementChild?.style.display, "")
  }
})

test("SwiftUI-derived padding and ideal frame inputs have observable renderer semantics", async () => {
  const value = Text("Ideal").padding().frame({ idealWidth: 140, idealHeight: 52, alignment: "bottomTrailing" })
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]

  for (const html of outputs) {
    const document = new JSDOM(html).window.document
    const frame = document.body.firstElementChild
    assert.ok(frame)
    assert.equal(frame.style.width, "140px")
    assert.equal(frame.style.height, "52px")
    assert.equal(frame.style.placeItems, "end end")
    assert.equal(frame.firstElementChild?.style.padding, "16px")
  }
})

test("layout primitives omit invalid numeric CSS values in every renderer", async () => {
  const value = VStack({ spacing: Number.NaN },
    Text("Finite").padding(Number.NaN).margin(Number.POSITIVE_INFINITY).frame({
      width: Number.NaN,
      height: Number.NEGATIVE_INFINITY,
    }),
    Spacer(Number.POSITIVE_INFINITY),
    RoundedRectangle(Number.NaN),
    LazyVStack({ spacing: Number.NEGATIVE_INFINITY, estimatedItemSize: Number.NaN, overscan: Number.NaN }, Text("Lazy")),
    Grid({ columns: Number.NaN, rows: Number.POSITIVE_INFINITY }, Text("Grid")),
    LazyGrid({ columns: 0, rows: 1.5, estimatedItemSize: Number.NaN, overscan: Number.POSITIVE_INFINITY }, Text("Lazy grid")),
  )
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]
  for (const html of outputs) {
    assert.doesNotMatch(html, /NaN|Infinity/)
    assert.doesNotMatch(html, /repeat\((?:0|1\.5),/)
  }
})

test("layout option records are immutable data-only snapshots", () => {
  let getterCalls = 0
  const stackOptions = { alignment: "leading", spacing: 4 }
  Object.defineProperty(stackOptions, "unknown", {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error("unknown stack options must not be read")
    },
  })
  const gridOptions = { columns: 2, autoFlow: "row" }
  const stack = VStack(stackOptions, Text("Stack"))
  const grid = Grid(gridOptions, Text("Grid"))
  stackOptions.alignment = "trailing"
  stackOptions.spacing = 20
  gridOptions.columns = 5
  gridOptions.autoFlow = "column"

  const stackHTML = renderToHTML(stack)
  const gridHTML = renderToHTML(grid)
  assert.match(stackHTML, /align-items:flex-start/)
  assert.match(stackHTML, /gap:4px/)
  assert.doesNotMatch(stackHTML, /20px|flex-end/)
  assert.match(gridHTML, /grid-template-columns:repeat\(2,/)
  assert.match(gridHTML, /grid-auto-flow:row/)
  assert.doesNotMatch(gridHTML, /repeat\(5,|grid-auto-flow:column/)
  assert.equal(getterCalls, 0)

  const accessorOptions = {}
  Object.defineProperty(accessorOptions, "spacing", {
    get() {
      getterCalls += 1
      throw new Error("declared option accessors must not run")
    },
  })
  Object.defineProperty(accessorOptions, "columns", {
    get() {
      getterCalls += 1
      throw new Error("declared option accessors must not run")
    },
  })
  assert.throws(() => VStack(accessorOptions, Text("Invalid")), /VStack options must be a data-only record/)
  assert.throws(() => Grid(accessorOptions, Text("Invalid")), /Grid options must be a data-only record/)
  assert.equal(getterCalls, 0)
})

test("grid option values cannot trigger coercion during rendering", async () => {
  let getterCalls = 0
  const hostile = {}
  Object.defineProperty(hostile, "toString", {
    get() {
      getterCalls += 1
      throw new Error("grid options must not coerce objects")
    },
  })
  const value = VStack(
    Grid({ columns: hostile, rows: hostile, autoFlow: hostile }, Text("Grid")),
    LazyGrid({ columns: hostile, autoFlow: hostile, estimatedItemSize: hostile }, Text("Lazy grid")),
  )
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]
  assert.equal(getterCalls, 0)
  for (const html of outputs) assert.doesNotMatch(html, /\[object Object\]/)
})

test("SafeArea snapshots edge arrays without executing indexed accessors", () => {
  const edges = ["top"]
  const value = SafeArea(edges, () => Text("Safe"))
  edges.push("left")
  const html = renderToHTML(value)
  assert.match(html, /padding-top:env\(safe-area-inset-top\)/)
  assert.doesNotMatch(html, /padding-left/)

  let getterCalls = 0
  const accessorEdges = []
  Object.defineProperty(accessorEdges, "0", {
    configurable: true,
    get() {
      getterCalls += 1
      throw new Error("edge getters must not run")
    },
  })
  accessorEdges.length = 1
  assert.throws(
    () => SafeArea(accessorEdges, () => Text("Invalid")),
    /SafeArea edges must be a data-only edge or edge array/,
  )
  assert.equal(getterCalls, 0)
})

test("ScrollView rejects axes outside its declared literal contract", () => {
  assert.throws(() => ScrollView("sideways", () => Text("Invalid")), /No matching initializer/)
  assert.throws(() => ScrollView(Text("Invalid"), "sideways"), /No matching initializer/)

  const html = renderToHTML(ScrollView("both", () => Text("Valid")))
  assert.match(html, /overflow-x:auto/)
  assert.match(html, /overflow-y:auto/)
})

test("custom View modifiers reach the rendered root in every renderer", async () => {
  const Card = defineView("ModifierCard", {
    initializers: [initializer("ModifierCard()", args => args.length === 0)],
    body: () => Element("article", { "data-card": "root" }, Text("Card")),
  })
  const value = Card().padding(7).className("custom-card")
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]
  for (const html of outputs) {
    assert.match(html, /class="custom-card"/)
    assert.match(html, /padding:\s*7px/)
    assert.match(html, /data-card="root"/)
  }
})
