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

Canonical `.mun` diagnostics now use the native compiler validity contract,
including keyed `ForEach` over record arrays. The compatibility TypeScript
transform is not a validity gate for native programs: it does not implement
Swift key-path syntax. Compatibility snippets (diagnostics without a canonical
filename) retain their existing TypeScript diagnostics. Project compilation
performs native validation/lowering once rather than first running the
compatibility transform.

### Repeatable hot-reload measurements

Run `pnpm benchmark:hot-reload` with a built native host, or
`pnpm benchmark:hot-reload:compile` without a display. Pass `--edits N` to the
script directly to change the sample count. The benchmark preserves unchanged
files, reads one edited file per iteration, validates compatibility and reports
p50/p95/max, UTF-8 IR bytes, file-read, native compile, serialization and
compatibility timings. No performance threshold blocks CI.

Initial darwin-arm64 compile-only samples (30 edits, milliseconds):

| Case | p50 | p95 | max | Full IR KiB |
| --- | ---: | ---: | ---: | ---: |
| Small app | 0.6 | 1.3 | 1.7 | 1.4 |
| 25 custom Views | 2.3 | 3.3 | 3.5 | 25.1 |
| 1,000 keyed rows | 14.2 | 19.5 | 22.1 | 33.2 |
| Cross-file View body edit | 0.2 | 0.3 | 0.5 | 1.8 |

The pre-fix draft measured small/medium compile p50 at 147.5/269.0 ms
(5 edits) and failed on the cross-file fixture. It bypassed diagnostics for the
keyed case. These are exploratory samples, not a controlled performance claim.
The semantic-contract fix removes the unnecessary compatibility analysis pass.

The project compiler now keeps a parsed struct forest per source file. A changed
file is re-read and reparsed without reparsing unchanged files; byte-identical
saves reuse the prior parse. Semantic validation and reachable-View lowering are
still whole-project work and the benchmark reports that honestly. For example,
a body edit in the 25-custom-View fixture reparses 1 declaration but currently
rechecks and relowers all 26 declarations/Views.

Development protocol v2 adds monotonic program revisions and a dev-only JSON
path patch representation. The toolchain chooses a patch only when its encoded
message is materially smaller than a full update. The native host validates the
base revision, reconstructs the candidate program on a clone, then sends that
full reconstructed program through the existing atomic `Runtime::hot_update`.
A patch therefore changes transport cost, not state/lifecycle semantics. Invalid
patches do not advance the host revision and may be retried as a full update;
stale/out-of-order revisions are rejected.

A darwin-arm64 release-host sample (10 compatible edits per case) measured the
following wire reduction. These are exploratory local measurements, not CI
performance thresholds:

| Case | Compile p50 | Host request/ack p50 | Full IR | Wire update | Reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small app | 1.3 ms | 14.8 ms | 1.4 KiB | 0.2 KiB | 85.7% |
| 25 custom Views | 3.6 ms | 8.9 ms | 25.1 KiB | 2.1 KiB | 91.5% |
| 1,000 keyed rows | 16.1 ms | 19.1 ms | 33.2 KiB | 0.4 KiB | 98.8% |
| Cross-file View body edit | 0.6 ms | 16.1 ms | 1.8 KiB | 0.3 KiB | 81.5% |

Request/ack p95 still showed roughly 159–273 ms spikes. The benchmark does not
yet split transfer, runtime reconciliation/layout, GPU submission and actual
presentation, so those tails must not be attributed to transport alone.

## Development

`mun dev` watches source and project configuration (changes are debounced 80ms),
launches the native host once, and applies each successful edit to the **running
process** over a loopback dev link. `--verbose` adds per-phase timings, the
runtime round trip and the payload size.

### Hot reload

The toolchain listens on `127.0.0.1:0`; the host connects back with `mun-native
--dev <ir>` plus `MUN_DEV_ENDPOINT` and `MUN_DEV_TOKEN`. Frames are a 4-byte
big-endian length followed by JSON (16 MiB cap); the host's first message is a
`hello` with development protocol v2, per-session token and IR version.
Production launches ignore these variables. The host exits when the link drops,
so no orphan process is left behind. Full and patch updates carry
`baseRevision`/`revision`; only the next revision is accepted.

`Runtime::hot_update` is atomic: the new program is loaded, validated and its
collections materialized before anything is committed. If any step fails the
running application is untouched and the update is reported as rejected.

Preserved across a hot update: state whose semantic identity, declared type and
keyed scope are all unchanged (globals and keyed list-row state), focus and the
active text editor when the node still exists, scroll offsets, and the retained
tree (so `onAppear`/`onDisappear` fire only on real presence changes). An active
IME composition is committed first. Reset: state whose declared type or keyed
scope changed (it takes its new initial value — incompatible state is never
carried over), newly added state, and transient input, motion and presence
animations.

A **process restart** is required, and reported as a relaunch rather than a hot
reload, when the IR version, the `@main` entry or the root window id changes, or
when the app window has been closed. Typical output:

```
Hot reload applied in 14 ms  ·  Preserved 3  ·  Reset 1
Structural change requires process restart: @main entry changed … Relaunched in 97 ms
Compile failed … Running previous valid build
```

An invalid edit never replaces the running build; the next valid save applies
normally. Declared state types are carried only in dev metadata, never in the
production IR. Compilation is incremental at the file-read level (unchanged files
are not re-read; byte-identical saves reuse the previous result) but semantic
analysis still covers the whole project unit.

### Inspecting a running app

While `mun dev` runs it writes `.mun/dev/session.json` (mode 0600; loopback
inspector endpoint and token) and removes it on exit. `mun inspect [--values]
[--json]` prints the live node tree (kind, frame, component, scroll offset, focus)
and state names. Development compilation keeps semantic node source spans outside
production IR; the inspector joins those identities back to project-relative
`Sources/*.mun:line:column` locations and reports the current dev-program revision.
Runtime diagnostics carrying a semantic node id use the same map, so the normal
dev console points to canonical Mün source instead of only printing an internal
node id. State values are included only with `--values`; `SecureField` state is
always redacted.

Ignored `mun.local.json` may contain local-only environment overrides:

```json
{"env":{"MUN_NATIVE_HOST":"/local/path/to/mun-native"}}
```

Never commit machine-specific paths. Environment overrides are loaded when the
command starts; restart dev to change them.

## Build and package

`mun build` copies the resolved release host and Semantic UI IR into
`.mun/build/<os>-<arch>/<name>/`. The native host binary is itself the
executable (there is no shell or `Run.cmd` launcher); `Resources/` sits next to it
with project-relative resource paths preserved under `Resources/bundled/`. With no
arguments the host loads `Resources/program.mun.ir.json` relative to its own
executable — never the working directory — so it can be launched from anywhere.
Arbitrary file access from Mün source is not yet a native language contract, and
bundled fonts are rejected explicitly until the renderer supports them.

`mun package` uses `.mun/package/<os>-<arch>/`. On macOS this is a `.app` whose
`CFBundleExecutable` is the native host, with `Contents/Resources` and a
manifest-generated `Info.plist` that must pass `plutil -lint`. Bundle identifiers
must be reverse-DNS segments of letters, digits and hyphens. Icons must be `.icns`
on macOS and are copied to `Contents/Resources/<basename>`. Other platforms
receive a portable directory, not an installer.

Packages are **unsigned by default** and are never ad-hoc signed. An unsigned
macOS app is not distribution-ready, and `codesign --verify` on it fails
(the arm64 linker ad-hoc signs the bare executable, which does not match a bundle
with resources). To sign and notarize with your credentials:

```sh
mun package --sign "Developer ID Application: YOUR IDENTITY" --notarize-profile YOUR_PROFILE
```

This runs `codesign` with the hardened runtime and a secure timestamp, then
`codesign --verify --strict`, then (with `--notarize-profile`) `notarytool submit
--wait` and `stapler staple`. The ad-hoc identity `-` is refused, and
`--notarize-profile` requires `--sign`.

### Platform status

| Capability | Exercised |
| --- | --- |
| macOS arm64: `mun dev` hot reload, `mun inspect`, packaged `.app` launched from the executable and via `open` | Yes, locally |
| macOS: Finder launch, signing and notarization with a real identity | Not exercised |
| Windows, Linux: dev, build, package | Implemented but not exercised; no CI coverage yet |

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
