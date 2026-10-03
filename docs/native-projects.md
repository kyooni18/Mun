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

`pnpm benchmark:hot-reload` compiles every edit with the same incremental
project compiler `mun dev` uses, diffs it into the exact update message `mun
dev` sends, and replays that stream headlessly through `mun-native
--dev-replay <ir> <updates.ndjson>`. The replay applies each update with the
dev host's own code path (`DevProgram::apply`: revision check, patch
reconstruction, `Runtime::hot_update`) and renders one offscreen frame through
the production renderer, waiting for the GPU. It opens no window.
`pnpm benchmark:hot-reload:window` drives a real windowed dev host instead and
adds the loopback round trip and first-presented-frame timings;
`pnpm benchmark:hot-reload:compile` measures the toolchain only. Pass
`--edits N`, `--case <name>`, `--spacing MS` (window mode: idle gap between edits) or `--json` to the script directly. No performance
threshold blocks CI. Not measured: the file watcher's 80 ms debounce and display
scan-out after the frame is handed to the platform.

darwin-arm64 headless sample (30 compatible edits per case; p50 / p95 ms).
These are local measurements, not CI thresholds:

| Case | Compile | Host load | Materialize | Reconcile | Layout | Render prepare | GPU | Host total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Small app | 0.27 / 0.70 | 0.04 / 0.05 | 0.00 / 0.00 | 0.00 / 0.00 | 0.02 / 0.04 | 0.04 / 0.07 | 0.30 / 0.58 | 0.43 / 0.77 |
| 25 custom Views | 0.37 / 0.57 | 0.32 / 0.37 | 0.01 / 0.01 | 0.01 / 0.02 | 0.06 / 0.09 | 0.03 / 0.05 | 0.32 / 0.67 | 0.87 / 1.20 |
| 1,000 keyed rows | 2.26 / 2.62 | 0.67 / 0.77 | 0.84 / 1.10 | 1.25 / 1.50 | 3.02 / 3.41 | 0.34 / 0.39 | 0.50 / 0.81 | 7.30 / 8.37 |
| Cross-file View body edit | 0.11 / 0.15 | 0.03 / 0.05 | 0.00 / 0.00 | 0.00 / 0.00 | 0.02 / 0.05 | 0.04 / 0.06 | 0.29 / 0.61 | 0.42 / 0.83 |

"Host load" is IR schema validation and typed deserialization of the new
program; "Layout" is the whole `Runtime::build_frame` (layout, scene and
accessibility). For 1,000 rows the same benchmark measured, before the
retained-runtime work below, load 2.48 / 2.82, materialize 2.37 / 2.87,
reconcile 1.63 / 2.06, layout 6.15 / 6.71, render prepare 0.88 / 0.98 and host
total 15.22 / 16.62 ms (and 29.8 ms host total before incremental compilation).
The benchmark also prints structural per-frame work: a 1,000-row edit
invalidates 0–1 of 3,003 retained layout nodes, reuses the list's expansion and
culls 2,969 offscreen primitives.

**Retained runtime.** A hot update or frame does work in proportion to what
changed where the result can be proven identical:

- *Materialization* runs once per hot update (with carried state). A top-level
  `forEach` whose template subtree, evaluated collection and item-scoped state
  declarations are unchanged keeps its previous instances: they are moved from
  the running program once the update can no longer fail, instead of being
  re-expanded. The same reuse applies when another collection changes at run
  time. A `forEach` containing a nested `forEach` is always re-expanded.
- *Layout* keeps one Taffy tree across frames and compatible hot updates, keyed
  by semantic node id. Every frame still derives each live node's complete
  layout input (style, intrinsic size, children) from Mün semantics and diffs
  it into that tree; only nodes whose input changed are invalidated (with all
  ancestors), and Taffy's cache answers every unchanged subtree. Stale layout
  is impossible by construction because nothing is skipped on the input side.
- *Rendering* skips primitives that lie entirely outside their clip (rows
  scrolled out of a ScrollView): they are neither reshaped nor prepared.
- *Reconciliation* moves retained nodes instead of cloning them.

Differential tests check retained layout against a from-scratch layout and
reused materialization against a fresh expansion through inserts, moves,
removals, filters, conditionals, text edits, resizes and hot updates, and
culled against unculled framebuffers pixel for pixel.

Still O(program) per update or frame: IR validation/deserialization of the
whole new program (the 1,000 row initial values are part of it), carrying
state, retained-tree reconciliation, and scene and accessibility construction
(every live node is visited each frame; the accessibility tree must be
complete, and the previous frame's scene/accessibility are kept for exit and
FLIP transitions).

Windowed sample (`--window --spacing 120`: an idle app, one update at a time,
30 edits; p50 / p95 ms from the host receiving the update to the frame being
handed to the platform):

| Case | Receive → present | Layout | Surface acquire |
| --- | ---: | ---: | ---: |
| Small app | 1.30 / 1.97 | 0.2 | 0.06 |
| 25 custom Views | 2.57 / 3.66 | 0.3 | 0.06 |
| 1,000 keyed rows | 16.6 / 17.7 | 6.0 | 0.03 |
| Cross-file View body edit | 1.87 / 2.40 | 0.3 | 0.10 |

Before the retained-runtime work, 1,000 keyed rows measured 26.3 / 27.8 ms
receive → present with 9.2 ms layout. The windowed frame build runs about twice
as long as the same build headless even though the retained counters are
identical (0–1 invalidated layout nodes); that difference has not been
attributed (a background window's scheduling class is the leading suspect).

Two measurement artifacts to know about. Sending edits back to back (the
`--spacing 0` default) makes each one queue behind the previous frame's vsync
wait, which doubles receive → present to ~31 ms; that is not what a person
saving a file sees. And the first update after launch is reported separately
(`firstUpdateAfterLaunchMs`, 183-267 ms here): it arrives while the host is
still creating its window and rendering its first frame, and its host queue time
is almost all of that, with the update itself applying in under 1 ms (12 ms for
1,000 rows). That startup contention was the large p95/max outlier in earlier
windowed runs. It delays an edit saved within roughly a quarter second of launch;
the edit is still applied.

**Incremental compilation.** Changed files are reread and reparsed per file,
and within a file only declarations whose text changed are reparsed (each
declaration's parse is reused by exact text). Canonical declaration validation
runs only for changed declarations. Lowering reuses every custom View instance
whose declaration, transitively resolved View declarations and call-site inputs
(bindings, identity path, component stack, enclosing ForEach scope and the
types of states declared before it) are unchanged; recorded side effects are
replayed and source spans are kept relative to their declaration, so offset
shifts elsewhere do not invalidate. Adding, removing or renaming any View
invalidates every instance (name resolution may change). A differential test
checks that reused and from-scratch compiles produce identical IR and dev
metadata. Per edit, the benchmark reports declarations reparsed and rechecked,
View declarations relowered, instances lowered/reused, and the Views the
previous compile's dependency graph marks as affected: an `App` edit in the
25-View fixture reparses, rechecks and relowers 1 declaration and reuses 25
instances; editing `Header` in the cross-file fixture relowers `Header` and the
entry View that uses it. The entry View's body is always relowered.

**Host instrumentation.** `update-applied` carries `timings` (frame decode,
event-loop queue, patch reconstruction, load, materialize, reconcile, total
apply). After an update the windowed host sends `update-presented` for the
first frame that reaches the platform presentation engine: receive-to-present
and apply-to-present latency plus step, layout, accessibility, render prepare,
surface acquire, submit and present times, plus the frame's retained layout
node count, invalidated layout nodes and culled primitives. Frames skipped while the window is
occluded are counted and the update stays pending until one is presented.
`mun dev --verbose` prints both.

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
production IR. Compilation is incremental per declaration and per View instance
(see the measurements above); byte-identical saves reuse the previous result.

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
The VS Code extension is a thin LSP client for source semantics. It checks
workspace-local `@mun/ui` first, then global `mun`, and refuses a version mismatch
instead of silently using a different compiler. Set `mun.server.command` to
select an executable. The LSP provides diagnostics, completion, hover,
signatures, definition, references, rename, formatting, semantic tokens,
document/workspace symbols, folding and selection ranges. Compiler/parity
metadata supplies signatures; lexically scoped navigation excludes comments and
literal text and includes Swift interpolation and cross-file custom Views.
Unchanged syntax snapshots are cached. Diagnostics still compile the whole
project unit for each document, but share the compiler's per-declaration parse
and validation reuse and a per-service View lowering cache (26 open documents:
edit plus full diagnostics refresh p50 22.8 -> 6.6 ms). Project-isolated
multi-root indexing and broader diagnostic quick fixes remain follow-up work. Safe quick fixes for `string` → `String` and `boolean` → `Bool`
are available through LSP and VS Code; `number` is deliberately not rewritten
because Int versus Double is ambiguous.

Native development is kept separate from LSP semantics. VS Code contributes
`Mün: Start Dev`, `Mün: Stop Dev`, `Mün: Restart App`, and `Mün: Inspect Running
App`. A **Mün Runtime** Explorer view polls the authenticated loopback inspector
while the extension-owned `mun dev` process is alive. The tree keeps runtime
semantic identities, shows source locations, and selecting a mapped node opens
its `.mun` range. Runtime diagnostics are carried structurally in inspector
snapshots and published as a distinct `mun-runtime` diagnostic collection; the
extension does not parse terminal text to invent source errors. Multiple
workspace folders keep separate dev processes, snapshots and runtime diagnostic
sets. Inspector polling never requests state values, so `SecureField` contents
remain redacted and ordinary state values are not exposed in the editor tree.
`mun editor export vscode output.vsix` packages exactly the files declared by the
extension manifest, including the dev inspector client.

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
