import assert from "node:assert/strict"
import test from "node:test"
import * as core from "../packages/core/dist/index.js"
import * as compat from "../packages/core/dist/compat.js"
import * as canonical from "../dist/index.js"
import * as mun from "../dist/mun.js"
import * as legacy from "../dist/legacy.js"
import * as astro from "../dist/astro.js"

test("the root package exposes the public SwiftUI-like core", () => {
  assert.deepEqual(Object.keys(canonical).sort(), Object.keys(core).sort())

  for (const name of [
    "mount",
    "render",
    "renderToHTML",
  ]) {
    assert.equal(name in canonical, false, `${name} must not leak from compatibility/renderers into canonical Mün`)
  }

  for (const name of ["Element", "Text", "VStack", "Button", "State"]) {
    assert.equal(typeof canonical[name], "function", `${name} is a public authoring API`)
    assert.equal(canonical[name], compat[name])
  }

  assert.equal(typeof canonical.Animation, "function")
  assert.equal(typeof canonical.SemanticModel, "function")
  assert.equal(typeof canonical.munMotionPropertyMask, "function")
})

test("the mun language subpath adds compiler entry points with View graph APIs", () => {
  assert.equal(typeof mun.compileMunFile, "function")
  assert.equal(typeof mun.compileMunUiProgram, "function")
  assert.equal(mun.Animation, core.Animation)
  assert.equal(mun.Element, core.Element)
  assert.equal(mun.Text, core.Text)
})

test("@mun/core/compat retains the historical View graph explicitly", () => {
  assert.equal(typeof compat.Text, "function")
  assert.equal(typeof compat.VStack, "function")
  assert.equal(typeof compat.Element, "function")
  assert.equal(typeof compat.State, "function")
  assert.equal(compat.Text("Hello").kind, "element")
})

test("the explicit legacy subpath remains React compatibility", () => {
  assert.equal(typeof legacy.Text, "function")
  assert.equal(typeof legacy.Button, "function")
  assert.equal(typeof legacy.view, "function")
})

test("the Astro subpath exposes the secondary Mün Astro integration", () => {
  assert.equal(typeof astro.default, "function")
  assert.equal(typeof astro.munAstro, "function")
  assert.equal(typeof astro.transformAstroMunSource, "function")
})
