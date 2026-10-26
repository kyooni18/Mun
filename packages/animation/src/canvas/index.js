import { FrameBatcher } from '../render/frame-batcher.js';
import { getRenderingQuality } from '../rendering-quality/index.js';

function isMotionValue(value) {
  return value && typeof value.get === 'function' && (typeof value.subscribeValue === 'function' || typeof value.subscribe === 'function');
}

/**
 * Coalesces any number of MotionValue changes into one Canvas draw per frame.
 * The Float64Array passed to draw() is retained and reused for the lifetime of
 * the renderer.
 */
export class CanvasMotionRenderer {
  constructor(context, values, draw, {
    autoClear = false,
    requestFrame,
    cancelFrame,
    renderInitial = true,
  } = {}) {
    if (!context || typeof draw !== 'function') throw new TypeError('CanvasMotionRenderer requires a context and draw callback.');
    if (!Array.isArray(values)) throw new TypeError('CanvasMotionRenderer values must be an array.');
    this.context = context;
    this.values = values;
    this.draw = draw;
    this.autoClear = autoClear;
    this.snapshot = new Float64Array(values.length);
    this.unsubscribers = [];
    this.frames = 0;
    this.disposed = false;
    this.owner = context.canvas?.ownerDocument?.defaultView;
    this.quality = 'full';
    this.lastDraw = -Infinity;
    this.timer = 0;
    this.batcher = new FrameBatcher((time) => this.#render(time), {
      requestFrame: requestFrame ?? this.owner?.requestAnimationFrame?.bind(this.owner),
      cancelFrame: cancelFrame ?? this.owner?.cancelAnimationFrame?.bind(this.owner),
    });
    this.stopQuality = getRenderingQuality(this.owner ?? null)?.subscribe(snapshot => {
      if (this.quality === snapshot.quality) return;
      this.quality = snapshot.quality;
      this.owner.clearTimeout(this.timer);
      this.timer = 0;
      this.invalidate();
    });

    values.forEach((value, index) => {
      if (!isMotionValue(value)) throw new TypeError(`Canvas motion value at index ${index} is not MotionValue-like.`);
      this.snapshot[index] = Number(value.get()) || 0;
      const subscribe = value.subscribeValue ?? value.subscribe;
      this.unsubscribers.push(subscribe.call(value, (next) => {
        this.snapshot[index] = Number(next) || 0;
        this.invalidate();
      }, { emitCurrent: false }));
    });
    if (renderInitial) this.invalidate();
  }

  #render(time) {
    if (this.disposed || this.quality === 'none') return;
    const remaining = this.lastDraw + 1000 / 30 - time;
    if (this.quality === 'reduced' && remaining > 0.5) {
      if (!this.timer) this.timer = this.owner.setTimeout(() => {
        this.timer = 0;
        this.batcher.invalidate();
      }, remaining);
      return;
    }
    this.lastDraw = time;
    if (this.autoClear) {
      const canvas = this.context.canvas;
      if (canvas && typeof this.context.clearRect === 'function') this.context.clearRect(0, 0, canvas.width, canvas.height);
    }
    this.frames += 1;
    this.draw(this.context, this.snapshot, time, this);
  }

  invalidate() { if (this.quality !== 'none' && !this.timer) this.batcher.invalidate(); return this; }
  renderNow(time) { this.batcher.flushNow(time); return this; }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopQuality?.();
    this.owner?.clearTimeout(this.timer);
    this.batcher.dispose();
    for (const unsubscribe of this.unsubscribers) unsubscribe?.();
    this.unsubscribers.length = 0;
  }
}

export function createCanvasRenderer(context, values, draw, options) {
  return new CanvasMotionRenderer(context, values, draw, options);
}
