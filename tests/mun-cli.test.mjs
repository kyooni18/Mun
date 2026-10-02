import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = resolve(root, 'bin/mun.mjs')
const initializer = resolve(root, 'packages/create-mun/bin/create-mun.mjs')
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

test('mun compile lowers canonical .mun source to shared semantic UI IR', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'mun-compile-'))
  writeFileSync(resolve(workspace, 'App.mun'), `import { Text, VStack } from "@mun/core"

struct App: View {
  var body: some View {
    VStack(spacing: 8) {
      Text("Hello native Mün")
    }
  }
}

export default App()
`)

  const result = run(['compile', 'App.mun', 'build/App.json'], workspace)
  assert.equal(result.status, 0, result.stderr)

  const program = JSON.parse(readFileSync(resolve(workspace, 'build/App.json'), 'utf8'))
  assert.equal(program.version, 1)
  assert.equal(program.sourceLanguage, 'mun')
  assert.equal(program.entry, 'App')
  assert.equal(program.root.kind, 'window')
  assert.equal(program.root.child.kind, 'column')
  assert.equal(program.root.child.children[0].kind, 'text')
  assert.deepEqual(program.root.child.children[0].value, { kind: 'literal', value: 'Hello native Mün' })
})

test('mun compile defaults to a .mun.ir.json artifact and rejects non-canonical source extensions', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'mun-compile-default-'))
  const source = `import { Text } from "@mun/core"
struct App: View {
  var body: some View {
    Text("Hello")
  }
}
export default App()
`
  writeFileSync(resolve(workspace, 'App.mun'), source)
  writeFileSync(resolve(workspace, 'App.mun.ts'), source)

  const result = run(['compile', 'App.mun'], workspace)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(resolve(workspace, 'App.mun.ir.json')), true)

  const rejected = run(['compile', 'App.mun.ts'], workspace)
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /expects canonical \.mun source/u)
})

test('mun run compiles canonical .mun source and launches the native host with semantic UI IR', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'mun-run-'))
  const input = resolve(workspace, 'App.mun')
  const host = resolve(workspace, 'fake-mun-native')
  const capture = resolve(workspace, 'captured-ir.json')

  writeFileSync(input, `import { Text, VStack } from "@mun/core"

struct App: View {
  var body: some View {
    VStack(spacing: 6) {
      Text("Native CLI")
    }
  }
}

export default App()
`)
  writeFileSync(host, '#!/bin/sh\ncp "$1" "$MUN_NATIVE_CAPTURE"\n')
  chmodSync(host, 0o755)

  const result = run(['run', 'App.mun'], workspace, {
    MUN_NATIVE_HOST: host,
    MUN_NATIVE_CAPTURE: capture,
  })
  assert.equal(result.status, 0, result.stderr)

  const program = JSON.parse(readFileSync(capture, 'utf8'))
  assert.equal(program.sourceLanguage, 'mun')
  assert.equal(program.entry, 'App')
  assert.equal(program.root.child.kind, 'column')
  assert.deepEqual(program.root.child.children[0].value, { kind: 'literal', value: 'Native CLI' })

  writeFileSync(resolve(workspace, 'Legacy.mun.ts'), readFileSync(input, 'utf8'))
  const rejected = run(['run', 'Legacy.mun.ts'], workspace, { MUN_NATIVE_HOST: host })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /run expects canonical \.mun source/u)
})

test('the published package carries the locked native Rust fallback used by mun run', () => {
  const publishFiles = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).files
  for (const path of [
    'native/Cargo.toml',
    'native/Cargo.lock',
    'native/mun-runtime',
    'native/mun-native',
  ]) assert.equal(publishFiles.includes(path), true, path)
})

test('canonical @mun/ui create scaffolds a Web project without React or Vue', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'mun-cli-'))
  const result = run(['create', 'hello-mun', '--target', 'web', '--no-install'], workspace)
  const project = resolve(workspace, 'hello-mun')

  assert.equal(result.status, 0, result.stderr)
  for (const file of [
    '.gitignore',
    'package.json',
    'index.html',
    'tsconfig.json',
    'vite.config.ts',
    'src/App.mun',
    'src/index.css',
    'src/main.ts',
  ]) assert.equal(existsSync(resolve(project, file)), true, file)

  const manifest = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'hello-mun')
  assert.equal(manifest.dependencies['@mun/core'], `^${currentVersion}`)
  assert.equal(manifest.dependencies['@mun/web'], `^${currentVersion}`)
  assert.equal(manifest.dependencies['@mun/ui'], undefined)
  assert.equal(manifest.dependencies.react, undefined)
  assert.equal(manifest.dependencies['react-dom'], undefined)
  assert.equal(manifest.dependencies.vue, undefined)
  assert.equal(manifest.devDependencies['@mun/vite'], `^${currentVersion}`)
  assert.equal(manifest.devDependencies['@vitejs/plugin-react'], undefined)
  assert.equal(manifest.devDependencies['@types/react'], undefined)
  assert.equal(manifest.devDependencies['@types/react-dom'], undefined)
  assert.match(readFileSync(resolve(project, 'src/App.mun'), 'utf8'), /struct HelloMunApp: View/u)
  assert.match(readFileSync(resolve(project, 'src/main.ts'), 'utf8'), /mount\(App/u)
  assert.match(readFileSync(resolve(project, 'vite.config.ts'), 'utf8'), /munPlugin\(\)/u)
  assert.doesNotMatch(readFileSync(resolve(project, 'vite.config.ts'), 'utf8'), /react|vue/u)
  assert.doesNotMatch(readFileSync(resolve(project, 'src/App.mun'), 'utf8'), /react|vue/u)
  assert.doesNotMatch(readFileSync(resolve(project, 'tsconfig.json'), 'utf8'), /react|vue/u)
})

test('create prints complete next steps when installation is skipped', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'mun-cli-steps-'))
  const result = run(['create', 'hello-mun', '--target', 'web', '--no-install'], workspace, { npm_config_user_agent: '' })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Next steps:\n  cd hello-mun\n  npm install\n  npm run dev/u)
})

test('init prints current-directory next steps without a redundant cd command', () => {
  const project = mkdtempSync(resolve(tmpdir(), 'mun-init-'))
  const result = run(['init', '--target', 'web', '--no-install', '--pm', 'pnpm'], project)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Next steps:\n  pnpm install\n  pnpm dev/u)
  assert.doesNotMatch(result.stdout, /Next steps:\n  cd /u)
})

test('canonical @mun/ui create protects a non-empty target unless forced', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'mun-cli-'))
  const project = resolve(workspace, 'existing')
  const manifest = resolve(project, 'package.json')
  mkdirSync(project, { recursive: true })
  writeFileSync(manifest, '{}')

  const result = run(['create', 'existing', '--no-install'], workspace)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /non-empty directory/u)
  assert.equal(readFileSync(manifest, 'utf8'), '{}')
})

test('create-mun accepts the npm/pnpm create directory shape', () => {
  const project = mkdtempSync(resolve(tmpdir(), 'create-mun-'))
  const result = runInitializer(['.', '--no-install'], project)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Created native Mün app/u)
  assert.equal(existsSync(resolve(project, 'Sources/App.mun')), true)
  assert.equal(existsSync(resolve(project, 'mun.toml')), true)
})

test('create-mun tolerates npm create argument separators', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'create-mun-separator-'))
  const result = runInitializer(['hello-mun', '--', '--no-install'], workspace)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(resolve(workspace, 'hello-mun', 'mun.toml')), true)
})

test('local create mode wires a separate app to the source checkout without npm publication', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'mun-local-create-'))
  const result = run(['create', 'linked-app', '--target', 'web', '--local', '--no-install'], workspace)
  const project = resolve(workspace, 'linked-app')

  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['@mun/ui'], undefined)
  assert.match(manifest.dependencies['@mun/web'], /^link:/u)
  assert.equal(manifest.dependencies['@mun/react'], undefined)
  assert.equal(manifest.dependencies['@mun/vue'], undefined)
  assert.equal(manifest.dependencies.react, undefined)
  assert.equal(manifest.dependencies.vue, undefined)
  assert.match(manifest.devDependencies['@mun/vite'], /^link:/u)
  assert.match(manifest.devDependencies['@mun/core'], /^link:/u)
  assert.match(manifest.devDependencies['@mun/compiler'], /^link:/u)
  assert.match(manifest.devDependencies['@mun/execution'], /^link:/u)
  assert.equal(manifest.devDependencies['@mun/legacy-react'], undefined)
  assert.equal(manifest.pnpm?.overrides, undefined)
  const workspaceConfig = readFileSync(resolve(project, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(workspaceConfig, /"@mun\/core": "link:/u)
  assert.match(workspaceConfig, /"@mun\/compiler": "link:/u)
  assert.match(workspaceConfig, /"@mun\/web": "link:/u)
  assert.doesNotMatch(workspaceConfig, /@mun\/(?:react|vue|legacy-react)/u)
  assert.doesNotMatch(JSON.stringify(manifest), /Desktop\/Muse|@muse\/|react-muse-ui/u)
})

test('local create mode uses pnpm even when invoked directly outside pnpm', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'mun-local-pm-'))
  const bin = resolve(workspace, 'bin')
  const fakePnpm = resolve(bin, 'pnpm')
  mkdirSync(bin)
  writeFileSync(fakePnpm, '#!/bin/sh\nexit 0\n')
  chmodSync(fakePnpm, 0o755)

  const result = run(['create', 'linked-app', '--target', 'web', '--local'], workspace, {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    npm_config_user_agent: 'npm/11.0.0',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Installing dependencies with pnpm/u)
  assert.match(result.stdout, /Next steps:\n  cd linked-app\n  pnpm dev/u)
})

test('local create validates the source checkout before writing project files', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'mun-local-preflight-'))
  const missingRoot = resolve(workspace, 'missing-mun')
  const project = resolve(workspace, 'app')
  const result = run(['create', 'app', '--local', '--local-root', missingRoot, '--no-install'], workspace)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Local Mün checkout has no package\.json/u)
  assert.equal(existsSync(project), false)
})

test('create validates the package manager before writing project files', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'mun-pm-preflight-'))
  const project = resolve(workspace, 'app')
  const result = run(['create', 'app', '--pm', 'deno', '--no-install'], workspace)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Unsupported package manager: deno/u)
  assert.equal(existsSync(project), false)
})

test('create keeps a usable scaffold and prints recovery steps when install fails', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'mun-install-recovery-'))
  const bin = resolve(workspace, 'bin')
  const fakeNpm = resolve(bin, 'npm')
  mkdirSync(bin)
  writeFileSync(fakeNpm, '#!/bin/sh\nexit 7\n')
  chmodSync(fakeNpm, 0o755)

  const result = run(['create', 'recoverable-app', '--target', 'web', '--pm', 'npm'], workspace, {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  })

  assert.equal(result.status, 1)
  assert.equal(existsSync(resolve(workspace, 'recoverable-app', 'package.json')), true)
  assert.match(result.stderr, /project files are ready, but dependency installation did not finish/iu)
  assert.match(result.stderr, /Retry with:\n  cd recoverable-app\n  npm install/u)
  assert.match(result.stderr, /npm install failed with exit code 7/u)
})

test('mun link upgrades an existing project to robust local source links', () => {
  const project = mkdtempSync(resolve(tmpdir(), 'mun-link-'))
  writeFileSync(resolve(project, 'package.json'), JSON.stringify({
    name: 'consumer',
    private: true,
    dependencies: { react: '^19.0.0' },
  }, null, 2))

  const result = run(['link', project, '--no-install'], root)
  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies.react, '^19.0.0')
  assert.match(manifest.dependencies['@mun/ui'], /^link:/u)
  assert.match(manifest.dependencies['@mun/react'], /^link:/u)
  assert.match(manifest.devDependencies['@mun/vite'], /^link:/u)
  assert.match(manifest.devDependencies['@mun/core'], /^link:/u)
  assert.match(manifest.devDependencies['@mun/compiler'], /^link:/u)
  assert.match(manifest.devDependencies['@mun/execution'], /^link:/u)
  assert.equal(manifest.devDependencies['@mun/legacy-react'], undefined)
  assert.equal(manifest.pnpm?.overrides, undefined)
  const workspaceConfig = readFileSync(resolve(project, 'pnpm-workspace.yaml'), 'utf8')
  for (const name of [
    '@mun/ui',
    '@mun/animation',
    '@mun/astro',
    '@mun/core',
    '@mun/compiler',
    '@mun/execution',
    '@mun/legacy-react',
    '@mun/react',
    '@mun/vue',
    '@mun/web',
    '@mun/vite',
  ]) assert.match(workspaceConfig, new RegExp(`${name.replace('/', '\\/').replace('@', '\\@')}\\": \"link:`), name)
})

test('mun link auto-detects Astro, React, Vue, or Web targets', () => {
  const cases = [
    ['astro', { astro: '^7.0.0' }],
    ['react', { react: '^19.0.0' }],
    ['vue', { vue: '^3.5.0' }],
    ['web', {}],
  ]

  for (const [renderer, dependencies] of cases) {
    const project = mkdtempSync(resolve(tmpdir(), `mun-link-detect-${renderer}-`))
    writeFileSync(resolve(project, 'package.json'), JSON.stringify({ name: `consumer-${renderer}`, private: true, dependencies }, null, 2))
    const result = run(['link', project, '--no-install'], root)

    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8'))
    assert.match(manifest.dependencies[`@mun/${renderer}`], /^link:/u)
    assert.match(result.stdout, new RegExp(`Linked Mün .* \\(${renderer}\\)`, 'u'))
  }
})

test('mun link asks for an explicit renderer when React and Vue coexist', () => {
  const project = mkdtempSync(resolve(tmpdir(), 'mun-link-ambiguous-'))
  writeFileSync(resolve(project, 'package.json'), JSON.stringify({
    name: 'consumer-ambiguous',
    private: true,
    dependencies: { react: '^19.0.0', vue: '^3.5.0' },
  }, null, 2))

  const result = run(['link', project, '--no-install'], root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Both React and Vue are present/u)
  assert.equal(JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8')).dependencies['mun'], undefined)
})

test('mun link can select Astro, Vue, or Web without forcing React renderer dependencies', () => {
  for (const renderer of ['astro', 'vue', 'web']) {
    const project = mkdtempSync(resolve(tmpdir(), `mun-link-${renderer}-`))
    writeFileSync(resolve(project, 'package.json'), JSON.stringify({ name: `consumer-${renderer}`, private: true }, null, 2))
    const result = run(['link', project, '--renderer', renderer, '--no-install'], root)
    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8'))
    assert.match(manifest.dependencies[`@mun/${renderer}`], /^link:/u)
    assert.equal(manifest.dependencies['@mun/react'], undefined)
  }
})


test('mun link merges pnpm 11 workspace overrides without destroying existing settings', () => {
  const project = mkdtempSync(resolve(tmpdir(), 'mun-link-workspace-'))
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
  assert.match(workspaceConfig, /"@mun\/compiler": "link:/u)
  assert.match(workspaceConfig, /onlyBuiltDependencies:\n  - esbuild/u)
})

test('local source mode refuses package managers that do not support the pnpm workspace override contract', () => {
  const project = mkdtempSync(resolve(tmpdir(), 'mun-link-non-pnpm-'))
  writeFileSync(resolve(project, 'package.json'), JSON.stringify({ name: 'consumer-npm', private: true }, null, 2))
  const before = readFileSync(resolve(project, 'package.json'), 'utf8')
  const result = run(['link', project, '--pm', 'npm', '--no-install'], root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /requires pnpm/u)
  assert.equal(readFileSync(resolve(project, 'package.json'), 'utf8'), before)
  assert.equal(existsSync(resolve(project, 'pnpm-workspace.yaml')), false)
})
