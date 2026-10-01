import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { renderMunUiProgramToHTML } from '../packages/web/dist/ui-ir.js'
import { compileMunUiProgram } from '../packages/compiler/dist/index.js'
function nodes(node) {
  return [node, ...(node.children ?? (node.child ? [node.child] : [...(node.then ?? []), ...(node.otherwise ?? [])])).flatMap(nodes)]
}
test('production smoke source lowers scroll and controls to backend-neutral nodes', () => {
  const program = compileMunUiProgram(readFileSync('examples/NativeProductionSmoke.mun', 'utf8'), 'examples/NativeProductionSmoke.mun')
  const all = nodes(program.root)
  assert(all.some(node => node.kind === 'scroll' && node.axis === 'vertical'))
  for (const kind of ['row', 'column', 'textField', 'action', 'radioGroup', 'conditional', 'panel']) assert(all.some(node => node.kind === kind), kind)
  assert.equal(new Set(all.map(node => node.id)).size, all.length)
})
test('unsupported raw view expressions report source rather than recurse indefinitely', () => {
  assert.throws(() => compileMunUiProgram('struct Bad: View { var body: some View { unknown + expression } }', 'Bad.mun'), /Unsupported native view expression: unknown \+ expression/)
})
test('scroll axis is explicit and invalid axis is diagnosed', () => {
  const source = axis => `struct App: View { var body: some View { ScrollView(${axis}) { Text("x") } } }`
  assert.equal(compileMunUiProgram(source('.horizontal'), 'App.mun').root.child.axis, 'horizontal')
  assert.throws(() => compileMunUiProgram(source('.diagonal'), 'App.mun'), /ScrollView/)
})

test('web compatibility adapter preserves semantic scroll axis', () => {
  for (const [axis, css] of [['vertical', 'overflow-y:auto'], ['horizontal', 'overflow-x:auto']]) {
    const program = compileMunUiProgram(`struct App: View { var body: some View { ScrollView(.${axis}) { Text("content") }.frame(width: 100, height: 60) } }`, 'App.mun')
    const html = renderMunUiProgramToHTML(program)
    assert(html.includes(css))
    assert(html.includes('content'))
    assert(html.includes('height:60px'))
  }
})
