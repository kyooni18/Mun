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
  assert.match(readFileSync(resolve(project, '.mun/editors/helix.toml'), 'utf8'), /file-types = \["mun"\]/u)
  assert.deepEqual(JSON.parse(readFileSync(resolve(project, '.mun/editors/zed.json'), 'utf8')).languages.Mun.file_types, ['mun'])
  const associations = JSON.parse(readFileSync(resolve(project, '.vscode/settings.json'), 'utf8'))['files.associations']
  assert.equal(associations['*.mun'], 'mun')
  assert.equal(associations['*.mun.ts'], undefined)
  assert.ok(JSON.parse(readFileSync(resolve(project, '.vscode/extensions.json'), 'utf8')).recommendations.includes('mun.mun-language-support'))
  rmSync(project, { recursive: true, force: true })
})

test('VS Code exporter creates an installable VSIX with loadable isolated client files', async () => {
  const output = resolve(tmpdir(), `mun-extension-${process.pid}.vsix`)
  const result = spawnSync(process.execPath, [resolve(root, 'editors/vscode/export.mjs'), output], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(output), true)
  const listing = spawnSync('unzip', ['-l', output], { encoding: 'utf8' })
  assert.equal(listing.status, 0, listing.stderr)
  assert.match(listing.stdout, /extension\.cjs/u)
  assert.match(listing.stdout, /extension\.vsixmanifest/u)
  const isolated = mkdtempSync(resolve(tmpdir(), 'mun-vsix-load-'))
  try {
    const extraction = spawnSync('unzip', ['-q', output, '-d', isolated], { encoding: 'utf8' })
    assert.equal(extraction.status, 0, extraction.stderr)
    const { pathToFileURL } = await import('node:url')
    const { LspClient } = await import(pathToFileURL(resolve(isolated, 'extension/client.mjs')).href)
    const { discoverToolchain } = await import(pathToFileURL(resolve(isolated, 'extension/discovery.mjs')).href)
    assert.equal(typeof LspClient, 'function')
    assert.equal(typeof discoverToolchain, 'function')
    const manifest = JSON.parse(readFileSync(resolve(isolated, 'extension/package.json')))
    assert.equal(manifest.private, undefined)
    assert.equal(manifest.version, JSON.parse(readFileSync(resolve(root, 'package.json'))).version)
  } finally { rmSync(isolated, { recursive: true, force: true }) }
  rmSync(output, { force: true })
})
