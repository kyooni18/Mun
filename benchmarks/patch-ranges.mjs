// JSDOM structural benchmark, not a browser layout/frame-time measurement.
// Run after building @mun/web: node benchmarks/patch-ranges.mjs
import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { JSDOM } from "jsdom"
import { allocatePatchValues, applyPatchIR, definePatchIR, markPatchDirty } from "../packages/web/dist/patch-ir.js"

const count = Number(process.env.MUN_PATCH_ITEMS ?? 1000)
const rounds = Number(process.env.MUN_PATCH_ROUNDS ?? 15)
if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(rounds) || rounds < 1) throw new RangeError("item/round counts must be positive safe integers")
for (const mode of ["unchanged", "reverse"]) {
  const dom = new JSDOM("<main></main>")
  const document = dom.window.document
  const parent = document.querySelector("main")
  const start = document.createComment("start")
  const end = document.createComment("end")
  let children = Array.from({ length: count }, () => document.createElement("span"))
  parent.append(start, ...children, end)
  const ir = definePatchIR([{ node: 0, kind: "child-range", endNode: 1 }])
  const patch = allocatePatchValues(ir)
  markPatchDirty(patch.dirty, 0)
  let writes = 0
  for (const method of ["removeChild", "insertBefore"]) {
    const original = parent[method]
    parent[method] = function (...args) { writes++; return original.apply(this, args) }
  }
  const times = []
  for (let round = -3; round < rounds; round++) {
    if (mode === "reverse") children = [...children].reverse()
    patch.values[0] = children
    const begin = performance.now()
    applyPatchIR([start, end], ir, patch)
    if (round >= 0) times.push(performance.now() - begin)
    if (round === -1) writes = 0
  }
  assert.deepEqual([...parent.childNodes], [start, ...children, end])
  times.sort((a, b) => a - b)
  console.log(`${mode}: ${count} nodes, median ${times[Math.floor(times.length / 2)].toFixed(3)} ms; ${writes / rounds} DOM writes/update (${rounds} rounds, 3 warmups)`)
  dom.window.close()
}
