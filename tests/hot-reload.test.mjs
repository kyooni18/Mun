import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { compileMunDevProgram } from '@mun/compiler'
import { DEV_PROTOCOL_VERSION, MAX_FRAME_BYTES, createFrameDecoder, encodeFrame, listenForHost } from '../bin/dev-protocol.mjs'
import { analyzeCompatibility } from '../bin/hot-reload.mjs'
import { applyProgramPatch, createProgramUpdate } from '../bin/program-patch.mjs'
import { createProjectCompiler } from '../bin/project.mjs'
import { HotUpdateRejected, createDevLoop, enrichInspectorSnapshot, formatRuntimeDiagnostic } from '../bin/watch.mjs'
import { formatSnapshot, macInfoPlist, packagedExecutableName } from '../bin/workflow.mjs'

const app = ({ type = 'Int', initial = '0', label = 'Count', step = 1, entry = 'App', row = 'Bool' } = {}) => `struct Row: View {
  @State var on: ${row} = ${row === 'Bool' ? 'false' : '""'}
  var body: some View {
    Text("row")
  }
}
@main
struct ${entry}: View {
  @State var count: ${type} = ${initial}
  var body: some View {
    VStack(spacing: 8) {
      Text("${label}: \\(count)")
      Button("Add") { count += ${step} }
      Row()
    }
  }
}
`
const compile = options => compileMunDevProgram(app(options), '/p/App.mun')

test('dev metadata carries declared state types outside the production IR', () => {
  const { program, metadata } = compile()
  assert.deepEqual(metadata.states.map(state => state.type), ['Int', 'Bool'])
  assert.equal(JSON.stringify(program).includes('"Int"'), false)
})

test('text, action and modifier edits preserve every state', () => {
  const result = analyzeCompatibility(compile(), compile({ label: 'Current count', step: 10 }))
  assert.equal(result.mode, 'hot')
  assert.equal(result.preserve.length, 2)
  assert.deepEqual(result.reset, [])
})

test('a retyped state resets only that state; nested View state survives', () => {
  const result = analyzeCompatibility(compile(), compile({ type: 'String', initial: '""' }))
  assert.equal(result.mode, 'hot')
  assert.deepEqual(result.reset.map(item => item.reason), ['type Int → String'])
  assert.deepEqual(result.preserve, ['@component/entry/App/body/child/#0/content/child/#2/component/Row/on'])
  const nested = analyzeCompatibility(compile(), compile({ row: 'String' }))
  assert.deepEqual(nested.preserve, ['@component/entry/App/count'])
})

test('changing the @main entry requires a process restart', () => {
  assert.equal(analyzeCompatibility(compile(), compile({ entry: 'Other' })).mode, 'restart')
})

test('frames round trip in pieces and oversized frames are rejected', () => {
  const messages = []
  const decode = createFrameDecoder(message => messages.push(message))
  const frame = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: '한글' })])
  for (const byte of frame) decode(Buffer.from([byte]))
  assert.deepEqual(messages, [{ a: 1 }, { b: '한글' }])
  const header = Buffer.alloc(4); header.writeUInt32BE(MAX_FRAME_BYTES + 1)
  assert.throws(() => createFrameDecoder(() => {})(header), /exceeds/)
})

function fakeHost(endpoint, hello, handler = () => {}) {
  const [host, port] = endpoint.split(':')
  const socket = connect({ host, port: Number(port) })
  socket.on('data', createFrameDecoder(message => handler(message, reply => socket.write(encodeFrame(reply)))))
  socket.on('connect', () => socket.write(encodeFrame(hello)))
  socket.on('error', () => {})
  return socket
}

test('the dev listener is loopback-only, authenticates the host and correlates replies', async () => {
  const listener = await listenForHost({ irVersion: 1 })
  assert.match(listener.endpoint, /^127\.0\.0\.1:\d+$/u)
  const intruder = fakeHost(listener.endpoint, { type: 'hello', protocol: DEV_PROTOCOL_VERSION, token: 'wrong', semanticUiIrVersion: 1 })
  await new Promise(resolve => intruder.once('close', resolve))
  const host = fakeHost(listener.endpoint, { type: 'hello', protocol: DEV_PROTOCOL_VERSION, token: listener.token, semanticUiIrVersion: 1, pid: 7 }, (message, reply) => {
    reply(message.program.ok ? { type: 'update-applied', id: message.id, preservedStates: 1 } : { type: 'update-rejected', id: message.id, message: 'bad' })
  })
  const channel = await listener.connection
  assert.equal(channel.pid, 7)
  const [applied, rejected] = await Promise.all([
    channel.request('update', { program: { ok: true } }),
    channel.request('update', { program: { ok: false } }),
  ])
  assert.equal(applied.type, 'update-applied'); assert.equal(rejected.type, 'update-rejected')
  host.destroy()
  await channel.closed
  await assert.rejects(channel.request('inspect'), /disconnected|EPIPE|destroyed|write after end/iu)
})


test('dev patch reconstructs the exact next program and is smaller for local edits', () => {
  const before = compile().program
  const after = compile({ label: 'Current count' }).program
  const update = createProgramUpdate(before, after, { baseRevision: 0, revision: 1, preserve: [] })
  assert.equal(update.type, 'patch')
  assert.deepEqual(applyProgramPatch(before, update.payload.operations), after)
  assert.ok(update.bytes < update.fullBytes, `${update.bytes} should be smaller than ${update.fullBytes}`)
  assert.throws(() => createProgramUpdate(before, after, { baseRevision: 2, revision: 4, preserve: [] }), /advance exactly by one/u)
})

test('a host speaking another protocol version is refused', async () => {
  const listener = await listenForHost({ irVersion: 1 })
  fakeHost(listener.endpoint, { type: 'hello', protocol: 99, token: listener.token, semanticUiIrVersion: 1 })
  await assert.rejects(listener.connection, /protocol 99/u)
  listener.close()
})

function harness({ analysis = { mode: 'hot', preserve: ['s'], reset: [], added: [], removed: [] }, reject = false } = {}) {
  const log = [], events = { launches: 0, stops: 0, updates: 0 }
  let queued
  let compileResult = () => ({ program: {} })
  const loop = createDevLoop({
    compile: () => compileResult(),
    launch: () => { events.launches++; return {} },
    stop: () => { events.stops++ },
    analyze: () => analysis,
    update: async () => { events.updates++; if (reject) throw new HotUpdateRejected('runtime refused'); return { preservedStates: 3, applyMicros: 900, insertedNodes: 0, removedNodes: 0 } },
    report: message => log.push(message),
    schedule: callback => { queued = callback; return 1 }, cancel: () => {},
  })
  return { loop, log, events, setCompile: fn => { compileResult = fn }, get queued() { return queued } }
}

test('compatible edits hot reload without relaunching and report the truth', async () => {
  const h = harness()
  await h.loop.rebuild(); await h.loop.rebuild()
  assert.deepEqual(h.events, { launches: 1, stops: 0, updates: 1 })
  assert.match(h.log.at(-1), /^Hot reload applied in .*\nPreserved 3 state scopes$/u)
  assert.equal(h.log.some(line => /hot reload/iu.test(line) && /Relaunch/u.test(line)), false)
  await h.loop.close(); assert.equal(h.events.stops, 1)
})

test('structural changes relaunch and are never called hot reload', async () => {
  const h = harness({ analysis: { mode: 'restart', reason: '@main entry changed', preserve: [], reset: [], added: [], removed: [] } })
  await h.loop.rebuild(); await h.loop.rebuild()
  assert.deepEqual(h.events, { launches: 2, stops: 1, updates: 0 })
  assert.match(h.log.at(-1), /^Structural change requires process restart: @main entry changed\nRelaunched in /u)
})

test('rejected updates and compile failures keep the previous build running, then recover', async () => {
  const h = harness({ reject: true })
  await h.loop.rebuild(); await h.loop.rebuild()
  assert.match(h.log.at(-1), /Hot update rejected: runtime refused\nRunning previous valid build/u)
  h.setCompile(() => { throw new Error('App.mun:3:1: bad') })
  await h.loop.rebuild()
  assert.match(h.log.at(-1), /^Compile failed\nApp\.mun:3:1: bad\nRunning previous valid build$/u)
  assert.deepEqual(h.events, { launches: 1, stops: 0, updates: 1 })
})

test('a closed app is relaunched on the next edit instead of updating a dead process', async () => {
  const h = harness()
  await h.loop.rebuild()
  h.loop.running.exited = true
  await h.loop.rebuild()
  assert.deepEqual(h.events, { launches: 2, stops: 0, updates: 0 })
})

test('project compiler re-reads only changed files and never reuses a result after failure', t => {
  const root = mkdtempSync(resolve(tmpdir(), 'mun-incremental-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(resolve(root, 'Sources'))
  const entry = resolve(root, 'Sources/App.mun'), other = resolve(root, 'Sources/Row.mun')
  writeFileSync(entry, app().split('@main')[1].replace(/^/u, '@main'))
  writeFileSync(other, app().split('@main')[0])
  const compiler = createProjectCompiler({ root, entry, manifest: {} })
  const initial = compiler.compile()
  assert.equal(initial.stats.filesRead, 2)
  assert.equal(initial.stats.filesReparsed, 2)
  assert.ok(initial.stats.viewDeclarationsRelowered >= 2)
  assert.ok(initial.metadata.nodes.some(node => node.file === 'Sources/Row.mun' && node.line === 4), 'nested View node maps back to Row.mun')
  assert.ok(initial.metadata.nodes.some(node => node.file === 'Sources/App.mun'), 'entry nodes map back to App.mun')
  const again = compiler.compile()
  assert.equal(again.stats.filesRead, 0); assert.equal(again.stats.reused, true)
  writeFileSync(other, app().split('@main')[0].replace('"row"', '"row!"'))
  utimesSync(other, new Date(), new Date(Date.now() + 5000))
  const edited = compiler.compile()
  assert.deepEqual([edited.stats.filesRead, edited.stats.filesReparsed, edited.stats.changedFiles], [1, 1, [other]])
  assert.equal(edited.stats.declarationsReparsed, 1)
  assert.equal(edited.stats.declarationsRechecked, 1, 'only the edited declaration is revalidated')
  // Only the edited View and the Views that use it are relowered, exactly as
  // the previous compile's dependency graph predicts.
  assert.deepEqual(edited.stats.changedDeclarations, ['Row'])
  assert.deepEqual(edited.stats.relowered, edited.stats.affectedViews)
  assert.ok(edited.stats.relowered.includes('Row') && edited.stats.viewInstancesLowered >= 2)
  writeFileSync(other, 'struct Row: View {'); utimesSync(other, new Date(), new Date(Date.now() + 10000))
  assert.throws(() => compiler.compile())
  assert.throws(() => compiler.compile(), 'unchanged invalid source must not fall back to the last valid result')
})

test('macOS Info.plist names the real executable and manifest identity', () => {
  const plist = macInfoPlist({ identifier: 'com.example.Hello', name: 'Hello & Co', version: '1.2.3' }, 'Hello & Co', 'AppIcon.icns')
  assert.match(plist, /<key>CFBundleExecutable<\/key>\n\t<string>Hello &amp; Co<\/string>/u)
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\n\t<string>1\.2\.3<\/string>/u)
  assert.match(plist, /<key>CFBundleIconFile<\/key>\n\t<string>AppIcon\.icns<\/string>/u)
  assert.doesNotMatch(plist, /launch/u)
  assert.equal(packagedExecutableName({ name: 'Mün App/x' }, 'win32'), 'Mün App_x.exe')
})

test('inspector and runtime diagnostics attach project-relative source locations without exposing values', () => {
  const node = '@node/entry/App/body/kind/text'
  const metadata = { nodes: [{ id: node, file: 'Sources/App.mun', line: 7, column: 5, endLine: 7, endColumn: 18 }] }
  const snapshot = enrichInspectorSnapshot({
    title: 'T', entry: 'App', revision: 2, primitives: 4,
    nodes: [{ id: 'window', kind: 'Window', children: [node], frame: [0, 0, 10, 10] }, { id: node, kind: 'Text', parent: 'window', children: [] }],
    states: [{ name: 'secret', valueKind: 'string', redacted: true }, { name: 'count', valueKind: 'number', value: 2 }],
  }, metadata, 4)
  const text = formatSnapshot(snapshot)
  assert.match(text, /secret = <redacted>/u)
  assert.match(text, /count = 2/u)
  assert.match(text, /Text\s+App\/body @ Sources\/App\.mun:7:5/u)
  assert.match(text, /dev revision 4/u)
  assert.equal(formatRuntimeDiagnostic({ severity: 'error', message: 'bad write', node }, metadata), 'Sources/App.mun:7:5: Runtime error: bad write')
})
