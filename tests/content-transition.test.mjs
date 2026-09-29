import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { Pause, Play, Wifi, WifiOff } from "@lucide/icons"
import {
  Animation,
  ContentTransition,
  Image,
  Path,
  State,
  SymbolEffect,
  Text,
  VectorSymbol,
  defineView,
  initializer,
} from "../packages/core/dist/compat.js"
import { Svg } from "../packages/core/dist/web-primitives.js"
import { transformMunSource } from "../packages/compiler/dist/index.js"
import { mount, renderToHTML } from "../packages/web/dist/index.js"
import { animateDomAttribute } from "../packages/web/dist/motion.js"
import {
  createSvgPathInterpolator,
  mapSvgPathBetweenViewBoxes,
  matchSvgPathLayers,
} from "../packages/web/dist/path-interpolation.js"

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

function box(width = 32, height = 32) {
  return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() { return this } }
}

function installGeometry(dom, width = 120, height = 28) {
  Object.defineProperty(dom.window.Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value() { return box(width, height) },
  })
}

const diamond = "M12 1 L23 12 L12 23 L1 12 Z"
const square = "M2 2 L22 2 L22 22 L2 22 Z"
const triangle = "M12 2 L22 22 L2 22 Z"

test("VectorSymbol renders semantic keyed SVG layers without transient motion markup", () => {
  const symbol = new VectorSymbol({
    name: "status.ready",
    viewBox: "0 0 24 24",
    layers: [
      { id: "base", d: square, fill: "currentColor" },
      { id: "badge", d: triangle, opacity: 0.8 },
    ],
  })
  const html = renderToHTML(Image(symbol, { alt: "Ready" }).contentTransition(ContentTransition.symbolEffect()))
  assert.match(html, /^<svg/)
  assert.match(html, /data-mun="VectorSymbol"/)
  assert.match(html, /data-mun-symbol="status.ready"/)
  assert.match(html, /data-mun-symbol-layer="base"/)
  assert.match(html, /data-mun-symbol-layer="badge"/)
  assert.match(html, /aria-label="Ready"/)
  assert.doesNotMatch(html, /transition-layer/)
})

test("VectorSymbol adapts standard Lucide data and ordinary SVG primitives into path geometry", () => {
  const play = VectorSymbol.fromLucide(Play)
  assert.equal(play.descriptor.name, "play")
  assert.equal(play.descriptor.viewBox, "0 0 24 24")
  assert.equal(play.descriptor.layers.length, 1)
  assert.equal(play.descriptor.layers[0].id, "10ikf1", "standard icon source keys should survive as semantic layer identity")
  assert.equal(play.descriptor.layers[0].stroke, "currentColor")
  assert.match(play.descriptor.layers[0].d, /^M/)

  const custom = VectorSymbol.fromSVGNodes([
    ["circle", { cx: 12, cy: 12, r: 7, stroke: "currentColor", fill: "none" }],
    ["line", { x1: 5, y1: 5, x2: 19, y2: 19, stroke: "currentColor" }],
    ["rect", { x: 3, y: 4, width: 8, height: 6, rx: 2 }],
  ], { name: "custom.geometry", viewBox: "0 0 24 24" })
  assert.equal(custom.descriptor.layers.length, 3)
  assert.match(custom.descriptor.layers[0].d, /A7 7/)
  assert.equal(custom.descriptor.layers[1].d, "M5 5 L19 19")
  assert.match(custom.descriptor.layers[2].d, /A2 2/)

  const transformed = VectorSymbol.fromSVGNodes([
    ["g", { transform: "translate(2 3)" }, [
      ["g", { transform: "scale(2)" }, [
        ["line", { x1: 0, y1: 0, x2: 4, y2: 4 }],
      ]],
    ]],
  ])
  assert.equal(transformed.descriptor.layers[0].transform, "translate(2 3) scale(2)")
})

test("Lucide semantic node keys preserve genuinely common geometry across related symbols", () => {
  const wifi = VectorSymbol.fromLucide(Wifi)
  const off = VectorSymbol.fromLucide(WifiOff)
  const common = wifi.descriptor.layers.map(layer => layer.id).filter(id => off.descriptor.layers.some(layer => layer.id === id))
  assert.deepEqual(common.sort(), ["1bycff", "zekei9"].sort())
})

test("geometry-aware layer assignment beats source order for reordered icon geometry", () => {
  const sources = [
    { d: "M1 1 L5 1", stroke: "currentColor", fill: "none" },
    { d: "M19 19 L23 19", stroke: "currentColor", fill: "none" },
  ]
  const targets = [
    { d: "M20 20 L24 20", stroke: "currentColor", fill: "none" },
    { d: "M2 2 L6 2", stroke: "currentColor", fill: "none" },
  ]
  const matches = matchSvgPathLayers(sources, targets)
  assert.deepEqual(matches.map(match => [match.sourceIndex, match.targetIndex]), [[0, 1], [1, 0]])
  assert(matches.every(match => match.confidence > 0.8))
})

test("path morphing accepts compact SVG arc flags and normalizes differing viewBoxes", () => {
  const compactArc = "M17 10a5 5 0 00-3 1"
  const interpolate = createSvgPathInterpolator(compactArc, "M14 11 L8 14")
  assert.match(interpolate(0.5), /^M/)

  const mapped = mapSvgPathBetweenViewBoxes("M0 0 L48 48", "0 0 48 48", "0 0 24 24")
  assert.match(mapped, /^M0 0 C/)
  assert.match(mapped, /24 24/)
})

test("automatic replacement treats ordinal icon-pack layers as geometry and morphs topology continuously", async () => {
  const first = VectorSymbol.fromLucide(Play)
  const second = VectorSymbol.fromLucide(Pause)
  let symbol
  const App = defineView("LucideTopologyMorph", {
    initializers: [initializer("LucideTopologyMorph()", args => args.length === 0)],
    state: () => ({ symbol: symbol = State(first) }),
    body: ({ symbol }) => Image(symbol.value)
      .contentTransition(ContentTransition.symbolEffect(SymbolEffect.automatic))
      .animation(Animation.linear(0.08), symbol.value),
  })
  const dom = new JSDOM("<body><div id=app></div></body>", { pretendToBeVisual: true })
  installGeometry(dom, 32, 32)
  const container = dom.window.document.querySelector("#app")
  const unmount = mount(App(), container)
  const oldPath = container.querySelector("path")?.getAttribute("d")
  assert.ok(oldPath)

  symbol.value = second
  await flush()
  const overlay = dom.window.document.querySelector("[data-mun-symbol-transition-layer]")
  assert.ok(overlay, "standard icon topology should use the geometry morph overlay")
  // Play has one path and Pause has two. The old geometry is duplicated so the
  // triangle can split into both bars without a newly appearing path pop.
  assert.equal(overlay.children.length, 2)
  assert.equal(container.querySelectorAll("path").length, 2)
  for (const path of container.querySelectorAll("path")) assert.equal(path.style.opacity, "0")

  let morphed = overlay.firstElementChild?.getAttribute("d")
  for (let attempt = 0; attempt < 6 && morphed === oldPath; attempt += 1) {
    await wait(25)
    morphed = overlay.firstElementChild?.getAttribute("d")
  }
  assert.ok(morphed && morphed !== oldPath, `Lucide geometry did not morph: ${morphed}`)
  await wait(100)
  assert.equal(dom.window.document.querySelector("[data-mun-symbol-transition-layer]"), null)
  for (const path of container.querySelectorAll("path")) assert.equal(path.style.opacity, "")
  unmount()
  dom.window.close()
})

test("SVG path attributes morph, retarget from presentation state, and land on the exact target", async () => {
  const dom = new JSDOM("<svg xmlns='http://www.w3.org/2000/svg'><path/></svg>", { pretendToBeVisual: true })
  const path = dom.window.document.querySelector("path")
  assert.ok(path)
  path.setAttribute("d", diamond)
  assert.equal(animateDomAttribute(path, "d", diamond, square, Animation.linear(0.08)), true)
  let middle = path.getAttribute("d")
  for (let attempt = 0; attempt < 6 && middle === diamond; attempt += 1) {
    await wait(25)
    middle = path.getAttribute("d")
  }
  assert.ok(middle && middle !== diamond, `path did not leave its origin: ${middle}`)

  assert.equal(animateDomAttribute(path, "d", middle, triangle, Animation.linear(0.025)), true)
  await wait(80)
  await Promise.resolve()
  assert.equal(path.getAttribute("d"), triangle)
  dom.window.close()
})

test("SVG path morphing equalizes changing compound subpath counts", async () => {
  const dom = new JSDOM("<svg xmlns='http://www.w3.org/2000/svg'><path/></svg>", { pretendToBeVisual: true })
  const path = dom.window.document.querySelector("path")
  const two = "M2 2 L10 2 L10 10 Z M14 14 L20 14 L20 20 Z"
  const three = "M2 2 L8 2 L8 8 Z M10 10 L15 10 L15 15 Z M17 17 L22 17 L22 22 Z"
  path.setAttribute("d", two)
  assert.equal(animateDomAttribute(path, "d", two, three, Animation.linear(0.05)), true)
  let changed = path.getAttribute("d")
  for (let attempt = 0; attempt < 6 && changed === two; attempt += 1) {
    await wait(20)
    changed = path.getAttribute("d")
  }
  assert.ok(changed && changed !== two)
  await wait(100)
  await Promise.resolve()
  assert.equal(path.getAttribute("d"), three, "finite motion must restore the exact authored target")
  dom.window.close()
})

test("path interpolation preserves spring overshoot instead of clamping geometry at the target", () => {
  const interpolate = createSvgPathInterpolator("M0 0 L10 0 L10 10 Z", "M0 0 L20 0 L20 20 Z")
  assert.equal(interpolate(0), "M0 0 L10 0 L10 10 Z")
  assert.equal(interpolate(1), "M0 0 L20 0 L20 20 Z")
  const overshoot = interpolate(1.1)
  assert.notEqual(overshoot, "M0 0 L20 0 L20 20 Z")
  assert.match(overshoot, /21/)
})

test("Path(d).animation() morphs intrinsic path data without a VectorSymbol wrapper", async () => {
  let shape
  const App = defineView("IntrinsicPathMorph", {
    initializers: [initializer("IntrinsicPathMorph()", args => args.length === 0)],
    state: () => ({ shape: shape = State(diamond) }),
    body: ({ shape }) => Svg("0 0 24 24", () => Path(shape.value).animation(Animation.linear(0.035), shape.value)),
  })
  const dom = new JSDOM("<body><div id=app></div></body>", { pretendToBeVisual: true })
  const container = dom.window.document.querySelector("#app")
  assert.ok(container)
  const unmount = mount(App(), container)
  const path = container.querySelector("path")
  assert.ok(path)
  shape.value = square
  await flush()
  assert.strictEqual(container.querySelector("path"), path)
  await wait(100)
  await Promise.resolve()
  assert.equal(path.getAttribute("d"), square)
  unmount()
  dom.window.close()
})

test("VectorSymbol keeps a matched layer node alive while its shape morphs", async () => {
  const first = new VectorSymbol({ name: "shape.first", viewBox: "0 0 24 24", layers: [{ id: "shape", d: diamond, fill: "#111" }] })
  const second = new VectorSymbol({ name: "shape.second", viewBox: "0 0 24 24", layers: [{ id: "shape", d: square, fill: "#333" }] })
  let symbol
  const App = defineView("MorphingSymbol", {
    initializers: [initializer("MorphingSymbol()", args => args.length === 0)],
    state: () => ({ symbol: symbol = State(first) }),
    body: ({ symbol }) => Image(symbol.value)
      .contentTransition(ContentTransition.symbolEffect(SymbolEffect.magicReplace()))
      .animation(Animation.linear(0.035), symbol.value),
  })
  const dom = new JSDOM("<body><div id=app></div></body>", { pretendToBeVisual: true })
  installGeometry(dom, 32, 32)
  const container = dom.window.document.querySelector("#app")
  assert.ok(container)
  const unmount = mount(App(), container)
  const root = container.querySelector("svg")
  const originalPath = root?.querySelector("[data-mun-symbol-layer='shape']")
  assert.ok(root && originalPath)

  symbol.value = second
  await flush()
  const livePath = root.querySelector("[data-mun-symbol-layer='shape']")
  assert.strictEqual(livePath, originalPath)
  await wait(100)
  await Promise.resolve()
  assert.equal(livePath.getAttribute("d"), square)
  assert.equal(livePath.getAttribute("fill"), "#333")

  unmount()
  dom.window.close()
})

test("magicReplace preserves common layers while old/new semantic layers transition independently", async () => {
  const first = new VectorSymbol({
    name: "speaker.old",
    viewBox: "0 0 24 24",
    layers: [
      { id: "speaker", d: diamond },
      { id: "slash", d: "M3 3 L21 21", stroke: "currentColor", strokeWidth: 2 },
    ],
  })
  const second = new VectorSymbol({
    name: "speaker.new",
    viewBox: "0 0 24 24",
    layers: [
      { id: "speaker", d: square },
      { id: "badge", d: triangle },
    ],
  })
  let symbol
  const App = defineView("LayeredSymbol", {
    initializers: [initializer("LayeredSymbol()", args => args.length === 0)],
    state: () => ({ symbol: symbol = State(first) }),
    body: ({ symbol }) => Image(symbol.value)
      .className("symbol-tone")
      .contentTransition(ContentTransition.symbolEffect(SymbolEffect.magicReplace("opacity")))
      .animation(Animation.linear(0.04), symbol.value),
  })
  const dom = new JSDOM("<body><div id=app></div></body>", { pretendToBeVisual: true })
  installGeometry(dom, 32, 32)
  const container = dom.window.document.querySelector("#app")
  assert.ok(container)
  const unmount = mount(App(), container)
  const root = container.querySelector("svg")
  const common = root?.querySelector("[data-mun-symbol-layer='speaker']")
  assert.ok(root && common)

  symbol.value = second
  await flush()
  assert.strictEqual(root.querySelector("[data-mun-symbol-layer='speaker']"), common)
  assert.equal(root.querySelector("[data-mun-symbol-layer='slash']"), null)
  assert.ok(root.querySelector("[data-mun-symbol-layer='badge']"))
  const transitionLayer = dom.window.document.querySelector("[data-mun-symbol-transition-layer]")
  assert.ok(transitionLayer)
  assert.ok(transitionLayer.classList.contains("symbol-tone"))

  await wait(110)
  await Promise.resolve()
  assert.equal(dom.window.document.querySelector("[data-mun-symbol-transition-layer]"), null)
  assert.equal(common.getAttribute("d"), square)

  unmount()
  dom.window.close()
})

test("long interpolate text uses a bounded whole-text fallback instead of a quadratic glyph matrix", async () => {
  let label
  const before = "a".repeat(300)
  const after = "b".repeat(300)
  const App = defineView("BoundedInterpolatingText", {
    initializers: [initializer("BoundedInterpolatingText()", args => args.length === 0)],
    state: () => ({ label: label = State(before) }),
    body: ({ label }) => Text(label.value)
      .contentTransition(ContentTransition.interpolate)
      .animation(Animation.linear(0.025), label.value),
  })
  const dom = new JSDOM("<body><div id=app></div></body>", { pretendToBeVisual: true })
  installGeometry(dom, 300, 24)
  const container = dom.window.document.querySelector("#app")
  assert.ok(container)
  const unmount = mount(App(), container)

  label.value = after
  await flush()
  const overlay = dom.window.document.querySelector("[data-mun-text-transition-layer]")
  assert.ok(overlay)
  assert.equal(overlay.children.length, 2)
  assert.equal(container.textContent, after)
  await wait(80)
  assert.equal(dom.window.document.querySelector("[data-mun-text-transition-layer]"), null)

  unmount()
  dom.window.close()
})

test("interpolate text transition keeps the semantic text node live and uses only an ephemeral glyph layer", async () => {
  let label
  const App = defineView("InterpolatingText", {
    initializers: [initializer("InterpolatingText()", args => args.length === 0)],
    state: () => ({ label: label = State("Save") }),
    body: ({ label }) => Text(label.value)
      .contentTransition(ContentTransition.interpolate)
      .animation(Animation.linear(0.04), label.value),
  })
  const dom = new JSDOM("<body><div id=app></div></body>", { pretendToBeVisual: true })
  installGeometry(dom, 100, 24)
  const container = dom.window.document.querySelector("#app")
  assert.ok(container)
  const unmount = mount(App(), container)
  const element = container.firstElementChild
  const textNode = element?.firstChild
  assert.ok(element && textNode)

  label.value = "Saved"
  await flush()
  assert.strictEqual(element.firstChild, textNode)
  assert.equal(textNode.nodeValue, "Saved")
  assert.equal(element.style.getPropertyValue("color"), "transparent")
  assert.equal(element.style.visibility, "")
  assert.ok(dom.window.document.querySelector("[data-mun-text-transition-layer]"))

  await wait(110)
  assert.equal(element.style.getPropertyValue("color"), "")
  assert.equal(dom.window.document.querySelector("[data-mun-text-transition-layer]"), null)
  assert.strictEqual(element.firstChild, textNode)

  unmount()
  dom.window.close()
})

test("numericText rolls changing numeric content and host animation suppression makes content changes discrete", async () => {
  let count
  const App = defineView("NumericText", {
    initializers: [initializer("NumericText()", args => args.length === 0)],
    state: () => ({ count: count = State(9) }),
    body: ({ count }) => Text(String(count.value))
      .contentTransition(ContentTransition.numericText(count.value))
      .animation(Animation.linear(0.04), count.value),
  })

  const animatedDom = new JSDOM("<body><div id=app></div></body>", { pretendToBeVisual: true })
  installGeometry(animatedDom, 80, 24)
  const animatedContainer = animatedDom.window.document.querySelector("#app")
  const unmountAnimated = mount(App(), animatedContainer)
  count.value = 10
  await flush()
  const layer = animatedDom.window.document.querySelector("[data-mun-text-transition-layer]")
  assert.ok(layer)
  assert.equal(animatedContainer.textContent, "10")
  await wait(110)
  assert.equal(animatedDom.window.document.querySelector("[data-mun-text-transition-layer]"), null)
  unmountAnimated()
  animatedDom.window.close()

  const disabledDom = new JSDOM("<body><div id=app></div></body>", { pretendToBeVisual: true })
  installGeometry(disabledDom, 80, 24)
  const disabledContainer = disabledDom.window.document.querySelector("#app")
  const Disabled = defineView("DisabledNumericText", {
    initializers: [initializer("DisabledNumericText()", args => args.length === 0)],
    body: () => Text(String(count.value))
      .contentTransition(ContentTransition.numericText(count.value))
      .animation(Animation.linear(0.04), count.value),
  })
  const unmountDisabled = mount(Disabled(), disabledContainer, { disablesAnimations: true })
  count.value = 11
  await flush()
  assert.equal(disabledContainer.textContent, "11")
  assert.equal(disabledDom.window.document.querySelector("[data-mun-text-transition-layer]"), null)
  unmountDisabled()
  disabledDom.window.close()
})

test("blur, push, and scale text replacements use ephemeral accessible overlays and clean up", async () => {
  const cases = [
    ContentTransition.blurReplace(7),
    ContentTransition.push("trailing"),
    ContentTransition.scale(0.8),
  ]
  for (const [index, transition] of cases.entries()) {
    let label
    const App = defineView(`TextVariant${index}`, {
      initializers: [initializer(`TextVariant${index}()`, args => args.length === 0)],
      state: () => ({ label: label = State("Before") }),
      body: ({ label }) => Text(label.value)
        .contentTransition(transition)
        .animation(Animation.spring(0.08, 0.72), label.value),
    })
    const dom = new JSDOM("<body><div id=app></div></body>", { pretendToBeVisual: true })
    installGeometry(dom, 120, 28)
    const container = dom.window.document.querySelector("#app")
    const unmount = mount(App(), container)
    label.value = "After"
    await flush()
    const overlay = dom.window.document.querySelector("[data-mun-text-transition-layer]")
    assert.ok(overlay)
    assert.equal(overlay.getAttribute("aria-hidden"), "true")
    assert.equal(container.textContent, "After")
    await wait(180)
    assert.equal(dom.window.document.querySelector("[data-mun-text-transition-layer]"), null)
    unmount()
    dom.window.close()
  }
})

test("compiler lowers Swift-style contentTransition and symbol-effect shorthand", () => {
  assert.equal(
    transformMunSource('Text("Saved").contentTransition(.interpolate)', "ContentTransition.mun.ts"),
    'import { ContentTransition } from "@mun/core/compat"\nText("Saved").contentTransition(ContentTransition.interpolate)',
  )
  assert.equal(
    transformMunSource('Image(icon).contentTransition(.symbolEffect(.magicReplace(fallback: .opacity))).animation()', "SymbolTransition.mun.ts"),
    'import { ContentTransition, SymbolEffect } from "@mun/core/compat"\nImage(icon).contentTransition(ContentTransition.symbolEffect(SymbolEffect.magicReplace("opacity"))).animation()',
  )
  assert.equal(
    transformMunSource('Text(String(count)).contentTransition(.numericText(value: count)).animation(.easeInOut, value: count)', "NumericTransition.mun.ts"),
    'import { ContentTransition } from "@mun/core/compat"\nText(String(count)).contentTransition(ContentTransition.numericText(count)).animation(Animation.easeInOut(), count)',
  )
  assert.equal(
    transformMunSource('Text("Saved").contentTransition(.blurReplace(radius: 9))', "BlurTransition.mun.ts"),
    'import { ContentTransition } from "@mun/core/compat"\nText("Saved").contentTransition(ContentTransition.blurReplace(9))',
  )
  assert.equal(
    transformMunSource('Text("Saved").contentTransition(.push(from: .trailing))', "PushTransition.mun.ts"),
    'import { ContentTransition } from "@mun/core/compat"\nText("Saved").contentTransition(ContentTransition.push("trailing"))',
  )
  assert.equal(
    transformMunSource('Text("Saved").contentTransition(.scale(scale: 0.82))', "ScaleTransition.mun.ts"),
    'import { ContentTransition } from "@mun/core/compat"\nText("Saved").contentTransition(ContentTransition.scale(0.82))',
  )
  const specialized = transformMunSource(
    'import { ContentTransition, Image, SymbolEffect } from "@mun/core/compat"\nconst value = Image(icon).contentTransition(.symbolEffect(.magicReplace(fallback: .opacity))).animation()',
    "SpecializedSymbolTransition.mun.ts",
  )
  assert.match(specialized, /modifiedContentCompiled/)
  assert.match(specialized, /ContentTransition\.symbolEffect\(SymbolEffect\.magicReplace\("opacity"\)\)/)
  assert.match(specialized, /\["animationAuto", \[0, \["--mun-content"\]\]\]/)
})
