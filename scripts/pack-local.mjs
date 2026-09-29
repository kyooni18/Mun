#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverReleaseTargets } from './release-targets.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'local-packages')
const targets = discoverReleaseTargets(root)

mkdirSync(out, { recursive: true })
for (const name of readdirSync(out)) {
  if (name.endsWith('.tgz')) rmSync(resolve(out, name), { force: true })
}

function pnpm(args, cwd) {
  const cli = process.env.MUN_PNPM_CLI || process.env.npm_execpath
  const cliIsJavaScript = Boolean(cli && /\.(?:cjs|mjs|js)$/u.test(cli))
  const command = cli ? (cliIsJavaScript ? process.execPath : cli) : 'pnpm'
  const commandArgs = cliIsJavaScript ? [cli, ...args] : args
  return spawnSync(command, commandArgs, { cwd, stdio: 'inherit', env: process.env })
}

for (const target of targets) {
  const manifest = JSON.parse(readFileSync(target.manifestPath, 'utf8'))
  console.log(`Packing ${manifest.name}@${manifest.version}`)
  const result = pnpm(['pack', '--pack-destination', out], target.dir)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
writeFileSync(resolve(out, 'manifest.json'), `${JSON.stringify({ version: manifest.version, generatedAt: new Date().toISOString() }, null, 2)}\n`)
console.log(`Local tarballs written to ${out}`)
console.log(`Install them into another project with:\n  node ${resolve(root, 'scripts/install-local-packages.mjs')} /path/to/project`)
