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

test("Patch IR dirty indexes cannot wrap around the 32-bit boundary", () => {
  const dirty = new Uint32Array(1)
  for (const index of [2 ** 32, 2 ** 32 + 31, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => markPatchDirty(dirty, index), /exceeds/)
    assert.equal(dirty[0], 0)
  }
})

test("Patch IR rejects unknown runtime location kinds", () => {
  assert.throws(() => definePatchIR([{ node: 0, kind: "typo" }]), /kind/)
})

function rangeFixture() {
  const dom = new JSDOM("<main><i>before</i><!--start--><b>old</b><!--end--><u>after</u></main>")
  const parent = dom.window.document.querySelector("main")
  const start = parent.childNodes[1]
  const end = parent.childNodes[3]
  const ir = definePatchIR([{ node: 0, kind: "child-range", endNode: 1 }])
  const patch = allocatePatchValues(ir)
  markPatchDirty(patch.dirty, 0)
  return { dom, parent, start, end, ir, patch }
}

for (const invalid of ["not-an-array", [null], [{ nodeType: 1 }]]) {
  test(`Patch IR validates range replacement before removing live DOM: ${JSON.stringify(invalid)}`, () => {
    const { dom, parent, start, end, ir, patch } = rangeFixture()
    const original = [...parent.childNodes]
    patch.values[0] = invalid
    assert.throws(() => applyPatchIR([start, end], ir, patch), /Nodes|non-Node/)
    assert.deepEqual([...parent.childNodes], original)
    dom.window.close()
  })
}

test("Patch IR rejects reversed or aliased range anchors without destroying siblings", () => {
  const { dom, parent, start, end, ir, patch } = rangeFixture()
  const original = [...parent.childNodes]
  patch.values[0] = []
  assert.throws(() => applyPatchIR([end, start], ir, patch), /order/)
  assert.deepEqual([...parent.childNodes], original)
  assert.throws(() => applyPatchIR([start, start], ir, patch), /distinct/)
  assert.deepEqual([...parent.childNodes], original)
  dom.window.close()
})

test("Patch IR rejects range self-insertion and ancestor insertion before mutation", () => {
  const { dom, parent, start, end, ir, patch } = rangeFixture()
  const original = [...parent.childNodes]
  for (const children of [[start], [end], [parent], [parent.ownerDocument]]) {
    patch.values[0] = children
    assert.throws(() => applyPatchIR([start, end], ir, patch), /range|ancestor|Node/)
    assert.deepEqual([...parent.childNodes], original)
  }
  dom.window.close()
})

test("Patch IR unchanged child ranges perform no DOM writes", () => {
  const { dom, parent, start, end, ir, patch } = rangeFixture()
  const old = start.nextSibling
  const observer = new dom.window.MutationObserver(() => {})
  observer.observe(parent, { childList: true })
  patch.values[0] = [old]
  assert.equal(applyPatchIR([start, end], ir, patch), 1)
  assert.deepEqual(observer.takeRecords(), [])
  observer.disconnect()
  dom.window.close()
})

test("Patch IR safely materializes fragments and adopts cross-document nodes", () => {
  const { dom, parent, start, end, ir, patch } = rangeFixture()
  const foreign = new JSDOM("")
  const fragment = foreign.window.document.createDocumentFragment()
  const a = foreign.window.document.createElement("em")
  const b = foreign.window.document.createTextNode("foreign")
  fragment.append(a, b)
  patch.values[0] = [fragment]
  applyPatchIR([start, end], ir, patch)
  assert.equal(start.nextSibling, a)
  assert.equal(a.nextSibling, b)
  assert.equal(b.nextSibling, end)
  assert.equal(a.ownerDocument, parent.ownerDocument)
  assert.equal(fragment.childNodes.length, 0)
  dom.window.close()
  foreign.window.close()
})

test("Patch IR rejects duplicate replacement nodes before removing live children", () => {
  const { dom, parent, start, end, ir, patch } = rangeFixture()
  const original = [...parent.childNodes]
  const next = parent.ownerDocument.createElement("em")
  patch.values[0] = [next, next]
  assert.throws(() => applyPatchIR([start, end], ir, patch), /duplicate/)
  assert.deepEqual([...parent.childNodes], original)
  dom.window.close()
})

test("Patch IR validates the entire replacement array before insertion", () => {
  const { dom, parent, start, end, ir, patch } = rangeFixture()
  const original = [...parent.childNodes]
  const next = parent.ownerDocument.createElement("em")
  patch.values[0] = [next, { nodeType: 1 }]
  assert.throws(() => applyPatchIR([start, end], ir, patch), /non-Node/)
  assert.deepEqual([...parent.childNodes], original)
  assert.equal(next.parentNode, null)
  dom.window.close()
})

test("Patch IR unchanged ranges retain focus on an existing input", () => {
  const { dom, parent, start, end, ir, patch } = rangeFixture()
  const input = parent.ownerDocument.createElement("input")
  parent.replaceChild(input, start.nextSibling)
  input.focus()
  patch.values[0] = [input]
  applyPatchIR([start, end], ir, patch)
  assert.equal(parent.ownerDocument.activeElement, input)
  dom.window.close()
})

test("Patch IR rejects document-root ranges before touching the document", () => {
  const dom = new JSDOM("")
  const document = dom.window.document
  const start = document.createComment("start")
  const end = document.createComment("end")
  document.insertBefore(start, document.documentElement)
  document.append(end)
  const original = [...document.childNodes]
  const ir = definePatchIR([{ node: 0, kind: "child-range", endNode: 1 }])
  const patch = allocatePatchValues(ir)
  patch.values[0] = [document.createTextNode("invalid")]
  markPatchDirty(patch.dirty, 0)
  assert.throws(() => applyPatchIR([start, end], ir, patch), /Element or DocumentFragment parent/)
  assert.deepEqual([...document.childNodes], original)
  dom.window.close()
})
