/* SPDX-License-Identifier: MIT */

import assert from "node:assert/strict"
import test from "node:test"
import { definePackedLayout, defineResidentRegion } from "../packages/core/dist/resident-execution.js"
import { compileResidentRegionWGSL } from "../packages/compiler/dist/gpu-region.js"

const load = name => ({ op: "load", path: [name] })
const capture = name => ({ op: "capture", name })
const binary = (operator, left, right) => ({ op: "binary", operator, left, right })

test("generic GPU Region lowers optimized packed f32 Kernel IR to SoA WGSL", () => {
  const layout = definePackedLayout([
    { name: "x", type: "f32" },
    { name: "y", type: "f32" },
  ], 4096)
  const region = defineResidentRegion({
    id: "chart-transform",
    source: { kind: "packed", layout },
    sink: { kind: "packed", layout },
    kernels: [{
      kind: "map",
      itemName: "row",
      preserveInput: true,
      outputs: [
        { name: "x", value: binary("+", load("x"), binary("*", load("y"), capture("scale"))) },
        { name: "y", value: binary("+", load("y"), capture("offset")) },
      ],
      captures: ["scale", "offset"],
      requiresTypeProof: true,
    }],
    typeProof: "numeric-packed",
    lifetime: "frame-persistent",
    inputResidency: "packed",
    outputResidency: "packed",
    estimatedTransferBytes: 0,
  })
  const compiled = compileResidentRegionWGSL(region, { workgroupSize: 128 })
  assert.equal(compiled.entryPoint, "munResidentCompute")
  assert.equal(compiled.workgroupSize, 128)
  assert.deepEqual(compiled.fieldNames, ["x", "y"])
  assert.deepEqual(compiled.captureNames, ["offset", "scale"])
  assert.match(compiled.code, /@compute @workgroup_size\(128\)/)
  assert.match(compiled.code, /var<storage, read_write> munColumn0/)
  assert.match(compiled.code, /let munOut0: f32/)
  assert.match(compiled.code, /munColumn0\.values\[index\] = munOut0/)
  assert.doesNotMatch(compiled.code, /readback|copy/iu)
})

test("generic GPU Region refuses layouts that would require an implicit repack", () => {
  const layout = definePackedLayout([{ name: "x", type: "f64" }], 16)
  const region = defineResidentRegion({
    id: "not-f32",
    source: { kind: "packed", layout },
    sink: { kind: "packed", layout },
    kernels: [{
      kind: "map", itemName: "row", preserveInput: true,
      outputs: [{ name: "x", value: load("x") }], captures: [], requiresTypeProof: true,
    }],
    typeProof: "numeric-packed",
    lifetime: "persistent",
    inputResidency: "packed",
    outputResidency: "packed",
    estimatedTransferBytes: 0,
  })
  assert.throws(() => compileResidentRegionWGSL(region), /dense f32 layout/)
})
