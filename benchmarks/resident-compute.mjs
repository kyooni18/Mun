import { performance } from "node:perf_hooks"
import {
  definePackedLayout,
  definePackedStorage,
  defineResidentRegion,
} from "../packages/core/dist/resident-execution.js"
import { emitResidentRegionJS } from "../packages/compiler/dist/resident-js.js"

const count = Number.parseInt(process.env.MUN_RESIDENT_ROWS ?? "100000", 10)
const frames = Number.parseInt(process.env.MUN_RESIDENT_FRAMES ?? "60", 10)
if (!Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(frames) || frames <= 0) {
  throw new Error("MUN_RESIDENT_ROWS and MUN_RESIDENT_FRAMES must be positive integers")
}

const layout = definePackedLayout([
  { name: "x", type: "f64" },
  { name: "y", type: "f64" },
  { name: "vx", type: "f64" },
  { name: "vy", type: "f64" },
  { name: "energy", type: "f64" },
], count)
const columns = layout.fields.map(() => new Float64Array(count))
for (let index = 0; index < count; index += 1) {
  columns[0][index] = index * 0.01
  columns[1][index] = index * -0.02
  columns[2][index] = 0.5 + (index % 7)
  columns[3][index] = -0.25 + (index % 5)
}
const storage = definePackedStorage(layout, columns)

const load = name => ({ op: "load", path: [name] })
const capture = name => ({ op: "capture", name })
const binary = (operator, left, right) => ({ op: "binary", operator, left, right })
const kernel = outputs => ({
  kind: "map",
  itemName: "row",
  preserveInput: true,
  outputs,
  captures: ["dt"],
  requiresTypeProof: true,
})
const region = defineResidentRegion({
  id: "resident-benchmark",
  source: { kind: "packed", layout },
  kernels: [
    kernel([
      { name: "x", value: binary("+", load("x"), binary("*", load("vx"), capture("dt"))) },
      { name: "y", value: binary("+", load("y"), binary("*", load("vy"), capture("dt"))) },
    ]),
    kernel([{
      name: "energy",
      value: binary("+", binary("*", load("vx"), load("vx")), binary("*", load("vy"), load("vy"))),
    }]),
  ],
  sink: { kind: "packed", layout },
  typeProof: "numeric-packed",
  lifetime: "frame-persistent",
  inputResidency: "packed",
  outputResidency: "packed",
  estimatedTransferBytes: 0,
})
const executorName = "__munResidentBenchmark"
const executor = Function(`"use strict"; ${emitResidentRegionJS(region, executorName)}; return ${executorName}`)()

let objects = Array.from({ length: count }, (_, index) => ({
  x: index * 0.01,
  y: index * -0.02,
  vx: 0.5 + (index % 7),
  vy: -0.25 + (index % 5),
  energy: 0,
}))

function measure(run) {
  const started = performance.now()
  run()
  return performance.now() - started
}

const objectMs = measure(() => {
  for (let frame = 0; frame < frames; frame += 1) {
    objects = objects.map(row => {
      const x = row.x + row.vx * 0.016
      const y = row.y + row.vy * 0.016
      return { ...row, x, y, energy: row.vx * row.vx + row.vy * row.vy }
    })
  }
})
const packedMs = measure(() => {
  for (let frame = 0; frame < frames; frame += 1) {
    executor(storage, storage, { dt: 0.016 })
  }
})

const objectChecksum = objects[0].x + objects[count - 1].y + objects[count - 1].energy
const packedChecksum = storage.buffers[0][0] + storage.buffers[1][count - 1] + storage.buffers[4][count - 1]
if (!Number.isFinite(objectChecksum) || !Number.isFinite(packedChecksum)
  || Math.abs(objectChecksum - packedChecksum) > 1e-9) throw new Error("resident benchmark produced a mismatched checksum")

console.log(`Resident Compute JS baseline | ${count} rows x ${frames} frames`)
console.log(`object map/materialize         ${objectMs.toFixed(2)} ms`)
console.log(`packed fused/in-place          ${packedMs.toFixed(2)} ms`)
console.log(`packed/object ratio            ${(packedMs / objectMs).toFixed(3)}`)
console.log(`checksums                      object=${objectChecksum.toFixed(3)} packed=${packedChecksum.toFixed(3)}`)
