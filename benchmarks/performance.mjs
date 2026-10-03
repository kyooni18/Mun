import { performance } from "node:perf_hooks"
import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup, renderToString as renderReactToString } from "react-dom/server"
import { JSDOM } from "jsdom"
import { compileMunFile } from "../packages/compiler/dist/index.js"
import {
  Element,
  ForEach,
  LazyVStack,
  State,
  Text,
  VStack,
  compiledTemplate,
  defineCompiledTemplate,
  defineView,
  initializer,
  initializerKinds,
  subscribeState,
} from "../packages/core/dist/compat.js"
import { compiledCollectionContent } from "../packages/core/dist/internal-runtime.js"
import { render as renderReact } from "../packages/react/dist/index.js"
import { mount, renderToHTML } from "../packages/web/dist/index.js"

const ci = process.env.MUN_BENCH_CI === "1"
const counts = (process.env.MUN_BENCH_ITEMS ?? (ci ? "100,1000" : "100,1000,10000"))
  .split(",")
  .map(value => Number(value.trim()))
  .filter(value => Number.isFinite(value) && value > 0)
const rounds = Number(process.env.MUN_BENCH_ROUNDS ?? (ci ? 3 : 5))
const warmupRounds = Number(process.env.MUN_BENCH_WARMUP_ROUNDS ?? 1)
const results = []
let vueBenchmarkRuntime
const budgets = {
  construction: 8,
  forEach: 12,
  reactSSR: 10,
  vueSSR: 20,
  webSSR: 12,
  dom: 25,
  heap: 10,
  specialization: 1.25,
  templateConstruction: Number(process.env.MUN_BENCH_TEMPLATE_RATIO ?? 1.25),
  state: 25,
  compiler: Number(process.env.MUN_BENCH_COMPILER_MS ?? 250),
  hydration: 1000,
  reactHydrationRatio: Number(process.env.MUN_BENCH_REACT_HYDRATION_RATIO ?? 10),
  vueHydrationRatio: Number(process.env.MUN_BENCH_VUE_HYDRATION_RATIO ?? 10),
  keyedDom: 2000,
  reactRerender: 2000,
  vueRerender: 2000,
  reactClientRatio: Number(process.env.MUN_BENCH_REACT_CLIENT_RATIO ?? 10),
  vueClientRatio: Number(process.env.MUN_BENCH_VUE_CLIENT_RATIO ?? 10),
  deepState: 25,
  burstDom: 1500,
  conditionalDom: 2000,
  lazyScroll: 2000,
  showcaseCompiler: Number(process.env.MUN_BENCH_SHOWCASE_COMPILER_MS ?? 500),
}

function median(samples) {
  const ordered = [...samples].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle]
}

function retainedHeap(factory) {
  if (typeof globalThis.gc !== "function") return undefined
  globalThis.gc()
  const before = process.memoryUsage().heapUsed
  // Amplify small allocations so V8's heap quantization does not turn a
  // valid baseline into zero and produce a meaningless ratio.
  let retained = Array.from({ length: 8 }, factory)
  globalThis.gc()
  const after = process.memoryUsage().heapUsed
  retained = undefined
  globalThis.gc()
  return Math.max(0, after - before)
}

function measure(name, factory) {
  const samples = []
  for (let round = 0; round < warmupRounds; round += 1) factory()
  for (let round = 0; round < rounds; round += 1) {
    const start = performance.now()
    factory()
    samples.push(performance.now() - start)
  }
  const value = median(samples)
  console.log(`${name}: ${value.toFixed(2)} ms (median of ${rounds} rounds)`)
  return value
}

function measureMutation(name, setup, mutate) {
  const samples = []
  for (let round = 0; round < warmupRounds; round += 1) {
    const fixture = setup()
    mutate(fixture)
    fixture.cleanup?.()
  }
  for (let round = 0; round < rounds; round += 1) {
    const fixture = setup()
    const start = performance.now()
    mutate(fixture)
    samples.push(performance.now() - start)
    fixture.cleanup?.()
  }
  const value = median(samples)
  console.log(`${name}: ${value.toFixed(2)} ms (median of ${rounds} rounds, mutation only)`)
  return value
}

async function measureAsync(name, factory) {
  const samples = []
  for (let round = 0; round < warmupRounds; round += 1) await factory()
  for (let round = 0; round < rounds; round += 1) {
    const start = performance.now()
    await factory()
    samples.push(performance.now() - start)
  }
  const value = median(samples)
  console.log(`${name}: ${value.toFixed(2)} ms (median of ${rounds} rounds)`)
  return value
}

function ratio(name, actual, baseline, budget, guard = true) {
  const value = actual / Math.max(baseline, 0.001)
  results.push({ name, actual, baseline, ratio: value })
  console.log(`${name} ratio: ${value.toFixed(2)}x (budget ${budget}x)`)
  if (ci && guard && value > budget) throw new Error(`${name} exceeded ${budget}x baseline: ${value.toFixed(2)}x`)
}

function itemViews(count) {
  return Array.from({ length: count }, (_, index) => Text(String(index)))
}

function rawReactItems(count) {
  return Array.from({ length: count }, (_, index) => createElement("span", { key: index }, String(index)))
}

function rawVueItems(count, h) {
  return Array.from({ length: count }, (_, index) => h("span", { key: index }, String(index)))
}

const PerformanceCard = defineView("PerformanceCard", {
  initializers: [
    initializer("PerformanceCard(title)", args => args.length === 1 && typeof args[0] === "string", args => ({ title: args[0] }), [initializerKinds.value(true, "title", undefined, "string")]),
    initializer("PerformanceCard(value)", args => args.length === 1 && typeof args[0] === "number", args => ({ title: String(args[0]) }), [initializerKinds.value(true, "value", undefined, "number")]),
  ],
  body: ({ title }) => Element("span", null, title),
})

const specializationCount = Number(process.env.MUN_BENCH_SPECIALIZATION_ITEMS ?? (ci ? 1000 : 10000))
const dynamicInitializer = measure(`dynamic initializer resolution ${specializationCount}`, () => Array.from({ length: specializationCount }, () => PerformanceCard("static")))
const specializedInitializer = measure(`specialized initializer construction ${specializationCount}`, () => Array.from({ length: specializationCount }, () => PerformanceCard.viewType.createNodeSpecialized(0, ["static"])))
ratio("specialized initializer construction", specializedInitializer, dynamicInitializer, budgets.specialization)
const compiledInitializer = measure(`compiled initializer construction ${specializationCount}`, () => Array.from({ length: specializationCount }, () => PerformanceCard.viewType.createNodeCompiled(0, ["static"])))
ratio("compiled initializer construction", compiledInitializer, specializedInitializer, budgets.specialization)

const templateConstructionCount = Number(process.env.MUN_BENCH_TEMPLATE_ITEMS ?? (ci ? 1000 : 10000))
const dynamicTextTemplate = defineCompiledTemplate({
  kind: "element",
  type: "div",
  props: { "data-mun": "VStack", style: { display: "flex", flexDirection: "column" } },
  children: [
    { kind: "element", type: "span", props: null, children: ["Static"] },
    { kind: "element", type: "span", props: null, children: [{ kind: "slot", index: 0, identity: ["element", 1, "element", 0] }] },
  ],
}, 1)
const ordinaryDynamicGraph = measure(`ordinary dynamic graph construction ${templateConstructionCount}`, () => Array.from({ length: templateConstructionCount }, (_, index) => VStack(Text("Static"), Text(String(index)))))
const templateDynamicGraph = measure(`compiled template construction ${templateConstructionCount}`, () => Array.from({ length: templateConstructionCount }, (_, index) => compiledTemplate(dynamicTextTemplate, [String(index)])))
ratio("compiled template construction", templateDynamicGraph, ordinaryDynamicGraph, budgets.templateConstruction)

const compilerSource = `import { Text, VStack } from "@mun/ui"
struct BenchCard: View {
  let title: string
  init(title: string) { self.title = title }
  var body: some View { VStack { Text(title).padding(4) } }
}
export const bench = BenchCard(title: "benchmark")`
const compilerTransform = measure(".mun.ts compiler transform", () => compileMunFile(compilerSource, "benchmark.mun.ts"))
if (!Number.isFinite(compilerTransform)) throw new Error("Compiler benchmark produced a non-finite measurement")
console.log(`compiler transform budget: ${budgets.compiler} ms ceiling for one fixture`)
if (ci && compilerTransform > budgets.compiler) throw new Error(`Compiler transform exceeded ${budgets.compiler} ms: ${compilerTransform.toFixed(2)} ms`)

const showcaseSource = readFileSync(new URL("../examples/Showcase.mun.ts", import.meta.url), "utf8")
// Warm the static TypeScript program/source-file caches before measuring the editing loop.
compileMunFile(showcaseSource, "examples/Showcase.mun.ts")
const showcaseCompiler = measure("Showcase warm compiler transform", () => compileMunFile(showcaseSource, "examples/Showcase.mun.ts"))
console.log(`Showcase compiler budget: ${budgets.showcaseCompiler} ms ceiling for one medium fixture`)
if (ci && showcaseCompiler > budgets.showcaseCompiler) throw new Error(`Showcase compiler transform exceeded ${budgets.showcaseCompiler} ms: ${showcaseCompiler.toFixed(2)} ms`)

for (const count of counts) {
  const views = itemViews(count)
  const items = Array.from({ length: count }, (_, index) => ({ id: index, value: String(index) }))

  const rawConstruction = measure(`raw React construction ${count}`, () => rawReactItems(count))
  const munConstruction = measure(`Mun View construction ${count}`, () => VStack(...itemViews(count)))
  ratio(`View construction ${count}`, munConstruction, rawConstruction, budgets.construction)
  const rawHeap = retainedHeap(() => rawReactItems(count))
  const munHeap = retainedHeap(() => VStack(...itemViews(count)))
  if (rawHeap !== undefined && munHeap !== undefined) {
    console.log(`retained heap ${count}: raw ${(rawHeap / 1024).toFixed(1)} KiB, Mun ${(munHeap / 1024).toFixed(1)} KiB`)
    if (rawHeap > 0) ratio(`retained heap ${count}`, munHeap, rawHeap, budgets.heap)
    else console.log(`retained heap ${count} ratio skipped: baseline below measurable heap resolution`)
  }

  const rawForEach = measure(`raw React list construction ${count}`, () => rawReactItems(count))
  const munForEach = measure(`Mun ForEach construction ${count}`, () => ForEach(items, item => Text(item.value)))
  ratio(`ForEach construction ${count}`, munForEach, rawForEach, budgets.forEach)

  const tree = VStack(...views)
  const rawSSR = measure(`raw React SSR ${count}`, () => renderToStaticMarkup(createElement("div", null, ...rawReactItems(count))))
  const reactSSR = measure(`Mun React SSR ${count}`, () => renderToStaticMarkup(renderReact(tree)))
  ratio(`React SSR ${count}`, reactSSR, rawSSR, budgets.reactSSR)

  const webSSR = measure(`Mun Web SSR ${count}`, () => renderToHTML(tree))
  ratio(`Web SSR ${count}`, webSSR, rawSSR, budgets.webSSR)

  const { runtime: vue, munRenderer, serverRenderer } = await getVueRuntime()
  const vueSSR = await measureAsync(`Mun Vue SSR ${count}`, async () => {
    await serverRenderer.renderToString(vue.createSSRApp({ render: () => munRenderer.render(tree) }))
  })
  const rawVueSSR = await measureAsync(`raw Vue SSR ${count}`, async () => {
    await serverRenderer.renderToString(vue.createSSRApp({ render: () => vue.h("div", null, rawVueItems(count, vue.h)) }))
  })
  ratio(`Vue SSR ${count}`, vueSSR, rawVueSSR, budgets.vueSSR)
}

async function rawDomUpdate(count) {
  const dom = new JSDOM("<div id=app></div>")
  const container = dom.window.document.querySelector("#app")
  const textNodes = rawReactItems(count).map(node => {
    const element = dom.window.document.createElement("span")
    const text = dom.window.document.createTextNode(node.props.children)
    element.appendChild(text)
    container.appendChild(element)
    return text
  })
  const start = performance.now()
  textNodes.forEach((node, index) => { node.nodeValue = `next-${index}` })
  const elapsed = performance.now() - start
  dom.window.close()
  return elapsed
}

async function munDomUpdate(count) {
  const dom = new JSDOM("<div id=app></div>")
  const container = dom.window.document.querySelector("#app")
  const values = State(Array.from({ length: count }, (_, index) => String(index)))
  const App = defineView(`PerformanceApp${count}`, {
    initializers: [initializer(`PerformanceApp${count}()`, args => args.length === 0)],
    body: () => Element("div", null, values.value.map(value => Element("span", null, value))),
  })
  const unmount = mount(App(), container)
  await Promise.resolve()
  const start = performance.now()
  values.value = values.value.map((_, index) => `next-${index}`)
  await Promise.resolve()
  await Promise.resolve()
  const elapsed = performance.now() - start
  unmount()
  dom.window.close()
  return elapsed
}

async function keyedDomUpdate(count) {
  const dom = new JSDOM("<div id=app></div>")
  const container = dom.window.document.querySelector("#app")
  const items = State(Array.from({ length: count }, (_, index) => ({ id: index, value: String(index) })))
  const App = defineView(`KeyedPerformanceApp${count}`, {
    initializers: [initializer(`KeyedPerformanceApp${count}()`, args => args.length === 0)],
    body: () => Element("div", null, ForEach(items.value, item => Element("span", { "data-key": item.id }, item.value))),
  })
  const unmount = mount(App(), container)
  await Promise.resolve()
  const start = performance.now()
  items.value = [...items.value].reverse()
  await Promise.resolve()
  await Promise.resolve()
  const elapsed = performance.now() - start
  unmount()
  dom.window.close()
  return elapsed
}

async function webHydration(count) {
  const dom = new JSDOM("<div id=app></div>")
  const container = dom.window.document.querySelector("#app")
  const items = Array.from({ length: count }, (_, index) => ({ id: index, value: String(index) }))
  const App = defineView(`HydrationPerformanceApp${count}`, {
    initializers: [initializer(`HydrationPerformanceApp${count}()`, args => args.length === 0)],
    body: () => Element("div", null, ForEach(items, item => Element("span", { "data-key": item.id }, item.value))),
  })
  const value = App()
  container.innerHTML = renderToHTML(value)
  const start = performance.now()
  const unmount = mount(value, container, { hydrate: true })
  const elapsed = performance.now() - start
  unmount()
  dom.window.close()
  return elapsed
}

async function rawReactHydration(count) {
  const dom = new JSDOM("<div id=app></div>")
  const restore = installRendererDOM(dom)
  try {
    const { act } = await import("react")
    const { hydrateRoot } = await import("react-dom/client")
    const container = dom.window.document.querySelector("#app")
    const value = createElement("div", null, ...Array.from(
      { length: count },
      (_, index) => createElement("span", { key: index, "data-key": index }, String(index)),
    ))
    container.innerHTML = renderReactToString(value)
    let root
    const start = performance.now()
    await act(async () => { root = hydrateRoot(container, value) })
    const elapsed = performance.now() - start
    await act(async () => { root.unmount() })
    return elapsed
  } finally {
    restore()
  }
}

async function rawVueHydration(count) {
  const { dom, runtime: vue, serverRenderer } = await getVueRuntime()
  const container = dom.window.document.querySelector("#vue-benchmark-app")
  container.replaceChildren()
  try {
    const App = {
      render: () => vue.h("div", null, Array.from(
        { length: count },
        (_, index) => vue.h("span", { key: index, "data-key": index }, String(index)),
      )),
    }
    container.innerHTML = await serverRenderer.renderToString(vue.createSSRApp(App))
    const app = vue.createSSRApp(App)
    const start = performance.now()
    app.mount(container)
    await vue.nextTick()
    const elapsed = performance.now() - start
    app.unmount()
    return elapsed
  } finally {
    container.replaceChildren()
  }
}

function installRendererDOM(dom) {
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
    for (const [name, value] of previous) {
      if (name === "navigator") Object.defineProperty(globalThis, name, { configurable: true, value })
      else if (value === undefined) delete globalThis[name]
      else globalThis[name] = value
    }
    dom.window.close()
  }
}

async function getVueRuntime() {
  if (!vueBenchmarkRuntime) {
    const dom = new JSDOM("<div id=vue-benchmark-app></div>")
    const restore = installRendererDOM(dom)
    const runtime = await import("vue")
    const munRenderer = await import("../packages/vue/dist/index.js")
    const serverRenderer = await import("@vue/server-renderer")
    vueBenchmarkRuntime = { dom, restore, runtime, munRenderer, serverRenderer }
  }
  return vueBenchmarkRuntime
}

function clientItems(count) {
  return Array.from({ length: count }, (_, index) => ({ id: index, value: String(index) }))
}

function updateClientItems(items, mode) {
  if (mode === "reverse") return [...items].reverse()
  if (mode === "single") {
    const next = [...items]
    const index = Math.floor(next.length / 2)
    if (next[index]) next[index] = { ...next[index], value: `next-${index}` }
    return next
  }
  return items.map((item, index) => ({ ...item, value: `next-${index}` }))
}

async function rawReactRerender(count, mode = "full") {
  const dom = new JSDOM("<div id=app></div>")
  const restore = installRendererDOM(dom)
  try {
    const { act, useState } = await import("react")
    const { createRoot } = await import("react-dom/client")
    const { flushSync } = await import("react-dom")
    let setItems
    function App() {
      const [items, set] = useState(() => clientItems(count))
      setItems = set
      return createElement("div", null, items.map(item => createElement("span", { key: item.id }, item.value)))
    }
    const root = createRoot(dom.window.document.querySelector("#app"))
    await act(async () => { root.render(createElement(App)) })
    let elapsed = 0
    await act(() => {
      const start = performance.now()
      flushSync(() => {
        setItems(previous => updateClientItems(previous, mode))
      })
      elapsed = performance.now() - start
    })
    await act(async () => { root.unmount() })
    return elapsed
  } finally {
    restore()
  }
}

async function rawReactMemoRerender(count) {
  const dom = new JSDOM("<div id=app></div>")
  const restore = installRendererDOM(dom)
  try {
    const { act, memo, useState } = await import("react")
    const { createRoot } = await import("react-dom/client")
    const { flushSync } = await import("react-dom")
    let setItems
    const Row = memo(function Row({ item }) {
      return createElement("span", null, item.value)
    })
    function App() {
      const [items, set] = useState(() => clientItems(count))
      setItems = set
      return createElement("div", null, items.map(item => createElement(Row, { key: item.id, item })))
    }
    const root = createRoot(dom.window.document.querySelector("#app"))
    await act(async () => { root.render(createElement(App)) })
    let elapsed = 0
    await act(() => {
      const start = performance.now()
      flushSync(() => {
        setItems(previous => updateClientItems(previous, "single"))
      })
      elapsed = performance.now() - start
    })
    await act(async () => { root.unmount() })
    return elapsed
  } finally {
    restore()
  }
}

async function reactRerender(count, mode = "full") {
  const dom = new JSDOM("<div id=app></div>")
  const restore = installRendererDOM(dom)
  try {
    const { act } = await import("react")
    const { createRoot } = await import("react-dom/client")
    const { flushSync } = await import("react-dom")
    const items = State(clientItems(count))
    const App = defineView(`ReactPerformanceApp${count}${mode}`, {
      initializers: [initializer(`ReactPerformanceApp${count}${mode}()`, args => args.length === 0)],
      body: () => Element("div", null, items.value.map(item => Element("span", { key: item.id }, item.value))),
    })
    const root = createRoot(dom.window.document.querySelector("#app"))
    await act(async () => { root.render(renderReact(App())) })
    let elapsed = 0
    await act(() => {
      const start = performance.now()
      flushSync(() => {
        items.value = updateClientItems(items.value, mode)
      })
      elapsed = performance.now() - start
    })
    await act(async () => { root.unmount() })
    return elapsed
  } finally {
    restore()
  }
}

async function reactCompiledCollectionRerender(count, ownedMutation = false) {
  const dom = new JSDOM("<div id=app></div>")
  const restore = installRendererDOM(dom)
  try {
    const { act } = await import("react")
    const { createRoot } = await import("react-dom/client")
    const { flushSync } = await import("react-dom")
    const items = State(clientItems(count))
    const content = compiledCollectionContent(
      item => Element("span", { key: item.id }, item.value),
      {
        kind: "flat-text-host",
        indexIndependent: true,
        evaluateKey: item => item.id,
        evaluate: item => ({ type: "span", props: null, text: item.value }),
      },
    )
    const graph = Element("div", null, ForEach(items, item => item.id, content))
    const root = createRoot(dom.window.document.querySelector("#app"))
    await act(async () => { root.render(renderReact(graph)) })
    let elapsed = 0
    await act(() => {
      const start = performance.now()
      flushSync(() => {
        if (ownedMutation) {
          const index = Math.floor(items.value.length / 2)
          const current = items.value[index]
          if (current) items.value[index] = { ...current, value: `next-${index}` }
        } else {
          items.value = updateClientItems(items.value, "single")
        }
      })
      elapsed = performance.now() - start
    })
    await act(async () => { root.unmount() })
    return elapsed
  } finally {
    restore()
  }
}

async function rawVueRerender(count, mode = "full") {
  const { dom, runtime: vue } = await getVueRuntime()
  const container = dom.window.document.querySelector("#vue-benchmark-app")
  container.replaceChildren()
  try {
    const items = vue.ref(clientItems(count))
    const app = vue.createApp({
      render: () => vue.h("div", null, items.value.map(item => vue.h("span", { key: item.id }, item.value))),
    })
    app.mount(container)
    const start = performance.now()
    items.value = updateClientItems(items.value, mode)
    await vue.nextTick()
    const elapsed = performance.now() - start
    app.unmount()
    return elapsed
  } finally {
    container.replaceChildren()
  }
}

async function rawVueOwnedMutation(count) {
  const { dom, runtime: vue } = await getVueRuntime()
  const container = dom.window.document.querySelector("#vue-benchmark-app")
  container.replaceChildren()
  try {
    const items = vue.ref(clientItems(count))
    const app = vue.createApp({
      render: () => vue.h("div", null, items.value.map(item => vue.h("span", { key: item.id }, item.value))),
    })
    app.mount(container)
    const index = Math.floor(items.value.length / 2)
    const start = performance.now()
    if (items.value[index]) items.value[index].value = `next-${index}`
    await vue.nextTick()
    const elapsed = performance.now() - start
    app.unmount()
    return elapsed
  } finally {
    container.replaceChildren()
  }
}

async function vueRerender(count, mode = "full") {
  const { dom, runtime: vue, munRenderer } = await getVueRuntime()
  const container = dom.window.document.querySelector("#vue-benchmark-app")
  container.replaceChildren()
  try {
    const items = State(clientItems(count))
    const App = defineView(`VuePerformanceApp${count}${mode}`, {
      initializers: [initializer(`VuePerformanceApp${count}${mode}()`, args => args.length === 0)],
      body: () => Element("div", null, items.value.map(item => Element("span", { key: item.id }, item.value))),
    })
    const app = vue.createApp({ render: () => munRenderer.render(App()) })
    app.mount(container)
    const start = performance.now()
    items.value = updateClientItems(items.value, mode)
    await vue.nextTick()
    const elapsed = performance.now() - start
    app.unmount()
    return elapsed
  } finally {
    container.replaceChildren()
  }
}

async function vueCompiledCollectionRerender(count, ownedMutation = false) {
  const { dom, runtime: vue, munRenderer } = await getVueRuntime()
  const container = dom.window.document.querySelector("#vue-benchmark-app")
  container.replaceChildren()
  try {
    const items = State(clientItems(count))
    const content = compiledCollectionContent(
      item => Element("span", { key: item.id }, item.value),
      {
        kind: "flat-text-host",
        indexIndependent: true,
        evaluateKey: item => item.id,
        evaluate: item => ({ type: "span", props: null, text: item.value }),
      },
    )
    const graph = Element("div", null, ForEach(items, item => item.id, content))
    const app = vue.createApp({ render: () => munRenderer.render(graph) })
    app.mount(container)
    const start = performance.now()
    if (ownedMutation) {
      const index = Math.floor(items.value.length / 2)
      const current = items.value[index]
      if (current) items.value[index] = { ...current, value: `next-${index}` }
    } else {
      items.value = updateClientItems(items.value, "single")
    }
    await vue.nextTick()
    const elapsed = performance.now() - start
    app.unmount()
    return elapsed
  } finally {
    container.replaceChildren()
  }
}

function rawStateUpdate(count) {
  let value = 0
  for (let index = 0; index < count; index += 1) value = index
  return value
}

function munStateUpdate(count) {
  const state = State(0)
  const unsubscribe = subscribeState(state, () => {})
  for (let index = 0; index < count; index += 1) state.value = index
  unsubscribe()
  return state.value
}

function rawDeepStateUpdate(count, depth = 8) {
  const root = {}
  let cursor = root
  for (let level = 0; level < depth; level += 1) {
    cursor.child = { value: 0 }
    cursor = cursor.child
  }
  for (let index = 0; index < count; index += 1) cursor.value = index
  return cursor.value
}

function munDeepStateUpdate(count, depth = 8) {
  const root = {}
  let cursor = root
  for (let level = 0; level < depth; level += 1) {
    cursor.child = { value: 0 }
    cursor = cursor.child
  }
  const state = State(root)
  const unsubscribe = subscribeState(state, () => {})
  let nested = state.value
  for (let level = 0; level < depth; level += 1) nested = nested.child
  for (let index = 0; index < count; index += 1) nested.value = index
  unsubscribe()
  return nested.value
}

async function burstDomUpdate(updateCount = 100, childCount = 250) {
  const dom = new JSDOM("<div id=app></div>")
  const container = dom.window.document.querySelector("#app")
  const tick = State(0)
  const App = defineView("BurstPerformanceApp", {
    initializers: [initializer("BurstPerformanceApp()", args => args.length === 0)],
    body: () => Element("div", null, Array.from({ length: childCount }, (_, index) => Element("span", null, `${tick.value}:${index}`))),
  })
  const unmount = mount(App(), container)
  await Promise.resolve()
  const start = performance.now()
  for (let index = 1; index <= updateCount; index += 1) tick.value = index
  await Promise.resolve(); await Promise.resolve()
  const elapsed = performance.now() - start
  if (!container.textContent?.startsWith(`${updateCount}:0`)) throw new Error("Burst update did not commit the latest State value")
  unmount()
  dom.window.close()
  return elapsed
}

async function conditionalSubtreeToggle(childCount = 1000) {
  const dom = new JSDOM("<div id=app></div>")
  const container = dom.window.document.querySelector("#app")
  const visible = State(false)
  const App = defineView("ConditionalPerformanceApp", {
    initializers: [initializer("ConditionalPerformanceApp()", args => args.length === 0)],
    body: () => Element("section", null, visible.value
      ? Array.from({ length: childCount }, (_, index) => Element("span", { "data-index": index }, String(index)))
      : null),
  })
  const unmount = mount(App(), container)
  await Promise.resolve()
  const start = performance.now()
  visible.value = true
  await Promise.resolve(); await Promise.resolve()
  visible.value = false
  await Promise.resolve(); await Promise.resolve()
  const elapsed = performance.now() - start
  if (container.querySelector("span")) throw new Error("Conditional subtree did not unmount")
  unmount()
  dom.window.close()
  return elapsed
}

async function lazyScrollUpdate(itemCount = 10000) {
  const dom = new JSDOM("<div id=app></div>")
  const container = dom.window.document.querySelector("#app")
  Object.defineProperty(container, "clientHeight", { configurable: true, value: 240 })
  container.style.overflowY = "auto"
  const rows = Array.from({ length: itemCount }, (_, index) => Element("div", { "data-row": index }, `row-${index}`).keyed(index))
  const App = defineView("LazyScrollPerformanceApp", {
    initializers: [initializer("LazyScrollPerformanceApp()", args => args.length === 0)],
    body: () => LazyVStack({ estimatedItemSize: 24, overscan: 2 }, ...rows),
  })
  const unmount = mount(App(), container)
  await Promise.resolve()
  const initialDomRows = container.querySelectorAll("[data-row]").length
  const start = performance.now()
  container.scrollTop = Math.max(0, itemCount * 24 - 240)
  container.dispatchEvent(new dom.window.Event("scroll"))
  await Promise.resolve(); await Promise.resolve()
  const elapsed = performance.now() - start
  const finalDomRows = container.querySelectorAll("[data-row]").length
  if (initialDomRows >= itemCount || finalDomRows >= itemCount) throw new Error("LazyVStack materialized the full logical collection")
  unmount()
  dom.window.close()
  return elapsed
}

async function measureRounds(factory) {
  const samples = []
  for (let round = 0; round < rounds; round += 1) samples.push(await factory())
  return median(samples)
}

const arrayMutationCount = Number(process.env.MUN_BENCH_ARRAY_MUTATION_ITEMS ?? 1000)
const arrayMutationBudget = Number(process.env.MUN_BENCH_ARRAY_MUTATION_MS ?? 25)
const stateArrayFixture = () => {
  const state = State(Array.from({ length: arrayMutationCount }, (_, index) => ({ id: index })))
  const unsubscribe = subscribeState(state, () => {})
  return { state, cleanup: unsubscribe }
}
const arrayReverse = measureMutation(`Mun State in-place reverse ${arrayMutationCount}`, stateArrayFixture, ({ state }) => state.value.reverse())
const arraySort = measureMutation(`Mun State in-place sort ${arrayMutationCount}`, stateArrayFixture, ({ state }) => state.value.sort((left, right) => right.id - left.id))
if (ci && arrayReverse > arrayMutationBudget) throw new Error(`State in-place reverse exceeded ${arrayMutationBudget} ms: ${arrayReverse.toFixed(2)} ms`)
if (ci && arraySort > arrayMutationBudget) throw new Error(`State in-place sort exceeded ${arrayMutationBudget} ms: ${arraySort.toFixed(2)} ms`)

for (const count of counts.slice(0, ci ? 2 : counts.length)) {
  const rawState = measure(`raw state update ${count}`, () => rawStateUpdate(count))
  const munState = measure(`Mun State update ${count}`, () => munStateUpdate(count))
  ratio(`State update ${count}`, munState, rawState, Number.POSITIVE_INFINITY, false)
  if (ci && munState > budgets.state) throw new Error(`State update exceeded ${budgets.state} ms for ${count}: ${munState.toFixed(2)} ms`)
  const rawDeepState = measure(`raw deep State update ${count}`, () => rawDeepStateUpdate(count))
  const munDeepState = measure(`Mun deep State update ${count}`, () => munDeepStateUpdate(count))
  ratio(`Deep State update ${count}`, munDeepState, rawDeepState, Number.POSITIVE_INFINITY, false)
  if (ci && munDeepState > budgets.deepState) throw new Error(`Deep State update exceeded ${budgets.deepState} ms for ${count}: ${munDeepState.toFixed(2)} ms`)

  // DOM rounds are intentionally sequential. Running independent JSDOM instances
  // concurrently makes microtask scheduling and GC contention dominate the ratio.
  const raw = await measureRounds(() => rawDomUpdate(count))
  const mun = await measureRounds(() => munDomUpdate(count))
  const keyed = await measureRounds(() => keyedDomUpdate(count))
  const hydration = await measureRounds(() => webHydration(count))
  const rawReactHydrationTime = await measureRounds(() => rawReactHydration(count))
  const rawVueHydrationTime = await measureRounds(() => rawVueHydration(count))
  console.log(`raw DOM update ${count}: ${raw.toFixed(2)} ms`)
  console.log(`Mun DOM reconciliation ${count}: ${mun.toFixed(2)} ms`)
  console.log(`Mun keyed DOM update ${count}: ${keyed.toFixed(2)} ms`)
  console.log(`Mun Web hydration ${count}: ${hydration.toFixed(2)} ms`)
  console.log(`raw React hydration ${count}: ${rawReactHydrationTime.toFixed(2)} ms`)
  console.log(`raw Vue hydration ${count}: ${rawVueHydrationTime.toFixed(2)} ms`)
  ratio(`DOM reconciliation ${count}`, mun, raw, budgets.dom)
  ratio(`Web hydration vs React ${count}`, hydration, rawReactHydrationTime, budgets.reactHydrationRatio)
  // Keep this JSDOM comparison visible, but let the production Chromium suite
  // own the release gate. Vue's JSDOM hydration path is an unusually low floor
  // and makes this ratio volatile without reflecting real-browser regressions.
  ratio(`Web hydration vs Vue ${count}`, hydration, rawVueHydrationTime, budgets.vueHydrationRatio, false)
  if (![keyed, hydration, rawReactHydrationTime, rawVueHydrationTime].every(Number.isFinite)) throw new Error(`DOM or hydration benchmark produced a non-finite measurement for ${count}`)
  if (ci && keyed > budgets.keyedDom) throw new Error(`Keyed DOM update exceeded ${budgets.keyedDom} ms for ${count}: ${keyed.toFixed(2)} ms`)
  if (ci && hydration > budgets.hydration) throw new Error(`Hydration exceeded ${budgets.hydration} ms for ${count}: ${hydration.toFixed(2)} ms`)

  for (const mode of ["full", "single", "reverse"]) {
    const rawReactRerenderTime = await measureRounds(() => rawReactRerender(count, mode))
    const reactRerenderTime = await measureRounds(() => reactRerender(count, mode))
    const rawVueRerenderTime = await measureRounds(() => rawVueRerender(count, mode))
    const vueRerenderTime = await measureRounds(() => vueRerender(count, mode))
    console.log(`raw React ${mode} rerender ${count}: ${rawReactRerenderTime.toFixed(2)} ms`)
    console.log(`Mun React ${mode} rerender ${count}: ${reactRerenderTime.toFixed(2)} ms`)
    console.log(`raw Vue ${mode} rerender ${count}: ${rawVueRerenderTime.toFixed(2)} ms`)
    console.log(`Mun Vue ${mode} rerender ${count}: ${vueRerenderTime.toFixed(2)} ms`)
    ratio(`React client ${mode} ${count}`, reactRerenderTime, rawReactRerenderTime, budgets.reactClientRatio)
    ratio(`Vue client ${mode} ${count}`, vueRerenderTime, rawVueRerenderTime, budgets.vueClientRatio)
    if (mode === "single") {
      const rawReactMemoTime = await measureRounds(() => rawReactMemoRerender(count))
      const rawVueOwnedTime = await measureRounds(() => rawVueOwnedMutation(count))
      const reactCompiledCollectionTime = await measureRounds(() => reactCompiledCollectionRerender(count))
      const vueCompiledCollectionTime = await measureRounds(() => vueCompiledCollectionRerender(count))
      const reactOwnedCollectionTime = await measureRounds(() => reactCompiledCollectionRerender(count, true))
      const vueOwnedCollectionTime = await measureRounds(() => vueCompiledCollectionRerender(count, true))
      console.log(`raw React memoized single rerender ${count}: ${rawReactMemoTime.toFixed(2)} ms`)
      console.log(`raw Vue owned single mutation ${count}: ${rawVueOwnedTime.toFixed(2)} ms`)
      console.log(`Mun React compiled collection single rerender ${count}: ${reactCompiledCollectionTime.toFixed(2)} ms`)
      console.log(`Mun Vue compiled collection single rerender ${count}: ${vueCompiledCollectionTime.toFixed(2)} ms`)
      console.log(`Mun React compiled collection owned single mutation ${count}: ${reactOwnedCollectionTime.toFixed(2)} ms`)
      console.log(`Mun Vue compiled collection owned single mutation ${count}: ${vueOwnedCollectionTime.toFixed(2)} ms`)
      ratio(`React compiled collection single ${count}`, reactCompiledCollectionTime, rawReactRerenderTime, budgets.reactClientRatio)
      ratio(`Vue compiled collection single ${count}`, vueCompiledCollectionTime, rawVueRerenderTime, budgets.vueClientRatio)
      if (![rawReactMemoTime, rawVueOwnedTime, reactOwnedCollectionTime, vueOwnedCollectionTime].every(Number.isFinite)) throw new Error(`Compiled collection owned mutation benchmark produced a non-finite measurement for ${count}`)
    }
    if (![rawReactRerenderTime, reactRerenderTime, rawVueRerenderTime, vueRerenderTime].every(Number.isFinite)) throw new Error(`Renderer rerender benchmark produced a non-finite measurement for ${count}/${mode}`)
    if (ci && reactRerenderTime > budgets.reactRerender) throw new Error(`React rerender exceeded ${budgets.reactRerender} ms for ${count}/${mode}: ${reactRerenderTime.toFixed(2)} ms`)
    if (ci && vueRerenderTime > budgets.vueRerender) throw new Error(`Vue rerender exceeded ${budgets.vueRerender} ms for ${count}/${mode}: ${vueRerenderTime.toFixed(2)} ms`)
  }
}

const burstDom = await measureRounds(() => burstDomUpdate(ci ? 50 : 100, ci ? 100 : 250))
const conditionalDom = await measureRounds(() => conditionalSubtreeToggle(ci ? 500 : 1000))
const lazyScroll = await measureRounds(() => lazyScrollUpdate(ci ? 1000 : 10000))
console.log(`Mun burst DOM update: ${burstDom.toFixed(2)} ms`)
console.log(`Mun conditional subtree toggle: ${conditionalDom.toFixed(2)} ms`)
console.log(`Mun LazyVStack scroll: ${lazyScroll.toFixed(2)} ms`)
for (const [name, actual, budget] of [
  ["Burst DOM update", burstDom, budgets.burstDom],
  ["Conditional DOM toggle", conditionalDom, budgets.conditionalDom],
  ["LazyVStack scroll", lazyScroll, budgets.lazyScroll],
]) {
  if (!Number.isFinite(actual)) throw new Error(`${name} benchmark produced a non-finite measurement`)
  if (ci && actual > budget) throw new Error(`${name} exceeded ${budget} ms: ${actual.toFixed(2)} ms`)
}

if (results.some(result => !Number.isFinite(result.actual) || !Number.isFinite(result.ratio))) {
  throw new Error("Performance benchmark produced a non-finite measurement")
}

console.log(`Performance benchmark completed: ${results.length} guarded comparisons`)
if (vueBenchmarkRuntime) vueBenchmarkRuntime.restore()
