# Local development

This is the recommended workflow while Mün packages are not published to npm.
The Mün checkout and the application remain completely separate projects.

## 1. Prepare the Mün checkout

```bash
cd ~/Code/Web/React/Mun
pnpm install
pnpm build
```

Internal workspace dependencies use `workspace:*`. This guarantees that
building Mün itself never depends on a previously published `@mun/*`
version. `pnpm pack` rewrites those workspace dependencies to the package
version for release archives.

## 2. Link an existing app

From the Mün checkout:

```bash
pnpm dev:link ~/Code/Web/React/MyApp
```

The command edits the target `package.json` with direct source links:

```json
{
  "dependencies": {
    "@mun/ui": "link:/absolute/path/to/Mun",
    "@mun/react": "link:/absolute/path/to/Mun/packages/react"
  },
  "devDependencies": {
    "@mun/core": "link:/absolute/path/to/Mun/packages/core",
    "@mun/compiler": "link:/absolute/path/to/Mun/packages/compiler",
    "@mun/vite": "link:/absolute/path/to/Mun/packages/vite"
  }
}
```

`link:` packages do not install their own dependency graph, so the linker also
adds the internal packages needed by the selected renderer directly as development
dependencies. It writes `overrides:` to the target `pnpm-workspace.yaml` for all
internal Mün packages as a second guard. This prevents a linked `@mun/vite` from trying to download `@mun/compiler`, or a linked
React renderer from trying to download `@mun/core`, from npm.

Use another renderer explicitly when needed:

```bash
pnpm dev:link /path/to/vue-app --renderer vue
pnpm dev:link /path/to/web-app --renderer web
```

Pass `--no-install` if you only want the manifest changed.

## 3. Keep Mün outputs fresh

```bash
pnpm dev:watch
```

The watch command performs one clean build and then watches the root package and
each TypeScript workspace package. A linked app can stay open in its own Vite
dev server while Mün is edited.

## 4. Create a separate app directly from the checkout

```bash
pnpm dev:create ~/Code/Web/React/MyMunApp
```

This is equivalent to:

```bash
node bin/mun.mjs create ~/Code/Web/React/MyMunApp --local
```

The generated project uses the direct Web renderer, does not install React or
Vue, and is not a Mün workspace member. Its dependencies point back to the
Mün checkout through `link:` paths.

## 5. Local tarballs when links are undesirable

Generate current-version archives:

```bash
pnpm pack:local
```

Then configure another project with the generated archives:

```bash
pnpm local:install /path/to/my-app
```

The installer adds `file:` dependencies and pnpm 11 workspace overrides for all internal
archives, so transitive unpublished packages cannot leak to the registry.

Generated `.tgz` files and `manifest.json` are ignored by Git. Do not commit
local package archives; regenerate them from the current source instead.

## 6. Vite configuration

React:

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { munPlugin } from '@mun/vite'

export default defineConfig({
  plugins: [munPlugin(), react()],
})
```

The Mün transform must run before the renderer plugin.
