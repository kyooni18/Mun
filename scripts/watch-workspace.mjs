#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = resolve(root, 'node_modules/typescript/bin/tsc')
const targets = [
  ['execution', 'packages/execution/tsconfig.json'],
  ['core', 'packages/core/tsconfig.json'],
  ['compiler', 'packages/compiler/tsconfig.json'],
  ['legacy-react', 'packages/legacy-react/tsconfig.json'],
  ['react', 'packages/react/tsconfig.json'],
  ['vue', 'packages/vue/tsconfig.json'],
  ['web', 'packages/web/tsconfig.json'],
  ['vite', 'packages/vite/tsconfig.json'],
  ['root', 'tsconfig.build.json'],
]

if (!existsSync(tsc)) {
  console.error('Mün dependencies are not installed. Run `pnpm install` first.')
  process.exit(1)
}

if (!process.argv.includes('--no-build')) {
  const pnpmCli = process.env.npm_execpath
  const cliIsJavaScript = Boolean(pnpmCli && /\.(?:cjs|mjs|js)$/u.test(pnpmCli))
  const command = pnpmCli ? (cliIsJavaScript ? process.execPath : pnpmCli) : 'pnpm'
  const args = cliIsJavaScript ? [pnpmCli, 'run', 'build'] : ['run', 'build']
  const build = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

console.log('Watching Mün package outputs. Press Ctrl+C to stop.')
const children = targets.map(([name, config]) => {
  const child = spawn(process.execPath, [tsc, '--watch', '--project', resolve(root, config), '--preserveWatchOutput'], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const prefix = `[${name}] `
  child.stdout.on('data', chunk => process.stdout.write(prefix + String(chunk).replaceAll('\n', `\n${prefix}`)))
  child.stderr.on('data', chunk => process.stderr.write(prefix + String(chunk).replaceAll('\n', `\n${prefix}`)))
  return child
})

function stop(signal = 'SIGTERM') {
  for (const child of children) {
    if (!child.killed) child.kill(signal)
  }
}

process.on('SIGINT', () => {
  stop('SIGINT')
  process.exit(130)
})
process.on('SIGTERM', () => {
  stop('SIGTERM')
  process.exit(143)
})

await Promise.all(children.map(child => new Promise((resolvePromise, reject) => {
  child.once('error', reject)
  child.once('exit', code => {
    if (code && code !== 130 && code !== 143) reject(new Error(`TypeScript watcher exited with code ${code}`))
    else resolvePromise()
  })
})))
