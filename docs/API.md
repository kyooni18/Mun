# Mün API

## View authoring: `@mun/core` and `@mun/ui`

Both public entry points expose the SwiftUI-inspired JavaScript View API:

- `Text`, `Button`, `VStack`, `HStack`, `ZStack`, collections, and controls;
- `State`, `Binding`, and declarative custom Views;
- layout, style, identity, and presentation modifiers;
- `Animation`, `Transition`, transactions, and shared motion semantics.

`@mun/core/compat` remains a supported alias for the same graph implementation.
Renderers do not need to be imported to construct a View.

## Web rendering: `@mun/web`

- `mount(view, container, options?)`: mount a View to a DOM element; returns cleanup.
- `renderToHTML(view)`: render a View graph to HTML on the server.
- `renderMunUiProgramToHTML(program)`: experimental Semantic UI IR rendering.

DOM rendering, CSS, browser events, and hydration live in the web package rather
than requiring a native host. React, Vue, and Astro integrations remain optional.

## Optional syntax: `@mun/compiler` and `@mun/vite`

The `.mun` compiler supports SwiftUI-like builder and custom View syntax and
lowers it to JavaScript. Use `munPlugin()` from `@mun/vite` in a Vite frontend.
`compileMunFile`, `transformMunSource`, `createMunSemanticModel`, and
`diagnoseMunSource` support tooling and programmatic compilation.

## Experimental native API

`compileMunUiProgram` and the Semantic UI IR types remain available for the
opt-in Rust runtime. Native development and packaging are experimental; see
[native architecture](./NATIVE_ARCHITECTURE.md). They do not define the default
web authoring or rendering surface.
