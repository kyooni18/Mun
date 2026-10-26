# First language and web milestone

Scope: the first vertical slice in [the implementation plan](LANGUAGE_AND_WEB_PLAN.md),
not completion of its eight phases. `.mun` is the primary application language;
JavaScript is its compilation and integration target.

## Acceptance criteria (agreed before implementation)

1. A counter and profile form contain all UI and application behavior in `.mun`.
   Host code only mounts/hydrates the app or implements a demo HTTP endpoint.
2. Instance-owned `@State` drives the counter. A profile field exercises `@Binding`
   and `$` projection; validation rejects an empty name before any request.
3. A lifecycle-owned async submission exposes pending, success and recoverable
   error states. Cancel, supersede and removal abort work; stale results cannot
   publish even if the transport ignores abort. Retrying can succeed.
4. Unrelated counter updates retain the profile input DOM node, text, focus and
   selection. Multiple mounted instances do not share state.
5. SSR and client mounting consume the same compiled View graph. Useful form HTML
   exists before attachment; hydration retains a pre-attachment input edit and
   starts no submission. Server rendering never starts browser lifecycle tasks.
6. The parser, compiler and web diagnostics share the implemented subset; invalid
   binding and async usage identify the original `.mun` location. Unsupported
   language features are documented without silently promising full Swift.
7. Focused regression tests and real Chromium checks cover these behaviors.
   Changed packages compile; docs distinguish verified, partial, missing and
   experimental capabilities. Coherent checkpoints are committed.

## Implementation evidence

Implemented in the checkpoints below. See [capabilities](CAPABILITIES.md) for
the implemented subset and remaining gaps.

### Compiling integration checkpoint

The examples are in `examples/language-web/Counter.mun`, `Profile.mun` and
`App.mun`. Run `node examples/language-web/server.mjs` and open
`http://127.0.0.1:4178/`. The server compiles the same modules through Vite for
SSR and client use; only `client.ts` attachment and the demo HTTP endpoint live
outside Mun. Enter `fail` to exercise a recoverable HTTP failure.

The compiler retains method return types and body ranges, preserves synthesized
binding parameters, checks known member binding roles and rejects `await` outside
async functions. Web diagnostics use that lowering; native diagnostic consumers
select `{ target: "native" }`. The editor retains native compilation-unit behavior
for `@main` sources. Core adds `TextField(_:text:)` and Element builder children.
Hydration adopts dirty text inputs through their normal input handler so State
matches early user edits.

Checks at this checkpoint: compiler/core/web builds; the three tests in
`tests/language-web.test.mjs`; six LSP quickfix tests; 206 existing compiler,
canonical native diagnostic, control and web renderer tests. Real-browser evidence
is recorded in the following checkpoint. The current scope and gaps are tracked
in [capabilities](CAPABILITIES.md).

### Browser and contract checkpoint

`pnpm test:browser:language-web` starts an isolated demo server and runs real
Chromium. It checks server HTML with JavaScript disabled; delays client attachment
while editing; preserves the input node/focus/selection through updates; submits
using Enter; exercises the real HTTP failure endpoint and a network rejection;
then verifies retry, superseding an older request, cancel and removal/remount.
No uncaught browser errors remain. Screenshot: local ignored artifact
`output/language-web-browser.png`.

The demo host connects Vite HMR to its own HTTP server, avoiding a second shared
WebSocket port. `pnpm demo:language-web:build` creates a production client bundle
with source maps in `output/language-web`. Production SSR deployment is not part
of this example; use its development host for the SSR acceptance scenario.

Validation completed:

- `pnpm check` (all workspace builds and root TypeScript check).
- `pnpm test:types` (existing declaration tests; no new compile-time matrix).
- `node --test tests/language-web.test.mjs tests/lsp-quickfix.test.mjs`.
- Existing compiler package/canonical diagnostic/control/web suites: 206 passed.
- Compiler hardening/parser/import, CLI/editor, hot reload/incremental and new
  integration suites: 82 passed.
- `pnpm test:browser:language-web` and `pnpm demo:language-web:build`.
- `pnpm test:docs` and `git diff --check`.

README, architecture, semantics, styling, getting-started/migration/agent guidance
and the default web scaffold now describe `.mun` as the primary language. The
[language reference](LANGUAGE_REFERENCE.md) specifies the current expression,
function, binding, identity and task subset and explicitly records differences
from Swift. The native book/design documents remain labeled historical.

Remaining gaps include full module/type/async-result analysis, typed HTTP decoding,
standard cached data/mutation APIs and automatic stale-result publication guards,
arbitrary SSR state serialization/loaders, production SSR adapters and broader
browser/IME/autofill/accessibility coverage. Request revision guards in the profile
are application code. This checkpoint completes the requested first slice, not
the complete implementation plan or all exit criteria of Phases 1–3.
