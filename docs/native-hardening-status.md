# Native hardening status

> **Experimental native area.** Web/JavaScript is the default Mün frontend.
> Native scaffolds require `--target native`; this document describes the opt-in backend.

This is a hardening checkpoint, not a production-readiness declaration. The
architecture is unchanged: compiler → Semantic UI IR → `mun-runtime` (state,
editing, layout via Taffy, retained scene, accessibility semantics) →
`mun-native` (winit/wgpu/glyphon/AccessKit realization). Platform adapters
translate events; semantics stay in the runtime.

## Automatically verified (macOS arm64, 2026-10-01)

- `pnpm test`; `cargo test --manifest-path native/Cargo.toml --workspace --locked`
  (22 host unit tests, 123 runtime unit tests, 54 integration tests in 11
  suites; source contracts and the stress report are ignored by plain Cargo);
  `node scripts/verify-native-contracts.mjs` (5 compiled-source contracts,
  including keyed rows in the production smoke); `cargo build -p mun-native
  --locked`; `node scripts/native-smoke.mjs` (real window, renderer and
  AccessKit adapter initialized, frames presented); `node
  scripts/verify-native-package.mjs` (release host assembly, clean consumer,
  stale-metadata and no-Cargo-fallback rejection); `cargo fmt --check`;
  `git diff --check`.
- Pixel tests through the production wgpu/glyphon renderer (offscreen): sRGB
  colors, caret/selection/preedit at shaped positions, display scale changes.

CI runs the same contracts, builds, smoke and package checks on macOS, Windows
and Linux (Xvfb/Mesa); Windows and Linux were not executed locally.

## Verification note: Linux x64 cloud sandbox, 2026-11-11

Headless container (Ubuntu 24.04, no display, no GPU, no desktop session), Node
22.23.4, pnpm 11.22.0, cargo 1.97.0, from a clean checkout. Windowed checks ran
under `xvfb-run` with Mesa software rendering, as in the Linux CI job; system
packages were the ones that job installs.

Passed:

- `pnpm install --frozen-lockfile`, `pnpm run build`.
- `cargo fmt --manifest-path native/Cargo.toml --all -- --check`.
- `cargo test --manifest-path native/Cargo.toml --workspace --locked`: 27 host
  unit tests, 124 runtime unit tests, 69 integration tests in 14 suites (5
  source contracts and the stress report are ignored by plain Cargo).
- `node --test tests/native-dx.test.mjs tests/hot-reload.test.mjs
  tests/incremental-lowering.test.mjs tests/editor-integrations.test.mjs
  tests/vscode-extension.test.mjs` (38 tests); `pnpm run test:dx`; `pnpm run
  test:docs`.
- `node scripts/verify-native-contracts.mjs` (5 compiled-source contracts plus
  the keyed-row contract).
- `cargo build --manifest-path native/Cargo.toml -p mun-native --locked`;
  `xvfb-run -a node scripts/native-smoke.mjs`.
- `xvfb-run -a node scripts/verify-native-package.mjs` (release host assembly,
  clean npm consumer, `mun new --target native`, `check`, `fmt --check`,
  `build`, `package`, stale-metadata and no-Cargo-fallback rejection).
- Documented project path, under Xvfb: `mun create HelloMun --target native`,
  `mun doctor`, `mun check`, `mun run` (window presented; screenshot shows the
  shaped text and button), `mun dev --verbose` (launch, three successive saves:
  hot reload with state preserved, a broken edit reported as "Compile failed …
  Running previous valid build", then a hot reload again), `mun inspect
  --values`, and no host process left after Ctrl-C. Two synthetic pointer
  clicks (`xdotool`) on the button moved `count` to 2 in `mun inspect`.
- `pnpm benchmark:hot-reload --edits 5` (headless replay through the offscreen
  renderer).

Fixed to get there:

- `packages/compiler` imports `node:fs`/`node:path` without any `@types/node`
  in the workspace; a clean checkout failed `pnpm run build`.
- `cargo fmt --check` failed on the text-wrapping and layout-priority changes.
- `scripts/verify-native-package.mjs` scaffolded the default (web) target and
  failed its own native assertion; it now passes `--target native`.
- `mun dev` on Linux saw only the first save of a file that is replaced by
  rename (Node's recursive `fs.watch`); Linux now watches each directory.
- `docs/SWIFTUI_PARITY_REPORT.md` was stale against the manifest.

Not verified here:

- Keyboard input into the window: Xvfb has no window manager, so the window
  never receives input focus (`WindowFocused false` in `MUN_NATIVE_TRACE`).
  Substitute: the runtime keyboard/focus unit and integration tests above.
- A real GPU, IME, AT-SPI screen reader, trackpad and system clipboard.
  Substitute: offscreen pixel tests and AccessKit adapter initialization in
  the smoke. `docs/native-manual-validation.md` was not run.
- macOS and Windows: not executed in this environment.

Web frontend, fixed in the same pass so `pnpm test` passes as a whole (116
animation, 107 runtime, 753 package, 54 DX tests, docs and release checks):

- Compatibility `.mun.ts` sources using a contextual member
  (`.foregroundStyle(.red)`, `.font(.title)`) lowered to `Color.red` /
  `Font.title` without importing `Color` or `Font`; they are imported now.
- Ten Web/React/Vue expectations and the packed render check in
  `scripts/verify-release.mjs` still described `Text` as a bare `span`. Commit
  4892cfe made it a `span` with `max-width:100%;overflow-wrap:anywhere`; the
  expectations now state that markup.
- `tests/unsafe-html-browser.test.mjs` needs the Chromium revision the pinned
  Playwright asks for. The sandbox ships another revision, so the full run
  used `PLAYWRIGHT_BROWSERS_PATH` pointing at a directory that aliases the
  installed build under the expected name. Without that the one test fails to
  launch a browser here; CI installs the matching build.

## Text editing

- Grapheme-aware editor (scalar-offset public contract): combining marks, emoji
  variation selectors, skin tones, ZWJ sequences, flags and decomposed Hangul
  are never split; word navigation and deletion are separate from grapheme
  steps.
- Caret, selection and IME preedit (with composition selection) are positioned
  from cosmic-text shaped glyph clusters; pointer-to-text mapping, click,
  drag-select and Shift-click use the same geometry. The renderer exposes
  geometry only.
- IME: the binding mirrors what the field shows, so an in-progress
  composition (e.g. a partial Hangul syllable) updates bound views
  immediately; cancelling restores the committed text. Composition survives
  frames; focus change, window deactivation, pointer relocation and clipboard
  shortcuts commit it into its own field and ask the platform to discard
  its marked text (`NSTextInputContext.discardMarkedText` on macOS). The IME
  candidate area follows the shaped caret and is re-sent after scale changes.
- Clipboard: arboard host service; cut deletes only after a successful write
  acknowledgement; reads carry request ids, stale/failed/superseded reads are
  ignored, pasted text is sanitized to one line. No shelling out.

- Undo/redo (⌘Z/⌘⇧Z, Ctrl+Z/Ctrl+Y) with coalesced typing runs; history is
  per focus session. Shortcuts use the physical key, so they work under
  non-Latin input sources.

## Layout

The window bounds its root view. `.frame(minWidth:maxWidth:minHeight:maxHeight:)`
makes views flexible (grow along the parent's main axis, stretch across it,
clamped to bounds; `.infinity` allowed for max); containers of flexible
children become flexible.

## Scrolling

Keyboard (arrows, Page Up/Down, Home/End) with deterministic owner (focused
control's nearest viewport, else hovered), focus-driven minimal reveal through
nested ancestors, runtime-owned scrollbars hidden when content fits, thumb
drag and track paging, nested wheel routing. Scroll input reuses current
viewport geometry instead of rebuilding a frame.

## Keyed collections

`ForEach(items, id: \.key)` lowers to a `forEach` node. The runtime
materializes one instance per key; node identities and item-scoped `@State`
follow the key through insertion, deletion, reorder, filtering and conditional
parents; removed keys release their state; duplicate/invalid keys are explicit
errors; rejected transactions roll back atomically. The production smoke has
keyed `TaskRow`s with per-row state, verified through compiled source.

## Accessibility semantics

Radio options are RadioButton nodes (checked, disabled, activation through the
group). Text fields expose committed text as AccessKit text runs with grapheme
characters, shaped positions, word starts and the editor selection, and accept
SetTextSelection / ReplaceSelectedText / SetValue through the runtime editor.
Scroll views expose offsets and accept scroll/ScrollIntoView actions. Inactive
conditional branches are absent from the tree.

## Contracts and lifecycle

- Controls added for SwiftUI parity are covered by the compiled-source contract
  `examples/NativeSettingsPane.mun` → `tests/native_settings_pane.rs`
  (run by `scripts/verify-native-contracts.mjs`):
  - Toggle: checkbox semantics and activation, AccessKit CheckBox.
  - SecureField: masked, no copy/cut, AccessKit PasswordInput without value.
  - ProgressView: fill fraction and percent value.
  - Spacer and Divider along the stack axis.
  - onAppear/onDisappear: once per presence change, not per frame.

  None of these has been exercised interactively with VoiceOver yet.

- The runtime evaluates the bundled `schemas/semantic-ui-ir-v1.schema.json`
  before deserializing: unknown fields/kinds, nested windows and malformed data
  are errors naming node and field; references are checked.
- Deterministic tests cover scale changes while composing, minimize/restore
  while scrolled and animating, zero-sized windows. Host layout errors are
  reported, not panics. Mirrored text transforms are rejected with a
  diagnostic; collapsed (zero-scale) text is skipped.
- Release hosts are assembled per OS/arch with metadata the launcher checks;
  Cargo builds are a source-checkout/dev path only. Signing is an external step
  (`docs/native-release.md`); published hosts are currently unsigned.

## Measured performance (release, offscreen 800×600@2x)

`tests/stress.rs` (report: `cargo test --release -p mun-native --test stress --
--ignored --nocapture`). 1000 keyed rows (~7.3k retained nodes): frame build
~18 ms + render ~3 ms, typing ~1.9 ms per keystroke, scroll input ~0.6 ms,
keyed insert/move/remove ~42 ms. 3000 rows (~22k nodes): build ~57 ms. Text
buffers, shaped-line cache and scoped state stay bounded under churn; resizes
reshape no text.

## Not verified on a real platform

- Korean/Japanese IME typing, VoiceOver, trackpad momentum scrolling and
  real clipboard interplay on macOS were **not** exercised interactively:
  this environment has no Accessibility, event-posting or screen-recording
  permission. `docs/native-manual-validation.md` is the checklist;
  `MUN_NATIVE_TRACE=1` records a verifiable trace.
- Windows UIA/IME and Linux AT-SPI/IBus/Wayland clipboard: not exercised.

## Remaining blockers

- Real-platform IME, screen-reader and trackpad validation (above).
- Scalability: every frame rebuilds layout and scene for the whole tree, and
  every collection mutation re-materializes the whole `forEach`; no
  virtualization or offscreen culling. Comfortable for hundreds to low
  thousands of nodes, not for very large lists.
- Single-line text only (no wrapping or multi-line editing).
- Group opacity multiplies per primitive; overlapping children inside a
  translucent group do not composite as one layer.
- Release signing/notarization is not automated.
