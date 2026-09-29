import assert from 'node:assert/strict'
import test from 'node:test'
import { compileMunFile, createMunVitePlugin, generateVueHostModule } from '../packages/compiler/dist/index.js'

test('compiler emits a reusable legacy host binding plan', () => {
  const source = `struct StatusBadge: View {
  let enabled: boolean
  let count: number
  init(enabled: boolean, count: number) { self.enabled = enabled; self.count = count }
  var body: some View { Text(String(count)) }
}`
  const compiled = compileMunFile(source, 'StatusBadge.mun')
  assert.match(compiled.code, /legacyHost:/)
  assert.match(compiled.code, /coercion:\s*["']boolean["']/)
  assert.match(compiled.code, /coercion:\s*["']number["']/)
})

test('compiler can generate a typed transitional Vue host module', () => {
  const source = `struct StatusBadge: View {
  let enabled: boolean
  let count: number
  init(enabled: boolean, count: number) { self.enabled = enabled; self.count = count }
  var body: some View { Text(String(count)) }
}`
  const generated = generateVueHostModule(source, 'StatusBadge.mun', {
    viewName: 'StatusBadge',
    viewImport: './StatusBadge.mun',
    hostFactoryImport: '#legacy-host',
    aliases: { enabled: 'active' },
  })
  assert.equal(generated.viewName, 'StatusBadge')
  assert.match(generated.code, /export interface StatusBadgeVueProps/)
  assert.match(generated.code, /active\??: boolean/)
  assert.match(generated.code, /count\??: number/)
  assert.match(generated.code, /createMunWebHost\(StatusBadge/)
  assert.match(generated.code, /from ["']#legacy-host["']/)
  assert.match(generated.code, /\$props: StatusBadgeVueProps/)
  assert.match(generated.code, /\{\"enabled\":\"active\"\}/)
})


test('vite can emit the transitional Vue host directly from a .mun import query', () => {
  const source = `struct StatusBadge: View {
  let count: number
  init(count: number) { self.count = count }
  var body: some View { Text(String(count)) }
}`
  const plugin = createMunVitePlugin({ vueHost: { factoryImport: '#legacy-host' } })
  const generated = plugin.transform(source, '/src/StatusBadge.mun?vue-host')
  assert.match(generated?.code ?? '', /createMunWebHost\(StatusBadge/)
  assert.doesNotMatch(generated?.code ?? '', /export interface|\sas\stypeof/)
  assert.match(generated?.code ?? '', /export default StatusBadgeVueHost/)
  assert.match(generated?.code ?? '', /from ["']#legacy-host["']/)
})


test('vue host codegen supports Views with the implicit zero-argument initializer', () => {
  const source = `struct LoadingPage: View {
  var body: some View { Text('Loading') }
}`
  const generated = generateVueHostModule(source, 'LoadingPage.mun', {
    viewImport: './LoadingPage.mun',
    hostFactoryImport: '#legacy-host',
  })
  assert.match(generated.code, /export interface LoadingPageVueProps \{\}/)
  assert.match(generated.code, /createMunWebHost\(LoadingPage, \{ initializerIndex: 0 \}\)/)
})

test('vue host codegen selects the file default export when helper Views come first', () => {
  const source = `struct HelperView: View {
  var body: some View { Text('Helper') }
}
struct MainView: View {
  var body: some View { Text('Main') }
}
export default MainView`
  const generated = generateVueHostModule(source, 'MainView.mun', {
    viewImport: './MainView.mun',
    hostFactoryImport: '#legacy-host',
  })
  assert.equal(generated.viewName, 'MainView')
  assert.match(generated.code, /createMunWebHost\(MainView, \{ initializerIndex: 0 \}\)/)
  assert.match(generated.code, /const MainViewVueHost/)
  assert.match(generated.code, /import MainView from ["']\.\/MainView\.mun["']/)
})

test('vue host codegen treats object-literal initializer arguments without contextual TypeScript inference', () => {
  const source = `type Props = { height: number }
struct StyledHost: View {
  let props: Props
  init(_ props: Props) { self.props = props }
  var body: some View { Box(style: { height: \`${'${props.height}'}px\` }) }
}`
  assert.doesNotThrow(() => generateVueHostModule(source, 'StyledHost.mun', {
    viewImport: './StyledHost.mun',
    hostFactoryImport: '#legacy-host',
  }))
})


test('vite hot updates invalidate only the changed Mün source cache', () => {
  const plugin = createMunVitePlugin({ sourceMap: false })
  const source = 'struct HotView: View { var body: some View { Text("Hot") } }'
  const first = plugin.transform(source, '/tmp/HotView.mun')
  assert.ok(first?.code)
  const modules = [{ id: '/tmp/HotView.mun' }]
  assert.equal(plugin.handleHotUpdate({ file: '/tmp/HotView.mun', modules }), modules)
  const second = plugin.transform(source.replace('Hot', 'Warm'), '/tmp/HotView.mun')
  assert.ok(second?.code)
  assert.notEqual(first.code, second.code)
})
