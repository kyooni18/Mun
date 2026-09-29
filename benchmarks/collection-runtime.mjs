import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { JSDOM } from "jsdom"
import {
  Element,
  ForEach,
  State,
  defineView,
  initializer,
} from "../packages/core/dist/index.js"
import { compiledCollectionContent } from "../packages/core/dist/internal-runtime.js"
import { mount } from "../packages/web/dist/index.js"

const rowCount = Number.parseInt(process.env.MUN_COLLECTION_ROWS ?? "25000", 10)
if (!Number.isSafeInteger(rowCount) || rowCount < 3) throw new Error("MUN_COLLECTION_ROWS must be an integer >= 3")

function ms(start) {
  return Number((performance.now() - start).toFixed(3))
}

async function flushCollection() {
  await Promise.resolve()
  await Promise.resolve()
}

const dom = new JSDOM("<div id=app></div>")
const container = dom.window.document.querySelector("#app")
assert.ok(container)

const items = State(Array.from({ length: rowCount }, (_, index) => ({
  id: `row-${index}`,
  value: `Row ${index}`,
})))

let parentRuns = 0
let rowRuns = 0
let keyRuns = 0
const content = compiledCollectionContent(
  item => Element("span", { "data-row": item.id }, item.value),
  {
    kind: "flat-text-host",
    indexIndependent: true,
    evaluateKey: item => {
      keyRuns += 1
      return item.id
    },
    evaluate: item => {
      rowRuns += 1
      return { type: "span", props: { "data-row": item.id }, text: item.value }
    },
  },
)

const App = defineView("CompiledCollectionBenchmark", {
  initializers: [initializer("CompiledCollectionBenchmark()", args => args.length === 0)],
  body: () => {
    parentRuns += 1
    return Element(
      "section",
      { "data-benchmark": "compiled-collection" },
      ForEach.viewType.createNodeCompiled(1, [items, item => item.id, content]),
    )
  },
})

const mountStart = performance.now()
const unmount = mount(App(), container)
const mountMs = ms(mountStart)
assert.equal(parentRuns, 1)
assert.equal(rowRuns, rowCount)
assert.equal(keyRuns, rowCount)
assert.equal(container.querySelectorAll("span").length, rowCount)

const middle = Math.floor(rowCount / 2)
const middleKey = `row-${middle}`
const middleBefore = container.querySelector(`[data-row="${middleKey}"]`)
assert.ok(middleBefore)

rowRuns = 0
keyRuns = 0
let start = performance.now()
items.value[middle] = { id: middleKey, value: "Row changed" }
await flushCollection()
const replaceOneMs = ms(start)
assert.equal(parentRuns, 1)
assert.equal(rowRuns, 1)
assert.equal(keyRuns, 1)
assert.strictEqual(container.querySelector(`[data-row="${middleKey}"]`), middleBefore)
assert.equal(middleBefore.textContent, "Row changed")

rowRuns = 0
keyRuns = 0
start = performance.now()
items.value[middle].value = "Row mutated"
await flushCollection()
const mutateOneMs = ms(start)
assert.equal(parentRuns, 1)
assert.equal(rowRuns, 1)
assert.equal(keyRuns, 1)
assert.strictEqual(container.querySelector(`[data-row="${middleKey}"]`), middleBefore)
assert.equal(middleBefore.textContent, "Row mutated")

rowRuns = 0
keyRuns = 0
start = performance.now()
items.value.push({ id: "row-extra", value: "Extra" })
await flushCollection()
const pushOneMs = ms(start)
assert.equal(parentRuns, 1)
assert.equal(rowRuns, 1)
assert.equal(keyRuns, 1)
const section = container.querySelector("section")
assert.ok(section)
const appended = section.lastElementChild
assert.ok(appended)
assert.equal(appended.getAttribute("data-row"), "row-extra")
assert.equal(appended.textContent, "Extra")

rowRuns = 0
keyRuns = 0
start = performance.now()
items.value.pop()
await flushCollection()
const popOneMs = ms(start)
assert.equal(parentRuns, 1)
assert.equal(rowRuns, 0)
assert.equal(keyRuns, 0)
assert.equal(container.querySelector("[data-row=row-extra]"), null)

const firstBefore = container.querySelector("[data-row=row-0]")
const lastBefore = container.querySelector(`[data-row="row-${rowCount - 1}"]`)
assert.ok(firstBefore)
assert.ok(lastBefore)
rowRuns = 0
keyRuns = 0
start = performance.now()
items.value.reverse()
await flushCollection()
const reverseMs = ms(start)
assert.equal(parentRuns, 1)
assert.equal(rowRuns, 0)
assert.equal(keyRuns, 0)
assert.strictEqual(container.querySelector("span:first-child"), lastBefore)
assert.strictEqual(container.querySelector("span:last-child"), firstBefore)

const result = {
  rows: rowCount,
  mountMs,
  replaceOneMs,
  mutateOneMs,
  pushOneMs,
  popOneMs,
  reverseMs,
  invalidation: {
    parentRuns,
    replaceOne: { keyRuns: 1, rowRuns: 1 },
    mutateOne: { keyRuns: 1, rowRuns: 1 },
    pushOne: { keyRuns: 1, rowRuns: 1 },
    popOne: { keyRuns: 0, rowRuns: 0 },
    reverse: { keyRuns: 0, rowRuns: 0 },
  },
}

console.log(JSON.stringify(result, null, 2))
unmount()
dom.window.close()
