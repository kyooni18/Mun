import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import {
  Animation,
  Element,
  State,
  Text,
  Transaction,
  modifierGraphOf,
  stateTransaction,
  subscribeState,
  swiftUIApiManifest,
  swiftUICanonicalModifierNames,
  swiftUIInitializerSymbols,
  swiftUIStaticModifierNames,
  withAnimation,
  withRenderTransaction,
  withTransaction,
  defineView,
  initializer,
} from "../packages/core/dist/compat.js"
import { mount, renderToHTML } from "../packages/web/dist/index.js"
import { animateDomStyle, motionSpecForAnimation } from "../packages/web/dist/motion.js"

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function waitUntil(predicate, timeout = 250) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(5)
  }
  return predicate()
}

test("Web DOM animation adapter executes @mun/animation timing and spring specs", async () => {
  const dom = new JSDOM('<div style="opacity:0"></div>')
  const element = dom.window.document.querySelector("div")
  assert.ok(element)
  assert.equal(motionSpecForAnimation(Animation.spring(0.2, 0.8)).kind, "spring")
  assert.equal(animateDomStyle(element, "opacity", "0", 1, Animation.linear(0.01)), true)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(element.style.opacity, "1")
  dom.window.close()
})

test("Web motion channels honor delay/repeat and retarget from the live presentation value", async () => {
  const dom = new JSDOM('<div style="opacity:0"></div>')
  const element = dom.window.document.querySelector("div")
  assert.ok(element)

  const repeated = Animation.linear(0.01).delay(0.01).repeatCount(2, false)
  assert.equal(animateDomStyle(element, "opacity", "0", 1, repeated), true)
  await sleep(5)
  assert.equal(element.style.opacity, "0")
  assert.equal(await waitUntil(() => element.style.opacity === "1", 180), true)

  element.style.opacity = "0"
  assert.equal(animateDomStyle(element, "opacity", "0", 1, Animation.spring(0.12, 0.82)), true)
  assert.equal(await waitUntil(() => {
    const value = Number(element.style.opacity)
    return value > 0 && value < 1
  }, 140), true)
  const presentation = Number(element.style.opacity)
  assert.ok(presentation > 0 && presentation < 1)
  // `from` deliberately supplies the logical previous target (1). A persistent
  // channel must continue from the live presentation value instead of jumping.
  assert.equal(animateDomStyle(element, "opacity", 1, 0, Animation.spring(0.12, 0.82)), true)
  const immediatelyAfterRetarget = Number(element.style.opacity)
  assert.ok(Math.abs(immediatelyAfterRetarget - presentation) < 0.2)
  assert.equal(await waitUntil(() => Number(element.style.opacity) < 0.02, 320), true)
  dom.window.close()
})

test("Web mount routes animated State patches through @mun/animation", async () => {
  const dom = new JSDOM('<div id="app"></div>')
  const container = dom.window.document.querySelector("#app")
  assert.ok(container)
  const opacity = State(0)
  const App = defineView("AnimatedState", {
    initializers: [initializer("AnimatedState()", args => args.length === 0)],
    body: () => Element("div", { style: { opacity: opacity.value } }, "Motion"),
  })
  const unmount = mount(App(), container)
  withAnimation(Animation.linear(0.01), () => { opacity.value = 1 })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(container.firstElementChild?.style.opacity, "1")
  unmount()
  dom.window.close()
})

test("SwiftUI API manifest drives the canonical source contract and runtime mapping", () => {
  const vstack = swiftUIInitializerSymbols("VStack")
  assert.equal(vstack?.length, 1)
  assert.equal(vstack?.[0].signature, "init(alignment:spacing:content:)")
  assert.equal(vstack?.[0].index, 1)
  assert.deepEqual(vstack?.[0].parameters.map(parameter => parameter.name), ["alignment", "spacing", "content"])
  assert.equal(vstack?.[0].parameters.at(-1)?.kind, "viewBuilder")
  assert.equal(vstack?.[0].parameters.at(-1)?.trailing, true)

  assert.equal(swiftUICanonicalModifierNames.has("opacity"), true)
  assert.equal(swiftUICanonicalModifierNames.has("margin"), false)
  assert.equal(swiftUIStaticModifierNames.has("margin"), true)
  // Native claims only the value-scoped overload; the deprecated implicit
  // `animation(_:)` is a named unsupported overload, not a silent omission.
  const animation = swiftUIApiManifest.modifiers.find(modifier => modifier.name === "animation")
  assert.ok(animation?.compat)
  assert.deepEqual(animation.signatures.map(signature => signature.signature), ["animation(_:value:)"])
  assert.ok(swiftUIApiManifest.unsupported.overloads.animation.includes("animation(_:)"))
  // Web limitations are recorded separately and never downgrade native parity.
  const [stack] = swiftUIApiManifest.views.VStack.initializers
  assert.deepEqual([stack.contract, stack.native, stack.web], ["exact", "parity", "approximation"])
  assert.equal(swiftUIApiManifest.schemaVersion, 2)
})

test("withAnimation snapshots its Transaction onto State changes", () => {
  const count = State(0)
  let delivered
  const unsubscribe = subscribeState(count, transaction => { delivered = transaction })
  const animation = Animation.linear(0.2).delay(0.05)

  withAnimation(animation, () => { count.value = 1 })

  unsubscribe()
  assert.strictEqual(delivered?.animation, animation)
  const snapshot = stateTransaction(count)
  assert.strictEqual(snapshot.animation, animation)
  assert.equal(snapshot.disablesAnimations, false)
})

test("withTransaction preserves animation suppression metadata", () => {
  const state = State(false)
  const transaction = new Transaction({ animation: Animation.easeOut(0.1), disablesAnimations: true, isContinuous: true })
  withTransaction(transaction, () => { state.value = true })
  const snapshot = stateTransaction(state)
  assert.strictEqual(snapshot.animation, transaction.animation)
  assert.equal(snapshot.disablesAnimations, true)
  assert.equal(snapshot.isContinuous, true)
})

test("animatable modifiers stay renderer-neutral and Web wrapper preserves independent transform channels", () => {
  const animation = Animation.easeInOut(0.25)
  const graph = Text("Motion")
    .opacity(0.5)
    .scaleEffect({ x: 1.2, y: 0.8 })
    .rotationEffect(45)
    .offset(10, 5)
    .animation(animation, true)

  assert.deepEqual(modifierGraphOf(graph).map(modifier => modifier.name), [
    "opacity",
    "scaleEffect",
    "rotationEffect",
    "offset",
    "animation",
  ])

  const html = renderToHTML(graph)
  assert.match(html, /opacity:0\.5/)
  assert.match(html, /scale:1\.2 0\.8/)
  assert.match(html, /rotate:45deg/)
  assert.match(html, /translate:10px 5px/)
  assert.doesNotMatch(html, /transform:scale/)
  assert.match(html, /transition-duration:0\.25s/)
})

test("render Transactions feed the initial Web animation wrapper", () => {
  const graph = Text("Transaction").opacity(0.25).scaleEffect(0.9)
  const html = withRenderTransaction(
    new Transaction(Animation.spring(0.4, 0.8)),
    () => renderToHTML(graph),
  )
  assert.match(html, /transition-property:/)
  assert.match(html, /transition-duration:0\.4s/)
  assert.match(html, /scale:0\.9/)
})

import { diagnoseMunSource, transformMunSource } from "../packages/compiler/dist/index.js"

test("Swift-style labeled modifiers lower before TypeScript parsing", () => {
  assert.equal(
    transformMunSource('Text("Hi").frame(width: 100, height: 40)', "Modifier.mun.ts"),
    'Text("Hi").frame({ width: 100, height: 40 })',
  )
  assert.equal(
    transformMunSource('Text("Hi").offset(x: 10, y: 5)', "Modifier.mun.ts"),
    'Text("Hi").offset({ x: 10, y: 5 })',
  )
  assert.equal(
    transformMunSource('Text("Hi").scaleEffect(x: 1.2, y: 0.8, anchor: .center)', "Modifier.mun.ts"),
    'Text("Hi").scaleEffect({ x: 1.2, y: 0.8 }, "center")',
  )
  assert.equal(
    transformMunSource('Text("Hi").scaleEffect(x: 1.2)', "Modifier.mun.ts"),
    'Text("Hi").scaleEffect({ x: 1.2 })',
  )
  assert.equal(
    transformMunSource('Text("Hi").shadow(radius: 8, x: 1)', "Modifier.mun.ts"),
    'Text("Hi").shadow(undefined, 8, 1)',
  )
  assert.equal(
    transformMunSource('Text("Hi").fixedSize(horizontal: true, vertical: false)', "Modifier.mun.ts"),
    'Text("Hi").fixedSize(true, false)',
  )
  assert.equal(
    transformMunSource('Text("Hi").onTapGesture(count: 2, perform: { save() })', "Modifier.mun.ts"),
    'Text("Hi").onTapGesture(2, () => {save()})',
  )
  assert.equal(
    transformMunSource('Text("Hi").onHover(perform: { hovering in setHover(hovering) })', "Modifier.mun.ts"),
    'Text("Hi").onHover((hovering) => {setHover(hovering)})',
  )
})

test("canonical stack syntax and diagnostics use the same manifest", () => {
  const source = 'VStack(alignment: .leading, spacing: 12) { Text("Hi") }'
  const output = transformMunSource(source, "Stack.mun.ts")
  assert.match(output, /VStack\(namedArguments\(\{ alignment: "leading", spacing: 12 \}\), \(\) => \[Text\("Hi"\)\]\)/)
  assert.deepEqual(diagnoseMunSource(source), [])
})

test("withAnimation lowers Swift-style Animation factories and action closures", () => {
  const source = 'withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) { expanded.value = true }'
  assert.equal(
    transformMunSource(source, "Animation.mun.ts"),
    'withAnimation(Animation.spring(0.4, 0.8), () => { expanded.value = true })',
  )
  assert.deepEqual(diagnoseMunSource(source), [])

  const skippedDefault = 'Animation.spring(dampingFraction: 0.7)'
  assert.equal(transformMunSource(skippedDefault, "Animation.mun.ts"), 'Animation.spring(undefined, 0.7)')
  assert.deepEqual(diagnoseMunSource(skippedDefault), [])

  assert.equal(
    transformMunSource('withAnimation(.default) { expanded.value = false }', "Animation.mun.ts"),
    'withAnimation(Animation.default, () => { expanded.value = false })',
  )
  assert.equal(
    transformMunSource('Text("Hi").animation(.easeInOut, value: active)', "Animation.mun.ts"),
    'Text("Hi").animation(Animation.easeInOut(), active)',
  )
})
