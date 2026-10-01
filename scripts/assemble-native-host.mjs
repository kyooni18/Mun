// Assemble a release Mün native host for one OS/architecture into
// <out>/native/bin/<platform>-<arch>/ with a metadata file that launchers use
// to reject a host built for another package version or IR contract.
//
//   node scripts/assemble-native-host.mjs --out <dir> [--target <rust-triple>] [--profile release|debug]
//
// The worktree is never written to except Cargo's target directory. Signing
// and notarization are external release steps (docs/native-release.md); the
// metadata records `signed: false` until that step replaces the binary.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const triples = {
  'aarch64-apple-darwin': ['darwin', 'arm64'],
  'x86_64-apple-darwin': ['darwin', 'x64'],
  'x86_64-pc-windows-msvc': ['win32', 'x64'],
  'aarch64-pc-windows-msvc': ['win32', 'arm64'],
  'x86_64-unknown-linux-gnu': ['linux', 'x64'],
  'aarch64-unknown-linux-gnu': ['linux', 'arm64'],
}

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`)
  return result.stdout
}

export function assembleNativeHost({ out, target, profile = 'release' }) {
  if (!out) throw new Error('--out <directory> is required')
  if (!['release', 'debug'].includes(profile)) throw new Error(`unsupported profile ${profile}`)
  const [platform, arch] = target ? triples[target] ?? [] : [process.platform, process.arch]
  if (!platform) throw new Error(`unsupported target ${target}; known: ${Object.keys(triples).join(', ')}`)
  const executable = platform === 'win32' ? 'mun-native.exe' : 'mun-native'
  const cargoArgs = ['build', '--locked', '--manifest-path', resolve(root, 'native/Cargo.toml'), '-p', 'mun-native']
  if (profile === 'release') cargoArgs.push('--release')
  if (target) cargoArgs.push('--target', target)
  run(process.env.CARGO?.trim() || 'cargo', cargoArgs, { stdio: 'inherit' })

  const targetDirectory = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : resolve(root, 'native/target')
  const built = resolve(targetDirectory, ...(target ? [target] : []), profile, executable)
  const directory = resolve(out, 'native/bin', `${platform}-${arch}`)
  mkdirSync(directory, { recursive: true })
  const host = resolve(directory, executable)
  copyFileSync(built, host)
  if (platform !== 'win32') chmodSync(host, 0o755)

  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const native = target === undefined || triples[target]?.join('-') === `${process.platform}-${process.arch}`
  // A host that can run here describes itself; a cross-built one cannot.
  const info = native ? JSON.parse(run(host, ['--host-info'])) : null
  if (info && info.profile !== profile) throw new Error(`assembled ${info.profile} host for a ${profile} assembly`)
  const metadata = {
    package: manifest.name,
    packageVersion: manifest.version,
    semanticUiIrVersion: info?.semanticUiIrVersion ?? 1,
    crateVersion: info?.crateVersion ?? null,
    platform,
    arch,
    target: target ?? null,
    profile,
    executable,
    sha256: createHash('sha256').update(readFileSync(host)).digest('hex'),
    signed: false,
  }
  writeFileSync(resolve(directory, 'mun-native.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  return { host, metadata }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { host, metadata } = assembleNativeHost({
    out: option('--out') && resolve(option('--out')),
    target: option('--target'),
    profile: option('--profile', 'release'),
  })
  console.log(`Assembled ${metadata.profile} Mün native host ${metadata.platform}-${metadata.arch}: ${host}`)
}
