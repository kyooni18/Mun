import assert from "node:assert/strict"
import test from "node:test"
import { Suspense, createSSRApp, defineAsyncComponent, defineComponent, h, inject, provide, ref, watchEffect } from "vue"
import { renderToString } from "@vue/server-renderer"
import {
  Animation,
  Button,
  GeometryReader,
  State,
  Text,
  VStack,
  compiledTemplate,
  defineCompiledTemplate,
} from "../packages/core/dist/compat.js"
import { initializersOf, namedArguments } from "../packages/core/dist/compat.js"
import {
  Component,
  MunView,
  createVueView,
  foreignComponent,
  fromVueRef,
  render,
  toVueRef,
  vueComponent,
} from "../packages/vue/dist/index.js"

test("@mun/vue renders the renderer-independent graph as Vue VNodes", async () => {
  const value = VStack(() => [Text("Hello Vue"), Button("Save", () => undefined)])
  const html = await renderToString(createSSRApp({ render: () => h(MunView, { value }) }))
  assert.match(html, /Hello Vue/)
  assert.match(html, /<button[^>]*><span>Save<\/span><\/button>/)
  assert.match(html, /data-mun="VStack"/)
  const styled = await renderToString(createSSRApp({ render: () => render(Text("Styled").className(["card", false, "active"])) }))
  assert.match(styled, /class="card active"/)
})

test("@mun/vue MunView can suppress explicit animation styles at the host boundary", async () => {
  const value = Text("Still").opacity(0.5).animation(Animation.linear(0.4), 0.5)
  const animated = await renderToString(createSSRApp({ render: () => h(MunView, { value }) }))
  const suppressed = await renderToString(createSSRApp({ render: () => h(MunView, { value, disablesAnimations: true }) }))
  assert.match(animated, /transition-duration:0.4s/)
  assert.doesNotMatch(suppressed, /transition-duration/)
})

test("@mun/vue materializes compiled templates as native Vue VNodes", async () => {
  const template = defineCompiledTemplate({
    kind: "element", type: "div", props: { class: "compiled" }, children: [
      { kind: "element", type: "span", props: null, children: ["Static"] },
      { kind: "element", type: "span", props: null, children: [{ kind: "slot", index: 0, identity: ["element", 1, "element", 0] }] },
    ],
  }, 1)
  const html = await renderToString(createSSRApp({ render: () => render(compiledTemplate(template, ["Vue template"])) }))
  assert.match(html, /<div class="compiled"><span>Static<\/span><span>Vue template<\/span><\/div>/)
})

test("Vue components enter Mun before Vue materialization and Mün Views enter Vue SFCs", async () => {
  const Badge = defineComponent({
    props: { label: { type: String, required: true } },
    setup(props) { return () => h("strong", null, props.label) },
  })
  const value = VStack(Component(Badge, { label: "Vue component" }))
  const html = await renderToString(createSSRApp({ render: () => render(value) }))
  assert.match(html, /<strong>Vue component<\/strong>/)
  const MunBadge = foreignComponent(Badge)
  assert.equal(MunBadge({ label: "Graph Vue" }).kind, "element")
  const adaptedHtml = await renderToString(createSSRApp({ render: () => render(MunBadge({ label: "Adapted Vue" })) }))
  assert.match(adaptedHtml, /<strong>Adapted Vue<\/strong>/)
  assert.equal(initializersOf(MunBadge).length, 1)
  const LegacyMunBadge = vueComponent(Badge)
  assert.equal(initializersOf(LegacyMunBadge).length, 1)
  const namedHtml = await renderToString(createSSRApp({ render: () => render(MunBadge(namedArguments({ label: "Named Vue" }))) }))
  assert.match(namedHtml, /<strong>Named Vue<\/strong>/)

  const Panel = defineComponent({
    setup(_props, { slots }) {
      return () => h("article", null, [h("header", null, slots.header?.()), slots.default?.()])
    },
  })
  const panel = VStack(Component(Panel, { slots: { header: () => Text("Header") } }, Text("Body")))
  const panelHtml = await renderToString(createSSRApp({ render: () => render(panel) }))
  assert.match(panelHtml, /<header><span>Header<\/span><\/header>/)
  assert.match(panelHtml, /<span>Body<\/span>/)

  const Greeting = createVueView(props => Text(`Hello ${props.name}`))
  const greetingHtml = await renderToString(createSSRApp({ render: () => h(Greeting, { name: "Mun" }) }))
  assert.match(greetingHtml, /Hello Mun/)
})

test("Vue component adapters isolate revoked and accessor props", () => {
  const Badge = defineComponent({ props: { label: String }, render() { return h("span", null, this.label) } })
  const pair = Proxy.revocable({}, {})
  pair.revoke()
  const direct = Component(Badge, pair.proxy)
  assert.deepEqual(direct.type.props, {})

  const AdaptedBadge = vueComponent(Badge)
  assert.throws(() => AdaptedBadge(pair.proxy), /No matching initializer/)

  let getterCalls = 0
  const props = { label: "safe" }
  Object.defineProperty(props, "slots", {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error("component slots getter must not run")
    },
  })
  const value = Component(Badge, props)
  assert.deepEqual(value.type.props, { label: "safe" })
  assert.deepEqual(value.type.slots, {})
  assert.equal(getterCalls, 0)
})

test("Vue scoped slots and provide/inject cross the Mün graph without losing Vue ownership", async () => {
  const key = Symbol("mun-context")
  const Provider = defineComponent({
    setup(_props, { slots }) {
      provide(key, "provided")
      return () => h("section", null, slots.default?.())
    },
  })
  const Consumer = defineComponent({ setup: () => () => h("strong", null, inject(key, "missing")) })
  const Scoped = defineComponent({
    setup(_props, { slots }) { return () => h("article", null, slots.row?.({ label: "Scoped" })) },
  })
  const value = Component(Provider, null,
    Component(Consumer),
    Component(Scoped, { slots: { row: ({ label }) => Text(`${label} slot`) } }),
  )
  const html = await renderToString(createSSRApp({ render: () => render(value) }))
  assert.match(html, /<strong>provided<\/strong>/)
  assert.match(html, /Scoped slot/)
})

test("Vue async components and Suspense retain native slot semantics inside Mun", async () => {
  const AsyncBadge = defineAsyncComponent(async () => defineComponent({
    setup: () => () => h("strong", null, "Async Vue"),
  }))
  const value = Component(Suspense, { slots: {
    default: () => Component(AsyncBadge),
    fallback: () => Text("Loading"),
  } })
  const html = await renderToString(createSSRApp({ render: () => render(value) }))
  assert.match(html, /<strong>Async Vue<\/strong>/)
})

test("@mun/vue preserves component events, refs, and graph keys", () => {
  const save = () => undefined
  const reference = ref(null)
  const vnode = render(Component("button", { onclick: save, ref: reference }, Text("Save")).keyed("save"))
  assert.equal(vnode.key, "save")
  assert.equal(vnode.props?.onClick, save)
  assert.equal(vnode.props?.ref, reference)
})

test("Vue and Mun reactivity cross only through explicit ref bridges", () => {
  const state = State(1)
  const vueState = toVueRef(state)
  vueState.value = 2
  assert.equal(state.value, 2)

  const vueValue = ref("before")
  const binding = fromVueRef(vueValue)
  binding.value = "after"
  assert.equal(vueValue.value, "after")
})

test("toVueRef invalidates Vue effects exactly once per State change", () => {
  const state = State(1)
  const vueState = toVueRef(state)
  let runs = 0
  const stop = watchEffect(() => {
    void vueState.value
    runs += 1
  }, { flush: "sync" })

  assert.equal(runs, 1)
  vueState.value = 2
  assert.equal(runs, 2)
  vueState.value = 2
  assert.equal(runs, 2)
  state.value = 3
  assert.equal(runs, 3)
  stop()
})

test("@mun/vue materializes GeometryReader through a measured host boundary", async () => {
  const value = GeometryReader(geometry => Text(`${geometry.size.width}x${geometry.size.height}`))
  const html = await renderToString(createSSRApp({ render: () => render(value) }))
  assert.match(html, /data-mun="GeometryReader"/)
  assert.match(html, /0x0/)
})
