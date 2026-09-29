import * as ts from "typescript"
import type { ResidentRegionIR } from "@mun/core/internal/execution"
import {
  analyzeMunMapperFunction,
  analyzeMunScalarFunction,
  type MunScalarEffectFacts,
  unwrapCompilerExpression,
} from "./effect-analysis.js"
import {
  lowerMunMapKernel,
  lowerMunScalarKernel,
  type MunKernelIR,
} from "./kernel-ir.js"

export type MunExecutionBackend = "js" | "packed-js" | "wasm" | "worker-wasm" | "webgpu"
export type MunExecutionBackendStatus = "ready" | "candidate" | "blocked"
export type MunExecutionRegionKind = "state-array-map" | "collection-row"
export type MunExecutionSink = "state" | "dom"
export type MunExecutionResidency = "js-object" | "cpu-state" | "dom-patch"

export interface MunExecutionBackendPlan {
  readonly backend: MunExecutionBackend
  readonly status: MunExecutionBackendStatus
  readonly reason?: string
}

export interface MunExecutionEffectSummary {
  readonly pure: boolean
  readonly itemDependent: boolean
  readonly indexDependent: boolean
  readonly captures: readonly string[]
  readonly maxItemAccessDepth: number
  readonly dynamicItemElementAccess: boolean
  readonly allocatesObject: boolean
}

export interface MunExecutionResidencyPlan {
  readonly input: MunExecutionResidency
  readonly output: MunExecutionResidency
  readonly gpuResident: boolean
  readonly webgpuReadbackRequired: boolean
}

export interface MunExecutionRegion {
  readonly id: string
  readonly kind: MunExecutionRegionKind
  readonly start: number
  readonly end: number
  readonly sink: MunExecutionSink
  readonly residency: MunExecutionResidencyPlan
  readonly effects: MunExecutionEffectSummary
  readonly kernels: readonly MunKernelIR[]
  /** Object-backed analysis regions are never Resident Compute regions. */
  readonly resident: ResidentRegionIR | null
  readonly backends: readonly MunExecutionBackendPlan[]
}

export interface MunExecutionPlanSummary {
  readonly regions: number
  readonly residentRegions: number
  readonly packedJsCandidates: number
  readonly wasmCandidates: number
  readonly workerCandidates: number
  readonly webgpuCandidates: number
  readonly gpuBlockedByCpuSink: number
}

export interface MunExecutionPlan {
  readonly version: 2
  readonly fileName: string
  readonly regions: readonly MunExecutionRegion[]
  readonly residentRegions: readonly ResidentRegionIR[]
  readonly summary: MunExecutionPlanSummary
}

interface MutableEffectSummary {
  pure: boolean
  itemDependent: boolean
  indexDependent: boolean
  captures: Set<string>
  maxItemAccessDepth: number
  dynamicItemElementAccess: boolean
  allocatesObject: boolean
}

function emptyEffects(): MutableEffectSummary {
  return {
    pure: true,
    itemDependent: false,
    indexDependent: false,
    captures: new Set(),
    maxItemAccessDepth: 0,
    dynamicItemElementAccess: false,
    allocatesObject: false,
  }
}

function mergeFacts(target: MutableEffectSummary, facts: MunScalarEffectFacts, allocatesObject = false): void {
  target.pure = target.pure && facts.pure
  target.itemDependent ||= facts.itemDependent
  target.indexDependent ||= facts.indexDependent
  for (const capture of facts.captures) target.captures.add(capture)
  target.maxItemAccessDepth = Math.max(target.maxItemAccessDepth, facts.maxItemAccessDepth)
  target.dynamicItemElementAccess ||= facts.dynamicItemElementAccess
  target.allocatesObject ||= allocatesObject
}

function freezeEffects(value: MutableEffectSummary): MunExecutionEffectSummary {
  return Object.freeze({
    pure: value.pure,
    itemDependent: value.itemDependent,
    indexDependent: value.indexDependent,
    captures: Object.freeze([...value.captures].sort()),
    maxItemAccessDepth: value.maxItemAccessDepth,
    dynamicItemElementAccess: value.dynamicItemElementAccess,
    allocatesObject: value.allocatesObject,
  })
}

function cpuComputeBackends(
  effects: MunExecutionEffectSummary,
  sink: MunExecutionSink,
  kernelComplete: boolean,
): readonly MunExecutionBackendPlan[] {
  const analysisReason = !effects.pure
    ? "effect analysis cannot prove a portable compute region"
    : !kernelComplete
      ? "compute region is not fully representable in Kernel IR"
      : sink === "state"
        ? "object-backed State input and output require row packing and materialization"
        : "object rows and a DOM sink do not form a packed resident region"
  const gpuReason = sink === "state"
    ? "object-backed State output would require readback and row materialization"
    : "compiled collection output is consumed by DOM patches"
  return Object.freeze([
    Object.freeze({ backend: "js" as const, status: "ready" as const }),
    Object.freeze({ backend: "packed-js" as const, status: "blocked" as const, reason: analysisReason }),
    Object.freeze({ backend: "wasm" as const, status: "blocked" as const, reason: analysisReason }),
    Object.freeze({ backend: "worker-wasm" as const, status: "blocked" as const, reason: analysisReason }),
    Object.freeze({ backend: "webgpu" as const, status: "blocked" as const, reason: gpuReason }),
  ])
}

function cpuResidency(output: "cpu-state" | "dom-patch"): MunExecutionResidencyPlan {
  return Object.freeze({
    input: "js-object",
    output,
    gpuResident: false,
    webgpuReadbackRequired: true,
  })
}

function staticPropertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return object.properties.find((property): property is ts.PropertyAssignment =>
    ts.isPropertyAssignment(property) && staticPropertyName(property.name) === name)
}

function directCallName(call: ts.CallExpression): string | undefined {
  const callee = unwrapCompilerExpression(call.expression)
  if (ts.isIdentifier(callee)) return callee.text
  return undefined
}

function stateArrayMapRegion(call: ts.CallExpression, ordinal: number): MunExecutionRegion | undefined {
  if (directCallName(call) !== "mapStateArrayData" || call.arguments.length < 2) return undefined
  const mapper = analyzeMunMapperFunction(call.arguments[1])
  if (!mapper) return undefined
  const effects = emptyEffects()
  mergeFacts(effects, mapper, mapper.allocatesObject)
  const frozenEffects = freezeEffects(effects)
  const kernel = lowerMunMapKernel(call.arguments[1])
  const kernels = kernel ? Object.freeze<MunKernelIR[]>([kernel]) : Object.freeze<MunKernelIR[]>([])
  return Object.freeze({
    id: `region-${ordinal}`,
    kind: "state-array-map",
    start: call.getStart(),
    end: call.end,
    sink: "state",
    residency: cpuResidency("cpu-state"),
    effects: frozenEffects,
    kernels,
    resident: null,
    backends: cpuComputeBackends(frozenEffects, "state", kernels.length === 1),
  })
}

function collectionRowRegion(call: ts.CallExpression, ordinal: number): MunExecutionRegion | undefined {
  if (directCallName(call) !== "compiledCollectionContent" || call.arguments.length < 2) return undefined
  const descriptor = unwrapCompilerExpression(call.arguments[1])
  if (!ts.isObjectLiteralExpression(descriptor)) return undefined
  const kind = objectProperty(descriptor, "kind")?.initializer
  if (!kind || !ts.isStringLiteralLike(unwrapCompilerExpression(kind))
    || (unwrapCompilerExpression(kind) as ts.StringLiteralLike).text !== "flat-text-host") return undefined

  const effects = emptyEffects()
  const kernels: MunKernelIR[] = []
  let requiredKernels = 0
  const key = objectProperty(descriptor, "evaluateKey")?.initializer
  const props = objectProperty(descriptor, "evaluateProps")?.initializer
  const text = objectProperty(descriptor, "evaluateText")?.initializer
  const fallback = objectProperty(descriptor, "evaluate")?.initializer

  if (key) {
    requiredKernels += 1
    const facts = analyzeMunScalarFunction(key)
    if (facts) mergeFacts(effects, facts)
    else effects.pure = false
    const kernel = lowerMunScalarKernel(key)
    if (kernel) kernels.push(kernel)
  }
  if (props) {
    requiredKernels += 1
    const facts = analyzeMunMapperFunction(props)
    if (facts) mergeFacts(effects, facts, facts.allocatesObject)
    else effects.pure = false
    const kernel = lowerMunMapKernel(props)
    if (kernel) kernels.push(kernel)
  }
  if (text) {
    requiredKernels += 1
    const facts = analyzeMunScalarFunction(text)
    if (facts) mergeFacts(effects, facts)
    else effects.pure = false
    const kernel = lowerMunScalarKernel(text)
    if (kernel) kernels.push(kernel)
  }
  if (!props && !text && fallback) {
    requiredKernels += 1
    const facts = analyzeMunMapperFunction(fallback)
    if (facts) mergeFacts(effects, facts, facts.allocatesObject)
    else effects.pure = false
    const kernel = lowerMunMapKernel(fallback)
    if (kernel) kernels.push(kernel)
  }

  const frozenEffects = freezeEffects(effects)
  const frozenKernels = Object.freeze(kernels)
  return Object.freeze({
    id: `region-${ordinal}`,
    kind: "collection-row",
    start: call.getStart(),
    end: call.end,
    sink: "dom",
    residency: cpuResidency("dom-patch"),
    effects: frozenEffects,
    kernels: frozenKernels,
    resident: null,
    backends: cpuComputeBackends(frozenEffects, "dom", requiredKernels > 0 && frozenKernels.length === requiredKernels),
  })
}

/**
 * Build a stable post-specialization execution plan without changing emitted
 * code. The Vite plugin only invokes this when a consumer asks for plans, so
 * normal production compilation does not pay an extra parse/analysis pass.
 */
export function createMunExecutionPlan(source: string, fileName: string): MunExecutionPlan {
  if (!source.includes("mapStateArrayData") && !source.includes("compiledCollectionContent")) {
    return Object.freeze({
      version: 2,
      fileName,
      regions: Object.freeze([]),
      residentRegions: Object.freeze([]),
      summary: Object.freeze({ regions: 0, residentRegions: 0, packedJsCandidates: 0, wasmCandidates: 0, workerCandidates: 0, webgpuCandidates: 0, gpuBlockedByCpuSink: 0 }),
    })
  }
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const regions: MunExecutionRegion[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const region = stateArrayMapRegion(node, regions.length)
        ?? collectionRowRegion(node, regions.length)
      if (region) {
        regions.push(region)
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const backendCount = (backend: MunExecutionBackend, status: MunExecutionBackendStatus) =>
    regions.filter(region => region.backends.some(plan => plan.backend === backend && plan.status === status)).length
  const gpuBlockedByCpuSink = regions.filter(region => region.residency.webgpuReadbackRequired
    && region.backends.some(plan => plan.backend === "webgpu" && plan.status === "blocked")).length

  return Object.freeze({
    version: 2,
    fileName,
    regions: Object.freeze(regions),
    residentRegions: Object.freeze([]),
    summary: Object.freeze({
      regions: regions.length,
      residentRegions: 0,
      packedJsCandidates: backendCount("packed-js", "candidate"),
      wasmCandidates: backendCount("wasm", "candidate"),
      workerCandidates: backendCount("worker-wasm", "candidate"),
      webgpuCandidates: backendCount("webgpu", "candidate"),
      gpuBlockedByCpuSink,
    }),
  })
}
