import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Button, Text, VStack, closureKindOf, defineView, initializer, initializerKinds, namedArguments, render, resolveBuilderClosure, resolveInitializer } from "../packages/react/dist/index.js"

test("Button exposes exactly the two canonical initializer forms", () => {
  const calls = []
  const forms = [
    Button("Save", () => { calls.push(2) }),
    Button(namedArguments({ action: () => { calls.push(3) }, label: () => [Text("Save")] })),
  ]
  for (const button of forms) {
    const element = render(button)
    const html = renderToStaticMarkup(element)
    assert.match(html, /<button/)
    element.props.onClick()
  }
  assert.deepEqual(calls, [2, 3])
  assert.deepEqual(Button.viewType.initializers.map(initializer => initializer.signature), [
    "Button(_ title: string | number, @Action action)",
    "Button(@Action action, @ViewBuilder label)",
  ])
  assert.equal(resolveInitializer(Button, ["Save", () => undefined]).initializer.signature, "Button(_ title: string | number, @Action action)")
  assert.equal(resolveInitializer(Button, [namedArguments({ action: () => undefined, label: () => Text("Save") })]).initializer.signature, "Button(@Action action, @ViewBuilder label)")
})

test("Button rejects legacy closure ordering and unlabeled custom labels", () => {
  const action = () => undefined
  const label = () => [Text("Save")]
  for (const args of [[action], [action, label], [label, action], [namedArguments({ label, action })]]) {
    assert.throws(() => Button(...args), error => error.name === "MunInitializerError" || error.name === "MunInitializerAmbiguityError")
  }
  assert.throws(() => resolveInitializer(Button, [namedArguments({ label, action })]), /No matching initializer/)
})

test("named argument resolution does not execute carrier getters", () => {
  let getterCalls = 0
  const carrier = { label: () => Text("Save") }
  Object.defineProperty(carrier, "action", {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error("initializer resolution must not execute argument getters")
    },
  })
  namedArguments(carrier)

  assert.throws(() => resolveInitializer(Button, [carrier]), /No matching initializer/)
  assert.throws(() => Button.viewType.createNodeSpecialized(1, [carrier]), /No matching initializer/)
  assert.equal(getterCalls, 0)
})

test("custom views and ViewBuilder composition use the same graph boundary", () => {
  const html = renderToStaticMarkup(render(VStack(() => [Text("Header"), Text("Body")])) )
  assert.match(html, /Header/)
  assert.match(html, /Body/)
})

test("initializer metadata maps mixed positional, labeled, and trailing closures independent of carrier position", () => {
  const MixedCard = defineView("MixedCard", {
    initializers: [initializer(
      "MixedCard(_ title: string, @Action action, @ViewBuilder label)",
      args => args.length === 3 && typeof args[0] === "string" && typeof args[1] === "function" && typeof args[2] === "function",
      args => ({ title: args[0], action: args[1], label: resolveBuilderClosure(args[2]) }),
      [
        initializerKinds.value(true, undefined, undefined, "string"),
        initializerKinds.action(true, "action"),
        initializerKinds.viewBuilder(true, "label"),
      ],
    )],
    body: props => Button(namedArguments({ action: props.action, label: () => [Text(props.title), ...props.label] })),
  })
  const action = () => undefined
  const label = () => Text("Body")
  const afterPositional = resolveInitializer(MixedCard, ["Title", action, label])
  assert.deepEqual(afterPositional.args.slice(0, 1), ["Title"])
  assert.equal(afterPositional.args[1](), undefined)
  assert.match(renderToStaticMarkup(render(MixedCard("Title", action, label))), /Title.*Body/)
  assert.throws(() => resolveInitializer(MixedCard, [namedArguments({ label, action }), "Title"]), /No matching initializer/)
})

test("runtime initializer resolution accepts omitted optional middle arguments and applies defaults", () => {
  const DefaultedControl = defineView("DefaultedControl", {
    initializers: [initializer(
      "DefaultedControl(_ checked: boolean, disabled: boolean = false, @Action onToggle: () => void = noop)",
      args => args.length >= 1 && args.length <= 3
        && typeof args[0] === "boolean"
        && (args[1] === undefined || typeof args[1] === "boolean")
        && (args[2] === undefined || typeof args[2] === "function"),
      args => ({
        checked: args[0],
        disabled: args[1] === undefined ? false : args[1],
        onToggle: args[2] === undefined ? (() => undefined) : args[2],
      }),
      [
        initializerKinds.value(true, undefined, undefined, "boolean"),
        initializerKinds.value(false, "disabled", undefined, "boolean"),
        initializerKinds.action(false, "onToggle", "function", true),
      ],
    )],
    body: () => Text("control"),
  })

  const onToggle = () => undefined
  const middleOmission = resolveInitializer(DefaultedControl, [true, undefined, onToggle])
  assert.equal(middleOmission.args[0], true)
  assert.equal(middleOmission.args[1], undefined)
  assert.equal(closureKindOf(middleOmission.args[2]), "action")
  assert.deepEqual(middleOmission.initializer.build(middleOmission.args), {
    checked: true,
    disabled: false,
    onToggle,
  })

  const LoadingLike = defineView("LoadingLike", {
    initializers: [initializer(
      "LoadingLike(isStatic: boolean = false, inline: boolean = false)",
      args => args.length <= 2 && (args[0] === undefined || typeof args[0] === "boolean") && (args[1] === undefined || typeof args[1] === "boolean"),
      args => ({
        isStatic: args[0] === undefined ? false : args[0],
        inline: args[1] === undefined ? false : args[1],
      }),
      [
        initializerKinds.value(false, "isStatic", undefined, "boolean"),
        initializerKinds.value(false, "inline", undefined, "boolean"),
      ],
    )],
    body: () => Text("loading"),
  })
  const hostOmission = resolveInitializer(LoadingLike, [undefined, true])
  assert.deepEqual(hostOmission.initializer.build(hostOmission.args), { isStatic: false, inline: true })
})

test("initializer ties are an error and do not use declaration order as a fallback", () => {
  const make = (name, initializers) => defineView(name, {
    initializers,
    body: ({ value }) => Text(value),
  })
  const first = initializer(
    "Ambiguous(value: string)",
    args => args.length === 1 && typeof args[0] === "string",
    args => ({ value: args[0] }),
    [initializerKinds.value(true, "value", undefined, "string")],
  )
  const second = initializer(
    "Ambiguous(value: string) [duplicate]",
    args => args.length === 1 && typeof args[0] === "string",
    args => ({ value: args[0] }),
    [initializerKinds.value(true, "value", undefined, "string")],
  )
  const forward = make("Ambiguous", [first, second])
  const reverse = make("AmbiguousReverse", [second, first])
  for (const View of [forward, reverse]) {
    assert.throws(() => View("value"), error => {
      assert.equal(error.name, "MunInitializerAmbiguityError")
      assert.match(error.message, /Ambiguous initializer for/)
      assert.match(error.message, /Candidates:/)
      return true
    })
  }
})
