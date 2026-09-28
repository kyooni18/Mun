import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import { compileMunUiProgram, createMunSemanticModel } from "../packages/compiler/dist/index.js"
import { Animation } from "../packages/core/dist/index.js"
import { compileMotionPlan, curves, spring, timing } from "../packages/animation/dist/src/core/index.js"

test("native UI IR keeps semantic controls and precompiles inherited spring motion", () => {
  const file = new URL("../examples/NativeDemo.mun", import.meta.url)
  const source = fs.readFileSync(file, "utf8")
  const program = compileMunUiProgram(source, file.pathname)
  const serialized = JSON.stringify(program)

  assert.equal(program.sourceLanguage, "mun")
  assert.equal(program.root.kind, "window")
  assert.equal(program.root.accessibility?.role, "window")
  assert.equal(program.root.child.kind, "column")

  const column = program.root.child
  assert.equal(column.kind, "column")
  if (column.kind !== "column") return

  const action = column.children.find(node => node.kind === "action")
  const panel = column.children.find(node => node.kind === "panel")
  assert.ok(action && action.kind === "action")
  assert.equal(action.accessibility?.role, "button")
  assert.match(program.states[0].name, /^@component\/NativeDemo-\d+\/expanded$/)
  assert.deepEqual(action.action, { kind: "toggle-state", state: program.states[0].name })

  assert.ok(panel && panel.kind === "panel")
  const widthMotion = panel.motion?.find(binding => binding.property === "width")
  assert.ok(widthMotion)
  assert.equal(widthMotion.propertyMask, 1 << 9)
  assert.equal(widthMotion.plan.kind, "spring")
  if (widthMotion.plan.kind === "spring") {
    assert.ok(Math.abs(widthMotion.plan.omega - Math.PI * 2 / 0.48) < 1e-9)
    assert.equal(widthMotion.plan.dampingRatio, 0.82)
  }

  assert.equal(serialized.includes('"type":"div"'), false)
  assert.equal(serialized.includes('"type":"span"'), false)
  assert.equal(serialized.includes('"style"'), false)
  assert.equal(serialized.includes('"css"'), false)
  assert.equal(serialized.includes('"dom"'), false)
})


test("compiler timing plans stay aligned with the inherited motion planner", () => {
  const source = `import { Animation, Rectangle, State } from "@mun/core"
const expanded = State(false)
struct App: View {
  var body: some View {
    Rectangle()
      .frame(width: expanded.value ? 320 : 160, height: 80)
      .animation(Animation.easeInOut(0.4), expanded.value)
  }
}
export default App()`
  const program = compileMunUiProgram(source, "timing-contract.mun")
  const panel = program.root.child
  assert.equal(panel.kind, "panel")
  if (panel.kind !== "panel") return
  const binding = panel.motion?.find(item => item.property === "width")
  assert.ok(binding)
  assert.equal(binding.plan.kind, "timing")
  if (binding.plan.kind !== "timing") return

  const inherited = compileMotionPlan(timing({ duration: 0.4, curve: curves.easeInOut }))
  assert.equal(inherited.route, "timing")
  assert.equal(binding.plan.duration, inherited.spec.duration)
  assert.deepEqual(binding.plan.curve, [
    inherited.spec.curve.x1,
    inherited.spec.curve.y1,
    inherited.spec.curve.x2,
    inherited.spec.curve.y2,
  ])
})


test("compiler native motion reuses core Animation descriptor modifiers", () => {
  const source = `import { Animation, Rectangle, State } from "@mun/core"
const expanded = State(false)
struct App: View {
  var body: some View {
    Rectangle()
      .frame(width: expanded.value ? 320 : 160, height: 80)
      .animation(Animation.snappy(0.6, 0.2).delay(0.12).speed(2), expanded.value)
  }
}
export default App()`
  const program = compileMunUiProgram(source, "descriptor-contract.mun")
  const panel = program.root.child
  assert.equal(panel.kind, "panel")
  if (panel.kind !== "panel") return
  const binding = panel.motion?.find(item => item.property === "width")
  assert.ok(binding)
  assert.equal(binding.plan.kind, "spring")
  if (binding.plan.kind !== "spring") return

  const descriptor = Animation.snappy(0.6, 0.2).delay(0.12).speed(2).descriptor
  const inherited = compileMotionPlan(spring({
    response: descriptor.response / descriptor.speed,
    dampingRatio: descriptor.dampingFraction,
    blendDuration: descriptor.blendDuration / descriptor.speed,
  }))
  assert.equal(inherited.route, "spring")
  assert.ok(Math.abs(binding.plan.omega - inherited.omega) < 1e-9)
  assert.equal(binding.plan.dampingRatio, inherited.dampingRatio)
  assert.equal(binding.plan.delayMs, descriptor.delay / descriptor.speed * 1000)
})

test("native compiler preserves inherited repeat iteration and autoreverse semantics", () => {
  const source = `import { Animation, Rectangle, State } from "@mun/core"
const expanded = State(false)
struct App: View {
  var body: some View {
    Rectangle()
      .frame(width: expanded.value ? 320 : 160, height: 80)
      .animation(Animation.easeInOut(0.4).repeatCount(3, false), expanded.value)
  }
}
export default App()`
  const program = compileMunUiProgram(source, "repeat-contract.mun")
  const panel = program.root.child
  assert.equal(panel.kind, "panel")
  if (panel.kind !== "panel") return
  const binding = panel.motion?.find(item => item.property === "width")
  assert.equal(binding?.plan?.repeatCount, 3)
  assert.equal(binding?.plan?.autoreverses, false)
})

test("native compiler serializes repeatForever without inventing a finite iteration count", () => {
  const source = `import { Animation, Rectangle, State } from "@mun/core"
const expanded = State(false)
struct App: View {
  var body: some View {
    Rectangle()
      .frame(width: expanded.value ? 320 : 160, height: 80)
      .animation(Animation.linear(0.2).repeatForever(true), expanded.value)
  }
}
export default App()`
  const program = compileMunUiProgram(source, "repeat-forever-contract.mun")
  const panel = program.root.child
  if (panel.kind !== "panel") return
  const binding = panel.motion?.find(item => item.property === "width")
  assert.equal(binding?.plan?.repeatCount, "infinite")
  assert.equal(binding?.plan?.autoreverses, true)
})

test("withAnimation lowers into a state transaction and dynamic properties remain motion participants", () => {
  const source = `import { Animation, Button, Rectangle, State, VStack, withAnimation } from "@mun/core"
const expanded = State(false)
struct App: View {
  var body: some View {
    VStack() {
      Button("Toggle") {
        withAnimation(Animation.easeInOut(0.4)) {
          expanded.toggle()
        }
      }
      Rectangle()
        .frame(width: expanded.value ? 320 : 160, height: 80)
    }
  }
}
export default App()`
  const program = compileMunUiProgram(source, "transaction-contract.mun")
  const column = program.root.child
  assert.equal(column.kind, "column")
  if (column.kind !== "column") return

  const action = column.children[0]
  const panel = column.children[1]
  assert.equal(action.kind, "action")
  assert.equal(panel.kind, "panel")
  if (action.kind !== "action" || panel.kind !== "panel") return

  assert.equal(action.action.transaction?.animation?.kind, "timing")
  assert.equal(action.action.transaction?.disablesAnimations, false)
  assert.equal(action.action.transaction?.isContinuous, false)

  const width = panel.motion?.find(binding => binding.property === "width")
  assert.ok(width)
  assert.equal(width.plan, undefined)
  assert.equal(width.trigger, undefined)
})

test("withAnimation null preserves transaction intent without inventing a motion plan", () => {
  const source = `import { Button, Rectangle, State, VStack, withAnimation } from "@mun/core"
const expanded = State(false)
struct App: View {
  var body: some View {
    VStack() {
      Button("Toggle") {
        withAnimation(null) {
          expanded.toggle()
        }
      }
      Rectangle().frame(width: expanded.value ? 320 : 160, height: 80)
    }
  }
}
export default App()`
  const program = compileMunUiProgram(source, "transaction-null.mun")
  const column = program.root.child
  if (column.kind !== "column") return
  const action = column.children[0]
  if (action.kind !== "action") return
  assert.ok(action.action.transaction)
  assert.equal(action.action.transaction.animation, null)
})

test("withTransaction lowers the core Transaction constructor without renderer semantics", () => {
  const source = `import { Animation, Button, Rectangle, State, Transaction, VStack, withTransaction } from "@mun/core"
const expanded = State(false)
struct App: View {
  var body: some View {
    VStack() {
      Button("Toggle") {
        withTransaction(new Transaction({
          animation: Animation.easeOut(0.5),
          disablesAnimations: true,
          isContinuous: true
        })) {
          expanded.toggle()
        }
      }
      Rectangle().frame(width: expanded.value ? 320 : 160, height: 80)
    }
  }
}
export default App()`
  const program = compileMunUiProgram(source, "with-transaction.mun")
  const column = program.root.child
  if (column.kind !== "column") return
  const action = column.children[0]
  if (action.kind !== "action") return

  assert.equal(action.action.transaction?.animation?.kind, "timing")
  assert.equal(action.action.transaction?.disablesAnimations, true)
  assert.equal(action.action.transaction?.isContinuous, true)
})


test("native compiler rejects semantic constructs it cannot represent instead of silently defaulting", () => {
  const unsupportedModifier = `import { Rectangle } from "@mun/core"
struct App: View {
  var body: some View {
    Rectangle().shadow(radius: 4)
  }
}
export default App()`

  assert.throws(
    () => compileMunUiProgram(unsupportedModifier, "unsupported-modifier.mun"),
    /View modifier '\.shadow' is not representable in Mün semantic UI IR/,
  )

  const unsupportedPadding = `import { Rectangle } from "@mun/core"
struct App: View {
  var body: some View {
    Rectangle().padding("wide")
  }
}
export default App()`

  assert.throws(
    () => compileMunUiProgram(unsupportedPadding, "unsupported-padding.mun"),
    /Native semantic numeric value must be a finite static number: "wide"/,
  )

  const unsupportedBackground = `import { Rectangle, State } from "@mun/core"
const highlighted = State(false)
struct App: View {
  var body: some View {
    Rectangle().background(highlighted.value ? "#fff" : "#000")
  }
}
export default App()`

  assert.throws(
    () => compileMunUiProgram(unsupportedBackground, "unsupported-background.mun"),
    /Native semantic string value must be static/,
  )
})

test("native UI IR expands custom View structs with bound values, defaults, state, and conditionals", () => {
  const source = `import { Rectangle, State, Text, VStack } from "@mun/core"
const expanded = State(false)

struct StatusCard: View {
  let title: string
  let collapsedWidth: number = 120
  let expandedWidth: number
  let expandedValue: boolean

  var body: some View {
    VStack(spacing: 6) {
      Text(title)
      if (expandedValue) {
        Rectangle()
          .frame(width: expandedWidth, height: 24)
          .background("#6750A4")
      } else {
        Rectangle()
          .frame(width: collapsedWidth, height: 24)
          .background("#333333")
      }
    }
    .padding(10)
  }
}

struct App: View {
  var body: some View {
    StatusCard(title: "Status", expandedWidth: 260, expandedValue: expanded.value)
  }
}

export default App()`

  const program = compileMunUiProgram(source, "custom-view-contract.mun")
  const card = program.root.child
  assert.equal(card.kind, "column")
  if (card.kind !== "column") return
  assert.equal(card.layout?.padding, 10)
  assert.equal(card.children[0]?.kind, "text")
  assert.deepEqual(card.children[0]?.value, { kind: "literal", value: "Status" })

  const branch = card.children[1]
  assert.equal(branch?.kind, "conditional")
  if (branch?.kind !== "conditional") return
  assert.deepEqual(branch.condition, { kind: "state", state: "expanded" })

  const expandedPanel = branch.then[0]
  const collapsedPanel = branch.otherwise[0]
  assert.equal(expandedPanel?.kind, "panel")
  assert.equal(collapsedPanel?.kind, "panel")
  assert.deepEqual(expandedPanel?.layout?.width, { kind: "literal", value: 260 })
  assert.deepEqual(collapsedPanel?.layout?.width, { kind: "literal", value: 120 })
  assert.equal(expandedPanel?.visual?.background, "#6750A4")
  assert.equal(collapsedPanel?.visual?.background, "#333333")
})

test("custom View expansion keeps per-instance bindings isolated and node identities distinct", () => {
  const source = `import { Text, VStack } from "@mun/core"

struct Badge: View {
  let title: string

  var body: some View {
    Text(title)
  }
}

struct App: View {
  var body: some View {
    VStack(spacing: 4) {
      Badge(title: "First")
      Badge(title: "Second")
    }
  }
}

export default App()`

  const program = compileMunUiProgram(source, "component-instance-contract.mun")
  const column = program.root.child
  assert.equal(column.kind, "column")
  if (column.kind !== "column") return
  assert.deepEqual(column.children.map(node => node.kind === "text" ? node.value : null), [
    { kind: "literal", value: "First" },
    { kind: "literal", value: "Second" },
  ])
  assert.notEqual(column.children[0]?.id, column.children[1]?.id)
})


test("custom View memberwise calls use the shared semantic initializer contract", () => {
  const source = `import { Text } from "@mun/core"

struct Badge: View {
  let title: string
  let tone: string = "normal"

  var body: some View {
    Text(title)
  }
}

struct App: View {
  var body: some View {
    Badge(title: "Ready")
  }
}

export default App()`

  const semantic = createMunSemanticModel(source, "memberwise-semantic-contract.mun")
  const badge = semantic.view("Badge")
  assert.ok(badge)
  assert.equal(badge.initializers.length, 1)
  assert.equal(badge.initializers[0]?.synthesized, "memberwise")
  assert.deepEqual(
    badge.initializers[0]?.parameters.map(parameter => ({
      name: parameter.name,
      label: parameter.label,
      required: parameter.required,
      kind: parameter.kind,
    })),
    [
      { name: "title", label: "title", required: true, kind: "value" },
      { name: "tone", label: "tone", required: false, kind: "value" },
    ],
  )

  const call = semantic.calls.find(candidate => candidate.callee === "Badge")
  assert.ok(call)
  assert.deepEqual(call.resolution.diagnostics, [])
  assert.equal(call.resolution.resolvedInitializer?.signature, badge.initializers[0]?.signature)

  const unlabeled = source.replace('Badge(title: "Ready")', 'Badge("Ready")')
  assert.throws(
    () => compileMunUiProgram(unlabeled, "memberwise-label-contract.mun"),
    /No matching initializer for native View 'Badge'/,
  )
})

test("native explicit initializer assigns fields and honors default arguments", () => {
  const source = `import { Rectangle, Text, VStack } from "@mun/core"

struct Badge: View {
  let title: string
  let width: number

  init(_ label: string, width: number = 140) {
    self.title = label
    self.width = width
  }

  var body: some View {
    VStack() {
      Text(title)
      Rectangle().frame(width: width, height: 20)
    }
  }
}

struct App: View {
  var body: some View {
    VStack() {
      Badge("Compact")
      Badge("Wide", width: 220)
    }
  }
}

export default App()`

  const program = compileMunUiProgram(source, "explicit-initializer-contract.mun")
  const root = program.root.child
  assert.equal(root.kind, "column")
  if (root.kind !== "column") return
  assert.equal(root.children.length, 2)

  const compact = root.children[0]
  const wide = root.children[1]
  assert.equal(compact?.kind, "column")
  assert.equal(wide?.kind, "column")
  if (compact?.kind !== "column" || wide?.kind !== "column") return

  const compactText = compact.children[0]
  const compactPanel = compact.children[1]
  const wideText = wide.children[0]
  const widePanel = wide.children[1]
  assert.deepEqual(compactText?.kind === "text" ? compactText.value : undefined, { kind: "literal", value: "Compact" })
  assert.deepEqual(wideText?.kind === "text" ? wideText.value : undefined, { kind: "literal", value: "Wide" })
  assert.deepEqual(compactPanel?.layout?.width, { kind: "literal", value: 140 })
  assert.deepEqual(widePanel?.layout?.width, { kind: "literal", value: 220 })
})
test("native built-ins validate calls through the shared semantic initializer contract", () => {
  const source = `import { Button, State, Text, VStack } from "@mun/core"
const enabled = State(false)

struct App: View {
  var body: some View {
    VStack(spacing: 8) {
      Text("Ready")
      Button("Toggle") { enabled.toggle() }
    }
  }
}

export default App()`

  const semantic = createMunSemanticModel(source, "builtin-semantic-contract.mun")
  for (const name of ["VStack", "Text", "Button"]) {
    const call = semantic.calls.find(candidate => candidate.callee === name)
    assert.ok(call)
    assert.deepEqual(call.resolution.diagnostics, [])
    assert.ok(call.resolution.resolvedInitializer)
  }
  assert.doesNotThrow(() => compileMunUiProgram(source, "builtin-semantic-contract.mun"))

  const unlabeledStack = source.replace("VStack(spacing: 8)", "VStack(8)")
  assert.throws(
    () => compileMunUiProgram(unlabeledStack, "builtin-stack-label-contract.mun"),
    /No matching initializer for native View 'VStack'/,
  )

  const wrongTextType = source.replace('Text("Ready")', "Text(42)")
  assert.throws(
    () => compileMunUiProgram(wrongTextType, "builtin-text-type-contract.mun"),
    /No matching initializer for native View 'Text'/,
  )
})

test("entry View @State lowers to owned semantic state used by reads and actions", () => {
  const source = `import { Button, Text, VStack } from "@mun/core"

struct App: View {
  @State var enabled: boolean = false

  var body: some View {
    VStack(spacing: 8) {
      Button("Toggle") { enabled.toggle() }
      if (enabled.value) {
        Text("Enabled")
      } else {
        Text("Disabled")
      }
    }
  }
}

export default App()`

  const program = compileMunUiProgram(source, "entry-state-contract.mun")
  assert.equal(program.states.length, 1)
  const state = program.states[0]
  assert.match(state.name, /^@component\/App-\d+\/enabled$/)
  assert.equal(state.initial, false)

  const column = program.root.child
  assert.equal(column.kind, "column")
  if (column.kind !== "column") return
  const action = column.children[0]
  const conditional = column.children[1]
  assert.equal(action?.kind, "action")
  assert.equal(conditional?.kind, "conditional")
  if (action?.kind !== "action" || conditional?.kind !== "conditional") return
  assert.deepEqual(action.action, { kind: "toggle-state", state: state.name })
  assert.deepEqual(conditional.condition, { kind: "state", state: state.name })
})

test("custom View instances own distinct @State identities and initial values", () => {
  const source = `import { Button, Text, VStack } from "@mun/core"

struct Counter: View {
  let initiallyEnabled: boolean
  @State var enabled: boolean = initiallyEnabled

  var body: some View {
    VStack() {
      Button("Toggle") { enabled.value = !enabled.value }
      if (enabled.value) {
        Text("On")
      } else {
        Text("Off")
      }
    }
  }
}

struct App: View {
  var body: some View {
    VStack() {
      Counter(initiallyEnabled: false)
      Counter(initiallyEnabled: true)
    }
  }
}

export default App()`

  const program = compileMunUiProgram(source, "component-state-contract.mun")
  assert.equal(program.states.length, 2)
  assert.deepEqual(program.states.map(state => state.initial), [false, true])
  assert.notEqual(program.states[0].name, program.states[1].name)
  assert.match(program.states[0].name, /^@component\/Counter-\d+\/enabled$/)
  assert.match(program.states[1].name, /^@component\/Counter-\d+\/enabled$/)

  const root = program.root.child
  assert.equal(root.kind, "column")
  if (root.kind !== "column") return
  const counters = root.children
  assert.equal(counters.length, 2)
  for (let index = 0; index < counters.length; index += 1) {
    const counter = counters[index]
    assert.equal(counter?.kind, "column")
    if (counter?.kind !== "column") continue
    const action = counter.children[0]
    const conditional = counter.children[1]
    assert.equal(action?.kind, "action")
    assert.equal(conditional?.kind, "conditional")
    if (action?.kind !== "action" || conditional?.kind !== "conditional") continue
    assert.equal(action.action.state, program.states[index].name)
    assert.deepEqual(conditional.condition, { kind: "state", state: program.states[index].name })
  }
})

test("custom View @Binding aliases parent-owned State without copying storage", () => {
  const source = `import { Button, Text, VStack } from "@mun/core"

struct ToggleRow: View {
  @Binding var enabled: boolean

  var body: some View {
    VStack() {
      Button("Child toggle") { enabled.toggle() }
      if (enabled.value) {
        Text("Child on")
      } else {
        Text("Child off")
      }
    }
  }
}

struct App: View {
  @State var enabled: boolean = false

  var body: some View {
    VStack() {
      ToggleRow(enabled: $enabled)
      if (enabled.value) {
        Text("Parent on")
      } else {
        Text("Parent off")
      }
    }
  }
}

export default App()`

  const program = compileMunUiProgram(source, "component-binding-alias.mun")
  assert.equal(program.states.length, 1)
  const state = program.states[0]

  const root = program.root.child
  assert.equal(root.kind, "column")
  if (root.kind !== "column") return
  const child = root.children[0]
  const parentConditional = root.children[1]
  assert.equal(child?.kind, "column")
  assert.equal(parentConditional?.kind, "conditional")
  if (child?.kind !== "column" || parentConditional?.kind !== "conditional") return

  const action = child.children[0]
  const childConditional = child.children[1]
  assert.equal(action?.kind, "action")
  assert.equal(childConditional?.kind, "conditional")
  if (action?.kind !== "action" || childConditional?.kind !== "conditional") return

  assert.equal(action.action.state, state.name)
  assert.deepEqual(childConditional.condition, { kind: "state", state: state.name })
  assert.deepEqual(parentConditional.condition, { kind: "state", state: state.name })
})
test("native custom View expansion still rejects unsupported binding ownership and recursion", () => {
  const entryBinding = `import { Text } from "@mun/core"

struct App: View {
  @Binding var enabled: boolean
  var body: some View {
    Text("Binding")
  }
}

export default App()`

  assert.throws(
    () => compileMunUiProgram(entryBinding, "component-binding-contract.mun"),
    /uses @Binding without an owning parent/,
  )

  const recursive = `struct Loop: View {
  var body: some View {
    Loop()
  }
}

export default Loop()`

  assert.throws(
    () => compileMunUiProgram(recursive, "component-recursion-contract.mun"),
    /Recursive native View expansion is not supported: Loop -> Loop/,
  )
})


test("native compiler preserves renderer-neutral lifecycle Transition descriptors", () => {
  const source = `import { Animation, Rectangle, State, Transition, VStack } from "@mun/core"
const visible = State(true)
struct App: View {
  var body: some View {
    VStack() {
      if (visible.value) {
        Rectangle().frame(width: 120, height: 48).transition(Transition.opacity.combined(Transition.scale(0.8)).combined(Transition.move("bottom", 20)).animation(Animation.linear(0.2).delay(0.1)))
      }
    }
  }
}
export default App()`
  const program = compileMunUiProgram(source, "transition-contract.mun")
  const column = program.root.child
  assert.equal(column.kind, "column")
  if (column.kind !== "column") return
  const conditional = column.children.find(node => node.kind === "conditional")
  assert.ok(conditional && conditional.kind === "conditional")
  if (!conditional || conditional.kind !== "conditional") return
  const panel = conditional.then[0]
  assert.equal(panel.kind, "panel")
  assert.deepEqual(panel.transition?.insertion, [
    { kind: "opacity" },
    { kind: "scale", scale: 0.8 },
    { kind: "move", edge: "bottom", distance: 20 },
  ])
  assert.deepEqual(panel.transition?.removal, [
    { kind: "opacity" },
    { kind: "scale", scale: 0.8 },
    { kind: "move", edge: "bottom", distance: 20 },
  ])
  assert.equal(panel.transition?.animation?.kind, "timing")
  if (panel.transition?.animation?.kind !== "timing") return
  assert.equal(panel.transition.animation.duration, 0.2)
  assert.equal(panel.transition.animation.delayMs, 100)
})
