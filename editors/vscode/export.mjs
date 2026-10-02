#!/usr/bin/env node

import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)))
const repositoryRoot = resolve(extensionRoot, '../..')
const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'))
const extensionManifest = JSON.parse(readFileSync(resolve(extensionRoot, 'package.json'), 'utf8'))
const version = process.env.MUN_EXTENSION_VERSION ?? manifest.version
const output = resolve(process.argv[2] ?? resolve(repositoryRoot, 'dist', `mun-language-support-${version}.vsix`))
const stage = mkdtempSync(resolve(tmpdir(), 'mun-vsix-'))
const extensionStage = resolve(stage, 'extension')

try {
  mkdirSync(extensionStage, { recursive: true })
  for (const file of ['extension.cjs', 'client.mjs', 'discovery.mjs', 'language-configuration.json', 'package.json', 'syntaxes']) {
    cpSync(resolve(extensionRoot, file), resolve(extensionStage, file), { recursive: true })
  }
  cpSync(resolve(extensionRoot, 'protocol.mjs'), resolve(extensionStage, 'protocol.mjs'))
  const packagedManifest = { ...extensionManifest, version, private: undefined }
  delete packagedManifest.private
  writeFileSync(resolve(extensionStage, 'package.json'), `${JSON.stringify(packagedManifest, null, 2)}\n`)
  writeFileSync(resolve(stage, '[Content_Types].xml'), `<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="xml" ContentType="text/xml"/><Default Extension="tmLanguage" ContentType="application/json"/></Types>\n`)
  writeFileSync(resolve(stage, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>\n<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="${packagedManifest.name}" Version="${version}" Publisher="${packagedManifest.publisher}"/><DisplayName>${packagedManifest.displayName}</DisplayName><Description xml:space="preserve">${packagedManifest.description}</Description><Tags>mun,lsp,typescript</Tags><Categories>${packagedManifest.categories.join(',')}</Categories></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" Version="^1.85.0"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json"/><Asset Type="Microsoft.VisualStudio.Code.Extension" Path="extension/"/></Assets></PackageManifest>\n`)
  mkdirSync(dirname(output), { recursive: true })
  // Windows ships bsdtar, which writes zip archives; other platforms use zip.
  const zip = process.platform === 'win32'
    ? spawnSync('tar', ['-a', '-c', '--format', 'zip', '-f', output, '.'], { cwd: stage, encoding: 'utf8' })
    : spawnSync('zip', ['-q', '-r', output, '.'], { cwd: stage, encoding: 'utf8' })
  if (zip.error) throw new Error(`Could not create VSIX: ${zip.error.message}`)
  if (zip.status !== 0) throw new Error(`archiver failed with exit code ${zip.status}: ${zip.stderr ?? ''}`)
  console.log(output)
} finally {
  rmSync(stage, { recursive: true, force: true })
}

