import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { MunLoweringCache, compileMunDevProgram, parseMunStructs } from '@mun/compiler'

// Differential check: a compile that reuses cached View instances must be
// indistinguishable (IR and development metadata) from a from-scratch compile.
function assertSequence(sources) {
  const cache = new MunLoweringCache()
  const results = []
  for (const source of sources) {
    let expected, actual
    try { expected = compileMunDevProgram(source) } catch (error) { expected = { error: error.message } }
    try { actual = compileMunDevProgram(source, undefined, { loweringCache: cache }) } catch (error) { actual = { error: error.message } }
    assert.deepEqual(actual.error ? actual : { program: actual.program, metadata: actual.metadata }, expected.error ? expected : { program: expected.program, metadata: expected.metadata })
    results.push(actual.stats?.lowering)
  }
  return results
}

const card = (name, label, extra = '') => `struct ${name}: View {\n  var title: String\n  @State var on: Bool = false\n  var body: some View {\n    HStack(spacing: 4) {\n      Button("${label}") { on.toggle() }\n      Text(title)${extra}\n    }\n  }\n}\n`
const app = (body, header = '') => `${header}@main\nstruct App: View {\n  @State var count: Int = 0\n  var body: some View {\n    VStack(spacing: 8) {\n${body}\n    }\n  }\n}\n`

test('reused View instances produce the same IR and metadata as a full compile', () => {
  const cards = card('Card', 'Toggle') + card('Other', 'Flip', '\n        .padding(4)')
  const stats = assertSequence([
    app('      Text("A")\n      Card(title: "one")\n      Other(title: "two")') + cards,
    // Edit the entry only: both Views are reused.
    app('      Text("B")\n      Card(title: "one")\n      Other(title: "two")') + cards,
    // Shift every later offset: spans of reused Views must move with them.
    app('      Text("B")\n      Card(title: "one")\n      Other(title: "two")', '// comment\n\n') + cards,
    // Change a call-site argument and a leaf declaration.
    app('      Text("B")\n      Card(title: "uno")\n      Other(title: "two")') + card('Card', 'Toggle') + card('Other', 'Flop', '\n        .padding(4)'),
    // A state type change before a reused View changes the digest.
    app('      Text("B")\n      Card(title: "uno")\n      Other(title: "two")').replace('@State var count: Int = 0', '@State var count: String = "0"') + cards,
    // Adding a View changes name resolution for everything.
    app('      Text("B")\n      Card(title: "uno")\n      Extra()') + cards + 'struct Extra: View {\n  var body: some View { Text("x") }\n}\n',
    // Errors are never cached; the next valid compile is still exact.
    app('      Text("B")\n      Card(title: 3)') + cards,
    app('      Text("B")\n      Card(title: "one")\n      Other(title: "two")') + cards,
  ])
  assert.equal(stats[1].instancesReused, 2)
  assert.deepEqual(stats[1].declarationsLowered, ['App'])
  assert.equal(stats[2].instancesReused, 2, 'offset shifts alone do not invalidate')
  assert.deepEqual(stats[3].declarationsLowered, ['App', 'Card', 'Other'])

  // Same call-site text, but the bound state's type changed: the compile must
  // fail exactly as a full compile does, then recover.
  const counter = 'struct Counter: View {\n  @Binding var value: Int\n  var body: some View { Text("\\(value)") }\n}\n'
  assertSequence([
    app('      Counter(value: $count)') + counter,
    app('      Counter(value: $count)').replace('@State var count: Int = 0', '@State var count: String = "0"') + counter,
    app('      Counter(value: $count)') + counter,
  ])
})

test('nested Views, bindings, ForEach item state and the example corpus stay exact', () => {
  const list = name => `@main\nstruct Lists: View {\n  @State var rows: [Row] = [{ id: "a", title: "A" }, { id: "b", title: "B" }]\n  @State var flag: Bool = false\n  var body: some View {\n    VStack(spacing: 2) {\n      Text("${name}")\n      Toggle("Flag", isOn: $flag)\n      Panel(flag: $flag)\n      ForEach(rows, id: \\.id) { item in\n        RowView(item: item)\n      }\n    }\n  }\n}\n\nstruct Panel: View {\n  @Binding var flag: Bool\n  var body: some View { Inner(on: flag) }\n  struct Inner: View {\n    var on: Bool\n    var body: some View { Text(on ? "on" : "off") }\n  }\n}\n\nstruct RowView: View {\n  var item: Row\n  @State var open: Bool = false\n  var body: some View {\n    HStack {\n      Button("Open") { open.toggle() }\n      Text(item.title)\n    }\n  }\n}\n`
  const stats = assertSequence([list('one'), list('two'), list('two').replace('Text(on ? "on" : "off")', 'Text(on ? "yes" : "no")')])
  assert.ok(stats[1].instancesReused >= 2)
  assert.ok(stats[2].declarationsLowered.includes('Panel'), 'a nested declaration change relowers its parent')

  for (const file of readdirSync(new URL('../examples', import.meta.url)).filter(name => name.endsWith('.mun'))) {
    const source = readFileSync(new URL(`../examples/${file}`, import.meta.url), 'utf8')
    const edited = source.replace(/Text\("([^"\\]*)"\)/u, 'Text("$1 edited")')
    assertSequence([source, edited, `// moved\n${edited}`, source])
  }
})

test('reused struct parses keep exact source ranges at any offset', () => {
  const sources = readdirSync(new URL('../examples', import.meta.url))
    .filter(name => name.endsWith('.mun'))
    .map(file => readFileSync(new URL(`../examples/${file}`, import.meta.url), 'utf8'))
  // Every recorded range must slice back out of the source to the recorded
  // text, whether the declaration was parsed fresh or reused and shifted.
  const check = (source, declarations) => {
    for (const declaration of declarations) {
      assert.equal(source.slice(declaration.range.start, declaration.range.end), declaration.source)
      assert.equal(source.slice(declaration.bodyRange.start, declaration.bodyRange.end), declaration.bodySource)
      assert.equal(source.slice(declaration.bodyExpressionRange.start, declaration.bodyExpressionRange.end), declaration.bodyExpressionSource)
      for (const field of declaration.fields) assert.equal(source.slice(field.range.start, field.range.end), field.name)
      for (const initializer of declaration.initializers) {
        assert.equal(source.slice(initializer.parametersRange.start, initializer.parametersRange.end), initializer.parametersSource)
        assert.equal(source.slice(initializer.bodyRange.start, initializer.bodyRange.end), initializer.bodySource)
      }
      check(source, declaration.nested ?? [])
    }
  }
  const variants = [...sources, ...sources.map(source => `// shifted\n\n${source}`), sources.join('\n'), `\n${sources.slice().reverse().join('\n\n')}`]
  for (let pass = 0; pass < 2; pass += 1) for (const source of variants) check(source, parseMunStructs(source))
})
