/* SPDX-License-Identifier: MIT */

import { BlurProfile, planBlur, type BlurQuality } from "./plan.js"

const runs = new WeakMap<Window, Map<string, Promise<BlurQuality>>>()
const cachePrefix = "mun:backdrop-quality:v1:"
const inputEvents = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "touchmove", "scroll"]
const screenKey = (owner: Window) => JSON.stringify([owner.navigator.userAgent, owner.screen.width, owner.screen.height, owner.screen.colorDepth, owner.devicePixelRatio])
const isQuality = (value: unknown): value is BlurQuality => value === "full" || value === "reduced" || value === "none"

/** Frame pacing is only a hint: require two consistent slow samples and a stable baseline. */
export function qualityFromFrames(baseline: readonly number[], filtered: readonly number[]): BlurQuality {
  if (baseline.length !== 2 || filtered.length !== 2) return "full"
  if ([...baseline, ...filtered].some(ms => !Number.isFinite(ms) || ms < 4 || ms > 100)) return "full"
  const base = (baseline[0]! + baseline[1]!) / 2
  if (base > 40 || Math.abs(baseline[0]! - baseline[1]!) > Math.max(2, base * 0.2)) return "full"
  const slow = Math.min(...filtered)
  if (Math.max(...filtered) > slow * 1.25) return "full"
  if (slow >= Math.max(48, base * 2.5)) return "none"
  if (slow >= Math.max(24, base * 1.5)) return "reduced"
  return "full"
}

/** Consume the GPU renderer's preparation without starting work from a blur component. */
export function progressiveBlurQuality(owner: Window): Promise<BlurQuality> {
  try { return runs.get(owner)?.get(screenKey(owner)) ?? Promise.resolve("full") } catch { return Promise.resolve("full") }
}

/**
 * Schedule once per browser/screen, after load, paint and one quiet second.
 * No idle API or no idle budget means no probe. Never await this during startup.
 */
export function prepareProgressiveBlur(owner: Window | null = typeof window === "undefined" ? null : window): Promise<BlurQuality> {
  if (!owner) return Promise.resolve("full")
  let key: string
  try { key = screenKey(owner) } catch { return Promise.resolve("full") }
  let screens = runs.get(owner)
  if (!screens) runs.set(owner, screens = new Map())
  const previous = screens.get(key)
  if (previous) return previous
  const pending = new Promise<BlurQuality>(resolve => {
    const document = owner.document
    if (typeof owner.requestIdleCallback !== "function" || typeof owner.cancelIdleCallback !== "function"
      || typeof owner.requestAnimationFrame !== "function" || typeof owner.cancelAnimationFrame !== "function") return resolve("full")
    let done = false
    let frame = 0
    let idle = 0
    let quiet = 0
    let watchdog = 0
    let sample: HTMLDivElement | undefined
    const finish = (quality: BlurQuality = "full", cache = !!sample) => {
      if (done) return
      done = true
      owner.cancelAnimationFrame(frame)
      owner.cancelIdleCallback(idle)
      owner.clearTimeout(quiet)
      owner.clearTimeout(watchdog)
      owner.removeEventListener("load", loaded)
      owner.removeEventListener("pagehide", cancel)
      document.removeEventListener("visibilitychange", cancel)
      owner.removeEventListener("resize", cancel)
      for (const event of inputEvents) owner.removeEventListener(event, cancel, true)
      sample?.remove()
      resolve(quality)
      // Storage is synchronous; keep both reads and writes out of input/startup work.
      if (cache) owner.requestIdleCallback(deadline => {
        if (deadline.timeRemaining() < 2) return
        try { owner.localStorage.setItem(cachePrefix + key, quality) } catch { /* blocked or full storage */ }
      })
    }
    const cancel = () => finish()
    const safe = (work: () => void) => {
      try { work() } catch { finish() }
    }
    const available = () => !done && document.visibilityState === "visible" && screenKey(owner) === key
    const whenIdle = (work: () => void) => {
      idle = owner.requestIdleCallback(deadline => safe(() => {
        if (!available() || deadline.didTimeout || deadline.timeRemaining() < 8) return finish()
        work()
      }))
    }
    const measure = (next: (intervals: number[]) => void) => {
      const times: number[] = []
      const tick = (time: number) => safe(() => {
        if (!available()) return finish()
        times.push(time)
        if (times.length === 3) return next([times[1]! - times[0]!, times[2]! - times[1]!])
        // Repaint the same tiny patterned backdrop in both phases, so the browser
        // cannot reuse a static filtered surface. No layout reads or GPU readback.
        sample!.style.backgroundPosition = `${times.length % 2}px 0px`
        frame = owner.requestAnimationFrame(tick)
      })
      frame = owner.requestAnimationFrame(tick)
    }
    const probe = () => {
      try {
        const cached = owner.localStorage.getItem(cachePrefix + key)
        if (isQuality(cached)) return finish(cached)
      } catch { /* private mode or storage policy; still deduplicate in memory */ }
      const css = (owner as Window & { CSS?: typeof CSS }).CSS
      if (!css?.supports("backdrop-filter", "blur(1px)") && !css?.supports("-webkit-backdrop-filter", "blur(1px)")) return finish()
      sample = document.createElement("div")
      sample.setAttribute("aria-hidden", "true")
      sample.dataset.pbProbe = ""
      // 32x32 device pixels, even on high-DPI screens. It must be on screen,
      // visible and unoccluded: opacity:0/offscreen/display:none can skip filtering.
      const dpr = Math.max(1, owner.devicePixelRatio || 1)
      sample.style.cssText = `position:fixed;right:0;bottom:0;width:${32 / dpr}px;height:${32 / dpr}px;z-index:2147483647;pointer-events:none;overflow:hidden;background:repeating-linear-gradient(90deg,#888 0px,#888 1px,#999 1px,#999 2px)`
      document.body.append(sample)
      owner.clearTimeout(watchdog)
      watchdog = owner.setTimeout(cancel, 250)
      measure(baseline => whenIdle(() => {
        for (const layer of planBlur(BlurProfile.edge("bottom", 32 / dpr), { radius: 6 })) {
          const element = document.createElement("div")
          element.style.cssText = `position:absolute;inset:0;backdrop-filter:blur(${layer.blur / dpr}px);-webkit-backdrop-filter:blur(${layer.blur / dpr}px);mask-image:${layer.mask};-webkit-mask-image:${layer.mask}`
          sample!.append(element)
        }
        measure(filtered => finish(qualityFromFrames(baseline, filtered), true))
      }))
    }
    const loaded = () => safe(() => {
      frame = owner.requestAnimationFrame(() => {
        // The preceding frame has painted before this second callback.
        frame = owner.requestAnimationFrame(() => {
          quiet = owner.setTimeout(() => safe(() => whenIdle(probe)), 1000)
        })
      })
    })
    for (const event of inputEvents) owner.addEventListener(event, cancel, { capture: true, passive: true })
    document.addEventListener("visibilitychange", cancel)
    owner.addEventListener("pagehide", cancel)
    owner.addEventListener("resize", cancel)
    // This timer only gives up; it never forces probe work onto a busy browser.
    watchdog = owner.setTimeout(cancel, 5000)
    if (document.readyState === "complete") loaded()
    else owner.addEventListener("load", loaded, { once: true })
  }).catch(() => "full" as const)
  screens.set(key, pending)
  return pending
}
