import assert from "node:assert/strict"
import test from "node:test"
import ts from "typescript"
import { diagnoseMunSource, transformMunSource } from "../packages/compiler/dist/index.js"

function parses(output, name = "Generated.ts") {
  assert.equal(ts.createSourceFile(name, output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
}

test("compiler never rewrites ordinary TypeScript methods or generators as Mun closures", () => {
  const source = `
class Service {
  method() { const value = 1; return value }
  static async Load() { return 2 }
  get value() { return 3 }
  set value(next: number) { void next }
  *values() { yield 1 }
}
const object = {
  method() { const value = 4; return value },
  async Load() { return 5 },
  get value() { return 6 },
  *values() { yield 7 },
}
function* topLevel() { yield 8 }
`
  const output = transformMunSource(source, "Methods.mun.ts")
  assert.doesNotMatch(output, /overloadClosure/)
  assert.match(output, /method\(\) \{/)
  assert.match(output, /\*values\(\)/)
  parses(output)
  assert.deepEqual(diagnoseMunSource(source), [])
})

test("Mun trailing closures remain callable inside object-valued property expressions", () => {
  const source = `const Graph = defineView("Graph", {
  body: () => VStack(
    Text("A"),
    Button("Increment") { count.value += 1 },
    ForEach(items) { item in Text(item.id) },
  ),
})`
  const output = transformMunSource(source, "ObjectPropertyClosures.mun.ts")
  assert.match(output, /Button(?:\.viewType\.createNodeSpecialized\([^\n]*|\()(?=[\s\S]*count\.value \+= 1)/)
  assert.match(output, /ForEach(?:\.viewType\.createNodeSpecialized|\()/)
  assert.doesNotMatch(output, /Button\([^\n]*\), \{ count\.value/)
  parses(output)
})

test("statement-aware ViewBuilder recursively collects conditional, loop, and try children", () => {
  const source = `VStack() {
  const values = [1, 2]
  enabled ? Text("on") : Text("off")
  enabled && Text("extra")
  for (const value of values) Text(String(value))
  while (ready) { Text("ready"); break }
  try { Text("try") } catch { Text("catch") } finally { Text("finally") }
}`
  const output = transformMunSource(source, "ControlFlow.mun.ts")
  assert.match(output, /__munChildren\.push\(enabled \? Text\("on"\) : Text\("off"\)\)/)
  assert.match(output, /__munChildren\.push\(enabled && Text\("extra"\)\)/)
  assert.match(output, /for \(const value of values\)[\s\S]*__munChildren\.push\(Text\(String\(value\)\)\)/)
  assert.match(output, /while \(ready\)[\s\S]*__munChildren\.push\(Text\("ready"\)\)/)
  assert.match(output, /try[\s\S]*__munChildren\.push\(Text\("try"\)\)[\s\S]*catch[\s\S]*__munChildren\.push\(Text\("catch"\)\)[\s\S]*finally[\s\S]*__munChildren\.push\(Text\("finally"\)\)/)
  parses(output)
})

test("statement-aware ViewBuilder lowers labeled nested calls before TypeScript parser recovery", () => {
  const source = `VStack() {
  if (enabled) {
    Badge("ready", className: "status")
  }
}`
  const output = transformMunSource(source, "StatementAwareNamedCall.mun.ts")
  assert.match(output, /Badge\("ready", namedArguments\(\{ className: "status" \}\)\)/)
  assert.doesNotMatch(output, /Badge\("ready", className, "status"\)/)
  parses(output)
})

test("top-level State ownership is per-view and shared State remains module-scoped", () => {
  const source = `import { State } from "@mun/core/compat"
import { view } from "@mun/react"
const first = State(1)
const second = State(2)
const shared = State(3)
export const A = view(() => VStack() { Text(String(first.value)); Text(String(shared.value)) })
export const B = view(() => VStack() { Text(String(second.value)); Text(String(shared.value)) })`
  const output = transformMunSource(source, "StateOwnership.mun.ts")
  assert.match(output, /^const shared = State\(3\)/m)
  assert.doesNotMatch(output, /^const first = State\(1\)/m)
  assert.doesNotMatch(output, /^const second = State\(2\)/m)
  assert.match(output, /state: \(\) => \{ const first = State\(1\)/)
  assert.match(output, /state: \(\) => \{ const second = State\(2\)/)
  assert.match(output, /dependencies: \(\{ first \}\) => \[first\]/)
  assert.match(output, /dependencies: \(\{ second \}\) => \[second\]/)
  assert.doesNotMatch(output, /dependenciesComplete: true/)
  parses(output)
})

test("top-level State skips runtime dependency discovery only for a compiler-proven closed body", () => {
  const source = `import { State, Text } from "@mun/core"
import { view } from "@mun/react"
const count = State(0)
export default view(() => Text(String(count.value)))`
  const output = transformMunSource(source, "ClosedStateDependencies.mun.ts")
  assert.match(output, /dependencies: \(\{ count \}\) => \[count\], dependenciesComplete: true/)
  parses(output)
})

test("top-level State keeps runtime dependency discovery for unproven member calls", () => {
  const source = `import { State, Text } from "@mun/core"
import { view } from "@mun/react"
const count = State(0)
const helper = { padding(value: number) { return Text(String(value)) } }
export default view(() => count.value > 0 ? helper.padding(8) : Text(String(count.value)))`
  const output = transformMunSource(source, "OpaqueModifierName.mun.ts")
  assert.match(output, /dependencies: \(\{ count \}\) => \[count\]/)
  assert.doesNotMatch(output, /dependenciesComplete: true/)
  parses(output)
})

test("top-level State proof rejects shadowed pure globals", () => {
  const source = `import { State, Text } from "@mun/core"
import { view } from "@mun/react"
const external = State("outside")
const count = State(0)
const String = (_value: unknown) => external.value
export default view(() => Text(String(count.value)))`
  const output = transformMunSource(source, "ShadowedPureGlobal.mun.ts")
  assert.match(output, /dependencies: \(\{ count \}\) => \[count\]/)
  assert.doesNotMatch(output, /dependenciesComplete: true/)
  assert.match(output, /^const external = State\("outside"\)/m)
  parses(output)
})

test("top-level State ownership respects outer references and lexical shadowing", () => {
  const outside = `import { State } from "@mun/core/compat"
import { view } from "@mun/react"
const count = State(0)
export function readCount() { return count.value }
export default view(() => Text(String(count.value)))`
  assert.match(transformMunSource(outside, "Outside.mun.ts"), /^const count = State\(0\)/m)

  const shadowed = `import { State } from "@mun/core/compat"
import { view } from "@mun/react"
const count = State(0)
function helper(count: number) { return count + 1 }
export default view(() => Text(String(count.value)))`
  const output = transformMunSource(shadowed, "Shadowed.mun.ts")
  assert.doesNotMatch(output, /^const count = State\(0\)/m)
  assert.match(output, /state: \(\) => \{ const count = State\(0\)/)
  parses(output)
})

test("semantic initializer matching widens const primitive literal types", () => {
  const source = `const title = "Mun"
const count = 3
const enabled = true
Text(title)
Text(count)
Text(String(enabled))`
  const diagnostics = diagnoseMunSource(source).filter(item => item.code === "MUN_INITIALIZER")
  assert.deepEqual(diagnostics, [])
})

test("semantic initializer matching preserves direct string literals for literal contracts", () => {
  const valid = diagnoseMunSource('ScrollView("both") { Text("valid") }').filter(item => item.code === "MUN_INITIALIZER")
  const invalid = diagnoseMunSource('ScrollView("sideways") { Text("invalid") }').filter(item => item.code === "MUN_INITIALIZER")
  assert.deepEqual(valid, [])
  assert.equal(invalid.length, 1)
})

test("raw HTML disambiguates TypeScript assertions and decodes character references", () => {
  const assertion = `const result = <Foo>input\nText(String(result))`
  const assertionOutput = transformMunSource(assertion, "Assertion.mun.ts")
  assert.match(assertionOutput, /<Foo>input/)
  assert.doesNotMatch(assertionOutput, /Element\("Foo"/)
  parses(assertionOutput)

  const html = `<div title="A &amp; B">A &amp; B &#x21;</div>`
  const htmlOutput = transformMunSource(html, "Entities.mun.ts")
  assert.match(htmlOutput, /Element\("div", \{ "?title"?: "A & B" \}, "A & B !"\)/)
  parses(htmlOutput)
})

test("qualified nested Mun view calls lower named arguments without losing the qualifier", () => {
  const source = `struct Outer: View {
  struct Inner: View {
    let title: string
    init(title: string) { self.title = title }
    var body: some View { Text(title) }
  }
  var body: some View { Outer.Inner(title: "x") }
}`
  const output = transformMunSource(source, "Nested.mun.ts")
  assert.match(output, /Outer\.Inner\(namedArguments\(\{ title: "x" \}\)\)/)
  assert.doesNotMatch(output, /Outer\.Inner\(title:/)
  parses(output)
})

test("source maps keep moved State declarations and body uses on their original spans", async () => {
  const { compileMunFile, mapGeneratedPosition } = await import("../packages/compiler/dist/index.js")
  const source = `import { State, Text, view } from "@mun/core/compat"
const count = State(0)
const label = "x"

export default view(() =>
  Text(String(count.value))
)`
  const result = compileMunFile(source, "SourceMap.mun.ts")
  const lines = result.code.split("\n")
  const stateLine = lines.findIndex(line => line.includes("const count = State(0)"))
  const stateColumn = lines[stateLine].indexOf("count")
  const useLine = lines.findIndex(line => line.includes("String(count.value)"))
  const useColumn = lines[useLine].indexOf("count")
  assert.deepEqual(mapGeneratedPosition(result.map, { line: stateLine + 1, column: stateColumn + 1 }), { line: 2, column: 7 })
  assert.deepEqual(mapGeneratedPosition(result.map, { line: useLine + 1, column: useColumn + 1 }), { line: 6, column: 15 })
})

test("diagnostics warn when top-level State cannot become instance-local", () => {
  const source = `import { State as S } from "@mun/core"
export const exported = S(0)
let mutable = S(1)
const local = S(2)`
  const warnings = diagnoseMunSource(source).filter(item => item.code === "MUN_STATE_SCOPE")
  assert.equal(warnings.length, 2)
  assert.deepEqual(warnings.map(item => [item.severity, item.line]), [["warning", 2], ["warning", 3]])
  assert.match(warnings[0].message, /exported/)
  assert.match(warnings[1].message, /mutable/)
})

test("static specialization cache invalidates when an imported type file changes", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { lowerStaticImportedCalls } = await import("../packages/compiler/dist/specialization.js")
  const directory = mkdtempSync(join(tmpdir(), "mun-specialization-"))
  try {
    const dependency = join(directory, "dep.ts")
    const fileName = join(directory, "main.mun.ts")
    const source = `import { Card } from "./dep"\nconst value = Card("x")\n`
    writeFileSync(dependency, `export declare const Card: { (value: string): unknown; readonly viewType: {} }\n`)
    assert.match(lowerStaticImportedCalls(source, fileName), /createNodeCompiled/)
    writeFileSync(dependency, `export declare const Card: { (...value: string[]): unknown; readonly viewType: {} }\n`)
    assert.doesNotMatch(lowerStaticImportedCalls(source, fileName), /createNode(?:Compiled|Specialized)/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("trusted imported specialization rejects callables with unsafe return types", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { lowerStaticImportedCalls } = await import("../packages/compiler/dist/specialization.js")
  const directory = mkdtempSync(join(tmpdir(), "mun-unsafe-builder-"))
  try {
    const dependency = join(directory, "dep.ts")
    const fileName = join(directory, "main.mun.ts")
    writeFileSync(dependency, `export declare const Stack: { (content: () => any): unknown; readonly viewType: {} }\n`)
    const source = `import { Stack } from "./dep"\ndeclare const content: () => any\nconst value = Stack(content)\n`
    const output = lowerStaticImportedCalls(source, fileName)
    assert.match(output, /createNodeSpecialized/)
    assert.doesNotMatch(output, /createNodeCompiled/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("dynamic Button values defer initializer choice instead of producing a false compiler error", () => {
  const source = `const label = enabled ? "Pause" : "Resume"\nButton(label) { save() }`
  assert.deepEqual(diagnoseMunSource(source).filter(item => item.code === "MUN_INITIALIZER"), [])
  const output = transformMunSource(source, "DynamicButton.mun.ts")
  assert.match(output, /Button\(label, \(\) => \{\s*save\(\)\s*\}\)/)
  parses(output)

  const named = `const action = () => save()\nButton(action: action, label: { Text("Save") })`
  assert.deepEqual(diagnoseMunSource(named).filter(item => item.code === "MUN_INITIALIZER"), [])
  parses(transformMunSource(named, "DynamicNamedButton.mun.ts"))
})

test("SwiftUI labeled calls remain valid TypeScript inside struct View bodies", () => {
  const source = `import { Button, Text } from "@mun/core/compat"
export struct ToolbarButton: View {
  let action: () => void
  init(action: () => void) { self.action = action }
  var body: some View {
    Button(action: action, label: { Text("Save") })
  }
}`
  const output = transformMunSource(source, "StructNamedButton.mun")
  assert.match(output, /Button\(namedArguments\(\{ action: action, label:/)
  assert.doesNotMatch(output, /Button\(action,\s*action,\s*label,/)
  parses(output)
})

test("parameterized Swift action closures lower inside struct View bodies", () => {
  const source = `import { Text } from "@mun/core/compat"
struct Field: View {
  let onChange: (value: string) => void
  init(@Action onChange: (value: string) => void) { self.onChange = onChange }
  var body: some View { Text("Field") }
}
export struct Form: View {
  var body: some View {
    Field(onChange: { value in save(value) })
  }
}`
  const output = transformMunSource(source, "ParameterizedAction.mun")
  assert.match(output, /\(value\) => \{\s*save\(value\)\s*\}/)
  assert.doesNotMatch(output, /value\s+in/)
  assert.match(output, /type: "\(value: string\) => void", defaultValue: undefined/)
  parses(output)
})

test("aliased dollar imports are never mistaken for Binding shorthand", () => {
  const source = `import { $i as currentUser } from "./identity.js"
import { Text } from "@mun/core/compat"
export struct AccountLabel: View {
  var body: some View { Text(currentUser?.username ?? "guest") }
}`
  const output = transformMunSource(source, "DollarImport.mun")
  assert.match(output, /import \{ \$i as currentUser \} from "\.\/identity\.js"/)
  assert.doesNotMatch(output, /Binding\(i\)/)
  parses(output)
})


test("Grid and LazyGrid static specialization indices match runtime initializer order", () => {
  const source = `import { Grid, LazyGrid, Text } from "@mun/core/compat"
Grid({ columns: 3 }) { Text("A") }
LazyGrid({ columns: 2, estimatedItemSize: 44 }) { Text("B") }`
  const output = transformMunSource(source, "GridSpecialization.mun.ts")
  assert.match(output, /Grid\.viewType\.createNodeCompiled\(0,/)
  assert.match(output, /LazyGrid\.viewType\.createNodeCompiled\(0,/)
  parses(output)
})

test("Switch static specialization indices match runtime initializer order", () => {
  const source = `import { Binding, State, Switch } from "@mun/core/compat"
const isOn = State(false)
Switch("Switch", Binding(isOn))
Switch(Binding(isOn))`
  const output = transformMunSource(source, "SwitchSpecialization.mun.ts")
  assert.match(output, /Switch\.viewType\.createNodeCompiled\(0, \["Switch", Binding\(isOn\)\]\)/)
  assert.match(output, /Switch\.viewType\.createNodeCompiled\(1, \[Binding\(isOn\)\]\)/)
  parses(output)
})

test("implicit member arguments survive static modifier chain specialization", () => {
  // `.red` is not valid TypeScript, so the checker recovers with a zero-width
  // base; the emitted argument must still be the lowered string literal.
  const source = `import { Text } from "@mun/core/compat"\nconst view = Text("x").foregroundStyle(.red)`
  const output = transformMunSource(source, "ImplicitMemberModifier.mun.ts")
  assert.match(output, /\[\["foregroundStyle", \["red"\]\]\]/)
  assert.doesNotMatch(output, /\[red\]/)
  parses(output)
})

test("ternary implicit members lower in labeled arguments and keep optional chaining intact", () => {
  const output = transformMunSource(
    'VStack(alignment: flag ? .center : .leading) { Text("a") }',
    "TernaryMember.mun.ts",
  )
  assert.match(output, /alignment: flag \? "center" : "leading"/)
  parses(output)

  const chaining = transformMunSource('const name = obj?.value?.name ?? "fallback"', "OptionalChaining.ts")
  assert.equal(chaining, 'const name = obj?.value?.name ?? "fallback"')
})

test("single-line struct initializer bodies produce valid field assignments", () => {
  const source = `struct Gauge: View {
  var v: number
  init(v: number) { if (v < 0) { self.v = 0 } else { self.v = v } }
  var body: some View { Text(String(v)) }
}`
  const output = transformMunSource(source, "SingleLineInit.mun.ts")
  // The closing braces of the single-line body must not be swallowed into
  // the field expression; the final assignment wins.
  assert.match(output, /return \{ v: v \} \}/)
  parses(output)
})

test("mixed State and view declarators hoist without corrupting sibling edits", () => {
  const source = `import { State } from "@mun/core/compat"
import { view } from "@mun/react"
const count = State(0), app = view(() => Text(String(count.value)))`
  const output = transformMunSource(source, "MixedDeclarators.mun.ts")
  // The State declaration is removed and the view call gains its state body
  // without leaving fragments of the original statement behind.
  assert.match(output, /const\s+app = view\(\{\s*state:/)
  assert.doesNotMatch(output, /\)\)tate\(0\)/)
  assert.doesNotMatch(output, /view\([^)]*\)[a-zA-Z]/)
  assert.doesNotMatch(output, /^const count = State\(0\)/m)
  parses(output)
})

test("spread arguments and member access survive static modifier specialization", () => {
  const source = `import { Text } from "@mun/core/compat"\nconst values = [8]\nconst view = Text("x").padding(...values)`
  const output = transformMunSource(source, "SpreadModifier.mun.ts")
  assert.match(output, /\[\["padding", \[\.\.\.values\]\]\]/)
  assert.doesNotMatch(output, /\["values"\]/)
  parses(output)
})

test("implicit-member lowering never rewrites string or comment content", () => {
  const source = `import { Text } from "@mun/core/compat"
// return .red inside a comment
const view = Text("Press return .red to confirm")`
  const output = transformMunSource(source, "ProseMember.mun.ts")
  // The prose keeps its literal `.red`; only authored implicit members lower.
  assert.match(output, /Press return \.red to confirm/)
  assert.match(output, /return \.red inside a comment/)
  assert.doesNotMatch(output, /"red" to confirm/)
  parses(output)
})

test("binding shorthand never rewrites dollar-prefixed import or export aliases", () => {
  const source = `import { $i as currentUser } from "./identity.js"
export { $i as exportedUser } from "./identity.js"
const title = currentUser?.name ?? "guest"`
  const output = transformMunSource(source, "DollarImportAlias.mun.ts")
  assert.match(output, /import \{ \$i as currentUser \}/)
  assert.match(output, /export \{ \$i as exportedUser \}/)
  assert.doesNotMatch(output, /Binding\(i\)/)
  parses(output)
})

test("struct field assignments continue across operator-terminated lines", () => {
  const source = `struct Banner: View {
  var title: string
  init(prefix: string) { self.title = prefix +\n  " World" }
  var body: some View { Text(title) }
}`
  const output = transformMunSource(source, "MultilineInit.mun.ts")
  assert.match(output, /title: prefix \+\s+" World"/)
  parses(output)
})
