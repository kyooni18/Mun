# Migrating to web-first Mün

Mün's direction is primary `.mun` authoring for application UI and behavior,
compiled to JavaScript with SwiftUI-like Views. Native development remains opt-in and experimental.

- `mun new/create/init` and `create-mun` now scaffold Vite web applications.
- Use `--target native` to preserve the previous native scaffold workflow.
- Existing native projects keep their `mun.toml` and native commands.
- `@mun-ui/core` and `@mun-ui/ui` expose the View graph authoring API again, including
  `Text`, `VStack`, `Button`, and `State`.
- Existing `@mun-ui/core/compat` imports still work and share the same implementation.
- Render with `mount` or `renderToHTML` from `@mun-ui/web`; renderer functions remain
  separate from core. React and Vue adapters remain optional.
- `.mun` is the primary documented language, compiled by the Vite plugin; direct JavaScript and
  TypeScript authoring does not require the syntax compiler.

Existing web apps using `@mun-ui/core/compat` require no import changes. Native IR
exports are retained so experimental consumers can migrate independently.

See [getting started](./GETTING_STARTED.md) for the default workflow.

Web `.mun` diagnostics now use the web compilation path. Native diagnostic callers
must select `{ target: "native" }`; the LSP retains native diagnostics for `@main`
compilation units. This keeps existing native experiments available while allowing
web-only forms and async behavior. Existing `.mun.ts`, JS/TS builders and imports
remain supported. See [language differences and migration policy](LANGUAGE_REFERENCE.md)
and [current capability status](CAPABILITIES.md).

## Built-ins and `@mun-ui/ui` opt-in features

- `.mun` files no longer need `import { Text, VStack } from "@mun-ui/core"`. Existing
  explicit imports keep working; removing them is optional.
- A `.mun` file that used an undeclared name (a typo, or a View that only
  existed at runtime by accident) now fails to compile with `Cannot find '<Name>' in scope`.
- Replace `@mun-ui/progressive-blur` with `@mun-ui/ui/progressive-blur` (and
  `@mun-ui/progressive-blur/plan` with `@mun-ui/ui/progressive-blur/plan`). The old package is
  kept as the internal implementation module and resolves to the same module instance,
  so mixing both paths during migration does not duplicate state or behaviour.
