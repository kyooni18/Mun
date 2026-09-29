import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifests = [
  'package.json',
  'packages/animation/package.json',
  'packages/astro/package.json',
  'packages/compiler/package.json',
  'packages/core/package.json',
  'packages/execution/package.json',
  'packages/create-mun/package.json',
  'packages/legacy-react/package.json',
  'packages/react/package.json',
  'packages/vite/package.json',
  'packages/vue/package.json',
  'packages/web/package.json',
]

function readJSON(relative) {
  return JSON.parse(readFileSync(resolve(root, relative), 'utf8'))
}

test('workspace-internal dependencies never require a published Mun package during development', () => {
  for (const relative of manifests) {
    const manifest = readJSON(relative)
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
        if (name === '@mun/ui' || name.startsWith('@mun/')) {
          assert.equal(specifier, 'workspace:*', `${relative} ${field}.${name}`)
        }
      }
    }
  }
})

test('canonical root installs the published Mun packages together', () => {
  const manifest = readJSON('package.json')
  for (const name of [
    '@mun/animation',
    '@mun/astro',
    '@mun/compiler',
    '@mun/core',
    '@mun/execution',
    '@mun/react',
    '@mun/vite',
    '@mun/vue',
    '@mun/web',
  ]) assert.equal(manifest.dependencies[name], 'workspace:*')
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.peerDependenciesMeta, undefined)
})

test('local package output never checks stale archives into source', () => {
  const localDir = resolve(root, 'local-packages')
  assert.equal(existsSync(resolve(localDir, 'README.md')), true)
  const localArchives = readdirSync(localDir).filter(name => name.endsWith('.tgz'))
  const trackedArchives = execFileSync('git', ['ls-files', '--', 'local-packages/*.tgz'], {
    cwd: root,
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean)
  assert.deepEqual(trackedArchives, [], `local archives must stay untracked: ${localArchives.join(', ')}`)
  const ignore = readFileSync(resolve(root, '.gitignore'), 'utf8')
  assert.match(ignore, /^\.pi\/$/mu)
  assert.match(ignore, /^local-packages\/\*\.tgz$/mu)
})
