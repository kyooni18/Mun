/* SPDX-License-Identifier: MIT */

import type { GPUIslandGraphIR, GPUIslandViewOptions } from "@mun/core/internal/runtime"
import { gpuIslandView } from "@mun/core/internal/runtime"
import type { ModifiableViewNode } from "@mun/core/compat"

export type GPUIslandFallback = "canvas" | "static"
export type GPUBufferUsageIR = "storage" | "vertex" | "uniform" | "copy-dst"

export interface GPUIslandBufferIR {
  readonly name: string
  readonly byteLength: number
  readonly stride: number
  readonly usages: readonly GPUBufferUsageIR[]
  readonly authority: "gpu"
  readonly cpuReadable: false
}

export interface GPUIslandComputePassIR {
  readonly entryPoint: string
  readonly workgroupSize: number
  readonly dispatchCount: number
  readonly reads: readonly string[]
  readonly writes: readonly string[]
}

export interface GPUIslandRenderPassIR {
  readonly vertexEntryPoint: string
  readonly fragmentEntryPoint: string
  readonly topology: "point-list" | "line-list" | "line-strip" | "triangle-list"
  readonly vertexCount: number
  readonly reads: readonly string[]
  readonly target: "gpu-canvas"
}

/**
 * Compiler-owned proof envelope for a compute-to-render GPU island. The
 * renderer owns device/canvas materialization; this IR only records the
 * residency and pass relationship that makes a native backend legal.
 */
export interface GPUIslandIR extends GPUIslandGraphIR {
  readonly version: 1
  readonly id: string
  readonly kind: "particle-field" | "line-chart"
  readonly typeProof: "numeric-packed"
  readonly inputResidency: "gpu"
  readonly outputResidency: "gpu"
  readonly readback: "forbidden"
  readonly materialization: "renderer-owned"
  readonly lifetime: "frame-persistent"
  readonly buffers: readonly GPUIslandBufferIR[]
  readonly compute: GPUIslandComputePassIR
  readonly render: GPUIslandRenderPassIR
  readonly fallback: GPUIslandFallback
  readonly estimatedOpsPerFrame: number
  readonly estimatedUploadBytesPerFrame: number
}

export interface ParticleFieldGPUIslandInput {
  readonly id: string
  readonly count: number
  /** Interleaved position, velocity, and color bytes for one particle. */
  readonly particleStride?: number
  readonly workgroupSize?: number
  readonly fallback?: GPUIslandFallback
  readonly computeEntryPoint?: string
  readonly vertexEntryPoint?: string
  readonly fragmentEntryPoint?: string
}

export interface LineChartGPUIslandInput {
  readonly id: string
  readonly count: number
  readonly workgroupSize?: number
  readonly fallback?: GPUIslandFallback
  readonly computeEntryPoint?: string
  readonly vertexEntryPoint?: string
  readonly fragmentEntryPoint?: string
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer`)
  return value
}

function entryPoint(value: string | undefined, fallback: string, label: string): string {
  const name = value ?? fallback
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new TypeError(`${label} must be a WGSL identifier`)
  return name
}

/**
 * Form the first strict GPU Island proof target. No CPU-readable or copy-source
 * usage exists in the IR: compute writes the same authoritative buffer that
 * the render pass consumes and only a small uniform is uploaded per frame.
 */
export function defineParticleFieldGPUIslandIR(input: ParticleFieldGPUIslandInput): GPUIslandIR {
  const id = input.id.trim()
  if (!id) throw new TypeError("GPU Island requires a non-empty id")
  const count = positiveSafeInteger(input.count, "GPU Island particle count")
  const stride = positiveSafeInteger(input.particleStride ?? 32, "GPU Island particle stride")
  if (stride % 4 !== 0) throw new RangeError("GPU Island particle stride must be four-byte aligned")
  const byteLength = count * stride
  if (!Number.isSafeInteger(byteLength)) throw new RangeError("GPU Island particle storage exceeds the safe integer range")
  const workgroupSize = positiveSafeInteger(input.workgroupSize ?? 64, "GPU Island workgroup size")
  if (workgroupSize > 256) throw new RangeError("GPU Island workgroup size exceeds the portable WebGPU limit")
  if (workgroupSize !== 64) throw new RangeError("ParticleField GPU Islands currently require the fixed 64-thread runtime workgroup")
  const dispatchCount = Math.ceil(count / workgroupSize)
  const estimatedOpsPerFrame = count * 12
  if (!Number.isSafeInteger(estimatedOpsPerFrame)) throw new RangeError("GPU Island operation estimate exceeds the safe integer range")

  const particleBuffer: GPUIslandBufferIR = Object.freeze({
    name: "particles",
    byteLength,
    stride,
    usages: Object.freeze(["storage", "vertex", "copy-dst"] as const),
    authority: "gpu",
    cpuReadable: false,
  })
  const frameBuffer: GPUIslandBufferIR = Object.freeze({
    name: "frame",
    byteLength: 16,
    stride: 16,
    usages: Object.freeze(["uniform", "copy-dst"] as const),
    authority: "gpu",
    cpuReadable: false,
  })
  return Object.freeze({
    version: 1,
    id,
    kind: "particle-field",
    typeProof: "numeric-packed",
    inputResidency: "gpu",
    outputResidency: "gpu",
    readback: "forbidden",
    materialization: "renderer-owned",
    lifetime: "frame-persistent",
    buffers: Object.freeze([particleBuffer, frameBuffer]),
    compute: Object.freeze({
      entryPoint: entryPoint(input.computeEntryPoint, "computeParticles", "GPU Island compute entry point"),
      workgroupSize,
      dispatchCount,
      reads: Object.freeze(["particles", "frame"]),
      writes: Object.freeze(["particles"]),
    }),
    render: Object.freeze({
      vertexEntryPoint: entryPoint(input.vertexEntryPoint, "renderParticle", "GPU Island vertex entry point"),
      fragmentEntryPoint: entryPoint(input.fragmentEntryPoint, "shadeParticle", "GPU Island fragment entry point"),
      topology: "point-list",
      vertexCount: count,
      reads: Object.freeze(["particles"]),
      target: "gpu-canvas",
    }),
    fallback: input.fallback ?? "canvas",
    estimatedOpsPerFrame,
    estimatedUploadBytesPerFrame: 16,
  })
}

/**
 * A second compute-to-render proof target representing a large continuously
 * transformed chart. Each point stores immutable source x/y plus GPU-computed
 * clip-space x/y. Only a 16-byte frame uniform crosses the CPU/GPU boundary.
 */
export function defineLineChartGPUIslandIR(input: LineChartGPUIslandInput): GPUIslandIR {
  const id = input.id.trim()
  if (!id) throw new TypeError("GPU Island requires a non-empty id")
  const count = positiveSafeInteger(input.count, "GPU Island chart point count")
  if (count < 2) throw new RangeError("LineChart GPU Islands require at least two points")
  const stride = 16
  const byteLength = count * stride
  if (!Number.isSafeInteger(byteLength)) throw new RangeError("GPU Island chart storage exceeds the safe integer range")
  const workgroupSize = positiveSafeInteger(input.workgroupSize ?? 64, "GPU Island workgroup size")
  if (workgroupSize !== 64) throw new RangeError("LineChart GPU Islands currently require the fixed 64-thread runtime workgroup")
  const points: GPUIslandBufferIR = Object.freeze({
    name: "points",
    byteLength,
    stride,
    usages: Object.freeze(["storage", "vertex", "copy-dst"] as const),
    authority: "gpu",
    cpuReadable: false,
  })
  const frame: GPUIslandBufferIR = Object.freeze({
    name: "frame",
    byteLength: 16,
    stride: 16,
    usages: Object.freeze(["uniform", "copy-dst"] as const),
    authority: "gpu",
    cpuReadable: false,
  })
  return Object.freeze({
    version: 1,
    id,
    kind: "line-chart",
    typeProof: "numeric-packed",
    inputResidency: "gpu",
    outputResidency: "gpu",
    readback: "forbidden",
    materialization: "renderer-owned",
    lifetime: "frame-persistent",
    buffers: Object.freeze([points, frame]),
    compute: Object.freeze({
      entryPoint: entryPoint(input.computeEntryPoint, "computeChartPoints", "GPU Island compute entry point"),
      workgroupSize,
      dispatchCount: Math.ceil(count / workgroupSize),
      reads: Object.freeze(["points", "frame"]),
      writes: Object.freeze(["points"]),
    }),
    render: Object.freeze({
      vertexEntryPoint: entryPoint(input.vertexEntryPoint, "renderChartPoint", "GPU Island vertex entry point"),
      fragmentEntryPoint: entryPoint(input.fragmentEntryPoint, "shadeChartLine", "GPU Island fragment entry point"),
      topology: "line-strip",
      vertexCount: count,
      reads: Object.freeze(["points"]),
      target: "gpu-canvas",
    }),
    fallback: input.fallback ?? "canvas",
    estimatedOpsPerFrame: count * 7,
    estimatedUploadBytesPerFrame: 16,
  })
}

/** Form compiler proof and the internal renderer boundary in one operation. */
export function compileParticleFieldGPUIsland(
  input: ParticleFieldGPUIslandInput,
  options: GPUIslandViewOptions = {},
): ModifiableViewNode {
  return gpuIslandView(defineParticleFieldGPUIslandIR(input), options)
}

export function compileLineChartGPUIsland(
  input: LineChartGPUIslandInput,
  options: GPUIslandViewOptions = {},
): ModifiableViewNode {
  return gpuIslandView(defineLineChartGPUIslandIR(input), options)
}
