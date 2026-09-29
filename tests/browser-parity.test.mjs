import assert from "node:assert/strict"
import test from "node:test"

const targets = [
  ["react", process.env.MUN_PARITY_REACT_URL],
  ["vue", process.env.MUN_PARITY_VUE_URL],
  ["web", process.env.MUN_PARITY_WEB_URL],
]

test("the same Mün graph preserves live parity in React, Vue, and Web", { skip: targets.some(([, url]) => !url) }, async () => {
  const { chromium } = await import("@playwright/test")
  const browser = await chromium.launch({ headless: true, ...(process.env.MUN_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MUN_CHROMIUM_EXECUTABLE } : {}) })
  try {
    for (const [renderer, url] of targets) {
      const page = await browser.newPage()
      const errors = []
      page.on("pageerror", error => errors.push(error))
      page.on("console", message => { if (message.type() === "error") errors.push(new Error(message.text())) })
      await page.goto(url, { waitUntil: "networkidle" })

      const root = page.locator('[data-testid="parity-root"]')
      await root.waitFor()
      const rootBox = await root.boundingBox()
      assert.ok(rootBox && rootBox.width >= 320 && rootBox.height > 0, renderer)

      const count = page.locator('[data-testid="count"]')
      assert.equal(await count.textContent(), "Count: 0", renderer)
      const increment = page.getByRole("button", { name: "Increment" })
      const incrementHandle = await increment.elementHandle()
      await increment.click()
      assert.equal(await count.textContent(), "Count: 1", renderer)
      assert.ok(incrementHandle)
      assert.equal(await page.evaluate(element => document.querySelector('[data-testid="count"]')?.textContent, incrementHandle), "Count: 1")

      const name = page.getByRole("textbox", { name: "Name" })
      await name.fill("Parity")
      await name.focus()
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Name")
      assert.equal(await name.inputValue(), "Parity")

      const enabled = page.getByRole("checkbox", { name: "Enabled" })
      await enabled.click()
      assert.equal(await enabled.isChecked(), true, renderer)

      const rowA = page.locator('[data-row="a"]')
      await rowA.click()
      assert.equal(await rowA.textContent(), "a:1", renderer)
      await page.getByRole("button", { name: "Reorder" }).click()
      assert.deepEqual(await page.locator("[data-row]").evaluateAll(elements => elements.map(element => element.getAttribute("data-row"))), ["b", "a"], renderer)
      assert.equal(await page.locator('[data-row="a"]').textContent(), "a:1", renderer)

      const custom = page.locator("x-mun-parity")
      assert.equal(await custom.getAttribute("data-testid"), "custom-element")
      const customBox = await custom.boundingBox()
      assert.ok(customBox && customBox.width > 0 && customBox.height > 0, renderer)
      const geometry = page.locator('[data-testid="geometry"]')
      await geometry.waitFor()
      assert.ok((await geometry.boundingBox())?.width > 0, renderer)
      await page.locator('[data-testid="lazy-content"]').waitFor()
      assert.deepEqual(errors, [], renderer)
      await page.close()
    }
  } finally {
    await browser.close()
  }
})
