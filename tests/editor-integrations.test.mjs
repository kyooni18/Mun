import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(new URL('..', import.meta.url).pathname)
const cli = resolve(root, 'bin/mun.mjs')

test('editor install generates project-local integrations for every supported client', () => {
  const project = mkdtempSync(resolve(tmpdir(), 'mun-editors-'))
  const result = spawnSync(process.execPath, [cli, 'editor', 'install', '--editor', 'all', '--project', project], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(resolve(project, '.mun/editors/nvim.lua'), 'utf8'), /mun.*lsp.*--stdio/u)
  assert.match(readFileSync(resolve(project, '.mun/editors/nvim.lua'), 'utf8'), /\["mun"\]/u)
  assert.match(readFileSync(resolve(project, '.mun/editors/vim.vim'), 'utf8'), /lsp#register_server/u)
  assert.match(readFileSync(resolve(project, '.mun/editors/vim.vim'), 'utf8'), /\*\.mun/u)
  assert.match(readFileSync(resolve(project, '.mun/editors/helix.toml'), 'utf8'), /language-server\.mun/u)
  assert.match(readFileSync(resolve(project, '.mun/editors/helix.toml'), 'utf8'), /file-types = \["mun", "mun\.ts"\]/u)
  assert.deepEqual(JSON.parse(readFileSync(resolve(project, '.mun/editors/zed.json'), 'utf8')).languages.Mun.file_types, ['mun', 'mun.ts'])
  const associations = JSON.parse(readFileSync(resolve(project, '.vscode/settings.json'), 'utf8'))['files.associations']
  assert.equal(associations['*.mun'], 'mun')
  assert.equal(associations['*.mun.ts'], 'mun')
  assert.ok(JSON.parse(readFileSync(resolve(project, '.vscode/extensions.json'), 'utf8')).recommendations.includes('mun.mun-language-support'))
  rmSync(project, { recursive: true, force: true })
})

test('VS Code exporter creates an installable VSIX with the extension manifest', () => {
  const output = resolve(tmpdir(), `mun-extension-${process.pid}.vsix`)
  const result = spawnSync(process.execPath, [resolve(root, 'editors/vscode/export.mjs'), output], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(output), true)
  const listing = spawnSync('unzip', ['-l', output], { encoding: 'utf8' })
  assert.equal(listing.status, 0, listing.stderr)
  assert.match(listing.stdout, /extension\.cjs/u)
  assert.match(listing.stdout, /extension\.vsixmanifest/u)
  rmSync(output, { force: true })
})
