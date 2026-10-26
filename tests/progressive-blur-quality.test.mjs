/* SPDX-License-Identifier: MIT */

import assert from "node:assert/strict"
import test from "node:test"
import { browser } from "./helpers/rendering-quality.mjs"
import { VStack } from "../packages/core/dist/index.js"
import { compileParticleFieldGPUIsland } from "../packages/compiler/dist/gpu-island-ir.js"
import { mount } from "../packages/web/dist/index.js"
import { BlurProfile, ProgressiveBlur } from "../packages/progressive-blur/dist/index.js"
import { prepareProgressiveBlur, qualityFromFrames } from "../packages/progressive-blur/dist/quality.js"


test("quality thresholds require stable baseline and consistent absolute and relative slowdown", async () => {
  assert.equal(await prepareProgressiveBlur(), "full", "SSR never starts work")
  for (const [baseline, filtered, quality] of [
    [[16, 16], [16, 16], "full"], [[16, 16], [24, 24], "reduced"], [[16, 16], [48, 48], "none"],
    [[33, 33], [40, 40], "full"], [[8, 8], [16, 16], "full"],
    [[16, 33], [50, 50], "full"], [[16, 16], [16, 60], "full"],
    [[16, 16], [NaN, 50], "full"], [[0, 0], [50, 50], "full"], [[16], [50, 50], "full"],
  ]) assert.equal(qualityFromFrames(baseline, filtered), quality)
})

test("probe waits for load, paint, quiet and idle, samples only six frames, and caches by browser/screen", async () => {
  const b = browser()
  try {
    const pending = prepareProgressiveBlur(b.owner)
    assert.equal(prepareProgressiveBlur(b.owner), pending)
    assert.equal(b.frames.size, 0, "no startup work")
    b.start()
    assert.equal(b.sample(), null, "quiet timer only requests idle work")
    b.flushIdle()
    const sample = b.sample()
    assert.ok(sample)
    assert.equal(sample.style.width, "32px")
    assert.equal(sample.style.pointerEvents, "none")
    b.frame(100); b.frame(116); b.frame(132)
    assert.equal(sample.children.length, 0, "blur insertion waits for another idle period")
    b.flushIdle()
    assert.equal(sample.children.length, 3)
    assert.match(sample.firstElementChild.style.maskImage, /linear-gradient/)
    b.frame(150); b.frame(183); b.frame(216)
    assert.equal(await pending, "reduced")
    assert.equal(b.sample(), null)
    assert.equal(b.frames.size, 0)
    b.flushIdle() // deferred storage write
    assert.equal(b.storage.size, 1)
    assert.equal(prepareProgressiveBlur(b.owner), pending)

    const next = browser(b.storage)
    try {
      const cached = prepareProgressiveBlur(next.owner)
      next.start(); next.flushIdle()
      assert.equal(await cached, "reduced")
      assert.equal(next.sample(), null, "reload reuses cache without a sample")
      for (const property of ["devicePixelRatio", "navigator"]) {
        Object.defineProperty(next.owner, property, { value: property === "navigator" ? { userAgent: "other browser" } : 2, configurable: true })
        const changed = prepareProgressiveBlur(next.owner)
        assert.notEqual(changed, cached)
        next.owner.dispatchEvent(new next.owner.Event("pagehide"))
        assert.equal(await changed, "full")
      }
    } finally { next.dom.window.close() }
  } finally { b.dom.window.close() }
})

test("input, visibility, starvation and exceptions abort safely; blocked storage still runs at most once", async () => {
  for (const reason of ["pointerdown", "pointermove", "keydown", "wheel", "scroll", "touchstart", "visibilitychange", "pagehide", "resize", "budget", "watchdog", "exception", "storage", "unsupported"]) {
    const b = browser()
    try {
      if (reason === "storage") Object.defineProperty(b.owner, "localStorage", { get() { throw Error("blocked") } })
      if (reason === "unsupported") b.owner.requestIdleCallback = undefined
      const pending = prepareProgressiveBlur(b.owner)
      b.start()
      if (reason === "budget") b.flushIdle(0)
      else if (reason === "watchdog") b.timer(5000)
      else if (reason === "exception") {
        b.owner.document.body.append = () => { throw Error("DOM unavailable") }
        b.flushIdle()
      } else if (reason !== "unsupported") {
        b.flushIdle()
        if (reason === "storage") {
          b.frame(0); b.frame(16); b.frame(32); b.flushIdle()
          b.frame(50); b.frame(100); b.frame(150)
          assert.equal(await pending, "none")
          b.flushIdle()
        } else {
          const target = reason === "visibilitychange" ? b.owner.document : b.owner
          target.dispatchEvent(new b.owner.Event(reason))
        }
      }
      assert.equal(await pending, reason === "storage" ? "none" : "full", reason)
      assert.equal(b.sample(), null, reason)
      assert.equal(b.frames.size, 0, reason)
      assert.equal(prepareProgressiveBlur(b.owner), pending, reason)
    } finally { b.dom.window.close() }
  }
})

test("GPU renderer startup prepares quality consumed by hydrated blur layers", async () => {
  for (const quality of ["reduced", "none"]) {
    const b = browser()
    try {
      const owner = b.owner
      const key = "mun:backdrop-quality:v1:" + JSON.stringify([owner.navigator.userAgent, owner.screen.width, owner.screen.height, owner.screen.colorDepth, owner.devicePixelRatio])
      b.storage.set(key, quality)
      owner.HTMLCanvasElement.prototype.getContext = () => null
      const gpu = compileParticleFieldGPUIsland({ id: "probe", count: 1, fallback: "static" })
      const graph = VStack(gpu, ProgressiveBlur(BlurProfile.edge("bottom", 80), { radius: 12 }))
      const container = owner.document.querySelector("main")
      // Hydration retains full SSR nodes; quality changes only active layers.
      const { renderToHTML } = await import("../packages/web/dist/index.js")
      container.innerHTML = renderToHTML(graph)
      const box = container.querySelector("[data-pb-amount]")
      const dispose = mount(graph, container, { hydrate: true, experimentalResidentCompute: true })
      b.start(); b.flushIdle()
      await prepareProgressiveBlur(owner)
      await Promise.resolve()
      assert.equal(container.querySelector("[data-pb-amount]"), box)
      const active = [...box.children].filter(child => child.style.display !== "none")
      assert.equal(active.length, quality === "none" ? 0 : 2)
      if (active.length) assert.equal(active[0].style.backdropFilter, "blur(8.49px)")
      dispose()
    } finally { b.dom.window.close() }
  }
})
