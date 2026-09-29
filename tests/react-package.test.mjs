import assert from "node:assert/strict"
import test from "node:test"
import { createElement, forwardRef, memo } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  defineBuiltinView,
  Element,
  initializer,
  initializerKinds,
  GeometryReader,
  SafeArea,
  ScrollView,
  compiledTemplate,
  defineCompiledTemplate,
  viewElement,
} from "../packages/core/dist/compat.js"
import { Component, State, createReactView, foreignComponent, fromReactState, reactComponent, render, view } from "../packages/react/dist/index.js"

const Text = defineBuiltinView(
  "Text",
  [initializer("Text(value)", args => args.length === 1, args => ({ value: args[0] }), [initializerKinds.value()])],
  ({ value }) => viewElement("span", null, [value]),
)

test("@mun/react renders the core graph at the React boundary", () => {
  const html = renderToStaticMarkup(render(Text("Hello").padding(8)))
  assert.match(html, /<span style="padding:8px">Hello<\/span>/)
  assert.equal(renderToStaticMarkup(render(Text("Styled").className(["card", false, "active"]))), '<span class="card active">Styled</span>')
})

test("@mun/react materializes compiled templates through the native template path", () => {
  const template = defineCompiledTemplate({
    kind: "element", type: "div", props: { className: "compiled" }, children: [
      { kind: "element", type: "span", props: null, children: ["Static"] },
      { kind: "element", type: "span", props: null, children: [{ kind: "slot", index: 0, identity: ["element", 1, "element", 0] }] },
    ],
  }, 1)
  assert.equal(renderToStaticMarkup(render(compiledTemplate(template, ["React template"]))), '<div class="compiled"><span>Static</span><span>React template</span></div>')
})

test("@mun/react view keeps props at the renderer boundary", () => {
  const Greeting = view(({ name }) => Text(`Hello, ${name}`))
  const html = renderToStaticMarkup(createElement(Greeting, { name: "Mun" }))
  assert.equal(html, "<span>Hello, Mun</span>")
})

test("@mun/react stateful view scopes State creation to each mounted identity", () => {
  let factories = 0
  const Counter = view({
    state: () => { factories += 1; return { count: State(2) } },
    body: ({ count }) => Text(String(count.value)),
  })
  const html = renderToStaticMarkup(createElement("div", null, createElement(Counter), createElement(Counter)))
  assert.equal(html, "<div><span>2</span><span>2</span></div>")
  assert.equal(factories, 2)
})

test("@mun/react adapts raw HTML names to native React props at the boundary", () => {
  const save = () => undefined
  const element = render(Element("button", { class: "card", for: "name", onclick: save }, "Save"))
  assert.equal(element.props.className, "card")
  assert.equal(element.props.htmlFor, "name")
  assert.equal(element.props.onClick, save)
})

test("@mun/react adapts real inline CSS strings at the renderer boundary", () => {
  const element = render(Element("x-card", { style: "color: red; --accent: blue", "data-kind": "custom" }, "Card"))
  assert.deepEqual(element.props.style, { color: "red", "--accent": "blue" })
  assert.equal(element.props["data-kind"], "custom")
})

test("@mun/react shares core scroll and safe-area Views", () => {
  const value = SafeArea(() => [ScrollView("horizontal", () => [Element("span", null, "Items")])])
  const html = renderToStaticMarkup(render(value))
  assert.match(html, /data-mun="SafeArea"/)
  assert.match(html, /data-mun="ScrollView"/)
  assert.match(html, /overflow-x:auto/)
  assert.match(html, /overflow-y:hidden/)
})

test("@mun/react materializes GeometryReader with a renderer-owned boundary", () => {
  const value = GeometryReader(geometry => Element("span", null, `${geometry.size.width}x${geometry.size.height}`))
  const html = renderToStaticMarkup(render(value))
  assert.match(html, /data-mun="GeometryReader"/)
  assert.match(html, />0x0<\/span>/)
})

test("React components enter and leave the Mün graph through typed explicit boundaries", () => {
  function Badge({ label }) { return createElement("strong", null, label) }
  const MemoBadge = memo(Badge)
  const ForwardBadge = forwardRef(({ label }, ref) => createElement("strong", { ref }, label))
  const value = Text("before ")
  const direct = render(Component(MemoBadge, { label: "memo" }))
  assert.equal(renderToStaticMarkup(direct), "<strong>memo</strong>")
  assert.equal(renderToStaticMarkup(render(Component(ForwardBadge, { label: "forward" }))), "<strong>forward</strong>")
  const Adapted = reactComponent(Badge)
  const Generic = foreignComponent(Badge)
  assert.equal(renderToStaticMarkup(render(Adapted({ label: "adapted" }))), "<strong>adapted</strong>")
  assert.equal(renderToStaticMarkup(render(Generic({ label: "generic" }))), "<strong>generic</strong>")
  assert.equal(Adapted.component, Badge)
  assert.equal(value.kind, "element")
})

test("React graph factories retain React props at the native component boundary", () => {
  const Greeting = createReactView(({ name }) => Text(`Hello ${name}`))
  assert.equal(renderToStaticMarkup(createElement(Greeting, { name: "React" })), "<span>Hello React</span>")
})

test("React component prop snapshots do not invoke accessors or revoked proxies", () => {
  function Badge({ label }) { return createElement("span", null, label) }
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  assert.deepEqual(Component(Badge, revoked.proxy).type.props, {})
  let calls = 0
  const props = { label: "safe" }
  Object.defineProperty(props, "danger", { enumerable: true, get() { calls += 1; throw new Error("must not run") } })
  assert.deepEqual(Component(Badge, props).type.props, { label: "safe" })
  assert.equal(calls, 0)
})

test("React state setters can be exposed as Mun Bindings", () => {
  let current = "before"
  const binding = fromReactState(current, next => { current = typeof next === "function" ? next(current) : next })
  binding.value = "after"
  assert.equal(current, "after")
  assert.equal(binding.value, "before")
})
