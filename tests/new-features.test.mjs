import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { jsx, jsxDEV, jsxs } from '../dist/jsx-runtime.js'
import { Fragment as DevFragment, jsxDEV as devJsxDEV } from '../dist/jsx-dev-runtime.js'
import {
  Grid,
  Group,
  HStack,
  styled,
  Text,
  VStack,
} from '../dist/legacy.js'
import {
  createMunSwcVisitor,
  createMunVitePlugin,
  transformMunBuilderSyntax,
} from '../dist/compiler/index.js'
import {
  applyMunPlugins,
  coordinateSpace,
  coordinateSpaceOf,
  createLayoutNode,
  emptyLayoutNode,
  getMunNodeMetadata,
  globalCoordinates,
  layoutPass,
  markMunNode,
  observeLayout,
  registerMunPlugin,
  unregisterMunPlugin,
} from '../dist/experimental.js'

test('transforms nested builder blocks without touching source text', () => {
  const source = `
const example = 'VStack() { not syntax }'
// VStack() { also not syntax }
VStack({ spacing: 8 }) {
  Text('A')
  HStack() {
    Text('B')
    Text('C')
  }
}
`

  const output = transformMunBuilderSyntax(source)
  assert.match(output, /VStack\(\{ spacing: 8 \}, \(\) => \[/)
  assert.match(output, /HStack\(\(\) => \[Text\('B'\), Text\('C'\)\]\)/)
  assert.match(output, /'VStack\(\) \{ not syntax \}'/)
  assert.match(output, /\/\/ VStack\(\) \{ also not syntax \}/)

  assert.equal(
    transformMunBuilderSyntax("VStack() { Text('A') // keep this\n Text('B') }"),
    "VStack(() => [Text('A') /* keep this*/, Text('B')])",
  )
})

test('builder transformer resolves arbitrary View names and reports malformed blocks', () => {
  assert.equal(
    transformMunBuilderSyntax('Card() { Text(\'Card\') }'),
    "Card(() => [Text('Card')])",
  )
  assert.throws(
    () => transformMunBuilderSyntax('VStack() { Text(\'missing\')'),
    /Unclosed \{ block/,
  )
})

test('builder runtime supports plain, optioned, nested, Group, and Grid builders', () => {
  assert.match(renderToStaticMarkup(VStack(() => [Text('A'), Text('B')])), />A<.*>B</s)
  assert.match(renderToStaticMarkup(VStack({ spacing: 8 }, () => Text('A'))), /gap:8px/)
  assert.match(renderToStaticMarkup(HStack(() => [Text('A')])), />A</s)
  assert.match(renderToStaticMarkup(Group(() => [Text('A')])), />A</s)
  assert.match(renderToStaticMarkup(Grid(2, () => [Text('A')])), /repeat\(2, minmax\(0, 1fr\)\)/)
})

test('Vite and SWC adapters use the same builder transform and support query IDs', () => {
  const source = "VStack() { Text('A') }"
  const vite = createMunVitePlugin()
  assert.deepEqual(vite.transform(source, '/src/App.tsx?direct'), {
    code: "VStack(() => [Text('A')])",
    map: {
      version: 3,
      file: '/src/App.tsx',
      sources: ['/src/App.tsx'],
      sourcesContent: [source],
      names: [],
      mappings: 'AAAA',
    },
  })
  assert.equal(vite.transform(source, '/src/App.css'), null)

  const swc = createMunSwcVisitor()
  assert.equal(swc.transform(source), "VStack(() => [Text('A')])")
  assert.match(swc.transform('VStack(spacing: 8) { Text(\'A\') }'), /import \{ namedArguments \}/)
})

test('Mun JSX runtimes preserve native props and apply all style modifiers', () => {
  const production = jsxs('div', {
    id: 'root',
    padding: 4,
    minWidth: 10,
    fontWeight: 700,
    children: ['Hello', jsx('span', { children: ' Mun' })],
  })
  const development = jsxDEV('div', {
    opacity: 0.5,
    children: 'Dev',
  }, undefined, false, undefined, undefined)

  assert.match(renderToStaticMarkup(production), /id="root"/)
  assert.match(renderToStaticMarkup(production), /padding:4px/)
  assert.match(renderToStaticMarkup(production), /min-width:10px/)
  assert.match(renderToStaticMarkup(production), /font-weight:700/)
  assert.match(renderToStaticMarkup(development), /opacity:0\.5/)
  assert.equal(DevFragment, DevFragment)
  assert.equal(typeof devJsxDEV, 'function')
})

test('JSX nodes pass through registered plugins and retain metadata', () => {
  registerMunPlugin({
    name: 'test-plugin',
    apply: element => styled(element).attr('data-plugin', 'yes'),
  })
  try {
    const element = jsx('div', { padding: 4, children: 'Plugin' })
    const html = renderToStaticMarkup(element)
    assert.match(html, /data-plugin="yes"/)
    assert.match(renderToStaticMarkup(Text('DSL plugin')), /data-plugin="yes"/)
    assert.deepEqual(getMunNodeMetadata(element), { modifiers: ['padding'], layout: undefined })
    assert.equal(applyMunPlugins(element).props['data-plugin'], 'yes')
  } finally {
    assert.equal(unregisterMunPlugin('test-plugin'), true)
  }
})

test('coordinate, layout, and node metadata APIs retain their contracts', () => {
  const target = {}
  coordinateSpace(target, 'screen')
  assert.equal(coordinateSpaceOf(target), 'screen')
  assert.equal(coordinateSpaceOf({}), 'local')
  assert.deepEqual(emptyLayoutNode('root').frame, { x: 0, y: 0, width: 0, height: 0 })

  let receivedProposal
  const child = createLayoutNode('child', proposal => {
    receivedProposal = proposal
    return {
      x: 1,
      y: 2,
      width: proposal.width ?? 0,
      height: proposal.height ?? 0,
    }
  })
  const root = createLayoutNode('root', () => ({ x: 0, y: 0, width: 100, height: 50 }), [child])
  assert.deepEqual(layoutPass(root, {}), { x: 0, y: 0, width: 100, height: 50 })
  assert.deepEqual(child.frame, { x: 1, y: 2, width: 100, height: 50 })
  assert.deepEqual(receivedProposal, { width: 100, height: 50 })

  const element = jsx('div', { children: 'node' })
  const metadata = { modifiers: ['padding'], layout: { width: 10 } }
  assert.equal(getMunNodeMetadata(markMunNode(element, metadata)), metadata)
})

test('layout observation records named coordinate spaces', () => {
  const originalResizeObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  try {
    const element = { getBoundingClientRect: () => ({ x: 3, y: 4, width: 50, height: 20 }) }
    coordinateSpace(element, 'screen')
    const node = emptyLayoutNode('observed')
    const stop = observeLayout(element, node)
    assert.deepEqual(node.frame, { x: 3, y: 4, width: 50, height: 20 })
    assert.equal(node.coordinateSpace, 'screen')
    assert.deepEqual(globalCoordinates.get('screen'), node.frame)
    stop()
  } finally {
    globalThis.ResizeObserver = originalResizeObserver
  }
})
