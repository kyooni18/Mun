import assert from "node:assert/strict"
import test from "node:test"
import {
  allocatePackedStorage,
  allocatePackedState,
  definePackedLayout,
  definePackedState,
  definePackedStorage,
  defineResidentRegion,
  executeResidentRegionPackedState,
  executeResidentRegionJS,
} from "../packages/core/dist/resident-execution.js"
import { emitResidentRegionJS } from "../packages/compiler/dist/resident-js.js"

const load = name => ({ op: "load", path: [name] })
const constant = value => ({ op: "const", value })
const capture = name => ({ op: "capture", name })
const binary = (operator, left, right) => ({ op: "binary", operator, left, right })

function mapKernel(outputs) {
  return {
    kind: "map",
    itemName: "row",
    preserveInput: true,
    outputs,
    captures: ["dt"],
    requiresTypeProof: true,
  }
}

test("packed storage validates column type, count, and stable length", () => {
  const layout = definePackedLayout([
    { name: "x", type: "f64" },
    { name: "active", type: "u8" },
  ], 3)
  const storage = definePackedStorage(layout, [new Float64Array([1, 2, 3]), new Uint8Array([1, 0, 1])])
  assert.equal(storage.layout, layout)
  assert.equal(storage.version, 0)
  assert.throws(() => definePackedStorage(layout, [new Float32Array(3), new Uint8Array(3)]), /does not match/)
  assert.throws(() => definePackedStorage(layout, [new Float64Array(2), new Uint8Array(3)]), /wrong length/)
  assert.throws(() => definePackedLayout([{ name: "x", type: "f32" }, { name: "x", type: "f32" }], 1), /duplicate/)
})

test("the JS packed executor fuses kernels over authoritative columns in place", () => {
  const layout = definePackedLayout([
    { name: "x", type: "f64" },
    { name: "velocity", type: "f64" },
    { name: "energy", type: "f64" },
  ], 3)
  const storage = definePackedStorage(layout, [
    new Float64Array([1, 2, 3]),
    new Float64Array([10, 20, 30]),
    new Float64Array(3),
  ], 7)
  const region = defineResidentRegion({
    id: "advance-particles",
    source: { kind: "packed", layout },
    kernels: [
      mapKernel([{ name: "x", value: binary("+", load("x"), binary("*", load("velocity"), capture("dt"))) }]),
      mapKernel([{ name: "energy", value: binary("*", load("x"), load("velocity")) }]),
    ],
    sink: { kind: "packed", layout },
    typeProof: "numeric-packed",
    lifetime: "frame-persistent",
    inputResidency: "packed",
    outputResidency: "packed",
    estimatedTransferBytes: 0,
  })

  const originalBuffers = storage.buffers
  const result = executeResidentRegionJS(region, storage, storage, { captures: { dt: 0.5 } })

  assert.equal(result, storage)
  assert.equal(result.buffers, originalBuffers)
  assert.deepEqual([...result.buffers[0]], [6, 12, 18])
  assert.deepEqual([...result.buffers[2]], [60, 240, 540])
  assert.equal(result.version, 8)
  assert.ok(region.estimatedOpsPerItem > 0)
  assert.equal(region.estimatedTransferBytes, 0)
})

test("the JS packed executor can reuse a separate packed sink without row objects", () => {
  const layout = definePackedLayout([
    { name: "value", type: "f32" },
    { name: "untouched", type: "u32" },
  ], 2)
  const source = definePackedStorage(layout, [new Float32Array([2, 4]), new Uint32Array([7, 9])], 3)
  const sink = allocatePackedStorage(layout, 11)
  const region = defineResidentRegion({
    id: "scale-values",
    source: { kind: "packed", layout },
    kernels: [mapKernel([{ name: "value", value: binary("*", load("value"), constant(3)) }])],
    sink: { kind: "packed", layout },
    typeProof: "numeric-packed",
    lifetime: "persistent",
    inputResidency: "packed",
    outputResidency: "packed",
    estimatedTransferBytes: 0,
  })

  executeResidentRegionJS(region, source, sink, { captures: { dt: 1 } })
  assert.deepEqual([...source.buffers[0]], [2, 4])
  assert.deepEqual([...sink.buffers[0]], [6, 12])
  assert.deepEqual([...sink.buffers[1]], [7, 9])
  assert.equal(source.version, 3)
  assert.equal(sink.version, 12)
})

test("PackedState keeps authoritative packed memory, stable capacity, and versioned dirty ranges", () => {
  const layout = definePackedLayout([
    { name: "x", type: "f64" },
    { name: "y", type: "f64" },
  ], 2)
  const state = allocatePackedState(layout, { capacity: 4, version: 2 })
  const changes = []
  const unsubscribe = state.subscribe((_, change) => { changes.push(change) })

  assert.equal(state.length, 2)
  assert.equal(state.capacity, 4)
  assert.equal(state.version, 2)
  assert.deepEqual(state.dirtyRanges, [])
  assert.deepEqual(state.consumeDirtyRanges(), [])
  assert.deepEqual(state.dirtyRanges, [])

  const mutation = state.mutate({ start: 1, end: 2, fields: ["x"] }, view => {
    view.column("x")[1] = 9
  })
  assert.equal(mutation, true)
  assert.equal(state.lastChange.kind, "mutation")
  assert.equal(state.lastChange.storageChanged, false)
  assert.equal(state.version, 3)
  assert.deepEqual(state.dirtyRanges, [{ start: 1, end: 2, fields: ["x"], version: 3 }])

  const reserve = state.reserve(8)
  assert.equal(reserve, true)
  assert.equal(state.lastChange.kind, "reserve")
  assert.equal(state.lastChange.storageChanged, true)
  assert.equal(state.capacity, 8)
  assert.equal(state.version, 4)

  const resize = state.resize(4)
  assert.equal(resize, true)
  assert.equal(state.lastChange.kind, "resize")
  assert.equal(state.lastChange.storageChanged, true)
  assert.equal(state.length, 4)
  assert.equal(state.version, 5)
  assert.deepEqual(state.dirtyRanges, [
    { start: 0, end: 2, version: 4 },
    { start: 2, end: 4, version: 5 },
  ])
  assert.equal(changes.length, 3)
  unsubscribe()
})

test("Resident Compute rejects object or GPU boundaries before execution planning", () => {
  const layout = definePackedLayout([{ name: "value", type: "f64" }], 1)
  const region = {
    id: "invalid-boundary",
    source: { kind: "packed", layout },
    kernels: [mapKernel([{ name: "value", value: load("value") }])],
    sink: { kind: "packed", layout },
    typeProof: "numeric-packed",
    lifetime: "single-use",
    outputResidency: "packed",
    estimatedTransferBytes: 8,
  }
  assert.throws(() => defineResidentRegion({ ...region, inputResidency: "objects" }), /must remain packed/)
  assert.throws(() => defineResidentRegion({ ...region, inputResidency: "packed", outputResidency: "gpu" }), /must remain packed/)
})

test("the compiler emits a direct fused TypedArray loop instead of a row-time IR interpreter", () => {
  const layout = definePackedLayout([
    { name: "x", type: "f64" },
    { name: "velocity", type: "f64" },
  ], 2)
  const storage = definePackedStorage(layout, [new Float64Array([1, 2]), new Float64Array([4, 5])])
  const region = defineResidentRegion({
    id: "compiled-packed-loop",
    source: { kind: "packed", layout },
    kernels: [mapKernel([{ name: "x", value: binary("+", load("x"), binary("*", load("velocity"), capture("dt"))) }])],
    sink: { kind: "packed", layout },
    typeProof: "numeric-packed",
    lifetime: "frame-persistent",
    inputResidency: "packed",
    outputResidency: "packed",
    estimatedTransferBytes: 0,
  })
  const name = "__testResidentExecutor"
  const source = emitResidentRegionJS(region, name)
  assert.match(source, /for \(let __munRangeIndex = 0;/)
  assert.match(source, /for \(let __munIndex = __munRange\.start;/)
  assert.doesNotMatch(source, /evaluateResident|\.map\(/)
  const executor = Function(`"use strict"; ${source}; return ${name}`)()
  const buffers = storage.buffers
  executor(storage, storage, { dt: 0.25 })
  assert.equal(storage.buffers, buffers)
  assert.deepEqual([...storage.buffers[0]], [2, 3.25])
  assert.equal(storage.version, 1)
})

test("resident packed-state execution reuses dirty ranges and only updates the affected packed slice", () => {
  const layout = definePackedLayout([
    { name: "x", type: "f64" },
    { name: "y", type: "f64" },
  ], 3)
  const source = definePackedState(definePackedStorage(layout, [
    new Float64Array([1, 2, 3]),
    new Float64Array([0, 0, 0]),
  ], 5))
  source.consumeDirtyRanges()
  source.mutate({ start: 1, end: 2, fields: ["x"] }, view => {
    view.column("x")[1] = 10
  })
  const sink = definePackedState(definePackedStorage(layout, [
    new Float64Array([99, 99, 99]),
    new Float64Array([50, 50, 50]),
  ], 9))
  sink.consumeDirtyRanges()
  const region = defineResidentRegion({
    id: "dirty-slice",
    source: { kind: "packed", layout },
    kernels: [mapKernel([{ name: "y", value: binary("*", load("x"), constant(2)) }])],
    sink: { kind: "packed", layout },
    typeProof: "numeric-packed",
    lifetime: "persistent",
    inputResidency: "packed",
    outputResidency: "packed",
    estimatedTransferBytes: 0,
  })

  const change = executeResidentRegionPackedState(region, source, sink)

  assert.equal(change.kind, "external")
  assert.equal(sink.version, 10)
  assert.deepEqual([...sink.storage.buffers[0]], [99, 10, 99])
  assert.deepEqual([...sink.storage.buffers[1]], [50, 20, 50])
  assert.deepEqual(sink.dirtyRanges, [{ start: 1, end: 2, fields: ["y"], version: 10 }])
})

test("outputs in one map kernel read the same pre-kernel row while later kernels see fused writes", () => {
  const layout = definePackedLayout([
    { name: "x", type: "f64" },
    { name: "previous", type: "f64" },
  ], 1)
  const makeStorage = () => definePackedStorage(layout, [new Float64Array([2]), new Float64Array([0])])
  const region = defineResidentRegion({
    id: "map-snapshot-semantics",
    source: { kind: "packed", layout },
    kernels: [
      mapKernel([
        { name: "x", value: binary("+", load("x"), constant(1)) },
        { name: "previous", value: load("x") },
      ]),
      mapKernel([{ name: "previous", value: binary("+", load("previous"), load("x")) }]),
    ],
    sink: { kind: "packed", layout },
    typeProof: "numeric-packed",
    lifetime: "persistent",
    inputResidency: "packed",
    outputResidency: "packed",
    estimatedTransferBytes: 0,
  })
  const reference = makeStorage()
  executeResidentRegionJS(region, reference, reference, { captures: { dt: 1 } })
  assert.deepEqual(reference.buffers.map(buffer => [...buffer]), [[3], [5]])

  const compiled = makeStorage()
  const name = "__snapshotExecutor"
  const executor = Function(`"use strict"; ${emitResidentRegionJS(region, name)}; return ${name}`)()
  executor(compiled, compiled, { dt: 1 })
  assert.deepEqual(compiled.buffers.map(buffer => [...buffer]), [[3], [5]])
})

test("the compiled packed executor can target only dirty ranges without sweeping untouched rows", () => {
  const layout = definePackedLayout([
    { name: "x", type: "f64" },
    { name: "velocity", type: "f64" },
  ], 3)
  const source = definePackedStorage(layout, [
    new Float64Array([1, 10, 3]),
    new Float64Array([4, 5, 6]),
  ])
  const sink = definePackedStorage(layout, [
    new Float64Array([100, 100, 100]),
    new Float64Array([7, 7, 7]),
  ], 4)
  const region = defineResidentRegion({
    id: "compiled-dirty-slice",
    source: { kind: "packed", layout },
    kernels: [mapKernel([{ name: "x", value: binary("+", load("x"), load("velocity")) }])],
    sink: { kind: "packed", layout },
    typeProof: "numeric-packed",
    lifetime: "frame-persistent",
    inputResidency: "packed",
    outputResidency: "packed",
    estimatedTransferBytes: 0,
  })
  const name = "__rangeResidentExecutor"
  const executor = Function(`"use strict"; ${emitResidentRegionJS(region, name)}; return ${name}`)()

  executor(source, sink, { dt: 1 }, [{ start: 1, end: 2 }])

  assert.deepEqual([...sink.buffers[0]], [100, 15, 100])
  assert.deepEqual([...sink.buffers[1]], [7, 5, 7])
  assert.equal(sink.version, 5)
})
