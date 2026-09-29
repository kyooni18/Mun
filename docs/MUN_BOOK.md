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
import { Text, VStack } from "@mun/core"

struct Greeting: View {
  var body: some View {
    VStack(spacing: 8) {
      Text("Hello")
      Text("Mün")
    }
    .padding(20)
  }
}

export default Greeting()
```

Builders collect semantic Views. Custom Views and built-in Views lower through
the same compiler.

## 3. State and actions

```mun
import { Button, State, Text, VStack } from "@mun/core"

const count = State(0)

struct Counter: View {
  var body: some View {
    VStack(spacing: 12) {
      Text(count.value)
      Button("Increase") {
        count.value = count.value + 1
      }
    }
  }
}

export default Counter()
```

State is owned by Mün semantics. A backend executes state changes; it does not
redefine them.

## 4. Layout and visuals

Stacks, frame constraints, padding, spacing, alignment, backgrounds, foreground
values, and corner radii describe semantic intent.

```mun
Rectangle()
  .frame(width: 240, height: 96)
  .background("#6750A4")
  .cornerRadius(18)
```

These are not CSS declarations. A native backend maps them to native layout and
scene properties. The Web backend may map them to browser representation after
semantic compilation.

## 5. Animation

```mun
Rectangle()
  .frame(width: expanded.value ? 320 : 160, height: 96)
  .animation(Animation.spring(0.48, 0.82), expanded.value)
```

Mün preserves renderer-neutral motion semantics across backends.

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
migration surface, not the language specification.

## 10. Where to continue

Read [DESIGN.md](./DESIGN.md), [SEMANTICS.md](./SEMANTICS.md), and
[NATIVE_ARCHITECTURE.md](./NATIVE_ARCHITECTURE.md). Use
`examples/NativeDemo.mun` as the canonical executable example.
