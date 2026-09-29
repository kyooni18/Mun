import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createMunAstroSourcePlugin,
  generateVirtualMunModule,
  munAstro,
  transformAstroMunSource,
} from "../packages/astro/dist/index.js"
import astroRenderer from "../packages/astro/dist/server.js"
import { Text } from "../packages/core/dist/compat.js"

test("@mun static blocks capture frontmatter values without adding client JavaScript", () => {
  const source = `---
const title = "Mün"
---
<main>
  @mun Hero {
    VStack(spacing: 8) {
      Text(title)
      Text("Astro")
    }
  }
</main>
`
  const result = transformAstroMunSource(source, "/app/src/pages/index.astro")
  assert.equal(result.blocks.length, 1)
  assert.deepEqual(result.blocks[0].props, ["title"])
  assert.equal(result.blocks[0].interactive, false)
  assert.equal(result.blocks[0].hydration.directive, undefined)
  assert.doesNotMatch(result.code, /client:/)
  assert.match(result.code, /title=\{title\}/)

  const virtual = generateVirtualMunModule(result.blocks[0])
  assert.match(virtual, /\bText\b/)
  assert.match(virtual, /\bVStack\b/)
  assert.match(virtual, /const \{ title \} = __props/)
  assert.match(virtual, /return VStack/)
})

test("@mun state and actions become an Astro island automatically", () => {
  const source = `@mun Counter {
    const count = State(0)
    Button(String(count.value)) {
      count.value += 1
    }
  }`
  const result = transformAstroMunSource(source, "/app/src/pages/counter.astro")
  assert.equal(result.blocks.length, 1)
  assert.equal(result.blocks[0].interactive, true)
  assert.equal(result.blocks[0].hydration.directive, "load")
  assert.match(result.code, /client:load/)

  const virtual = generateVirtualMunModule(result.blocks[0])
  assert.match(virtual, /const count = State\(0\)/)
  assert.match(virtual, /return Button/)
})

test("@mun rejects raw HTML and server-only function capture across hydration", () => {
  assert.throws(
    () => transformAstroMunSource("@mun { <div>not Mün</div> }", "/app/src/pages/raw.astro"),
    /Raw HTML is not part of the Mün language/,
  )

  const source = `---
const handler = () => {}
---
@mun {
  Button("Tap") {
    handler()
  }
}`
  assert.throws(
    () => transformAstroMunSource(source, "/app/src/pages/server-capture.astro"),
    /Interactive @mun cannot capture a server-only function or class: handler/,
  )
})

test("@mun scanner ignores host markup, scripts, and Astro expressions", () => {
  const source = `<script>const sample = "@mun { Text('wrong') }"</script>
<div data-copy="@mun { Text('wrong') }">{ "@mun { Text('wrong') }" }</div>
@mun { Text("right") }`
  const result = transformAstroMunSource(source, "/app/src/pages/scanner.astro")
  assert.equal(result.blocks.length, 1)
  assert.match(result.blocks[0].body, /right/)
})

test("Astro source plugin preprocesses .astro in load and serves virtual Mün modules", async () => {
  const plugin = createMunAstroSourcePlugin()
  const directory = mkdtempSync(join(tmpdir(), "mun-astro-plugin-"))
  const fileName = join(directory, "hooks.astro")

  try {
    writeFileSync(fileName, '@mun { Text("hook") }')
    const transformed = plugin.load(fileName)

    assert.ok(transformed)
    assert.match(transformed.code, /virtual:mun-astro:/)
    assert.match(transformed.code, /<MunAstro_/)

    const publicId = /from "([^"]*virtual:mun-astro:[^"]+)"/.exec(transformed.code)?.[1]
    assert.ok(publicId)
    const resolvedId = await plugin.resolveId.call(
      { resolve: async () => null },
      publicId,
    )
    assert.equal(typeof resolvedId, "string")

    const virtual = plugin.load(resolvedId)
    assert.ok(virtual)
    assert.match(virtual.code, /__MunAstroComponent/)
    assert.match(virtual.code, /Text\("hook"\)/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Astro renderer emits Mün SSR HTML, accepts native View props, and rejects HTML slots", async () => {
  const Component = Object.assign(
    () => Text("Rendered by Mün"),
    { __munComponent: true },
  )

  assert.equal(await astroRenderer.check(Component), true)
  const embedded = await astroRenderer.renderToStaticMarkup(Component, {}, {})
  assert.match(embedded.html, /Rendered by Mün/)

  assert.equal(await astroRenderer.check(Text), true)
  const native = await astroRenderer.renderToStaticMarkup(Text, { value: "Native Mün View" }, {})
  assert.match(native.html, /Native Mün View/)

  await assert.rejects(
    () => astroRenderer.renderToStaticMarkup(Component, {}, { default: "<b>host HTML</b>" }),
    /Astro HTML slots cannot cross into a Mün component/,
  )
})

test("Astro integration registers Mün renderer and both source/compiler Vite plugins", () => {
  let registeredRenderer
  let updatedConfig
  const integration = munAstro()
  integration.hooks["astro:config:setup"]({
    addRenderer(renderer) {
      registeredRenderer = renderer
    },
    updateConfig(config) {
      updatedConfig = config
    },
  })

  assert.deepEqual(registeredRenderer, {
    name: "@mun/astro",
    serverEntrypoint: "@mun/astro/server",
    clientEntrypoint: "@mun/astro/client",
  })
  assert.deepEqual(
    updatedConfig.vite.plugins.map(plugin => plugin.name),
    ["mun:astro-source", "mun-compiler"],
  )
})
