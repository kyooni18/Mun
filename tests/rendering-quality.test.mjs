/* SPDX-License-Identifier: MIT */

import assert from "node:assert/strict"
import test from "node:test"
import { browser } from "./helpers/rendering-quality.mjs"
import { getRenderingQuality, observeRenderingQuality, prepareRenderingQuality } from "../packages/animation/src/rendering-quality/index.js"

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
    stop()
    resolve()
    await Promise.resolve()
    assert.equal(controller.snapshot.gpuQueueDelayMs, null, "stale completions cannot update a stopped controller")
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
