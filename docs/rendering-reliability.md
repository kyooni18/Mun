# Web rendering and release guarantees

Mün's primary production target is the renderer-independent View graph with
`@mun/web` DOM rendering, SSR and hydration. React, Vue and Astro are optional
adapters. Native Semantic UI IR and resident/accelerated execution are experimental,
opt-in backends, not prerequisites for web rendering. Historical native-first
proposals are not production guarantees.

## Compiler contract

Canonical `.mun` uses SwiftUI-style labels and types: `String`, `Bool`, `Double`,
`.animation(.easeInOut(duration: 0.4), value: expanded)`,
`.scale(scale: 0.8, anchor: .center)`, `.move(edge: .bottom)`,
`.combined(with: .opacity)`, and `Transaction(animation: .linear(duration: 1))`.
Use `Color("#6750A4")`, not a string, as a ShapeStyle. TypeScript constructors,
object-style transactions and positional compatibility overloads are not canonical
`.mun` syntax. Compatibility graph APIs remain available in JavaScript/TypeScript.

The source transform returns **module source**, not a standalone expression. Runtime
symbols introduced by lowering (including `Animation` and `withAnimation`) must be
imported; applications must not need ambient framework globals. Exact-output tests
are accompanied by execution tests for this contract. Semantic node/state IDs are
internal structural paths; body builder child segments are significant. Keyed
state must remain stable across sibling reorders even when path formatting evolves.

## URL attributes

SSR, ordinary DOM attributes, compiled templates, hydration matching and Patch IR
share `packages/web/src/url-policy.ts`. Rejected URLs are omitted; updating a safe
attribute to an unsafe URL **removes** the old attribute. Hydration does not accept
an executable server URL just because it equals the application's requested prop.

* Relative, fragment and protocol-relative URLs are preserved.
* Explicit `http:` and `https:` URLs are accepted.
* Navigation (`href`, `xlink:href`, `action`, `formaction`, `cite`, `ping`) additionally
  supports `mailto:`, `tel:` and `sms:`. `ping` checks every space-separated URL.
* Resources (`src`, `poster`, `background`, `data`, `longdesc`, `manifest`) additionally
  support `blob:` and base64 raster-image data URLs (PNG, GIF, JPEG, WebP, AVIF, BMP,
  ICO). Object `data` does not accept data URLs. HTML/SVG data URLs are rejected.
* Unknown explicit schemes, `javascript:` and `vbscript:` are rejected. Scheme
  recognition follows browser stripping of ASCII tab/newline and leading C0/space,
  and is case-insensitive. Paths containing the word `javascript` are not blocked.
  Attribute escaping prevents HTML entities from becoming a hidden scheme in SSR.

This is a URL-attribute policy, **not a content sandbox**. It does not establish
trust in HTTP origins, blob contents, CSS, raw HTML, `srcdoc`, custom component
implementations or URL-list grammars such as `srcset`. Use trusted content for those
APIs, validate application-specific destinations, sandbox embedded documents and
apply a suitable CSP. Patch IR rejects raw `srcdoc` sinks, like `innerHTML`.
Server markup itself must be trusted: hydration cannot undo script execution that
occurred before the framework started. Direct third-party DOM mutation is outside
the renderer's guarantees.

## Reconciliation and ownership

Matching hydration avoids DOM writes; structural mismatches fall back to a fresh
client tree. Keyed collections preserve node identity for supported stable keys.
Unmount releases framework event listeners, subscriptions, references and owned
boundaries. Retaining application closures or detached DOM nodes in application
code can still retain memory. Tests cover unsafe URL updates on a retained keyed
node and event/subscription inactivity after unmount, as well as existing hydration,
collection, state ownership, animation and template suites.

## Test discovery and release gates

`pnpm test` builds packages/declarations, checks types and parity, then runs animation,
runtime, package and DX tests, docs checks and release/offline-install verification.
`scripts/test-packages.mjs` discovers every root `tests/*.test.mjs` not assigned to
an explicit runtime, DX or browser command in `package.json`. New package tests no
longer require editing a long allowlist. TypeScript test fixtures use `test:types`;
the animation package retains its own `test:animation` gate.

Browser tests are a separate environment-dependent classification: `test:browser`,
`test:browser:vue`, `test:browser:web`, `test:browser:parity` and
`test:browser:showcase` need their documented running demo URLs and Playwright.
Use `demo:release:build` followed by `test:browser:built:smoke` for self-hosted built
React/web checks. `release:check:full` adds all demos, browser checks and benchmark
budgets. A browser test skipped for a missing URL is not evidence of browser success.

Previously undiscovered tests are now in the package gate:

| File | Diagnosis and resolution |
| --- | --- |
| `lazy-index.test.mjs` | Supported; existing tests pass unchanged. |
| `transition-lifecycle.test.mjs` | Supported DOM/motion lifecycle tests pass unchanged. |
| `native-ui-ir.test.mjs` | Obsolete TypeScript type names, positional animation/transition calls, string ShapeStyles and object transactions migrated to canonical syntax. Diagnostics and internal builder paths updated without removing state isolation, keyed stability or motion assertions. |
| `native-ui-ir-modifier-rejection.test.mjs` | Stale rejection expectations: `minWidth` and default antialiased corner radius are supported. Now asserts preserved semantic width and radius. |
| `web-ui-ir.test.mjs` | Overlay count was accidentally global (now verifies direct grid children). Also exposed a real defect: shape foreground paint was serialized as text color instead of visible background. Fixed in the semantic web serializer. |
| `icon.test.mjs` | Discovered automatically when present; ongoing icon work is independent of this hardening. |

## Performance and maintenance

Preserve compiled Patch IR, local invalidation, keyed reconciliation and template
reuse. Existing opt-in web devtools already expose compiled patches, reconciliation
passes, root requests/passes/escalations and collection fallbacks. Use those counters
before replacing hot paths. `benchmarks/performance.mjs` supports reproducible item,
round and warmup settings via `MUN_BENCH_ITEMS`, `MUN_BENCH_ROUNDS` and
`MUN_BENCH_WARMUP_ROUNDS`; `benchmark:browser` adds real-browser measurements.
Synthetic/JSDOM results are not browser frame-time guarantees.

The 4,947-line DOM module already delegates props, hydration, motion, transition,
focus, lazy indexing and Patch IR. The shared URL policy is another small explicit
boundary, not a renderer rewrite. Collection ownership and scheduling are candidates
for future extraction only with invariant tests and comparative measurements.

### Verification snapshot

On macOS ARM64, Node 26.11.1, pnpm 11.22.0:

* Baseline package gate: 617 passed, 2 failed (missing import expectations).
  Independently running the five tracked omitted files: 14 passed, 25 failed.
  The sixth lead was the separate, untracked icon suite; its work was preserved.
* After hardening, `pnpm test`: animation 116, runtime 105, packages 687 and DX 53
  passed (961 total), zero failures/skips. Types, parity, docs, declarations,
  package exports, clean offline install and create-mun verification passed.
  These counts include the locally present independent icon tests.
* Production React/web demo builds and built Chromium smoke: 2/2 passed.
  Playwright Chromium had to be installed first. CI's React 18/19 and native
  multi-OS matrices were not reproduced locally.
* `MUN_BENCH_ITEMS=100 MUN_BENCH_ROUNDS=3 node --expose-gc benchmarks/performance.mjs`:
  22 guarded comparisons completed. Template construction 4.76 ms versus ordinary
  graph construction 160.69 ms for the existing 10,000-construction fixture;
  JSDOM burst update 1.39 ms. These compare existing strategies, not this patch
  against its parent.
* After `pnpm exec vite build --config benchmarks/browser.vite.config.ts`, run
  `MUN_BROWSER_BENCH_ITEMS=1000 MUN_BROWSER_BENCH_ROUNDS=3 MUN_BROWSER_BENCH_WARMUPS=1 node benchmarks/browser-performance.mjs`.
  Chromium medians: web full update 6.30 ms, compiled web full 4.00 ms,
  compiler-map full 2.10 ms; web reverse 3.20 ms, compiled web reverse 0.50 ms;
  static hydration 4.10 ms, state hydration 5.00 ms. This is a small local sample,
  not a CI performance-budget run or a before/after improvement claim. The
  multi-framework benchmark bundle emits Vite's >500 kB chunk warning.

No hot-path replacement was justified by these measurements. Follow-up work should
capture paired browser measurements and heap snapshots before extracting the
collection/scheduler internals or changing reconciliation algorithms.
