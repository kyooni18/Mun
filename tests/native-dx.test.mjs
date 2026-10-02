import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseManifest, discoverProject } from '../bin/project.mjs'
import { createDevLoop } from '../bin/watch.mjs'
import { formatSource } from '../bin/formatter.mjs'
const root = fileURLToPath(new URL('..', import.meta.url))
const cli = resolve(root, 'bin/mun.mjs')
function run(args, cwd, env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 15000, env: { ...process.env, ...env } })
  return result
}

test('public native scaffold -> nested check/fmt -> compile/run/build/package', { skip: process.platform === 'win32' }, t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'mun-native-dx-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const result = run(['create', 'HelloMun'], directory)
  assert.equal(result.status, 0, result.stderr)
  const project = resolve(directory, 'HelloMun')
  const source = readFileSync(resolve(project, 'Sources/App.mun'), 'utf8')
  assert.match(source, /@main\nstruct HelloMunApp: View/u)
  assert.match(source, /@State var count: Int/u)
  assert.doesNotMatch(source, /State\(|\.value|\$\{|export default|import /u)
  for (const path of ['package.json', 'index.html', 'vite.config.ts', 'src/main.ts']) assert.equal(existsSync(resolve(project, path)), false)
  const manifest = parseManifest(readFileSync(resolve(project, 'mun.toml'), 'utf8'))
  assert.equal(manifest.entry, 'Sources/App.mun')
  const nested = resolve(project, 'Sources/deep'); mkdirSync(nested)
  assert.equal(discoverProject(nested).root, project)
  for (const args of [['check'], ['fmt', '--check'], ['compile', '../App.mun', resolve(directory, 'compiled.json')]]) {
    const checked = run(args, nested); assert.equal(checked.status, 0, checked.stderr)
  }
  const host = resolve(directory, 'host'), capture = resolve(directory, 'captured.json')
  writeFileSync(host, '#!/bin/sh\ncp "$1" "$MUN_CAPTURE"\n'); chmodSync(host, 0o755)
  const env = { MUN_NATIVE_HOST: host, MUN_CAPTURE: capture }
  assert.equal(run(['run'], nested, env).status, 0)
  const ir = JSON.parse(readFileSync(capture, 'utf8'))
  assert.equal(ir.entry, 'HelloMunApp'); assert.equal(ir.sourceLanguage, 'mun'); assert.equal(ir.root.kind, 'window')
  assert.equal(run(['build'], nested, env).status, 0)
  const artifact = resolve(project, '.mun/build', `${process.platform}-${process.arch}`, manifest.name)
  assert.equal(existsSync(resolve(artifact, 'Resources/program.mun.ir.json')), true)
  assert.equal(run(['package'], nested, env).status, 0)
  if (process.platform === 'darwin') assert.equal(existsSync(resolve(project, '.mun/package', `${process.platform}-${process.arch}`, `${manifest.name}.app/Contents/Info.plist`)), true)
  writeFileSync(resolve(project, 'Sources/App.mun'), source.replace('count: Int', 'count: string'))
  const broken = run(['check'], nested)
  assert.notEqual(broken.status, 0); assert.match(broken.stderr, /App\.mun:\d+:\d+:/u)
})

test('manifest failures are deliberate and versioned', () => {
  const manifest = 'manifest_version = 1\nname = "App"\nentry = "Sources/App.mun"\nidentifier = "app.mun.test"\nversion = "1.0.0"\n'
  assert.equal(parseManifest(manifest).manifest_version, 1)
  assert.throws(() => parseManifest(manifest + 'entry = "Other.mun"'), /Duplicate entry/u)
  assert.throws(() => parseManifest(manifest.replace('manifest_version = 1', 'manifest_version = 2')), /Unsupported manifest version/u)
  assert.throws(() => parseManifest(manifest + 'platforms = ["ios"]'), /Unsupported platform/u)
  assert.throws(() => parseManifest(manifest + 'resources = true'), /string array/u)
})

test('dev loop debounce, invalid compilation retention and recovery without sleeps', async () => {
  let queued, invalid = false, launches = 0, stops = 0
  const loop = createDevLoop({
    compile: () => { if (invalid) throw new Error('invalid'); return {} },
    launch: () => ++launches, stop: () => { stops++ },
    schedule: callback => { queued = callback; return 1 }, cancel: () => { queued = undefined },
  })
  await loop.rebuild(); assert.equal(launches, 1)
  loop.changed(); loop.changed(); assert.equal(launches, 1); assert.equal(typeof queued, 'function')
  invalid = true; await loop.rebuild(); assert.equal(stops, 0); assert.equal(launches, 1)
  invalid = false; await loop.rebuild(); assert.equal(stops, 1); assert.equal(launches, 2)
  await loop.close(); assert.equal(stops, 2); assert.equal(queued, undefined)
})

test('dev loop serializes stop before launching and coalesces changes during compilation', async () => {
  let unblock, count = 0, active = 0, pending
  const loop = createDevLoop({
    compile: () => ++count === 2 ? new Promise(resolve => { unblock = resolve }) : {},
    launch: () => { assert.equal(active, 0); active++; return {} },
    stop: () => { active-- }, schedule: callback => { pending = callback; return 1 }, cancel: () => {},
  })
  await loop.rebuild()
  const compiling = loop.rebuild(); await loop.rebuild(); unblock({}); await compiling
  assert.equal(active, 1); assert.equal(typeof pending, 'function'); await loop.close(); assert.equal(active, 0)
})

for (const fixture of [
  '@main\nstruct App: View {\nvar body: some View {\nText("한글 😀 { }")\n.padding(12)\n}\n}',
  'struct A: View {\n@State var x: Int = 0\nvar body: some View {\nif x > 0 {\nText("\\(x)")\n} else {\nText("none")\n}\n}\n}',
  'struct A: View {\n// { is not a delimiter\n/* } */\nvar body: some View {\nVStack {\nButton("OK") { x += 1 }\n}\n}\n}',
]) test('formatter is idempotent and ignores literal/comment delimiters', () => {
  const formatted = formatSource(fixture)
  assert.equal(formatSource(formatted), formatted)
  assert.equal(formatted.replace(/\s/gu, ''), fixture.replace(/\s/gu, ''))
})

test('dev shutdown during an in-flight launch stops the resulting child exactly once', async () => {
  let launched, stopped = 0
  const loop = createDevLoop({ compile: () => ({}), launch: () => new Promise(resolve => { launched = resolve }), stop: () => { stopped++ } })
  const rebuild = loop.rebuild()
  await Promise.resolve()
  const closing = loop.close()
  launched({})
  await rebuild; await closing
  assert.equal(stopped, 1)
})

test('formatter preserves multiline literal whitespace', () => {
  const source = 'struct A {\nlet text = """\n    literal whitespace\n  """\n}\n'
  assert.equal(formatSource(source), source)
})

test('fmt --check accepts a CRLF checkout and keeps its line endings', t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'mun-native-crlf-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  assert.equal(run(['create', 'Crlf'], directory).status, 0)
  const file = resolve(directory, 'Crlf/Sources/App.mun')
  writeFileSync(file, readFileSync(file, 'utf8').replace(/\r?\n/gu, '\r\n'))
  const checked = run(['fmt', '--check'], resolve(directory, 'Crlf'))
  assert.equal(checked.status, 0, checked.stdout + checked.stderr)
  assert.ok(readFileSync(file, 'utf8').includes('\r\n'))
})
