import assert from "node:assert/strict"
import test from "node:test"

test("the medium Mun showcase survives real browser state and collection interactions", { skip: !process.env.MUN_SHOWCASE_URL }, async () => {
  const { chromium } = await import("@playwright/test")
  const browser = await chromium.launch({ headless: true, ...(process.env.MUN_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MUN_CHROMIUM_EXECUTABLE } : {}) })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on("pageerror", error => errors.push(error))
    page.on("console", message => { if (message.type() === "error") errors.push(new Error(message.text())) })
    await page.goto(process.env.MUN_SHOWCASE_URL, { waitUntil: "networkidle" })
    await page.locator('[data-testid="showcase-root"]').waitFor()
    assert.equal(await page.locator("[data-row]").count(), 4)

    const filter = page.getByRole("textbox", { name: "Filter modules" })
    await filter.fill("runtime")
    assert.equal(await page.locator("[data-row]").count(), 1)
    assert.equal(await page.locator("[data-row]").first().getAttribute("data-row"), "runtime")
    await filter.fill("")

    const enabled = page.getByRole("checkbox", { name: "Enable live updates" })
    assert.equal(await enabled.isChecked(), true)
    await enabled.click()
    assert.equal(await enabled.isChecked(), false)
    assert.equal(await page.getByText("Paused").count(), 1)

    await page.getByRole("button", { name: "Reorder" }).click()
    assert.deepEqual(await page.locator("[data-row]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-row"))), ["runtime", "renderer", "tooling", "compiler"])

    await page.getByRole("button", { name: "Refresh" }).click()
    await page.getByText("1", { exact: true }).waitFor()
    assert.equal(await page.getByText("1", { exact: true }).count() >= 1, true)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
