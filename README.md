# Mün UI

Mün is a native-first standalone UI language, compiler, runtime, and framework.
Canonical `.mun` source lowers into backend-neutral Semantic UI IR. The native
runtime is the primary consumer; Web and Astro are secondary consumers of the
same compiler and semantic model.

The dependency direction is:

```text
.mun
  -> @mun/compiler
  -> Mün Semantic UI IR
     -> mun-runtime
        -> mun-native
           -> macOS / Windows / Linux
     -> secondary Web / Astro backends
```

Mün owns its component, layout, state, input, animation, rendering, and semantic
models. Native Mün does not use HTML, DOM, CSS, WebView, or Chromium internally.
Platform differences stay behind the shared runtime/backend boundary rather than
becoming platform-specific language semantics.

The older React, Vue, Web, and Astro adapters remain compatibility and secondary
integration surfaces while the native path is completed. Legacy React APIs are
isolated under `@mun/ui/legacy`.

Resident Compute Islands remain a separate data-oriented acceleration mechanism;
they do not define Mün's native UI architecture.

## Quick start

### Install and create a native app

With Node.js 20.19 or newer, install a Mün release that includes a native host
for your OS and architecture:

```bash
npm install -g @mun/ui
mun new HelloMun
cd HelloMun
mun dev
```

`mun create HelloMun`, `npm create mun HelloMun`, and `pnpm create mun HelloMun`
use the same native template. No npm install is needed inside the generated app.
Edit `Sources/App.mun`. `mun dev` debounces source changes, recompiles, and
relaunches the native process with fresh state. It is **not hot reload**. Invalid
edits show diagnostics and leave the last valid application running.

```text
HelloMun/
  mun.toml
  Sources/App.mun
  Assets/
  .gitignore
```

Commands discover the nearest `mun.toml` from nested directories:

```bash
mun run          # compile and launch
mun check        # project diagnostics, nonzero on errors
mun fmt --check  # check structural indentation without modifying files
mun fmt          # normalize structural indentation
mun build        # host + Semantic UI IR in .mun/build/<os>-<arch>/<name>
mun package      # unsigned .app on macOS; portable directory elsewhere
mun doctor       # offline host, project, asset, Cargo/Xcode checks
mun editor install --editor all
mun lsp --stdio
```

See [Native project workflow](docs/native-projects.md) for the manifest contract,
packaging/signing steps, resources, local toolchain development, and limitations.
Web/Vite scaffolding is an explicit compatibility workflow:
`mun create MyWebApp --target web`.

### Native checkout

From the Mün repository, build the compiler packages once:

```bash
pnpm install
pnpm build:workspace
```

Then run the representative native application through the complete
source-to-window path:

```bash
node bin/mun.mjs run examples/NativeDemo.mun
```

The same command accepts any canonical standalone Mün file:

```bash
mun run path/to/App.mun
```

`mun run` compiles `.mun` into Semantic UI IR, resolves the native host, and
passes that backend-neutral program to `mun-native`. A packaged native binary is
used when available; source checkouts and source-only packages fall back to the
locked Rust workspace without changing Mün language semantics.

### Compatibility: local Web/React checkout

Mün can be used from a completely separate project without publishing any
`@mun/*` package to npm. Install and build the Mün checkout once:

```bash
cd ~/Code/Mun
pnpm install
pnpm build
```

Then link an existing React project from the Mün repository:

```bash
pnpm dev:link ~/Code/Web/React/MyApp
```

`dev:link` writes direct `link:` entries for the selected renderer plus the
internal `core/compiler` plumbing that bundlers must resolve, and pnpm
11-compatible `overrides:` in the target `pnpm-workspace.yaml` for every
internal `@mun/*` facade package. That last part is important: unpublished
transitive facade packages such as `@mun/compiler` never fall through to the
public npm registry.

Run a watch build while developing Mün itself:

```bash
pnpm dev:watch
```

Now edits in the Mün checkout update facade package `dist/` outputs while the separate
application keeps using the linked facade packages.

To create a brand-new separate project using this checkout:

```bash
cd ~/Code/Mun
pnpm dev:create ~/Code/Web/React/MyMunApp --target web --no-install
cd ~/Code/Web/React/MyMunApp
pnpm install
pnpm dev
```

The equivalent direct CLI is:

```bash
node ~/Code/Mun/bin/mun.mjs create ./MyMunApp --target web --local
```

For Astro, Vue, or the native Web renderer in an existing project:

```bash
pnpm dev:link /path/to/astro-app --renderer astro
pnpm dev:link /path/to/vue-app --renderer vue
pnpm dev:link /path/to/web-app --renderer web
```

If you specifically need portable tarballs instead of source links, Mün can
build a complete local facade package set and install it with pnpm 11 workspace overrides automatically:

```bash
pnpm pack:local
pnpm local:install /path/to/my-app
```

Generated tarballs live under `local-packages/` and are intentionally ignored by
Git so stale versions cannot be committed accidentally.

### Published-package workflow

After the facade packages are published, the standard initializer is:

```bash
pnpm create mun my-mun-app
cd my-mun-app
pnpm dev
```

The generated app uses Mün's direct Web renderer and does not install or
configure React or Vue. Add a renderer facade package separately when an existing
React or Vue application needs framework-specific interop.

The equivalent CLI form is `pnpm dlx mun create my-mun-app`. From an empty
directory, pass `.` to create the app in place. The CLI installs dependencies
by default and prints the command to start development. Use `--no-install` to
inspect the generated files first; Mün will print both the install and dev
commands so setup remains resumable. If installation fails, the scaffold is
kept and the CLI prints the exact recovery command.

Local source scaffolding and linking use pnpm automatically because they rely
on pnpm 11 workspace overrides. `mun link` detects Astro, React, or Vue from the
target package manifest and falls back to the direct Web renderer when none is present;
pass `--renderer` when you need to override detection.

For the canonical Vite compiler, put `munPlugin()` before the renderer plugin:

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { munPlugin } from '@mun/vite'

export default defineConfig({
  plugins: [
    munPlugin(),
    react(),
  ],
})
```


### Astro

Install the integration in an Astro project and register it once:

```js
// astro.config.mjs
import { defineConfig } from 'astro/config'
import mun from '@mun/astro'

export default defineConfig({
  integrations: [mun()],
})
```

A `.astro` file can embed a native Mün region without wrapping it in HTML:

```astro
---
const title = 'Dashboard'
---

<main>
  <h1>{title}</h1>

  @mun Hero {
    VStack(spacing: 8) {
      Text(title)
      Text("Static Mün")
    }
  }
</main>
```

Static `@mun` regions render on the server and add no client JavaScript. If the
embedded Mün region uses state, bindings, action closures, or client effects, the
integration turns it into an Astro island automatically:

```astro
@mun Counter {
  const count = State(0)

  Button(String(count.value)) {
    count.value += 1
  }
}
```

Use an explicit Astro hydration policy when needed:

```astro
@mun (client: visible) {
  ExpensiveInteractiveView()
}

@mun (client: media("(min-width: 900px)")) {
  DesktopControls()
}
```

Standalone `.mun` Views can also be imported as Astro components. Static imports
need no client directive; interactive standalone Views use Astro's normal
`client:*` directives:

```astro
---
import { Greeting } from '../components/Greeting.mun'
---

<Greeting name="Ada" />
```

The boundary is intentionally strict: canonical `.mun` files and embedded
`@mun` regions contain Mün Views, not raw HTML. Keep host HTML in Astro and compose
Mün UI with `Text`, `VStack`, `Button`, and other Mün Views inside the Mün region.
Astro HTML slots are not passed through a Mün View boundary.

A Mün screen can stay in ordinary TypeScript when you do not need builder
syntax:

```ts
import {
  Button,
  HStack,
  Spacer,
  State,
  Text,
  VStack,
} from '@mun/ui'
import { Action, view } from '@mun/react'

const count = State(0)

export default view(() => (
  VStack(
    { alignment: 'leading', spacing: 16 },
    Text('Hello, Mün').fontSize(28).bold(),
    Text(`Count: ${count.value}`),
    Button('Increase', Action(() => { count.value += 1 })),
    HStack(
      Text('Left'),
      Spacer(),
      Text('Right'),
    ).frame({ maxWidth: 'infinity' }),
  )
  .padding(24)
  .frame({ maxWidth: 'infinity' })
))
```

`@mun/vite` lowers `.mun` and compatibility `.mun.ts` builders, labeled
initializers, shorthand modifiers, and custom `struct ...: View` declarations.
Canonical `.mun` rejects raw HTML; legacy host-file compatibility remains isolated
to the older `.mun.ts`/framework paths. The root `mun` entry remains renderer-independent;
select React, Vue, Web, or Astro from the corresponding `@mun/*` renderer facade package.

## Publishing to npm

Once the npm scope is ready, the repository can publish the complete synchronized facade package set with one command:

```bash
pnpm release:dry   # full verification + npm dry-run
pnpm release       # publish the current version
pnpm release:patch # bump every facade package, verify, and publish
```

The release helper publishes in dependency order and can resume a partial release by skipping versions that already exist on npm. See [Publishing Mün to npm](docs/PUBLISHING.md) for first-time npm setup, versioning, tags, and recovery.

See [Local development](docs/LOCAL_DEVELOPMENT.md) for the complete separate-
project workflow.

## Editor and LSP integration

Mün includes a standalone stdio language server and setup generator for Vim,
Neovim, VS Code, Zed, Helix, and generic LSP clients:

```bash
npx mun editor install --editor all
mun lsp --stdio
```

To export the included VS Code extension as an installable VSIX:

```bash
pnpm vscode:package
code --install-extension dist/mun-language-support-<version>.vsix
```

See [Editor integrations](docs/EDITORS.md) for global installs and client
configuration details.

## View values, initializers, and builders

Mün's declarative core now has a View/initializer boundary. Built-in Views and
user Views select a registered initializer from the actual argument list before
rendering; a trailing block is valid only when that selected initializer accepts
`@ViewBuilder` or `@Action`.

```ts
import { defineView, initializer, resolveBuilderClosure, Text, VStack } from '@mun/ui'

const Card = defineView('Card', {
  initializers: [initializer(
    'Card(@ViewBuilder content)',
    args => args.length === 1 && typeof args[0] === 'function',
    args => ({ content: resolveBuilderClosure(args[0]) }),
  )],
  body: ({ content }) => VStack(() => [content]),
})

Card() {
  Text('CPU')
  Text('72%')
}
```

The compiler also lowers the optional `struct Name: View { ... }` form to this
model, including `var body`, `@ViewBuilder`, `@Action`, and `@State` fields.
Builder blocks support nested Views, conditionals, optional branches, and
`ForEach(items) { item in ... }`. The compiler resolves syntax by initializer
metadata rather than a hard-coded component-name list; malformed calls produce
structured compiler diagnostics and `MunInitializerError` at the runtime
boundary. When a same-file custom View call has exactly one declaration-defined
initializer match, or an imported View exposes one unique non-variadic typed
call signature, the compiler emits a direct initializer-index path. Calls that
the compiler can fully prove now use the trusted `createNodeCompiled` AOT path:
runtime overload scans, label normalization, and repeated parameter scoring are
removed. Swift-style labeled arguments are normalized to the runtime
initializer's positional payload when that mapping is unambiguous, and simple
`@ViewBuilder` closures are lowered directly to child arrays. Ambiguous,
variadic, `any`/`unknown`, opaque-call, or otherwise unproven cases retain the
guarded specialization or normal runtime resolver.

Production lowering also fuses statically typed modifier chains into compact
`modifiedContentCompiled` descriptors. Proven intrinsic host trees can be
lowered further into an immutable compiled template plus identity-preserving
dynamic slots: static host structure is defined once, while React, Vue, Web DOM,
and Web SSR use cached native template factories and re-enter generic graph
traversal only for the dynamic slots. Fully static View subtrees are still
hoisted to module scope. Every template optimization has a generic graph
fallback, so renderer-independent semantics do not depend on successful AOT
analysis. State dependency metadata follows the same rule: the compiler may mark
a dependency set complete only for a deliberately small, proven closed body;
all other Views continue to use runtime dependency collection.

The same source syntax can be used with built-in and custom Views:

`Button` intentionally has only these two Mün forms:

```ts
Button('Save') { save() }
Button(action: { save() }, label: { Text('Save') })
```

The custom-label form is declaration-ordered; `label:` before `action:` and
unlabeled closure pairs are compiler errors.

```ts
VStack(alignment: .leading, spacing: 12) {
  Text('Header').font(.title)
  if (enabled) {
    EnabledView()
  } else {
    DisabledView()
  }
}

Button(action: { save() }, label: {
  Text('Save')
})
```

`munPlugin()` lowers these builder, labeled-argument, shorthand-modifier, and
`struct` forms before the TypeScript/React transform. `parseMunBuilder()` and
`parseMunStructs()` expose the source-ranged AST consumed by that lowering
pass, without a component-name allow-list. Labeled calls use an internal
`namedArguments()` carrier; JavaScript object calls remain available as the
compatibility form. Editor integrations that do not
run Vite can use `createMunLanguageService()` from `@mun/compiler`;
its diagnostics and positions remain in the original Mün source space. A
TypeScript host can use `createMunTypeScriptLanguageService()` to parse the
same lowered snapshots in editor tooling; diagnostics and common text spans are
mapped back to the original Mün file.

## React entry point

A minimal app entry can stay free of JSX too:

```ts
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('app')!).render(createElement(App))
```

## Reusable views with props

`view()` can also create reusable React components with typed props:

```ts
const Greeting = view((props: { name: string }) =>
  Text(`Hello, ${props.name}`),
)
```

State-scoped views can initialize their local Mün state from React props too:

```ts
type CounterProps = {
  initial: number
  label: string
}

const Counter = view({
  state: (props: CounterProps) => ({
    count: State(props.initial),
  }),
  body: ({ count }, props) =>
    Text(`${props.label}: ${count.value}`),
})
```

The state factory runs once per mounted component instance. Later prop changes are passed to the body without recreating that instance state.

## Mutable State containers

Arrays and plain objects stored in `State()` are mutation-aware, including nested plain objects. You can update them directly without cloning the whole root value:

```ts
const todos = State([
  { title: 'Ship Mün', done: false },
])

Button('Add', Action(
  todos.value.push({ title: 'Next item', done: false })
))

Button('Complete', Action(
  todos.value[0].done = true
))
```

Direct assignment still works normally. React elements, frozen values, class instances, `Map`, `Set`, and other special objects are not proxied as mutable containers; replace the `State.value` root when those values change.

If two `State()` containers are created from the same raw array or plain object,
they share mutation ownership: a mutation through either container notifies both
containers' subscribers. The containers keep their own state references, so
application code should treat `State()` as the ownership boundary rather than
comparing proxy identity. Sharing raw mutable containers is supported and is
observable behavior, not an accidental implementation detail.

## Stable and experimental APIs

The stable root API is the function DSL: views, state, elements, controls,
collections, presentation primitives, modifiers, and the React component
interop helpers. The layout-engine, coordinate runtime, layout observer,
metadata/plugin registry, and block-builder transform are experimental while
their integration contract is being consolidated:

```ts
import { layoutPass, registerMunPlugin } from '@mun/ui/experimental'
```

The automatic JSX runtime remains available through `@mun/ui/jsx-runtime` and
`@mun/ui/jsx-dev-runtime`. Function-DSL and JSX-created elements both pass through
registered experimental plugins. The block-builder compiler adapter remains
available through `@mun/ui/compiler`; it is not part of the stable root DSL
contract.

## Coordinate-free layout

Mün prefers relationships over x/y coordinates:

```ts
VStack(
  { alignment: 'leading', spacing: 12 },
  Text('Title'),
  HStack(
    Text('Left'),
    Spacer(),
    Text('Right'),
  ),
)
```

Core layout primitives include `Box`, `VStack`, `HStack`, `ZStack`, `Grid`, `ScrollView`, `SafeArea`, `GeometryReader`, `Spacer`, `Divider`, and `Group`.

`Spacer()` consumes available flex space. `Spacer(minLength)` keeps that explicit minimum when flex space becomes tight. `HStack` is full-width by default, and `.frame({ maxWidth: 'infinity' })` is available when a parent or another element should explicitly stretch.

`frame` creates a renderer-neutral layout host around its content. Its width and
height constraints apply to that host, while `alignment` places the content in
the host (`leading`/`trailing` are horizontal, `top`/`bottom` are vertical, and
the corner values combine both axes). This keeps alignment predictable for raw
HTML, custom Views, React components, and Vue components, including SSR output.
Styles applied before `frame` belong to the content; styles applied after it
belong to the frame host.

## Simple and advanced CSS styling

Use the simple modifiers for the styles that are common to most views. They stay
readable and can be chained with layout modifiers:

```ts
Text('Hello')
  .fontSize(32)
  .bold()
  .foreground('#eee')
  .padding(12)
  .background('#222')
  .style({ borderRadius: 10 })
```

Use `.style()` when you need an arbitrary inline CSS property, including CSS
custom properties. Custom properties are useful for sharing a value with an
external stylesheet:

```ts
Text('Hello')
  .style({
    letterSpacing: '0.05em',
    userSelect: 'none',
    '--accent': '#7c3aed',
  })
```

For advanced selectors, responsive rules, pseudo-classes, and animations, keep
the CSS in a normal stylesheet and attach one or more classes. Class arrays can
contain conditional values, and repeated `.className()` calls are composed:

```ts
Text('Hello')
  .className(['card', isFeatured && 'card--featured'])
  .className('u-shadow')
```

This gives simple styles a concise modifier syntax while preserving the full
CSS escape hatch through `.style()` and `.className()`.

## React compatibility JSX

Automatic JSX remains an optional React compatibility surface. Set
`jsxImportSource` to `mun` when using its legacy JSX runtime. New
renderer-independent code should use the `mun` function DSL; the canonical
graph does not depend on JSX or React's runtime.

## React components are first-class layout items

Ordinary React components can sit beside Mün primitives and `Spacer()`:

```ts
function ProfileCard(props: { name: string }) {
  return createElement('strong', null, props.name)
}

HStack(
  Text('Profile'),
  Spacer(),
  Component(ProfileCard, { name: 'Mün' })
    .padding(12)
    .frame({ minWidth: 240 }),
)
```

Inside a Mün layout container, a normal React component gets one neutral outer layout host. Layout modifiers apply to that host instead of being pushed into the component's own props. React keeps ownership of the component itself, including hooks, refs, context, props, children, and rendering. Direct React elements, `memo(...)`, and `forwardRef(...)` components follow the same layout-host rule.

`Raw(element)` accepts an already-created React element when modifier chaining is needed.

## Controls

```ts
Text('Hello')
Button('Save', save)
TextField(name)
TextArea(description)
Toggle(enabled)

Image('/avatar.png', { alt: 'Profile', fit: 'cover' })
Label('Profile', Text('●'))
Link('Settings', '/settings')
ProgressView(progress, { max: 1 })
Picker(category, categories)
Slider(volume, { min: 0, max: 1, step: 0.05 })
Stepper(quantity, { min: 0, max: 10 })
```

### Symbol and content transitions

`VectorSymbol` accepts both authored symbols and real icon-pack geometry.
Ordinary SVG primitives are normalized to paths, while explicit layer ids keep
semantic identity separate from rendered SVG geometry. `@lucide/icons` data can
be used directly without a Mün/Lucide runtime bridge:

```ts
import { Pause, Play } from '@lucide/icons'

const play = VectorSymbol.fromLucide(Play)
const pause = VectorSymbol.fromLucide(Pause)

Image(isPlaying.value ? pause : play)
  .contentTransition(ContentTransition.symbolEffect(SymbolEffect.automatic))
  .animation(Animation.spring(0.48, 0.7), isPlaying.value)
```

Custom icons do not need hand-normalized `d` strings either:

```ts
const search = VectorSymbol.fromSVGNodes([
  ['circle', { cx: 11, cy: 11, r: 6.5, stroke: 'currentColor', fill: 'none' }],
  ['line', { x1: 16, y1: 16, x2: 21, y2: 21, stroke: 'currentColor' }],
], { name: 'search', viewBox: '0 0 24 24' })
```

Generated ordinal layers such as `layer:0` are treated as geometry, not
semantic identity. Standard icon source keys are retained when available
(including Lucide node keys), so genuinely shared geometry stays live across
related symbols. Unnamed layers are globally assigned by geometry and
presentation instead of array order; compound contours are paired by shape
role before split/merge duplication. Added stroke-only layers draw on/off,
while unrelated topology can still split or converge continuously. Differing
viewBoxes and nested SVG transforms are normalized as part of the transition.

Mün source accepts the matching Swift-style shorthand:

```ts
Image(icon)
  .contentTransition(.symbolEffect(.magicReplace(fallback: .downUp)))
  .animation(.spring(response: 0.28, dampingFraction: 0.86), value: active)

Text(status)
  .contentTransition(.interpolate)
  .animation(.spring(response: 0.42, dampingFraction: 0.78), value: status)

Text(status)
  .contentTransition(.blurReplace(radius: 8))
  .animation()

Text(status)
  .contentTransition(.push(from: .trailing))
  .animation()

Text(status)
  .contentTransition(.scale(scale: 0.84))
  .animation()

Text(String(count))
  .contentTransition(.numericText(value: count))
  .animation()
```

`ContentTransition` changes content inside a stable View; `Transition` remains
the insertion/removal lifecycle API. `Path(d).animation()` also morphs SVG path
data directly without requiring a `VectorSymbol` wrapper. Web path morphing
normalizes path topology once, preserves active presentation state during
retargeting, and keeps path, color, opacity, transform, and layout motion on
independent ownership channels. The path parser accepts compact SVG arc syntax
used by production icon packs. High-confidence geometry preserves spring
overshoot; uncertain correspondence clamps the silhouette to monotonic progress
while the surrounding transform can still spring, reducing self-intersection
and inside-out intermediate shapes.

## Collections

```ts
List(
  Section('Account',
    Text('Profile'),
    Text('Security'),
  ),
)

LazyVStack({ estimatedItemSize: 56 }, ...rows)
LazyHStack(...cards)
LazyGrid({ columns: 3, estimatedItemSize: 160 }, ...cards)
```

`Lazy*` carries estimated-size metadata for every renderer. Direct `@mun/web`
mounts window children and updates the range on scroll/resize; SSR, React, and
Vue materialize the full graph while retaining the browser `content-visibility`
hint.

## Navigation and presentation

Navigation remains router-agnostic. Pass any object with `push(destination)`:

```ts
NavigationStack(
  router,
  VStack(
    NavigationLink('/profile', 'Profile'),
    NavigationLink('/settings', 'Settings'),
  ),
)
```

Presentation primitives use React portals and platform HTML:

```ts
Sheet(showingDetails, detailsView)
Alert(showingAlert, { title: 'Delete item?' })
Menu('Actions', editButton, deleteButton)
```

`Sheet()` and `Alert()` use `createPortal()`. They render no portal markup in
the server or hydration render and mount after the client effect, avoiding
hydration mismatches. Nested presentations receive increasing z-index values.
`Menu()` uses native `details` / `summary`, first-item focus, keyboard
navigation, disabled-item skipping, typeahead, and trigger restoration.

## Explicit no-macro form

Vite macros are optional. The explicit state-scoped form is:

```ts
export default view({
  state: () => ({ count: State(0) }),
  body: ({ count }) => VStack(
    Text(`Count: ${count.value}`),
    Button('Increase', () => { count.value += 1 }),
  ),
})
```

## Tests

```bash
pnpm test
pnpm run demo:build
pnpm run test:browser
pnpm run benchmark:modifiers
pnpm run benchmark:performance:ci
```

The application-style benchmark includes raw React and raw Vue client baselines
for full-tree, single-item, and keyed-reverse updates alongside the Mün React
and Vue adapters. Ratio thresholds are regression guards rather than claims
that a renderer is intrinsically a fixed multiple faster or slower.

`test:browser` is opt-in and uses `MUN_BROWSER_URL` so it can target a running
demo server, for example
`MUN_BROWSER_URL=http://localhost:5173 pnpm run test:browser`. CI uses the
committed `pnpm-lock.yaml` with frozen-lockfile mode
and runs the suite against React 18 and React 19.

## End-to-end example

The Vite example is a small component demo in [`examples/App.ts`](examples/App.ts). It
shows a text field, slider, checkbox, button, and progress view in a Mün
layout.

Run it locally with:

```bash
pnpm run dev
```

Then open the local URL printed by Vite and exercise the text field, slider,
toggle, button, progress view, and responsive stack layout.

## Status

The facade package family is currently versioned as `0.1.0`. React is an optional
renderer; Vue and direct web/DOM renderers are first-class canonical adapters.
The previous root API remains available only through the explicit legacy layer.

Mün's layout API is SwiftUI-inspired and CSS-native rather than a promise of
SwiftUI's proposal-based geometry algorithm. `frame`, `Spacer`, stacks, and
infinity sizing translate the relationship into CSS-native web layout semantics; they
do not guarantee pixel-for-pixel SwiftUI behavior.

See [Getting started](docs/GETTING_STARTED.md), [Design](docs/DESIGN.md),
[Styling](docs/STYLING.md), [Migration](docs/MIGRATION.md), [API](docs/API.md),
[Roadmap](docs/ROADMAP.md), and [Changelog](docs/CHANGELOG.md).

For a complete learning-oriented treatment, read [Mün: a human-first guide](docs/MUN_BOOK.md).
For coding agents and compact retrieval, use the [Mün AI agent reference](docs/AI_AGENT_REFERENCE.md).
