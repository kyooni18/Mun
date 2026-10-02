import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
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

export function buildProject(project, program, env, packageApp = false) {
  requirePlatform(project)
  validateAssets(project)
  if (project.manifest.fonts?.length) throw new Error('Bundled font registration is not yet supported by the native renderer. Remove fonts until the renderer exposes this contract.')
  const binary = hostBinary(project, program, env)
  const parent = projectPath(project.root, `.mun/${packageApp ? 'package' : 'build'}/${process.platform}-${process.arch}`)
  mkdirSync(parent, { recursive: true })
  const stage = mkdtempSync(resolve(parent, '.stage-'))
  const name = project.manifest.name.replace(/[^A-Za-z0-9_-]/gu, '_') || 'MunApp'
  const isApp = packageApp && process.platform === 'darwin'
  const destination = projectPath(project.root, `.mun/${packageApp ? 'package' : 'build'}/${process.platform}-${process.arch}/${isApp ? `${name}.app` : name}`)
  try {
    const executableDir = isApp ? resolve(stage, 'Contents/MacOS') : stage
    const resources = isApp ? resolve(stage, 'Contents/Resources') : resolve(stage, 'Resources')
    mkdirSync(executableDir, { recursive: true })
    mkdirSync(resources, { recursive: true })
    cpSync(binary, resolve(executableDir, nativeBinaryName()))
    chmodSync(resolve(executableDir, nativeBinaryName()), 0o755)
    writeFileSync(resolve(resources, 'program.mun.ir.json'), `${JSON.stringify(program, null, 2)}\n`)
    writeFileSync(resolve(resources, 'application.json'), `${JSON.stringify(project.manifest, null, 2)}\n`)
    for (const resource of [...(project.manifest.resources ?? []), ...(project.manifest.icon ? [project.manifest.icon] : [])]) {
      cpSync(projectPath(project.root, resource), resolve(resources, 'bundled', resource), { recursive: true })
    }
    if (process.platform === 'win32') {
      writeFileSync(resolve(stage, 'Run.cmd'), '@echo off\r\n"%~dp0mun-native.exe" "%~dp0Resources\\program.mun.ir.json"\r\n')
    } else {
      const launcher = isApp ? resolve(executableDir, 'launch') : resolve(stage, 'launch')
      const resourcePath = isApp ? '../Resources' : 'Resources'
      writeFileSync(launcher, `#!/bin/sh\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport MUN_RESOURCE_DIR="$HERE/${resourcePath}"\nexec "$HERE/mun-native" "$HERE/${resourcePath}/program.mun.ir.json"\n`)
      chmodSync(launcher, 0o755)
    }
    if (isApp) {
      if (project.manifest.icon && !project.manifest.icon.endsWith('.icns')) throw new Error('macOS application icons must be .icns files.')
      const icon = project.manifest.icon ? `<key>CFBundleIconFile</key><string>bundled/${xml(project.manifest.icon)}</string>` : ''
      writeFileSync(resolve(stage, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>launch</string><key>CFBundleIdentifier</key><string>${xml(project.manifest.identifier)}</string><key>CFBundleName</key><string>${xml(project.manifest.name)}</string><key>CFBundleShortVersionString</key><string>${xml(project.manifest.version)}</string><key>CFBundleVersion</key><string>${xml(project.manifest.version)}</string><key>CFBundlePackageType</key><string>APPL</string>${icon}</dict></plist>\n`)
    }
    rmSync(destination, { recursive: true, force: true })
    renameSync(stage, destination)
    console.log(`${packageApp ? 'Packaged (unsigned)' : 'Built'} native application: ${destination}`)
    if (isApp) console.log(`Signing: codesign --force --deep --options runtime --sign "Developer ID Application: YOUR IDENTITY" "${destination}"\nNotarization: ditto -c -k --keepParent "${destination}" "${destination}.zip" && xcrun notarytool submit "${destination}.zip" --keychain-profile YOUR_PROFILE --wait\nThen: xcrun stapler staple "${destination}"`)
    return destination
  } finally { rmSync(stage, { recursive: true, force: true }) }
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
      const source = readFileSync(path, 'utf8'), formatted = formatSource(source)
      if (source !== formatted) { changed = true; console.log(`${options.check ? 'Needs formatting' : 'Formatted'}: ${path}`); if (!options.check) writeFileSync(path, formatted) }
    }
    return options.check && changed ? 1 : 0
  }
  if (command === 'dev') return develop(project, { env, verbose: options.verbose })
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
  if (command === 'build' || command === 'package') { buildProject(project, program, env, command === 'package'); return 0 }
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
