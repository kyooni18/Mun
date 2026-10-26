/* SPDX-License-Identifier: MIT */

import { JSDOM } from "jsdom"

export function browser(storage = new Map()) {
  const dom = new JSDOM("<!doctype html><main></main>", { url: "https://mun.test", pretendToBeVisual: true })
  const owner = dom.window
  let id = 0, now = 0
  Object.defineProperty(owner.performance, "now", { value: () => now })
  const frames = new Map(), idle = new Map(), timers = new Map()
  Object.defineProperty(owner.document, "readyState", { value: "loading" })
  Object.defineProperty(owner, "localStorage", { configurable: true, value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  } })
  owner.CSS = { supports: () => true }
  owner.requestAnimationFrame = callback => { frames.set(++id, callback); return id }
  owner.cancelAnimationFrame = id => frames.delete(id)
  owner.requestIdleCallback = callback => { idle.set(++id, callback); return id }
  owner.cancelIdleCallback = id => idle.delete(id)
  owner.setTimeout = (callback, delay) => { timers.set(++id, { callback, delay }); return id }
  owner.clearTimeout = id => timers.delete(id)
  const flush = (queue, value) => { const callbacks = [...queue.values()]; queue.clear(); callbacks.forEach(fn => fn(value)) }
  const frame = time => flush(frames, time)
  const timer = delay => {
    for (const [id, timer] of timers) if (timer.delay === delay) { timers.delete(id); timer.callback() }
  }
  const start = () => { owner.dispatchEvent(new owner.Event("load")); frame(0); frame(16); timer(1000) }
  return { dom, owner, storage, frames, idle, timers, start, frame, timer, advance: ms => { now += ms },
    flushIdle: (budget = 50) => flush(idle, { didTimeout: false, timeRemaining: () => budget }),
    sample: () => owner.document.querySelector("[data-pb-probe]"),
  }
}
