import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { fileURLToPath } from "node:url"

// Real layout is required: lazy ranges, row measurement and scroll anchoring
// all read live geometry, which jsdom does not provide.
const entry = `
import { LazyVStack, ScrollView, Text, State } from ${JSON.stringify(fileURLToPath(new URL("../packages/core/dist/compat.js", import.meta.url)))}
import { mount } from ${JSON.stringify(fileURLToPath(new URL("../packages/web/dist/index.js", import.meta.url)))}
const tick = State(0)
const rows = Array.from({ length: 5000 }, (_, index) => ({ index, height: 30 + (index % 7) * 6 }))
mount(ScrollView(LazyVStack({ estimatedItemSize: 40, overscan: 3 },
  ...rows.map(row => Text(\`row \${row.index} \${tick.value}\`).frame({ height: row.height })),
)).style({ height: "400px" }), document.getElementById("root"))
window.__tick = tick
`

const viewEntry = `
import { LazyVStack, ScrollView, Text, VStack, defineView, initializer } from ${JSON.stringify(fileURLToPath(new URL("../packages/core/dist/compat.js", import.meta.url)))}
import { mount } from ${JSON.stringify(fileURLToPath(new URL("../packages/web/dist/index.js", import.meta.url)))}
window.__bodies = { sidebar: 0 }
const Sidebar = defineView("Sidebar", { initializers: [initializer("Sidebar()", args => args.length === 0)], body: () => { window.__bodies.sidebar += 1; return VStack(Text("nav")) } })
const rows = Array.from({ length: 5000 }, (_, index) => index)
const List = defineView("List", { initializers: [initializer("List()", args => args.length === 0)], body: () =>
  ScrollView(LazyVStack({ estimatedItemSize: 40, overscan: 3 }, ...rows.map(index => Text(\`row \${index}\`).frame({ height: 40 })))).style({ height: "400px" }) })
mount(VStack(Sidebar(), List()), document.getElementById("root"))
`

async function openPage(source) {
  const { build } = await import("esbuild")
  const { chromium } = await import("@playwright/test")
  const bundle = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: "js" }, bundle: true, format: "iife", write: false, logLevel: "silent" })
  const script = bundle.outputFiles[0].text
  const server = createServer((request, response) => {
    if (request.url === "/bundle.js") response.end(script)
    else response.end('<!doctype html><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body>')
  }).listen(0)
  const browser = await chromium.launch({ headless: true, ...(process.env.MUN_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MUN_CHROMIUM_EXECUTABLE } : {}) })
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  const errors = []
  page.on("pageerror", error => errors.push(error))
  await page.goto(`http://localhost:${server.address().port}/`)
  await page.waitForSelector("[data-mun-lazy-item]")
  const close = async () => { await browser.close(); server.close() }
  return { page, errors, close }
}

async function scrollSteps(page, steps) {
  for (let step = 0; step < steps; step += 1) {
    await page.evaluate(() => { document.querySelector('[data-mun="ScrollView"]').scrollTop += 400 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  await page.waitForTimeout(100)
}

function visibleRows(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-mun="ScrollView"]')
    const viewport = scroller.getBoundingClientRect()
    return [...document.querySelectorAll("[data-mun-lazy-item]")]
      .filter(item => { const box = item.getBoundingClientRect(); return box.bottom > viewport.top && box.top < viewport.bottom })
      .map(item => ({ slot: Number(item.dataset.munLazyIndex), row: Number(item.textContent.split(" ")[1]) }))
  })
}

test("lazy stacks keep the scrolled window materialized in a real browser", async () => {
  const { page, errors, close } = await openPage(entry)
  try {
    await scrollSteps(page, 40)
    const scrollTop = await page.evaluate(() => document.querySelector('[data-mun="ScrollView"]').scrollTop)
    const rows = await visibleRows(page)
    assert.ok(rows.length > 0, "the scrolled viewport must show rows")
    // Rows average 48px, so 16000px lands near row 333.
    assert.ok(Math.abs(rows[0].row - scrollTop / 48) < 20, `row ${rows[0].row} does not match scrollTop ${scrollTop}`)
    for (const row of rows) assert.equal(row.slot, row.row, "a reused row wrapper must report the slot it renders")
    await page.evaluate(() => { window.__tick.value += 1 })
    await page.waitForTimeout(100)
    assert.equal((await visibleRows(page))[0].row, rows[0].row, "a state update must not move the window")
    assert.deepEqual(errors, [])
  } finally {
    await close()
  }
})

test("a lazy stack inside a View scrolls without re-rendering unrelated Views", async () => {
  const { page, errors, close } = await openPage(viewEntry)
  try {
    const before = await page.evaluate(() => window.__bodies.sidebar)
    await scrollSteps(page, 40)
    const rows = await visibleRows(page)
    assert.ok(rows.length > 0 && Math.abs(rows[0].row - 400) <= 2, `expected row ~400, got ${rows[0]?.row}`)
    assert.equal(await page.evaluate(() => window.__bodies.sidebar), before, "scrolling must not re-run sibling View bodies")
    assert.deepEqual(errors, [])
  } finally {
    await close()
  }
})
