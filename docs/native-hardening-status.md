# Native hardening checkpoint

This is a partial hardening checkpoint, not a production-readiness declaration.
The native-first compiler → semantic IR → runtime → Taffy → retained scene →
winit/wgpu/glyphon/accesskit architecture is unchanged.

## Verified in this checkpoint

On macOS arm64:

- `pnpm run build` and `pnpm test` passed (compiler, package, types, docs, release tests).
- `cargo test --manifest-path native/Cargo.toml --workspace --locked` passed:
  18 native-host unit tests, 112 runtime unit tests, 9 existing integration tests,
  8 scroll integration tests and 3 editing integration tests. Three source contracts are ignored by plain Cargo.
- `node scripts/verify-native-contracts.mjs` passed all four freshly compiled
  source contracts, including the production smoke, controls and layout.
- `cargo build --manifest-path native/Cargo.toml -p mun-native --locked` passed.
- `node scripts/native-smoke.mjs` opened a real native window, initialized the
  renderer and accessibility adapter, rendered three frames, and exited.
- `node scripts/verify-native-package.mjs` packed isolated workspace packages,
  installed into a clean consumer, compiled source, and launched the installed
  host without Cargo or checkout dependency.
- Cargo formatting and `git diff --check` passed.

CI now schedules these source contracts, native builds, and real-window smoke
checks on macOS, Windows and Linux (Xvfb/Mesa). Windows/Linux were **not executed
locally**. Adapter initialization does not prove screen-reader interaction.

## Editing contract

Runtime editing uses Unicode scalar offsets, explicitly not UTF-8 byte offsets.
Left/right, Home/End, Shift-selection, select-all, replacement, Backspace/Delete,
and composition update/commit/cancel share a semantic editor. Preedit appears
in presentation but never updates the committed binding or accessibility value.
Platform preedit byte offsets are normalized at the winit adapter. Focus changes
and window focus loss cancel composition. Clipboard requests are runtime service
messages serviced by the host through arboard, not OS commands in controls.

## Scrolling contract

`ScrollView()` defaults to vertical; `.horizontal` is explicit. The compiler,
shared semantic IR/schema and native runtime carry a first-class `scroll` node.
Runtime-owned offsets reconcile against Taffy content extents, clamp on content
changes and resize, and translate scene/hit-test/accessibility geometry together.
Nested wheel input consumes inner capacity before routing residual movement to
ancestors. Removed viewports discard offsets. Integration tests cover clipping,
hit testing, nested routing, conditional removal, resizing and horizontal input.
The web compatibility adapter maps this node to CSS overflow; no web dependency
was introduced into the native runtime.

## Remaining release blockers

These are unfinished implementation work, **not external blockers**:

- Caret/selection/preedit-decoration rendering, pointer-to-text-position mapping,
  IME candidate positioning, real Korean/Japanese/Chinese input validation.
  Scalar editing is UTF-8 safe but not grapheme-aware (combining marks/ZWJ).
- Clipboard failure acknowledgement: cut currently mutates before host write
  success. Linux clipboard ownership persistence and Wayland integration need
  real-platform testing. Service calls are synchronous.
- Scrollbar presentation, keyboard/page scrolling, focus-driven scroll-to-reveal,
  and real trackpad/platform scrolling validation. Basic semantic viewports and
  nested wheel routing are integrated, but these interaction contracts remain.
- Runtime-owned keyed collection state scopes. Compiler identity safeguards are
  deliberately not relaxed.
- Accesskit text selection/edit actions and detailed radio option semantics;
  VoiceOver/UIA/AT-SPI manual verification.
- Mirrored text transforms, true subtree opacity contract, full GPU device-loss
  and initialization error recovery, display-change/DPI regression matrix.
- Strict unknown-field IR diagnostics, comprehensive contract validation.
- Release host artifact assembly for supported OS/architecture targets. The
  packaging test stages a current debug host; it does not produce signed release
  binaries. Packages lacking hosts still use the existing Cargo fallback.
- Runtime-scoped keyed local state in the production smoke. The current
  NativeProductionSmoke source covers controls, scrolling, shapes, gradients,
  multilingual editing content and conditional transitions, not keyed local state.
- Retained-tree stress/performance measurement and leak/resource-growth testing.

No browser or platform UI framework was added to the native core. No claim of
full desktop production readiness or three-platform direct validation is made.
