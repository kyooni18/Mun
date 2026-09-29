import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import {
  allocatePatchValues,
  applyPatchIR,
  clearPatchDirty,
  definePatchIR,
  markPatchDirty,
} from "../packages/web/dist/patch-ir.js"

test("Patch IR applies compact dirty text, attribute, property, style, and class values", () => {
  const document = new JSDOM("<!doctype html><body><button><span>old</span></button></body>").window.document
  const button = document.querySelector("button")
  const text = document.querySelector("span").firstChild
  const ir = definePatchIR([
    { node: 1, kind: "text" },
    { node: 0, kind: "attribute", key: "aria-label" },
    { node: 0, kind: "property", key: "disabled" },
    { node: 0, kind: "style", key: "--resident-x" },
    { node: 0, kind: "class", key: "active" },
  ])
  const patch = allocatePatchValues(ir)
  patch.values.splice(0, patch.values.length, "new", "patched", true, "12px", true)
  for (let index = 0; index < ir.locations.length; index += 1) markPatchDirty(patch.dirty, index)

  assert.equal(applyPatchIR([button, text], ir, patch), 5)
  assert.equal(text.nodeValue, "new")
  assert.equal(button.getAttribute("aria-label"), "patched")
  assert.equal(button.disabled, true)
  assert.equal(button.style.getPropertyValue("--resident-x"), "12px")
  assert.equal(button.classList.contains("active"), true)

  clearPatchDirty(patch.dirty)
  assert.equal(applyPatchIR([button, text], ir, patch), 0)
})

test("Patch IR child ranges retain anchors and replace only renderer-owned children", () => {
  const document = new JSDOM("<!doctype html><body><div></div></body>").window.document
  const parent = document.querySelector("div")
  const start = document.createComment("mun:start")
  const stale = document.createElement("i")
  const end = document.createComment("mun:end")
  parent.append(start, stale, end)
  const next = document.createElement("b")
  next.textContent = "next"
  const ir = definePatchIR([{ node: 0, kind: "child-range", endNode: 1 }])
  const patch = allocatePatchValues(ir)
  patch.values[0] = [next]
  markPatchDirty(patch.dirty, 0)

  assert.equal(applyPatchIR([start, end], ir, patch), 1)
  assert.deepEqual([...parent.childNodes], [start, next, end])
})

test("Patch IR rejects event/prototype sinks and malformed buffers", () => {
  assert.throws(() => definePatchIR([{ node: 0, kind: "attribute", key: "onclick" }]), /unsafe/)
  assert.throws(() => definePatchIR([{ node: 0, kind: "property", key: "innerHTML" }]), /unsafe/)
  assert.throws(() => definePatchIR([{ node: 0, kind: "style", key: "cssText" }]), /unsafe/)
  assert.throws(() => definePatchIR([{ node: 0, kind: "child-range", endNode: 0 }]), /distinct/)

  const ir = definePatchIR([{ node: 0, kind: "text" }])
  const document = new JSDOM("<!doctype html><body>x</body>").window.document
  const text = document.body.firstChild
  assert.throws(() => applyPatchIR([text], ir, { dirty: new Uint32Array(0), values: ["x"] }), /bitset/)
})
