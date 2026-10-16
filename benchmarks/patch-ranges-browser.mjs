// Isolated DOM patch benchmark: excludes application rendering, layout and paint.
// Build @mun/web first. Optional paired source comparison:
// MUN_PATCH_BASE_REF=730348c node benchmarks/patch-ranges-browser.mjs
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import ts from "typescript"
import { chromium } from "@playwright/test"

const count = Number(process.env.MUN_PATCH_ITEMS ?? 1000)
const rounds = Number(process.env.MUN_PATCH_ROUNDS ?? 21)
if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(rounds) || rounds < 1) throw new RangeError("item/round counts must be positive safe integers")
const dataURL = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
const policy = dataURL(readFileSync(new URL("../packages/web/dist/url-policy.js", import.meta.url)))
const moduleURL = code => dataURL(code.replace('"./url-policy.js"', JSON.stringify(policy)))
const variants = []
const ref = process.env.MUN_PATCH_BASE_REF
if (ref) {
  if (!/^[A-Za-z0-9_./~^-]+$/.test(ref) || ref.startsWith("-")) throw new Error("invalid baseline Git ref")
  const source = execFileSync("git", ["show", `${ref}:packages/web/src/patch-ir.ts`], { encoding: "utf8", timeout: 10000 })
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  variants.push([`baseline ${ref}`, moduleURL(compiled)])
}
variants.push(["current", moduleURL(readFileSync(new URL("../packages/web/dist/patch-ir.js", import.meta.url), "utf8"))])
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  const results = await page.evaluate(async ({ variants, count, rounds }) => {
    const results = []
    for (const [label, url] of variants) {
      const { definePatchIR, allocatePatchValues, markPatchDirty, applyPatchIR } = await import(url)
      for (const mode of ["unchanged", "reverse"]) {
        const parent = document.createElement("main")
        document.body.append(parent)
        const start = document.createComment("start")
        const end = document.createComment("end")
        let children = Array.from({ length: count }, () => document.createElement("span"))
        parent.append(start, ...children, end)
        const ir = definePatchIR([{ node: 0, kind: "child-range", endNode: 1 }])
        const patch = allocatePatchValues(ir)
        markPatchDirty(patch.dirty, 0)
        let writes = 0
        for (const method of ["insertBefore", "removeChild"]) {
          const original = parent[method]
          parent[method] = function (...args) { writes++; return original.apply(this, args) }
        }
        const times = []
        for (let round = -5; round < rounds; round++) {
          if (mode === "reverse") children = [...children].reverse()
          patch.values[0] = children
          const begin = performance.now()
          applyPatchIR([start, end], ir, patch)
          if (round >= 0) times.push(performance.now() - begin)
          if (round === -1) writes = 0
        }
        const actual = [...parent.childNodes]
        if (actual.length !== count + 2 || actual[0] !== start || actual.at(-1) !== end || children.some((child, i) => actual[i + 1] !== child)) throw new Error("incorrect range output")
        times.sort((a, b) => a - b)
        results.push({ label, mode, medianMs: times[Math.floor(times.length / 2)], writesPerUpdate: writes / rounds })
        parent.remove()
      }
    }
    return results
  }, { variants, count, rounds })
  console.log(`Chromium, ${count} nodes, ${rounds} measured rounds, 5 warmups; DOM operations only`)
  console.table(results)
} finally {
  await browser.close()
}
