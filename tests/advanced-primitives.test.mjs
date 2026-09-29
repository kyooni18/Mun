import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Binding, Box, ElementRef, Grid, Key, Picker, ProgressView, State, Stepper, Text, TextArea } from "../packages/core/dist/compat.js"
import { Box as ReactBox, Grid as ReactGrid, render } from "../packages/react/dist/index.js"

test("remaining built-in elements and controls use the new graph adapter", () => {
  const value = State("one")
  const count = State(1)
  const html = renderToStaticMarkup(render(Box(
    Grid({ columns: 2 }, ProgressView(0.5, { label: "Load" })),
    TextArea(Binding(value), "Notes"),
    Picker(Binding(value), [{ label: "One", value: "one" }]),
    Stepper(Binding(count)),
  )))
  assert.match(html, /data-mun="Grid"/)
  assert.match(html, /data-mun="ProgressView"/)
  assert.match(html, /data-mun="TextArea"/)
  assert.match(html, /data-mun="Picker"/)
  assert.match(html, /data-mun="Stepper"/)
  assert.match(renderToStaticMarkup(render(Grid({ columns: 2 }, () => [Text("A"), Text("B")]))), /A.*B/)
  assert.match(renderToStaticMarkup(render(Box(() => Text("Builder")))), /Builder/)
  assert.match(renderToStaticMarkup(render(ProgressView(5, { max: 10 }))), /max="10" value="5"/)
})

test("ProgressView and Stepper normalize non-finite numeric inputs", () => {
  const progress = renderToStaticMarkup(render(ProgressView(Number.NaN, { max: Number.POSITIVE_INFINITY })))
  assert.doesNotMatch(progress, /NaN|Infinity/)
  assert.match(progress, /<progress max="1"><\/progress>/)

  const count = State(2)
  const stepper = render(Stepper(Binding(count), Number.NaN))
  const button = stepper.props.children.find(child => child?.type === "button")
  assert.ok(button)
  button.props.onClick()
  assert.equal(count.value, 3)
})

test("ProgressView options cannot override its positional value or execute unknown getters", () => {
  let getterCalls = 0
  const options = { value: Number.NaN, max: 1 }
  Object.defineProperty(options, "unknown", {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error("unknown ProgressView options must not be read")
    },
  })
  const graph = ProgressView(0.5, options)
  options.max = 10
  const html = renderToStaticMarkup(render(graph))
  assert.match(html, /<progress max="1" value="0.5"><\/progress>/)
  assert.equal(getterCalls, 0)

  const accessorOptions = {}
  Object.defineProperty(accessorOptions, "max", {
    get() {
      getterCalls += 1
      throw new Error("max getter must not run")
    },
  })
  assert.throws(() => ProgressView(0.5, accessorOptions), /ProgressView options must be a data-only record/)
  assert.equal(getterCalls, 0)
})

test("ProgressView ignores non-string labels without coercing them", () => {
  let getterCalls = 0
  const hostile = {}
  Object.defineProperty(hostile, "toString", {
    get() {
      getterCalls += 1
      throw new Error("progress labels must not be coerced")
    },
  })
  const html = renderToStaticMarkup(render(ProgressView(0.5, { label: hostile })))
  assert.doesNotMatch(html, /\[object Object\]/)
  assert.equal(getterCalls, 0)
})

test("Picker snapshots validated options for rendered choices and change handling", () => {
  let getterCalls = 0
  const options = [{ label: "One", value: "one" }]
  Object.defineProperty(options[0], "unknown", {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error("unknown Picker option fields must not be read")
    },
  })
  const selection = State("none")
  const picker = render(Picker(Binding(selection), options))
  options[0].label = "Changed"
  options[0].value = "changed"
  options.push({ label: "Two", value: "two" })

  picker.props.onChange({ target: { value: "changed" } })
  assert.equal(selection.value, "none")
  picker.props.onChange({ target: { value: "two" } })
  assert.equal(selection.value, "none")
  picker.props.onChange({ target: { value: "one" } })
  assert.equal(selection.value, "one")
  assert.equal(getterCalls, 0)
  assert.match(renderToStaticMarkup(picker), />One<\/option>/)
  assert.doesNotMatch(renderToStaticMarkup(picker), /Changed|Two/)

  assert.throws(() => Picker(Binding(selection), [null]), /Picker options must contain/)
  assert.throws(() => Picker(Binding(selection), [{ label: "Invalid", value: Number.NaN }]), /finite, uniquely serialized/)
  assert.throws(() => Picker(Binding(selection), [
    { label: "Number", value: 1 },
    { label: "String", value: "1" },
  ]), /finite, uniquely serialized/)

  let lengthReads = 0
  const proxiedOptions = new Proxy([{ label: "Proxy", value: "proxy" }], {
    get(target, key, receiver) {
      if (key === "length") {
        lengthReads += 1
        throw new Error("Picker must inspect the length descriptor")
      }
      return Reflect.get(target, key, receiver)
    },
  })
  assert.doesNotThrow(() => Picker(Binding(selection), proxiedOptions))
  assert.equal(lengthReads, 0)
})

test("built-in option initializers reject revoked proxies without native reflection errors", () => {
  const revoked = target => {
    const pair = Proxy.revocable(target, {})
    pair.revoke()
    return pair.proxy
  }
  assert.throws(() => Grid(revoked({}), () => Text("Grid")), /No matching initializer for Grid/)
  assert.throws(() => Picker(Binding(State("value")), revoked([])), /No matching initializer for Picker/)
})

test("Key and ElementRef are immutable graph modifiers", () => {
  const value = TextArea(Binding(State("value")))
  const keyed = Key("field", value)
  const referenced = ElementRef(() => undefined, keyed)
  assert.notEqual(value, keyed)
  assert.notEqual(keyed, referenced)
  assert.equal(referenced.kind, "modified")
})

test("@mun/react advanced Views are compatibility aliases of core Views", () => {
  assert.equal(ReactBox, Box)
  assert.equal(ReactGrid, Grid)
})
