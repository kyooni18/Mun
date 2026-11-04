import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { transformMunSource, compileMunUiProgram } from '../packages/compiler/dist/index.js'
import { Color, Font, Text } from '../packages/core/dist/index.js'
import { renderToHTML } from '../packages/web/dist/index.js'

const source = expression => `struct Demo: View { var body: some View { Text("Hello")${expression} } }\nexport default Demo()`
async function graph(expression) {
  const code = ts.transpileModule(transformMunSource(source(expression), 'Demo.mun'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  return (await import(`data:text/javascript,${encodeURIComponent(code.replaceAll('"@mun-ui/core/compat"', JSON.stringify(new URL('../packages/core/dist/compat.js', import.meta.url).href)))}`)).default
}
test('semantic styles lower to imported values and render through SSR', async () => {
  for (const expression of ['.foregroundStyle(Color.blue)', '.foregroundStyle(.blue)']) {
    const html = renderToHTML(await graph(expression))
    assert.match(html, /#007AFF/i)
  }
  for (const style of ['largeTitle','title','title2','title3','headline','subheadline','body','callout','footnote','caption','caption2']) {
    assert.match(renderToHTML(await graph(`.font(.${style})`)), /system-ui/)
    assert.ok(Font[style])
  }
  assert.match(renderToHTML(Text('x').font('600 18px system-ui').foregroundStyle('red')), /600 18px system-ui/)
  for (const color of Object.keys(Color)) assert.doesNotThrow(() => renderToHTML(Text('x').foregroundStyle(Color[color])))
})
test('invalid members and native typography retain diagnostics', () => {
  assert.throws(() => transformMunSource(source('.font(.bogus)'), 'Demo.mun'), /Unknown Font member/)
  assert.throws(() => transformMunSource(source('.foregroundStyle(.bogus)'), 'Demo.mun'), /Unknown Color member/)
  assert.throws(() => compileMunUiProgram(source('.font(.title)')), /native Semantic UI IR does not support/)
})
