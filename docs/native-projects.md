# Native project workflow

## Toolchain

Install `@mun/ui` globally with npm or invoke its installed `mun` binary. Native
projects contain no JavaScript package: they use the selected public CLI/compiler.
Releases need a matching `native/bin/<os>-<arch>` host. `mun doctor` explains
missing hosts; it does not download anything. `MUN_NATIVE_HOST` explicitly selects
an alternate executable. Installed packages do not silently invoke Cargo. Source
build fallback requires `MUN_NATIVE_BUILD_FROM_SOURCE=1` (or a repository checkout)
and builds the existing locked Rust workspace, not a second runtime.

## Manifest version 1

`mun.toml` is a strict flat TOML subset. Use double-quoted strings, an integer
`manifest_version`, and single-line arrays of double-quoted strings. Whole-line
comments are supported. Tables, unknown keys and duplicate keys are rejected.

```toml
manifest_version = 1
name = "HelloMunApp"
entry = "Sources/App.mun"
identifier = "app.mun.hellomun"
version = "1.0.0"
minimum_mun_version = "0.1.20"
platforms = ["macos", "windows", "linux"]
resources = ["Assets"]
```

Required: format version, name, entry, identifier, application version.
Optional: minimum Mün version, platforms, resources, icon, fonts, window_title.
Paths must be project-relative and stay inside the project. Missing resources fail
build/package. Resource symlinks are rejected. Font registration is not currently
exposed by the native renderer, so nonempty `fonts` fails build rather than
pretending fonts were registered. Window-title metadata is reserved and is not yet
applied to the native window. Manifest fields never define layout or runtime state.

The entry is canonical `.mun` with `@main`. All non-hidden `.mun` files in the
project (excluding node_modules, Assets, build, dist) are one deterministic
compilation unit. Do not put independent applications in the same project.
Cross-file diagnostic mapping is best-effort for compiler lowering errors;
source-analysis diagnostics retain mapped file/line/column positions.

## Development

`mun dev` watches source and project configuration. Changes are debounced 80ms.
Compilation failure does not terminate the loop or replace valid IR. Successful
compilation stops the old process before launching a new one. State resets.
`--verbose` reports changed paths and combined compile/IR duration.

Ignored `mun.local.json` may contain local-only environment overrides:

```json
{"env":{"MUN_NATIVE_HOST":"/local/path/to/mun-native"}}
```

Never commit machine-specific paths. Environment overrides are loaded when the
command starts; restart dev to change them.

## Build and package

`mun build` copies the resolved release host and Semantic UI IR into
`.mun/build/<os>-<arch>/<name>/`. Unix uses `launch`; Windows uses `Run.cmd`.
Resources are copied under `Resources/`, with project-relative paths preserved.
The launcher locates IR independent of the original project working directory.
`MUN_RESOURCE_DIR` identifies bundled resources for future renderer integration;
arbitrary file access from Mün source is not yet a native language contract.

`mun package` uses `.mun/package/<os>-<arch>/`. On macOS this is a `.app` with
Contents/MacOS, Contents/Resources and Info.plist. Icons must be `.icns` on macOS.
The launcher is currently a shell script: Finder behavior and distribution/signing
need further real-machine validation. Other platforms receive a portable directory,
not an installer. No command claims to sign or notarize the app.

The package command prints signing/notarization commands. With your credentials:

```sh
codesign --force --deep --options runtime --sign "Developer ID Application: YOUR IDENTITY" App.app
ditto -c -k --keepParent App.app App.zip
xcrun notarytool submit App.zip --keychain-profile YOUR_PROFILE --wait
xcrun stapler staple App.app
```

## Editors and local framework development

`mun editor install` supports VS Code, Vim, Neovim, Zed, Helix and generic LSP
configurations. All canonical `.mun` intelligence now comes from the standalone
`mun lsp --stdio` server; `.mun.ts` and Vue are not classified as canonical Mün.
The VS Code extension is a thin LSP client. It checks workspace-local `@mun/ui`
first, then global `mun`, and refuses a version mismatch instead of silently
using a different compiler. Set `mun.server.command` to select an executable.
The LSP provides diagnostics, completion, hover, signatures, definition,
references, rename, formatting, semantic tokens, document/workspace symbols,
folding and selection ranges. Compiler/parity metadata supplies signatures;
lexically scoped navigation excludes comments and literal text and includes
Swift interpolation and cross-file custom Views. Unchanged syntax snapshots are
cached. Full type-directed navigation, project-isolated multi-root indexing,
and broader diagnostic quick fixes remain follow-up work. Safe quick fixes for
`string` → `String` and `boolean` → `Bool` are available through LSP and VS Code;
`number` is deliberately not rewritten because Int versus Double is ambiguous.
`mun editor export vscode output.vsix` uses the existing VSIX exporter.

For framework development: `pnpm install && pnpm build` in the Mün checkout,
then `node /path/to/Mun/bin/mun.mjs new /path/to/HelloMun`. Invoke that same CLI
from the app (`--project /path/to/HelloMun`) while using `pnpm dev:watch` to update
compiler outputs. Native app manifests do not contain links to repository internals.
The `mun link` command remains for explicit Web/React/Vue/Astro compatibility.

## Troubleshooting

- No project: run `mun init` in an empty directory or `mun new <name>`.
- Missing entry: verify the `entry` path in mun.toml.
- Malformed manifest: use the documented version-1 subset; diagnostics name a line.
- Missing host: use a matching release, an explicit host override, or opt into Cargo.
- Broken edit: run `mun check`; dev automatically retries after the next edit.
- Missing assets: correct project-relative paths before building.
- Formatting uses a structural token scanner for blocks, wrappers, argument labels,
  operators and collections. Raw/multiline string files are preserved unchanged
  until their indentation semantics can be handled safely.
