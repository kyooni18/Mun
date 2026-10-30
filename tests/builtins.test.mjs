import assert from 'node:assert/strict'
import test from 'node:test'
import * as Core from '../packages/core/dist/index.js'
import { diagnoseMunSource, munBuiltinSymbols, munOptInFeatures, transformMunSource } from '../packages/compiler/dist/index.js'
import { LanguageService } from '../editors/lsp/service.mjs'
import { positionAt } from '../editors/lsp/source.mjs'

const counter = `struct Counter: View {
    @State var count = 0
    var body: some View {
        VStack(spacing: 12) {
            Text("Count: \\(count)")
            Button("Increase") {
                count += 1
            }
        }
        .padding(16)
    }
}
export default Counter()
`

function builtinImports(output) {
  const match = /import \{([^}]*)\} from "@mun\/core\/compat"/u.exec(output)
  return new Set(match ? match[1].split(',').map(name => name.trim()) : [])
}

test('standard .mun components compile without imports and import only what they read', () => {
  const imports = builtinImports(transformMunSource(counter, 'Counter.mun'))
  for (const name of ['VStack', 'Text', 'Button', 'State']) assert.ok(imports.has(name), name)
  for (const name of ['HStack', 'Slider', 'List', 'Color', 'Image']) assert.ok(!imports.has(name), `${name} is not referenced`)
  assert.deepEqual(diagnoseMunSource(counter, 'Counter.mun', { target: 'web' }), [])
})

test('value types and functions resolve as built-ins, not only View calls', () => {
  const source = `struct Swatch: View {
  @State var on = false
  var body: some View {
    Text("x").foregroundStyle(Color.red).animation(.easeInOut, value: on)
  }
}
export default Swatch()
`
  const imports = builtinImports(transformMunSource(source, 'Swatch.mun'))
  assert.ok(imports.has('Color'), 'Color.red used to lower to an unimported identifier')
  assert.ok(imports.has('Animation'))
})

test('declarations and explicit imports shadow built-ins lexically', () => {
  const shadowed = transformMunSource(`struct Text: View {
  var label: String
  var body: some View { Element("b", {}) { "hi" } }
}
struct App: View {
  var body: some View { VStack { Text(label: "mine") } }
}
export default App()
`, 'Shadow.mun')
  assert.ok(!builtinImports(shadowed).has('Text'), 'a user View named Text wins over the built-in')
  const aliased = transformMunSource(`import { Text as Label2 } from "@mun-ui/core"
struct App: View {
  var body: some View { VStack { Label2("explicit"); Text("auto") } }
}
export default App()
`, 'Explicit.mun')
  assert.match(aliased, /import \{ Text as Label2 \} from "@mun\/core"/u, 'explicit imports stay supported')
  assert.ok(builtinImports(aliased).has('Text'))
  const explicit = transformMunSource(`import { Text } from "@mun-ui/core"
struct App: View { var body: some View { Text("x") } }
export default App()
`, 'Own.mun')
  assert.ok(!builtinImports(explicit).has('Text'), 'an explicit import is never duplicated')
})

test('unknown, native-only and opt-in identifiers report located diagnostics', () => {
  const unknown = diagnoseMunSource('struct A: View {\n  var body: some View {\n    VStack { Frobnicate("x") }\n  }\n}\nexport default A()\n', 'A.mun', { target: 'web' })
  assert.equal(unknown.length, 1)
  assert.match(unknown[0].message, /Cannot find 'Frobnicate' in scope/u)
  assert.deepEqual([unknown[0].line, unknown[0].column], [3, 14])
  const optIn = diagnoseMunSource('struct A: View {\n  var body: some View { ProgressiveBlur(1) }\n}\nexport default A()\n', 'A.mun', { target: 'web' })
  assert.match(optIn[0].message, /import \{ ProgressiveBlur \} from "@mun\/ui\/progressive-blur"/u)
  const native = diagnoseMunSource('struct A: View {\n  @State var p = ""\n  var body: some View { SecureField("pw", text: $p) }\n}\nexport default A()\n', 'A.mun', { target: 'web' })
  assert.match(native[0].message, /only to the native target/u)
  const typo = diagnoseMunSource('struct A: View {\n  var greeting = "hi"\n  var body: some View { Text(greting) }\n}\nexport default A()\n', 'A.mun', { target: 'web' })
  assert.match(typo[0].message, /Cannot find 'greting' in scope/u)
  assert.deepEqual([typo[0].line, typo[0].column], [3, 30])
  // Host globals are not mistaken for missing Views.
  assert.deepEqual(diagnoseMunSource('struct A: View {\n  func f() { let o = new ResizeObserver(() => {}); console.log(o, Math.max(1, 2), new URL("x:y")) }\n  var body: some View { Text("ok") }\n}\nexport default A()\n', 'A.mun', { target: 'web' }), [])
})

test('Swift-typed struct fields satisfy TypeScript-typed initializer parameters', () => {
  const source = 'struct S: View {\n  var title: String\n  var n: Int\n  var body: some View { VStack { Text(title); Text(n); Button(title) { } } }\n}\nexport default S(title: "x", n: 1)\n'
  assert.deepEqual(diagnoseMunSource(source, 'S.mun', { target: 'web' }), [])
})

test('the registry lists only implemented runtime bindings', () => {
  for (const symbol of munBuiltinSymbols().values()) {
    if (symbol.module) assert.equal(typeof Core[symbol.name], 'function', `${symbol.name} must exist at runtime`)
  }
  for (const name of ['Text', 'Image', 'Button', 'Spacer', 'VStack', 'HStack', 'ZStack', 'ScrollView', 'List', 'Toggle', 'State', 'Binding', 'withAnimation', 'Color', 'View']) {
    assert.ok(munBuiltinSymbols().has(name), name)
  }
})

test('opt-in feature names match the module they point to', async () => {
  for (const feature of munOptInFeatures) {
    const module = await import(feature.module)
    for (const name of feature.exports) assert.ok(name in module, `${feature.module} exports ${name}`)
    for (const name of feature.exports) assert.ok(!munBuiltinSymbols().has(name), `${name} must never resolve implicitly`)
  }
})

test('LSP completion and hover follow the built-in resolution rules', () => {
  const service = new LanguageService(), uri = 'file:///App.mun'
  const source = 'struct Card: View {\n  var body: some View {\n    VStack {\n      \n    }\n  }\n}\n'
  service.update(uri, source)
  const labels = service.completion(uri, positionAt(source, source.indexOf('\n    }'))).map(item => item.label)
  for (const name of ['Text', 'Color', 'withAnimation', 'Card']) assert.ok(labels.includes(name), name)
  assert.ok(!labels.includes('ProgressiveBlur'), 'opt-in features are not offered as built-ins')
  assert.ok(!labels.includes('View') && !labels.includes('SecureField'))

  const shadow = 'struct Text: View {\n  var label: String\n  var body: some View { Element("b", {}) { "x" } }\n}\nstruct App: View {\n  var body: some View { Text(label: "a") }\n}\n'
  service.update(uri, shadow)
  const hover = service.hover(uri, positionAt(shadow, shadow.lastIndexOf('Text(') + 1))
  assert.match(hover.contents.value, /Text\(label/u, 'hover shows the user View that shadows the built-in')
  const builtin = 'struct App: View {\n  var body: some View { Text("a").foregroundStyle(Color.red) }\n}\n'
  service.update(uri, builtin)
  const color = service.hover(uri, positionAt(builtin, builtin.indexOf('Color') + 1))
  assert.match(color.contents.value, /Resolved without an import from `@mun\/core\/compat`/u)
  assert.deepEqual(service.diagnostics(uri), [])
  const missing = 'struct App: View {\n  var body: some View { Frobnicate() }\n}\nexport default App()\n'
  service.update(uri, missing)
  assert.match(service.diagnostics(uri)[0].message, /Cannot find 'Frobnicate'/u)
})
