import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '@playwright/test'

const root = process.cwd()
const args = new Set(process.argv.slice(2))
const smokeOnly = args.delete('--smoke')
if (args.size > 0) throw new Error(`Unknown option(s): ${[...args].join(', ')}`)

async function injectBuild(page, dir) {
  const dist = path.join(root, dir)
  const entries = (await fs.readdir(dist)).filter(name => name.endsWith('.html'))
  assert.equal(entries.length, 1, `expected one HTML entry in ${dir}`)
  let html = await fs.readFile(path.join(dist, entries[0]), 'utf8')
  const scripts = [...html.matchAll(/<script\b[^>]*src=["']([^"']+)["'][^>]*><\/script>/gi)].map(m => m[1])
  const styles = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi)].map(m => m[1])
  html = html
    .replace(/<script\b[^>]*src=["'][^"']+["'][^>]*><\/script>/gi, '')
    .replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["'][^"']+["'][^>]*>/gi, '')
  await page.setContent(html, { waitUntil: 'domcontentloaded' })
  for (const href of styles) {
    const css = await fs.readFile(path.join(dist, href.replace(/^\//, '')), 'utf8')
    await page.addStyleTag({ content: css })
  }
  for (const src of scripts) {
    const js = await fs.readFile(path.join(dist, src.replace(/^\//, '')), 'utf8')
    await page.addScriptTag({ content: js, type: 'module' })
  }
}

function captureErrors(page) {
  const errors = []
  page.on('pageerror', e => errors.push(e))
  page.on('console', m => { if (m.type() === 'error') errors.push(new Error(m.text())) })
  return errors
}

async function validateDemo(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = captureErrors(page)
  await injectBuild(page, 'demo-dist')
  await page.getByText('DEMO', { exact: true }).waitFor()
  assert.ok(await page.locator('[class*="demoTitleModule"]').first().isVisible())
  const text = page.getByRole('textbox', { name: 'Demo text field' })
  await text.fill('Mün UI')
  assert.equal(await text.inputValue(), 'Mün UI')
  const slider = page.getByRole('slider', { name: 'Demo slider' })
  await slider.fill('80')
  assert.equal(await slider.inputValue(), '80')
  const checkbox = page.getByRole('checkbox', { name: 'Demo checkbox' })
  assert.equal(await checkbox.isChecked(), true)
  await checkbox.click()
  assert.equal(await checkbox.isChecked(), false)
  assert.ok(await page.locator('[aria-label="Demo progress"]').isVisible())
  assert.deepEqual(errors, [])
  await page.close()
}

async function validateCounter(browser, dir, label) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = captureErrors(page)
  await injectBuild(page, dir)
  const count = page.getByText('Count: 0', { exact: false })
  await count.waitFor()
  assert.equal(await count.evaluate(el => getComputedStyle(el).fontSize), '24px', label)
  const button = page.getByRole('button', { name: 'Increment' })
  const handle = await button.elementHandle()
  await button.click()
  await page.getByText('Count: 1', { exact: false }).waitFor()
  assert.ok(handle, label)
  assert.equal(await page.evaluate(el => document.querySelector('button') === el, handle), true, label)
  assert.deepEqual(errors, [], label)
  await page.close()
}

async function validateParity(browser, dir, renderer) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = captureErrors(page)
  await injectBuild(page, dir)
  const rootEl = page.locator('[data-testid="parity-root"]')
  await rootEl.waitFor()
  assert.ok((await rootEl.boundingBox())?.width >= 320, renderer)
  const count = page.locator('[data-testid="count"]')
  assert.equal(await count.textContent(), 'Count: 0', renderer)
  await page.getByRole('button', { name: 'Increment' }).click()
  assert.equal(await count.textContent(), 'Count: 1', renderer)
  const name = page.getByRole('textbox', { name: 'Name' })
  await name.fill('Parity')
  assert.equal(await name.inputValue(), 'Parity', renderer)
  const enabled = page.getByRole('checkbox', { name: 'Enabled' })
  await enabled.click()
  assert.equal(await enabled.isChecked(), true, renderer)
  const rowA = page.locator('[data-row="a"]')
  await rowA.click()
  assert.equal(await rowA.textContent(), 'a:1', renderer)
  await page.getByRole('button', { name: 'Reorder' }).click()
  assert.deepEqual(await page.locator('[data-row]').evaluateAll(es => es.map(e => e.getAttribute('data-row'))), ['b', 'a'], renderer)
  assert.equal(await page.locator('[data-row="a"]').textContent(), 'a:1', renderer)
  const custom = page.locator('x-mun-parity')
  assert.equal(await custom.getAttribute('data-testid'), 'custom-element', renderer)
  assert.ok((await custom.boundingBox())?.width > 0, renderer)
  await page.locator('[data-testid="geometry"]').waitFor()
  await page.locator('[data-testid="lazy-content"]').waitFor()
  assert.deepEqual(errors, [], renderer)
  await page.close()
}

async function validateShowcase(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = captureErrors(page)
  await injectBuild(page, 'showcase-dist')
  await page.locator('[data-testid="showcase-root"]').waitFor()
  assert.equal(await page.locator('[data-row]').count(), 4)
  const filter = page.getByRole('textbox', { name: 'Filter modules' })
  await filter.fill('runtime')
  assert.equal(await page.locator('[data-row]').count(), 1)
  assert.equal(await page.locator('[data-row]').first().getAttribute('data-row'), 'runtime')
  await filter.fill('')
  const enabled = page.getByRole('checkbox', { name: 'Enable live updates' })
  assert.equal(await enabled.isChecked(), true)
  await enabled.click()
  assert.equal(await enabled.isChecked(), false)
  assert.equal(await page.getByText('Paused').count(), 1)
  await page.getByRole('button', { name: 'Reorder' }).click()
  assert.deepEqual(await page.locator('[data-row]').evaluateAll(es => es.map(e => e.getAttribute('data-row'))), ['runtime', 'renderer', 'tooling', 'compiler'])
  await page.getByRole('button', { name: 'Refresh' }).click()
  await page.getByText('1', { exact: true }).first().waitFor()
  assert.ok(await page.getByText('1', { exact: true }).count() >= 1)
  assert.deepEqual(errors, [])
  await page.close()
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.MUN_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MUN_CHROMIUM_EXECUTABLE } : {}),
})
try {
  if (smokeOnly) {
    await validateDemo(browser)
    console.log('react demo: OK')
    await validateCounter(browser, 'web-demo-dist', 'web')
    console.log('web demo: OK')
    console.log('production Chromium smoke: 2/2 OK')
  } else {
    await validateDemo(browser)
    console.log('react demo: OK')
    await validateCounter(browser, 'vue-demo-dist', 'vue')
    console.log('vue demo: OK')
    await validateCounter(browser, 'web-demo-dist', 'web')
    console.log('web demo: OK')
    await validateParity(browser, 'parity-react-dist', 'react parity')
    console.log('react parity: OK')
    await validateParity(browser, 'parity-vue-dist', 'vue parity')
    console.log('vue parity: OK')
    await validateParity(browser, 'parity-web-dist', 'web parity')
    console.log('web parity: OK')
    await validateShowcase(browser)
    console.log('showcase: OK')
    console.log('production Chromium validation: 7/7 OK')
  }
} finally {
  await browser.close()
}
