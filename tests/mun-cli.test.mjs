import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(new URL('..', import.meta.url).pathname)
const cli = resolve(root, 'bin/vune-ui.mjs')
const initializer = resolve(root, 'packages/create-vune-ui/bin/create-vune-ui.mjs')
const currentVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version

function run(args, cwd, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function runInitializer(args, cwd) {
  return spawnSync(process.execPath, [initializer, ...args], { cwd, encoding: 'utf8' })
}

test('canonical vune-ui create scaffolds a Web project without React or Vue', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'vune-ui-cli-'))
  const result = run(['create', 'hello-vune', '--no-install'], workspace)
  const project = resolve(workspace, 'hello-vune')

  assert.equal(result.status, 0, result.stderr)
  for (const file of [
    '.gitignore',
    'package.json',
    'index.html',
    'tsconfig.json',
    'vite.config.ts',
    'src/App.vune.ts',
    'src/App.css',
    'src/index.css',
    'src/main.ts',
  ]) assert.equal(existsSync(resolve(project, file)), true, file)

  const manifest = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'hello-vune')
  assert.equal(manifest.dependencies['@vune-ui/core'], `^${currentVersion}`)
  assert.equal(manifest.dependencies['@vune-ui/web'], `^${currentVersion}`)
  assert.equal(manifest.dependencies['vune-ui'], undefined)
  assert.equal(manifest.dependencies.react, undefined)
  assert.equal(manifest.dependencies['react-dom'], undefined)
  assert.equal(manifest.dependencies.vue, undefined)
  assert.equal(manifest.devDependencies['@vune-ui/vite'], `^${currentVersion}`)
  assert.equal(manifest.devDependencies['@vitejs/plugin-react'], undefined)
  assert.equal(manifest.devDependencies['@types/react'], undefined)
  assert.equal(manifest.devDependencies['@types/react-dom'], undefined)
  assert.match(readFileSync(resolve(project, 'src/App.vune.ts'), 'utf8'), /struct HelloVuneApp: View/u)
  assert.match(readFileSync(resolve(project, 'src/main.ts'), 'utf8'), /mount\(App/u)
  assert.match(readFileSync(resolve(project, 'vite.config.ts'), 'utf8'), /vunePlugin\(\)/u)
  assert.doesNotMatch(readFileSync(resolve(project, 'vite.config.ts'), 'utf8'), /react|vue/u)
  assert.doesNotMatch(readFileSync(resolve(project, 'src/App.vune.ts'), 'utf8'), /react|vue/u)
  assert.doesNotMatch(readFileSync(resolve(project, 'tsconfig.json'), 'utf8'), /react|vue/u)
})

test('create prints complete next steps when installation is skipped', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'vune-ui-cli-steps-'))
  const result = run(['create', 'hello-vune', '--no-install'], workspace, { npm_config_user_agent: '' })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Next steps:\n  cd hello-vune\n  npm install\n  npm run dev/u)
})

test('init prints current-directory next steps without a redundant cd command', () => {
  const project = mkdtempSync(resolve(tmpdir(), 'vune-ui-init-'))
  const result = run(['init', '--no-install', '--pm', 'pnpm'], project)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Next steps:\n  pnpm install\n  pnpm dev/u)
  assert.doesNotMatch(result.stdout, /Next steps:\n  cd /u)
})

test('canonical vune-ui create protects a non-empty target unless forced', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'vune-ui-cli-'))
  const project = resolve(workspace, 'existing')
  const manifest = resolve(project, 'package.json')
  mkdirSync(project, { recursive: true })
  writeFileSync(manifest, '{}')

  const result = run(['create', 'existing', '--no-install'], workspace)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /non-empty directory/u)
  assert.equal(readFileSync(manifest, 'utf8'), '{}')
})

test('create-vune-ui accepts the npm/pnpm create directory shape', () => {
  const project = mkdtempSync(resolve(tmpdir(), 'create-vune-ui-'))
  const result = runInitializer(['.', '--no-install'], project)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Created Vune app/u)
  assert.equal(existsSync(resolve(project, 'src/App.vune.ts')), true)
  assert.equal(JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8')).name, project.split('/').pop().toLowerCase())
})

test('create-vune-ui tolerates npm create argument separators', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'create-vune-ui-separator-'))
  const result = runInitializer(['hello-vune', '--', '--no-install'], workspace)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(resolve(workspace, 'hello-vune', 'package.json')), true)
})

test('local create mode wires a separate app to the source checkout without npm publication', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'vune-ui-local-create-'))
  const result = run(['create', 'linked-app', '--local', '--no-install'], workspace)
  const project = resolve(workspace, 'linked-app')

  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['vune-ui'], undefined)
  assert.match(manifest.dependencies['@vune-ui/web'], /^link:/u)
  assert.equal(manifest.dependencies['@vune-ui/react'], undefined)
  assert.equal(manifest.dependencies['@vune-ui/vue'], undefined)
  assert.equal(manifest.dependencies.react, undefined)
  assert.equal(manifest.dependencies.vue, undefined)
  assert.match(manifest.devDependencies['@vune-ui/vite'], /^link:/u)
  assert.match(manifest.devDependencies['@vune-ui/core'], /^link:/u)
  assert.match(manifest.devDependencies['@vune-ui/compiler'], /^link:/u)
  assert.match(manifest.devDependencies['@vune-ui/execution'], /^link:/u)
  assert.equal(manifest.devDependencies['@vune-ui/legacy-react'], undefined)
  assert.equal(manifest.pnpm?.overrides, undefined)
  const workspaceConfig = readFileSync(resolve(project, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(workspaceConfig, /"@vune-ui\/core": "link:/u)
  assert.match(workspaceConfig, /"@vune-ui\/compiler": "link:/u)
  assert.match(workspaceConfig, /"@vune-ui\/web": "link:/u)
  assert.doesNotMatch(workspaceConfig, /@vune-ui\/(?:react|vue|legacy-react)/u)
  assert.doesNotMatch(JSON.stringify(manifest), /Desktop\/Muse|@muse\/|react-muse-ui/u)
})

test('local create mode uses pnpm even when invoked directly outside pnpm', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'vune-ui-local-pm-'))
  const bin = resolve(workspace, 'bin')
  const fakePnpm = resolve(bin, 'pnpm')
  mkdirSync(bin)
  writeFileSync(fakePnpm, '#!/bin/sh\nexit 0\n')
  chmodSync(fakePnpm, 0o755)

  const result = run(['create', 'linked-app', '--local'], workspace, {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    npm_config_user_agent: 'npm/11.0.0',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Installing dependencies with pnpm/u)
  assert.match(result.stdout, /Next steps:\n  cd linked-app\n  pnpm dev/u)
})

test('local create validates the source checkout before writing project files', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'vune-ui-local-preflight-'))
  const missingRoot = resolve(workspace, 'missing-vune')
  const project = resolve(workspace, 'app')
  const result = run(['create', 'app', '--local', '--local-root', missingRoot, '--no-install'], workspace)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Local Vune checkout has no package\.json/u)
  assert.equal(existsSync(project), false)
})

test('create validates the package manager before writing project files', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'vune-ui-pm-preflight-'))
  const project = resolve(workspace, 'app')
  const result = run(['create', 'app', '--pm', 'deno', '--no-install'], workspace)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Unsupported package manager: deno/u)
  assert.equal(existsSync(project), false)
})

test('create keeps a usable scaffold and prints recovery steps when install fails', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'vune-ui-install-recovery-'))
  const bin = resolve(workspace, 'bin')
  const fakeNpm = resolve(bin, 'npm')
  mkdirSync(bin)
  writeFileSync(fakeNpm, '#!/bin/sh\nexit 7\n')
  chmodSync(fakeNpm, 0o755)

  const result = run(['create', 'recoverable-app', '--pm', 'npm'], workspace, {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  })

  assert.equal(result.status, 1)
  assert.equal(existsSync(resolve(workspace, 'recoverable-app', 'package.json')), true)
  assert.match(result.stderr, /project files are ready, but dependency installation did not finish/iu)
  assert.match(result.stderr, /Retry with:\n  cd recoverable-app\n  npm install/u)
  assert.match(result.stderr, /npm install failed with exit code 7/u)
})

test('vune-ui link upgrades an existing project to robust local source links', () => {
  const project = mkdtempSync(resolve(tmpdir(), 'vune-ui-link-'))
  writeFileSync(resolve(project, 'package.json'), JSON.stringify({
    name: 'consumer',
    private: true,
    dependencies: { react: '^19.0.0' },
  }, null, 2))

  const result = run(['link', project, '--no-install'], root)
  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies.react, '^19.0.0')
  assert.match(manifest.dependencies['vune-ui'], /^link:/u)
  assert.match(manifest.dependencies['@vune-ui/react'], /^link:/u)
  assert.match(manifest.devDependencies['@vune-ui/vite'], /^link:/u)
  assert.match(manifest.devDependencies['@vune-ui/core'], /^link:/u)
  assert.match(manifest.devDependencies['@vune-ui/compiler'], /^link:/u)
  assert.match(manifest.devDependencies['@vune-ui/execution'], /^link:/u)
  assert.equal(manifest.devDependencies['@vune-ui/legacy-react'], undefined)
  assert.equal(manifest.pnpm?.overrides, undefined)
  const workspaceConfig = readFileSync(resolve(project, 'pnpm-workspace.yaml'), 'utf8')
  for (const name of [
    'vune-ui',
    '@vune-ui/animation',
    '@vune-ui/core',
    '@vune-ui/compiler',
    '@vune-ui/execution',
    '@vune-ui/legacy-react',
    '@vune-ui/react',
    '@vune-ui/vue',
    '@vune-ui/web',
    '@vune-ui/vite',
  ]) assert.match(workspaceConfig, new RegExp(`${name.replace('/', '\\/').replace('@', '\\@')}\\": \"link:`), name)
})

test('vune-ui link auto-detects React, Vue, or Web targets', () => {
  const cases = [
    ['react', { react: '^19.0.0' }],
    ['vue', { vue: '^3.5.0' }],
    ['web', {}],
  ]

  for (const [renderer, dependencies] of cases) {
    const project = mkdtempSync(resolve(tmpdir(), `vune-ui-link-detect-${renderer}-`))
    writeFileSync(resolve(project, 'package.json'), JSON.stringify({ name: `consumer-${renderer}`, private: true, dependencies }, null, 2))
    const result = run(['link', project, '--no-install'], root)

    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8'))
    assert.match(manifest.dependencies[`@vune-ui/${renderer}`], /^link:/u)
    assert.match(result.stdout, new RegExp(`Linked Vune .* \\(${renderer}\\)`, 'u'))
  }
})

test('vune-ui link asks for an explicit renderer when React and Vue coexist', () => {
  const project = mkdtempSync(resolve(tmpdir(), 'vune-ui-link-ambiguous-'))
  writeFileSync(resolve(project, 'package.json'), JSON.stringify({
    name: 'consumer-ambiguous',
    private: true,
    dependencies: { react: '^19.0.0', vue: '^3.5.0' },
  }, null, 2))

  const result = run(['link', project, '--no-install'], root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Both React and Vue are present/u)
  assert.equal(JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8')).dependencies['vune-ui'], undefined)
})

test('vune-ui link can select Vue or Web without forcing React renderer dependencies', () => {
  for (const renderer of ['vue', 'web']) {
    const project = mkdtempSync(resolve(tmpdir(), `vune-ui-link-${renderer}-`))
    writeFileSync(resolve(project, 'package.json'), JSON.stringify({ name: `consumer-${renderer}`, private: true }, null, 2))
    const result = run(['link', project, '--renderer', renderer, '--no-install'], root)
    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8'))
    assert.match(manifest.dependencies[`@vune-ui/${renderer}`], /^link:/u)
    assert.equal(manifest.dependencies['@vune-ui/react'], undefined)
  }
})


test('vune-ui link merges pnpm 11 workspace overrides without destroying existing settings', () => {
  const project = mkdtempSync(resolve(tmpdir(), 'vune-ui-link-workspace-'))
  writeFileSync(resolve(project, 'package.json'), JSON.stringify({ name: 'workspace-consumer', private: true }, null, 2))
  writeFileSync(resolve(project, 'pnpm-workspace.yaml'), `packages:
  - packages/*

overrides:
  "left-pad": "1.3.0"

onlyBuiltDependencies:
  - esbuild
`)

  const result = run(['link', project, '--no-install'], root)
  assert.equal(result.status, 0, result.stderr)
  const workspaceConfig = readFileSync(resolve(project, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(workspaceConfig, /packages:\n  - packages\/\*/u)
  assert.match(workspaceConfig, /"left-pad": "1\.3\.0"/u)
  assert.match(workspaceConfig, /"@vune-ui\/compiler": "link:/u)
  assert.match(workspaceConfig, /onlyBuiltDependencies:\n  - esbuild/u)
})

test('local source mode refuses package managers that do not support the pnpm workspace override contract', () => {
  const project = mkdtempSync(resolve(tmpdir(), 'vune-ui-link-non-pnpm-'))
  writeFileSync(resolve(project, 'package.json'), JSON.stringify({ name: 'consumer-npm', private: true }, null, 2))
  const before = readFileSync(resolve(project, 'package.json'), 'utf8')
  const result = run(['link', project, '--pm', 'npm', '--no-install'], root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /requires pnpm/u)
  assert.equal(readFileSync(resolve(project, 'package.json'), 'utf8'), before)
  assert.equal(existsSync(resolve(project, 'pnpm-workspace.yaml')), false)
})
