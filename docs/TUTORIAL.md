# Build a native Mün screen

This tutorial follows the canonical path:

```text
.mun -> Mün compiler -> Semantic UI IR -> native runtime
```

No React, Vue, HTML, DOM, or CSS is required.

## 1. Create a standalone Mün file

Create `App.mun`:

```mun
const expanded = State(false)

struct App: View {
  var body: some View {
    VStack(spacing: 16) {
      Text("Mün")
      Button("Toggle") {
        expanded.value = !expanded.value
      }

      Rectangle()
        .frame(width: expanded.value ? 320 : 160, height: 96)
        .background("#6750A4")
        .cornerRadius(18)
        .animation(Animation.spring(0.48, 0.82), expanded.value)

      if (expanded.value) {
        Text("Expanded")
      } else {
        Text("Collapsed")
      }
    }
    .padding(24)
  }
}

export default App()
```

`.mun` is the canonical source extension. Raw HTML is not valid Mün syntax.

## 2. Compile to Semantic UI IR

The repository exposes `compileMunUiProgram(source, fileName)` from
`@mun/compiler`. The native demo build script uses that same compiler path to
serialize the fixture into `native/generated/NativeDemo.json`.

The compiler parses the builder syntax, resolves Mün Views, state, actions, and
modifiers, and produces backend-neutral Semantic UI IR.

The IR contains semantic nodes and properties. It does not contain browser tags
or CSS declarations.

## 3. Run with the native host

Build the checked-in native vertical slice and run its generated IR:

```bash
./scripts/build-native-demo.sh
./native/target/debug/mun-native native/generated/NativeDemo.json
```

The fixture `examples/NativeDemo.mun` is compiled through the same canonical
Semantic UI IR boundary before the native runtime consumes it.

## 4. Add state and actions

State is a Mün concept:

```mun
const enabled = State(false)

Button("Toggle") {
  enabled.value = !enabled.value
}
```

The compiler records the state and action in the semantic program. The runtime
applies the mutation and re-evaluates the affected semantic values.

## 5. Add animation

Animation is represented in the same semantic program:

```mun
Rectangle()
  .frame(width: enabled.value ? 280 : 140, height: 80)
  .animation(Animation.spring(0.5, 0.82), enabled.value)
```

The native runtime executes the shared renderer-neutral motion plan directly.
A secondary Web backend can lower the same motion intent to browser execution
without changing the Mün source language.

## Secondary Web and Astro use

Web and Astro remain supported targets, but they consume Mün rather than define
it. Standalone `.mun` source and Astro `@mun { ... }` regions must pass
through the same compiler and semantic model.

Browser markup and styles stay on the host/Web side of that boundary.
