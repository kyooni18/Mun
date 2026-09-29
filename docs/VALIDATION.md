# Validation

This file records the release-hardening checks expected before a Mün alpha is
published. The commands are intentionally reproducible and are also represented
in CI where they need network or real-browser support.

## Type and runtime gates

- Type-check every workspace package, the root build, and test declarations.
- Run every non-browser `tests/*.test.mjs` file as one suite.
- Run compiler parser fuzzing and renderer live-conformance tests as part of that
  suite rather than as optional checks.
- Validate all relative documentation links and stale canonical API references.

The hardening workspace passed all 281 unique non-browser tests after the final
compiler scanner regression was added.

## Browser and production-build gates

Production Vite builds cover the React, Vue, and Web demos, the three renderer
parity demos, and the medium Showcase application. Browser CI installs Playwright
Chromium, launches each demo with an isolated Vite cache, and exercises:

- native input/event/ref behavior;
- React/Vue/Web live graph parity;
- keyed State preservation across reorder;
- custom elements and GeometryReader;
- Showcase filtering, bindings, async refresh, reorder, and lazy content.

The browser job also executes the minified production bundles directly through
`test:browser:built`; this catches build-time specialization/minification failures
that a dev-server-only test cannot expose. The final Linux/amd64 hardening run
passed all seven production fixtures (React, Vue, Web, three parity fixtures, and
Showcase) in Chromium.

A local system Chromium may be unavailable or policy-restricted; that is not a
reason to skip the CI Playwright gate.

The standalone browser benchmark prefers Playwright's bundled Chromium, then
falls back to an installed Chrome or Edge channel. Set `MUN_BROWSER_EXECUTABLE`
when validation needs to use a specific compatible Chromium binary.

## Package/release gate

Run `pnpm run test:release`. It verifies every package's declared exports, type
entry points, `sideEffects` contract where applicable, and packed file list. It
also uses `pnpm pack` to ensure `workspace:*` dependencies become concrete
versions, then installs packed packages into a fresh offline project and
smoke-tests imports, React/Vue/Web rendering, the compiler, and the Vite plugin.
The final hardening run packed and verified all nine publishable surfaces: the
root compatibility package plus the eight workspace packages.

## Performance gates

`benchmark:modifiers:ci` guards modifier construction against raw React at
multiple chain depths. `benchmark:performance:ci` guards compiler transforms,
View/ForEach construction, State propagation, Web DOM reconciliation, keyed
updates, hydration, React/Vue rerenders, conditional subtrees, burst updates,
and LazyVStack scrolling. `benchmark:browser:ci` builds a minified production
bundle and measures the same hot collection paths in headless Chromium at 5,000
rows, including raw DOM, raw React/Vue, generic Mün, compiler-owned Mün,
precise State mutations, full replacements, keyed reverse, and Web hydration.

Client renderer measurements include matching raw React and raw Vue fixtures
for three update shapes: a full-tree value change, a single-item change, and a
keyed reverse. Mün adapter timings are reported beside those baselines and CI
can enforce `MUN_BENCH_REACT_CLIENT_RATIO` and
`MUN_BENCH_VUE_CLIENT_RATIO`. The suite also compares the guarded initializer
path with the trusted compiler-resolved `createNodeCompiled` path so a future
semantic change cannot silently reintroduce runtime overload work. It also
compares ordinary dynamic host-graph construction with compiled template
instantiation, while core/compiler tests verify template immutability, generic
fallback rendering, native renderer-hook dispatch, custom-View slot fallback,
and identity parity.

DOM benchmark rounds run sequentially so independent JSDOM instances do not
contend for the same event loop, microtask queue, and garbage collector. Timed
synchronous measurements do not run forced GC inside their timing window;
retained-heap measurement owns its GC separately. The raw DOM text-update
fixture retains the original Text nodes and updates `nodeValue`, so it measures
a meaningful lower bound instead of reconstructing element text content.

The Chromium suite validates the final DOM after every measured update and uses
an explicit raw-DOM floor for single-row text updates, wide text replacement,
and reorder. It is the authoritative renderer-performance regression gate;
JSDOM remains useful for deterministic logic coverage and relative development
microbenchmarks, but its large keyed-reorder timings are not treated as browser
performance. The browser gate also asserts that compiler-owned paths do not
regress behind the corresponding generic Mün path by more than the configured
noise allowance.

These numbers are regression budgets, not cross-framework marketing claims;
they are intended to catch unexpectedly nonlinear or catastrophic changes.
