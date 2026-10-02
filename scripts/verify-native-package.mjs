// Stage in isolation: never install or overwrite a host inside the worktree.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { assembleNativeHost } from './assemble-native-host.mjs'
import { pathToFileURL } from 'node:url'
import { LspClient } from '../editors/vscode/client.mjs'
const temporary = mkdtempSync(resolve(tmpdir(), 'mun-package-'))
const name = process.platform === 'win32' ? 'mun-native.exe' : 'mun-native'
const key = `${process.platform}-${process.arch}`
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000, shell: process.platform === 'win32' && command.endsWith('.cmd') })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr}\n${result.stdout}`)
  return result.stdout
}
try {
  const stage = resolve(temporary, 'stage')
  mkdirSync(stage)
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  for (const entry of ['package.json', ...manifest.files]) {
    if (existsSync(entry)) cpSync(entry, resolve(stage, entry), { recursive: true })
  }
  // The same release assembly a release pipeline runs, into the stage only.
  const { metadata } = assembleNativeHost({ out: stage, profile: process.env.MUN_PACKAGE_PROFILE || 'release' })
  assert.equal(metadata.packageVersion, manifest.version)
  // Explicitly bypass prepack only because CI already rebuilt all source.
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const workspaceManifests = readdirSync('packages').map(name => resolve('packages', name, 'package.json')).filter(existsSync).map(path => ({ path, manifest: JSON.parse(readFileSync(path, 'utf8')) }))
  const versions = new Map(workspaceManifests.map(({ manifest }) => [manifest.name, manifest.version]))
  function publishManifest(manifest) {
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, version] of Object.entries(manifest[group] || {})) {
        if (version.startsWith('workspace:')) manifest[group][name] = versions.get(name)
      }
    }
    return manifest
  }
  const tarballs = []
  for (const { path, manifest } of workspaceManifests) {
    const packageStage = resolve(temporary, manifest.name.replaceAll('/', '-'))
    mkdirSync(packageStage)
    writeFileSync(resolve(packageStage, 'package.json'), JSON.stringify(publishManifest(manifest)))
    const source = resolve(path, '..')
    for (const entry of manifest.files || ['dist']) {
      if (existsSync(resolve(source, entry))) cpSync(resolve(source, entry), resolve(packageStage, entry), { recursive: true })
    }
    const packed = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json'], packageStage))[0]
    tarballs.push(resolve(packageStage, packed.filename))
  }
  writeFileSync(resolve(stage, 'package.json'), JSON.stringify(publishManifest(manifest)))
  const packed = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json'], stage))[0]
  assert(packed.files.some(file => file.path === `native/bin/${key}/${name}`), 'host must be in npm tarball')
  assert(packed.files.some(file => file.path === `native/bin/${key}/mun-native.json`), 'host metadata must be in npm tarball')
  assert(packed.files.some(file => file.path === 'dist/index.js'), 'compiled runtime must be in tarball')
  assert(!packed.files.some(file => file.path.includes('target/')), 'Cargo target must not be published')
  const consumer = resolve(temporary, 'consumer')
  mkdirSync(consumer)
  run(npm, ['init', '--yes'], consumer)
  run(npm, ['install', '--ignore-scripts', ...tarballs, resolve(stage, packed.filename)], consumer)
  cpSync('examples/NativeProductionSmoke.mun', resolve(consumer, 'App.mun'))
  run(process.execPath, ['node_modules/@mun/ui/bin/mun.mjs', 'compile', 'App.mun', 'app.json'], consumer)
  const host = resolve(consumer, 'node_modules/@mun/ui/native/bin', key, name)
  assert(existsSync(host), 'installed native host')
  // A real native launch, with no Cargo and no repository fixture dependency.
  run(host, ['--smoke', 'app.json'], consumer)
  for (const file of ['templates/native/App.mun', 'templates/native/mun.toml', 'bin/project.mjs', 'bin/workflow.mjs', 'bin/watch.mjs', 'editors/lsp/mun-lsp.mjs']) assert(packed.files.some(entry => entry.path === file), `${file} must be in tarball`)
  const publicCli = resolve(consumer, 'node_modules/@mun/ui/bin/mun.mjs')
  run(process.execPath, [publicCli, 'new', 'HelloMun'], consumer)
  const nativeProject = resolve(consumer, 'HelloMun')
  assert(!existsSync(resolve(nativeProject, 'package.json')), 'native app must not depend on Web packages')
  mkdirSync(resolve(nativeProject, 'Sources/Nested'))
  const nested = resolve(nativeProject, 'Sources/Nested')
  run(process.execPath, [publicCli, 'check'], nested)
  run(process.execPath, [publicCli, 'fmt', '--check'], nested)
  run(process.execPath, [publicCli, 'build'], nested)
  const app = resolve(nativeProject, '.mun/build', key, 'HelloMunApp')
  const builtIr = resolve(app, 'Resources/program.mun.ir.json')
  assert.equal(JSON.parse(readFileSync(builtIr, 'utf8')).entry, 'HelloMunApp')
  run(resolve(app, name), ['--smoke', builtIr], consumer)
  run(process.execPath, [publicCli, 'package'], nested)
  if (process.platform === 'darwin') assert(existsSync(resolve(nativeProject, '.mun/package', key, 'HelloMunApp.app/Contents/Info.plist')))
  const client = new LspClient({ command: process.execPath, args: [publicCli, 'lsp', '--stdio'], cwd: nativeProject }, () => {}, () => {})
  try {
    const initialization = await client.request('initialize', { capabilities: {}, rootUri: pathToFileURL(nativeProject).href })
    assert.equal(initialization.serverInfo.version, manifest.version)
    const uri = pathToFileURL(resolve(nativeProject, 'Sources/App.mun')).href
    client.notify('textDocument/didOpen', { textDocument: { uri, text: readFileSync(resolve(nativeProject, 'Sources/App.mun'), 'utf8'), version: 1 } })
    const symbols = await client.request('textDocument/documentSymbol', { textDocument: { uri } })
    assert.equal(symbols[0].name, 'HelloMunApp')
  } finally { await client.dispose() }

  // A host assembled for another package version is rejected before launch,
  // and an installed package never falls back to building with Cargo.
  const cli = resolve(consumer, 'node_modules/@mun/ui/bin/mun.mjs')
  const metadataPath = resolve(consumer, 'node_modules/@mun/ui/native/bin', key, 'mun-native.json')
  const original = readFileSync(metadataPath, 'utf8')
  writeFileSync(metadataPath, JSON.stringify({ ...JSON.parse(original), packageVersion: '0.0.0-stale' }))
  const env = { ...process.env, MUN_NATIVE_HOST: '', CARGO: resolve(temporary, 'no-cargo') }
  let mismatch = spawnSync(process.execPath, [cli, 'run', 'App.mun'], { cwd: consumer, encoding: 'utf8', env, timeout: 60_000 })
  assert.notEqual(mismatch.status, 0)
  assert.match(mismatch.stderr, /built for packageVersion "0\.0\.0-stale"/)
  rmSync(resolve(consumer, 'node_modules/@mun/ui/native/bin', key), { recursive: true })
  mismatch = spawnSync(process.execPath, [cli, 'run', 'App.mun'], { cwd: consumer, encoding: 'utf8', env, timeout: 60_000 })
  assert.notEqual(mismatch.status, 0)
  assert.match(mismatch.stderr, /No Mün native host is packaged for/)
  console.log(`Packaged native consumer verified: ${key}`)
} finally { rmSync(temporary, { recursive: true, force: true }) }
