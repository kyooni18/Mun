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
