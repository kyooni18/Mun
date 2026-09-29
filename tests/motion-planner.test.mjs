import test from "node:test"
import assert from "node:assert/strict"
import { Animation } from "../packages/core/dist/index.js"
import { animateDomLayout, animateDomStyle, animateDomStyles, cancelDomAnimations, motionSpecForAnimation } from "../packages/web/dist/motion.js"
import { MunMotionEngine } from "../packages/web/dist/element-motion.js"

function fakeElement(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    style: {
      setProperty(name, value) { values.set(name, String(value)) },
      getPropertyValue(name) { return values.get(name) ?? "" },
      removeProperty(name) { values.delete(name) },
    },
    value(name) { return values.get(name) },
  }
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function waitUntil(predicate, timeout = 250) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(5)
  }
  return predicate()
}

test("Mun reuses precompiled motion specs across persistent scalar retargets", async () => {
  const element = fakeElement({ opacity: "0" })
  const animation = Animation.linear(0.012)
  const spec = motionSpecForAnimation(animation)
  assert.strictEqual(motionSpecForAnimation(animation), spec)
  assert.equal(animateDomStyle(element, "opacity", "0", 1, animation), true)
  await sleep(6)
  assert.equal(animateDomStyle(element, "opacity", element.value("opacity") ?? "0", 0.25, animation), true)
  await sleep(70)
  assert.equal(Number(element.value("opacity")), 0.25)
  cancelDomAnimations(element)
})

test("Mun forwards spring blendDuration into the precompiled engine plan", () => {
  const animation = Animation.spring(0.4, 0.8, 0.12).speed(2)
  const spec = motionSpecForAnimation(animation)
  assert.equal(spec.kind, "spring")
  assert.equal(spec.blendDuration, 0.06)
})

test("Mun motion plan applies delay and finite autoreversing iterations without rebuilding the channel", async () => {
  const element = fakeElement({ opacity: "0" })
  const animation = Animation.linear(0.008).delay(0.02).repeatCount(2, true)
  assert.equal(animateDomStyle(element, "opacity", "0", 1, animation), true)
  await sleep(10)
  assert.equal(element.value("opacity"), "0")
  await sleep(180)
  assert.equal(Number(element.value("opacity")), 0)
  cancelDomAnimations(element)
})

test("interpolated motion uses repeatCount as iteration count and autoreverses", async () => {
  const history = []
  const values = new Map([["transform", "translateX(0px)"]])
  const element = {
    style: {
      setProperty(name, value) {
        values.set(name, String(value))
        if (name === "transform") history.push(String(value))
      },
    },
  }
  const animation = Animation.linear(0.008).repeatCount(2, true)
  assert.equal(animateDomStyle(element, "transform", "translateX(0px)", "translateX(10px)", animation), true)
  await sleep(160)
  assert.ok(history.some(value => value === "none" || /\b0(?:\.0+)?px\b/.test(value)), `expected an autoreverse pass: ${history.join(" -> ")}`)
  assert.ok(history.some(value => /10(?:\.0+)?px/.test(value)), `expected a forward pass: ${history.join(" -> ")}`)
  assert.ok((history.at(-1) ?? "") === "none" || /\b0(?:\.0+)?px\b/.test(history.at(-1) ?? ""), `expected the even autoreverse to end at origin: ${history.join(" -> ")}`)
  cancelDomAnimations(element)
})

test("delayed scalar retarget keeps the current presentation motion running until handoff", async () => {
  const element = fakeElement({ opacity: "0" })
  const first = Animation.linear(0.16)
  const delayed = Animation.linear(0.04).delay(0.08)
  assert.equal(animateDomStyle(element, "opacity", "0", 1, first), true)
  await sleep(25)
  const atRetarget = Number(element.value("opacity"))
  assert.equal(animateDomStyle(element, "opacity", element.value("opacity") ?? "0", 0.25, delayed), true)
  await sleep(35)
  const duringDelay = Number(element.value("opacity"))
  assert.ok(duringDelay > atRetarget, `expected the old motion to continue during delay: ${atRetarget} -> ${duringDelay}`)
  await sleep(150)
  assert.equal(Number(element.value("opacity")), 0.25)
  cancelDomAnimations(element)
})

test("cancelling a property clears delayed writes and prevents stale commits", async () => {
  const element = fakeElement({ opacity: "0" })
  const animation = Animation.linear(0.01).delay(0.03)
  assert.equal(animateDomStyle(element, "opacity", "0", 1, animation), true)
  cancelDomAnimations(element)
  await sleep(70)
  assert.equal(element.value("opacity"), "0")
})


test("equivalent recreated Animation descriptors share one compiled motion spec", () => {
  const first = motionSpecForAnimation(Animation.easeInOut(0.123).delay(0.017))
  const second = motionSpecForAnimation(Animation.easeInOut(0.123).delay(0.017))
  assert.strictEqual(second, first)
})

test("multi-style motion launches independent channels together without cross-cancellation", async () => {
  const element = fakeElement({ opacity: "0", scale: "1", translate: "0px 0px" })
  const opacityAnimation = Animation.linear(0.09)
  const scaleAnimation = Animation.spring(0.05, 0.78)
  const positionAnimation = Animation.easeInOut(0.06)
  const started = animateDomStyles(element, [
    { property: "opacity", from: "0", to: "1", animation: opacityAnimation },
    { property: "scale", from: "1", to: "1.8", animation: scaleAnimation },
    { property: "translate", from: "0px 0px", to: "30px -12px", animation: positionAnimation },
  ])
  assert.deepEqual([...started].sort(), ["opacity", "scale", "translate"])

  assert.equal(await waitUntil(() => {
    const value = Number(element.value("opacity"))
    return value > 0 && value < 1
  }, 140), true)
  const opacityBeforeScaleRetarget = Number(element.value("opacity"))
  assert.ok(opacityBeforeScaleRetarget > 0 && opacityBeforeScaleRetarget < 1)
  // Retarget only scale with a fourth curve. The opacity and position drivers
  // must keep running because every CSS property owns an independent channel.
  assert.equal(animateDomStyle(element, "scale", element.value("scale") ?? "1", "0.75", Animation.easeOut(0.035)), true)
  assert.equal(await waitUntil(() => Number(element.value("opacity")) > opacityBeforeScaleRetarget, 140), true)
  const opacityAfterScaleRetarget = Number(element.value("opacity"))
  assert.ok(opacityAfterScaleRetarget > opacityBeforeScaleRetarget, `${opacityBeforeScaleRetarget} -> ${opacityAfterScaleRetarget}`)

  assert.equal(await waitUntil(() => Number(element.value("opacity")) === 1 && Number(element.value("scale")) === 0.75, 260), true)
  assert.equal(Number(element.value("opacity")), 1)
  assert.equal(Number(element.value("scale")), 0.75)
  assert.match(element.value("translate") ?? "", /^30(?:\.0+)?px -12(?:\.0+)?px$/)
  cancelDomAnimations(element)
})

test("switch motion preserves presentation continuity across rapid reversal", async () => {
  const element = fakeElement({ opacity: "0", translate: "0px 0px" })
  const opacityAnimation = Animation.easeOut(0.18)
  const positionAnimation = Animation.spring(0.3, 0.86)

  const started = animateDomStyles(element, [
    { property: "opacity", from: "0", to: "1", animation: opacityAnimation },
    { property: "translate", from: "0px 0px", to: "17.6px 0px", animation: positionAnimation },
  ])
  assert.deepEqual([...started].sort(), ["opacity", "translate"])

  await sleep(35)
  const beforeReverseOpacity = Number(element.value("opacity"))
  const beforeReverseTranslate = Number.parseFloat(element.value("translate") ?? "0")
  assert.ok(beforeReverseOpacity > 0 && beforeReverseOpacity < 1, `expected in-flight opacity, got ${beforeReverseOpacity}`)
  assert.ok(beforeReverseTranslate > 0 && beforeReverseTranslate < 17.6, `expected in-flight translate, got ${beforeReverseTranslate}`)

  const reversed = animateDomStyles(element, [
    { property: "opacity", from: element.value("opacity") ?? "0", to: "0", animation: opacityAnimation },
    { property: "translate", from: element.value("translate") ?? "0px 0px", to: "0px 0px", animation: positionAnimation },
  ])
  assert.deepEqual([...reversed].sort(), ["opacity", "translate"])

  await sleep(30)
  const afterReverseTranslate = Number.parseFloat(element.value("translate") ?? "0")
  assert.ok(afterReverseTranslate < beforeReverseTranslate, `${beforeReverseTranslate} -> ${afterReverseTranslate}`)

  await sleep(450)
  assert.ok(Math.abs(Number(element.value("opacity"))) < 0.001)
  assert.ok(Math.abs(Number.parseFloat(element.value("translate") ?? "0")) < 0.01)
  cancelDomAnimations(element)
})

test("layout FLIP animates real size and position deltas on its own channel", async () => {
  const element = fakeElement({ transform: "rotate(8deg)", translate: "", scale: "" })
  const before = { left: 10, top: 20, width: 100, height: 30 }
  const after = { left: 55, top: 32, width: 160, height: 54 }
  assert.equal(animateDomLayout(element, before, after, Animation.easeInOut(0.04)), true)
  assert.match(element.value("translate") ?? "", /px/)
  assert.notEqual(element.value("scale"), "")
  assert.equal(element.value("transform"), "rotate(8deg)")
  await sleep(120)
  assert.match(element.value("translate") ?? "", /^0(?:\.0+)?px 0(?:\.0+)?px$/)
  assert.match(element.value("scale") ?? "", /^1(?:\.0+)? 1(?:\.0+)?$/)
  assert.equal(element.value("transform"), "rotate(8deg)")
  cancelDomAnimations(element)
})

test("shared element motion keeps CSS properties independently cancellable", async () => {
  const values = new Map([["opacity", "0"], ["transform", "translateX(0px)"]])
  const element = {
    style: {
      setProperty(name, value) { values.set(name, String(value)) },
      getPropertyValue(name) { return values.get(name) ?? "" },
      getPropertyPriority() { return "" },
      removeProperty(name) { values.delete(name) },
    },
  }
  const engine = new MunMotionEngine()
  engine.animateElement(element, [
    { opacity: 0, transform: "translateX(0px)" },
    { opacity: 1, transform: "translateX(40px)" },
  ], { animation: Animation.linear(0.08), fill: "forwards" })

  await sleep(20)
  engine.animateElement(element, [{ opacity: values.get("opacity") ?? "0" }, { opacity: 0.25 }], {
    animation: Animation.linear(0.025),
    fill: "forwards",
  })
  await sleep(140)

  assert.equal(Number(values.get("opacity")), 0.25)
  assert.match(values.get("transform") ?? "", /40(?:\.0+)?px/)
  engine.cancelAll()
})

test("shared element motion interpolates multi-keyframe fallback tracks", async () => {
  const history = []
  const values = new Map([["opacity", "0"]])
  const element = {
    style: {
      setProperty(name, value) {
        values.set(name, String(value))
        if (name === "opacity") history.push(Number(value))
      },
      getPropertyValue(name) { return values.get(name) ?? "" },
      getPropertyPriority() { return "" },
      removeProperty(name) { values.delete(name) },
    },
  }
  const engine = new MunMotionEngine()
  const handle = engine.animateElement(element, [
    { offset: 0, opacity: 0 },
    { offset: 0.5, opacity: 1 },
    { offset: 1, opacity: 0 },
  ], { animation: Animation.linear(0.06), fill: "forwards" })
  assert.equal(await handle.finished, "finished")
  assert.ok(history.some(value => value > 0.5), `expected middle keyframe, got ${history.join(", ")}`)
  assert.ok(Math.abs(Number(values.get("opacity"))) < 0.001)
  engine.cancelAll()
})
