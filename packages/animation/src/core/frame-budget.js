import { FrameBudgetGovernor as ExecutionFrameBudgetGovernor } from '@mun/execution';

// Backend threshold policy remains animation-owned. The sampling, EMA,
// pressure, and subscription signal are shared with other execution clients.
export class FrameBudgetGovernor extends ExecutionFrameBudgetGovernor {
  constructor({
    budgetMs = 8,
    alpha = 0.12,
    minWasmThreshold = 64,
    minWorkerThreshold = 512,
  } = {}) {
    super({ budgetMs, alpha });
    this.minWasmThreshold = Math.max(1, Math.floor(minWasmThreshold));
    this.minWorkerThreshold = Math.max(this.minWasmThreshold, Math.floor(minWorkerThreshold));
  }

  wasmThreshold(baseThreshold, activeCount) {
    const base = Math.max(1, Math.floor(baseThreshold));
    if (this.pressure < 0.75 || activeCount < this.minWasmThreshold) return base;
    const pressureScale = this.pressure >= 1.15 ? 0.35 : 0.6;
    return Math.max(this.minWasmThreshold, Math.min(base, Math.floor(base * pressureScale)));
  }

  workerThreshold(baseThreshold, activeCount) {
    const base = Math.max(1, Math.floor(baseThreshold));
    if (this.pressure < 1 || activeCount < this.minWorkerThreshold) return base;
    const pressureScale = this.pressure >= 1.35 ? 0.35 : 0.6;
    return Math.max(this.minWorkerThreshold, Math.min(base, Math.floor(base * pressureScale)));
  }
}
