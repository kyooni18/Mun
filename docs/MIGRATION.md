# Migrating to web-first Mün

Mün's default is now a regular JavaScript web frontend with SwiftUI-inspired
Views. Native development remains opt-in and experimental.

- `mun new/create/init` and `create-mun` now scaffold Vite web applications.
- Use `--target native` to preserve the previous native scaffold workflow.
- Existing native projects keep their `mun.toml` and native commands.
- `@mun/core` and `@mun/ui` expose the View graph authoring API again, including
  `Text`, `VStack`, `Button`, and `State`.
- Existing `@mun/core/compat` imports still work and share the same implementation.
- Render with `mount` or `renderToHTML` from `@mun/web`; renderer functions remain
  separate from core. React and Vue adapters remain optional.
- `.mun` source remains supported by the Vite plugin; direct JavaScript and
  TypeScript authoring does not require the syntax compiler.

Existing web apps using `@mun/core/compat` require no import changes. Native IR
exports are retained so experimental consumers can migrate independently.

See [getting started](./GETTING_STARTED.md) for the default workflow.
