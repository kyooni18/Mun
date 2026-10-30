import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { munPlugin } from '../packages/vite/dist/index.js'

// Built inside the workspace so `@mun-ui/web` and `@mun-ui/ui/*` resolve as in an app.
const root = fileURLToPath(new URL('../output/builtin-tree-shaking/', import.meta.url))
const counter = `struct Counter: View {
  @State var count = 0
  @State var level = 0.5
  var body: some View {
    VStack(spacing: 12) {
      __EXTRA__
      Text("Count: \\(count)")
      Button("Increase") { count += 1 }
    }
    .padding(16)__MODIFIER__
  }
}
export default Counter()
`

async function bundle(name, app) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'App.mun'), app)
  writeFileSync(join(dir, 'main.ts'), 'import { mount } from "@mun-ui/web"\nimport App from "./App.mun"\nmount(App, document.body)\n')
  await build({ root: dir, logLevel: 'silent', configFile: false, plugins: [munPlugin()], build: { outDir: join(dir, 'dist'), minify: true, rollupOptions: { input: join(dir, 'main.ts') } } })
  const assets = join(dir, 'dist', 'assets')
  return readdirSync(assets).filter(file => file.endsWith('.js')).map(file => readFileSync(join(assets, file), 'utf8')).join('\n')
}

const variant = (extra = '', modifier = '', header = '') => header + counter.replace('__EXTRA__', extra).replace('__MODIFIER__', modifier)
// Initializer signatures are stable string markers that survive minification.
const slider = /Slider\(value, range\?\)/u
const blur = /data-pb-amount/u

test('implicit built-ins and opt-in imports are tree-shaken per module', { timeout: 120_000 }, async () => {
  rmSync(root, { recursive: true, force: true })
  const plain = await bundle('plain', variant())
  const withSlider = await bundle('slider', variant('Slider(value: $level)'))
  const unusedOptIn = await bundle('unused-opt-in', variant('', '', 'import { ProgressiveBlur, BlurProfile } from "@mun-ui/ui/progressive-blur"\n'))
  const usedOptIn = await bundle('used-opt-in', variant('', '.modifier(progressiveBlur(BlurProfile.edge("bottom", 40)))', 'import { BlurProfile, progressiveBlur } from "@mun-ui/ui/progressive-blur"\n'))
  assert.doesNotMatch(plain, slider, 'an unreferenced built-in View is not bundled')
  assert.match(withSlider, slider)
  assert.doesNotMatch(plain, blur)
  assert.equal(unusedOptIn, plain, 'an imported but unused opt-in feature adds nothing')
  assert.match(usedOptIn, blur)
})
