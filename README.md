# Mün UI

Mün is a **SwiftUI-inspired JavaScript frontend framework**. Compose Views with
stacks, controls, reactive state, and chainable modifiers; render them to the DOM
with `@mun/web`. It runs in a regular browser application using JavaScript, HTML,
and CSS, without a native host, Rust toolchain, React, or Vue requirement.

```text
JavaScript / TypeScript View builders ───────────────┐
.mun SwiftUI-like syntax -> @mun/compiler -> JS ─────┤
                                                   v
                                          @mun/core View graph
                                                   v
                                           @mun/web -> DOM
```

The web-first Vune architecture is the reference for this direction (see commits
`798c5a6`, `ac8447e`, and `965276f`). Mün keeps its SwiftUI-like composition model;
it is not a React wrapper. React, Vue, and Astro integrations remain optional.

## Quick start

Use Node.js 20.19 or newer and a package manager:

```bash
npm install -g @mun/ui
mun create HelloMun
cd HelloMun
npm run dev
```

`mun new`, `mun create`, `mun init`, and `npm create mun` default to a normal
Vite web project. Dependency installation runs automatically unless you pass
`--no-install`. Edit `src/App.mun`; the Vite plugin compiles the SwiftUI-like
syntax to JavaScript. `npm run build` creates deployable static web assets.

```swift
import { Button, State, Text, VStack } from "@mun/core"

const count = State(0)

struct Counter: View {
  var body: some View {
    VStack(spacing: 12) {
      Text('Hello, Mün')
      Text(`Count: ${count.value}`)
      Button('Increase') { count.value += 1 }
    }
  }
}

export default Counter()
```

You can also author Views directly in JavaScript or TypeScript, without the
`.mun` compiler. Import the authoring API from `@mun/core` (or `@mun/ui`) and
`mount` / `renderToHTML` from `@mun/web`. Rendering is explicitly separate from
View composition; `@mun/core/compat` remains an alias for existing imports.

## Local development

```bash
pnpm install
pnpm build
pnpm dev:create ../HelloMun --no-install
cd ../HelloMun
pnpm install
pnpm dev
```

For an existing project, use `mun link <path> --renderer web` from the checkout.
`pnpm dev:watch` rebuilds workspace packages while developing the framework.
Run `pnpm test` for the full suite and `pnpm demo:web:build` for the web demo.

## Experimental native area

The Rust native runtime, Semantic UI IR pipeline, native packaging, and native
hot-reload work are retained as **experimental**, not the default frontend or a
prerequisite for web development. Opt in with:

```bash
mun create NativeExperiment --target native
cd NativeExperiment
mun dev
```

Native `mun dev/run/check/build/package` workflows use `mun.toml` and
`Sources/App.mun`. Their support and limitations are documented in
[Native projects](docs/native-projects.md) and
[Native architecture](docs/NATIVE_ARCHITECTURE.md). Resident Compute Islands are
also optional research infrastructure, not the core authoring model.

## Documentation

- [Getting started](docs/GETTING_STARTED.md)
- [Architecture](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [SwiftUI parity](docs/SWIFTUI_PARITY.md)
- [Local development](docs/LOCAL_DEVELOPMENT.md)
- [Migration](docs/MIGRATION.md)
