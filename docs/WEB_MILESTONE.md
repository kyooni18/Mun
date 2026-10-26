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

Pending implementation. See the final checkpoint for commands, capability status,
source examples and remaining gaps.
