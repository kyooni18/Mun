import assert from 'node:assert/strict'
import test from 'node:test'
import { Text, VStack } from '../packages/core/dist/index.js'
import { renderToHTML } from '../packages/web/dist/index.js'

test('.modifier(_:) applies a reusable modifier given as a function or a body(content) object', () => {
  const footer = content => VStack(content, Text('footer'))
  const viaFunction = Text('a').modifier(footer)
  const viaObject = Text('a').modifier({ body: footer })
  assert.equal(renderToHTML(viaFunction), renderToHTML(viaObject))
  assert.match(renderToHTML(viaFunction), /footer/)
  assert.equal(typeof viaFunction.padding, 'function', 'result stays modifiable')
  assert.throws(() => Text('a').modifier(null), TypeError)
})

test('.modifier(_:) survives the compiled modifier path used by .mun structs', async () => {
  const { modifiedContentCompiled } = await import('../packages/core/dist/graph.js')
  const framed = content => VStack(content, Text('footer'))
  const html = renderToHTML(modifiedContentCompiled(Text('a'), [['modifier', [framed]], ['padding', [4]]]))
  assert.match(html, /footer/)
  assert.match(html, /padding/)
})
