/* SPDX-License-Identifier: MIT */

import { cacheRenderingQuality, probeRenderingQuality, screenKey } from './probe.js';
export { qualityFromFrames } from './probe.js';

const controllers = new WeakMap();
const levels = ['full', 'reduced', 'none'];
const intervalMs = 30_000;
const defaultOwner = () => typeof window === 'undefined' ? null : window;

/** One owner per Window; subscriptions own all timers and observers. */
class RenderingQualityController {
  constructor(owner) {
    this.owner = owner;
    this.listeners = new Set();
    this.queues = new WeakMap();
    this.snapshot = Object.freeze({ quality: 'full', source: 'default', baselineMs: null, frameDelayMs: null, gpuQueueDelayMs: null, longFrameMs: null, measuredAt: null });
    this.timer = 0;
    this.running = null;
    this.ready = null;
    this.resolveReady = null;
    this.started = false;
    this.initialized = false;
    this.healthy = 0;
    this.pressureWindows = new Map();
    this.pressureTimes = new Map();
    this.lastPressure = -Infinity;
    this.lastChange = -Infinity;
    this.frameWindow = 0;
    this.frameSamples = 0;
    this.delayedFrames = 0;
    this.epoch = 0;
    this.key = screenKey(owner);
    this.onVisibility = () => {
      this.pause();
      this.resolveReady?.(this.quality);
      this.resolveReady = null;
      this.initialized = true;
      if (!this.listeners.size) this.stop();
      else if (owner.document.visibilityState === 'visible') this.schedule();
    };
    this.onResize = () => {
      if (screenKey(owner) === this.key) return;
      this.pause();
      this.resolveReady?.('full');
      this.resolveReady = null;
      this.ready = null;
      this.key = screenKey(owner);
      this.initialized = false;
      this.healthy = 0;
      this.lastPressure = this.lastChange = -Infinity;
      this.update({ quality: 'full', source: 'default', baselineMs: null, frameDelayMs: null, gpuQueueDelayMs: null, longFrameMs: null, measuredAt: null });
      if (this.started) this.prepare();
    };
  }

  get quality() { return this.snapshot.quality; }

  subscribe(listener) {
    const subscription = snapshot => listener(snapshot);
    this.listeners.add(subscription);
    this.emit(subscription);
    this.start();
    if (!this.ready) this.prepare();
    return () => {
      this.listeners.delete(subscription);
      if (!this.listeners.size) {
        this.resolveReady?.(this.quality);
        this.resolveReady = null;
        this.stop();
      }
    };
  }

  prepare() {
    if (screenKey(this.owner) !== this.key) this.onResize();
    if (this.ready) return this.ready;
    this.ready = new Promise(resolve => { this.resolveReady = resolve; });
    this.start();
    void this.check(true);
    return this.ready;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.owner.document.addEventListener('visibilitychange', this.onVisibility);
    this.owner.addEventListener('resize', this.onResize);
    const Observer = this.owner.PerformanceObserver;
    try {
      const type = Observer?.supportedEntryTypes?.includes('long-animation-frame') ? 'long-animation-frame'
        : Observer?.supportedEntryTypes?.includes('longtask') ? 'longtask' : null;
      if (type) {
        this.observer = new Observer(list => {
          if (this.owner.document.visibilityState !== 'visible') return;
          for (const entry of list.getEntries()) {
            this.update({ longFrameMs: entry.duration });
            if (entry.duration >= 50) this.pressure('long-frame');
          }
        });
        this.observer.observe({ type });
      }
    } catch { /* observers are optional */ }
    if (this.ready && !this.resolveReady) this.schedule();
  }

  pause() {
    this.epoch++;
    this.owner.clearTimeout(this.timer);
    this.timer = 0;
    this.running?.abort();
    this.running = null;
    this.frameSamples = this.delayedFrames = this.healthy = 0;
    this.pressureWindows.clear();
    this.pressureTimes.clear();
    this.frameWindow = this.owner.performance.now();
  }

  stop() {
    this.pause();
    this.started = false;
    this.observer?.disconnect();
    this.observer = null;
    this.owner.document.removeEventListener('visibilitychange', this.onVisibility);
    this.owner.removeEventListener('resize', this.onResize);
  }

  schedule() {
    this.owner.clearTimeout(this.timer);
    if (!this.started || !this.listeners.size || this.owner.document.visibilityState !== 'visible') return;
    this.timer = this.owner.setTimeout(() => { this.timer = 0; void this.check(false); }, intervalMs);
  }

  async check(initial) {
    if (this.running || !this.started) return;
    const abort = new AbortController();
    this.running = abort;
    const result = await probeRenderingQuality(this.owner, { cached: initial, signal: abort.signal });
    if (this.running !== abort) return;
    this.running = null;
    const now = this.owner.performance.now();
    if (result.quality) {
      const current = levels.indexOf(this.quality), target = levels.indexOf(result.quality);
      let quality = this.quality;
      if (!this.initialized || target > current) {
        quality = result.quality;
        this.healthy = 0;
      } else if (target < current && now - this.lastPressure >= intervalMs) {
        if (++this.healthy >= 2) { quality = levels[current - 1]; this.healthy = 0; }
      } else this.healthy = 0;
      if (quality !== this.quality) this.lastChange = now;
      this.update({ quality, source: result.source, measuredAt: now, ...(result.baselineMs ? { baselineMs: result.baselineMs } : {}) });
      if (result.source !== 'cache') cacheRenderingQuality(this.owner, this.key, quality);
    } else this.healthy = 0; // Unknown samples never restore quality during runtime.
    this.initialized = true;
    this.resolveReady?.(this.quality);
    this.resolveReady = null;
    if (!this.listeners.size) this.stop();
    else this.schedule();
  }

  update(values) {
    this.snapshot = Object.freeze({ ...this.snapshot, ...values });
    for (const listener of this.listeners) this.emit(listener);
  }

  emit(listener) {
    try { listener(this.snapshot); } catch { /* isolate renderer callbacks */ }
  }

  pressure(source) {
    if (!this.initialized || !this.started || this.running || this.owner.document.visibilityState !== 'visible') return;
    const now = this.owner.performance.now();
    const previous = this.pressureTimes.get(source) ?? -Infinity;
    if (now - previous < 1000) return;
    this.pressureTimes.set(source, now);
    this.lastPressure = now;
    this.healthy = 0;
    const count = now - previous > 2500 ? 1 : (this.pressureWindows.get(source) ?? 0) + 1;
    this.pressureWindows.set(source, count);
    if (count < 3 || now - this.lastChange < 10_000) return;
    this.pressureWindows.clear();
    const quality = levels[Math.min(2, levels.indexOf(this.quality) + 1)];
    if (quality === this.quality) return;
    this.lastChange = now;
    this.update({ quality, source: 'pressure' });
    cacheRenderingQuality(this.owner, this.key, quality);
  }

  /** Piggyback on renderer-owned animation callbacks; never create a monitoring RAF. */
  recordFrame(durationMs) {
    if (!this.started || this.running || durationMs < 4 || durationMs > 250 || !Number.isFinite(durationMs)) return;
    const now = this.owner.performance.now();
    this.frameSamples++;
    if (durationMs >= Math.max(24, (this.snapshot.baselineMs ?? 16.67) * 1.5)) this.delayedFrames++;
    if (now - this.frameWindow < 1000) return;
    this.update({ frameDelayMs: durationMs });
    if (this.frameSamples >= 10 && this.delayedFrames / this.frameSamples >= 0.25) this.pressure('frame');
    else this.pressureWindows.delete('frame');
    this.frameWindow = now;
    this.frameSamples = this.delayedFrames = 0;
  }

  /** Queue completion latency includes scheduling delay; it is not GPU utilization. */
  sampleGPUQueue(queue) {
    if (!this.started || this.running || this.owner.document.visibilityState !== 'visible' || typeof queue?.onSubmittedWorkDone !== 'function') return;
    const now = this.owner.performance.now();
    const previous = this.queues.get(queue);
    if (previous?.pending) {
      if (now - previous.at >= Math.max(32, (this.snapshot.baselineMs ?? 16.67) * 2)) this.pressure('queue');
      return;
    }
    if (previous && now - previous.at < 1000) return;
    const entry = { pending: true, at: now };
    this.queues.set(queue, entry);
    const epoch = this.epoch;
    try {
      Promise.resolve(queue.onSubmittedWorkDone()).then(() => {
        entry.pending = false;
        if (!this.started || epoch !== this.epoch || this.running || this.owner.document.visibilityState !== 'visible') return;
        const duration = this.owner.performance.now() - now;
        this.update({ gpuQueueDelayMs: duration });
        if (duration >= Math.max(32, (this.snapshot.baselineMs ?? 16.67) * 2)) this.pressure('queue');
        else this.pressureWindows.delete('queue');
      }, () => { entry.pending = false; });
    } catch { entry.pending = false; }
  }
}

export function getRenderingQuality(owner = defaultOwner()) {
  if (!owner) return null;
  try {
    let controller = controllers.get(owner);
    if (!controller) { controller = new RenderingQualityController(owner); controllers.set(owner, controller); }
    return controller;
  } catch { return null; }
}

export function prepareRenderingQuality(owner = defaultOwner()) {
  return getRenderingQuality(owner)?.prepare() ?? Promise.resolve('full');
}

export function observeRenderingQuality(listener, owner = defaultOwner()) {
  const controller = getRenderingQuality(owner);
  if (controller) return controller.subscribe(listener);
  listener(Object.freeze({ quality: 'full', source: 'default', baselineMs: null, frameDelayMs: null, gpuQueueDelayMs: null, longFrameMs: null, measuredAt: null }));
  return () => {};
}
