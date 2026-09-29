/* SPDX-License-Identifier: MIT */

import type { KernelBinaryOperator, KernelExpression, ResidentRegionIR } from "@mun/core/internal/execution"
import { optimizeResidentKernelSequence } from "./resident-fusion.js"

export interface CompiledGPURegionBinding {
  readonly binding: number
  readonly kind: "column" | "frame" | "captures"
  readonly name: string
  readonly access: "read" | "read_write"
}

export interface CompiledGPURegionWGSL {
  readonly version: 1
  readonly regionId: string
  readonly entryPoint: "munResidentCompute"
  readonly workgroupSize: 64 | 128 | 256
  readonly code: string
  readonly fieldNames: readonly string[]
  readonly captureNames: readonly string[]
  readonly bindings: readonly CompiledGPURegionBinding[]
  readonly estimatedOpsPerItem: number
}

const supportedBinary = new Set<KernelBinaryOperator>([
  "+", "-", "*", "/", "%",
  "<", "<=", ">", ">=", "==", "===", "!=", "!==",
  "&&", "||",
])

function sameDenseF32Layout(region: ResidentRegionIR): boolean {
  const source = region.source.layout
  const sink = region.sink.layout
  return source.fields.length === sink.fields.length
    && source.length === sink.length
    && source.fields.every((field, index) => field.type === "f32"
      && sink.fields[index]?.type === "f32"
      && sink.fields[index]?.name === field.name)
}

function wgslExpression(
  expression: KernelExpression,
  fields: ReadonlyMap<string, number>,
  captures: ReadonlyMap<string, number>,
): string {
  if (expression.op === "const") return typeof expression.value === "boolean" ? (expression.value ? "1.0" : "0.0") : `${Number(expression.value).toPrecision(9)}`
  if (expression.op === "index") return "f32(index)"
  if (expression.op === "capture") {
    const index = captures.get(expression.name)
    if (index === undefined) throw new TypeError(`GPU region references undeclared capture ${JSON.stringify(expression.name)}`)
    return `munCaptures.values[${index}u]`
  }
  if (expression.op === "load") {
    if (expression.path.length !== 1 || typeof expression.path[0] !== "string") throw new TypeError("GPU regions require direct packed-column loads")
    const field = fields.get(expression.path[0])
    if (field === undefined) throw new TypeError(`GPU region references unknown field ${JSON.stringify(expression.path[0])}`)
    return `munColumn${field}.values[index]`
  }
  if (expression.op === "unary") {
    const value = wgslExpression(expression.value, fields, captures)
    if (expression.operator === "+") return `(${value})`
    if (expression.operator === "-") return `(-(${value}))`
    if (expression.operator === "!") return `select(0.0, 1.0, (${value}) == 0.0)`
    throw new TypeError(`GPU regions do not support unary ${expression.operator}`)
  }
  if (expression.op === "binary") {
    if (!supportedBinary.has(expression.operator)) throw new TypeError(`GPU regions do not support binary ${expression.operator}`)
    const left = wgslExpression(expression.left, fields, captures)
    const right = wgslExpression(expression.right, fields, captures)
    if (["<", "<=", ">", ">=", "==", "===", "!=", "!=="].includes(expression.operator)) {
      const operator = expression.operator === "===" ? "==" : expression.operator === "!==" ? "!=" : expression.operator
      return `select(0.0, 1.0, (${left}) ${operator} (${right}))`
    }
    if (expression.operator === "&&" || expression.operator === "||") {
      const operator = expression.operator === "&&" ? "&&" : "||"
      return `select(0.0, 1.0, ((${left}) != 0.0) ${operator} ((${right}) != 0.0))`
    }
    return `((${left}) ${expression.operator} (${right}))`
  }
  return `select((${wgslExpression(expression.whenFalse, fields, captures)}), (${wgslExpression(expression.whenTrue, fields, captures)}), (${wgslExpression(expression.condition, fields, captures)}) != 0.0)`
}

/**
 * Lower a proven packed f32 region to renderer-neutral WGSL. Every packed
 * column remains a separate storage binding, avoiding an AoS repack before GPU
 * execution. This function emits compute only; promotion still requires a
 * GPU-resident renderer sink and is never legal for a DOM readback path.
 */
export function compileResidentRegionWGSL(
  region: ResidentRegionIR,
  options: Readonly<{ workgroupSize?: 64 | 128 | 256 }> = {},
): CompiledGPURegionWGSL {
  if (region.inputResidency !== "packed" || region.outputResidency !== "packed" || region.typeProof !== "numeric-packed") {
    throw new TypeError("GPU region lowering requires a proven packed numeric region")
  }
  if (!sameDenseF32Layout(region)) throw new TypeError("GPU region lowering currently requires an unchanged dense f32 layout")
  if (region.kernels.some(kernel => kernel.kind !== "map")) throw new TypeError("GPU region lowering currently supports map kernels only")
  const workgroupSize = options.workgroupSize ?? 64
  if (workgroupSize !== 64 && workgroupSize !== 128 && workgroupSize !== 256) throw new RangeError("GPU region workgroup size must be 64, 128, or 256")
  const optimization = optimizeResidentKernelSequence(region.kernels, region.sink.layout)
  const fieldNames = Object.freeze(region.source.layout.fields.map(field => field.name))
  const fields = new Map(fieldNames.map((name, index) => [name, index]))
  const captureNames = Object.freeze([...new Set(optimization.kernels.flatMap(kernel => [...kernel.captures]))].sort())
  const captures = new Map(captureNames.map((name, index) => [name, index]))
  const bindings: CompiledGPURegionBinding[] = fieldNames.map((name, binding) => Object.freeze({
    binding,
    kind: "column" as const,
    name,
    access: "read_write" as const,
  }))
  const frameBinding = fieldNames.length
  const captureBinding = frameBinding + 1
  bindings.push(Object.freeze({ binding: frameBinding, kind: "frame", name: "frame", access: "read" }))
  bindings.push(Object.freeze({ binding: captureBinding, kind: "captures", name: "captures", access: "read" }))

  const lines: string[] = [
    "struct MunColumn { values: array<f32>, };",
    "struct MunFrame { length: u32, _pad0: vec3<u32>, };",
    "struct MunCaptures { values: array<f32>, };",
    ...fieldNames.map((_, index) => `@group(0) @binding(${index}) var<storage, read_write> munColumn${index}: MunColumn;`),
    `@group(0) @binding(${frameBinding}) var<uniform> munFrame: MunFrame;`,
    `@group(0) @binding(${captureBinding}) var<storage, read> munCaptures: MunCaptures;`,
    `@compute @workgroup_size(${workgroupSize})`,
    "fn munResidentCompute(@builtin(global_invocation_id) id: vec3<u32>) {",
    "  let index = id.x;",
    "  if (index >= munFrame.length) { return; }",
  ]
  let temporary = 0
  for (const kernel of optimization.kernels) {
    if (kernel.kind !== "map") continue
    const outputTemps: Array<{ readonly field: number; readonly name: string }> = []
    for (const output of kernel.outputs) {
      const field = fields.get(output.name)
      if (field === undefined) throw new TypeError(`GPU region writes unknown field ${JSON.stringify(output.name)}`)
      const name = `munOut${temporary++}`
      lines.push(`  let ${name}: f32 = ${wgslExpression(output.value, fields, captures)};`)
      outputTemps.push({ field, name })
    }
    for (const output of outputTemps) lines.push(`  munColumn${output.field}.values[index] = ${output.name};`)
  }
  lines.push("}")
  return Object.freeze({
    version: 1,
    regionId: region.id,
    entryPoint: "munResidentCompute",
    workgroupSize,
    code: `${lines.join("\n")}\n`,
    fieldNames,
    captureNames,
    bindings: Object.freeze(bindings),
    estimatedOpsPerItem: optimization.stats.estimatedOpsPerItem,
  })
}
