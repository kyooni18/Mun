export type RenderingQuality = 'full' | 'reduced' | 'none';

export interface RenderingQualitySnapshot {
  readonly quality: RenderingQuality;
  readonly source: 'default' | 'cache' | 'probe' | 'pressure';
  readonly baselineMs: number | null;
  readonly frameDelayMs: number | null;
  /** Queue completion latency, including browser scheduling; not GPU utilization. */
  readonly gpuQueueDelayMs: number | null;
  readonly longFrameMs: number | null;
  readonly measuredAt: number | null;
}

export interface RenderingQualityController {
  readonly quality: RenderingQuality;
  readonly snapshot: RenderingQualitySnapshot;
  prepare(): Promise<RenderingQuality>;
  subscribe(listener: (snapshot: RenderingQualitySnapshot) => void): () => void;
  recordFrame(durationMs: number): void;
  sampleGPUQueue(queue: object): void;
  setDebug(enabled: boolean): void;
}

export function getRenderingQuality(owner?: Window | null): RenderingQualityController | null;
export function prepareRenderingQuality(owner?: Window | null): Promise<RenderingQuality>;
export function observeRenderingQuality(listener: (snapshot: RenderingQualitySnapshot) => void, owner?: Window | null): () => void;
export function setRenderingQualityDebug(enabled: boolean, owner?: Window | null): void;
export function qualityFromFrames(baseline: readonly number[], filtered: readonly number[]): RenderingQuality;
