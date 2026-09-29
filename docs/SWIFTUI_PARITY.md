# SwiftUI API parity

Mün's canonical authoring surface is moving from hand-maintained TypeScript
signatures to an SDK-derived SwiftUI contract. The goal is that a Mün call uses
the same public name, argument labels, argument order, defaultability, overload
shape, and closure role as SwiftUI whenever that API exists in Mün.

This work deliberately separates three concerns that used to be conflated:

- **Canonical SwiftUI surface** — APIs that participate in parity checks and are
  accepted by the compiler as SwiftUI-style source.
- **Compatibility surface** — historical Mün-only helpers such as `margin`,
  `gap`, `className`, and `withProps`. They remain callable while migration is in
  progress, but they are not counted as SwiftUI API parity.
- **Fidelity** — every canonical View/modifier says whether it is `source`, a
  `source-subset`, or a `web-approximation`. A matching name/signature therefore
  never implies pixel-identical or type-complete native SwiftUI behavior.

Plain positional JavaScript/TypeScript calls remain a compatibility escape
hatch. Swift-style labels and trailing closures are resolved against the
canonical manifest. This keeps existing Mün code working without letting
runtime-only overloads silently become SwiftUI source syntax.

## Source of truth

`packages/core/src/api-manifest.ts` is the source-contract and compiler truth for
the SwiftUI slice Mün currently claims. Runtime View types keep compatibility
overloads where needed, but every canonical initializer maps explicitly to its
runtime implementation and the manifest checker validates that mapping. This is
intentional: the runtime can stay efficient and backward-compatible without
silently widening the SwiftUI authoring contract.

The manifest is not intended to be manually invented from memory. On macOS with
Xcode installed, capture the public SwiftUI SDK first:

```sh
pnpm snapshot:swiftui
```

This runs `swift-symbolgraph-extract` against the selected Xcode SDK and writes
`api/swiftui-symbols.snapshot.json`. Modern Xcode splits foundational SwiftUI
symbols between `SwiftUI` and `SwiftUICore`, so Mün snapshots both modules by
default. The snapshot records each symbol's originating module, public
declarations, function signatures, availability, relationships, the Xcode/SDK
version, and a stable symbol digest. A different SDK, target, or module set can
be selected with:

```sh
node scripts/snapshot-swiftui-api.mjs --sdk iphonesimulator --target <triple> --modules SwiftUI,SwiftUICore
```

A snapshot should be regenerated intentionally when the project changes its
SwiftUI reference SDK. Do not silently mix declarations from different Xcode
versions.

## Manifest consistency

After changing the manifest or graph API, build core and run:

```sh
pnpm check:swiftui-manifest
```

The check verifies that every manifest View is exported, every canonical
initializer maps to an actual runtime initializer, compiler initializer symbols
match the manifest, every canonical entry declares its fidelity, every manifest
modifier exists on the View graph, and the compiler static-modifier set is
generated from the same manifest.

When an SDK snapshot is available, also run:

```sh
pnpm check:swiftui-snapshot
```

That check verifies canonical View names, initializer titles, optional/defaulted
initializer parameters, and modifier signatures against the public symbols
extracted from the selected Xcode SDK. It recognizes modern `swift.method`
modifier symbols as well as older symbol-graph function forms.

The current manifest is still a migration slice, not a claim of complete SwiftUI
coverage. Its canonical View slice is `Text`, `VStack`, `HStack`, `ZStack`,
`Button`, `Spacer`, `Divider`, `Group`, `GeometryReader`, `List`, `Section`,
`Toggle`, and `TextEditor`. The modifier slice is substantially broader: it now
covers 108 SDK-backed modifier names spanning layout and safe areas, grids,
2D/3D transforms, typography, visual effects, structural composition,
interaction and focus, scrolling and list rows, control-style hints, symbol
rendering, drag/drop, color-scheme behavior, and accessibility metadata. Each entry intentionally
exposes only the overloads Mün can support and audit today.

The graph/renderer modifier contract can render modifier-owned View arguments.
View-backed `background` and `overlay` therefore remain real graph structure
rather than being flattened into CSS strings. Swift-style labeled modifier
lowering also has exact runtime slots for omitted defaulted parameters and
action-closure lowering for tap, long-press, and hover modifiers.

Same-name APIs outside that slice are not implicitly canonical. In particular,
web primitives or simplified controls such as `Grid`, `Canvas`, `Path`, `Image`,
`NavigationLink`, and `Picker` should be treated as Mün APIs until their actual
SwiftUI contract is represented in the manifest. A familiar name is not enough.

## Labeled arguments

Mün source preserves SwiftUI-style labels even though the JavaScript runtime
ultimately receives positional values or an options object. The lowering is
manifest-driven. For example:

```ts
VStack(alignment: .leading, spacing: 12) {
  Text("Hello")
    .frame(width: 240, height: 44)
    .offset(x: 8, y: 0)
}
```

is lowered to the existing renderer-neutral graph representation. Compatibility
runtime overloads do not become canonical compiler overloads merely because they
exist in JavaScript.

The manifest can map a canonical source initializer to a different runtime
initializer index. For example, SwiftUI's `VStack(alignment:spacing:content:)`
is lowered into Mün's compact options-object runtime initializer. That mapping
is explicit and checked instead of relying on declaration order accidentally
matching across independent tables.

## Fidelity levels

`source` means the implemented slice preserves the SwiftUI source contract and
its direct semantics closely enough that no web-specific caveat is material to
that slice. `source-subset` means the spelling/overload is SDK-backed but Mün
accepts a narrower value family or implements only part of SwiftUI's generic
contract. `web-approximation` means the source contract is recognizable but the
native layout/control behavior is deliberately mapped to browser semantics.

Examples matter here. `opacity` is a direct source-level mapping. `font`,
`foregroundStyle`, and `background` currently accept a narrower web-oriented
value family than SwiftUI's `Font`, `ShapeStyle`, and arbitrary background
`View` families, so they are subsets. `frame`, stack layout, `padding`, anchors,
and browser controls are web approximations. `idealWidth`/`idealHeight` now have
observable behavior, but on the web they act as preferred width/height fallbacks
rather than reproducing SwiftUI's full proposal/ideal-size layout algorithm.

The expanded web-approximation set maps native concepts to observable browser
semantics instead of accepting and ignoring them. This includes edge-set
padding, `fixedSize`, `layoutPriority`, `position`, `zIndex`, `clipShape`,
`shadow`, filter effects, text decorations and line constraints, `disabled`,
hit testing, pointer gestures, scroll behavior, `color-scheme`, and ARIA-backed
accessibility modifiers. React, Vue, DOM, and HTML rendering consume the same
modifier graph and are covered by cross-renderer conformance tests.

Subsystem-heavy APIs remain outside the canonical claim until their semantics
exist. Broad Environment propagation, View lifecycle (`onAppear`,
`onDisappear`, `task`), preference keys, full gesture composition, custom
SwiftUI-style protocol implementations behind control styles,
navigation/toolbars, and platform presentation APIs are not counted as
implemented merely because a browser analogue could share their name. The
canonical control-style modifiers currently map supported built-in style values
to renderer-visible web behavior; they are not a claim that arbitrary SwiftUI
`ButtonStyle`/`ToggleStyle` implementations execute unchanged on the web.

Mün's parameterless `.animation()` is deliberately a Mün extension. It stays
callable and compiler-specialized, but the SDK parity checker excludes that
signature while continuing to check SwiftUI's `.animation(_:)` and
`.animation(_:value:)` forms.

## Animation architecture

Animation is split at the graph/renderer boundary so Mün source does not depend
on the initial browser implementation:

```text
State mutation
    |
    v
Transaction(animation)
    |
    v
View invalidation / graph evaluation
    |
    v
renderer transaction
    |
    +--> @mun/web -> @mun/animation numeric/color/transform interpolation
    |
    `--> @mun/react / @mun/vue -> renderer-native style transition fallback
```

`Animation`, `Transaction`, `withAnimation`, and `withTransaction` live in core.
State writes snapshot the active mutation transaction, so asynchronous renderer
updates do not lose the animation selected at mutation time. React, Vue, and DOM
renderers consume the same render transaction.

The DOM renderer uses the in-workspace `@mun/animation` package for numeric, color, and transform values.
Spring updates keep the current value and velocity when a state update retargets
an element, and a per-element/property control cancels the previous motion.
The first render remains synchronous for SSR and hydration safety. React and Vue
continue to expose the same transaction contract and use their style-transition
fallback until they have an equivalent host-commit adapter. The Web renderer is
the reference implementation for property-aware motion and explicit trigger
handling. This renderer difference is an implementation limitation, not hidden
behind a parity claim.

The Web motion engine executes delay/repeat metadata and retargets live motion
channels. Layout/transition retention is still not a full SwiftUI-compatible
animation engine, and React/Vue intentionally remain simpler fallbacks. The
public `Animation`/`Transaction` values stay renderer-independent so these
implementation details can evolve without changing authoring syntax.

## Expansion order

When adding parity for another SwiftUI API:

1. Confirm the declaration in the SDK symbol snapshot.
2. Add its canonical initializer/modifier declaration to the manifest.
3. Add or adapt the renderer-neutral graph implementation.
4. Add lowering only when JavaScript cannot represent the Swift label syntax
   directly.
5. Add positive and negative compiler diagnostics tests.
6. Run the manifest check and renderer tests.

Do not add a second compiler-only signature table. If an API cannot yet be
represented faithfully, leave it outside the canonical manifest rather than
pretending parity.
