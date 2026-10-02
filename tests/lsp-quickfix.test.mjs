import assert from 'node:assert/strict'
import test from 'node:test'
import { LanguageService } from '../editors/lsp/service.mjs'
import { offsetAt, rangeAt } from '../editors/lsp/source.mjs'
import { compileMunUiProgram } from '@mun/compiler'

for (const [legacy, canonical, value] of [['string', 'String', '"😀"'], ['boolean', 'Bool', 'true']]) {
  test(`compiler-backed quickfix ${legacy} -> ${canonical}`, () => {
    const uri = 'file:///App.mun', service = new LanguageService()
    const source = `// 한글 日本 中文 😀 é\n@main\nstruct App: View {\n  var title: ${legacy} = ${value}\n  var body: some View { Text("${legacy}") }\n}`
    service.update(uri, source)
    const diagnostics = service.diagnostics(uri)
    assert.ok(diagnostics.some(d => d.code === 'MUN_NATIVE' && d.range.start.line === 3))
    const start = source.indexOf(legacy, source.indexOf('var title'))
    const selected = rangeAt(source, start, start + legacy.length)
    const actions = service.codeActions(uri, selected)
    assert.equal(actions.length, 1)
    const edit = actions[0].edit.changes[uri][0]
    assert.equal(edit.newText, canonical)
    const fixed = source.slice(0, offsetAt(source, edit.range.start)) + edit.newText + source.slice(offsetAt(source, edit.range.end))
    assert.ok(fixed.includes(`Text("${legacy}")`))
    assert.doesNotThrow(() => compileMunUiProgram(fixed))
    service.update(uri, fixed)
    assert.deepEqual(service.codeActions(uri, selected), [])
    assert.deepEqual(service.codeActions(uri, selected, { only: ['refactor'] }), [])
  })
}
test('quickfix refuses ambiguous number and unrelated equal identifiers', () => {
  const service = new LanguageService(), uri = 'file:///App.mun'
  const source = '@main struct App: View { var count: number = 1; var body: some View { Text("number") } }'
  service.update(uri, source)
  assert.deepEqual(service.codeActions(uri, rangeAt(source, 0, source.length)), [])
})

test('quickfix works through actual stdio LSP', async () => {
  const { LspClient } = await import('../editors/vscode/client.mjs')
  const client = new LspClient({ command: process.execPath, args: ['bin/mun.mjs', 'lsp', '--stdio'], cwd: process.cwd() }, () => {}, () => {})
  try {
    const initialized = await client.request('initialize', { capabilities: {} })
    assert.deepEqual(initialized.capabilities.codeActionProvider.codeActionKinds, ['quickfix'])
    const uri = 'file:///Quickfix.mun'
    const source = '@main struct App: View { var title: string = "한글 😀"; var body: some View { Text(title) } }'
    client.notify('textDocument/didOpen', { textDocument: { uri, text: source, version: 1 } })
    const actions = await client.request('textDocument/codeAction', { textDocument: { uri }, range: rangeAt(source, 0, source.length), context: { diagnostics: [], only: ['quickfix'] } })
    assert.equal(actions.length, 1)
    assert.equal(actions[0].edit.changes[uri][0].newText, 'String')
  } finally { await client.dispose() }
})

test('project lowering diagnostic maps to the owning non-entry source', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { resolve } = await import('node:path')
  const { compileProject } = await import('../bin/project.mjs')
  const root = mkdtempSync(resolve(tmpdir(), 'mun-diagnostic-'))
  try {
    mkdirSync(resolve(root, 'Sources'))
    const entry = resolve(root, 'Sources/App.mun')
    writeFileSync(entry, '@main struct App: View { var body: some View { Text("Hi") } }')
    writeFileSync(resolve(root, 'Sources/Card.mun'), 'struct Card: View {\n  var title: string = "😀"\n  var body: some View { Text(title) }\n}')
    assert.throws(() => compileProject({ root, entry }), /Card\.mun:2:7:/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
