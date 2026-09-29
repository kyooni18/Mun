# Migrating to canonical Mün

Mün now separates the renderer-independent graph from its runtime adapters.
New code should define Views with `mun`, then choose `@mun/react`,
`@mun/vue`, or `@mun/web` at the application boundary. The root
`mun` package remains available only as a compatibility layer.

## Dependencies

For a React application:

```bash
pnpm add mun @mun/react @mun/vite react react-dom
pnpm add -D @vitejs/plugin-react
```

For a Vue application:

```bash
pnpm add mun @mun/vue @mun/vite vue
pnpm add -D @vitejs/plugin-vue
```

For direct HTML/DOM materialization:

```bash
pnpm add mun @mun/web @mun/vite
```

## Vite

The canonical compiler handles `.mun.ts` syntax. Keep it before the host
framework plugin and keep the host's normal CSS pipeline unchanged:

```ts
import { defineConfig } from 'vite'
import { munPlugin } from '@mun/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({ plugins: [munPlugin(), react()] })
```

Vue applications use the same Mün plugin with `@vitejs/plugin-vue`:

```ts
export default defineConfig({ plugins: [munPlugin(), vue()] })
```

The plugin also handles Vue virtual script-module IDs such as
`?vue&type=script&setup=true&lang.ts`. When it receives a complete `.vue` SFC,
it lowers only JavaScript/TypeScript `<script>` blocks and leaves the Vue
`<template>` and stylesheet blocks for Vue and Vite.

`import './style.css'`, CSS Modules, Sass, PostCSS, and Tailwind remain host
Vite features; the Mün compiler preserves those imports for the host pipeline.

## Imports and View construction

Before:

```ts
import { VStack, Text, view } from '@mun/ui'
```

After:

```ts
import { State, Text, VStack } from '@mun/ui'
import { view } from '@mun/react'
```

The graph is created before a renderer is selected. Built-in Views and custom
`struct ...: View` declarations share the same initializer metadata:

```ts
struct Card<Content: View>: View {
  let content: Content

  init(@ViewBuilder content: () => Content) {
    self.content = content()
  }

  var body: some View {
    VStack() { content }
  }
}
```

Trailing builders, labels, `@Action`, defaults, `@State`, `@Binding`, raw HTML,
and `ForEach` are lowered by `@mun/vite` without a component-name allow-list.

## State and explicit interop

State belongs to Mün, not to a renderer hook:

```ts
import { Action, Button, State } from '@mun/ui'
import { view } from '@mun/react'

const Counter = view({
  state: () => ({ count: State(0) }),
  body: ({ count }) => Button(
    `Count: ${count.value}`,
    Action(() => { count.value += 1 }),
  ),
})
```

Vue bridges are explicit. Use `toVueRef(state)` when a Vue `Ref` is required,
and `fromVueRef(ref)` when a Mün `Binding` is required. Use `Component()` for
Vue components inside a Mün graph and `MunView` or `createVueView()` for a
Mün graph inside a Vue SFC. Props, events, keys, refs, and default/named slots
stay at the Vue boundary.

React interop follows the same explicit boundary. Use `Component()` for a
React component inside a Mün graph, `reactComponent()` (or its generic
`foreignComponent()` alias) when a typed reusable Mün callable is useful, and
`MunView`/`createReactView()` when a graph is consumed from React. Use
`mount(value, target, { hydrate: true })` to attach React to server-rendered
markup. Props, children, hooks, refs, context, and lifecycle remain React-owned.
Use `useMunState(state)` and `fromReactState(value, setValue)` for explicit
State/Binding bridges at the React boundary.

## Compatibility macro

Existing applications may continue using `@mun/ui/vite` and its
`munMacro()` transform. It is intentionally separate from `@mun/vite`: the
compatibility macro provides React-oriented `State` hoisting and legacy JSX
behavior, while the canonical plugin lowers renderer-independent Mün syntax.

Migrate incrementally by moving graph imports to `mun`, replacing the macro
with `munPlugin()`, and selecting the renderer explicitly. Keep legacy JSX and
root imports only in files that still require compatibility behavior.
