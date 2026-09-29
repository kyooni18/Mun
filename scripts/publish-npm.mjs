#!/usr/bin/env node

import { spawn } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { discoverReleaseTargets } from './release-targets.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packDir = resolve(root, 'local-packages')
const defaultRegistry = 'https://registry.npmjs.org/'
const interruptKillDelayMs = 500

let releaseTargets = []

const options = {
  bump: null,
  version: null,
  tag: null,
  registry: defaultRegistry,
  dryRun: false,
  plan: false,
  yes: false,
  quick: false,
  full: false,
  skipChecks: false,
  provenance: false,
  allowDirty: false,
}

class ReleaseFailure extends Error {}

class ReleaseInterrupted extends Error {
  constructor(signal) {
    super(`Release interrupted by ${signal}.`)
    this.signal = signal
    this.exitCode = signal === 'SIGINT' ? 130 : 143
  }
}

function fail(message) {
  throw new ReleaseFailure(message)
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function parseValue(args, index, flag) {
  const current = args[index]
  const equals = current.match(new RegExp(`^${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=(.+)$`))
  if (equals) return { value: equals[1], consumed: 0 }
  const next = args[index + 1]
  if (!next || next.startsWith('-')) fail(`${flag} requires a value`)
  return { value: next, consumed: 1 }
}

function parseArgs() {
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') continue
    if (arg === '--patch' || arg === '--minor' || arg === '--major') {
      const bump = arg.slice(2)
      if (options.bump || options.version) fail('Use only one of --patch, --minor, --major, or --version.')
      options.bump = bump
    } else if (arg === '--version' || arg.startsWith('--version=')) {
      if (options.bump || options.version) fail('Use only one of --patch, --minor, --major, or --version.')
      const parsed = parseValue(args, index, '--version')
      options.version = parsed.value
      index += parsed.consumed
    } else if (arg === '--tag' || arg.startsWith('--tag=')) {
      const parsed = parseValue(args, index, '--tag')
      options.tag = parsed.value
      index += parsed.consumed
    } else if (arg === '--registry' || arg.startsWith('--registry=')) {
      const parsed = parseValue(args, index, '--registry')
      options.registry = parsed.value
      index += parsed.consumed
    } else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--plan') options.plan = true
    else if (arg === '--yes' || arg === '-y') options.yes = true
    else if (arg === '--quick') options.quick = true
    else if (arg === '--full') options.full = true
    else if (arg === '--skip-checks') options.skipChecks = true
    else if (arg === '--provenance') options.provenance = true
    else if (arg === '--allow-dirty') options.allowDirty = true
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else fail(`Unknown option: ${arg}`)
  }

  if (!/^https?:\/\//u.test(options.registry)) fail(`Invalid registry URL: ${options.registry}`)
  if (options.tag && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.tag)) fail(`Invalid npm dist-tag: ${options.tag}`)
  if (options.quick && options.full) fail('Use only one of --quick or --full.')
}

function printHelp() {
  console.log(`Mün npm release helper

Usage:
  pnpm release
  pnpm release:dry
  pnpm release:patch
  pnpm release:minor
  pnpm release:major
  pnpm release -- --version 0.2.0-beta.1 --tag next

Options:
  --patch | --minor | --major   Bump every publishable package together.
  --version <semver>            Set an explicit version for every package.
  --tag <tag>                   npm dist-tag (stable defaults to latest, prerelease to next).
  --registry <url>              Registry URL (default: npmjs.org).
  --dry-run                     Pack everything and run npm publish --dry-run only.
  --plan                        Print package/version/order without building or publishing.
  --quick                       Run pnpm test only; skip production-browser smoke.
  --full                        Run benchmarks and the complete 7-target built-browser matrix.
  --skip-checks                 Skip verification entirely (not recommended).
  --provenance                  Pass --provenance to npm publish (mainly for supported CI).
  --allow-dirty                 Allow publishing from a dirty Git working tree.
  --yes, -y                     Skip the final interactive confirmation.
  --help, -h                    Show this help.

The script is resumable: an already-published package at the same version is skipped,
so rerunning after a partial release continues with the remaining packages.`)
}

function manifestFor(target) {
  return readJSON(target.manifestPath)
}

function validateSemver(version) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(version)
}

function bumpVersion(version, kind) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-[^+]+)?(?:\+.+)?$/u)
  if (!match) fail(`Cannot ${kind}-bump invalid version: ${version}`)
  let major = Number(match[1])
  let minor = Number(match[2])
  let patch = Number(match[3])
  if (kind === 'major') {
    major += 1
    minor = 0
    patch = 0
  } else if (kind === 'minor') {
    minor += 1
    patch = 0
  } else {
    patch += 1
  }
  return `${major}.${minor}.${patch}`
}

function currentVersion() {
  const versions = new Map(releaseTargets.map(target => [manifestFor(target).name, manifestFor(target).version]))
  const unique = new Set(versions.values())
  if (unique.size !== 1 && !options.bump && !options.version) {
    const detail = [...versions].map(([name, version]) => `  ${name}: ${version}`).join('\n')
    fail(`Publishable package versions are not synchronized:\n${detail}\nUse --version <semver> to synchronize them.`)
  }
  return manifestFor(releaseTargets.find(target => target.relativeDir === '.')).version
}

function targetVersion() {
  const current = currentVersion()
  const next = options.version ?? (options.bump ? bumpVersion(current, options.bump) : current)
  if (!validateSemver(next)) fail(`Invalid semantic version: ${next}`)
  return next
}

function syncVersions(version) {
  for (const target of releaseTargets) {
    const path = resolve(target.dir, 'package.json')
    const manifest = readJSON(path)
    if (manifest.version === version) continue
    manifest.version = version
    writeJSON(path, manifest)
    console.log(`Versioned ${manifest.name} -> ${version}`)
  }
}

function snapshotReleaseManifests() {
  return new Map(releaseTargets.map(target => [target.manifestPath, readFileSync(target.manifestPath, 'utf8')]))
}

function restoreReleaseManifests(snapshot) {
  for (const [path, contents] of snapshot) writeFileSync(path, contents)
}

async function buildReleaseTarballs(version) {
  if (!options.bump && !options.version) return packAll()

  const snapshot = snapshotReleaseManifests()
  try {
    syncVersions(version)
    return await packAll()
  } finally {
    restoreReleaseManifests(snapshot)
  }
}

function killCommandTree(child, signal, grouped) {
  if (!child.pid) return
  try {
    if (grouped) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

function command(commandName, args, { cwd = root, stdio = 'inherit', env = process.env, interactive = false } = {}) {
  const piped = stdio === 'pipe'
  const grouped = process.platform !== 'win32' && !interactive
  const child = spawn(commandName, args, {
    cwd,
    env,
    detached: grouped,
    stdio: piped ? ['ignore', 'pipe', 'pipe'] : interactive ? 'inherit' : ['ignore', 'inherit', 'inherit'],
  })

  let stdout = ''
  let stderr = ''
  let interruptedSignal = null
  let forceKillTimer = null

  if (piped) {
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
    }

    const interrupt = signal => {
      if (interruptedSignal) {
        killCommandTree(child, 'SIGKILL', grouped)
        return
      }
      interruptedSignal = signal
      killCommandTree(child, signal, grouped)
      forceKillTimer = setTimeout(() => killCommandTree(child, 'SIGKILL', grouped), interruptKillDelayMs)
    }
    const onSigint = () => interrupt('SIGINT')
    const onSigterm = () => interrupt('SIGTERM')

    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigterm)

    child.once('error', error => {
      cleanup()
      if (forceKillTimer) clearTimeout(forceKillTimer)
      rejectPromise(new ReleaseFailure(`Could not run ${commandName}: ${error.message}`))
    })
    child.once('close', (status, signal) => {
      cleanup()
      if (interruptedSignal) {
        // Keep the parent alive long enough to reap stubborn descendants in
        // the command's process group before returning terminal control.
        setTimeout(() => {
          killCommandTree(child, 'SIGKILL', grouped)
          rejectPromise(new ReleaseInterrupted(interruptedSignal))
        }, interruptKillDelayMs)
        return
      }
      if (forceKillTimer) clearTimeout(forceKillTimer)
      resolvePromise({ status, signal, stdout, stderr })
    })
  })
}

async function pnpm(args, settings = {}) {
  const cli = process.env.MUN_PNPM_CLI || (process.env.npm_execpath?.includes('pnpm') ? process.env.npm_execpath : null)
  if (!cli) return command('pnpm', args, settings)
  const cliIsJavaScript = /\.(?:cjs|mjs|js)$/u.test(cli)
  return cliIsJavaScript ? command(process.execPath, [cli, ...args], settings) : command(cli, args, settings)
}

async function assertGitClean() {
  if (options.allowDirty || !existsSync(resolve(root, '.git'))) return
  const result = await command('git', ['status', '--porcelain'], { stdio: 'pipe' })
  if (result.status !== 0) fail('git status failed. Use --allow-dirty only if you intentionally want to bypass this check.')
  if (result.stdout.trim()) fail('Git working tree is dirty. Commit/stash changes first, or explicitly pass --allow-dirty.')
}

async function runChecks() {
  if (options.skipChecks) {
    console.warn('Skipping release checks (--skip-checks).')
    return
  }
  if (options.quick) {
    console.log('\n==> Release checks (quick)')
    const result = await pnpm(['test'])
    if (result.status !== 0) fail('pnpm test failed.')
    return
  }
  if (options.full) {
    console.log('\n==> Release checks (full)')
    const result = await pnpm(['run', 'release:check:full'])
    if (result.status !== 0) fail('release:check:full failed.')
    return
  }
  console.log('\n==> Release checks')
  const result = await pnpm(['run', 'release:check'])
  if (result.status !== 0) fail('release:check failed.')
}

async function packAll() {
  console.log('\n==> Building release tarballs')
  const result = await pnpm(['run', 'pack:local'])
  if (result.status !== 0) fail('pack:local failed.')

  const tarballs = new Map()
  for (const file of readdirSync(packDir)) {
    if (!file.endsWith('.tgz')) continue
    const path = resolve(packDir, file)
    const extracted = await command('tar', ['-xOf', path, 'package/package.json'], { stdio: 'pipe' })
    if (extracted.status !== 0) fail(`Could not inspect ${file}.`)
    const manifest = JSON.parse(extracted.stdout)
    tarballs.set(manifest.name, { path, manifest })
  }

  for (const target of releaseTargets) {
    const name = manifestFor(target).name
    const packed = tarballs.get(name)
    if (!packed) fail(`pack:local did not produce ${name}.`)
  }
  return tarballs
}

async function npm(args, settings = {}) {
  return command('npm', [...args, '--registry', options.registry], settings)
}

async function authPreflight() {
  console.log('\n==> npm authentication')
  const result = await npm(['whoami'], { stdio: 'pipe' })
  if (result.status !== 0) {
    fail(`npm authentication failed. Run \`npm login\` for ${options.registry} first.\n${result.stderr.trim()}`)
  }
  const username = result.stdout.trim()
  console.log(`Authenticated as ${username}`)

  if (username !== 'mun') {
    const scopeProbe = await npm(['team', 'ls', 'mun:developers', '--json'], { stdio: 'pipe' })
    if (scopeProbe.status !== 0) {
      console.warn('Warning: could not verify membership in the npm @mun organization.')
      console.warn('First-time scoped publishing requires access to the @mun scope; npm publish will be authoritative.')
    }
  }
  return username
}

async function packageVersionExists(name, version) {
  const result = await npm(['view', `${name}@${version}`, 'version', '--json'], { stdio: 'pipe' })
  if (result.status === 0) return true
  const message = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (/E404|404 Not Found|is not in this registry/iu.test(message)) return false
  fail(`Could not query ${name}@${version} from npm:\n${message.trim()}`)
}

async function ensureDistTag(name, version, tag) {
  const result = await npm(['view', name, 'dist-tags', '--json'], { stdio: 'pipe' })
  if (result.status !== 0) fail(`Could not query dist-tags for ${name}:\n${`${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()}`)
  let tags
  try {
    tags = JSON.parse(result.stdout || '{}')
  } catch {
    fail(`npm returned invalid dist-tag data for ${name}: ${result.stdout.trim()}`)
  }
  if (tags?.[tag] === version) return
  const tagged = await npm(['dist-tag', 'add', `${name}@${version}`, tag])
  if (tagged.status !== 0) fail(`Could not set dist-tag ${tag} on ${name}@${version}.`)
  console.log(`TAG  ${name}@${version} -> ${tag}`)
}

function printPlan(version, tag) {
  console.log(`\nMün npm release plan`)
  console.log(`  Version : ${version}`)
  console.log(`  Tag     : ${tag}`)
  console.log(`  Registry: ${options.registry}`)
  console.log(`  Mode    : ${options.dryRun ? 'dry-run' : 'publish'}`)
  console.log('  Order:')
  for (const [index, target] of releaseTargets.entries()) {
    const manifest = manifestFor(target)
    console.log(`    ${index + 1}. ${manifest.name}@${version}`)
  }
}

async function confirmPublish(version, tag) {
  if (options.yes || options.dryRun) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('Non-interactive publishing requires --yes.')
  const rl = createInterface({ input, output })
  let rejectInterrupt
  const interrupted = new Promise((_, reject) => { rejectInterrupt = reject })
  const onSigint = () => rejectInterrupt(new ReleaseInterrupted('SIGINT'))
  const onSigterm = () => rejectInterrupt(new ReleaseInterrupted('SIGTERM'))
  rl.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  try {
    const answer = await Promise.race([
      rl.question(`\nPublish Mün ${version} to npm with dist-tag "${tag}"? [y/N] `),
      interrupted,
    ])
    if (!/^(y|yes)$/iu.test(answer.trim())) {
      console.log('Release cancelled.')
      process.exit(0)
    }
  } finally {
    rl.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    rl.close()
  }
}

function publishArgs(tarball, manifest, tag) {
  const args = ['publish', tarball, '--tag', tag]
  if (manifest.name.startsWith('@')) args.push('--access', 'public')
  if (options.provenance) args.push('--provenance')
  if (options.dryRun) args.push('--dry-run')
  return args
}

async function main() {
  parseArgs()
  try {
    releaseTargets = discoverReleaseTargets(root)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  const version = targetVersion()
  const tag = options.tag ?? (version.includes('-') ? 'next' : 'latest')

  if (options.plan) {
    printPlan(version, tag)
    return
  }

  await assertGitClean()

  // Validate before mutating manifests: a failed check must not leave the
  // working tree dirty at bumped versions, which would block a resumable
  // rerun behind the assertGitClean gate above.
  await runChecks()
  printPlan(version, tag)

  const tarballs = await buildReleaseTarballs(version)

  for (const target of releaseTargets) {
    const expected = manifestFor(target)
    const packed = tarballs.get(expected.name)
    if (packed.manifest.version !== version) {
      fail(`${expected.name} tarball has version ${packed.manifest.version}, expected ${version}.`)
    }
    if (/workspace:/u.test(JSON.stringify(packed.manifest))) {
      fail(`${expected.name} tarball still contains a workspace: dependency.`)
    }
  }

  if (!options.dryRun) await authPreflight()
  await confirmPublish(version, tag)

  console.log(`\n==> ${options.dryRun ? 'Dry-running' : 'Publishing'} packages`)
  const skipped = []
  const published = []

  for (const target of releaseTargets) {
    const name = manifestFor(target).name
    const packed = tarballs.get(name)

    if (!options.dryRun && await packageVersionExists(name, version)) {
      console.log(`SKIP ${name}@${version} (already published)`)
      await ensureDistTag(name, version, tag)
      skipped.push(name)
      continue
    }

    console.log(`${options.dryRun ? 'DRY ' : ''}PUBLISH ${name}@${version}`)
    const result = await npm(publishArgs(packed.path, packed.manifest, tag), { interactive: true })
    if (result.status !== 0) {
      fail(`${name}@${version} was not published. Fix the npm error and rerun the same release command; already-published packages will be skipped.`)
    }
    published.push(name)
  }

  console.log('\nMun release complete.')
  console.log(`  Version  : ${version}`)
  console.log(`  Dist-tag : ${tag}`)
  console.log(`  Published: ${published.length}`)
  if (skipped.length) console.log(`  Resumed/skipped: ${skipped.length}`)
  if (options.dryRun) console.log('  Nothing was uploaded (dry-run).')
  else if (options.bump || options.version) syncVersions(version)
}

main().catch(error => {
  if (error instanceof ReleaseInterrupted) {
    console.error('\nMun release interrupted.')
    process.exitCode = error.exitCode
    return
  }
  const message = error instanceof ReleaseFailure
    ? error.message
    : error instanceof Error
      ? error.stack ?? error.message
      : String(error)
  console.error(`\nMun release failed: ${message}`)
  process.exitCode = 1
})
