import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import test from "node:test"
import { chromium, expect } from "@playwright/test"

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test("Mun-authored counter/profile: real SSR, hydration, input stability and async recovery", { timeout: 60000 }, async () => {
  const server = spawn(process.execPath, ["examples/language-web/server.mjs"], { cwd: new URL("..", import.meta.url), env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  const url = await new Promise((resolve, reject) => {
    server.stdout.on("data", chunk => {
      output += chunk
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output)
      if (match) resolve(match[0])
    })
    server.stderr.on("data", chunk => { output += chunk })
    server.once("error", reject)
    server.once("exit", code => reject(new Error(`Demo server exited ${code}: ${output}`)))
  })
  let browser
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.MUN_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MUN_CHROMIUM_EXECUTABLE } : {}) })
    const plain = await browser.newPage({ javaScriptEnabled: false })
    await plain.goto(url)
    await expect(plain.getByRole("textbox", { name: "Display name" })).toBeVisible()
    await expect(plain.getByText("Count: 0", { exact: true })).toBeVisible()
    await plain.close()

    const page = await browser.newPage()
    const errors = []
    page.on("pageerror", error => errors.push(error.message))
    const attachment = deferred()
    await page.route("**/client.ts", async route => { await attachment.promise; await route.continue() })
    const navigation = page.goto(url, { waitUntil: "load" })
    const field = page.getByRole("textbox", { name: "Display name" })
    await expect(field).toBeVisible()
    await field.fill("Early edit")
    await field.evaluate(node => { window.earlyInput = node; node.setSelectionRange(2, 5) })
    attachment.resolve()
    await navigation
    // The update proves attachment has completed and exercises an unrelated render.
    const update = page.getByRole("button", { name: "Update unrelated count" })
    await update.focus()
    await update.press("Enter")
    await expect(page.getByText("Unrelated count: 1", { exact: true })).toBeVisible()
    await field.focus()
    await field.evaluate(node => node.setSelectionRange(2, 5))
    await update.evaluate(node => node.click())
    await expect(page.getByText("Unrelated count: 2", { exact: true })).toBeVisible()
    assert.deepEqual(await field.evaluate(node => ({ same: node === window.earlyInput, focused: document.activeElement === node, value: node.value, start: node.selectionStart, end: node.selectionEnd })), { same: true, focused: true, value: "Early edit", start: 2, end: 5 })
    await page.getByRole("button", { name: "Increment", exact: true }).click()
    await expect(page.getByText("Count: 1", { exact: true })).toBeVisible()

    // Enter submits a native form; the early edit must have reached Mun State.
    await field.press("Enter")
    await expect(page.getByRole("status")).toHaveText("Saved: Early edit")
    await field.fill("")
    let invalidRequests = 0
    const countRequest = request => { if (request.url().endsWith("/api/profile")) invalidRequests++ }
    page.on("request", countRequest)
    await field.press("Enter")
    await expect(page.getByRole("status")).toHaveText("Enter a display name.")
    assert.equal(invalidRequests, 0)
    page.off("request", countRequest)

    // Real demo endpoint failure, followed by a successful retry.
    await field.fill("fail")
    await field.press("Enter")
    await expect(page.getByRole("status")).toHaveText("Save failed. Try again.")
    await field.fill("Grace")
    await field.press("Enter")
    await expect(page.getByRole("status")).toHaveText("Saved: Grace")

    // Also recover from a network rejection rather than an HTTP status.
    await page.route("**/api/profile", route => route.abort("failed"), { times: 1 })
    await field.press("Enter")
    await expect(page.getByRole("status")).toHaveText("Save failed. Try again.")
    await field.press("Enter")
    await expect(page.getByRole("status")).toHaveText("Saved: Grace")

    const gates = new Map()
    const arrivals = []
    await page.route("**/api/profile", async route => {
      const { name } = route.request().postDataJSON()
      arrivals.push(name)
      const gate = gates.get(name)
      if (gate) await gate.promise
      try { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ name }) }) } catch { /* aborted transport */ }
    })
    const slow = deferred()
    gates.set("Older", slow)
    await field.fill("Older")
    await field.press("Enter")
    await expect.poll(() => arrivals.includes("Older")).toBe(true)
    await field.fill("Newer")
    await field.press("Enter")
    await expect(page.getByRole("status")).toHaveText("Saved: Newer")
    slow.resolve()
    await update.click()
    await expect(page.getByRole("status")).toHaveText("Saved: Newer")

    const cancelled = deferred()
    gates.set("Cancelled request", cancelled)
    await field.fill("Cancelled request")
    await field.press("Enter")
    await expect.poll(() => arrivals.includes("Cancelled request")).toBe(true)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(page.getByRole("status")).toHaveText("Cancelled")
    cancelled.resolve()
    await update.click()
    await expect(page.getByRole("status")).toHaveText("Cancelled")

    const removed = deferred()
    gates.set("Removed", removed)
    await field.fill("Removed")
    await field.press("Enter")
    await expect.poll(() => arrivals.includes("Removed")).toBe(true)
    await page.getByRole("button", { name: "Toggle profile" }).click()
    await expect(field).toHaveCount(0)
    removed.resolve()
    await page.getByRole("button", { name: "Toggle profile" }).click()
    await expect(field).toHaveValue("")
    await expect(page.getByRole("status")).toHaveText("Ready")
    assert.deepEqual(errors, [])
    await page.screenshot({ path: "output/language-web-browser.png", fullPage: true })
  } finally {
    await browser?.close()
    const stopped = once(server, "exit")
    server.kill("SIGTERM")
    await stopped
  }
})
