import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Binding, Image, Link, namedArguments, Slider, State, Switch, TextField, Toggle } from "../packages/core/dist/compat.js"
import { Image as ReactImage, Switch as ReactSwitch, Toggle as ReactToggle, render } from "../packages/react/dist/index.js"

test("migrated controls expose native semantics and writable bindings", () => {
  const wifi = State(false)
  const name = State("Mun")
  const volume = State(0.5)
  const html = renderToStaticMarkup(render(
    Toggle("Wi-Fi", Binding(wifi)),
  )) + renderToStaticMarkup(render(TextField(Binding(name), "Name"))) + renderToStaticMarkup(render(Slider(Binding(volume), { min: 0, max: 1, step: 0.1 })))
  assert.match(html, /type="checkbox"/)
  assert.match(html, /data-mun="TextField"/)
  assert.match(html, /type="range"/)
  assert.equal(wifi.value, false)
  assert.equal(name.value, "Mun")
  assert.equal(volume.value, 0.5)

  const toggleElement = render(Toggle("Wi-Fi", Binding(wifi)))
  toggleElement.props.children[0].props.onChange({ target: { checked: true } })
  assert.equal(wifi.value, true)
  const fieldElement = render(TextField(Binding(name)))
  fieldElement.props.onInput({ target: { value: "Mun Core" } })
  assert.equal(name.value, "Mun Core")
  const sliderElement = render(Slider(Binding(volume)))
  sliderElement.props.onInput({ target: { value: "0.75" } })
  assert.equal(volume.value, 0.75)
})

test("Slider normalizes non-finite native numeric attributes", () => {
  const value = State(Number.NaN)
  const html = renderToStaticMarkup(render(Slider(Binding(value), {
    min: Number.NaN,
    max: Number.POSITIVE_INFINITY,
    step: Number.NEGATIVE_INFINITY,
  })))
  assert.doesNotMatch(html, /NaN|Infinity/)
  assert.match(html, /value="0"/)
  assert.match(html, /min="0"/)
  assert.match(html, /max="1"/)
  assert.doesNotMatch(html, /step=/)
})

test("control options cannot override positional props or execute unknown getters", () => {
  let getterCalls = 0
  const sliderOptions = { value: { value: 99 }, min: 0, max: 1 }
  Object.defineProperty(sliderOptions, "unknown", {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error("unknown Slider options must not be read")
    },
  })
  const sliderGraph = Slider(Binding(State(0.25)), sliderOptions)
  sliderOptions.min = -10
  sliderOptions.max = 10
  const slider = renderToStaticMarkup(render(sliderGraph))
  assert.match(slider, /type="range"/)
  assert.match(slider, /value="0.25"/)
  assert.match(slider, /min="0"/)
  assert.match(slider, /max="1"/)

  const imageOptions = { source: "/override.png", alt: "Mun" }
  Object.defineProperty(imageOptions, "unknown", {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error("unknown Image options must not be read")
    },
  })
  const imageGraph = Image("/original.png", imageOptions)
  imageOptions.alt = "Changed"
  const image = renderToStaticMarkup(render(imageGraph))
  assert.match(image, /src="\/original\.png"/)
  assert.match(image, /alt="Mun"/)
  assert.doesNotMatch(image, /override/)
  assert.equal(getterCalls, 0)

  const sliderAccessor = {}
  Object.defineProperty(sliderAccessor, "min", { get() { getterCalls += 1; throw new Error("min getter must not run") } })
  const imageAccessor = {}
  Object.defineProperty(imageAccessor, "alt", { get() { getterCalls += 1; throw new Error("alt getter must not run") } })
  assert.throws(() => Slider(Binding(State(0.5)), sliderAccessor), /Slider options must be a data-only record/)
  assert.throws(() => Image("/image.png", imageAccessor), /Image options must be a data-only record/)
  assert.equal(getterCalls, 0)
})

test("Image ignores non-string alt values without coercing them", () => {
  let getterCalls = 0
  const hostile = {}
  Object.defineProperty(hostile, "toString", {
    get() {
      getterCalls += 1
      throw new Error("alt values must not be coerced")
    },
  })
  const html = renderToStaticMarkup(render(Image("/image.png", { alt: hostile })))
  assert.doesNotMatch(html, /alt=/)
  assert.equal(getterCalls, 0)
})

test("Image and Link stay graph values until rendered", () => {
  const image = Image("/mun.png", { alt: "Mun" })
  assert.equal(image.kind, "element")
  assert.match(renderToStaticMarkup(render(Link("Docs", "/docs"))), /href="\/docs".*Docs/)
})

test("@mun/react controls are compatibility aliases of core controls", () => {
  assert.equal(ReactImage, Image)
  assert.equal(ReactToggle, Toggle)
  assert.equal(ReactSwitch, Switch)
})

test("Switch binds a boolean and toggles it on click", () => {
  const wifi = State(false)
  const html = renderToStaticMarkup(render(Switch(Binding(wifi))))
  assert.match(html, /role="switch"/)
  assert.match(html, /aria-checked="false"/)
  assert.match(html, /data-mun="Switch"/)

  const element = render(Switch(Binding(wifi)))
  element.props.onClick()
  assert.equal(wifi.value, true)
  assert.match(renderToStaticMarkup(render(Switch(Binding(wifi)))), /aria-checked="true"/)
  element.props.onClick()
  assert.equal(wifi.value, false)
})

test("Switch options customize tint, off state, size, and label", () => {
  const enabled = State(true)
  const html = renderToStaticMarkup(render(Switch(Binding(enabled), {
    tint: "#ff375f",
    offTint: "#333333",
    size: 40,
    label: "Notifications",
  })))
  assert.match(html, /background:#ff375f|background: rgb\(255, 55, 95\)/)
  assert.match(html, /aria-label="Notifications"/)
  assert.match(html, /height:40px/)
  assert.doesNotMatch(html, /NaN/)

  // Non-finite or non-positive sizes fall back to the default instead of emitting invalid CSS.
  const fallback = renderToStaticMarkup(render(Switch(Binding(enabled), { size: Number.NaN })))
  assert.doesNotMatch(fallback, /NaN/)
})

test("Switch supports SwiftUI-style labeled and positional title initializers", () => {
  const wifi = State(false)

  // Labeled form: lowered from `Switch("Wi-Fi", isOn: $wifi)` in .mun source.
  const labeled = render(Switch("Wi-Fi", namedArguments({ isOn: Binding(wifi) })))
  assert.match(renderToStaticMarkup(labeled), /Wi-Fi.*role="switch"/s)
  labeled.props.children[1].props.onClick()
  assert.equal(wifi.value, true)

  // Plain positional form.
  wifi.value = false
  const positional = renderToStaticMarkup(render(Switch("Wi-Fi", Binding(wifi))))
  assert.match(positional, /Wi-Fi.*aria-checked="false"/s)

  // Labeled carrier without a title still resolves to the unlabeled initializer.
  const unlabeled = renderToStaticMarkup(render(Switch(namedArguments({ isOn: Binding(wifi) }))))
  assert.match(unlabeled, /role="switch"/)
  assert.doesNotMatch(unlabeled, /Wi-Fi/)
})

test("Switch composes with view modifiers", () => {
  const enabled = State(true)
  const html = renderToStaticMarkup(render(
    Switch(Binding(enabled), { tint: "#ff375f" }).style({ margin: 4 }).padding(8),
  ))
  assert.match(html, /margin: ?4px|margin-top: ?8px/)
  assert.match(html, /padding: ?8px/)
  assert.match(html, /role="switch"/)
})

test("Switch rejects option records that are not data-only", () => {
  let getterCalls = 0
  const hostile = {}
  Object.defineProperty(hostile, "tint", {
    get() {
      getterCalls += 1
      throw new Error("unknown Switch options must not be read")
    },
  })
  assert.throws(() => Switch(Binding(State(true)), hostile), /Switch options must be a data-only record/)
  assert.equal(getterCalls, 0)
})

test("Slider rejects non-numeric input and clamps to the configured range", () => {
  const volume = State(0.5)
  const sliderElement = render(Slider(Binding(volume), { min: 0, max: 1 }))
  sliderElement.props.onInput({ target: { value: "" } })
  assert.equal(volume.value, 0)
  sliderElement.props.onInput({ target: { value: "not-a-number" } })
  assert.equal(volume.value, 0)
  sliderElement.props.onInput({ target: { value: "5" } })
  assert.equal(volume.value, 1)
  sliderElement.props.onInput({ target: { value: "-3" } })
  assert.equal(volume.value, 0)
  sliderElement.props.onInput({ target: {} })
  assert.equal(volume.value, 0)
})
