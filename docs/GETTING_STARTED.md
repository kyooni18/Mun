# Getting started with Mün

Mün is a native-first standalone UI language. Start with a `.mun` file; do not
start with React, Vue, HTML, or CSS.

## Build the repository

```bash
pnpm install
pnpm build
pnpm native:build
```

## Create a screen

```mun
@main
struct App: View {
  @State private var count: Int = 0

  var body: some View {
    VStack(spacing: 12) {
      Text("Count: \(count)")
      Button("Increase") { count = count + 1 }
    }
    .padding(24)
  }
}
```

Save it as `App.mun`.

## Run natively

```bash
pnpm native:run -- App.mun
```

The path is `.mun -> @mun/compiler -> Semantic UI IR -> native runtime`.

## Inspect the IR

```bash
node bin/compile.mjs App.mun
```

The output is backend-neutral. HTML and CSS are not generated until a secondary
Web backend is selected.

## Repository demo

```bash
pnpm native:demo
```

This runs `examples/NativeDemo.mun` through the same compiler and native host.

## Secondary Web and Astro targets

`@mun/web` and `@mun/astro` consume the same Mün compiler/semantic model.
Astro `@mun { ... }` regions contain Mün Views, not host HTML.

Existing React/Vue integrations remain compatibility adapters while the native
path becomes the primary runtime.

For architecture details, read [DESIGN.md](./DESIGN.md) and
[NATIVE_ARCHITECTURE.md](./NATIVE_ARCHITECTURE.md).
