/* SPDX-License-Identifier: MIT */

import assert from "node:assert/strict"
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { chromium } from "@playwright/test"

// Isolate the real CSS probe from application startup and measure each browser
// context only once. Run after building @mun/animation.
const server = createServer(async (request, response) => {
  if (request.url === "/index.js" || request.url === "/probe.js") {
    const source = await readFile(new URL(`../packages/animation/dist/src/rendering-quality${request.url}`, import.meta.url))
    response.writeHead(200, { "Content-Type": "text/javascript" }).end(source)
  } else response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>Blur probe cost</title>")
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const url = `http://127.0.0.1:${server.address().port}`
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.MUN_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MUN_CHROMIUM_EXECUTABLE } : {}) })
  const system = await browser.newBrowserCDPSession()
  const info = await system.send("SystemInfo.getInfo")
  console.log(JSON.stringify({ browser: browser.version(), gpu: info.gpu.devices }, null, 2))
  if (process.argv.includes("--monitor")) {
    const page = await browser.newPage()
    await page.goto(url)
    const result = await page.evaluate(async () => {
      const { observeRenderingQuality, prepareRenderingQuality } = await import("/index.js")
      const starts = [], durations = [], longTasks = []
      const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)))
      observer.observe({ type: "longtask" })
      let finish
      const complete = new Promise(resolve => { finish = resolve })
      const mutations = new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) if (node instanceof HTMLElement && node.hasAttribute("data-pb-probe")) starts.push(performance.now())
          for (const node of record.removedNodes) if (node instanceof HTMLElement && node.hasAttribute("data-pb-probe")) {
            durations.push(performance.now() - starts.at(-1))
            if (durations.length === 2) finish()
          }
        }
      })
      mutations.observe(document.body, { childList: true })
      const stop = observeRenderingQuality(() => {})
      await prepareRenderingQuality()
      await complete
      stop(); mutations.disconnect(); observer.disconnect()
      return { periodMs: starts[1] - starts[0], sampleDurationsMs: durations, longTasks }
    })
    assert.ok(result.periodMs >= 30_000 && result.periodMs < 35_000)
    assert.equal(result.sampleDurationsMs.length, 2)
    console.log(JSON.stringify({ monitor: result }, null, 2))
    await page.close()
  } else {
    for (const dpr of [1, 2]) {
      for (let run = 0; run < 3; run++) {
        const context = await browser.newContext({ deviceScaleFactor: dpr })
        const page = await context.newPage()
        const session = await context.newCDPSession(page)
        const events = []
        session.on("Tracing.dataCollected", chunk => events.push(...chunk.value))
        await page.goto(url)
        await session.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing", transferMode: "ReportEvents" })
        const measure = async () => page.evaluate(async () => {
          const { prepareRenderingQuality: prepareProgressiveBlur } = await import("/index.js")
          let callbackMs = 0, maxCallbackMs = 0, frameCount = 0, layers = 0, area = 0
          const intervals = [], longTasks = []
          const observer = new MutationObserver(records => {
            for (const record of records) {
              for (const node of record.addedNodes) {
                if (node instanceof HTMLElement && node.hasAttribute("data-pb-probe")) {
                  performance.mark("probe-start")
                  area = parseFloat(node.style.width) * parseFloat(node.style.height) * devicePixelRatio ** 2
                }
              }
              if (document.querySelector("[data-pb-probe]")?.children.length) {
                const sample = document.querySelector("[data-pb-probe]")
                layers = sample.children.length
                if (![...sample.children].every(child => child.style.backdropFilter.includes("blur(") && child.style.maskImage.includes("gradient("))) throw Error("Expected masked CSS backdrop layers")
              }
              for (const node of record.removedNodes) {
                if (node instanceof HTMLElement && node.hasAttribute("data-pb-probe")) performance.mark("probe-end")
              }
            }
          })
          observer.observe(document.body, { childList: true, subtree: true })
          const longObserver = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)))
          longObserver.observe({ type: "longtask" })
          const tracked = callback => (...args) => {
            const start = performance.now()
            try { return callback(...args) } finally {
              const elapsed = performance.now() - start
              callbackMs += elapsed
              maxCallbackMs = Math.max(maxCallbackMs, elapsed)
            }
          }
          const raf = window.requestAnimationFrame.bind(window), idle = window.requestIdleCallback.bind(window)
          window.requestAnimationFrame = callback => raf(tracked(time => {
            frameCount++
            if (document.querySelector("[data-pb-probe]")) intervals.push({ phase: document.querySelector("[data-pb-probe]").children.length ? "blur" : "baseline", time })
            callback(time)
          }))
          window.requestIdleCallback = callback => idle(tracked(callback))
          const start = performance.now()
          const quality = await prepareProgressiveBlur()
          // Include the deferred cache write in the callback measurement.
          await new Promise(resolve => idle(resolve))
          observer.disconnect(); longObserver.disconnect()
          window.requestAnimationFrame = raf; window.requestIdleCallback = idle
          const marks = performance.getEntriesByName("probe-start"), ends = performance.getEntriesByName("probe-end")
          return { quality, callbackMs, maxCallbackMs, frameCount, layers, area, elapsedMs: performance.now() - start,
            sampleMs: marks.length ? ends.at(-1).startTime - marks.at(-1).startTime : 0,
            intervals: ["baseline", "blur"].map(phase => intervals.filter(frame => frame.phase === phase).map((frame, index, frames) => index ? frame.time - frames[index - 1].time : null).filter(ms => ms !== null)), longTasks }
        })
        const cold = await measure()
        const complete = new Promise(resolve => session.once("Tracing.tracingComplete", resolve))
        await session.send("Tracing.end"); await complete
        const start = events.find(event => event.name === "probe-start")?.ts
        const end = events.find(event => event.name === "probe-end")?.ts
        const render = events.filter(event => ["Paint", "PrePaint", "UpdateLayoutTree", "Layout", "Layerize"].includes(event.name) && event.ts >= start && event.ts <= end)
        cold.renderCpuMs = render.reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000
        assert.equal(cold.frameCount, 8, "two paint gates plus six sample callbacks")
        assert.equal(cold.layers, 3)
        assert.equal(cold.area, 1024)
        await page.reload()
        const cached = await measure()
        assert.equal(cached.layers, 0, "cache avoids all sample DOM")
        assert.equal(cached.frameCount, 2, "cache only waits for the paint gate")
        console.log(JSON.stringify({ dpr, run, cold, cached }, null, 2))
        await context.close()
      }
    }
  }
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
