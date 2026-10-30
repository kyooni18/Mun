import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import test from "node:test"
import { chromium, expect } from "@playwright/test"

// The opt-in feature is imported from @mun-ui/ui/progressive-blur by a .mun
// module, rendered on the server and hydrated in a real browser.
async function startServer() {
  const server = spawn(process.execPath, ["examples/progressive-blur/server.mjs"], { cwd: new URL("..", import.meta.url), env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  const url = await new Promise((resolve, reject) => {
    server.stdout.on("data", chunk => {
      output += chunk
      const match = /http:\/\/127\.0\.0\.1:\d+/u.exec(output)
      if (match) resolve(match[0])
    })
    server.stderr.on("data", chunk => { output += chunk })
    server.once("error", reject)
    server.once("exit", code => reject(new Error(`Example server exited ${code}: ${output}`)))
  })
  return { server, url }
}

const boxes = page => page.locator("[data-pb-amount]")
const layerOpacity = (page, index) => boxes(page).nth(index).evaluate(box => Number(getComputedStyle(box.firstElementChild).opacity))

test("ProgressiveBlur: SSR, hydration, every profile and animated amount in Chromium", { timeout: 60_000 }, async () => {
  const { server, url } = await startServer()
  let browser
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.MUN_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MUN_CHROMIUM_EXECUTABLE } : {}) })

    // Server HTML alone already paints every profile.
    const plain = await browser.newPage({ javaScriptEnabled: false })
    await plain.goto(url)
    await expect(boxes(plain)).toHaveCount(5)
    assert.equal(await plain.locator('[data-pb-focus="dot"]').count(), 1)
    await plain.close()

    const page = await browser.newPage()
    const errors = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
    let release
    const attached = new Promise(resolve => { release = resolve })
    await page.route("**/client.ts", async route => { await attached; await route.continue() })
    const navigation = page.goto(url, { waitUntil: "load" })
    await expect(boxes(page)).toHaveCount(5)
    await boxes(page).first().evaluate(node => { window.serverBox = node })
    release()
    await navigation
    await page.waitForFunction(() => document.querySelector("button")?.isConnected)

    // Hydration adopts the server nodes instead of replacing them.
    assert.equal(await boxes(page).first().evaluate(node => node === window.serverBox), true)

    const profiles = await boxes(page).evaluateAll(list => list.map(box => {
      const layers = [...box.children].filter(child => getComputedStyle(child).backdropFilter !== "none")
      return { layers: layers.length, filters: layers.map(layer => getComputedStyle(layer).backdropFilter), masks: layers.map(layer => getComputedStyle(layer).maskImage) }
    }))
    // uniform: one unmasked layer at the full radius.
    assert.deepEqual(profiles[0].filters, ["blur(8px)"])
    assert.deepEqual(profiles[0].masks, ["none"])
    // linear (smooth easing), edge (inverted) and radial use stacked masked layers.
    for (const [index, pattern] of [[1, /linear-gradient\(to right/u], [2, /^linear-gradient\(rgb/u], [3, /radial-gradient/u], [4, /linear-gradient\(to top/u]]) {
      assert.ok(profiles[index].layers > 1, `profile ${index} stacks layers`)
      assert.match(profiles[index].masks[0], pattern)
    }
    // .inverted() moves the strong end of the bottom edge profile away from the edge.
    assert.match(profiles[2].masks.at(-1), /rgba\(0, 0, 0, 0\) 100%\)$/u)
    // The radial profile is clipped to its shape and follows the focus view.
    const radial = boxes(page).nth(3)
    const clipped = await radial.evaluate(box => {
      for (let node = box; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.clipPath !== "none" || (style.overflow === "hidden" && style.borderRadius !== "0px")) return true
      }
      return false
    })
    assert.equal(clipped, true, "in: RoundedRectangle(24) clips the blur")
    await page.waitForFunction(() => document.querySelectorAll("[data-pb-amount]")[3].style.getPropertyValue("--pb-cx") !== "")

    // amount 1 -> 0 animates the layers' opacity instead of jumping.
    assert.equal(await layerOpacity(page, 0), 1)
    await page.getByRole("button", { name: "Toggle blur" }).click()
    await expect(boxes(page).first()).toHaveAttribute("data-pb-amount", "0")
    await page.waitForTimeout(120)
    const midway = await layerOpacity(page, 0)
    assert.ok(midway > 0 && midway < 1, `opacity is mid-transition, got ${midway}`)
    await expect.poll(() => layerOpacity(page, 0)).toBe(0)
    for (let index = 0; index < 5; index++) assert.equal(await layerOpacity(page, index), 0)
    // ... and back.
    await page.getByRole("button", { name: "Toggle blur" }).click()
    await page.waitForTimeout(120)
    const rising = await layerOpacity(page, 0)
    assert.ok(rising > 0 && rising < 1, `opacity rises gradually, got ${rising}`)
    await expect.poll(() => layerOpacity(page, 0)).toBe(1)
    assert.equal(await boxes(page).first().evaluate(node => node === window.serverBox), true, "updates patch the hydrated nodes")
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    server.kill()
  }
})
