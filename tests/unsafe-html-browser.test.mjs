import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium, expect } from '@playwright/test'
import { munPlugin } from '../packages/vite/dist/index.js'

const root = new URL('..', import.meta.url)
test('compiled trusted markup hydrates, updates and unmounts in Chromium', async () => {
  const dir = await mkdtemp(new URL('.unsafe-html-browser-', root).pathname)
  let server, browser
  try {
    await writeFile(`${dir}/App.mun`, `import { Element } from "@mun/core"
struct App: View {
  @State var html = "<strong>first</strong>"
  var body: some View {
    Element("main", {}) {
      Element("div", { unsafeHTML: html }) { }
      Button("Change") { html = "<em>second</em>" }
    }
  }
}
export default App()`)
    await writeFile(`${dir}/client.js`, `import {mount} from '@mun/web'; import App from './App.mun';
const root=document.querySelector('#app'); const original=root.querySelector('strong');
const stop=mount(App,root,{hydrate:true}); window.fixture={original,stop};`)
    await writeFile(`${dir}/index.html`, '<div id="app"><main><div><strong>first</strong></div><button><span>Change</span></button></main></div><script type="module" src="/client.js"></script>')
    server = await createServer({ root: dir, configFile: false, plugins: [munPlugin()], server: { host: '127.0.0.1', port: 0 } })
    await server.listen()
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`)
    await page.waitForFunction(() => window.fixture)
    assert.equal(await page.evaluate(() => document.querySelector('strong') === window.fixture.original), true)
    await page.getByRole('button', { name: 'Change' }).click()
    await expect(page.locator('#app div em')).toHaveText('second')
    await page.evaluate(() => window.fixture.stop())
    await expect(page.locator('#app')).toBeEmpty()
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close(); await server?.close(); await rm(dir, { recursive: true, force: true })
  }
})
