#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import process from 'node:process'
import { compileMunUiProgram } from '@mun/compiler'

function displayPath(path) {
  const local = relative(process.cwd(), path)
  return local && !local.startsWith('..') ? local : path
}

const [inputArg, outputArg, ...extra] = process.argv.slice(2)
if (!inputArg || extra.length > 0) {
  console.error('Usage: mun compile <input.mun> [output.json]')
  process.exit(2)
}

const input = resolve(process.cwd(), inputArg)
if (!input.endsWith('.mun')) {
  console.error(`Mün compile expects canonical .mun source: ${displayPath(input)}`)
  process.exit(2)
}

const output = outputArg
  ? resolve(process.cwd(), outputArg)
  : resolve(dirname(input), `${basename(input, '.mun')}.mun.ir.json`)

try {
  const source = readFileSync(input, 'utf8')
  const program = compileMunUiProgram(source, input)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(program, null, 2)}\n`)
  console.log(`Compiled ${displayPath(input)} -> ${displayPath(output)}`)
} catch (error) {
  console.error(`Mün compile failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
