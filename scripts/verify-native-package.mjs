// Stage in isolation: never install or overwrite a host inside the worktree.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
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
  const hostDirectory = resolve(stage, 'native/bin', key)
  mkdirSync(hostDirectory, { recursive: true })
  cpSync(resolve('native/target/debug', name), resolve(hostDirectory, name))
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
  console.log(`Packaged native consumer verified: ${key}`)
} finally { rmSync(temporary, { recursive: true, force: true }) }
