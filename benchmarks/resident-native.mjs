import { performance } from "node:perf_hooks"
import {
  definePackedLayout,
  definePackedStorage,
  defineResidentRegion,
} from "../packages/core/dist/resident-execution.js"
import { emitResidentRegionJS } from "../packages/compiler/dist/resident-js.js"
import { compileResidentWasmRegion } from "../packages/compiler/dist/resident-wasm.js"
import { defineBufferLayout } from "../packages/execution/dist/index.js"
import {
  ResidentAdaptiveNativeScheduler,
  bindResidentWasmRegion,
  createResidentWasmMemory,
  executeResidentWasm,
  loadDefaultResidentWasmRuntime,
} from "../packages/execution/dist/resident-wasm.js"

const defaultRows = [256, 1024, 4096, 16_384, 65_536, 262_144]
const rows = (process.env.MUN_RESIDENT_NATIVE_ROWS ?? "")
  .split(",").filter(Boolean).map(Number)
const rowCounts = rows.length > 0 ? rows : defaultRows
const dirtyRatios = (process.env.MUN_RESIDENT_NATIVE_DIRTY ?? "0.01,0.1,1").split(",").map(Number)
const rounds = Math.max(3, Number.parseInt(process.env.MUN_RESIDENT_NATIVE_ROUNDS ?? "15", 10))
const ci = process.env.MUN_RESIDENT_NATIVE_CI === "1"
const ciMaximumRatio = Number(process.env.MUN_RESIDENT_NATIVE_MAX_RATIO ?? "1.5")

const load = name => ({ op: "load", path: [name] })
const capture = name => ({ op: "capture", name })
const constant = value => ({ op: "const", value })
const binary = (operator, left, right) => ({ op: "binary", operator, left, right })
const select = (condition, whenTrue, whenFalse) => ({ op: "select", condition, whenTrue, whenFalse })
const kernel = (outputs, captures = []) => ({
  kind: "map",
  itemName: "row",
  preserveInput: true,
  outputs,
  captures,
  requiresTypeProof: true,
})

const profiles = Object.freeze({
  light: [kernel([
    { name: "x", value: binary("+", load("x"), binary("*", load("vx"), capture("dt"))) },
    { name: "y", value: binary("+", load("y"), binary("*", load("vy"), capture("dt"))) },
  ], ["dt"])],
  medium: [kernel([
    { name: "x", value: binary("+", load("x"), binary("*", load("vx"), capture("dt"))) },
    { name: "y", value: binary("+", load("y"), binary("*", load("vy"), capture("dt"))) },
    { name: "energy", value: binary("+", binary("*", load("vx"), load("vx")), binary("*", load("vy"), load("vy"))) },
  ], ["dt"])],
  heavy: [
    kernel([
      { name: "x", value: binary("+", load("x"), binary("*", load("vx"), capture("dt"))) },
      { name: "y", value: binary("+", load("y"), binary("*", load("vy"), capture("dt"))) },
      { name: "energy", value: binary("+", binary("*", load("vx"), load("vx")), binary("*", load("vy"), load("vy"))) },
    ], ["dt"]),
    kernel([
      { name: "x", value: select(binary(">", load("energy"), capture("threshold")), binary("*", load("x"), capture("decay")), load("x")) },
      { name: "y", value: binary("+", load("y"), binary("*", constant(0.125), capture("dt"))) },
    ], ["threshold", "decay", "dt"]),
  ],
})

const captureValues = Object.freeze({ dt: 0.016, threshold: 12, decay: 0.9995 })

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >>> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function seed(buffers, count) {
  const [x, y, vx, vy, energy] = buffers
  for (let index = 0; index < count; index += 1) {
    x[index] = index * 0.001
    y[index] = index * -0.0015
    vx[index] = 0.5 + (index % 7) * 0.125
    vy[index] = -0.25 + (index % 5) * 0.2
    energy[index] = 0
  }
}

function assertClose(left, right, end) {
  for (let field = 0; field < left.length; field += 1) {
    for (let index = 0; index < end; index += 1) {
      const a = left[field][index]
      const b = right[field][index]
      if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > 2e-5 * Math.max(1, Math.abs(a), Math.abs(b))) {
        throw new Error(`resident native parity mismatch at field=${field} row=${index}: js=${a} wasm=${b}`)
      }
    }
  }
}

async function benchmarkCase(profileName, kernels, count, dirtyRatio) {
  const fields = ["x", "y", "vx", "vy", "energy"]
  const packedLayout = definePackedLayout(fields.map(name => ({ name, type: "f32" })), count)
  const region = defineResidentRegion({
    id: `resident-native-${profileName}-${count}`,
    source: { kind: "packed", layout: packedLayout },
    kernels,
    sink: { kind: "packed", layout: packedLayout },
    typeProof: "numeric-packed",
    lifetime: "frame-persistent",
    inputResidency: "packed",
    outputResidency: "packed",
    estimatedTransferBytes: 0,
  })
  const runtimeLayout = defineBufferLayout(fields.map(name => ({ name, type: "f32", length: count })))
  const memory = createResidentWasmMemory(runtimeLayout.byteLength + 512 * 1024)
  const runtime = await loadDefaultResidentWasmRuntime({ memory, preferSimd: true })
  const program = compileResidentWasmRegion(region)
  const binding = bindResidentWasmRegion(runtime, runtimeLayout, program)
  if (binding.directBackend !== "wasm-aot-simd") throw new Error(`expected wasm-aot-simd, got ${binding.directBackend ?? runtime.variant}`)
  const wasmBuffers = binding.buffer.cpuViews.map(view => view)
  const jsBuffers = fields.map(() => new Float32Array(count))
  seed(wasmBuffers, count)
  seed(jsBuffers, count)
  const jsStorage = definePackedStorage(packedLayout, jsBuffers)
  const executorName = `__munNative${profileName}${count}`
  const jsExecutor = Function(`"use strict"; ${emitResidentRegionJS(region, executorName)}; return ${executorName}`)()
  const end = Math.max(1, Math.ceil(count * dirtyRatio))
  const ranges = [{ start: 0, end }]
  const captureArray = new Float32Array(program.captureNames.map(name => captureValues[name]))
  const captureRecord = Object.fromEntries(program.captureNames.map(name => [name, captureValues[name]]))
  const scheduler = new ResidentAdaptiveNativeScheduler()
  const predicted = scheduler.choose(binding, { ranges, captures: captureArray })

  jsExecutor(jsStorage, jsStorage, captureRecord, ranges)
  executeResidentWasm(binding, { captures: captureArray, ranges })
  assertClose(jsBuffers, wasmBuffers, end)
  seed(wasmBuffers, count)
  seed(jsBuffers, count)

  const iterations = Math.max(1, Math.min(64, Math.floor(32_768 / Math.max(1, end))))
  for (let warmup = 0; warmup < 8; warmup += 1) {
    for (let repeat = 0; repeat < iterations; repeat += 1) jsExecutor(jsStorage, jsStorage, captureRecord, ranges)
    for (let repeat = 0; repeat < iterations; repeat += 1) executeResidentWasm(binding, { captures: captureArray, ranges })
  }
  const jsSamples = []
  const wasmSamples = []
  for (let round = 0; round < rounds; round += 1) {
    let started = performance.now()
    for (let repeat = 0; repeat < iterations; repeat += 1) jsExecutor(jsStorage, jsStorage, captureRecord, ranges)
    jsSamples.push((performance.now() - started) / iterations)
    started = performance.now()
    for (let repeat = 0; repeat < iterations; repeat += 1) executeResidentWasm(binding, { captures: captureArray, ranges })
    wasmSamples.push((performance.now() - started) / iterations)
  }
  const jsMs = median(jsSamples)
  const wasmMs = median(wasmSamples)
  return {
    profileName,
    count,
    dirtyRatio,
    end,
    backend: binding.directBackend,
    predicted,
    weightedWork: scheduler.snapshot().weightedWork,
    jsMs,
    wasmMs,
    ratio: wasmMs / jsMs,
  }
}

const results = []
for (const [profileName, kernels] of Object.entries(profiles)) {
  for (const count of rowCounts) {
    if (!Number.isSafeInteger(count) || count <= 0) throw new RangeError(`invalid row count: ${count}`)
    for (const dirtyRatio of dirtyRatios) {
      if (!(dirtyRatio > 0 && dirtyRatio <= 1)) throw new RangeError(`invalid dirty ratio: ${dirtyRatio}`)
      results.push(await benchmarkCase(profileName, kernels, count, dirtyRatio))
    }
  }
}

console.log(`Resident Native matrix | median ${rounds} rounds | ${results.length} cases`)
for (const result of results) {
  console.log(`${result.profileName.padEnd(6)} ${String(result.count).padStart(7)} rows ${(result.dirtyRatio * 100).toFixed(0).padStart(3)}% dirty | packed-js ${result.jsMs.toFixed(4).padStart(8)} ms | ${result.backend} ${result.wasmMs.toFixed(4).padStart(8)} ms | ratio ${result.ratio.toFixed(3)} | predict ${result.predicted.padEnd(9)} work ${result.weightedWork.toFixed(0)}`)
}

const decisive = results.filter(result => result.predicted !== "calibrate" && Math.abs(result.ratio - 1) >= 0.08)
const correct = decisive.filter(result => result.predicted === (result.ratio < 1 ? "wasm" : "packed-js"))
if (decisive.length > 0) {
  console.log(`adaptive bootstrap accuracy ${correct.length}/${decisive.length} (${(correct.length / decisive.length * 100).toFixed(1)}%) on decisive cases; ${results.filter(result => result.predicted === "calibrate").length} crossover cases delegated to calibration`)
}

if (ci) {
  const guarded = results.filter(result => result.count >= 65_536 && result.dirtyRatio === 1)
  const failures = guarded.filter(result => !Number.isFinite(result.ratio) || result.ratio > ciMaximumRatio)
  if (failures.length > 0) {
    throw new Error(`resident AOT SIMD exceeded CI ratio ceiling ${ciMaximumRatio}: ${failures.map(result => `${result.profileName}/${result.count}=${result.ratio.toFixed(3)}`).join(", ")}`)
  }
}
