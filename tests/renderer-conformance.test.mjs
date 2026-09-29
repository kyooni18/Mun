import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { renderToStaticMarkup } from "react-dom/server"
import { createSSRApp } from "vue"
import { renderToString } from "@vue/server-renderer"
import { BindingValue, Button, Element, ForeignComponent, LazyVStack, SafeArea, State, Text, Toggle, VStack, defineView, initializer } from "../packages/core/dist/compat.js"
import { render as renderReact } from "../packages/react/dist/index.js"
import { render as renderVue } from "../packages/vue/dist/index.js"
import { renderToHTML } from "../packages/web/dist/index.js"

const Card = defineView("Card", {
  initializers: [initializer("Card()", args => args.length === 0)],
  body: () => Element("article", { "data-card": "root" }, Text("Card body")),
})

test("the shared Text/VStack/Button/Card graph has renderer-conformant SSR semantics", async () => {
  const value = VStack(
    Text("Title"),
    Button("Save", () => {}),
    Card(),
  ).padding(8)
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]

  for (const html of outputs) {
    assert.match(html, /data-mun="VStack"/)
    assert.match(html, /padding:8px/)
    assert.match(html, /<span>Title<\/span>/)
    assert.match(html, /<button type="button"><span>Save<\/span><\/button>/)
    assert.match(html, /<article data-card="root"><span>Card body<\/span><\/article>/)
  }
})

test("SwiftUI-derived transform anchors and independent transform channels stay renderer-conformant", async () => {
  const value = Text("Motion")
    .scaleEffect({ x: 1.25, y: 0.75 }, "topLeading")
    .rotationEffect(15, "topLeading")
    .offset(8, 6)
    .background("linear-gradient(red, blue)", "bottomTrailing")
    .bold()
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]

  for (const html of outputs) {
    const document = new JSDOM(html).window.document
    const element = document.body.firstElementChild
    assert.ok(element)
    assert.equal(element.style.scale, "1.25 0.75")
    assert.equal(element.style.rotate, "15deg")
    assert.equal(element.style.translate, "8px 6px")
    assert.equal(element.style.transformOrigin, "left top")
    assert.equal(element.style.backgroundPosition, "right bottom")
    assert.equal(element.style.fontWeight, "700")
  }
})

test("scaleEffect keeps SwiftUI's independent labeled-axis defaults", async () => {
  const value = Text("Axis").scaleEffect({ x: 1.5 }, "center")
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]
  for (const html of outputs) {
    const document = new JSDOM(html).window.document
    assert.equal(document.body.firstElementChild?.style.scale, "1.5 1")
  }
})

test("expanded SwiftUI text, visual, layout, and accessibility modifiers stay renderer-conformant", async () => {
  const value = Text("Expanded")
    .padding("horizontal", 12)
    .fontWeight("semibold")
    .italic()
    .tracking(1.5)
    .border("red", 2)
    .shadow("black", 4, 1, 2)
    .zIndex(3)
    .accessibilityLabel("Expanded label")
    .accessibilityHint("Expanded hint")
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]

  for (const html of outputs) {
    const document = new JSDOM(html).window.document
    const element = document.body.firstElementChild
    assert.ok(element)
    assert.equal(element.style.paddingLeft, "12px")
    assert.equal(element.style.paddingRight, "12px")
    assert.equal(element.style.fontWeight, "600")
    assert.equal(element.style.fontStyle, "italic")
    assert.equal(element.style.letterSpacing, "1.5px")
    assert.equal(element.style.borderTopWidth, "2px")
    assert.equal(element.style.borderTopColor, "red")
    assert.match(element.style.boxShadow, /1px 2px 4px/)
    assert.equal(element.style.zIndex, "3")
    assert.equal(element.getAttribute("aria-label"), "Expanded label")
    assert.equal(element.getAttribute("aria-description"), "Expanded hint")
  }
})

test("View-backed background and overlay are structural across renderers", async () => {
  const value = Text("Body")
    .background(Text("Backdrop"), "center")
    .overlay(Text("Badge"), "topTrailing")
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]

  for (const html of outputs) {
    assert.match(html, /Body/)
    assert.match(html, /Backdrop/)
    assert.match(html, /Badge/)
    const document = new JSDOM(html).window.document
    const grids = [...document.querySelectorAll("div")].filter(element => element.style.display === "grid")
    assert.ok(grids.length >= 2)
    assert.ok([...document.querySelectorAll("div")].some(element => element.style.placeSelf === "start end"))
  }
})

test("safe-area, grid, 3D transform, identity, and accessibility semantics stay renderer-conformant", async () => {
  const value = Text("Platform")
    .safeAreaPadding("horizontal", 6)
    .ignoresSafeArea("all", "top")
    .gridCellColumns(2)
    .gridCellAnchor("bottomTrailing")
    .rotation3DEffect(30, { x: 0, y: 1, z: 0 }, "topLeading")
    .id("platform-row")
    .accessibilityElement("contain")
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]

  for (const html of outputs) {
    const document = new JSDOM(html).window.document
    const element = document.body.firstElementChild
    assert.ok(element)
    assert.match(element.style.paddingLeft, /safe-area-inset-left/)
    assert.match(element.style.paddingRight, /safe-area-inset-right/)
    assert.equal(element.style.paddingTop, "")
    assert.match(element.style.marginTop, /safe-area-inset-top/)
    assert.equal(element.style.marginLeft, "")
    assert.equal(element.style.gridColumn, "span 2")
    assert.equal(element.style.placeSelf, "end end")
    assert.match(element.style.transform, /rotate3d\(0, 1, 0, 30deg\)/)
    assert.equal(element.style.transformOrigin, "left top")
    assert.equal(element.getAttribute("data-mun-id"), "platform-row")
    assert.equal(element.getAttribute("role"), "group")
  }
})

test("raw HTML, foreign boundaries, and CSS environment semantics stay renderer-conformant", async () => {
  const value = Element("section", { class: "raw-card", "data-raw": "yes", "aria-label": "raw" },
    Element("strong", null, "Raw"),
    ForeignComponent("button", { name: "ConformanceForeign", props: { "data-foreign": "yes", title: "foreign" } }, Text("Foreign")),
  )
  const safe = SafeArea(["top"], () => Text("Inset"))
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
    renderToStaticMarkup(renderReact(safe)),
    await renderToString(createSSRApp({ render: () => renderVue(safe) })),
    renderToHTML(safe),
  ]

  for (const html of outputs.slice(0, 3)) {
    assert.match(html, /data-raw="yes"/)
    assert.match(html, /Raw/)
    assert.match(html, /data-foreign="yes"/)
    assert.match(html, /Foreign/)
  }
  for (const html of outputs.slice(3)) assert.match(html, /safe-area-inset-top/)
})

test("BindingValue has the same writable control semantics in React, Vue, and Web", async () => {
  const state = State(false)
  const value = Toggle("Enabled", BindingValue(state))
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]
  for (const html of outputs) assert.match(html, /type="checkbox"/)
  state.value = true
  assert.equal(BindingValue(state).value, true)
})

test("lazy graph boundaries keep renderer-conformant SSR fallback markup", async () => {
  const value = LazyVStack({ estimatedItemSize: 40 }, Text("One"), Text("Two"))
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]
  for (const html of outputs) {
    assert.match(html, /data-mun="LazyVStack"/)
    assert.match(html, /data-mun-lazy="vertical"/)
    assert.match(html, /<span>One<\/span><span>Two<\/span>/)
  }
})

test("custom View state accessors are omitted consistently across renderers", async () => {
  let getterCalls = 0
  const Stateful = defineView("StateAccessorConformance", {
    initializers: [initializer("StateAccessorConformance()", args => args.length === 0)],
    state: () => {
      const state = { safe: "state" }
      Object.defineProperty(state, "hostile", {
        enumerable: true,
        get() {
          getterCalls += 1
          throw new Error("renderer must not execute state getters")
        },
      })
      return state
    },
    body: props => Text(`${props.safe}:${Object.hasOwn(props, "hostile")}`),
  })
  const value = Stateful()
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]
  for (const html of outputs) assert.match(html, /state:false/)
  assert.equal(getterCalls, 0)
})

test("invalid object and non-finite style values are inert across renderers", async () => {
  let coercionCalls = 0
  const value = Element("div", {
    style: {
      color: { toString() { coercionCalls += 1; return "red" } },
      display: "grid",
      opacity: Number.NaN,
      "--accent": "blue",
    },
  })
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]

  for (const html of outputs) {
    assert.match(html, /display:grid/)
    assert.match(html, /--accent:blue/)
    assert.doesNotMatch(html, /color:red|opacity:NaN/)
  }
  assert.equal(coercionCalls, 0)
})

test("invalid native HTML attribute objects are inert across renderers", async () => {
  let coercionCalls = 0
  const value = Element("div", {
    title: { toString() { coercionCalls += 1; return "coerced" } },
    "data-safe": "yes",
  })
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]

  for (const html of outputs) {
    assert.match(html, /data-safe="yes"/)
    assert.doesNotMatch(html, /title=|coerced/)
  }
  assert.equal(coercionCalls, 0)
})

test("withProps cannot reintroduce coercible objects at native roots", async () => {
  for (const value of [Element("div", { "data-safe": "yes" }), Text("value")]) {
    let coercionCalls = 0
    const modified = value.withProps({
      title: { toString() { coercionCalls += 1; return "coerced" } },
      "data-modified": "yes",
    })
    const outputs = [
      renderToStaticMarkup(renderReact(modified)),
      await renderToString(createSSRApp({ render: () => renderVue(modified) })),
      renderToHTML(modified),
    ]

    for (const html of outputs) {
      assert.match(html, /data-modified="yes"/)
      assert.doesNotMatch(html, /title=|coerced/)
    }
    assert.equal(coercionCalls, 0)
  }
})

test("custom element object props remain non-serializing across SSR renderers", async () => {
  let coercionCalls = 0
  const value = Element("mun-card", {
    payload: { toString() { coercionCalls += 1; return "coerced" } },
    label: "safe",
  })
  const outputs = [
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
    renderToHTML(value),
  ]

  for (const html of outputs) {
    assert.match(html, /label="safe"/)
    assert.doesNotMatch(html, /payload=|coerced/)
  }
  assert.equal(coercionCalls, 0)
})
