import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export async function discoverMunCommand({ cwd, command, expectedVersion, env = process.env }) {
  let selected
  if (command) selected = { command, args: [] }
  else {
    let directory = resolve(cwd)
    while (true) {
      const root = resolve(directory, 'node_modules/@mun/ui')
      if (existsSync(resolve(root, 'package.json'))) {
        const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
        if (manifest.version !== expectedVersion) throw new Error(`Workspace Mün ${manifest.version} does not match extension ${expectedVersion}. Install matching versions; refusing a global fallback.`)
        const cli = resolve(root, 'bin/mun.mjs')
        if (!existsSync(cli)) throw new Error(`Workspace Mün CLI is missing: ${cli}`)
        selected = { command: process.execPath, args: [cli], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
        break
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    selected ??= { command: 'mun', args: [] }
  }
  const actual = await commandVersion(selected, cwd, env)
  if (actual !== expectedVersion) throw new Error(`Selected Mün ${actual} does not match extension ${expectedVersion}. Install matching versions or set mun.server.command.`)
  return { ...selected, cwd, env: selected.env ?? env }
}

export async function discoverToolchain(options) {
  const selected = await discoverMunCommand(options)
  return { ...selected, args: [...selected.args, 'lsp', '--stdio'] }
}

function commandVersion(selected, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(selected.command, [...selected.args, '--version'], { cwd, env: selected.env ?? env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Mün version check timed out.')) }, 5000)
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 8192) { child.kill(); reject(new Error('Invalid Mün version output.')) } })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
    child.once('error', error => { clearTimeout(timer); reject(new Error(`Cannot start Mün: ${error.message}. Install @mun/ui or set mun.server.command.`)) })
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error(`Mün version check failed: ${stderr}`)) })
  })
}
