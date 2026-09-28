# Vune: a human-first guide

This is the long-form guide to Vune. It is written for people learning the
framework, migrating an existing application, or trying to understand why Vune
looks a little like SwiftUI while behaving like a web-native TypeScript UI
system.

The examples in this book describe the current Vune checkout, version `0.1.20`,
including the in-progress compiler and Resident Compute work. Stable authoring
APIs are separated from compatibility and experimental APIs wherever that
distinction matters.

For the short machine-oriented version, see [AI_AGENT_REFERENCE.md](./AI_AGENT_REFERENCE.md).
For normative semantics, see [SEMANTICS.md](./SEMANTICS.md). For the exact public
surface, see [API.md](./API.md).

---

## 1. The one idea to understand first

Vune source describes a **renderer-independent View graph**.

That graph is not a React element, not a Vue VNode, and not a DOM node.

```text
.vune / .vune.ts
       |
       v
@vune-ui/compiler
       |
       v
Vune View graph
   |      |      |
   v      v      v
 React   Vue    Web
                 |
                 v
              DOM / HTML
```

The best SwiftUI analogy is that `Text("Hello")` is a value describing a View.
The best React analogy is that it fills a role similar to an element tree, but
Vune does not use React's element or component model as its semantic core. The
best Vue analogy is similar: Vue can host and render Vune, but Vue does not own
Vune state, initializer rules, or identity.

That separation explains most of the framework:

- `vune-ui` owns Views, State, Binding, builders, modifiers, and semantic rules.
- `@vune-ui/compiler` owns Swift-like source lowering and compile-time analysis.
- `@vune-ui/web` owns direct DOM/HTML materialization.
- `@vune-ui/react` owns React materialization and React interop.
- `@vune-ui/vue` owns Vue materialization and Vue interop.
- `@vune-ui/vite` connects the compiler to Vite.

If a rule changes depending on whether React or Vue is rendering the same graph,
that rule is usually in the wrong layer.

### 1.1 A translation table

| Idea | SwiftUI | Vune | React | Vue |
| --- | --- | --- | --- | --- |
| Declarative value | `some View` | Vune View graph | React element | VNode/template |
| Local state | `@State` | `State()` / `@State` in Vune structs | `useState()` | `ref()` / `reactive()` |
| Writable child state | `@Binding` | `Binding()` / `@Binding` | value + setter props | `v-model` / writable ref |
| Composition block | `@ViewBuilder` | `ViewBuilder` compiler syntax | JSX children | template / slots |
| Repeated children | `ForEach` | `ForEach` | `.map()` + `key` | `v-for` + `:key` |
| Modifier chain | `.padding().opacity()` | `.padding().opacity()` | props/style wrappers | directives/style/classes |
| Native host | platform View | renderer host graph | DOM through React | DOM through Vue |
| Direct browser renderer | not applicable | `@vune-ui/web` | React DOM | Vue runtime-dom |

The visual similarity to SwiftUI is deliberate. The runtime model is still made
for browsers and TypeScript.

---

## 2. Your first Vune application

The simplest mental model is the direct Web renderer. It removes React and Vue
from the picture and makes the Vune boundary obvious.

### 2.1 Vite configuration

```ts
// vite.config.ts
import { defineConfig } from "vite"
import { vunePlugin } from "@vune-ui/vite"

export default defineConfig({
  plugins: [vunePlugin()],
})
```

### 2.2 A counter

```ts
// Counter.vune.ts
import { Button, State, Text, VStack } from "vune-ui"

const count = State(0)

struct Counter: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(`Count: ${count.value}`)
        .font(.title)

      Button("Increment") {
        count.value += 1
      }
    }
    .padding(24)
  }
}

export default Counter()
```

```ts
// main.ts
import { mount } from "@vune-ui/web"
import App from "./Counter.vune"

mount(App, document.getElementById("app")!)
```

There are three important things happening here.

First, `State(0)` is Vune state, not React state or Vue state. Second,
`VStack`, `Text`, and `Button` produce Vune graph values. Third, the Web renderer
materializes that graph into the DOM and subscribes only to the state boundaries
that actually read `count`.

### 2.3 The same counter in SwiftUI

```swift
struct Counter: View {
    @State private var count = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Count: \(count)")
                .font(.title)

            Button("Increment") {
                count += 1
            }
        }
        .padding(24)
    }
}
```

The source resemblance is intentional. The major semantic difference is that
Vune ultimately maps layout and controls to browser behavior rather than
SwiftUI's proposal-based native layout engine.

### 2.4 The same counter in React

```tsx
import { useState } from "react"

export function Counter() {
  const [count, setCount] = useState(0)

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 24 }}>
      <span>Count: {count}</span>
      <button onClick={() => setCount(count + 1)}>Increment</button>
    </div>
  )
}
```

React recomputes the component function when its state changes and reconciles
the returned element tree. Vune instead records State dependencies at View
boundaries and can invalidate the smallest safe Vune boundary. The Web renderer
also has compiler-generated direct patch paths for some proven State-only
changes.

### 2.5 The same counter in Vue

```vue
<script setup lang="ts">
import { ref } from "vue"

const count = ref(0)
</script>

<template>
  <div class="counter">
    <span>Count: {{ count }}</span>
    <button @click="count += 1">Increment</button>
  </div>
</template>
```

Vue and Vune are both fine-grained enough to avoid treating every update as a
complete DOM rebuild, but their ownership is different. A Vune graph can be
materialized by Vue without converting Vune State into Vue reactivity.

### 2.6 The same counter with the plain DOM

```ts
let count = 0

const label = document.createElement("span")
const button = document.createElement("button")
button.textContent = "Increment"

function update() {
  label.textContent = `Count: ${count}`
}

button.addEventListener("click", () => {
  count += 1
  update()
})

document.body.append(label, button)
update()
```

This is useful as a reminder: Vune's direct Web renderer is not an attempt to
hide the browser. It automates graph construction, state dependency tracking,
identity, reconciliation, accessibility mapping, hydration, modifiers, and
compiler specialization while still producing ordinary browser output.

---

## 3. Vune source forms

Vune supports two broad authoring styles:

1. canonical `.vune` / `.vune.ts` source with Swift-like builders, labels,
   shorthand values, raw HTML, and `struct ...: View`;
2. ordinary TypeScript using explicit function calls and `defineView`.

They lower into the same graph semantics.

### 3.1 Builder syntax

```ts
VStack(alignment: .leading, spacing: 12) {
  Text("Title")
  Text("Subtitle")
}
```

The compiler turns `.leading` into the appropriate inert runtime value and the
trailing block into a `ViewBuilder` closure. It does not special-case `VStack`
by name; initializer metadata says that the final parameter is a ViewBuilder.

### 3.2 Ordinary TypeScript form

```ts
VStack(
  { alignment: "leading", spacing: 12 },
  Text("Title"),
  Text("Subtitle"),
)
```

This is useful in generated code, libraries that do not run the Vune compiler,
or places where normal TypeScript is clearer.

### 3.3 `struct ...: View`

```ts
struct Badge: View {
  let title: string

  init(_ title: string) {
    self.title = title
  }

  var body: some View {
    Text(title)
      .padding(8)
      .background("Canvas")
  }
}

Badge("Ready")
```

The compiler lowers this declaration to the same `defineView` and initializer
metadata used by built-in Views.

### 3.4 Instance state in a struct

```ts
struct CounterRow: View {
  @State var count: number = 0

  var body: some View {
    HStack(spacing: 8) {
      Text(String(count.value))
      Button("+") {
        count.value += 1
      }
    }
  }
}
```

An `@State` field is instance-owned. Reordering keyed rows therefore preserves
the State with the logical View identity instead of moving it to a neighboring
row.

### 3.5 Binding shorthand

Inside compiler-managed Vune source, `$name` lowers to `Binding(name)` when it
is an actual binding shorthand identifier.

```ts
const enabled = State(false)

Toggle("Enabled", isOn: $enabled)
```

The compiler intentionally does not rewrite strings, comments, regular
expressions, member properties such as `vm.$attrs`, or identifiers that merely
contain a dollar sign.

The explicit equivalent is:

```ts
Toggle("Enabled", Binding(enabled))
```

### 3.6 Raw HTML inside Vune source

```ts
VStack() {
  <section class="card" aria-label="Profile">
    <h2>{title}</h2>
    <button onclick={save}>Save</button>
  </section>
}
```

Raw HTML is lowered to typed Vune `Element` graph nodes. It does not switch the
file into JSX or React semantics.

The explicit form is:

```ts
Element(
  "section",
  { class: "card", "aria-label": "Profile" },
  Element("h2", null, title),
  Element("button", { onclick: save }, "Save"),
)
```

---

## 4. Initializers are part of the language

SwiftUI-style source only works predictably if a View has a real initializer
contract. Vune therefore treats initializer metadata as a semantic boundary,
not as documentation layered over arbitrary JavaScript calls.

Resolution considers labels, arity, defaults, variadics, closure roles, runtime
types where known, generic constraints, and conversion cost. A unique best
initializer must win.

### 4.1 `Button` is the easiest example

Canonical Vune source intentionally accepts two forms:

```ts
Button("Save") {
  save()
}
```

and:

```ts
Button(action: {
  save()
}, label: {
  HStack(spacing: 6) {
    Image(saveIcon)
    Text("Save")
  }
})
```

These are not valid canonical forms:

```ts
// Wrong: custom label without action: / label: initializer labels.
Button({ save() }) {
  Text("Save")
}

// Wrong: declaration order is action, then label.
Button(label: { Text("Save") }, action: { save() })
```

The point is not to be restrictive for its own sake. The compiler, editor,
runtime, and renderer all agree on one declaration rather than carrying
component-specific exceptions.

### 4.2 A custom initializer

```ts
struct Metric: View {
  let label: string
  let value: string

  init(_ label: string, value: string) {
    self.label = label
    self.value = value
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.caption)
      Text(value).font(.title)
    }
  }
}

Metric("CPU", value: "72%")
```

### 4.3 The explicit `defineView` equivalent

```ts
import {
  Text,
  VStack,
  defineView,
  initializer,
} from "vune-ui"

const Metric = defineView("Metric", {
  initializers: [
    initializer(
      "Metric(label, value)",
      args => args.length === 2,
      args => ({ label: String(args[0]), value: String(args[1]) }),
    ),
  ],
  body: ({ label, value }) => VStack(
    { alignment: "leading", spacing: 4 },
    Text(label),
    Text(value),
  ),
})
```

Most application code should prefer the struct syntax when it makes the source
clearer. Framework and generated code often benefits from seeing the metadata
explicitly.

---

## 5. State: Vune's reactive ownership boundary

`State<T>` owns a mutable value and publishes observable changes.

```ts
const count = State(0)

count.value += 1
```

A View that reads `count.value` becomes dependent on that State for the current
evaluation. Renderers can subscribe to the smallest safe View boundary rather
than requiring every parent above it to subscribe manually.

### 5.1 State compared with other frameworks

SwiftUI:

```swift
@State private var count = 0
count += 1
```

Vune:

```ts
const count = State(0)
count.value += 1
```

React:

```ts
const [count, setCount] = useState(0)
setCount(value => value + 1)
```

Vue:

```ts
const count = ref(0)
count.value += 1
```

Vune's `.value` spelling resembles Vue's refs, but the semantic object is Vune
State and its subscriber graph is renderer-independent.

### 5.2 Mutable arrays and objects

Arrays and plain objects are mutation-aware, including nested plain objects.

```ts
const todos = State([
  { id: "docs", title: "Read the docs", done: false },
])

todos.value.push({
  id: "app",
  title: "Build an app",
  done: false,
})

todos.value[0].done = true
```

You do not have to clone the array just to make a nested mutation observable.
Root replacement still works:

```ts
todos.value = todos.value.filter(todo => todo.id !== "docs")
```

### 5.3 Values that should be replaced at the root

Vune does not pretend every JavaScript object can be safely proxied as a mutable
container. Replace the State root for values such as:

- `Map` and `Set`;
- class instances;
- frozen values;
- React elements;
- other special host objects.

```ts
const selected = State(new Set<string>())

const next = new Set(selected.value)
next.add("a")
selected.value = next
```

### 5.4 Shared raw mutable containers

If two State objects wrap the same raw array or plain object, both participate
in mutation ownership and both subscribers can be notified.

```ts
const raw = { count: 0 }
const a = State(raw)
const b = State(raw)

a.value.count += 1
// Reads through b observe the same underlying mutation contract.
```

Do not use proxy identity as application-level identity. Treat `State()` as the
ownership boundary.

### 5.5 Module State versus instance State

Top-level State is not automatically equivalent to component-local State.

When the compiler can prove that a top-level `const x = State(...)` belongs to
exactly one canonical Vune View, it may move that State into the View instance.
It deliberately refuses this transformation when ownership is ambiguous, such
as exported, mutable, destructured, shared, or externally referenced State.

If ownership matters, make it explicit:

```ts
struct Counter: View {
  @State var count: number = 0

  var body: some View {
    Text(String(count.value))
  }
}
```

or use a state factory in the React compatibility view API:

```ts
const Counter = view({
  state: () => ({ count: State(0) }),
  body: ({ count }) => Text(String(count.value)),
})
```

---

## 6. Binding: writable state without giving away ownership

A `Binding<T>` is a writable lens.

```ts
const name = State("Vune")
const nameBinding = Binding(name)

TextField(nameBinding, "Name")
```

The control can read and write the value without owning the State object.

### 6.1 Custom bindings

```ts
const temperatureC = State(20)

const temperatureF = Binding(
  () => temperatureC.value * 9 / 5 + 32,
  value => {
    temperatureC.value = (value - 32) * 5 / 9
  },
)
```

This is roughly the same role as a custom SwiftUI `Binding(get:set:)`.

### 6.2 Binding in a custom View

```ts
struct ToggleRow: View {
  @Binding var isOn: Bool

  var body: some View {
    Toggle("Wi-Fi", isOn: $isOn)
  }
}
```

The parent still owns the value. The child receives a writable projection.

### 6.3 React comparison

React normally represents this manually:

```tsx
function ToggleRow(props: {
  isOn: boolean
  setIsOn: (value: boolean) => void
}) {
  return (
    <input
      type="checkbox"
      checked={props.isOn}
      onChange={event => props.setIsOn(event.target.checked)}
    />
  )
}
```

Vune turns that read/write pair into one typed semantic value.

---

## 7. ViewBuilder and conditional UI

`ViewBuilder` normalizes declarative children while preserving source order.
Arrays flatten recursively. `null`, `undefined`, and false optional branches do
not produce rendered children.

### 7.1 Conditions

```ts
VStack() {
  Text("Account")

  if (signedIn.value) {
    ProfileView()
  } else {
    SignInView()
  }
}
```

### 7.2 Local values in a builder

Builders can contain ordinary statements used to compute later Views.

```ts
VStack() {
  const total = items.value.reduce((sum, item) => sum + item.price, 0)
  const formatted = `$${total.toFixed(2)}`

  Text("Cart")
  Text(formatted)
}
```

This is one of the important differences from JSX-as-expression. A Vune builder
is a compiler-recognized block with View-producing statements, not merely a
JavaScript expression returning one nested object literal.

### 7.3 Loops and switches

The compiler retains View children through statement-bearing builders,
including `switch`, `for`, `for...of`, `while`, and `try/catch/finally` when
they are part of the supported builder structure.

For data collections with persistent child identity, prefer `ForEach` rather
than an arbitrary loop.

---

## 8. `ForEach`, keys, and identity

Identity is one of the places where declarative frameworks most often appear to
work until rows are reordered.

Vune identity is based on:

```text
parent path
+ structural slot
+ concrete View declaration identity
+ explicit key, when present
```

### 8.1 The preferred form

```ts
ForEach(items.value, key: item => item.id) { item in
  Row(item)
}
```

Vune can infer identity from primitive items or common `id` / `key` fields, but
an explicit stable primitive key is the clearest contract for application data.

### 8.2 Stateful row example

```ts
struct Row: View {
  let item: Item
  @State var expanded: boolean = false

  init(_ item: Item) {
    self.item = item
  }

  var body: some View {
    Button(item.title) {
      expanded.value = !expanded.value
    }
  }
}

ForEach(items.value, key: item => item.id) { item in
  Row(item)
}
```

If the list is reordered, `expanded` follows the item key.

### 8.3 React comparison

```tsx
{items.map(item => (
  <Row key={item.id} item={item} />
))}
```

The broad purpose is similar, but a React key is not Vune identity. React and
Vue renderer keys are projections of Vune's renderer-independent identity path.

### 8.4 Duplicate and unstable keys

Duplicate keys make state ownership ambiguous. Unstable index-derived keys make
insertion and reorder behavior surprising. Vune warns when it has to fall back
to unstable or value-based inferred identity.

Use this:

```ts
ForEach(messages.value, key: message => message.id) { message in
  MessageRow(message)
}
```

not this for reorderable data:

```ts
ForEach(messages.value, key: (_message, index) => index) { message in
  MessageRow(message)
}
```

---

## 9. Layout: SwiftUI-shaped source, CSS-native behavior

Vune intentionally prefers relationships over absolute coordinates.

```ts
VStack(alignment: .leading, spacing: 12) {
  Text("Title")

  HStack(spacing: 8) {
    Text("Left")
    Spacer()
    Text("Right")
  }
}
```

That resembles SwiftUI, but the browser renderer uses CSS layout semantics.
Vune does not claim pixel-equivalent behavior to SwiftUI's proposal and ideal
size algorithm.

### 9.1 `VStack`

`VStack` is a vertical flex relationship.

```ts
VStack(alignment: .leading, spacing: 16) {
  Text("One")
  Text("Two")
}
```

### 9.2 `HStack`

`HStack` is a horizontal flex relationship and is full-width by default in the
current web implementation.

```ts
HStack(alignment: .top, spacing: 12) {
  Avatar(user.avatar)
  ProfileSummary(user)
}
```

### 9.3 `ZStack`

```ts
ZStack(alignment: .bottomTrailing) {
  Image(photo)
  Text("NEW")
    .padding(6)
}
```

The Web implementation maps this to a grid-based stacking relationship.

### 9.4 `Spacer`

```ts
HStack() {
  Text("Back")
  Spacer()
  Text("Done")
}
```

`Spacer()` consumes available flex space. `Spacer(12)` gives it an explicit
minimum basis.

### 9.5 `frame`

```ts
Text("Save")
  .frame(maxWidth: .infinity, alignment: .leading)
```

`frame` creates a renderer-neutral layout host around its content. Constraints
belong to the host; alignment positions the content within it.

Modifier order therefore matters:

```ts
Text("A")
  .background("red")
  .frame(width: 200)
```

is not structurally identical to:

```ts
Text("A")
  .frame(width: 200)
  .background("red")
```

The first background belongs to the inner content before the frame host is
introduced. The second background decorates the framed result.

### 9.6 `ScrollView`

```ts
ScrollView(.vertical) {
  LazyVStack(alignment: .leading, spacing: 8) {
    ForEach(rows.value, key: row => row.id) { row in
      Row(row)
    }
  }
}
```

The runtime maps axes to native browser overflow behavior.

### 9.7 `SafeArea`

```ts
SafeArea(["top", "bottom"]) {
  Content()
}
```

On the web, safe-area behavior maps to `env(safe-area-inset-*)` values.

### 9.8 `GeometryReader`

```ts
GeometryReader() { geometry in
  Text(`Width: ${geometry.size.width}`)
}
```

Measurement is renderer-owned. SSR uses deterministic zero geometry. Browser
renderers can re-evaluate after mounting and measuring the host.

### 9.9 Grid

`Grid` is a Vune web-oriented View whose familiar name should not be mistaken
for a full SwiftUI Grid parity claim.

```ts
Grid({ columns: 3 }) {
  Metric("CPU", value: "72%")
  Metric("Memory", value: "1.8 GB")
  Metric("Tasks", value: "14")
}
```

### 9.10 Lazy stacks and grids

```ts
LazyVStack({
  alignment: "leading",
  spacing: 8,
  estimatedItemSize: 56,
  overscan: 4,
}) {
  ForEach(items.value, key: item => item.id) { item in
    ItemRow(item)
  }
}
```

Direct Web can window lazy children. React and Vue preserve the same logical
graph and metadata but currently retain a full-graph fallback. Virtualization
must not destroy State for a keyed logical item merely because it leaves the
viewport.

---

## 10. Shapes and corners

Vune provides simple renderer-neutral shape Views including:

```ts
Rectangle()
Circle()
Capsule()
RoundedRectangle(16)
```

They are useful as structural View values in backgrounds, masks, overlays, and
other modifier-owned View positions.

Vune also exposes continuous-corner behavior for the browser. Treat
`continuousCorners` as a Vune compatibility extension rather than a SwiftUI
parity claim.

---

## 11. Controls

Controls use Vune Binding where the control needs to write application state.

### 11.1 Text field

```ts
const name = State("")

TextField(Binding(name), "Name")
```

Compiler shorthand:

```ts
TextField($name, "Name")
```

### 11.2 Text editor

`TextEditor` is part of the canonical SwiftUI-derived root surface.

```ts
const notes = State("")

TextEditor(text: $notes)
```

### 11.3 Toggle

```ts
const enabled = State(false)

Toggle("Enable notifications", isOn: $enabled)
```

### 11.4 Vune `Switch`

`Switch` is a Vune control with a compact web-native visual implementation.

```ts
Switch("Wi-Fi", Binding(enabled), {
  size: 24,
  label: "Wi-Fi",
})
```

It is useful when an application specifically wants Vune's switch primitive;
it is not part of the current canonical SwiftUI View manifest.

### 11.5 Slider

```ts
const volume = State(0.5)

Slider(Binding(volume), {
  min: 0,
  max: 1,
  step: 0.05,
})
```

### 11.6 Picker

```ts
const quality = State<string | number>("high")

Picker(Binding(quality), [
  { label: "Low", value: "low" },
  { label: "High", value: "high" },
])
```

### 11.7 Stepper

```ts
const quantity = State(1)

Stepper(Binding(quantity), 1)
```

The current `Stepper` primitive takes an optional step size. If the application
needs minimum/maximum bounds, clamp or validate the State at the owning
application boundary.

### 11.8 Progress

```ts
ProgressView(0.65, { max: 1, label: "Upload" })
```

### 11.9 Link

```ts
Link("Documentation", "/docs")
```

### 11.10 Image

```ts
Image("/avatar.png", { alt: "Profile" })
```

`Image` can also render `VectorSymbol` data, which becomes important for symbol
transitions later in this guide.

---

## 12. Modifiers: immutable graph transformations

A modifier returns a new View graph node. It does not mutate the original View.

```ts
const plain = Text("Hello")
const styled = plain
  .padding(12)
  .opacity(0.8)

plain !== styled
```

Conceptually this is closer to SwiftUI's nested `ModifiedContent` model than to
mutating a DOM style object.

### 12.1 Canonical SwiftUI-derived modifiers

The current parity manifest covers a broad modifier slice including:

- layout: `padding`, `frame`, `fixedSize`, `layoutPriority`, `position`,
  `offset`, `zIndex`;
- transforms: `scaleEffect`, `rotationEffect`, `transformEffect`,
  `projectionEffect`, `rotation3DEffect`;
- typography: `font`, `bold`, `fontWeight`, `fontDesign`, `fontWidth`,
  `italic`, `underline`, `strikethrough`, `kerning`, `tracking`,
  `baselineOffset`, `lineSpacing`, `lineLimit`;
- visual effects: `opacity`, `shadow`, `blur`, `brightness`, `contrast`,
  `saturation`, `grayscale`, `hueRotation`, `colorInvert`, `blendMode`;
- composition: `background`, `overlay`, `mask`, `clipShape`, `border`;
- interaction: `disabled`, `allowsHitTesting`, `onTapGesture`,
  `onLongPressGesture`, `onHover`, `focusable`;
- scrolling/list: `scrollDisabled`, `scrollIndicators`,
  `scrollBounceBehavior`, `listStyle`, `listRowInsets`,
  `listRowBackground`, separators;
- accessibility: `accessibilityLabel`, `accessibilityHint`,
  `accessibilityValue`, `accessibilityHidden`, `accessibilityIdentifier`,
  heading/action/element metadata;
- animation: `animation`, `transition`, `contentTransition`.

The exact source contract lives in `packages/core/src/api-manifest.ts` and is
described in [SWIFTUI_PARITY.md](./SWIFTUI_PARITY.md).

### 12.2 Fidelity levels

A matching SwiftUI name does not automatically mean identical native behavior.

Vune distinguishes:

- `source`: the implemented slice has no material web-specific semantic caveat;
- `source-subset`: the spelling is SDK-backed but accepted value families or
  generic behavior are narrower;
- `web-approximation`: the source idea is mapped intentionally to browser
  semantics.

For example, `opacity` is close to direct source semantics. `frame` is a web
approximation because CSS layout is not SwiftUI's proposal-based layout system.

### 12.3 Compatibility modifiers

Vune also keeps useful web-oriented compatibility APIs:

```ts
Text("Hello")
  .fontSize(24)
  .foreground("#111")
  .className("title")
  .style({ letterSpacing: "0.02em" })
```

The compatibility set includes `margin`, `gap`, `fontSize`, `foreground`,
`style`, `className`, `withProps`, `keyed`, `elementRef`, and
`continuousCorners`.

They are real supported APIs, but they are deliberately not counted as SwiftUI
parity.

---

## 13. Styling: use the browser when the browser is better

Vune does not try to replace CSS.

Use semantic or common modifiers when they make the source clearer. Use
`.style()` for a one-off inline CSS value. Use `.className()` for selectors,
pseudo-classes, media queries, keyframes, reusable classes, or a design system.

### 13.1 Inline styles

```ts
Text("Status")
  .style({
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    userSelect: "none",
    "--status-accent": "#5c7cfa",
  })
```

### 13.2 CSS classes

```ts
Text("Card")
  .className(["card", selected.value && "card--selected"])
```

```css
.card {
  border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  border-radius: 14px;
}

.card:hover {
  transform: translateY(-1px);
}

@media (max-width: 640px) {
  .card {
    border-radius: 10px;
  }
}
```

### 13.3 CSS Modules

```ts
import styles from "./Card.module.css"

Text("Card").className(styles.card)
```

### 13.4 Sass, PostCSS, and Tailwind

The Vune compiler leaves stylesheet modules to Vite. Sass, PostCSS, Tailwind,
and other normal Vite CSS tooling remain host concerns. Vune does not require a
parallel styling compiler.

---

## 14. Animation

Animation is renderer-independent at the authoring boundary.

```ts
import { Animation, withAnimation } from "vune-ui"
```

State writes snapshot the current mutation transaction so an asynchronous
renderer update does not lose the animation chosen when the value changed.

### 14.1 Explicit value-triggered animation

```ts
Text("Connected")
  .opacity(connected.value ? 1 : 0.35)
  .animation(
    .spring(response: 0.42, dampingFraction: 0.82),
    value: connected.value,
  )
```

The implicit-member animation syntax lowers to `Animation.spring(...)`.

### 14.2 Vune automatic animation

Vune additionally supports parameterless `.animation()` as a Vune extension.

```ts
Circle()
  .scaleEffect(active.value ? 1 : 0.8)
  .opacity(active.value ? 1 : 0.4)
  .animation()
```

The compiler records the properties implied by the modifier chain. The Web
renderer compares the real style/DOM change and selects appropriate motion
channels. This signature is intentionally excluded from the SwiftUI parity
claim.

### 14.3 Mutation-scoped animation

```ts
Button("Expand") {
  withAnimation(Animation.spring(0.45, 0.8), () => {
    expanded.value = !expanded.value
  })
}
```

This is the Vune equivalent of choosing animation at the mutation transaction
instead of attaching it only to one View.

### 14.4 Independent property ownership

The Web motion engine keeps animation ownership by element and property. An
opacity retarget does not have to cancel an unrelated transform, color, path,
or layout animation.

That matters when one View is doing several things at once:

```ts
Card()
  .opacity(visible.value ? 1 : 0)
  .scaleEffect(selected.value ? 1.04 : 1)
  .offset(x: dragging.value ? 24 : 0, y: 0)
  .animation()
```

### 14.5 Renderer differences

The Web renderer is the reference implementation for property-aware motion,
retargeting, layout projection, path morphing, and explicit trigger handling.
React and Vue consume the same core `Animation` and `Transaction` contract but
currently use simpler renderer-native style-transition fallbacks for parts of
the motion surface.

Do not assume that a complex Web-only motion proof already has identical
React/Vue host behavior.

---

## 15. Transition versus content transition

These solve different problems.

`Transition` describes insertion and removal of a View.

`ContentTransition` describes replacement inside a View whose identity stays
stable.

### 15.1 Content interpolation

```ts
Text(status.value)
  .contentTransition(.interpolate)
  .animation(.spring(response: 0.42, dampingFraction: 0.78), value: status.value)
```

### 15.2 Numeric text

```ts
Text(String(score.value))
  .contentTransition(.numericText(value: score.value))
  .animation()
```

### 15.3 Blur replace

```ts
Text(status.value)
  .contentTransition(.blurReplace(radius: 8))
  .animation()
```

### 15.4 Push

```ts
Text(pageTitle.value)
  .contentTransition(.push(from: .trailing))
  .animation()
```

Leading and trailing can respect computed text direction in the Web renderer.

---

## 16. Symbols and path morphing

Vune can treat vector icon geometry as persistent content rather than replacing
one whole SVG tree with another.

### 16.1 Lucide data

```ts
import { Pause, Play } from "@lucide/icons"
import { Image, VectorSymbol } from "vune-ui"

const play = VectorSymbol.fromLucide(Play)
const pause = VectorSymbol.fromLucide(Pause)

Image(playing.value ? pause : play)
  .contentTransition(.symbolEffect(.magicReplace(fallback: .downUp)))
  .animation(.spring(response: 0.28, dampingFraction: 0.86), value: playing.value)
```

No Lucide runtime bridge is required. Vune consumes the icon geometry and
retains stable source keys when available.

### 16.2 Custom SVG node data

```ts
const search = VectorSymbol.fromSVGNodes([
  ["circle", {
    cx: 11,
    cy: 11,
    r: 6.5,
    stroke: "currentColor",
    fill: "none",
  }],
  ["line", {
    x1: 16,
    y1: 16,
    x2: 21,
    y2: 21,
    stroke: "currentColor",
  }],
], { name: "search", viewBox: "0 0 24 24" })
```

### 16.3 `Path` is animatable too

```ts
Path(currentPath.value)
  .animation()
```

The Web renderer can morph `d` directly, normalize contour topology, and
retarget from the current presentation shape. Geometry confidence determines
whether spring overshoot can safely affect the silhouette.

---

## 17. Raw web primitives

Some browser concepts do not pretend to be SwiftUI APIs. They live explicitly
under `@vune-ui/core/web-primitives`.

```ts
import {
  Audio,
  Canvas,
  ContentEditable,
  FilePicker,
  FocusScope,
  Popover,
  Svg,
  Video,
} from "@vune-ui/core/web-primitives"
```

`TextEditor` and `Path` are also web-backed primitives, but they are exported
from the canonical root because they participate in the current SwiftUI-derived
and animatable source surface.

### 17.1 File picker

Use the dedicated primitive when the browser concept itself is what you need,
rather than creating a generic raw `<input type="file">` wrapper in every
feature.

### 17.2 Canvas and media

`Canvas`, `Video`, and `Audio` preserve the semantic boundary in core while the
Web renderer owns host behavior.

### 17.3 Focus scope

`FocusScope` expresses a graph-level focus boundary. DOM focus trapping and
restoration stay inside the Web package rather than leaking browser calls into
feature Views.

### 17.4 Popover

`Popover` is likewise a browser-oriented primitive. Use the graph abstraction
when possible instead of manually spreading imperative DOM popover state through
application code.

---

## 18. Accessibility and native HTML semantics

Vune does not replace semantic HTML with generic divs by default. Raw HTML and
built-in controls preserve native roles and attributes where practical.

### 18.1 Accessibility modifiers

```ts
Image(icon)
  .accessibilityLabel("Search")
  .accessibilityHint("Search all messages")
  .accessibilityIdentifier("global-search")
```

### 18.2 Raw ARIA and data attributes

```ts
Element("button", {
  type: "button",
  "aria-pressed": selected.value,
  "data-item-id": item.id,
  onclick: select,
}, "Select")
```

Web boolean attributes follow browser semantics. `aria-*` and `data-*` values
retain their string/attribute meaning rather than being treated exactly like
HTML boolean attributes.

### 18.3 SVG namespaces

SVG descendants use the SVG namespace, while `foreignObject` switches its
children back to HTML. XML/XLINK attributes retain their native namespaces.

---

## 19. Direct Web rendering

Use `@vune-ui/web` when you want Vune to own the browser rendering boundary
without React or Vue.

The public root is intentionally small:

```ts
import { mount, renderToHTML } from "@vune-ui/web"
```

### 19.1 Mount

```ts
import { mount } from "@vune-ui/web"
import App from "./App.vune"

const target = document.getElementById("app")!
mount(App, target)
```

### 19.2 Server rendering

```ts
import { renderToHTML } from "@vune-ui/web"

const html = renderToHTML(App)
```

### 19.3 Hydration

```ts
mount(App, target, { hydrate: true })
```

Hydration treats the client graph as authoritative for attributes and
properties. Structurally compatible server DOM is reused, events and refs are
attached, stale attributes are removed, and subsequent State invalidation stays
live.

### 19.4 Fine-grained Web invalidation

The direct Web renderer tracks State reads at View boundaries. Dirty boundaries
are batched into one microtask and processed parent-first, allowing an ancestor
update to absorb redundant child work.

Compiler-proven State-only dynamic slots can go further and patch specific text
or host locations without evaluating every dynamic slot in the body.

---

## 20. React integration

React is a first-class renderer and interop boundary, but it is not Vune's core
View model.

```ts
import {
  Component,
  VuneView,
  createReactView,
  fromReactState,
  mount,
  reactComponent,
  useVuneState,
} from "@vune-ui/react"
```

### 20.1 Render a Vune graph inside React

```tsx
import { VuneView } from "@vune-ui/react"
import { Text, VStack } from "vune-ui"

function ReactScreen() {
  return (
    <VuneView
      render={() => VStack(
        Text("Rendered from Vune"),
      )}
    />
  )
}
```

The exact React wrapper shape can also be produced with `createReactView` when
you want a reusable React component boundary.

### 20.2 Put a React component inside Vune

```ts
import { Component } from "@vune-ui/react"

function ProfileCard(props: { name: string }) {
  return React.createElement("strong", null, props.name)
}

HStack() {
  Text("Profile")
  Spacer()
  Component(ProfileCard, { name: "Vune" })
    .padding(12)
}
```

Vune owns the component's external layout slot. React keeps ownership of the
component's props, hooks, context, refs, children, and internal rendering.

### 20.3 Why the layout host exists

Suppose a React component returns several nested DOM elements. Vune cannot
safely push `.frame(...)` or `.padding(...)` into arbitrary internal props.
Instead, a neutral Vune layout host receives those modifiers while React keeps
the component implementation intact.

### 20.4 React state bridges

Use `useVuneState` when a React component needs to subscribe to Vune State.
Use `fromReactState` when you need to adapt a React `[value, setter]` pair to a
Vune Binding.

Do not mirror the same state into both systems unless there is a real ownership
boundary requiring it.

### 20.5 React Vite configuration

```ts
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { vunePlugin } from "@vune-ui/vite"

export default defineConfig({
  plugins: [
    vunePlugin(),
    react(),
  ],
})
```

Vune's transform runs before the React plugin.

---

## 21. Vue integration

Vue can host a Vune graph without redefining its State or View semantics.

```ts
import {
  Component,
  VuneView,
  createVueView,
  fromVueRef,
  mount,
  toVueRef,
} from "@vune-ui/vue"
```

### 21.1 Vune inside a Vue SFC

```vue
<script setup lang="ts">
import { Button, State, Text, VStack } from "vune-ui"
import { VuneView } from "@vune-ui/vue"

const count = State(0)

const graph = () => VStack() {
  Text(`Count: ${count.value}`)
  Button("Increment") {
    count.value += 1
  }
}
</script>

<template>
  <VuneView :render="graph" />
</template>
```

### 21.2 Vue components inside Vune

Use the Vue adapter's `Component` / foreign-component helpers. Vue continues to
own its slots, lifecycle, provide/inject, transitions, teleport, and component
reactivity after the graph crosses that boundary.

### 21.3 Vue ref bridges

`toVueRef` and `fromVueRef` make ownership explicit when data crosses between
Vune State and Vue reactivity.

### 21.4 Vue Vite configuration

```ts
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"
import { vunePlugin } from "@vune-ui/vite"

export default defineConfig({
  plugins: [
    vunePlugin(),
    vue(),
  ],
})
```

The Vune adapter can lower Vune syntax in Vue script blocks while leaving the
Vue template and stylesheet modules to Vue/Vite.

---

## 22. Choosing a renderer

Choose direct Web when:

- the application is primarily Vune;
- you want the smallest conceptual runtime stack;
- you want the reference fine-grained DOM, hydration, lazy-windowing, and
  property-aware animation implementation;
- React/Vue ecosystem ownership is not required for the surrounding app.

Choose React when:

- the application already has a React root;
- React context, hooks, components, or libraries are an important part of the
  application boundary;
- you are migrating incrementally and need Vune to live beside React.

Choose Vue when:

- the application already has a Vue root or SFC architecture;
- Vue components, slots, provide/inject, or ecosystem libraries remain useful;
- Vune is being adopted incrementally inside a Vue application.

The application should not select a renderer because one View needs one host
feature. Use the renderer that owns the surrounding application boundary and
cross into foreign components deliberately.

---

## 23. Navigation and presentation

The current navigation primitives are deliberately small. `NavigationStack`
provides a structural navigation container and `NavigationLink` produces a
destination link. There is no router argument in the current core initializer.

```ts
NavigationStack() {
  VStack() {
    NavigationLink("/profile", "Profile")
    NavigationLink("/settings", "Settings")
  }
}
```

Applications that use a client router can integrate it at the host boundary or
through foreign components without changing Vune's core View semantics.

### 23.1 Sheet

```ts
const showingDetails = State(false)

Sheet(Binding(showingDetails)) {
  DetailsView()
}
```

### 23.2 Alert

```ts
const showingDelete = State(false)

Alert(
  Binding(showingDelete),
  "Delete item?",
  "This cannot be undone.",
)
```

### 23.3 Menu

```ts
Menu("Actions") {
  Button("Edit") { edit() }
  Button("Delete") { remove() }
}
```

At the semantic graph level, `Sheet` and `Alert` use dialog-like presentation
nodes and `Menu` uses a details/menu structure. Renderer packages own the host
materialization details.

---

## 24. What the compiler actually does

The compiler is not only a syntax preprocessor. It has three jobs:

1. lower Vune source features that JavaScript does not natively understand;
2. produce diagnostics and source maps in original Vune source space;
3. specialize proven graph work without changing semantics when proof fails.

### 24.1 Syntax lowering

The compiler handles:

- trailing ViewBuilder and Action blocks;
- Swift-style labeled arguments;
- implicit-member shorthand such as `.leading` and `.spring(...)`;
- `$binding` shorthand;
- conditionals and statement-bearing ViewBuilder blocks;
- `ForEach(items) { item in ... }` syntax;
- `struct Name: View` declarations;
- `@State`, `@Binding`, `@ViewBuilder`, and `@Action` fields/parameters;
- raw HTML inside Vune source;
- source-ranged diagnostics and maps.

### 24.2 Initializer specialization

When static type information proves one initializer, the compiler can emit a
direct initializer-index path instead of repeating runtime overload scanning.

When the value is `any`, `unknown`, variadic, ambiguous, or otherwise unsafe to
prove, Vune falls back to guarded specialization or ordinary runtime resolution.

Correctness does not depend on optimization succeeding.

### 24.3 Modifier fusion

Statically typed modifier chains can be lowered to compact immutable
descriptors, reducing repeated graph wrapper work.

### 24.4 Compiled templates

Proven intrinsic host trees can become immutable templates plus dynamic slots.
React, Vue, Web DOM, and Web SSR can use cached native template factories while
re-entering generic graph traversal only for the dynamic positions.

### 24.5 Static subtree hoisting

Fully static View subtrees can be hoisted to module scope and reused.

### 24.6 State dependency metadata

The compiler only marks a dependency set complete when it can prove a closed
set. Otherwise runtime dependency collection remains active. A partial static
hint must never cause Vune to miss a real State dependency.

---

## 25. Vune is not a Virtual DOM framework in the usual sense

It is tempting to summarize every declarative web framework as VDOM plus state.
That description loses important Vune behavior.

Vune does have an immutable graph representation and generic reconciliation
fallbacks. But the direct Web path also includes:

- State reads attached to View boundaries;
- dirty-boundary batching;
- parent-first invalidation;
- compiled template factories;
- direct State-to-Patch-IR slot updates where proven;
- persistent keyed identity independent of a renderer;
- lazy viewport windowing;
- per-property animation ownership.

The graph is therefore a semantic IR from which several execution strategies
can be chosen, not merely a mandatory clone-and-diff DOM shadow tree.

---

## 26. Performance model

The fastest Vune code usually comes from preserving semantic information rather
than manually micro-optimizing generated DOM.

### 26.1 Prefer stable identity

```ts
ForEach(rows.value, key: row => row.id) { row in
  Row(row)
}
```

Stable keys let Vune retain State and host identity during reorder.

### 26.2 Keep State ownership narrow

A State read makes a View boundary dependent on that State. Do not read a large
global State object high in the tree only to pass a tiny derived value through
many descendants when the dependency can live closer to the consumer.

### 26.3 Use lazy containers for genuinely long collections

Do not use `LazyVStack` merely because it sounds faster. For small lists the
normal graph is simpler. Lazy behavior matters when mounting the full collection
would be meaningful work.

### 26.4 Let the compiler keep its proof boundaries

Do not replace typed values with `any` everywhere and then expect the compiler
to retain unique initializer or template proofs. Clear types improve both
editor behavior and optimization opportunities.

### 26.5 Avoid unnecessary renderer crossings

Crossing from Vune into React/Vue components is supported, but a tree that
alternates ownership every row can lose opportunities available to one
renderer-controlled region.

Use interop where ownership genuinely changes.

---

## 27. Resident Compute: experimental data-oriented acceleration

Resident Compute is separate from ordinary View rendering.

It exists for numeric regions where data can stay in a packed representation
long enough for a faster backend to repay its boundary costs.

```text
packed producer
    |
    v
ResidentRegionIR
    |
    +--> packed JS
    +--> WASM SIMD       experimental
    +--> Worker/WASM     experimental
    `--> WebGPU          experimental, renderer-sink dependent
```

### 27.1 What does not qualify

This does **not** mean Vune moves an ordinary object array to WASM because the
body contains arithmetic.

An object-backed `State<T[]>` mapped into DOM rows has costs including:

- packing objects;
- crossing a native boundary;
- reconstructing objects or patches;
- DOM work;
- synchronization or readback.

Those costs can easily exceed the arithmetic benefit.

### 27.2 Packed JavaScript is the baseline

The mandatory optimized baseline is fused TypedArray JavaScript. Native
promotion must beat that end-to-end, not a deliberately slow object interpreter.

### 27.3 Adaptive native scheduling

Eligible dense `f32` regions can carry direct scalar and SIMD WebAssembly
specializations. The scheduler uses actual dirty rows, compiler-known weighted
kernel cost, SIMD suitability, and measured crossover data.

Small or sparse dirty ranges should often stay in packed JS.

### 27.4 WebGPU

WebGPU makes sense when the producer, compute, and render consumer can keep the
authoritative buffer on the GPU. A GPU compute pass followed by CPU readback
only to create normal DOM nodes is usually the wrong architecture.

### 27.5 Feature toggle

Native Resident Compute backends are disabled by default.

```ts
createVuneVitePlugin({ experimentalResidentCompute: true })

mount(App(), container, {
  experimentalResidentCompute: true,
})
```

Backend-level execution options can further gate WASM, Worker, and GPU use.

Treat every API in this area as experimental unless the public API documents
promote it later. See [RESIDENT_COMPUTE.md](./RESIDENT_COMPUTE.md).

---

## 28. A complete application example

The following combines State, Binding, async updates, Grid, a custom View,
filtering, keyed collections, and lazy rendering.

```ts
import {
  Binding,
  Button,
  ForEach,
  Grid,
  LazyVStack,
  ProgressView,
  State,
  Text,
  TextField,
  Toggle,
  VStack,
} from "vune-ui"

type Module = {
  id: string
  title: string
  detail: string
}

const query = State("")
const enabled = State(true)
const loading = State(false)
const refreshes = State(0)
const modules = State<Module[]>([
  { id: "compiler", title: "Compiler", detail: "Source lowering" },
  { id: "runtime", title: "Runtime", detail: "State and identity" },
  { id: "web", title: "Web", detail: "DOM and hydration" },
])

struct MetricCard: View {
  let label: string
  let value: string

  init(_ label: string, value: string) {
    self.label = label
    self.value = value
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.caption)
      Text(value).font(.title)
    }
    .padding(12)
  }
}

struct Dashboard: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      const normalized = query.value.trim().toLowerCase()
      const filtered = normalized
        ? modules.value.filter(module =>
            `${module.title} ${module.detail}`
              .toLowerCase()
              .includes(normalized))
        : modules.value

      Text("Framework health")
        .font(.title)

      Grid({ columns: 3 }) {
        MetricCard("Visible", value: String(filtered.length))
        MetricCard("Refreshes", value: String(refreshes.value))
        MetricCard("Mode", value: enabled.value ? "Enabled" : "Paused")
      }

      TextField(Binding(query), "Filter modules")
      Toggle("Enable live updates", isOn: Binding(enabled))

      Button(loading.value ? "Refreshing…" : "Refresh") {
        if (!loading.value) {
          loading.value = true
          setTimeout(() => {
            refreshes.value += 1
            loading.value = false
          }, 250)
        }
      }

      ProgressView(loading.value ? 0.5 : 1, { max: 1 })

      LazyVStack({
        alignment: "leading",
        spacing: 8,
        estimatedItemSize: 56,
        overscan: 2,
      }) {
        ForEach(filtered, key: module => module.id) { module in
          VStack(alignment: .leading, spacing: 2) {
            Text(module.title).bold()
            Text(module.detail)
          }
          .padding(10)
          .className("module-row")
        }
      }
    }
    .padding(24)
  }
}

export default Dashboard()
```

The important part is not the exact visual result. It is that the application
logic remains ordinary TypeScript while View production, bindings, identity,
layout, and rendering stay in Vune's semantic model.

---

## 29. Migration from React

Do not mechanically translate JSX tag-for-tag. Translate ownership and intent.

### 29.1 React state

React:

```tsx
const [query, setQuery] = useState("")
```

Vune:

```ts
const query = State("")
```

### 29.2 Controlled input

React:

```tsx
<input
  value={query}
  onChange={event => setQuery(event.target.value)}
/>
```

Vune:

```ts
TextField(Binding(query), "Search")
```

### 29.3 Conditional children

React:

```tsx
{loading ? <Spinner /> : <Results />}
```

Vune:

```ts
VStack() {
  if (loading.value) {
    Spinner()
  } else {
    Results()
  }
}
```

### 29.4 Lists

React:

```tsx
{items.map(item => <Row key={item.id} item={item} />)}
```

Vune:

```ts
ForEach(items.value, key: item => item.id) { item in
  Row(item)
}
```

### 29.5 Keep React where it still owns something

You do not have to rewrite a mature React component only to put it on a Vune
screen.

```ts
Component(ExistingReactEditor, { document })
  .frame(maxWidth: .infinity)
```

Migrate the ownership boundary when it becomes useful, not because mixed trees
are forbidden.

---

## 30. Migration from Vue

The same principle applies: translate ownership, not syntax cosmetics.

### 30.1 Vue ref to Vune State

Vue:

```ts
const enabled = ref(false)
```

Vune:

```ts
const enabled = State(false)
```

### 30.2 `v-model`

Vue:

```vue
<input v-model="query" />
```

Vune:

```ts
TextField(Binding(query), "Search")
```

### 30.3 `v-for`

Vue:

```vue
<Row
  v-for="item in items"
  :key="item.id"
  :item="item"
/>
```

Vune:

```ts
ForEach(items.value, key: item => item.id) { item in
  Row(item)
}
```

### 30.4 Keep SFC boundaries when useful

```vue
<script setup lang="ts">
import { VuneView } from "@vune-ui/vue"
import { buildSettingsGraph } from "./settings.vune"
</script>

<template>
  <ExistingVueShell>
    <VuneView :render="buildSettingsGraph" />
  </ExistingVueShell>
</template>
```

This is a valid migration architecture. Vue remains the shell owner while the
feature graph moves into Vune.

---

## 31. Translation from SwiftUI

Vune intentionally makes many translations nearly mechanical, but web fidelity
still has to be considered.

SwiftUI:

```swift
VStack(alignment: .leading, spacing: 12) {
    Text("Settings")
        .font(.title)

    Toggle("Notifications", isOn: $notifications)

    Button("Save") {
        save()
    }
}
.padding(24)
```

Vune:

```ts
VStack(alignment: .leading, spacing: 12) {
  Text("Settings")
    .font(.title)

  Toggle("Notifications", isOn: $notifications)

  Button("Save") {
    save()
  }
}
.padding(24)
```

What should not be translated blindly:

- proposal-sensitive layout assumptions;
- platform-specific navigation and presentation behavior;
- Environment APIs not currently in the canonical Vune surface;
- advanced native gestures and preference systems;
- arbitrary custom SwiftUI protocol implementations;
- any familiar API name not represented in Vune's parity manifest.

See [SWIFTUI_PARITY.md](./SWIFTUI_PARITY.md) before assuming a same-name API has
full source or behavior parity.

---

## 32. Common mistakes

### 32.1 Passing a Vune graph directly to React DOM

Wrong:

```ts
createRoot(target).render(Text("Hello"))
```

A core Vune graph is not a React element.

Use `VuneView`, `createReactView`, the React renderer's `mount`, or a React
adapter boundary.

### 32.2 Treating every SwiftUI-looking name as canonical parity

`Grid`, `Image`, `Picker`, and several other familiar names are useful Vune
Views, but a familiar spelling alone does not put them in the current canonical
SwiftUI manifest.

### 32.3 Using object identity as a list key

Use a stable primitive application identity when possible.

```ts
key: item => item.id
```

### 32.4 Using `any` across an otherwise statically provable tree

The runtime will often still work, but the compiler may have to give up direct
initializer or template specialization.

### 32.5 Rebuilding browser primitives manually in feature code

Before writing raw imperative DOM for focus scopes, file picking, media, SVG,
popovers, or text editing, check the canonical or web-primitives packages.

### 32.6 Assuming WASM is always faster

Tiny or sparse numeric work should often remain packed JavaScript. Object/DOM
boundaries can erase any arithmetic win. Resident Compute promotion is based on
the complete residency region, not on enthusiasm for a backend.

### 32.7 Reversing the custom Button labels

Use:

```ts
Button(action: { save() }, label: { Text("Save") })
```

not:

```ts
Button(label: { Text("Save") }, action: { save() })
```

---

## 33. Debugging and editor tooling

### 33.1 Vune language server

```sh
vune-ui lsp --stdio
```

### 33.2 Install editor integration

```sh
npx vune-ui editor install --editor all
```

### 33.3 VS Code extension package

```sh
pnpm vscode:package
```

The language service uses the compiler's semantic model, diagnostics, lowered
snapshot, and source-position mapping instead of maintaining a separate syntax
interpretation.

### 33.4 Web DevTools overlay

Development builds can expose the Vune DevTools instrumentation used by the Web
renderer. The host integration can enable profiling explicitly; disabled
instrumentation is intended to remain cheap.

The recorded data includes View-body evaluation, dependencies, DOM node counts,
and render timing at Vune boundaries.

---

## 34. Testing a Vune application or framework change

Inside the Vune repository, the broad test command is:

```sh
pnpm test
```

Useful narrower commands include:

```sh
pnpm test:docs
pnpm test:packages
pnpm test:runtime
pnpm test:animation
pnpm demo:all:build
pnpm benchmark:performance
pnpm benchmark:resident
pnpm benchmark:resident:native
pnpm benchmark:browser
```

For SwiftUI manifest work:

```sh
pnpm snapshot:swiftui
pnpm check:swiftui-manifest
pnpm check:swiftui-snapshot
```

Benchmark thresholds in the repository are regression guards, not universal
claims that one renderer is always a fixed multiple faster than another.

---

## 35. Package map

| Package | Use it for |
| --- | --- |
| `vune-ui` | normal renderer-independent authoring |
| `@vune-ui/core` | direct core graph imports and framework-level work |
| `@vune-ui/compiler` | compiler, diagnostics, semantic and language-service tooling |
| `@vune-ui/vite` | Vite transform integration |
| `@vune-ui/web` | direct DOM mount and HTML serialization |
| `@vune-ui/react` | React rendering and React interop |
| `@vune-ui/vue` | Vue rendering and Vue interop |
| `@vune-ui/animation` | shared motion engine implementation |
| `@vune-ui/execution` | experimental resident execution substrate |
| `vune-ui/legacy` | explicit legacy React compatibility surface |
| `vune-ui/experimental` | experimental layout/plugin/metadata infrastructure |

Application code should usually begin with `vune-ui`, then import exactly one
renderer package at the application boundary.

---

## 36. A practical API map

### Core composition

```text
Text
VStack / HStack / ZStack
ScrollView / SafeArea / GeometryReader
Spacer / Divider / Group
Element
ForEach
List / Section
LazyVStack / LazyHStack
```

### Additional layout and visuals

```text
Box
Grid / LazyGrid
Rectangle / Circle / Capsule / RoundedRectangle
```

### Controls

```text
Button
TextField / TextEditor / TextArea
Toggle / Switch
Slider / Stepper / Picker
Image / Label / Link / ProgressView
```

### State and actions

```text
State
Binding
Action
withAnimation
withTransaction
Transaction
```

### Motion and replacement

```text
Animation
Transition
ContentTransition
SymbolEffect
VectorSymbol
Path
```

### Presentation

```text
NavigationStack / NavigationLink
Sheet / Alert / Menu
```

For exact signatures, overloads, fidelity, and compatibility notes, use
[API.md](./API.md) and the source manifest rather than treating this map as a
type declaration.

---

## 37. Mental models worth keeping

If you remember only a few things after reading this guide, remember these:

**A Vune View is a graph value.** It is not a React component instance, Vue
VNode, or DOM element.

**State belongs to Vune, not to the renderer.** React and Vue can bridge it, but
they do not redefine its semantics.

**Initializers are real contracts.** Labels, closure roles, defaults, and types
drive compiler and runtime behavior.

**Identity is logical and renderer-independent.** Stable collection keys are
there to preserve application identity, not merely silence a warning.

**SwiftUI source resemblance is not a promise of native layout equivalence.**
Vune maps source intent onto browser semantics and documents fidelity explicitly.

**Compiler optimization is proof-driven.** An optimization may disappear when
the compiler cannot prove it, but correct rendering must not.

**WASM and WebGPU are residency decisions, not magic switches.** The packed
producer-to-consumer region has to remain native long enough to repay transfer,
materialization, and synchronization costs.

With those rules in place, the rest of Vune becomes much easier to reason about.

---

## 38. Further reading

- [Getting started](./GETTING_STARTED.md)
- [Tutorial](./TUTORIAL.md)
- [Public API](./API.md)
- [Semantic contract](./SEMANTICS.md)
- [Architecture](./ARCHITECTURE.md)
- [SwiftUI parity](./SWIFTUI_PARITY.md)
- [Styling](./STYLING.md)
- [Migration](./MIGRATION.md)
- [Compiler optimization](./COMPILER_OPTIMIZATION.md)
- [Resident Compute](./RESIDENT_COMPUTE.md)
- [Validation](./VALIDATION.md)
- [Roadmap](./ROADMAP.md)

