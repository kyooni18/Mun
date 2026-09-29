import assert from 'node:assert/strict'
import test from 'node:test'

const baseURL = process.env.MUN_BROWSER_URL

test('Mun demo is interactive in a real browser', { skip: !baseURL }, async () => {
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch({ headless: true, ...(process.env.MUN_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MUN_CHROMIUM_EXECUTABLE } : {}) })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error))
    page.on('console', message => { if (message.type() === 'error') errors.push(new Error(message.text())) })
    await page.goto(baseURL, { waitUntil: 'networkidle' })
    assert.ok(await page.getByText('DEMO', { exact: true }).isVisible())
    assert.ok(await page.locator('[class*="demoTitleModule"]').first().isVisible())
    const textField = page.getByRole('textbox', { name: 'Demo text field' })
    await textField.fill('Mün UI')
    assert.equal(await textField.inputValue(), 'Mün UI')
    await textField.focus()
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Demo text field')
    const textFieldBox = await textField.boundingBox()
    assert.ok(textFieldBox && textFieldBox.width > 0 && textFieldBox.height > 0)

    const slider = page.getByRole('slider', { name: 'Demo slider' })
    await slider.fill('80')
    assert.equal(await slider.inputValue(), '80')

    const checkbox = page.getByRole('checkbox', { name: 'Demo checkbox' })
    assert.equal(await checkbox.isChecked(), true)
    await checkbox.click()
    assert.equal(await checkbox.isChecked(), false)
    const progress = page.locator('[aria-label="Demo progress"]')
    assert.ok(await progress.isVisible())
    await page.getByRole('button', { name: 'Button' }).click()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth >= document.documentElement.clientWidth))
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
