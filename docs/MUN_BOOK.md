# The Mün book

## 1. What Mün is

Mün is a native-first UI language, compiler, runtime, and framework. A
standalone `.mun` file is the primary source unit.

```text
.mun -> compiler -> Semantic UI IR -> native runtime
                              \-> Web/Astro backend
```

The Web path is secondary. Browser technology does not define Mün semantics.

## 2. A first View

```mun
@main
struct Greeting: View {
  var body: some View {
    VStack(spacing: 8) {
      Text("Hello")
      Text("Mün")
    }
    .padding(20)
  }
}
```

A `.mun` file is self-contained: no imports. `@main` marks the entry View.
Builders collect semantic Views, and custom and built-in Views lower through
the same compiler. Spelling follows SwiftUI; see
[SWIFTUI_PARITY.md](./SWIFTUI_PARITY.md) for exactly what is claimed and the
[parity report](./SWIFTUI_PARITY_REPORT.md) for every supported overload.

## 3. State and actions

```mun
@main
struct Counter: View {
  @State private var count: Int = 0

  var body: some View {
    VStack(spacing: 12) {
      Text("Count: \(count)")
      Button("Increase") { count = count + 1 }
    }
  }
}
```

`@State` is storage owned by the View's identity. A Button's closure is a
state action executed by the runtime. A backend executes state changes; it
does not redefine them.

Types are spelled like Swift: `String`, `Int`, `Double`, `Bool`, `[T]`,
`[K: V]` and `T?`. A literal initial value can stand in for the annotation.
`"\(value)"` interpolates.

## 4. Composition, bindings and control flow

```mun
struct SettingRow: View {
  let title: String
  @Binding var isOn: Bool

  var body: some View {
    HStack {
      Toggle(title, isOn: $isOn)
      Spacer()
      Text(isOn ? "On" : "Off")
    }
  }
}

@main
struct Settings: View {
  @State private var wifi: Bool = true
  @State private var mode: String = "auto"

  var body: some View {
    VStack(alignment: .leading) {
      SettingRow(title: "Wi-Fi", isOn: $wifi)
      Divider()
      switch mode {
      case "auto": Text("Automatic")
      default: Text("Manual")
      }
    }
    .padding()
  }
}
```

A child View receives a `@Binding` with `$state`. `private` members are
internal to their View, and `@State` is never set by a caller.

`if`/`else`, the ternary operator and `switch` with literal cases are all
supported. A `switch` must be exhaustive.

## 5. Layout, visuals and motion

```mun
@main
struct Card: View {
  @State private var expanded: Bool = false

  var body: some View {
    RoundedRectangle(cornerRadius: 18)
      .fill(Color(red: 0.4, green: 0.31, blue: 0.64))
      .frame(width: expanded ? 320 : 160, height: 96)
      .animation(.spring(response: 0.48, dampingFraction: 0.82), value: expanded)
      .onAppear { expanded = true }
  }
}
```

Modifier order is observable, as in SwiftUI: `.padding().background(c)` paints
the padding. These are not CSS declarations. The native runtime maps them to
native layout, scene and motion. The Web backend may map them to browser
representation after semantic compilation. `onAppear` runs when the View
becomes present, not on every frame.

## 6. Semantic UI IR

The IR contains backend-neutral state, expressions, UI nodes, layout, visual,
accessibility, action, transaction, and motion metadata.

Platform-specific constructs do not belong in this layer.

## 7. Native runtime

The native runtime owns desktop windows, layout execution, hit testing, input,
accessibility, scene rendering, state mutation, and motion scheduling. It does
not use WebView, DOM, HTML, or CSS internally.

## 8. Web and Astro

Web and Astro consume Mün. They may introduce browser markup and styling after
the semantic boundary.

Astro host markup stays in Astro. An embedded `@mun { ... }` region contains
Mün Views and follows the same compiler path as a standalone `.mun` file.

## 9. Compatibility

The pre-native TypeScript View graph remains available at
`@mun/core/compat` for React, Vue, and existing Web integrations. It is a
migration surface, not the language specification. Canonical `.mun` never
imports it, and its TypeScript spellings (`string`, `T[]`, `export default`)
are compatibility syntax.

## 10. Where to continue

Read [DESIGN.md](./DESIGN.md), [SEMANTICS.md](./SEMANTICS.md), and
[NATIVE_ARCHITECTURE.md](./NATIVE_ARCHITECTURE.md). Use
`examples/NativeDemo.mun` as the canonical executable example.
