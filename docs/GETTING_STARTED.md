# Getting started

Mün is a SwiftUI-inspired JavaScript frontend framework. Start with the web
renderer, a normal Vite application, and Node.js 20.19 or newer:

```bash
npm install -g @mun/ui
mun create HelloMun
cd HelloMun
npm run dev
```

The scaffold installs its dependencies. Use `--no-install` to install manually,
or `--pm pnpm` to select pnpm. `mun new` and `npm create mun` use the same web
template. Edit `src/App.mun` to compose stacks, text, buttons, and state using
SwiftUI-like syntax; Vite compiles this to JavaScript and renders it to the DOM.
Run `npm run build` for static deployment and `npm run preview` to preview it.
No native host or Rust installation is needed.

For direct JS/TS authoring, import View builders from `@mun/core` and `mount`
from `@mun/web`. React and Vue are optional integrations, not dependencies of
the web renderer. See the [API reference](./API.md).

## Data flow

Data flow in `.mun` files follows SwiftUI. `@State` belongs to each View
instance, and you read and write it as a plain value. Computed properties can
sit before or after `body`. `@Observable` classes hold shared models, and
`@Environment` reads values provided by an ancestor:

```swift
@Observable
final class Store {
  var count = 0
  func add() { count += 1 }
}

struct Counter: View {
  @Environment(Store.self) var store
  @Environment(\.colorScheme) var scheme
  @State private var taps = 0

  var body: some View {
    VStack {
      Text("Store \(store.count), taps \(taps), \(scheme)")
      Button("Add") { store.add(); taps += 1 }
    }
  }

  private var doubled: Int { taps * 2 }
}

export default Counter().environment(Store())
```

The built-in key paths are `colorScheme`, `locale`, and `isEnabled`. For a
custom key, use `.environment(\.key, value)`.

## Developing from a checkout

```bash
pnpm install
pnpm build
pnpm dev:create ../HelloMun --no-install
cd ../HelloMun
pnpm install
pnpm dev
```

## Native experiments

Native work is retained in an experimental area. Explicitly opt in with
`mun create HelloNative --target native`. See [native projects](./native-projects.md)
for its distinct `mun.toml`/`Sources` workflow and limitations.
