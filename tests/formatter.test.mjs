import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { formatSource } from '../bin/formatter.mjs'
import { compileMunUiProgram } from '@mun/compiler'

const fixtures = [
  ['struct declaration', 'struct App:View{var body:some View{Text("Hi")}}', 'struct App: View {\n  var body: some View {\n    Text("Hi")\n  }\n}\n'],
  ['wrappers and operators', '@main\nstruct App:View{\n@State private var count:Int=0\nvar body:some View{Button("Add"){count+=1}}}', '@main\nstruct App: View {\n  @State private var count: Int = 0\n  var body: some View {\n    Button("Add") {\n      count += 1\n    }\n  }\n}\n'],
  ['labels', 'VStack(spacing:12){Text("A");Text("B")}.padding()', 'VStack(spacing: 12) {\n  Text("A");\n  Text("B")\n}.padding()\n'],
  ['conditional', 'if ready{Text("Yes")}else{Text("No")}', 'if ready {\n  Text("Yes")\n} else {\n  Text("No")\n}\n'],
  ['decimals and indexing', 'var value:Double=1.25e-3\nText(values[0])', 'var value: Double = 1.25e-3\nText(values[0])\n'],
  ['nested interpolation', 'Text("\\(format("a { }"))")', 'Text("\\(format("a { }"))")\n'],
  ['arrays', 'var values:[Int]=[1,2,3]', 'var values: [Int] = [1, 2, 3]\n'],
  ['dictionary', 'var values=["a":1,"b":2]', 'var values = ["a": 1, "b": 2]\n'],
  ['initializer', 'init(title:String){self.title=title}', 'init(title: String) {\n  self.title = title\n}\n'],
  ['interpolation', 'Text("한글 😀 \\(count) { literal }")', 'Text("한글 😀 \\(count) { literal }")\n'],
  ['nested comments', '/* outer /* inner } */ end */\nText("Hi")', '/* outer /* inner } */ end */\nText("Hi")\n'],
  ['switch', 'switch choice{\ncase 1:Text("One")\ndefault:Text("Other")\n}', 'switch choice {\n  case 1: Text("One")\n  default: Text("Other")\n}\n'],
  ['multiline arguments', 'VStack(\nspacing:12\n){\nText("Hi")\n}', 'VStack(\n  spacing: 12\n) {\n  Text("Hi")\n}\n'],
]
for (const [name, source, expected] of fixtures) test(`formatter: ${name}`, () => {
  assert.equal(formatSource(source), expected)
  assert.equal(formatSource(expected), expected)
})
test('formatter preserves native compilation and literal semantics', () => {
  const source = readFileSync(new URL('../templates/native/App.mun', import.meta.url), 'utf8').replaceAll('__MUN_PROJECT_APP_NAME__', 'FixtureApp')
  assert.deepEqual(compileMunUiProgram(formatSource(source)), compileMunUiProgram(source))
})

for (const name of ['NativeControlsStyle', 'NativeDemo', 'NativeLayoutStyle', 'NativeProductionSmoke', 'NativeSettingsPane']) {
  test(`formatter preserves canonical native example: ${name}`, () => {
    const source = readFileSync(new URL(`../examples/${name}.mun`, import.meta.url), 'utf8')
    const formatted = formatSource(source)
    assert.equal(formatSource(formatted), formatted)
    assert.deepEqual(compileMunUiProgram(formatted), compileMunUiProgram(source))
  })
}
