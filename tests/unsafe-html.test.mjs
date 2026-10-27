import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { compileMunFile } from '../packages/compiler/dist/index.js'
import { Element, ForEach, State, defineView, initializer } from '../packages/core/dist/compat.js'
import { mount, renderToHTML } from '../packages/web/dist/index.js'

test('explicit unsafeHTML renders and updates trusted markup through SSR, hydration and DOM', async () => {
  const markup = State('<strong>first</strong>')
  const App = defineView('UnsafeHtmlTest', {
    initializers: [initializer('App()', args => args.length === 0)],
    body: () => Element('div', { class: 'description', unsafeHTML: markup.value }),
  })
  const view = App()
  const html = renderToHTML(view)
  assert.equal(html, '<div class="description"><strong>first</strong></div>')
  const dom = new JSDOM(`<div id="app">${html}</div>`)
  const root = dom.window.document.querySelector('#app')
  const host = root.firstElementChild
  const strong = host.firstElementChild
  const unmount = mount(view, root, { hydrate: true })
  assert.equal(root.firstElementChild, host)
  assert.equal(host.querySelector('strong'), strong)
  assert.equal(strong.textContent, 'first')
  markup.value = '<em>second</em>'
  await Promise.resolve(); await Promise.resolve()
  assert.equal(root.firstElementChild, host)
  assert.equal(host.innerHTML, '<em>second</em>')
  unmount()
  assert.equal(root.innerHTML, '')
  dom.window.close()
})

test('unsafeHTML cannot be combined with managed children', () => {
  const bad = Element('div', { unsafeHTML: '<b>raw</b>' }, 'managed')
  assert.throws(() => renderToHTML(bad), /unsafeHTML.*children/i)
  const dom = new JSDOM('<div id="app"></div>')
  assert.throws(() => mount(bad, dom.window.document.querySelector('#app')), /unsafeHTML.*children/i)
  dom.window.close()
})

test('unsafeHTML transitions to managed children and back without leaking old markup', async () => {
  const mode = State('raw')
  const App = defineView('UnsafeHtmlTransition', {
    initializers: [initializer('App()', args => args.length === 0)],
    body: () => mode.value === 'raw'
      ? Element('div', { unsafeHTML: '<b>trusted</b>' })
      : Element('div', {}, Element('span', {}, 'managed')),
  })
  const dom = new JSDOM('<div id="app"></div>')
  const root = dom.window.document.querySelector('#app')
  const unmount = mount(App(), root)
  assert.equal(root.innerHTML, '<div><b>trusted</b></div>')
  mode.value = 'managed'
  await Promise.resolve(); await Promise.resolve()
  assert.equal(root.innerHTML, '<div><span>managed</span></div>')
  mode.value = 'raw'
  await Promise.resolve(); await Promise.resolve()
  assert.equal(root.innerHTML, '<div><b>trusted</b></div>')
  unmount(); dom.window.close()
})

test('unsafeHTML rejects non-string values and invalid element contexts', () => {
  for (const value of [123, { html: '<b>x</b>' }]) {
    assert.throws(() => renderToHTML(Element('div', { unsafeHTML: value })), /unsafeHTML must be a string/)
  }
  for (const tag of ['img', 'script', 'textarea']) {
    assert.throws(() => renderToHTML(Element(tag, { unsafeHTML: '<b>x</b>' })), /unsafeHTML is not supported/)
  }
})

test('compiled .mun can render and update an explicit trusted HTML host', async () => {
  const source = `import { Element } from "@mun/core"
struct App: View {
  @State var content = "<strong>first</strong>"
  var body: some View {
    Element("main", {}) {
      Element("div", { unsafeHTML: content }) { }
      Button("Change") { content = "<em>second</em>" }
    }
  }
}
export default App()`
  const { code } = compileMunFile(source, 'UnsafeHtml.mun')
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replaceAll('"@mun/core/compat"', JSON.stringify(new URL('../packages/core/dist/compat.js', import.meta.url).href))
    .replaceAll('"@mun/core"', JSON.stringify(new URL('../packages/core/dist/index.js', import.meta.url).href))
  const { default: app } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
  assert.match(renderToHTML(app), /<div><strong>first<\/strong><\/div>/)
  const dom = new JSDOM('<div id="app"></div>')
  const root = dom.window.document.querySelector('#app')
  const dispose = mount(app, root)
  assert.equal(root.querySelector('div').innerHTML, '<strong>first</strong>')
  root.querySelector('button').click()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(root.querySelector('div').innerHTML, '<em>second</em>')
  dispose(); dom.window.close()
})

test('mismatched server markup is replaced on hydration', () => {
  const dom = new JSDOM('<div id="app"><div><strong>stale</strong></div></div>')
  const root = dom.window.document.querySelector('#app')
  const dispose = mount(Element('div', { unsafeHTML: '<em>trusted</em>' }), root, { hydrate: true })
  assert.equal(root.innerHTML, '<div><em>trusted</em></div>')
  dispose(); dom.window.close()
})

test('hydration preserves equivalent parsed markup even when serialization normalizes HTML', () => {
  const html = `<strong class='highlight'>first</strong><br/>`
  const value = Element('div', { unsafeHTML: html })
  const dom = new JSDOM(`<div id="app">${renderToHTML(value)}</div>`)
  const root = dom.window.document.querySelector('#app')
  const host = root.firstElementChild
  const original = host.firstElementChild
  const dispose = mount(value, root, { hydrate: true })
  assert.equal(root.firstElementChild, host)
  assert.equal(host.firstElementChild, original)
  dispose(); dom.window.close()
})

test('unsafeHTML cannot bypass child ownership through withProps', () => {
  const view = Element('div', {}, 'managed').withProps({ unsafeHTML: '<b>raw</b>' })
  assert.throws(() => renderToHTML(view), /unsafeHTML.*Element.*withProps/)
  const dom = new JSDOM('<div id="app"></div>')
  assert.throws(() => mount(view, dom.window.document.querySelector('#app')), /unsafeHTML.*Element.*withProps/)
  dom.window.close()
})

test('keyed rows retain correct trusted markup across updates and reordering', async () => {
  const rows = State([{ id: 'a', html: '<b>A</b>' }, { id: 'b', html: '<i>B</i>' }])
  const App = defineView('UnsafeHtmlRows', {
    initializers: [initializer('App()', args => args.length === 0)],
    body: () => Element('section', {}, ForEach(rows.value, row => row.id, row => Element('div', { 'data-id': row.id, unsafeHTML: row.html }))),
  })
  const dom = new JSDOM('<div id="app"></div>')
  const root = dom.window.document.querySelector('#app')
  const stop = mount(App(), root)
  assert.equal(root.querySelector('[data-id="a"]').innerHTML, '<b>A</b>')
  rows.value = [{ id: 'b', html: '<i>changed</i>' }, { id: 'a', html: '<b>A</b>' }]
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual([...root.querySelectorAll('section > div')].map(el => [el.getAttribute('data-id'), el.innerHTML]), [['b', '<i>changed</i>'], ['a', '<b>A</b>']])
  stop(); dom.window.close()
})

test('switching managed children to trusted HTML releases detached listeners even for identical markup', async () => {
  const raw = State(false)
  let calls = 0
  const App = defineView('UnsafeHtmlCleanup', {
    initializers: [initializer('App()', args => args.length === 0)],
    body: () => raw.value ? Element('div', { unsafeHTML: '<button>click</button>' })
      : Element('div', {}, Element('button', { onClick: () => calls++ }, 'click')),
  })
  const dom = new JSDOM('<div id="app"></div>')
  const root = dom.window.document.querySelector('#app')
  const stop = mount(App(), root)
  const old = root.querySelector('button')
  raw.value = true
  await Promise.resolve(); await Promise.resolve()
  assert.notEqual(root.querySelector('button'), old)
  old.click()
  assert.equal(calls, 0)
  stop(); dom.window.close()
})
