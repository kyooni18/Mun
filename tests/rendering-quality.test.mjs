/* SPDX-License-Identifier: MIT */

import assert from "node:assert/strict"
import test from "node:test"
import { browser } from "./helpers/rendering-quality.mjs"
import { getRenderingQuality, observeRenderingQuality, prepareRenderingQuality } from "../packages/animation/dist/src/rendering-quality/index.js"
import { motionValue } from "../packages/animation/dist/src/index.js"
import { createCanvasRenderer } from "../packages/animation/dist/src/canvas/index.js"
import { compileParticleFieldGPUIsland } from "../packages/compiler/dist/gpu-island-ir.js"
import { VStack } from "../packages/core/dist/index.js"
import { mount } from "../packages/web/dist/index.js"
import { BlurProfile, ProgressiveBlur } from "../packages/progressive-blur/dist/index.js"

async function initial(b, quality = "full") {
  const owner = b.owner
  const key = "mun:backdrop-quality:v1:" + JSON.stringify([owner.navigator.userAgent, owner.screen.width, owner.screen.height, owner.screen.colorDepth, owner.devicePixelRatio])
  b.storage.set(key, quality)
  const ready = prepareRenderingQuality(owner)
  b.start(); b.flushIdle()
  await ready
}

async function recheck(b, intervals = [16, 16]) {
  b.advance(30_000); b.timer(30_000)
  b.start(); b.flushIdle()
  assert.ok(b.sample(), "periodic measurements bypass the startup cache")
  b.frame(100); b.frame(116); b.frame(132); b.flushIdle()
  b.frame(150); b.frame(150 + intervals[0]); b.frame(150 + intervals[0] + intervals[1])
  await Promise.resolve(); await Promise.resolve()
  b.flushIdle()
}

test("one global controller resamples every 30s and restores quality gradually", async () => {
  const b = browser()
  let stop1, stop2
  try {
    const controller = getRenderingQuality(b.owner)
    assert.equal(getRenderingQuality(b.owner), controller)
    const changes = []
    stop1 = observeRenderingQuality(snapshot => changes.push(snapshot.quality), b.owner)
    stop2 = observeRenderingQuality(() => {}, b.owner)
    await initial(b, "none")
    assert.equal(controller.quality, "none")
    assert.equal([...b.timers.values()].filter(timer => timer.delay === 30_000).length, 1)
    await recheck(b)
    assert.equal(controller.quality, "none", "one healthy probe cannot raise quality")
    await recheck(b, [16, 60])
    assert.equal(controller.quality, "none", "unclear probes cannot restore quality")
    await recheck(b); await recheck(b)
    assert.equal(controller.quality, "reduced", "two healthy probes raise only one level")
    await recheck(b); await recheck(b)
    assert.equal(controller.quality, "full")
    await recheck(b, [33, 33])
    assert.equal(controller.quality, "reduced", "a fresh slow probe can lower quality")
    stop1()
    assert.equal([...b.timers.values()].filter(timer => timer.delay === 30_000).length, 1)
    stop2()
    assert.equal(b.timers.size, 0)
    assert.equal(b.frames.size, 0)
    assert.ok(changes.includes("none") && changes.includes("reduced") && changes.includes("full"))
    b.advance(15_000)
    stop1 = observeRenderingQuality(() => {}, b.owner)
    assert.equal([...b.timers.values()][0].delay, 15_000, "remounting cannot keep postponing the global check")
  } finally { stop1?.(); stop2?.(); b.owner.close() }
})

test("sustained frame and queue pressure lower quality without extra render loops or GPU work", async () => {
  const b = browser()
  const stop = observeRenderingQuality(() => {}, b.owner)
  try {
    await initial(b)
    const controller = getRenderingQuality(b.owner)
    // Three bad one-second windows, each with ten late frames.
    for (let window = 0; window < 3; window++) {
      for (let frame = 0; frame < 10; frame++) { b.advance(100); controller.recordFrame(33) }
      assert.equal(controller.quality, window === 2 ? "reduced" : "full")
    }
    assert.equal(b.frames.size, 0, "monitoring uses existing renderer callbacks")
    b.advance(10_000)
    let resolve, calls = 0
    const queue = { onSubmittedWorkDone() { calls++; return new Promise(done => { resolve = done }) } }
    controller.sampleGPUQueue(queue)
    for (let sample = 0; sample < 3; sample++) { b.advance(1034); controller.sampleGPUQueue(queue) }
    assert.equal(calls, 1, "one outstanding queue observation is shared")
    assert.equal(controller.quality, "none", "a backed-up queue is detected before its promise resolves")
    const delay = controller.snapshot.gpuQueueDelayMs
    assert.ok(delay >= 3000)
    await recheck(b); await recheck(b)
    assert.equal(controller.quality, "none", "a healthy CSS sample cannot hide an outstanding GPU backlog")
    stop()
    resolve()
    await Promise.resolve()
    assert.equal(controller.snapshot.gpuQueueDelayMs, delay, "stale completions cannot update a stopped controller")
  } finally { stop(); b.owner.close() }
})

test("hidden pages, unmounts, screen changes, and unavailable APIs fail safely", async () => {
  const b = browser()
  const stop = observeRenderingQuality(() => { throw Error("consumer failed") }, b.owner)
  try {
    await initial(b, "reduced")
    const controller = getRenderingQuality(b.owner)
    Object.defineProperty(b.owner.document, "visibilityState", { configurable: true, value: "hidden" })
    b.owner.document.dispatchEvent(new b.owner.Event("visibilitychange"))
    assert.equal(b.timers.size, 0)
    Object.defineProperty(b.owner.document, "visibilityState", { configurable: true, value: "visible" })
    b.owner.document.dispatchEvent(new b.owner.Event("visibilitychange"))
    assert.equal([...b.timers.values()].filter(timer => timer.delay === 30_000).length, 1)
    Object.defineProperty(b.owner, "devicePixelRatio", { value: 2 })
    b.owner.dispatchEvent(new b.owner.Event("resize"))
    b.start(); b.flushIdle()
    assert.equal(b.sample().style.width, "16px")
    stop()
    assert.equal(b.sample(), null, "last unsubscribe aborts an in-flight sample")
    assert.equal(b.frames.size, 0)
    assert.equal(b.timers.size, 0)
    assert.equal(await prepareRenderingQuality(null), "full")
    assert.equal(getRenderingQuality(null), null)
  } finally { stop(); b.owner.close() }
})

test("live blur and canvas rendering share quality, pacing, freezing and restoration", async () => {
  const b = browser()
  let dispose
  try {
    let draws = 0
    b.owner.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() { draws++ }, beginPath() {}, moveTo() {}, arc() {}, fill() {} })
    const graph = VStack(
      compileParticleFieldGPUIsland({ id: "adaptive", count: 1, fallback: "canvas" }),
      ProgressiveBlur(BlurProfile.edge("bottom", 80), { radius: 12 }),
    )
    const container = b.owner.document.querySelector("main")
    dispose = mount(graph, container)
    await initial(b)
    const controller = getRenderingQuality(b.owner)
    const blur = container.querySelector("[data-pb-amount]")
    const canvas = container.querySelector("canvas")
    const activeLayers = () => [...blur.children].filter(layer => layer.style.display !== "none").length
    const lateWindows = () => {
      for (let window = 0; window < 3; window++) for (let frame = 0; frame < 10; frame++) { b.advance(100); controller.recordFrame(33) }
    }
    let before = draws
    for (const time of [20, 36.7, 53.4, 70.1, 86.8, 103.5]) b.frame(time)
    assert.equal(draws - before, 6)
    lateWindows()
    assert.equal(blur.dataset.pbQuality, "reduced")
    assert.equal(canvas.dataset.munRenderingQuality, "reduced")
    assert.equal(activeLayers(), 2)
    before = draws
    for (const time of [120.2, 136.9, 153.6, 170.3, 187, 203.7]) b.frame(time)
    assert.equal(draws - before, 3, "reduced canvas work runs at 30fps")
    b.advance(10_000); controller.recordFrame(16); lateWindows()
    assert.equal(activeLayers(), 0)
    assert.equal(b.frames.size, 0, "none stops the renderer frame loop")
    before = draws
    b.frame(300)
    assert.equal(draws, before)
    await recheck(b); await recheck(b)
    assert.equal(activeLayers(), 2)
    b.frame(400)
    assert.ok(draws > before, "the same canvas resumes after recovery")
    dispose()
    assert.equal(b.frames.size, 0)
    assert.equal(b.timers.size, 0)
  } finally { dispose?.(); b.owner.close() }
})

test("demand-driven Canvas motion retains the newest state while quality is reduced or paused", async () => {
  const b = browser()
  let renderer
  try {
    const canvas = b.owner.document.createElement("canvas")
    b.owner.document.body.append(canvas)
    const value = motionValue(0)
    const draws = []
    renderer = createCanvasRenderer({ canvas }, [value], (_context, values) => draws.push(values[0]))
    await initial(b, "none")
    value.set(1); value.set(2)
    b.frame(100)
    const paused = draws.length
    assert.equal(renderer.snapshot[0], 2)
    await recheck(b); await recheck(b)
    b.frame(200)
    assert.equal(draws.at(-1), 2)
    assert.equal(draws.length, paused + 1)
    value.set(3); b.frame(210)
    assert.equal(draws.at(-1), 2)
    const trailing = [...b.timers.values()].find(timer => timer.delay < 100)
    assert.ok(trailing, "a single trailing update preserves the last value")
    b.timer(trailing.delay); b.frame(234)
    assert.equal(draws.at(-1), 3)
    renderer.dispose()
    assert.equal(b.timers.size, 0)
  } finally { renderer?.dispose(); b.owner.close() }
})
