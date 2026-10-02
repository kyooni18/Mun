import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileMunUiProgram } from '@mun/compiler'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageManifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))

function displayPath(path, cwd) {
  const local = relative(cwd, path)
  return local && !local.startsWith('..') ? local : path
}

export function nativeBinaryName() {
  return process.platform === 'win32' ? 'mun-native.exe' : 'mun-native'
}

function nativeCacheRoot(env) {
  if (env.MUN_CACHE_DIR) return resolve(env.MUN_CACHE_DIR)
  if (process.platform === 'darwin') return resolve(homedir(), 'Library', 'Caches', 'Mun')
  if (process.platform === 'win32') {
    return resolve(env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'Mun', 'Cache')
  }
  return resolve(env.XDG_CACHE_HOME || resolve(homedir(), '.cache'), 'mun')
}

function runProcess(command, args, options) {
  const result = spawnSync(command, args, options)
  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`)
  return result.status ?? 1
}

export function resolveNativeHost(cwd, env, irVersion) {
  const override = env.MUN_NATIVE_HOST?.trim()
  if (override) {
    const command = override.includes('/') || override.includes('\\') || override.includes(sep)
      ? resolve(cwd, override)
      : override
    return { kind: 'binary', command }
  }

  const binary = nativeBinaryName()
  const key = `${process.platform}-${process.arch}`
  const packaged = resolve(packageRoot, 'native', 'bin', key, binary)
  if (existsSync(packaged)) {
    verifyPackagedHost(resolve(packageRoot, 'native', 'bin', key, 'mun-native.json'), key, irVersion)
    return { kind: 'binary', command: packaged }
  }

  // Building the host from source is a development path for repository
  // checkouts (or an explicit opt-in); installed packages use a packaged host.
  const manifest = resolve(packageRoot, 'native', 'Cargo.toml')
  const developmentCheckout = existsSync(resolve(packageRoot, '.git'))
  if (existsSync(manifest) && (developmentCheckout || env.MUN_NATIVE_BUILD_FROM_SOURCE === '1')) {
    return { kind: 'cargo', manifest }
  }

  throw new Error(
    `No Mün native host is packaged for ${key} in ${packageManifest.name}@${packageManifest.version}. ` +
      'Install a release that includes this platform, set MUN_NATIVE_HOST to a mun-native executable, ' +
      'or set MUN_NATIVE_BUILD_FROM_SOURCE=1 to build one with Cargo.',
  )
}

/** Reject a packaged host assembled for another package version, IR contract or platform. */
function verifyPackagedHost(path, key, irVersion) {
  let metadata
  try {
    metadata = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Packaged Mün native host for ${key} has no readable metadata (${path}): ${error.message}`)
  }
  const expected = {
    packageVersion: packageManifest.version,
    semanticUiIrVersion: irVersion,
    platform: process.platform,
    arch: process.arch,
  }
  for (const [field, value] of Object.entries(expected)) {
    if (metadata[field] !== value) {
      throw new Error(
        `Packaged Mün native host for ${key} was built for ${field} ${JSON.stringify(metadata[field])}, ` +
          `but this ${packageManifest.name} requires ${JSON.stringify(value)}. Reinstall ${packageManifest.name} or set MUN_NATIVE_HOST.`,
      )
    }
  }
}

export function runNativeSource(inputArg, {
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const input = resolve(cwd, inputArg)
  if (!input.endsWith('.mun')) {
    throw new Error(`Mün run expects canonical .mun source: ${displayPath(input, cwd)}`)
  }

  const source = readFileSync(input, 'utf8')
  const program = compileMunUiProgram(source, input)
  const temporary = mkdtempSync(resolve(tmpdir(), 'mun-native-'))
  const ir = resolve(temporary, 'program.mun.ir.json')

  try {
    writeFileSync(ir, `${JSON.stringify(program, null, 2)}\n`)
    const host = resolveNativeHost(cwd, env, program.version)

    if (host.kind === 'binary') {
      return runProcess(host.command, [ir], { cwd, env, stdio: 'inherit' })
    }

    const cache = resolve(
      nativeCacheRoot(env),
      'native',
      packageManifest.version,
      `${process.platform}-${process.arch}`,
    )
    mkdirSync(cache, { recursive: true })
    const cargo = env.CARGO?.trim() || 'cargo'
    return runProcess(
      cargo,
      ['run', '--locked', '--manifest-path', host.manifest, '-p', 'mun-native', '--', ir],
      {
        cwd: packageRoot,
        env: { ...env, CARGO_TARGET_DIR: env.CARGO_TARGET_DIR || cache },
        stdio: 'inherit',
      },
    )
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
