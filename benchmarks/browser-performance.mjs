import { createReadStream, existsSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, join, resolve } from "node:path"
import { chromium } from "@playwright/test"

const root = resolve("browser-benchmark-dist")
if (!existsSync(root)) throw new Error("browser benchmark bundle is missing; run the Vite build first")

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
])

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname
  const candidate = join(root, pathname === "/" ? "index.html" : pathname.slice(1))
  const file = existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(root, "index.html")
  response.writeHead(200, { "content-type": mime.get(extname(file)) ?? "application/octet-stream", "cache-control": "no-store" })
  createReadStream(file).pipe(response)
})

await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen))
const address = server.address()
if (!address || typeof address === "string") throw new Error("browser benchmark server did not expose a TCP port")

const count = Number(process.env.MUN_BROWSER_BENCH_ITEMS ?? 5000)
const rounds = Number(process.env.MUN_BROWSER_BENCH_ROUNDS ?? 7)
const warmups = Number(process.env.MUN_BROWSER_BENCH_WARMUPS ?? 3)
const only = (process.env.MUN_BROWSER_BENCH_ONLY ?? "").split(",").map(value => value.trim()).filter(Boolean)
const ci = process.env.MUN_BROWSER_BENCH_CI === "1"
if (ci && only.length > 0) throw new Error("MUN_BROWSER_BENCH_ONLY cannot be used with the CI performance gate")

async function launchBenchmarkBrowser() {
  const executablePath = process.env.MUN_BROWSER_EXECUTABLE
  if (executablePath) {
    if (!existsSync(executablePath)) throw new Error(`MUN_BROWSER_EXECUTABLE does not exist: ${executablePath}`)
    return chromium.launch({ headless: true, executablePath })
  }

  const bundled = chromium.executablePath()
  if (bundled && existsSync(bundled)) return chromium.launch({ headless: true })

  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ headless: true, channel })
    } catch (error) {
      if (!String(error).includes("Executable doesn't exist")) throw error
    }
  }

  throw new Error(
    `No Chromium executable is available for the browser benchmark. `
    + `Playwright expected ${bundled || "a bundled browser"}; run \`pnpm exec playwright install chromium\` `
    + `or set MUN_BROWSER_EXECUTABLE to a compatible Chromium/Chrome binary.`,
  )
}

const browser = await launchBenchmarkBrowser()
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle" })
  const result = await page.evaluate(async ({ count, rounds, warmups, only }) => window.__munBenchmark.run({ count, rounds, warmups, only }), { count, rounds, warmups, only })
  console.log(`Production Chromium benchmark: ${count} rows, ${warmups} warmups, median of ${rounds} rounds`)
  for (const [name, value] of Object.entries(result)) console.log(`${name}: ${value.toFixed(2)} ms`)

  const limits = {
    "mun.react.single": 80,
    "mun.vue.single": 80,
    "mun.web.single": 80,
    "mun.react.compiled.single": 50,
    "mun.react.compiler-map.single": 40,
    "mun.vue.compiled.single": 50,
    "mun.vue.compiler-map.single": 40,
    "mun.web.compiled.single": 50,
    "mun.web.compiler-map.single": 40,
    "mun.react.owned.single": 25,
    "mun.vue.owned.single": 25,
    "mun.web.owned.single": 10,
    "authored.web.single": 50,
    "authored.react.single": 60,
    "authored.vue.single": 60,
    "misutgaru.web.reaction.single": 15,
    "mun.react.full": 150,
    "mun.react.compiled.full": 150,
    "mun.react.compiler-map.full": 120,
    "mun.vue.full": 150,
    "mun.vue.compiled.full": 150,
    "mun.vue.compiler-map.full": 120,
    "mun.web.full": 150,
    "mun.web.compiled.full": 150,
    "mun.web.compiler-map.full": 120,
    "authored.web.full": 120,
    "authored.react.full": 120,
    "authored.vue.full": 120,
    "mun.react.compiled.reverse": 120,
    "mun.vue.compiled.reverse": 80,
    "mun.web.compiled.reverse": 80,
    "mun.web.hydration.static": 100,
    "mun.web.hydration.state": 130,
  }
  if (ci) {
    for (const [name, limit] of Object.entries(limits)) {
      const value = result[name]
      if (!Number.isFinite(value) || value > limit) throw new Error(`${name} exceeded ${limit} ms: ${value?.toFixed?.(2) ?? value} ms`)
    }
    if (result["mun.react.compiled.single"] > result["mun.react.single"] * 1.25) throw new Error("React compiled collection regressed behind generic Mun React")
    if (result["mun.react.compiler-map.single"] > result["mun.react.compiled.single"] * 1.25) throw new Error("React compiler-owned State map single update regressed behind compiled replacement")
    if (result["mun.vue.compiled.single"] > result["mun.vue.single"] * 1.25) throw new Error("Vue compiled collection regressed behind generic Mun Vue")
    if (result["mun.vue.compiler-map.single"] > result["mun.vue.compiled.single"] * 1.25) throw new Error("Vue compiler-owned State map single update regressed behind compiled replacement")
    if (result["mun.web.compiled.single"] > result["mun.web.single"] * 1.25) throw new Error("Web compiled collection regressed behind generic Mun Web")
    if (result["mun.web.compiler-map.single"] > result["mun.web.compiled.single"] * 1.25) throw new Error("Web compiler-owned State map single update regressed behind compiled replacement")
    if (result["mun.react.owned.single"] > result["mun.react.compiled.single"] * 1.25) throw new Error("React owned mutation regressed behind compiled replacement")
    if (result["mun.vue.owned.single"] > result["mun.vue.compiled.single"] * 1.25) throw new Error("Vue owned mutation regressed behind compiled replacement")
    if (result["mun.web.owned.single"] > Math.max(1, result["mun.web.compiled.single"] * 1.25)) throw new Error("Web owned mutation regressed behind compiled replacement")
    if (result["authored.web.single"] > result["mun.web.compiler-map.single"] * 1.75) throw new Error("Authored Web single update is not reaching compiler-owned performance")
    if (result["authored.react.single"] > result["mun.react.compiler-map.single"] * 1.75) throw new Error("Authored React single update is not reaching compiler-owned performance")
    if (result["authored.vue.single"] > result["mun.vue.compiler-map.single"] * 1.75) throw new Error("Authored Vue single update is not reaching compiler-owned performance")
    if (result["mun.react.compiled.full"] > result["mun.react.full"] * 1.5) throw new Error("React compiled full update regressed behind generic Mun React")
    if (result["mun.react.compiler-map.full"] > result["mun.react.compiled.full"] * 1.25) throw new Error("React compiler-owned State map regressed behind compiled replacement")
    if (result["mun.vue.compiled.full"] > result["mun.vue.full"] * 1.5) throw new Error("Vue compiled full update regressed behind generic Mun Vue")
    if (result["mun.vue.compiler-map.full"] > result["mun.vue.compiled.full"] * 1.25) throw new Error("Vue compiler-owned State map regressed behind compiled replacement")
    if (result["mun.web.compiled.full"] > result["mun.web.full"] * 1.5) throw new Error("Web compiled full update regressed behind generic Mun Web")
    if (result["mun.web.compiler-map.full"] > result["mun.web.compiled.full"] * 1.25) throw new Error("Web compiler-owned State map regressed behind compiled replacement")
    if (result["authored.web.full"] > result["mun.web.compiler-map.full"] * 1.75) throw new Error("Authored Web full update is not reaching compiler-owned performance")
    if (result["authored.react.full"] > result["mun.react.compiler-map.full"] * 1.75) throw new Error("Authored React full update is not reaching compiler-owned performance")
    if (result["authored.vue.full"] > result["mun.vue.compiler-map.full"] * 1.75) throw new Error("Authored Vue full update is not reaching compiler-owned performance")
    if (result["mun.react.compiled.reverse"] > result["mun.react.reverse"] * 1.25) throw new Error("React compiled reverse regressed behind generic Mun React")
    if (result["mun.vue.compiled.reverse"] > result["mun.vue.reverse"] * 1.25) throw new Error("Vue compiled reverse regressed behind generic Mun Vue")
    if (result["mun.web.compiled.reverse"] > result["mun.web.reverse"] * 1.25) throw new Error("Web compiled reverse regressed behind generic Mun Web")
    if (result["mun.web.hydration.state"] > result["mun.web.hydration.static"] * 2.5) throw new Error("State hydration regressed excessively behind static hydration")
  }
} finally {
  await browser.close()
  await new Promise(resolveClose => server.close(resolveClose))
}
