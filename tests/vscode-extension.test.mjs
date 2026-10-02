import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, cpSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import test from 'node:test'
import { LanguageService } from '../editors/lsp/service.mjs'
import { positionAt } from '../editors/lsp/source.mjs'
import { discoverMunCommand, discoverToolchain } from '../editors/vscode/discovery.mjs'
import { DEV_PROTOCOL_VERSION, createDevFrameDecoder, encodeDevFrame, inspectDevSession, runtimeTree } from '../editors/vscode/dev-client.mjs'
import { LspClient } from '../editors/vscode/client.mjs'

const root = new URL('../editors/vscode/', import.meta.url)
test('VS Code is a canonical-only LSP client, not an independent compiler', () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', root)))
  assert.ok(manifest.activationEvents.includes('onLanguage:mun'))
  for (const command of ['mun.startDev', 'mun.stopDev', 'mun.restartDev', 'mun.inspectRunningApp']) assert.ok(manifest.activationEvents.includes(`onCommand:${command}`), command)
  assert.ok(manifest.activationEvents.includes('onView:mun.runtimeView'))
  assert.deepEqual(manifest.contributes.languages[0].extensions, ['.mun'])
  assert.ok(manifest.files.includes('dev-client.mjs'))
  assert.equal(manifest.contributes.views.explorer[0].id, 'mun.runtimeView')
  const source = readFileSync(new URL('extension.cjs', root), 'utf8')
  for (const feature of ['DocumentFormattingEdit', 'CompletionItem', 'Hover', 'SignatureHelp', 'Definition', 'Reference', 'Rename', 'DocumentSymbol', 'DocumentSemanticTokens', 'FoldingRange', 'SelectionRange']) assert.ok(source.includes(`register${feature}Provider`), feature)
  for (const command of ['mun.startDev', 'mun.stopDev', 'mun.restartDev', 'mun.inspectRunningApp', 'mun.openRuntimeSource']) assert.ok(source.includes(`registerCommand('${command}'`), command)
  assert.match(source, /createTreeView\('mun\.runtimeView'/u)
  assert.match(source, /createDiagnosticCollection\('mun-runtime'\)/u)
  assert.doesNotMatch(source, /VIEW_SIGNATURES|parseMun|diagnoseMun/)
  assert.match(source, /d.severity === 2 \? vscode.DiagnosticSeverity.Warning/)
  assert.equal(manifest.private, undefined)
})


test('VS Code dev inspector uses authenticated loopback snapshots and preserves tree identity', async t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'mun-vscode-inspect-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(resolve(directory, '.mun/dev'), { recursive: true })
  const token = 'test-token'
  const snapshot = {
    title: 'T', entry: 'App', revision: 2, devRevision: 7,
    nodes: [
      { id: 'root', kind: 'Column', parent: null, children: ['text'], source: { file: 'Sources/App.mun', line: 6, column: 5 } },
      { id: 'text', kind: 'Text', parent: 'root', children: [], source: { file: 'Sources/App.mun', line: 7, column: 7 } },
    ],
    runtimeDiagnostics: [{ severity: 'error', message: 'bad write', node: 'text', source: { file: 'Sources/App.mun', line: 7, column: 7 } }],
  }
  const server = createServer(socket => {
    let authenticated = false
    const decode = createDevFrameDecoder(message => {
      if (!authenticated) { assert.deepEqual(message, { type: 'hello', token }); authenticated = true; return }
      assert.equal(message.type, 'inspect'); assert.equal(message.includeValues, false)
      socket.write(encodeDevFrame({ type: 'snapshot', id: message.id, snapshot }))
    })
    socket.on('data', decode)
  })
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  t.after(() => server.close())
  const address = server.address()
  writeFileSync(resolve(directory, '.mun/dev/session.json'), JSON.stringify({ protocol: DEV_PROTOCOL_VERSION, endpoint: `127.0.0.1:${address.port}`, token, pid: process.pid }))
  const actual = await inspectDevSession(directory)
  assert.deepEqual(actual, snapshot)
  const tree = runtimeTree(actual)
  assert.deepEqual(tree.roots.map(node => node.id), ['root'])
  assert.deepEqual(tree.children(tree.roots[0]).map(node => node.id), ['text'])
})

test('shared service uses canonical initializer contracts and context-aware members', () => {
  const service = new LanguageService(), uri = 'file:///App.mun'
  for (const [source, expected, excluded] of [
    ['VStack(alignment: .', 'leading', 'top'], ['HStack(alignment: .', 'top', 'firstTextBaseline'],
    ['Text("Hi").padding(.', 'horizontal', 'infinity'], ['Text("Hi").frame(maxWidth: .', 'infinity', 'leading'],
  ]) {
    service.update(uri, source)
    const labels = service.completion(uri, positionAt(source, source.length)).map(item => item.label)
    assert.ok(labels.includes(expected), source); assert.ok(!labels.includes(excluded), source)
  }
  service.update(uri, 'Button(')
  const help = service.signatureHelp(uri, { line: 0, character: 7 })
  assert.ok(help.signatures.some(s => s.label.includes('String')))
  assert.ok(help.signatures.some(s => s.label.includes('() -> Void')))
  assert.doesNotMatch(JSON.stringify(help), /@Action|: string/)
})

test('semantic references, rename and tokens preserve UTF-16 and avoid equal literal/member names', () => {
  const service = new LanguageService(), uri = 'file:///App.mun'
  const source = '@main\nstruct App: View {\n  @State var count: Int = 0\n  var body: some View {\n    Text("한글 日本 中文 😀 é count \\(count)")\n    Button("count") { count += 1 }\n  }\n}'
  service.update(uri, source)
  const use = source.indexOf('count)', source.indexOf('Text'))
  const position = positionAt(source, use)
  assert.equal(service.definition(uri, position).range.start.line, 2)
  const changes = service.rename(uri, position, 'total').changes[uri]
  assert.equal(changes.length, 3)
  assert.ok(changes.some(e => e.range.start.character === position.character && e.range.start.line === 4))
  const data = service.semanticTokens(uri).data
  let line = 0, character = 0, found = false
  for (let i = 0; i < data.length; i += 5) { character = data[i] ? data[i + 1] : character + data[i + 1]; line += data[i]; if (line === position.line && character === position.character) { assert.equal(data[i + 2], 5); found = true } }
  assert.ok(found)
  const parses = service.parseCount; service.update(uri, source); assert.equal(service.parseCount, parses)
  const broken = 'struct App: View { var body: some View { Text("한글 😀") } }\n/* unfinished'
  service.update(uri, broken)
  assert.ok(service.diagnostics(uri).some(d => d.range.start.line === 1 && d.range.start.character === 0))
})

test('cross-file custom Views resolve and rename semantically', () => {
  const service = new LanguageService()
  const declaration = 'struct Card: View { var title: String; var body: some View { Text(title) } }'
  service.update('file:///Card.mun', declaration)
  service.update('file:///App.mun', 'struct App: View { var body: some View { Card(title: "Card") } }')
  const position = { line: 0, character: 41 }
  assert.equal(service.definition('file:///App.mun', position).uri, 'file:///Card.mun')
  assert.equal(Object.values(service.rename('file:///App.mun', position, 'Panel').changes).flat().length, 2)
})

test('a long-lived service with its shared lowering cache diagnoses exactly like a fresh one', () => {
  const card = label => `struct Card: View {\n  var title: String\n  var body: some View { Text(title) }\n}\nstruct Badge: View {\n  var body: some View { Text("${label}") }\n}\n`
  const app = argument => `@main\nstruct App: View {\n  var body: some View {\n    VStack {\n      Card(title: ${argument})\n      Badge()\n    }\n  }\n}\n`
  const steps = [[app('"a"'), card('x')], [app('"b"'), card('x')], [app('3'), card('x')], [app('"b"'), card('y')], [app('"b"'), card('y').replace('var title: String', 'var title: string')], [app('"c"'), card('z')]]
  const service = new LanguageService()
  for (const [appSource, cardSource] of steps) {
    service.update('file:///App.mun', appSource); service.update('file:///Card.mun', cardSource)
    const fresh = new LanguageService()
    fresh.update('file:///App.mun', appSource); fresh.update('file:///Card.mun', cardSource)
    for (const uri of ['file:///App.mun', 'file:///Card.mun']) assert.deepEqual(service.diagnostics(uri), fresh.diagnostics(uri))
  }
  assert.ok(service.loweringCache.stats().instancesReused > 0, 'unchanged Views were reused')
})

test('workspace-local toolchain discovery launches the actual LSP with version validation', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'mun-lsp-client-'))
  let client
  try {
    const local = resolve(directory, 'node_modules/@mun/ui')
    mkdirSync(local, { recursive: true })
    cpSync(new URL('../package.json', import.meta.url), resolve(local, 'package.json'))
    // Isolate the public CLI/LSP files; dependency resolution is supplied explicitly for this source fixture.
    cpSync(new URL('../bin', import.meta.url), resolve(local, 'bin'), { recursive: true })
    cpSync(new URL('../editors', import.meta.url), resolve(local, 'editors'), { recursive: true })
    symlinkSync(resolve('node_modules/@mun/compiler'), resolve(directory, 'node_modules/@mun/compiler'), 'junction')
    const version = JSON.parse(readFileSync(resolve(local, 'package.json'))).version
    const base = await discoverMunCommand({ cwd: directory, expectedVersion: version })
    assert.equal(base.args[0], resolve(local, 'bin/mun.mjs'))
    assert.ok(!base.args.includes('lsp'))
    const server = await discoverToolchain({ cwd: directory, expectedVersion: version })
    assert.equal(server.args[0], resolve(local, 'bin/mun.mjs'))
    assert.deepEqual(server.args.slice(-2), ['lsp', '--stdio'])
    await assert.rejects(discoverToolchain({ cwd: directory, expectedVersion: '99.0.0' }), /refusing a global fallback/)
    client = new LspClient(server, () => {}, () => {})
    const result = await client.request('initialize', { capabilities: {} })
    assert.equal(result.serverInfo.version, version)
    assert.equal(result.capabilities.positionEncoding, 'utf-16')
    client.notify('textDocument/didOpen', { textDocument: { uri: 'file:///Fixture.mun', text: 'struct Fixture: View { var body: some View { Text("Hi") } }', version: 1 } })
    const symbols = await client.request('textDocument/documentSymbol', { textDocument: { uri: 'file:///Fixture.mun' } })
    assert.equal(symbols[0].name, 'Fixture')
  } finally {
    await client?.dispose()
    // Windows keeps handles briefly after the server exits; drop the junction first and retry.
    rmSync(resolve(directory, 'node_modules/@mun/compiler'), { recursive: true, force: true })
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
