/* SPDX-License-Identifier: MIT */

import type { ResidentRegionIR } from "@mun/core/internal/execution"
import { resolveResidentComputeExperimental, type ResidentComputeExperimentalOptions, type ResidentComputeExperimentalState } from "@mun/execution"
import type { GPUIslandIR } from "./gpu-island-ir.js"
import {
  planResidentRegionFusion,
  type ResidentFusionBoundary,
  type ResidentFusionPlan,
} from "./resident-fusion.js"
import {
  analyzeResidentWasmRegion,
  type CompiledResidentWasmProgram,
} from "./resident-wasm.js"

export type ResidentPlannedBackend = "packed-js" | "wasm-simd" | "shared-worker-wasm" | "webgpu" | "renderer-fallback"
export type ResidentPlannedBackendStatus = "ready" | "measurement-required" | "blocked"

export interface ResidentBackendChoice {
  readonly backend: ResidentPlannedBackend
  readonly status: ResidentPlannedBackendStatus
  readonly reason: string
}

export interface ResidentPlannerCapabilities {
  readonly wasm: boolean
  readonly simd: boolean
  readonly worker: boolean
  readonly sharedMemory: boolean
  readonly crossOriginIsolated: boolean
  readonly webgpu: boolean
}

export interface ResidentFrameBudgetSignal {
  readonly pressure: number
  readonly level: "idle" | "comfortable" | "pressured" | "critical"
}

export interface ResidentRegionChainRequest {
  readonly regions: readonly ResidentRegionIR[]
  readonly boundaries: readonly ResidentFusionBoundary[]
  readonly computeCostSaved: number
  readonly minimumBenefit?: number
  readonly capabilities: ResidentPlannerCapabilities
  readonly frameBudget?: ResidentFrameBudgetSignal
  /** Experimental native backends are opt-in and default to disabled. */
  readonly experimentalResidentCompute?: boolean | ResidentComputeExperimentalOptions | ResidentComputeExperimentalState
}

export interface ResidentRegionChainPlan {
  readonly version: 1
  readonly fusion: ResidentFusionPlan
  readonly region: ResidentRegionIR | null
  readonly wasmProgram: CompiledResidentWasmProgram | null
  readonly backends: readonly ResidentBackendChoice[]
  readonly selectionRule: "predict-then-calibrate-against-packed-js"
}

function choice(
  backend: ResidentPlannedBackend,
  status: ResidentPlannedBackendStatus,
  reason: string,
): ResidentBackendChoice {
  return Object.freeze({ backend, status, reason })
}

/**
 * Plan a producer-to-consumer packed chain. This static pass may prove a
 * backend legal and exports compiler-known cost metadata. The runtime predicts
 * clear JS/SIMD cases from active dirty work, while crossover cases are still
 * measured against packed JavaScript before a learned preference is trusted.
 */
export function planResidentRegionChain(request: ResidentRegionChainRequest): ResidentRegionChainPlan {
  const experimental = resolveResidentComputeExperimental(request.experimentalResidentCompute)
  const fusion = planResidentRegionFusion({
    regions: request.regions,
    boundaries: request.boundaries,
    computeCostSaved: request.computeCostSaved,
    minimumBenefit: request.minimumBenefit,
  })
  if (!fusion.eligible) {
    const reason = fusion.rejections.map(rejection => rejection.code).join(", ") || "fusion-rejected"
    return Object.freeze({
      version: 1,
      fusion,
      region: null,
      wasmProgram: null,
      backends: Object.freeze([
        choice("packed-js", "ready", "execute the unfused proven packed regions with the mandatory JavaScript baseline"),
        choice("wasm-simd", "blocked", `native fusion is not legal: ${reason}`),
        choice("shared-worker-wasm", "blocked", `worker execution cannot cross a rejected resident boundary: ${reason}`),
        choice("webgpu", "blocked", "a CPU packed chain has no GPU-renderer sink; readback into CPU/DOM is forbidden"),
      ]),
      selectionRule: "predict-then-calibrate-against-packed-js",
    })
  }

  const wasm = analyzeResidentWasmRegion(fusion.fusedRegion)
  const wasmAvailable = experimental.wasm && request.capabilities.wasm && request.capabilities.simd && wasm.eligible
  const wasmReason = !experimental.wasm
    ? "experimental Resident Compute WASM is disabled"
    : !request.capabilities.wasm
      ? "WebAssembly is unavailable"
    : !request.capabilities.simd
      ? "SIMD is unavailable; packed JavaScript remains the baseline until the scalar fallback is measured separately"
      : !wasm.eligible
        ? `the fused region is not representable by the resident WASM ABI: ${wasm.reasons.join(", ")}`
        : "legal for adaptive runtime prediction; uncertain crossover work is calibrated against packed JS"
  const pressured = request.frameBudget?.level === "pressured"
    || request.frameBudget?.level === "critical"
    || (request.frameBudget?.pressure ?? 0) >= 0.75
  const workerAvailable = experimental.worker && wasmAvailable
    && request.capabilities.worker
    && request.capabilities.sharedMemory
    && request.capabilities.crossOriginIsolated
    && pressured
  const workerReason = !wasmAvailable
    ? !experimental.worker ? "experimental Resident Compute Worker is disabled" : "the shared Worker requires an eligible resident WASM program"
    : !request.capabilities.worker
      ? "Worker execution is unavailable"
      : !request.capabilities.sharedMemory || !request.capabilities.crossOriginIsolated
        ? "shared authoritative memory requires SharedArrayBuffer and cross-origin isolation"
        : !pressured
          ? "worker promotion requires measured main-thread frame pressure"
          : "legal only after shared-worker wall/main-thread measurements beat local execution"

  return Object.freeze({
    version: 1,
    fusion,
    region: fusion.fusedRegion,
    wasmProgram: wasm.eligible ? wasm.program : null,
    backends: Object.freeze([
      choice("packed-js", "ready", "mandatory correctness, fallback, and promotion baseline"),
      choice("wasm-simd", wasmAvailable ? "measurement-required" : "blocked", wasmReason),
      choice("shared-worker-wasm", workerAvailable ? "measurement-required" : "blocked", workerReason),
      choice("webgpu", "blocked", "packed CPU output is not a GPU Island and would require readback or renderer materialization"),
    ]),
    selectionRule: "predict-then-calibrate-against-packed-js",
  })
}

export interface GPUIslandBackendPlan {
  readonly version: 1
  readonly island: GPUIslandIR
  readonly backends: readonly ResidentBackendChoice[]
  readonly readbackBytes: 0
}

/** WebGPU is legal only for a compiler-proven GPU-to-GPU renderer island. */
export function planGPUIslandBackend(
  island: GPUIslandIR,
  capabilities: Pick<ResidentPlannerCapabilities, "webgpu">,
  experimentalResidentCompute?: boolean | ResidentComputeExperimentalOptions | ResidentComputeExperimentalState,
): GPUIslandBackendPlan {
  if (island.inputResidency !== "gpu" || island.outputResidency !== "gpu"
    || island.readback !== "forbidden" || island.render.target !== "gpu-canvas") {
    throw new TypeError("GPU Island planning requires gpu -> gpu residency, forbidden readback, and a GPUCanvas sink")
  }
  const experimental = resolveResidentComputeExperimental(experimentalResidentCompute)
  return Object.freeze({
    version: 1,
    island,
    backends: Object.freeze([
      choice("webgpu", experimental.gpu && capabilities.webgpu ? "ready" : "blocked", !experimental.gpu
        ? "experimental Resident Compute GPU Islands are disabled"
        : capabilities.webgpu
        ? "compute and render share GPU-authoritative buffers with no readback"
        : "WebGPU is unavailable"),
      choice("renderer-fallback", "ready", `renderer owns the ${island.fallback} fallback and framework lifecycle`),
    ]),
    readbackBytes: 0,
  })
}
