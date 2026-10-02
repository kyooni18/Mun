import assert from "node:assert/strict"
import test from "node:test"
import { compileMunUiProgram, compileMunDevProgram, diagnoseMunSource } from "../packages/compiler/dist/index.js"

const view = (body, members = "") => `@main
struct Probe: View {
  @State var on: Bool = false
  @State var text: String = "x"
  @State var amount: Double = 0.5
${members}
  var body: some View {
    ${body}
  }
}
`

// Canonical source is rejected at compile time with a source-oriented
// diagnostic naming the problem and, where useful, the valid signatures.
const rejected = [
  ["value for a Binding", 'Toggle("Wi-Fi", isOn: on)', /Binding is required, but 'on' is a value — pass \$on/],
  ["Binding for a value", 'ProgressView(value: $amount)', /takes a value, not a Binding/],
  ["wrong label", 'Toggle("Wi-Fi", value: $on)', /no argument label 'value:'/],
  ["wrong order", 'Toggle(isOn: $on, "Wi-Fi")', /unlabeled argument must come before 'isOn:'/],
  ["missing argument", "SecureField(\"Password\")", /requires 'text:'|SecureField\(_:text:\)/],
  ["extra argument", "Divider(1)", /too many arguments\. Mün supports: Divider\(\)/],
  ["missing label", "Spacer(8)", /needs the label 'minLength:'/],
  ["value type", 'ProgressView(value: "half")', /'value:' expects Double, received String/],
  ["unimplemented SDK overload", 'Toggle("Wi-Fi", systemImage: "wifi", isOn: $on)', /Toggle\(_:systemImage:isOn:\) is a SwiftUI initializer that Mün does not implement/],
  ["closure role", 'Text("x").onAppear(perform: 3)', /'perform:' requires a closure/],
  ["unimplemented parameter", 'Text("x").frame(idealWidth: 10)', /idealWidth:\) is not implemented/],
  ["compatibility-only spelling", 'Text("x").foregroundColor(Color.red)', /compatibility-only/],
  ["unsupported View", "List { Text(\"x\") }", /List/],
]

for (const [name, body, message] of rejected) {
  test(`canonical diagnostic: ${name}`, () => {
    assert.throws(() => compileMunUiProgram(view(body)), message)
  })
}

const declarations = [
  ["TypeScript type spelling", "  @State var items: string[] = []", /'string\[\]' is a compatibility-only TypeScript type spelling; canonical \.mun writes \[String\]/],
  ["@State initial type", "  @State var count: Int = 0.5", /declared Int but its initial value is Double/],
  ["private member without default", "  private let title: String", /private member needs a default value/],
  ["private @Binding", "  @Binding private var flag: Bool", /@Binding cannot be private/],
]
for (const [name, members, message] of declarations) {
  test(`canonical declaration: ${name}`, () => {
    assert.throws(() => compileMunUiProgram(view('Text("x")', members)), message)
  })
}

test("private members are internal to their View", () => {
  const source = `struct Badge: View {
  private let prefix: String = "#"
  let title: String
  var body: some View { Text(prefix + title) }
}
@main
struct App: View {
  var body: some View { Badge(${"title"}: "a") }
}
`
  assert.equal(compileMunUiProgram(source).entry, "App")
  assert.throws(() => compileMunUiProgram(source.replace('Badge(title: "a")', 'Badge(prefix: "!", title: "a")')), /'Badge\.prefix' is private; a caller cannot initialize it/)
})

test("switch is Swift-shaped: literal cases, exhaustive, desugared to conditionals", () => {
  const program = compileMunUiProgram(view(`switch text {
    case "a", "b":
      Text("ab")
    case "c": Text("c")
    default: Text("other")
    }`))
  const root = program.root.child
  assert.equal(root.kind, "conditional")
  assert.equal(root.condition.operator, "or")
  assert.equal(root.otherwise[0].kind, "conditional")
  assert.throws(() => compileMunUiProgram(view('switch text {\n    case "a": Text("a")\n    }')), /must be exhaustive: add a default case/)
  assert.throws(() => compileMunUiProgram(view('switch amount {\n    case 0...1: Text("low")\n    default: Text("x")\n    }')), /range patterns are not supported/)
  assert.throws(() => compileMunUiProgram(view('switch text {\n    case "a": Text("a")\n    case "a": Text("b")\n    default: Text("x")\n    }')), /case "a" is repeated/)
  // A Bool switch over both literals is exhaustive without default.
  compileMunUiProgram(view('switch on {\n    case true: Text("y")\n    case false: Text("n")\n    }'))
})

test("Swift literals and entry points", () => {
  const program = compileMunUiProgram(view('Text("x")', '  @State var maybe: String? = nil\n  @State var table: [String: Int] = ["a": 1]'))
  assert.deepEqual(program.states.find(state => state.name.endsWith("/maybe"))?.initial, null)
  assert.deepEqual(program.states.find(state => state.name.endsWith("/table"))?.initial, { a: 1 })
  // `\(…)` is interpolation, never an escaped parenthesis.
  const text = compileMunUiProgram(view('Text("n = \\(amount)!")')).root.child.value
  assert.equal(text.kind, "binary")
  assert.equal(JSON.stringify(text).includes('"stringify"'), true)
  assert.throws(() => compileMunUiProgram(`${view('Text("x")')}\nexport default Other()\n`), /@main Probe and export default Other\(\) name different entry Views/)
})

// The compatibility TS transform does not implement Swift key paths. It must
// not decide whether a canonical native program is valid.
test("canonical keyed collection shares native diagnostics and lowering", () => {
  for (const count of [2, 1000]) {
    const source = `@main
struct Tasks: View {
  @State var tasks: [Task] = [${Array.from({ length: count }, (_, n) => `{ id: "task-${n}", title: "Task ${n}" }`).join(', ')}]
  var body: some View {
    ForEach(tasks, id: \\.id) { task in
      TaskRow(task: task)
    }
  }
}
struct TaskRow: View {
  var task: Task
  @State var done: Bool = false
  var body: some View {
    HStack {
      Toggle("Done", isOn: $done)
      Text(task.title)
    }
  }
}`
    assert.deepEqual(diagnoseMunSource(source, "Sources/Tasks.mun"), [])
    assert.deepEqual(compileMunDevProgram(source).program, compileMunUiProgram(source))
    const invalid = source.replace('isOn: $done', 'isOn: done')
    assert.throws(() => compileMunUiProgram(invalid), /Binding/)
    assert.match(diagnoseMunSource(invalid, "Sources/Tasks.mun")[0].message, /Binding/)
  }
})
