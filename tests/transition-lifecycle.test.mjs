import assert from "node:assert/strict"
import test from "node:test"
const jsdomModule = await import("jsdom").catch(() => null)
import { Animation, State, Text, Transition, defineView, initializer, viewFragment } from "../packages/core/dist/compat.js"
import { mount } from "../packages/web/dist/index.js"
import { playWebTransition, transitionDurationMs, transitionFrames } from "../packages/web/dist/transition.js"

test("transition descriptors compose insertion and removal effects without renderer state", () => {
  const transition = Transition.opacity
    .combined(Transition.scale(0.9))
    .combined(Transition.move("bottom", 20))
    .animation(Animation.linear(0.2))
  assert.equal(transition.descriptor.insertion.length, 3)
  assert.equal(transition.descriptor.removal.length, 3)
  assert.equal(transitionDurationMs(transition), 200)
  const [from, to] = transitionFrames(transition, true, { opacity: "0.8", transform: "rotate(2deg)" })
  assert.equal(from.opacity, 0)
  assert.match(String(from.transform), /rotate\(2deg\).*scale\(0.9\).*translate3d/)
  assert.equal(to.opacity, 0.8)
  assert.equal(to.transform, "rotate(2deg)")
})

test("delayed web transitions hold their inactive frame before playback", () => {
  const events = new Map()
  let options
  const element = {
    ownerDocument: {
      defaultView: {
        matchMedia: () => ({ matches: false }),
        getComputedStyle: () => ({ opacity: "1", transform: "none" }),
      },
    },
    animate(_frames, received) {
      options = received
      return {
        cancel() {},
        addEventListener(type, listener) { events.set(type, listener) },
      }
    },
  }
  const transition = Transition.opacity.animation(Animation.linear(0.2).delay(0.4))
  const { cancel } = playWebTransition(element, transition, true)
  assert.equal(options.fill, "backwards")
  assert.equal(options.delay, 400)
  cancel()
})

test("exit transitions leave the live reconciliation tree immediately and clean their overlay", { skip: jsdomModule == null }, async () => {
  const dom = new jsdomModule.JSDOM("<body><div id=app></div></body>", { pretendToBeVisual: true })
  const target = dom.window.document.querySelector("#app")
  const visible = State(true)
  const Host = defineView("TransitionHost", {
    initializers: [initializer("TransitionHost()", args => args.length === 0)],
    body: () => visible.value
      ? Text("leaving").transition(Transition.opacity.animation(Animation.linear(0)))
      : viewFragment([]),
  })
  const unmount = mount(Host(), target)
  assert.equal(target.textContent, "leaving")

  visible.value = false
  await Promise.resolve()
  assert.equal(target.textContent, "")
  assert.ok(dom.window.document.querySelector("[data-mun-transition-layer]"))
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(dom.window.document.querySelector("[data-mun-transition-layer]"), null)
  assert.equal(dom.window.document.body.textContent, "")

  unmount()
  dom.window.close()
})


test('presentation coordinator locks modal scroll and restores focus', { skip: jsdomModule == null }, async () => {
  const { activateWebPresentation, activePresentationCount, disposeWebPresentation } = await import('../packages/web/dist/presentation.js')
  const dom = new jsdomModule.JSDOM('<!doctype html><body><button id="before">Before</button><dialog id="modal"></dialog></body>')
  const { document } = dom.window
  const before = document.getElementById('before')
  const modal = document.getElementById('modal')
  before.focus()
  activateWebPresentation(modal)
  assert.equal(activePresentationCount(document), 1)
  assert.equal(document.body.style.overflow, 'hidden')
  disposeWebPresentation(modal)
  assert.equal(activePresentationCount(document), 0)
  assert.equal(document.body.style.overflow, '')
  assert.equal(document.activeElement, before)
})
