import assert from "node:assert/strict"
import test from "node:test"
import ts from "typescript"
import { analyzeMunSource, compileMunFile, createMunLanguageService, createMunSemanticModel, createMunVitePlugin, diagnoseMunSource, lowerMunBuilderAst, mapGeneratedPosition, mapOriginalPosition, parseMunBuilder, parseMunStructs, transformMunSource } from "../packages/compiler/dist/index.js"
import { munPlugin } from "../packages/vite/dist/index.js"
import { Text, VStack, compiledTemplate, defineCompiledTemplate, defineView, initializer, modifiedContent, modifiedContentCompiled, modifierGraphOf, namedArguments, overloadClosure, renderViewNode, resolveBuilderClosure, resolveBuilderInput } from "../packages/core/dist/compat.js"
import { readFileSync } from "node:fs"

test("@mun/compiler lowers .mun.ts builders through declaration-neutral syntax", () => {
  const source = `VStack(spacing: 12) {\n  Text("Header")\n  if (enabled) { Text("On") } else { Text("Off") }\n  ForEach(items) { item in Row(item) }\n  Each(items) { item in Row(item) }\n}`
  const output = transformMunSource(source, "Counter.mun.ts")
  assert.match(output, /VStack\(namedArguments\(\{ spacing: 12 \}\), \(\) =>/)
  assert.match(output, /if \(enabled\)[\s\S]*Text\("On"\)[\s\S]*Text\("Off"\)/)
  assert.match(output, /ForEach\(items, \(item\) => \[Row\(item\)\]\)/)
  assert.match(output, /Each\(items, \(item\) => \[Row\(item\)\]\)/)
  assert.match(output, /import \{ namedArguments \} from "@mun\/core\/compat"/)
  assert.equal(ts.createSourceFile("Builder.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("SwiftUI modifier labels preserve argument slots and gesture closure roles", () => {
  const source = `Text("x")
  .shadow(color: "black", radius: 4, x: 1, y: 2)
  .blur(radius: 3, opaque: true)
  .onTapGesture(count: 2, perform: { hit() })
  .onLongPressGesture(perform: { hold() }, onPressingChanged: { pressing in press(pressing) })
  .onHover(perform: { hovering in hover(hovering) })`
  const output = transformMunSource(source, "Modifiers.mun.ts")
  assert.match(output, /\.shadow\("black", 4, 1, 2\)/)
  assert.match(output, /\.blur\(3, true\)/)
  assert.match(output, /\.onTapGesture\(2, \(\) => \{hit\(\)\}\)/)
  assert.match(output, /\.onLongPressGesture\(undefined, undefined, \(\) => \{hold\(\)\}, \(pressing\) => \{press\(pressing\)\}\)/)
  assert.match(output, /\.onHover\(\(hovering\) => \{hover\(hovering\)\}\)/)
  assert.equal(ts.createSourceFile("Modifiers.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("@mun/compiler keeps Vue imports separate when ensuring core imports", () => {
  const source = `import { MunView } from "@mun/vue"
import { Element } from "@mun/core/compat"
const App = MunView(() => Element("section", null, "Hi"))`
  const output = transformMunSource(source, "VueImports.mun.ts")
  assert.match(output, /import \{ MunView \} from "@mun\/vue"/)
  assert.match(output, /import \{ Element \} from "@mun\/core\/compat"/)
  assert.doesNotMatch(output, /Element,\s*Element/)
  assert.equal(ts.createSourceFile("VueImports.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("@mun/compiler keeps TypeScript lexical syntax separate from Mun HTML and blocks", () => {
  const source = `type Bar = number
declare const foo: <T>(value: T) => T
declare const a: number
declare const b: number
function matches(value: string) {
  return /\\{/.test(value)
}
const generic = foo<Bar>(1)
const result = a < b && b > a`
  const output = transformMunSource(source, "LexicalBoundaries.mun.ts")
  assert.match(output, /foo<Bar>\(1\)/)
  assert.match(output, /a < b && b > a/)
  assert.ok(output.includes(String.raw`return /\{/.test(value)`))
  assert.deepEqual(diagnoseMunSource(source).filter(diagnostic => diagnostic.code === "MUN_SYNTAX"), [])
  assert.equal(ts.createSourceFile("LexicalBoundaries.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("@mun/compiler lowers ViewBuilder statements and children in one executable closure", () => {
  const source = `VStack() {
  const title = "Hello"
  const enabled = count > 0
  Text(title)
  if (enabled) {
    Text("Enabled")
  }
}`
  const output = transformMunSource(source, "StatementBody.mun.ts")
  assert.match(output, /const __munChildren = \[\]/)
  assert.match(output, /const title = "Hello"/)
  assert.match(output, /__munChildren\.push\(Text\(title\)\)/)
  assert.match(output, /if \(enabled\)[\s\S]*__munChildren\.push\(Text\("Enabled"\)\)/)
  assert.doesNotMatch(output, /\[const title/)
  assert.equal(ts.createSourceFile("StatementBody.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)

  const controlFlow = transformMunSource(`VStack() {
  switch (mode) {
    case "enabled":
      Text("Enabled")
      break
    default:
      if (fallback) {
        return Text("Fallback")
      }
  }
}`, "StatementControlFlow.mun.ts")
  assert.match(controlFlow, /switch \(mode\)/)
  assert.match(controlFlow, /case "enabled":[\s\S]*__munChildren\.push\(Text\("Enabled"\)\)[\s\S]*break;/)
  assert.match(controlFlow, /if \(fallback\)[\s\S]*return Text\("Fallback"\);/)
  assert.equal(ts.createSourceFile("StatementControlFlow.ts", controlFlow, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("@mun/compiler preserves State call shape, generic arguments, and object initializers", () => {
  const source = `type Foo = { readonly value: string }
import { State, Text } from "@mun/core/compat"
import { view } from "@mun/react"
const count = State(
  0
)
const value = State<Foo | null>(null)
const state = State({
  count: 0,
  text: ""
})
export default view(() => [
  Text(String(count.value)),
  Text(String(value.value?.value ?? "")),
  Text(String(state.value.count)),
])`
  const output = transformMunSource(source, "StateShapes.mun.ts")
  assert.match(output, /state: \(\) => \{[\s\S]*const count = State\(\n  0\n\);[\s\S]*const value = State<Foo \| null>\(null\);[\s\S]*const state = State\(\{\n  count: 0,\n  text: ""\n\}\);/)
  assert.doesNotMatch(output, /^const count = State/m)
  assert.doesNotMatch(output, /^const value = State/m)
  assert.equal(ts.createSourceFile("StateShapes.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("@mun/compiler preserves meaningful raw HTML whitespace and explicit ForEach identity", () => {
  const html = transformMunSource(`<p>Hello <strong>world</strong> !</p>`, "Whitespace.mun.ts")
  assert.match(html, /Element\("p", null, "Hello ", Element\("strong", null, "world"\), " !"\)/)
  assert.doesNotMatch(html, /"Hello".*"world".*"!"/)

  const each = transformMunSource(`const items = [{ id: "a" }]
ForEach(items, { id: item => item.id }) {
  Row(item)
}`, "ForEachIdentity.mun.ts")
  assert.match(each, /ForEach\(items, namedArguments\(\{ key: item => item\.id \}\), \(\) => \[Row\(item\)\]\)/)
  assert.deepEqual(diagnoseMunSource(`const items = [{ id: "a" }]
ForEach(items, { id: item => item.id }) { Row(item) }`), [])
})


test("canonical .mun rejects raw HTML while compatibility .mun.ts remains isolated", () => {
  assert.throws(
    () => compileMunFile("<div>legacy host markup</div>", "Canonical.mun"),
    /Raw HTML is not part of the Mün language/,
  )

  const compatibility = compileMunFile("<div>legacy host markup</div>", "Compatibility.mun.ts")
  assert.match(compatibility.code, /Element\("div"/)
})

test("canonical Mün analysis distinguishes static Views from interactive state and actions", () => {
  const staticView = analyzeMunSource('VStack() { Text("Static") }', "Static.mun")
  assert.deepEqual(staticView, {
    interactive: false,
    usesState: false,
    usesBinding: false,
    usesAction: false,
    usesClientEffect: false,
  })

  const interactiveView = analyzeMunSource(`const count = State(0)
Button(String(count.value)) {
  count.value += 1
}`, "Interactive.mun")
  assert.equal(interactiveView.interactive, true)
  assert.equal(interactiveView.usesState, true)
  assert.equal(interactiveView.usesAction, true)
})

test("binding shorthand uses AST identifiers and preserves host dollar syntax", () => {
  const source = `Toggle(isOn: $wifi)
const attrs = vm.$attrs
const refs = $refs
const token = foo$bar
const text = "$wifi"
const pattern = /\\$wifi/`
  const output = transformMunSource(source, "Binding.mun.ts")
  assert.match(output, /Binding\(wifi\)/)
  assert.doesNotMatch(output, /Binding\(attrs\)/)
  assert.doesNotMatch(output, /Binding\(refs\)/)
  assert.match(output, /vm\.\$attrs/)
  assert.match(output, /foo\$bar/)
  assert.match(output, /"\$wifi"/)
  assert.match(output, /\/\\\$wifi\//)
  assert.equal(ts.createSourceFile("Binding.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("compiler and IDE consumers share one Mun plus TypeScript semantic model", () => {
  const source = `import { Text, VStack } from "@mun/core/compat"
struct Card<Content: View>: View {
  let content: Content
  init(@ViewBuilder content: () => Content) { self.content = content() }
  var body: some View { VStack() { Text("Hello"); content } }
}`
  const model = createMunSemanticModel(source, "Card.mun.ts")
  const card = model.view("Card")
  assert.equal(model.kind, "MunSemanticModel")
  assert.equal(card?.qualifiedName, "Card")
  assert.equal(card?.genericParameters, "Content: View")
  assert.equal(card?.initializers[0]?.signature, "Card(@ViewBuilder content: () => Content)")
  assert.ok(model.calls.some(call => call.callee === "VStack" && call.trailingClosure))
  assert.ok(model.calls.some(call => call.callee === "Text"))
  assert.ok(model.imports.some(item => item.module === "@mun/core/compat"))
  assert.equal(model.typescriptDiagnostics.length, 0)
  assert.equal(typeof model.typeChecker.typeToString(model.typeChecker.getTypeAtLocation(model.typescript.statements[0])), "string")
  assert.equal(model.symbol("Card")?.kind, "view")
  assert.equal(model.symbol("ViewBuilder")?.kind, "builder")
  assert.deepEqual(model.symbol("ViewBuilder")?.operations, ["buildBlock", "buildOptional", "buildEither", "buildArray"])
  assert.equal(model.symbol("Card(@ViewBuilder content: () => Content)")?.kind, "initializer")
  assert.equal(createMunLanguageService().semantic(source, "Card.mun.ts").view("Card")?.name, "Card")
})

test("every known Mun call exposes the shared initializer answer", () => {
  const source = `import { Text, VStack } from "@mun/core/compat"
struct Card: View {
  let title: string
  init(title: string) { self.title = title }
  var body: some View { VStack(spacing: 8) { Text(title) } }
}
const items = [{ id: "a", label: "A" }]
VStack(spacing: 12) { Text("Root") }
ForEach(items, key: item => item.id) { item in Text(item.label) }
Card(title: "Card")`
  const model = createMunSemanticModel(source, "ResolvedCalls.mun.ts")
  const root = model.calls.find(call => call.callee === "VStack" && call.range.start >= source.indexOf("VStack(spacing: 12)"))
  assert.equal(root?.resolution.resolvedViewType?.name, "VStack")
  assert.equal(root?.resolution.resolvedInitializer?.signature, "init(alignment:spacing:content:)")
  assert.deepEqual(root?.resolution.argumentTypes, ["number", "function"])
  assert.deepEqual(root?.resolution.closureRoles, ["value", "viewBuilder"])
  assert.deepEqual(root?.resolution.inferredGenerics, { Content: "View" })
  assert.deepEqual(root?.resolution.diagnostics, [])

  const each = model.calls.find(call => call.callee === "ForEach")
  assert.equal(each?.resolution.resolvedInitializer?.signature, "ForEach(items, key: (item) => string | number, @ViewBuilder content)")
  assert.deepEqual(each?.resolution.closureRoles, ["value", "value", "viewBuilder"])
  assert.deepEqual(each?.resolution.diagnostics, [])

  const card = model.calls.find(call => call.callee === "Card")
  assert.equal(card?.resolution.resolvedViewType?.name, "Card")
  assert.equal(card?.resolution.resolvedInitializer?.signature, "Card(title: string)")
  assert.deepEqual(card?.resolution.argumentTypes, ["string"])
})

test("compiler diagnostics consume shared call resolution without rejecting legacy variadic Views", () => {
  const service = createMunLanguageService()
  assert.deepEqual(service.diagnose("Text(true)"), [{
    severity: "error",
    code: "MUN_INITIALIZER",
    message: "No matching initializer for Text. Available initializers: Text(value).",
    line: 1,
    column: 1,
  }])
  assert.deepEqual(service.diagnose("VStack()"), [])
})

test("semantic model keeps foreign components while compatibility HTML stays outside canonical semantics", () => {
  const source = `import VueChart from "./VueChart.vue"
VueChart(values: values)`
  const model = createMunSemanticModel(source, "Interop.mun.ts")
  assert.equal("htmlElements" in model, false)
  assert.equal("htmlDiagnostics" in model, false)
  assert.deepEqual(model.foreignComponents.map(component => [component.localName, component.module]), [["VueChart", "./VueChart.vue"]])
  assert.equal(model.symbol("VueChart")?.kind, "foreign-component")
  assert.equal(model.symbol("VueChart")?.rendererAdapter, "@mun/vue")
  assert.equal(source.slice(model.foreignComponents[0].range.start, model.foreignComponents[0].range.end), "VueChart(values: values)")
  assert.equal(model.typescriptDiagnostics.length, 0)
})

test("semantic model records React foreign components with the React adapter", () => {
  const source = `import ReactChart from "./ReactChart.tsx"
ReactChart(values: values)`
  const model = createMunSemanticModel(source, "ReactInterop.mun.ts")
  assert.deepEqual(model.foreignComponents.map(component => [component.localName, component.module, component.symbol.rendererAdapter]), [["ReactChart", "./ReactChart.tsx", "@mun/react"]])
  assert.equal(source.slice(model.foreignComponents[0].range.start, model.foreignComponents[0].range.end), "ReactChart(values: values)")
})

test("compatibility HTML lowers to graph Element calls without entering the semantic symbol model", () => {
  const source = `<input type="email" aria-label="Email" />
<x-card data-kind="hero" />`
  const output = transformMunSource(source, "Html.mun.ts")
  assert.match(output, /Element\("input"/)
  assert.match(output, /Element\("x-card"/)
  const model = createMunSemanticModel(source, "Html.mun.ts")
  assert.equal("htmlElements" in model, false)
  assert.equal("htmlDiagnostics" in model, false)
})

test("@mun/compiler preserves empty, optional, and array builder results", () => {
  const source = `VStack() {
  if (showHeader) { Text("Header") }
  if (showEmpty) { }
  [Text("A"), [Text("B")]]
}`
  const output = transformMunSource(source, "Builder.mun.ts")
  assert.match(output, /if \(showHeader\)[\s\S]*__munChildren\.push\(Text\("Header"\)\)/)
  assert.match(output, /if \(showEmpty\)/)
  assert.match(output, /__munChildren\.push\(\[Text\("A"\), \[Text\("B"\)\]\]\)/)
  assert.equal(ts.createSourceFile("Builder.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("@mun/compiler keeps statement-bearing action closures out of ViewBuilder arrays", () => {
  const output = transformMunSource("Button(\"Save\") { const value = 1; save(value) }", "Action.mun.ts")
  assert.match(output, /Button\("Save", \(\) => \{ const value = 1; save\(value\) \}\)/)
  assert.doesNotMatch(output, /overloadClosure\(/)
  assert.doesNotMatch(output, /\[const value/)
  assert.equal(ts.createSourceFile("Action.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("@mun/compiler preserves async action closures", () => {
  const output = transformMunSource("Button(\"Save\") { await save() }", "AsyncAction.mun.ts")
  assert.match(output, /Button\("Save", async \(\) => \{\s*await save\(\)\s*\}\)/)
  assert.doesNotMatch(output, /overloadClosure\(/)
  assert.equal(ts.createSourceFile("AsyncAction.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("the compiler enforces Button's two source forms and declaration order", () => {
  const canonicalAction = transformMunSource('Button("Save") { save() }', "Button.mun.ts")
  assert.match(canonicalAction, /Button\("Save", \(\) => \{ save\(\) \}\)/)
  assert.doesNotMatch(canonicalAction, /overloadClosure\(/)

  const canonicalLabel = transformMunSource('Button(action: { save() }, label: { HStack() { Text("Save") } })', "Button.mun.ts")
  assert.match(canonicalLabel, /Button\(namedArguments\(\{ action: \(\) => \{save\(\)\}, label: \(\) => \[HStack\(/)
  assert.doesNotMatch(canonicalLabel, /overloadClosure\(/)

  const trailingLabel = transformMunSource('Button(action: { save() }) { HStack() { Text("Save") } }', "Button.mun.ts")
  assert.match(trailingLabel, /Button\(namedArguments\(\{ action: \(\) => \{save\(\)\} \}\), \(\) => \[HStack\(/)
  assert.doesNotMatch(trailingLabel, /overloadClosure\(/)

  const service = createMunLanguageService()
  assert.deepEqual(service.diagnose('Button() { save() }'), [{
    severity: "error",
    code: "MUN_INITIALIZER",
    message: 'Button must use either Button("Title") { action } or Button(action: { ... }) { label }.',
    line: 1,
    column: 1,
  }])
  assert.deepEqual(service.diagnose('Button(label: { Text("Save") }, action: { save() })'), [{
    severity: "error",
    code: "MUN_INITIALIZER",
    message: "Button arguments must follow declaration order: action:, label:.",
    line: 1,
    column: 1,
  }])
  assert.deepEqual(service.diagnose('Button(action: { save() }) { Text("Save") }'), [])
})

test("@mun/compiler exposes source-ranged builder and struct ASTs", () => {
  const source = `VStack(spacing: 12) {
  Text("Header")
  if (loading) { ProgressView() } else { ContentView() }
  ForEach(items) { item in Row(item) }
}`
  const ast = parseMunBuilder(source)
  assert.equal(ast.kind, "program")
  assert.equal(ast.statements.length, 1)
  assert.equal(ast.statements[0].kind, "call")
  assert.equal(ast.statements[0].callee, "VStack")
  assert.equal(ast.statements[0].trailing?.parameter, undefined)
  assert.equal(ast.statements[0].trailing?.body.statements[1].kind, "conditional")
  assert.equal(ast.statements[0].trailing?.body.statements[2].kind, "call")
  assert.equal(ast.statements[0].trailing?.body.statements[2].callee, "ForEach")
  const lowered = lowerMunBuilderAst(ast.statements[0].trailing.body, {
    transformRaw: value => value,
    closure: (body, parameter) => `${parameter ? `(${parameter})` : "()"} => [${body.trim()}]`,
  })
  assert.match(lowered.join(", "), /ProgressView\(\)/)
  const structSource = `struct Card<Content: View>: View {
  @State var count: number = 0
  let content: Content
  init(@ViewBuilder content: () => Content) { self.content = content() }
  var body: some View { VStack() { content } }
}`
  const structs = parseMunStructs(structSource)
  assert.equal(structs.length, 1)
  assert.equal(structs[0].genericParameters, "Content: View")
  assert.deepEqual(structs[0].fields.map(field => [field.name, field.kind]), [["count", "state"], ["content", "stored"]])
  assert.equal(structs[0].initializers.length, 1)
  assert.equal(structs[0].range.start, 0)
  assert.ok(structs[0].bodyExpressionRange.start > structs[0].bodyRange.start)
})

test("compiler parsing preserves nested template expressions and comment-separated trailing closures", () => {
  const source = `VStack(
  alignment: /* declaration-owned label */ \`leading-\${theme(\`nested-\${mode}\`)}\`
) /* trailing builder */ {
  Text(\`Hello \${user.name}\`)
  Button("Save") /* trailing action */ {
    save(\`item-\${item.id}\`)
  }
}`
  const ast = parseMunBuilder(source)
  assert.equal(ast.statements.length, 1)
  assert.equal(ast.statements[0].kind, "call")
  assert.equal(ast.statements[0].arguments[0].label, "alignment")
  assert.match(ast.statements[0].arguments[0].value.source, /nested-\$\{mode\}/)
  assert.equal(ast.statements[0].trailing?.body.statements.length, 2)
  const output = transformMunSource(source, "NestedTemplates.mun.ts")
  assert.match(output, /namedArguments\(\{ alignment:/)
  assert.match(output, /nested-\$\{mode\}/)
  assert.match(output, /Button\("Save", \(\) => \{\s*save\(/)
  assert.doesNotMatch(output, /Button\(namedArguments\(\{ action:/)
  assert.equal(ts.createSourceFile("NestedTemplates.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("@mun/compiler exposes source maps, diagnostics, language service, and Vite adapter", () => {
  const result = compileMunFile("Text(\"Hi\")", "/src/Counter.mun.ts")
  assert.equal(result.map.sources[0], "/src/Counter.mun.ts")
  assert.ok(result.map.mappings.length > 0)
  assert.ok(result.map.x_mun.segments.length > 0)
  assert.deepEqual(mapGeneratedPosition(result.map, { line: 1, column: 1 }), { line: 1, column: 1 })
  assert.deepEqual(mapOriginalPosition(result.map, { line: 1, column: 1 }), { line: 1, column: 1 })
  assert.deepEqual(createMunLanguageService().diagnose("VStack() {"), [{ severity: "error", code: "MUN_SYNTAX", message: "Unclosed { block in Mün source", line: 1, column: 10 }])
  assert.equal(createMunVitePlugin().transform("VStack() { Text(\"Hi\") }", "/src/Counter.mun.ts")?.map.version, 3)
  const vitePlugin = munPlugin()
  assert.equal(vitePlugin.name, "mun-compiler")
  const dependencyScan = vitePlugin.config().optimizeDeps.rolldownOptions.plugins[0]
  assert.match(dependencyScan.transform("VStack() { Text(\"Hi\") }", "virtual-module:/src/Counter.vue?id=0")?.code ?? "", /VStack\(\(\) =>/)
})

test("the Vite adapter compiles native .mun modules and resolves their extension", () => {
  const plugin = createMunVitePlugin()
  const transformed = plugin.transform('VStack() { Text("Hi") }', "/src/App.mun")
  assert.ok(transformed)
  assert.match(transformed.code, /VStack\(\(\) =>/)
  assert.deepEqual(plugin.config?.().resolve.extensions.slice(0, 3), [".mun", ".mun.ts", ".mun.tsx"])

  const struct = plugin.transform("export struct Greeting: View { let name: string; init(name: string) { self.name = name }; var body: some View { Text(name) } }", "/src/Greeting.mun")
  assert.ok(struct)
  assert.match(struct.code, /export const Greeting = defineView/)
  assert.doesNotMatch(struct.code, /__munProps:\s*any/)
})

test("the Vite adapter exposes opt-in execution plans for compiler-owned compute regions", () => {
  const plans = []
  const plugin = createMunVitePlugin({
    sourceMap: false,
    onExecutionPlan: (plan, id) => plans.push({ plan, id }),
  })
  const source = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const scale = 2
const items = State([{ id: 1, value: 2 }])
items.value = items.value.map(item => ({ ...item, value: item.value * scale }))
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => ForEach(items.value, item => item.id, item => Element("span", { title: item.value }, item.value)) })`
  const transformed = plugin.transform(source, "/src/ExecutionPlan.mun.ts")
  assert.ok(transformed)
  assert.equal(plans.length, 1)
  assert.equal(plans[0].id, "/src/ExecutionPlan.mun.ts")
  assert.deepEqual(plans[0].plan.regions.map(region => region.kind).sort(), ["collection-row", "state-array-map"])
  assert.equal(plans[0].plan.summary.residentRegions, 0)
  assert.equal(plans[0].plan.summary.packedJsCandidates, 0)
  assert.equal(plans[0].plan.summary.wasmCandidates, 0)
  assert.equal(plans[0].plan.summary.workerCandidates, 0)
  assert.equal(plans[0].plan.summary.webgpuCandidates, 0)
  assert.equal(plans[0].plan.summary.gpuBlockedByCpuSink, 2)
  assert.deepEqual(plans[0].plan.residentRegions, [])
  const stateRegion = plans[0].plan.regions.find(region => region.kind === "state-array-map")
  assert.deepEqual(stateRegion.effects.captures, ["scale"])
  assert.deepEqual(stateRegion.residency, { input: "js-object", output: "cpu-state", gpuResident: false, webgpuReadbackRequired: true })
  assert.equal(stateRegion.kernels.length, 1)
  assert.equal(stateRegion.kernels[0].kind, "map")
  assert.deepEqual(stateRegion.kernels[0].captures, ["scale"])
  assert.equal(stateRegion.kernels[0].outputs[0].value.op, "binary")
  assert.equal(stateRegion.resident, null)
  assert.equal(stateRegion.backends.find(backend => backend.backend === "packed-js")?.status, "blocked")
  assert.match(stateRegion.backends.find(backend => backend.backend === "packed-js")?.reason ?? "", /object-backed State/)
  assert.equal(stateRegion.backends.find(backend => backend.backend === "wasm")?.status, "blocked")
  assert.equal(stateRegion.backends.find(backend => backend.backend === "webgpu")?.status, "blocked")
  const collectionRegion = plans[0].plan.regions.find(region => region.kind === "collection-row")
  assert.equal(collectionRegion.sink, "dom")
  assert.equal(collectionRegion.residency.output, "dom-patch")
  assert.equal(collectionRegion.kernels.length, 3)
  assert.equal(collectionRegion.resident, null)
  assert.equal(collectionRegion.backends.find(backend => backend.backend === "wasm")?.status, "blocked")
  assert.match(collectionRegion.backends.find(backend => backend.backend === "wasm")?.reason ?? "", /DOM sink/)
})

test("execution planning does not claim WASM portability without complete Kernel IR", () => {
  const plans = []
  const plugin = createMunVitePlugin({ sourceMap: false, onExecutionPlan: plan => plans.push(plan) })
  const source = `import { State } from "@mun/core/compat"
const items = State([{ id: 1, value: "A" }])
items.value = items.value.map((item, index) => ({ ...item, value: \`next-\${index}\` }))`
  const transformed = plugin.transform(source, "/src/StringExecutionPlan.mun.ts")
  assert.ok(transformed)
  const region = plans[0].regions.find(candidate => candidate.kind === "state-array-map")
  assert.ok(region)
  assert.equal(region.effects.pure, true)
  assert.equal(region.kernels.length, 0)
  assert.equal(region.backends.find(backend => backend.backend === "wasm")?.status, "blocked")
  assert.match(region.backends.find(backend => backend.backend === "wasm")?.reason ?? "", /Kernel IR/)
})

test("compiler source maps keep real tokens anchored after synthesized imports", () => {
  const result = compileMunFile('VStack() {\n  Text("Hi")\n}', "Counter.mun.ts")
  const generatedLine = result.code.split("\n").findIndex(line => line.includes("Text")) + 1
  const generatedColumn = result.code.split("\n")[generatedLine - 1].indexOf("Text") + 1
  assert.deepEqual(mapGeneratedPosition(result.map, { line: generatedLine, column: generatedColumn }), { line: 2, column: 3 })
  assert.deepEqual(mapOriginalPosition(result.map, { line: 2, column: 3 }), { line: generatedLine, column: generatedColumn })
})

test("the Vite adapter caches unchanged modules and leaves CSS to Vite", () => {
  const plugin = createMunVitePlugin()
  const source = "VStack() { Text(\"Hi\") }"
  const first = plugin.transform(source, "/src/Counter.mun.ts")
  const second = plugin.transform(source, "/src/Counter.mun.ts?import")
  assert.equal(first, second)
  assert.equal(plugin.transform(".card { color: red }", "/src/style.css"), null)
  assert.equal(plugin.transform("function ordinary() { return 1 }", "/src/node_modules/dependency/index.js"), null)
  assert.equal(plugin.transform('const value = Text("Hi").padding(4)', "/workspace/packages/core/dist/advanced.js"), null)
  assert.equal(plugin.transform("function ordinary() { return 1 }", "/src/ordinary.ts"), null)
  assert.equal(plugin.transform("const pattern = /^[$A-Z_]/", "/src/ordinary.js"), null)
  assert.equal(plugin.transform('const App = () => <div className="card" />', "/src/App.tsx"), null)
  const staticModifier = plugin.transform('import { Text } from "@mun/core/compat"\nconst value = Text("Hi").padding(4)', new URL("../StaticModifier.ts", import.meta.url).pathname)
  assert.ok(staticModifier)
  assert.match(staticModifier.code, /modifiedContentCompiled\(/)
  const scoped = createMunVitePlugin({ include: /Counter\.mun\.ts/g })
  assert.ok(scoped.transform(source, "/src/Counter.mun.ts"))
  assert.ok(scoped.transform(source, "/src/Counter.mun.ts"))
  assert.equal(scoped.transform(source, "/src/Other.mun.ts"), null)
})

test("named-argument lowering scans maximal calls once and lowers nested arguments", () => {
  const output = transformMunSource("Outer(value: Inner(label: 1))", "NestedNamed.mun.ts")
  assert.match(output, /Outer\(namedArguments\(\{ value: Inner\(namedArguments\(\{ label: 1 \}\)\) \}\)\)/)
  assert.equal(ts.createSourceFile("NestedNamed.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("the Vite adapter skips detailed source-map tokenization when disabled", () => {
  const plugin = createMunVitePlugin({ sourceMap: false })
  const result = plugin.transform("VStack() { Text(\"Hi\") }", "/src/NoMap.mun.ts")
  assert.ok(result)
  assert.equal(result.map.mappings, "")
  assert.deepEqual(result.map.x_mun?.segments, [])
})

test("the Vite adapter lowers Mun only inside Vue SFC script blocks", () => {
  const plugin = createMunVitePlugin()
  const sfc = `<template><VStack /></template>
<script setup lang="ts">
VStack() { Text("Hello from Mun") }
</script>`
  const transformed = plugin.transform(sfc, "/src/Counter.vue")
  assert.ok(transformed)
  assert.match(transformed.code, /<template><VStack \/><\/template>/)
  assert.match(transformed.code, /VStack\(\(\) =>/)
  assert.equal(plugin.transform("<template><VStack /></template>", "/src/Counter.vue?vue&type=template"), null)
  assert.equal(plugin.transform(".card { color: red }", "/src/Counter.vue?vue&type=style&index=0&lang.css"), null)
  const script = plugin.transform('VStack() { Text("Query script") }', "/src/Counter.vue?vue&type=script&setup=true&lang.ts")
  assert.ok(script)
  assert.match(script.code, /VStack\(\(\) =>/)
  assert.equal(plugin.transform(`import { defineComponent as _defineComponent } from "vue"
import { openBlock as _openBlock, createBlock as _createBlock } from "vue"
export default _defineComponent({ setup(__props, { expose }) {
  expose()
  return (_ctx: any, _cache: any) => (_openBlock(), _createBlock("div"))
} })`, "/src/Counter.vue?vue&type=script&setup=true&lang.ts"), null)
  const virtualScript = plugin.transform('const graph = () => VStack() { Text("Virtual script") }', "/src/Counter.vue?id=virtual")
  assert.ok(virtualScript)
  assert.match(virtualScript.code, /VStack\(\(\) =>/)
})

test("Vue component adapters use the generic labeled-argument compiler path", () => {
  const source = `const MyVueComponent = vueComponent(Badge)
MyVueComponent(value: data)`
  const output = transformMunSource(source, "VueInterop.mun.ts")
  assert.match(output, /MyVueComponent\(namedArguments\(\{ value: data \}\)\)/)
  assert.doesNotMatch(output, /VueComponent.*hack/i)
  assert.equal(ts.createSourceFile("VueInterop.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("Vue SFC default imports become transparent Mün Views", () => {
  const output = transformMunSource(`import VueChart from "./VueChart.vue"
VueChart(values: values)`, "VueChart.mun.ts")
  assert.match(output, /import \{ foreignComponent as __munForeignComponent \} from "@mun\/vue"/)
  assert.match(output, /const VueChart = __munForeignComponent\(__munForeignComponent0\)/)
  assert.match(output, /VueChart\(namedArguments\(\{ values: values \}\)\)/)
  assert.equal(ts.createSourceFile("VueChart.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("Vue foreign wrapping follows TypeScript import nodes, not import-line matching", () => {
  const source = `// import Ignored from "./Ignored.vue"
import /* keep the module AST-bound */ Chart from "./Chart.vue";
Chart(values: values)`
  const output = transformMunSource(source, "AstVueImport.mun.ts")
  assert.match(output, /const Chart = __munForeignComponent\(__munForeignComponent0\)/)
  assert.doesNotMatch(output, /const Ignored\s*=/)
  assert.match(output, /Chart\(namedArguments\(\{ values: values \}\)\)/)
  assert.equal(ts.createSourceFile("AstVueImport.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("React TSX and JSX default imports become transparent Mün Views", () => {
  const output = transformMunSource(`import ReactChart from "./ReactChart.tsx"
ReactChart(values: values)`, "ReactChart.mun.ts")
  assert.match(output, /import \{ reactComponent as __munReactComponent \} from "@mun\/react"/)
  assert.match(output, /const ReactChart = __munReactComponent\(__munReactComponent0\)/)
  assert.match(output, /ReactChart\(namedArguments\(\{ values: values \}\)\)/)
  assert.equal(ts.createSourceFile("ReactChart.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("the canonical compiler preserves host stylesheet imports", () => {
  const source = `import styles from "./Card.module.css"
import "./tokens.scss"
import { Text } from "@mun/core/compat"
Text("Card").className(styles.card)`
  const output = transformMunSource(source, "Card.mun.ts")
  assert.match(output, /import styles from "\.\/Card\.module\.css"/)
  assert.match(output, /import "\.\/tokens\.scss"/)
  assert.match(output, /modifiedContentCompiled\(/)
  assert.match(output, /styles\.card/)
})

test("compiler diagnostics retain the original offset for raw HTML and delimiters", () => {
  const htmlDiagnostic = createMunLanguageService().diagnose("VStack() {\n  <section>\n")
  assert.deepEqual(htmlDiagnostic, [{ severity: "error", code: "MUN_SYNTAX", message: "Unclosed raw HTML element in Mün source", line: 2, column: 3 }])
  const delimiterDiagnostic = createMunLanguageService().diagnose("  VStack() {")
  assert.deepEqual(delimiterDiagnostic, [{ severity: "error", code: "MUN_SYNTAX", message: "Unclosed { block in Mün source", line: 1, column: 12 }])
  const templateDiagnostic = createMunLanguageService().diagnose("Text(\n  `value \${format(`nested`)}`\n")
  assert.deepEqual(templateDiagnostic, [{ severity: "error", code: "MUN_SYNTAX", message: "Unclosed ( block in Mün source", line: 1, column: 5 }])
  const commentDiagnostic = createMunLanguageService().diagnose("Text(\"ok\")\n/* unfinished")
  assert.deepEqual(commentDiagnostic, [{ severity: "error", code: "MUN_SYNTAX", message: "Unclosed block comment in Mün source", line: 2, column: 1 }])
  assert.deepEqual(createMunLanguageService().diagnose("<section><span></section>"), [{ severity: "error", code: "MUN_SYNTAX", message: "Mismatched raw HTML closing tag </section>; expected </span>", line: 1, column: 16 }])
  assert.deepEqual(createMunLanguageService().diagnose("const value = )"), [{ severity: "error", code: "MUN_TYPESCRIPT", message: "Expression expected.", line: 1, column: 15 }])
})

test("builder scanning ignores regex literals in TypeScript expressions", () => {
  const source = `VStack() { Text(/[{}]/.test(value) ? "yes" : "no") }`
  const output = transformMunSource(source, "RegexExpression.mun.ts")
  assert.match(output, /Text\(\/\[\{\}\]\/\.test\(value\) \? "yes" : "no"\)/)
  assert.equal(ts.createSourceFile("RegexExpression.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("the checked-in .mun.ts example passes through the compiler pipeline", () => {
  const source = readFileSync(new URL("../examples/Counter.mun.ts", import.meta.url), "utf8")
  const output = transformMunSource(source, "Counter.mun.ts")
  assert.doesNotMatch(output, /VStack\([^\n]*\)\s*\{/)
  assert.match(output, /const __munTemplate0 = defineCompiledTemplate\(/)
  assert.match(output, /"gap": "12px"/)
  assert.match(output, /compiledTemplate\(__munTemplate0, \[`Count: \${count\.value}`, Button\.viewType\.createNodeCompiled/)
  assert.doesNotMatch(output, /namedArguments\(/)
  assert.match(output, /from "@mun\/react"/)
  assert.match(output, /view\(\{ state: \(\) => \{ const count = State\(0\)/)
  assert.doesNotMatch(output, /^const count = State/m)
  assert.equal(ts.createSourceFile("Counter.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("custom generic View structs lower to declaration-defined initializer metadata", () => {
  const source = `import { VStack } from "@mun/react"\nstruct Card<Content: View>: View {\n  let content: Content\n  init(@ViewBuilder content: () => Content) { self.content = content() }\n  var body: some View { VStack() { content } }\n}`
  const output = transformMunSource(source, "Card.mun.ts")
  assert.match(output, /defineView\("Card"/)
  assert.match(output, /genericParameters: "Content: View"/)
  assert.match(output, /fields: \[\{ name: "content", kind: "stored"/)
  assert.match(output, /Card\(@ViewBuilder content\)/)
  assert.match(output, /resolveBuilderInput\(content\)/)
  assert.match(output, /from "@mun\/react"/)
  assert.equal(ts.createSourceFile("Card.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("compiler specializes unambiguous same-file struct calls from initializer declarations", () => {
  const source = `struct Card: View {
  let title: string
  init(title: string) { self.title = title }
  var body: some View { Text(title) }
}
const card = Card(title: "Hello")`
  const output = transformMunSource(source, "SpecializedCard.mun.ts")
  assert.match(output, /Card\.viewType\.createNodeCompiled\(0, \["Hello"\]\)/)
  assert.doesNotMatch(output, /namedArguments\(/)
  assert.doesNotMatch(output, /const card = Card\(/)
  assert.equal(ts.createSourceFile("SpecializedCard.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("compiler specializes imported Views from a unique typed call signature", () => {
  const source = `import { Text } from "@mun/core/compat"
const value = Text("Hello")`
  const output = transformMunSource(source, "ImportedText.mun.ts")
  assert.match(output, /defineCompiledTemplate\(\{ kind: "element", type: "span", props: null, children: \["Hello"\] \}, 0, \[\]\)/)
  assert.match(output, /const value = compiledTemplate\(__munTemplate0, \[\]\)/)
  assert.doesNotMatch(output, /Text\(\"Hello\"\)/)
  assert.equal(ts.createSourceFile("ImportedText.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
  const generated = output.replace(/^import [^\n]+\n/, "")
  const value = Function("compiledTemplate", "defineCompiledTemplate", `${generated}; return value`)(compiledTemplate, defineCompiledTemplate)
  assert.equal(value.kind, "template")
  assert.equal(value.template.root.type, "span")
})

test("compiler precomputes static expression results before runtime", () => {
  const source = `import { Text, VStack } from "@mun/core/compat"
export function App() {
  return VStack(spacing: 2 * (3 + 1)) {
    Text(\`Total: \${1 + 2}\`)
    Text(true ? "ready" : expensive())
  }
}`
  const output = transformMunSource(source, "StaticResults.mun.ts")
  assert.doesNotMatch(output, /2 \* \(3 \+ 1\)|1 \+ 2|expensive/)
  assert.match(output, /defineCompiledTemplate\(\{ kind: "element", type: "div"/)
  assert.match(output, /"gap": "8px"/)
  assert.match(output, /children: \[\{ kind: "element", type: "span", props: null, children: \["Total: 3"\] \}, \{ kind: "element", type: "span", props: null, children: \["ready"\] \}\]/)
  assert.match(output, /return compiledTemplate\(__munTemplate0, \[\]\)/)
  assert.equal(ts.createSourceFile("StaticResults.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("compiler normalizes proven Swift-style labels into the compiled runtime payload", () => {
  const source = `import { Text, VStack } from "@mun/core/compat"
const value = VStack(spacing: 12) { Text("Hello") }`
  const output = transformMunSource(source, "NamedCompiledStack.mun.ts")
  assert.match(output, /defineCompiledTemplate\(/)
  assert.match(output, /"gap": "12px"/)
  assert.doesNotMatch(output, /namedArguments\(/)
  const generated = output.replace(/^import [^\n]+\n/, "")
  const value = Function("Text", "VStack", "compiledTemplate", "defineCompiledTemplate", `${generated}; return value`)(Text, VStack, compiledTemplate, defineCompiledTemplate)
  assert.equal(value.template.root.props.style.gap, "12px")
  assert.equal(value.template.root.children[0].children[0], "Hello")
})

test("compiler lowers immutable host structure into a compiled template with dynamic slots", () => {
  const source = `import { Text, VStack } from "@mun/core/compat"
export function App(name: string) { return VStack() { Text("Static"); Text(name) } }`
  const output = transformMunSource(source, "StaticHoist.mun.ts")
  assert.match(output, /const __munTemplate0 = defineCompiledTemplate\(/)
  assert.match(output, /children: \["Static"\]/)
  assert.match(output, /kind: "slot", index: 0, identity: \["element", 1, "element", 0\]/)
  assert.match(output, /return compiledTemplate\(__munTemplate0, \[name\]\)/)
  assert.doesNotMatch(output, /createNode(?:Compiled|Specialized)\([^\n]*name/)
  assert.equal(ts.createSourceFile("StaticHoist.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("compiler keeps opaque custom View children as identity-preserving template slots", () => {
  const source = `import { Text, VStack } from "@mun/core/compat"
struct Card: View {
  let title: string
  var body: some View { Text(title) }
}
export function App(title: string) { return VStack() { Card(title: title) } }`
  const output = transformMunSource(source, "TemplateCustomChild.mun.ts")
  assert.match(output, /const __munTemplate0 = defineCompiledTemplate\(/)
  assert.match(output, /kind: "slot", index: 0, identity: \["element", 0\]/)
  assert.match(output, /compiledTemplate\(__munTemplate0, \[Card\.viewType\.createNodeCompiled\(0, \[title\]\)\]\)/)
  assert.equal(ts.createSourceFile("TemplateCustomChild.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("compiler emits State dependency metadata and templates dynamic primitive content", () => {
  const source = `import { Text } from "@mun/core/compat"
struct Counter: View {
  @State var count: number = 0
  var body: some View { Text(String(count.value)) }
}`
  const output = transformMunSource(source, "StaticDependencies.mun.ts")
  assert.match(output, /dependencies: \(props: any\) => \[props\.count\], dependenciesComplete: true/)
  assert.match(output, /const __munTemplate0 = defineCompiledTemplate\(/)
  assert.match(output, /defineCompiledTemplate\([^\n]+, 1, \["text"\], \[\{ node: 1, kind: "text" \}\]\)/)
  assert.match(output, /compiledBody: \{ template: __munTemplate0, .*evaluate:/)
  assert.match(output, /slots: \[String\(count\.value\)\]/)
  assert.doesNotMatch(output, /new Uint32Array/)
  assert.match(output, /compiledTemplate\(__munTemplate0, \[String\(count\.value\)\]\)/)
  assert.equal(ts.createSourceFile("StaticDependencies.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("compiler plans direct modifier patches for exhaustive State-backed struct Views", () => {
  const source = `import { Text, State } from "@mun/core/compat"
struct Counter: View {
  @State var count: number = 0
  var body: some View { Text(String(count.value)).opacity(count.value > 0 ? 1 : 0.25).className(count.value > 1 ? "hot" : "cold") }
}`
  const output = transformMunSource(source, "CompiledModifierPlan.mun.ts")
  assert.match(output, /dependenciesComplete: true/)
  assert.match(output, /compiledBody: \{ template: __munTemplate0, patchesModifiers: true, evaluate:/)
  assert.match(output, /modifiers: \[\["opacity", \[count\.value > 0 \? 1 : 0\.25\]\], \["className", \[count\.value > 1 \? "hot" : "cold"\]\]\]/)
  assert.equal(ts.createSourceFile("CompiledModifierPlan.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("compiler emits property-aware automatic motion plans for bare .animation()", () => {
  const source = `import { Text } from "@mun/core/compat"
export function Demo(active: boolean) {
  return Text("A")
    .opacity(active ? 1 : 0)
    .scaleEffect(active ? 1 : 0.9)
    .style({ backgroundColor: active ? "white" : "black" })
    .animation()
}`
  const output = transformMunSource(source, "AutomaticMotion.mun.ts")
  assert.match(output, /\["animationAuto", \[137\]\]/)
  assert.doesNotMatch(output, /\["animation", \[null, undefined\]\]/)
  assert.equal(ts.createSourceFile("AutomaticMotion.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("compiler narrows frame motion masks and preserves custom-property fallback", () => {
  const source = `import { Text } from "@mun/core/compat"
export function Demo(active: boolean) {
  return Text("A")
    .frame({ width: active ? 240 : 180 })
    .style({ "--progress": active ? 1 : 0 })
    .animation()
}`
  const output = transformMunSource(source, "NarrowAutomaticMotion.mun.ts")
  assert.match(output, /\["animationAuto", \[512, \["--progress"\]\]\]/)
  assert.doesNotMatch(output, /height|min-width|max-width|min-height|max-height/)
  assert.equal(ts.createSourceFile("NarrowAutomaticMotion.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("compiler keeps independent animation domains inside direct compiled modifier plans", () => {
  const source = `import { Animation, Text, State } from "@mun/core/compat"
struct Counter: View {
  @State var count: number = 0
  var body: some View {
    Text(String(count.value))
      .opacity(count.value > 0 ? 1 : 0.2)
      .animation(Animation.linear(0.18), count.value > 0)
      .scaleEffect(count.value > 2 ? 1.4 : 1)
      .animation(Animation.spring(0.3, 0.8), count.value > 2)
  }
}`
  const output = transformMunSource(source, "CompiledIndependentMotion.mun.ts")
  assert.match(output, /dependenciesComplete: true/)
  assert.match(output, /compiledBody: \{ template: __munTemplate0, patchesModifiers: true, evaluate:/)
  assert.match(output, /\["opacity", \[count\.value > 0 \? 1 : 0\.2\]\]/)
  assert.match(output, /\["animation", \[[^\]]+, count\.value > 0\]\]/)
  assert.match(output, /\["scaleEffect", \[count\.value > 2 \? 1\.4 : 1\]\]/)
  assert.match(output, /\["animation", \[[^\]]+, count\.value > 2\]\]/)
  assert.equal(ts.createSourceFile("CompiledIndependentMotion.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("compiler emits a direct compiled body plan for exhaustive State-backed template Views", () => {
  const source = `import { Text, State, view } from "@mun/core/compat"
const count = State(0)
export const App = view(() => Text(String(count.value)))`
  const output = transformMunSource(source, "CompiledBodyPlan.mun.ts")
  assert.match(output, /dependenciesComplete: true/)
  assert.match(output, /compiledBody: \{ template: __munTemplate0, evaluate: \(\{ count \}\) =>/)
  assert.match(output, /slots: \[String\(count\.value\)\]/)
  assert.doesNotMatch(output, /new Uint32Array/)
  assert.match(output, /body: \(\{ count \}\) => \(\(\(\) => compiledTemplate\(__munTemplate0, \[String\(count\.value\)\]\)\)\(\)\)/)
  assert.equal(ts.createSourceFile("CompiledBodyPlan.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("compiler maps independent State dependencies to sparse compiled text patches", () => {
  const source = `import { Text, VStack, State } from "@mun/core/compat"
struct Pair: View {
  @State var left: number = 0
  @State var right: number = 0
  var body: some View { VStack() { Text(String(left.value)); Text(String(right.value)) } }
}`
  const output = transformMunSource(source, "SparseCompiledPatch.mun.ts")
  assert.match(output, /patchDependencyIndices: \{ "left": \[0\], "right": \[1\] \}/)
  assert.match(output, /evaluatePatch:/)
  assert.match(output, /& 1\) !== 0[^;]+String\(left\.value\)/)
  assert.match(output, /& 2\) !== 0[^;]+String\(right\.value\)/)
  assert.equal(ts.createSourceFile("SparseCompiledPatch.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("compiler keeps struct dependency discovery dynamic when body reads external State", () => {
  const source = `import { Text, State } from "@mun/core/compat"
const external = State(1)
struct Counter: View {
  @State var count: number = 0
  var body: some View { Text(String(count.value + external.value)) }
}`
  const output = transformMunSource(source, "ExternalStateDependencies.mun.ts")
  assert.match(output, /dependencies: \(props: any\) => \[props\.count\]/)
  assert.doesNotMatch(output, /dependenciesComplete: true/)
  assert.doesNotMatch(output, /compiledBody:/)
  assert.match(output, /compiledTemplate\(__munTemplate0, \[String\(count\.value \+ external\.value\)\]\)/)
})

test("compiler emits reusable zero-slot host templates under dynamic modifiers", () => {
  const source = `import { Text } from "@mun/core/compat"
export function App(active: boolean) {
  return Text("Static").opacity(active ? 1 : 0.25)
}`
  const output = transformMunSource(source, "StaticModifierTemplate.mun.ts")
  assert.match(output, /defineCompiledTemplate\(\{ kind: "element", type: "span", props: null, children: \["Static"\] \}, 0, \[\]\)/)
  assert.match(output, /modifiedContentCompiled\(compiledTemplate\(__munTemplate0, \[\]\), \[\["opacity", \[active \? 1 : 0\.25\]\]\]\)/)
  assert.doesNotMatch(output, /const __munStatic/)
  assert.equal(ts.createSourceFile("StaticModifierTemplate.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("compiler hoists and deduplicates immutable Animation plans out of render paths", () => {
  const source = `import { Animation, Text } from "@mun/core/compat"
export function App(active: boolean) {
  const first = Text("A").opacity(active ? 1 : 0.5).animation(Animation.easeInOut(0.2).delay(0.05), active)
  const second = Text("B").opacity(active ? 0.8 : 0.2).animation(Animation.easeInOut(0.2).delay(0.05), active)
  return [first, second]
}`
  const output = transformMunSource(source, "MotionHoist.mun.ts")
  assert.match(output, /const __munMotion0 = Animation\.easeInOut\(0\.2\)\.delay\(0\.05\)/)
  assert.equal((output.match(/const __munMotion/g) ?? []).length, 1)
  assert.equal((output.match(/\[__munMotion0, active\]/g) ?? []).length, 2)
  assert.equal(ts.createSourceFile("MotionHoist.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("compiler specializes a resolved imported ViewBuilder overload by declaration order", () => {
  const source = `import { Text, VStack } from "@mun/core/compat"
const value = VStack() { Text("Hello") }`
  const output = transformMunSource(source, "ImportedVStack.mun.ts")
  assert.match(output, /defineCompiledTemplate\(\{ kind: "element", type: "div"/)
  assert.match(output, /children: \[\{ kind: "element", type: "span", props: null, children: \["Hello"\] \}\]/)
  assert.match(output, /const value = compiledTemplate\(__munTemplate0, \[\]\)/)
  assert.doesNotMatch(output, /createNode(?:Compiled|Specialized)/)
})

test("compiler lowers a statically typed modifier chain into one flat graph construction", () => {
  const source = `import { Text } from "@mun/core/compat"
const value = Text("Hello").padding(8).background("red").bold()`
  const output = transformMunSource(source, "StaticModifiers.mun.ts")
  assert.match(output, /modifiedContentCompiled\(compiledTemplate\(__munTemplate0, \[\]\), \[\["padding", \[8\]\], \["background", \["red"\]\], \["bold", \[\]\]\]\)/)
  assert.match(output, /defineCompiledTemplate\(\{ kind: "element", type: "span", props: null, children: \["Hello"\] \}, 0, \[\]\)/)
  assert.doesNotMatch(output, /\.padding\(|\.background\(|\.bold\(/)
  assert.equal(ts.createSourceFile("StaticModifiers.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
  const generated = output.replace(/^import [^\n]+\n/gm, "")
  const value = Function("modifiedContentCompiled", "compiledTemplate", "defineCompiledTemplate", `${generated}; return value`)(modifiedContentCompiled, compiledTemplate, defineCompiledTemplate)
  assert.deepEqual(modifierGraphOf(value).map(item => [item.name, item.arguments]), [["padding", [8]], ["background", ["red"]], ["bold", []]])
})

test("compiler preserves dynamic and non-View modifier methods", () => {
  const source = `declare const unknownValue: unknown
const dynamic = (unknownValue as any).padding(8)
const ordinary = { padding(value: number) { return value } }.padding(8)`
  const output = transformMunSource(source, "DynamicModifiers.mun.ts")
  assert.doesNotMatch(output, /modifiedContent(?:Compiled)?\(/)
  assert.match(output, /unknownValue as any\)\.padding\(8\)/)
  assert.match(output, /const ordinary = .*\.padding\(8\)/)
})

test("compiler keeps unresolved declaration calls on the dynamic resolver", () => {
  const source = `struct Card: View {
  let value: any
  init(_ value: string) { self.value = value }
  init(_ value: number) { self.value = value }
  var body: some View { Text(String(value)) }
}
const card = Card(valueFromRuntime)`
  const output = transformMunSource(source, "DynamicCard.mun.ts")
  assert.match(output, /const card = Card\(valueFromRuntime\)/)
  assert.doesNotMatch(output, /createNode(?:Compiled|Specialized)/)
})

test("compiler rejects ambiguous statically typed declaration overloads", () => {
  const source = `struct Card: View {
  let value: string
  init(_ value: string) { self.value = value }
  init(_ value: string) { self.value = value }
  var body: some View { Text(value) }
}
const card = Card("runtime")`
  assert.throws(
    () => transformMunSource(source, "AmbiguousCard.mun.ts"),
    error => error?.code === "MUN_INITIALIZER" && /Ambiguous initializer for Card/.test(error.message),
  )
})

test("compiled generic ViewBuilder initializers enforce View results", () => {
  const source = `import { Text, VStack } from "@mun/core/compat"
struct GenericBox<Content: View>: View {
  let content: Content
  init(@ViewBuilder content: () => Content) { self.content = content() }
  var body: some View { VStack() { content } }
}`
  const generated = transformMunSource(source, "GenericBox.mun.ts")
    .replace(/^import [^\n]+\n/, "")
    .replace(/: any\b/g, "")
  const GenericBox = Function(
    "defineView",
    "initializer",
    "resolveBuilderClosure",
    "resolveBuilderInput",
    "overloadClosure",
    "compiledTemplate",
    "defineCompiledTemplate",
    "Text",
    "VStack",
    `${generated}; return GenericBox`,
  )(defineView, initializer, resolveBuilderClosure, resolveBuilderInput, overloadClosure, compiledTemplate, defineCompiledTemplate, Text, VStack)
  assert.doesNotThrow(() => GenericBox(() => Text("valid")))
  assert.throws(() => GenericBox(() => "not a View"), /No matching initializer for GenericBox/)
})

test("compiled structs resolve unlabeled values, labeled actions, and trailing builders through metadata", () => {
  const source = `struct MixedCard<Content: View>: View {
  let title: string
  let action: () => void
  let content: Content
  init(_ title: string, @Action action: () => void, @ViewBuilder content: () => Content) {
    self.title = title
    self.action = action
    self.content = content()
  }
  var body: some View { VStack() { Text(title); content } }
}
const card = MixedCard("Title", action: { save() }) { Text("Body") }`
  const output = transformMunSource(source, "MixedCard.mun.ts")
  assert.match(output, /MixedCard\.viewType\.createNodeCompiled\(0, \["Title", \(\) => \{save\(\)\}, \[Text\("Body"\)\]\]\)/)
  assert.doesNotMatch(output, /namedArguments\(/)
  assert.doesNotMatch(output, /overloadClosure\(/)
  assert.equal(ts.createSourceFile("MixedCard.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
  const generated = output.replace(/^import [^\n]+\n/, "").replace(/: any\b/g, "")
  let saves = 0
  const card = Function(
    "defineView",
    "initializer",
    "resolveBuilderClosure",
    "resolveBuilderInput",
    "namedArguments",
    "overloadClosure",
    "Text",
    "VStack",
    "save",
    `${generated}; return card`,
  )(defineView, initializer, resolveBuilderClosure, resolveBuilderInput, namedArguments, overloadClosure, Text, VStack, () => { saves += 1 })
  const rendered = renderViewNode(card, {
    element(type, props, ...children) { return { type, props, children } },
    fragment(children) { return { children } },
    value(value) { return value },
    modifier(content) { return content },
  })
  assert.deepEqual(rendered.children.map(child => child.children[0]), ["Title", "Body"])
  assert.equal(saves, 0)
})

test("custom View trailing roles and invalid initializer shapes use compiler metadata", () => {
  const valid = `struct ActionCard: View {
  let action: () => void
  init(@Action action: () => void) { self.action = action }
  var body: some View { Text("Action") }
}
const card = ActionCard() { save() }`
  const output = transformMunSource(valid, "ActionCard.mun.ts")
  assert.doesNotMatch(output, /overloadClosure\(/)
  assert.match(output, /ActionCard\.viewType\.createNodeCompiled\(0, \[\(\) => \{ save\(\) \}\]\)/)

  const invalid = `struct LabelCard: View {
  let label: any
  init(@ViewBuilder label: () => View) { self.label = label() }
  var body: some View { Text("Label") }
}
const card = LabelCard(action: { save() }) { Text("Label") }`
  assert.throws(
    () => transformMunSource(invalid, "InvalidLabelCard.mun.ts"),
    error => error?.code === "MUN_INITIALIZER" && /No matching initializer for LabelCard/.test(error.message),
  )
})

test("struct AST keeps stored fields declared after an initializer and ignores initializer locals", () => {
  const source = `struct FieldOrder: View {
  init(title: string) { let local = title; const text = "init(fake)"; /* init(comment) */ self.title = title }
  let title: string
  @State var count: number = 0
  let suffix = "!"
  var body: some View { Text(title + suffix + String(count.value)) }
}`
  const declaration = parseMunStructs(source)[0]
  assert.deepEqual(declaration.fields.map(field => [field.name, field.kind]), [
    ["title", "stored"],
    ["count", "state"],
    ["suffix", "stored"],
  ])
  const output = transformMunSource(source, "FieldOrder.mun.ts")
  assert.match(output, /fields: \[\{ name: "title"/)
  assert.match(output, /name: "suffix", kind: "stored"/)
  assert.doesNotMatch(output, /name: "local"/)
})

test("struct fields may safely be named props", () => {
  const source = `struct LegacyHost: View {
  let props: { title: string }
  init(_ props: { title: string }) { self.props = props }
  var body: some View { Text(props.title) }
}`
  const output = transformMunSource(source, "LegacyHost.mun.ts")
  assert.match(output, /body: \(__munProps: any\) => \{ const \{ props \} = __munProps;/)
  assert.equal(ts.createSourceFile("LegacyHost.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("nested View structs keep the outer body and local View scope", () => {
  const source = `struct Parent: View {
  struct Header: View {
    var body: some View { Text("Header") }
  }
  var body: some View { VStack() { Header() } }
}`
  const declarations = parseMunStructs(source)
  assert.equal(declarations.length, 1)
  assert.deepEqual(declarations[0].nested?.map(item => item.name), ["Header"])
  assert.match(declarations[0].bodyExpressionSource, /VStack\(\) \{ Header\(\) \}/)
  const output = transformMunSource(source, "Parent.mun.ts")
  assert.match(output, /const Parent = \(\(\) => \{ const Header = defineView\("Header"/)
  assert.match(output, /return Object\.assign\(defineView\("Parent"/)
  assert.match(output, /\{ Header \}/)
  assert.doesNotMatch(output, /\bstruct\b/)
  assert.equal(ts.createSourceFile("Parent.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("nested View structs expose qualified constructors as well as local body names", () => {
  const source = `import { Text, VStack } from "@mun/core/compat"
struct Parent: View {
  struct Header: View {
    var body: some View { Text("Header") }
  }
  var body: some View { VStack() { Header() } }
}`
  const generated = transformMunSource(source, "Parent.mun.ts")
    .replace(/^import [^\n]+\n/, "")
    .replace(/: any\b/g, "")
  const Parent = Function(
    "defineView",
    "initializer",
    "resolveBuilderClosure",
    "resolveBuilderInput",
    "overloadClosure",
    "compiledTemplate",
    "defineCompiledTemplate",
    "Text",
    "VStack",
    `${generated}; return Parent`,
  )(
    defineView,
    initializer,
    resolveBuilderClosure,
    resolveBuilderInput,
    overloadClosure,
    compiledTemplate,
    defineCompiledTemplate,
    Text,
    VStack,
  )
  assert.equal(typeof Parent.Header, "function")
  assert.equal(Parent.Header().kind, "view")
  const rendered = renderViewNode(Parent(), {
    element(type, props, ...children) { return { type, props, children } },
    fragment(children) { return { fragment: children } },
    value(value) { return value },
    modifier(content) { return content },
  })
  assert.equal(rendered.children[0].children[0], "Header")
})

test("custom structs retain multiple initializers, defaults, @State, and @Binding", () => {
  const source = `import { Text, VStack, State } from "@mun/core/compat"
struct Card<Content: View>: View {
  @State var count: number = 0
  @Binding var title: BindingRef<string>
  let content: Content = Text("Default")
  init(@ViewBuilder content: () => Content, title: BindingRef<string>) { self.content = content(); self.title = title }
  init(@Binding title: BindingRef<string>) { self.title = title }
  var body: some View { VStack() { Text(title.value); Text(String(count.value)); content } }
}`
  const output = transformMunSource(source, "Card.mun.ts")
  assert.equal((output.match(/initializer\(/g) ?? []).length, 2)
  assert.match(output, /state: \(\) => \(\{ count: State\(0\) \}\)/)
  assert.match(output, /Card\(@Binding title\)/)
  assert.match(output, /label: "title"/)
  assert.match(output, /kind: "binding"/)
  assert.equal((output.match(/from "@mun\/core\/compat"/g) ?? []).length, 1)
  assert.equal(ts.createSourceFile("Card.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("struct initializers delegate through the same field plan", () => {
  const source = `struct DelegatedCard: View {
  let title: string
  let subtitle: string
  init(title: string) { self.init(title: title, subtitle: "Default") }
  init(title: string, subtitle: string) { self.title = title; self.subtitle = subtitle }
  var body: some View { VStack() { Text(title); Text(subtitle) } }
}`
  const output = transformMunSource(source, "DelegatedCard.mun.ts")
  assert.match(output, /title: \(title\)/)
  assert.match(output, /subtitle: \("Default"\)/)
  assert.doesNotMatch(output, /title: undefined/)
})

test("AST-backed struct lowering preserves export boundaries and ignores initializer locals", () => {
  const source = `export struct Card: View {
  let title: string
  init(title: string) {
    let local = title
    self.title = title
  }
  var body: some View { Text(title) }
}`
  const output = transformMunSource(source, "Card.mun.ts")
  assert.match(output, /export const Card = defineView\("Card"/)
  assert.match(output, /const \{ title \} = __munProps/)
  assert.doesNotMatch(output, /const \{[^}]*local/)
  assert.equal(ts.createSourceFile("Card.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("raw HTML lowers to core Element nodes and preserves real attributes", () => {
  const source = `import { VStack } from "@mun/core/compat"
VStack() {
  <section class="card" data-kind="hero">
    <h1>{title}</h1>
    <button onclick={save} aria-label="Save">Save</button>
  </section>
}`
  const output = transformMunSource(source, "Card.mun.ts")
  assert.match(output, /import \{ [^}]*Element[^}]* \} from "@mun\/core\/compat"/)
  assert.match(output, /Element\("section", \{ "class": "card", "data-kind": "hero" \}/)
  assert.match(output, /Element\("h1", null, title\)/)
  assert.match(output, /Element\("button", \{ "onclick": save, "aria-label": "Save" \}, "Save"\)/)
  assert.doesNotMatch(output, /<section|<h1|<button/)
  assert.equal(ts.createSourceFile("Card.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("raw HTML supports spread attributes, comments, void elements, custom elements, and inline CSS", () => {
  const source = `const shared = { role: "group", "data-shared": true }
<x-card {...shared} class="card" style="color: red; --accent: blue" aria-label="Card">
  <!-- compiler-only comment -->
  <input data-field="name" disabled>
</x-card>`
  const output = transformMunSource(source, "RawCard.mun.ts")
  assert.match(output, /Element\("x-card", \{ \.\.\.\(shared\), "class": "card", "style": "color: red; --accent: blue", "aria-label": "Card" \}/)
  assert.match(output, /Element\("input", \{ "data-field": "name", "disabled": true \}\)/)
  assert.doesNotMatch(output, /compiler-only comment|<input|<x-card/)
  assert.equal(ts.createSourceFile("RawCard.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
  const invalid = createMunLanguageService().diagnose("  <button {disabled}>Save</button>")
  assert.deepEqual(invalid, [{ severity: "error", code: "MUN_SYNTAX", message: "Raw HTML attribute expressions must use {...value}", line: 1, column: 11 }])
})

test("compiler emits direct collection row plans only for proven flat host rows", () => {
  const source = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => Element("span", { title: item.value }, item.value))) })`
  const output = transformMunSource(source, "CompiledCollection.mun.ts")
  assert.match(output, /compiledCollectionContent\(item => Element\("span"/)
  assert.match(output, /kind: "flat-text-host", indexIndependent: true/)
  assert.match(output, /evaluateProps: \(item\) => \(\{ title: item\.value \}\)/)
  assert.match(output, /evaluate: \(item\) => \(\{ type: "span", props: \{ title: item\.value \}, text: item\.value \}\)/)
  assert.match(output, /import \{[^}]*compiledCollectionContent[^}]*\} from "@mun\/core\/internal\/runtime"/)
  assert.equal(ts.createSourceFile("CompiledCollection.ts", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length, 0)
})

test("compiler specializes ordinary Text rows inside keyed collections", () => {
  const source = `import { State, Text, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => ForEach(items.value, item => item.id, item => Text(item.value)) })`
  const output = transformMunSource(source, "TextCompiledCollection.mun.ts")
  assert.match(output, /compiledCollectionContent\(/)
  assert.match(output, /evaluateKey: item => item\.id/)
  assert.match(output, /hostType: "span"/)
  assert.match(output, /staticProps: null/)
  assert.match(output, /evaluateText: \(item\) => item\.value/)
  assert.match(output, /evaluate: \(item\) => \(\{ type: "span", props: null, text: item\.value \}\)/)
  assert.match(output, /ForEach\.viewType\.createNodeCompiled\(1, \[items, item => item\.id, compiledCollectionContent/)
})

test("compiler lowers proven pure State array maps to the internal runtime ABI", () => {
  const source = `import { State } from "@mun/core/compat"
const items = State([{ id: 1, value: "A" }])
items.value = items.value.map((item, index) => ({ ...item, value: item.value + index }))`
  const output = transformMunSource(source, "StateArrayMap.mun.ts")
  assert.match(output, /mapStateArrayData\(items, \(item, index\) => \(\{ \.\.\.item, value: item\.value \+ index \}\)\)/)
  assert.match(output, /import \{[^}]*mapStateArrayData[^}]*\} from "@mun\/core\/internal\/runtime"/)
})

test("compiler keeps effectful or ambient-property State array maps on normal JavaScript semantics", () => {
  const cases = [
    `import { State } from "@mun/core/compat"\nconst settings = { suffix: "!" }\nconst items = State([{ id: 1, value: "A" }])\nitems.value = items.value.map(item => ({ ...item, value: item.value + settings.suffix }))`,
    `import { State } from "@mun/core/compat"\nconst items = State([{ id: 1, value: "A" }])\nitems.value = items.value.map(item => ({ ...item, value: format(item.value) }))`,
    `import { State } from "@mun/core/compat"\nconst items = State([{ id: 1, value: "A" }])\nitems.value = items.value.map(item => { item.value = "B"; return item })`,
  ]
  for (const [index, source] of cases.entries()) {
    const output = transformMunSource(source, `UnsafeStateArrayMap${index}.mun.ts`)
    assert.doesNotMatch(output, /mapStateArrayData/)
  }
})

test("compiler emits data-only collection descriptors for primitive attributes class and style", () => {
  const source = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "a", value: "A", tone: "active", color: "red", opacity: 0.5, hidden: false }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => Element("span", { className: item.tone, style: { color: item.color, opacity: item.opacity }, title: item.value, hidden: item.hidden }, item.value))) })`
  const output = transformMunSource(source, "DataOnlyCompiledCollection.mun.ts")
  assert.match(output, /compiledCollectionContent/)
  assert.match(output, /props: \{ className: item\.tone, style: \{ color: item\.color, opacity: item\.opacity \}, title: item\.value, hidden: item\.hidden \}/)
})

test("compiler leaves refs raw HTML events and opaque style records on the generic collection path", () => {
  const cases = [
    ["Ref", `{ ref: item.ref }`],
    ["InnerHtml", `{ innerHTML: item.html }`],
    ["DangerousHtml", `{ dangerouslySetInnerHTML: item.html }`],
    ["Event", `{ onClick: item.onClick }`],
    ["OpaqueStyle", `{ style: item.style }`],
  ]
  for (const [name, props] of cases) {
    const source = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => Element("span", ${props}, item.value))) })`
    assert.doesNotMatch(transformMunSource(source, `${name}Collection.mun.ts`), /compiledCollectionContent/)
  }

  const customElement = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => Element("x-row", { title: item.value }, item.value))) })`
  assert.doesNotMatch(transformMunSource(customElement, "CustomElementCollection.mun.ts"), /compiledCollectionContent/)

  const unsafeHost = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => Element("input", { value: item.value }, item.value))) })`
  assert.doesNotMatch(transformMunSource(unsafeHost, "UnsafeHostCollection.mun.ts"), /compiledCollectionContent/)
})

test("compiler keeps index-sensitive collection plans conservative", () => {
  const source = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, (item, index) => Element("span", { title: item.value }, index + ":" + item.value))) })`
  const output = transformMunSource(source, "IndexedCompiledCollection.mun.ts")
  assert.match(output, /compiledCollectionContent/)
  assert.match(output, /indexIndependent: false/)
})

test("compiler does not isolate a State collection whose explicit key depends on index", () => {
  const source = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, (item, index) => index, item => Element("span", null, item.value))) })`
  const output = transformMunSource(source, "IndexKeyCollection.mun.ts")
  assert.match(output, /compiledCollectionContent/)
  assert.match(output, /indexIndependent: false/)
  assert.match(output, /createNodeCompiled\(1, \[items\.value, \(item, index\) => index, compiledCollectionContent/)
  assert.doesNotMatch(output, /createNodeCompiled\(1, \[items, \(item, index\) => index, compiledCollectionContent/)
})

test("compiler does not claim index independence for an unproven explicit key", () => {
  const source = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => String(item.id), item => Element("span", null, item.value))) })`
  const output = transformMunSource(source, "UnprovenKeyCollection.mun.ts")
  assert.match(output, /compiledCollectionContent/)
  assert.match(output, /indexIndependent: false/)
  assert.doesNotMatch(output, /evaluateKey:/)
  assert.match(output, /createNodeCompiled\(1, \[items\.value, item => String\(item\.id\), compiledCollectionContent/)
})

test("compiler only isolates immutable same-file State bindings", () => {
  const source = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
let items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => item.id, item => Element("span", null, item.value))) })`
  const output = transformMunSource(source, "MutableStateBindingCollection.mun.ts")
  assert.match(output, /compiledCollectionContent/)
  assert.match(output, /createNodeCompiled\(1, \[items\.value, item => item\.id, compiledCollectionContent/)
  assert.doesNotMatch(output, /createNodeCompiled\(1, \[items, item => item\.id, compiledCollectionContent/)
})

test("compiler refuses asynchronous generator and shadowed collection row APIs", () => {
  const asynchronous = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, async item => Element("span", null, item.value))) })`
  assert.doesNotMatch(transformMunSource(asynchronous, "AsyncCollection.mun.ts"), /compiledCollectionContent/)

  const generator = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, function* (item) { return Element("span", null, item.value) })) })`
  assert.doesNotMatch(transformMunSource(generator, "GeneratorCollection.mun.ts"), /compiledCollectionContent/)

  const shadowed = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => { const Element = (...args) => args; return ForEach(items.value, item => Element("span", null, item.value)) } })`
  assert.doesNotMatch(transformMunSource(shadowed, "ShadowedElementCollection.mun.ts"), /compiledCollectionContent/)

  const namespaceShadowed = `import * as Mun from "@mun/core/compat"
const items = Mun.State([{ id: "a", value: "A" }])
export const App = Mun.defineView("App", { initializers: [Mun.initializer("App()", args => args.length === 0)], body: () => { const Mun = { Element: (...args) => args }; return Mun.ForEach(items.value, item => Mun.Element("span", null, item.value)) } })`
  assert.doesNotMatch(transformMunSource(namespaceShadowed, "ShadowedNamespaceCollection.mun.ts"), /compiledCollectionContent/)
})

test("compiler refuses effectful or structurally complex collection rows", () => {
  const effectful = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "a", value: "A" }])
const format = value => value.toUpperCase()
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => Element("span", { title: format(item.value) }, item.value))) })`
  assert.doesNotMatch(transformMunSource(effectful, "EffectfulCollection.mun.ts"), /compiledCollectionContent/)

  const nested = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => Element("span", null, Element("strong", null, item.value)))) })`
  assert.doesNotMatch(transformMunSource(nested, "NestedCollection.mun.ts"), /compiledCollectionContent/)

})

test("compiler keeps proven keyed State collections owned by the collection executor", () => {
  const source = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => item.id, item => Element("span", null, item.value))) })`
  const output = transformMunSource(source, "StateOwnedCollection.mun.ts")
  assert.match(output, /ForEach\.viewType\.createNodeCompiled\(1, \[items, item => item\.id, compiledCollectionContent/)
  assert.match(output, /evaluateKey: item => item\.id/)
})

test("compiler keeps keyed struct @State collections owned by the collection executor", () => {
  const source = `import { Element, ForEach } from "@mun/core/compat"
struct StateList: View {
  @State var items: any = [{ id: "a", value: "A" }]
  var body: some View { ForEach(items.value, item => item.id, item => Element("span", { title: item.value }, item.value)) }
}`
  const output = transformMunSource(source, "StructStateCollection.mun.ts")
  assert.match(output, /ForEach\.viewType\.createNodeCompiled\(1, \[items, item => item\.id, compiledCollectionContent/)
  assert.match(output, /evaluateKey: item => item\.id/)
})

test("compiler lowers pure immutable State array maps to the internal runtime helper", () => {
  const source = `import { State } from "@mun/core/compat"
const items = State([{ id: 0, value: "0" }])
export function update() { items.value = items.value.map((item, index) => ({ ...item, value: \`next-\${index}\` })) }`
  const output = transformMunSource(source, "StateArrayMap.mun.ts")
  assert.match(output, /mapStateArrayData\(items, \(item, index\) => \(\{ \.\.\.item, value: `next-\$\{index\}` \}\)\)/)
  assert.match(output, /import \{[^}]*mapStateArrayData[^}]*\} from "@mun\/core\/internal\/runtime"/)
  assert.doesNotMatch(output, /items\.value\s*=\s*items\.value\.map/)

  const conditional = `import { State } from "@mun/core/compat"
const items = State([{ id: 0, value: "0" }])
export function update(selectedId, nextValue) { items.value = items.value.map(item => item.id === selectedId ? ({ ...item, value: nextValue }) : item) }`
  const conditionalOutput = transformMunSource(conditional, "ConditionalStateArrayMap.mun.ts")
  assert.match(conditionalOutput, /mapStateArrayData\(items, item => item\.id === selectedId \? \(\{ \.\.\.item, value: nextValue \}\) : item\)/)

  const structState = `struct StateList: View {
  @State var items: any = [{ id: 0, value: "0" }]
  var body: some View { Button("Update") { items.value = items.value.map(item => item.id === 0 ? ({ ...item, value: "next" }) : item) } }
}`
  const structOutput = transformMunSource(structState, "StructStateArrayMap.mun.ts")
  assert.match(structOutput, /mapStateArrayData\(items, item => item\.id === 0 \? \(\{ \.\.\.item, value: "next" \}\) : item\)/)
  assert.match(structOutput, /from "@mun\/core\/internal\/runtime"/)
})

test("compiler keeps effectful or ambiguous State array maps on ordinary JavaScript semantics", () => {
  const effectful = `import { State } from "@mun/core/compat"
const items = State([{ id: 0, value: "0" }])
const format = value => String(value)
export function update() { items.value = items.value.map(item => ({ ...item, value: format(item.value) })) }`
  assert.doesNotMatch(transformMunSource(effectful, "EffectfulStateArrayMap.mun.ts"), /mapStateArrayData/)

  const mutated = `import { State } from "@mun/core/compat"
const items = State([{ id: 0, value: "0" }])
export function update() { items.value = items.value.map(item => { item.value = "x"; return { ...item, value: "y" } }) }`
  assert.doesNotMatch(transformMunSource(mutated, "MutatingStateArrayMap.mun.ts"), /mapStateArrayData/)

  const shadowed = `import { State } from "@mun/core/compat"
const items = State([{ id: 0, value: "0" }])
export function update(items) { items.value = items.value.map(item => ({ ...item, value: "x" })) }`
  assert.doesNotMatch(transformMunSource(shadowed, "ShadowedStateArrayMap.mun.ts"), /mapStateArrayData/)
})

test("compiler recognizes aliased State constructors for keyed collection ownership", () => {
  const source = `import { State as S, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = S([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => item.id, item => Element("span", null, item.value))) })`
  const output = transformMunSource(source, "AliasedStateCollection.mun.ts")
  assert.match(output, /ForEach\.viewType\.createNodeCompiled\(1, \[items, item => item\.id, compiledCollectionContent/)
})

test("compiler specializes namespace-imported keyed State collections", () => {
  const source = `import * as Mun from "@mun/core/compat"
const items = Mun.State([{ id: "a", value: "A" }])
export const App = Mun.defineView("App", { initializers: [Mun.initializer("App()", args => args.length === 0)], body: () => Mun.Element("section", null, Mun.ForEach(items.value, item => item.id, item => Mun.Element("span", { title: item.value }, item.value))) })`
  const output = transformMunSource(source, "NamespaceStateCollection.mun.ts")
  assert.match(output, /Mun\.ForEach\.viewType\.createNodeCompiled\(1, \[items, item => item\.id, compiledCollectionContent/)
  assert.match(output, /evaluateKey: item => item\.id/)
})

test("compiler does not rewrite a shadowing local value as a StateRef collection", () => {
  const source = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "outer", value: "Outer" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => { const items = { value: [{ id: "local", value: "Local" }] }; return Element("section", null, ForEach(items.value, item => Element("span", null, item.value))) } })`
  const output = transformMunSource(source, "ShadowedStateCollection.mun.ts")
  assert.match(output, /ForEach\.viewType\.createNodeCompiled\(0, \[items\.value, compiledCollectionContent/)
  assert.doesNotMatch(output, /createNodeCompiled\(0, \[items, compiledCollectionContent/)
})


test("compiler keeps implicit-key State collections on the conservative parent-owned path", () => {
  const source = `import { State, Element, ForEach, defineView, initializer } from "@mun/core/compat"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => Element("span", null, item.value))) })`
  const output = transformMunSource(source, "ImplicitStateCollection.mun.ts")
  assert.match(output, /ForEach\.viewType\.createNodeCompiled\(0, \[items\.value, compiledCollectionContent/)
})
