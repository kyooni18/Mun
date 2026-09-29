import assert from "node:assert/strict"
import test from "node:test"

const baseURL = process.env.MUN_WEB_BROWSER_URL

test("Mun Web adapter example is interactive in a real browser", { skip: !baseURL }, async () => {
  const { chromium } = await import("@playwright/test")
  const browser = await chromium.launch({ headless: true, ...(process.env.MUN_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MUN_CHROMIUM_EXECUTABLE } : {}) })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on("pageerror", error => errors.push(error))
    page.on("console", message => { if (message.type() === "error") errors.push(new Error(message.text())) })
    await page.goto(baseURL, { waitUntil: "networkidle" })
    const count = page.getByText("Count: 0", { exact: false })
    await assert.doesNotReject(() => count.waitFor())
    const countBox = await count.boundingBox()
    assert.ok(countBox && countBox.width > 0 && countBox.height > 0)
    assert.equal(await count.evaluate(element => getComputedStyle(element).fontSize), "24px")
    const button = page.getByRole("button", { name: "Increment" })
    const buttonHandle = await button.elementHandle()
    await button.focus()
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Increment")
    await button.click()
    await assert.doesNotReject(() => page.getByText("Count: 1", { exact: false }).waitFor())
    assert.ok(buttonHandle)
    assert.equal(await page.evaluate(element => document.querySelector("button") === element, buttonHandle), true)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
