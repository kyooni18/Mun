import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { basename, dirname, resolve } from 'node:path'
import { createFrameDecoder, encodeFrame } from './dev-protocol.mjs'
import { fileURLToPath } from 'node:url'
import { discoverProject, compileProject, sourceFiles, validateAssets, requirePlatform, projectPath } from './project.mjs'
import { resolveNativeHost, nativeBinaryName } from './native.mjs'
import { formatSource } from './formatter.mjs'
import { develop } from './watch.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const toolchain = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))

export function projectEnvironment(project) {
  const path = resolve(project.root, 'mun.local.json')
  if (!existsSync(path)) return { ...process.env }
  let local
  try { local = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { throw new Error(`${path}: ${error.message}`) }
  if (!local || typeof local !== 'object' || Array.isArray(local) || Object.keys(local).some(key => key !== 'env')) throw new Error(`${path}: expected { "env": { "NAME": "value" } }`)
  if (!local.env || typeof local.env !== 'object' || Array.isArray(local.env) || Object.values(local.env).some(value => typeof value !== 'string')) throw new Error(`${path}: env values must be strings.`)
  return { ...process.env, ...local.env }
}

export function hostBinary(project, program, env) {
  const host = resolveNativeHost(project.root, env, program.version)
  if (host.kind === 'binary') return host.command
  const target = resolve(project.root, '.mun', 'cargo')
  const result = spawnSync(env.CARGO || 'cargo', ['build', '--release', '--locked', '--manifest-path', host.manifest, '-p', 'mun-native'], { stdio: 'inherit', env: { ...env, CARGO_TARGET_DIR: target } })
  if (result.error || result.status !== 0) throw new Error(`Native release host build failed: ${result.error?.message ?? result.status}`)
  return resolve(target, 'release', nativeBinaryName())
}

export function launchProgram(project, program, env) {
  const directory = mkdtempSync(resolve(tmpdir(), 'mun-run-'))
  const path = resolve(directory, 'program.mun.ir.json')
  try {
    writeFileSync(path, `${JSON.stringify(program, null, 2)}\n`)
    const child = spawn(hostBinary(project, program, env), [path], { cwd: project.root, env, stdio: 'inherit' })
    child.once('close', () => rmSync(directory, { recursive: true, force: true }))
    child.once('error', () => rmSync(directory, { recursive: true, force: true }))
    return child
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
}

function xml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') }

function plistValue(value) {
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>'
  return `<string>${xml(value)}</string>`
}

/** Info.plist for a macOS bundle whose CFBundleExecutable is the real native binary. */
export function macInfoPlist(manifest, executable, iconFile) {
  const entries = {
    CFBundleDevelopmentRegion: 'en',
    CFBundleExecutable: executable,
    CFBundleIdentifier: manifest.identifier,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: manifest.name.slice(0, 15),
    CFBundleDisplayName: manifest.window_title ?? manifest.name,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: manifest.version,
    CFBundleVersion: manifest.version,
    LSMinimumSystemVersion: '11.0',
    NSHighResolutionCapable: true,
    NSPrincipalClass: 'NSApplication',
    ...(iconFile ? { CFBundleIconFile: iconFile } : {}),
  }
  const body = Object.entries(entries).map(([key, value]) => `\t<key>${key}</key>\n\t${plistValue(value)}`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`
}

/** Executable file name for a packaged app: the manifest name, filesystem-safe. */
export function packagedExecutableName(manifest, platform = process.platform) {
  const base = manifest.name.replace(/[^\p{L}\p{N} _-]/gu, '_').trim() || 'MunApp'
  return platform === 'win32' ? `${base}.exe` : base
}

export function buildProject(project, program, env, packageApp = false, options = {}) {
  requirePlatform(project)
  validateAssets(project)
  if (project.manifest.fonts?.length) throw new Error('Bundled font registration is not yet supported by the native renderer. Remove fonts until the renderer exposes this contract.')
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/u.test(project.manifest.identifier)) throw new Error(`Invalid bundle identifier ${JSON.stringify(project.manifest.identifier)}: use reverse-DNS segments of letters, digits and hyphens (e.g. com.example.App).`)
  if ((options.sign || options.notarizeProfile) && !(packageApp && process.platform === 'darwin')) throw new Error('--sign/--notarize-profile apply to macOS mun package only.')
  if (options.notarizeProfile && !options.sign) throw new Error('Notarization requires --sign with a Developer ID Application identity.')
  const binary = hostBinary(project, program, env)
  const parent = projectPath(project.root, `.mun/${packageApp ? 'package' : 'build'}/${process.platform}-${process.arch}`)
  mkdirSync(parent, { recursive: true })
  const stage = mkdtempSync(resolve(parent, '.stage-'))
  const name = project.manifest.name.replace(/[^A-Za-z0-9_-]/gu, '_') || 'MunApp'
  const isApp = packageApp && process.platform === 'darwin'
  const destination = projectPath(project.root, `.mun/${packageApp ? 'package' : 'build'}/${process.platform}-${process.arch}/${isApp ? `${name}.app` : name}`)
  const executable = packagedExecutableName(project.manifest)
  try {
    const executableDir = isApp ? resolve(stage, 'Contents/MacOS') : stage
    const resources = isApp ? resolve(stage, 'Contents/Resources') : resolve(stage, 'Resources')
    mkdirSync(executableDir, { recursive: true })
    mkdirSync(resources, { recursive: true })
    // The native host itself is the application executable: with no
    // arguments it loads Resources/program.mun.ir.json relative to its own
    // location (bundle- or directory-relative, never the working directory).
    cpSync(binary, resolve(executableDir, executable))
    chmodSync(resolve(executableDir, executable), 0o755)
    writeFileSync(resolve(resources, 'program.mun.ir.json'), `${JSON.stringify(program)}\n`)
    writeFileSync(resolve(resources, 'application.json'), `${JSON.stringify(project.manifest, null, 2)}\n`)
    for (const resource of project.manifest.resources ?? []) {
      cpSync(projectPath(project.root, resource), resolve(resources, 'bundled', resource), { recursive: true })
    }
    let iconFile
    if (project.manifest.icon) {
      if (isApp && !project.manifest.icon.endsWith('.icns')) throw new Error('macOS application icons must be .icns files.')
      iconFile = basename(project.manifest.icon)
      cpSync(projectPath(project.root, project.manifest.icon), resolve(resources, iconFile))
    }
    if (isApp) writeFileSync(resolve(stage, 'Contents/Info.plist'), macInfoPlist(project.manifest, executable, iconFile))
    rmSync(destination, { recursive: true, force: true })
    renameSync(stage, destination)
  } finally { rmSync(stage, { recursive: true, force: true }) }

  if (isApp) {
    const lint = spawnSync('plutil', ['-lint', resolve(destination, 'Contents/Info.plist')], { encoding: 'utf8' })
    if (lint.status !== 0) throw new Error(`Generated Info.plist failed plutil -lint: ${lint.stdout}${lint.stderr}`)
  }
  if (options.sign) {
    signMacApp(destination, options.sign, env)
    console.log(`Packaged and signed (${options.sign}) native application: ${destination}`)
    if (options.notarizeProfile) notarizeMacApp(destination, options.notarizeProfile, env)
  } else {
    console.log(`${packageApp ? 'Packaged (unsigned — not distribution-ready)' : 'Built'} native application: ${destination}`)
    if (isApp) console.log('To sign: mun package --sign "Developer ID Application: …" [--notarize-profile <notarytool keychain profile>]')
  }
  return destination
}

function run(command, args, env, what) {
  const result = spawnSync(command, args, { encoding: 'utf8', env })
  if (result.error || result.status !== 0) throw new Error(`${what} failed: ${result.error?.message ?? `${result.stdout}${result.stderr}`.trim()}`)
  return result
}

function signMacApp(app, identity, env) {
  if (identity === '-') throw new Error('Ad-hoc signing is not distribution signing; pass a Developer ID Application identity to --sign.')
  run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, app], env, 'codesign')
  run('codesign', ['--verify', '--strict', '--verbose=2', app], env, 'codesign --verify')
}

function notarizeMacApp(app, profile, env) {
  const archive = `${app}.zip`
  try {
    run('ditto', ['-c', '-k', '--keepParent', app, archive], env, 'ditto')
    run('xcrun', ['notarytool', 'submit', archive, '--keychain-profile', profile, '--wait'], env, 'notarytool submit')
    run('xcrun', ['stapler', 'staple', app], env, 'stapler staple')
    console.log(`Notarized and stapled: ${app}`)
  } finally { rmSync(archive, { force: true }) }
}

/** `mun inspect`: query the running `mun dev` session's native app. */
export async function inspectProject(project, { values = false, json = false } = {}) {
  const file = resolve(project.root, '.mun', 'dev', 'session.json')
  if (!existsSync(file)) throw new Error('No running mun dev session for this project.')
  const session = JSON.parse(readFileSync(file, 'utf8'))
  const [host, port] = session.endpoint.split(':')
  if (host !== '127.0.0.1') throw new Error('Refusing non-loopback inspector endpoint.')
  const socket = connect({ host, port: Number(port) })
  const reply = await new Promise((resolvePromise, reject) => {
    socket.once('error', error => reject(new Error(`Could not reach mun dev (${error.message}); is it still running?`)))
    socket.on('data', createFrameDecoder(message => { resolvePromise(message); socket.end() }))
    socket.once('connect', () => {
      socket.write(encodeFrame({ type: 'hello', token: session.token }))
      socket.write(encodeFrame({ type: 'inspect', id: 1, includeValues: values }))
    })
  })
  if (reply.type === 'error') throw new Error(reply.message)
  if (json) { console.log(JSON.stringify(reply.snapshot, null, 2)); return 0 }
  console.log(formatSnapshot(reply.snapshot))
  return 0
}

export function formatSnapshot(snapshot) {
  const nodes = new Map(snapshot.nodes.map(node => [node.id, node]))
  const lines = [`${snapshot.title} — entry ${snapshot.entry}, runtime revision ${snapshot.revision}${snapshot.devRevision !== undefined ? `, dev revision ${snapshot.devRevision}` : ''}, ${snapshot.primitives ?? '?'} primitives${snapshot.activeAnimations ? ', animating' : ''}`]
  if (snapshot.focus) lines.push(`focus: ${snapshot.focus}`)
  const short = id => id.replace(/^@node\/entry\//u, '').replace(/\/kind\/[A-Za-z]+$/u, '')
  const visit = (node, depth) => {
    const frame = node.frame ? ` [${node.frame.map(value => Math.round(value)).join(', ')}]` : ''
    const component = node.component ? ` <${node.component}>` : ''
    const scroll = node.scrollOffset ? ` scroll=${node.scrollOffset.map(value => Math.round(value)).join(',')}` : ''
    const source = node.source ? ` @ ${node.source.file}:${node.source.line}:${node.source.column}` : ''
    lines.push(`${'  '.repeat(depth)}${node.kind}${component}${frame}${scroll}  ${short(node.id)}${source}`)
    for (const child of node.children) if (nodes.has(child)) visit(nodes.get(child), depth + 1)
  }
  const root = snapshot.nodes.find(node => !node.parent)
  if (root) visit(root, 0)
  lines.push('state:')
  for (const state of snapshot.states) {
    const value = state.redacted ? '<redacted>' : 'value' in state ? JSON.stringify(state.value) : `<${state.valueKind}>`
    lines.push(`  ${state.name} = ${value}`)
  }
  return lines.join('\n')
}

export async function projectCommand(command, options) {
  let project
  try { project = discoverProject(options.projectRoot ?? process.cwd()) }
  catch (error) {
    if (command !== 'doctor') throw error
    console.log(`Mün ${toolchain.version}; ${process.platform}/${process.arch}\nWARNING: ${error.message}\nLSP: mun lsp --stdio`)
    return 1
  }
  if (project.manifest.minimum_mun_version) {
    const required = project.manifest.minimum_mun_version.split('.').map(Number)
    const current = toolchain.version.split('.').map(Number)
    const difference = current.map((value, i) => value - required[i]).find(value => value !== 0) ?? 0
    if (difference < 0) throw new Error(`Project requires Mün >= ${project.manifest.minimum_mun_version}; selected CLI/compiler is ${toolchain.version}.`)
  }
  const env = projectEnvironment(project)
  if (command === 'fmt') {
    let changed = false
    for (const path of sourceFiles(project)) {
      const source = readFileSync(path, 'utf8'), crlf = source.includes('\r\n')
      // Line endings are preserved: a CRLF checkout (Windows autocrlf) is not "unformatted".
      const formatted = crlf ? formatSource(source.replace(/\r\n/gu, '\n')).replace(/\n/gu, '\r\n') : formatSource(source)
      if (source !== formatted) { changed = true; console.log(`${options.check ? 'Needs formatting' : 'Formatted'}: ${path}`); if (!options.check) writeFileSync(path, formatted) }
    }
    return options.check && changed ? 1 : 0
  }
  if (command === 'dev') return develop(project, { env, verbose: options.verbose })
  if (command === 'inspect') return inspectProject(project, options)
  const program = compileProject(project)
  if (command === 'check') { console.log(`Checked ${sourceFiles(project).length} Mün source file(s).`); return 0 }
  if (command === 'doctor') {
    console.log(`Mün CLI/compiler: ${toolchain.version}\nManifest: ${project.manifest.manifest_version}\nOS/architecture: ${process.platform}/${process.arch}\nEntry: ${project.entry}\nLSP: mun lsp --stdio`)
    let fatal = false
    try { validateAssets(project); console.log('Assets: OK') } catch (error) { console.log(`ERROR: ${error.message}`); fatal = true }
    try {
      const host = resolveNativeHost(project.root, env, program.version)
      console.log(`Native host: ${host.kind === 'binary' ? host.command : 'Cargo fallback (locked release build)'}`)
      if (host.kind === 'cargo') {
        const rust = spawnSync(env.CARGO || 'cargo', ['--version'], { encoding: 'utf8', timeout: 5000 })
        if (rust.status !== 0) { console.log('ERROR: Cargo fallback requires Rust/Cargo.'); fatal = true } else console.log(rust.stdout.trim())
      }
    } catch (error) { console.log(`ERROR: ${error.message}`); fatal = true }
    if (process.platform === 'darwin') {
      const xcode = spawnSync('xcode-select', ['-p'], { encoding: 'utf8', timeout: 5000 })
      console.log(`${xcode.status === 0 ? 'Xcode' : 'WARNING: Xcode unavailable'}: ${xcode.stdout?.trim() ?? ''}`)
    }
    return fatal ? 1 : 0
  }
  if (command === 'build' || command === 'package') { buildProject(project, program, env, command === 'package', { sign: options.sign, notarizeProfile: options.notarizeProfile }); return 0 }
  if (command === 'run') {
    requirePlatform(project)
    const child = launchProgram(project, program, env)
    const stop = () => child.kill('SIGTERM')
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    try { return await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)) }) }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
  }
  throw new Error(`Unsupported project command: ${command}`)
}
