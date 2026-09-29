/* SPDX-License-Identifier: MIT */

import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { renderToStaticMarkup } from "react-dom/server"
import { createSSRApp } from "vue"
import { renderToString } from "@vue/server-renderer"
import { compileLineChartGPUIsland, compileParticleFieldGPUIsland, defineParticleFieldGPUIslandIR } from "../packages/compiler/dist/gpu-island-ir.js"
import { gpuIslandView } from "../packages/core/dist/internal-runtime.js"
import { render as renderReact } from "../packages/react/dist/index.js"
import { render as renderVue } from "../packages/vue/dist/index.js"
import { mount, renderToHTML } from "../packages/web/dist/index.js"

test("compiler proof becomes one immutable renderer-owned GPU Island graph boundary", () => {
  const initialData = new Float32Array(16)
  const graph = compileParticleFieldGPUIsland(
    { id: "stars", count: 2, fallback: "static" },
    { width: 320, height: 180, ariaLabel: "Star field", initialData },
  )
  assert.equal(graph.kind, "gpu-island")
  assert.equal(graph.ir.inputResidency, "gpu")
  assert.equal(graph.ir.outputResidency, "gpu")
  assert.equal(graph.ir.readback, "forbidden")
  assert.equal(graph.ir.materialization, "renderer-owned")
  assert.equal(graph.options.initialData === initialData, false, "the one-time upload is snapshotted")
  assert.equal(Object.isFrozen(graph), true)
  assert.throws(() => gpuIslandView({ ...graph.ir, readback: "allowed" }), /gpu-to-gpu, no-readback IR/)
})

test("SSR, React, and Vue retain ownership of their own inert canvas host", async () => {
  const value = gpuIslandView(defineParticleFieldGPUIslandIR({ id: "particles", count: 4 }), {
    width: 256,
    height: 144,
    class: "particle-field",
  })
  const outputs = [
    renderToHTML(value),
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
  ]
  const owners = ["web-ssr", "react", "vue"]
  outputs.forEach((html, index) => {
    const canvas = new JSDOM(html).window.document.querySelector("canvas")
    assert.ok(canvas)
    assert.equal(canvas.getAttribute("data-mun-gpu-owner"), owners[index])
    assert.equal(canvas.getAttribute("data-mun-gpu-island"), "particles")
    assert.equal(canvas.getAttribute("data-mun-gpu-readback"), "forbidden")
    assert.equal(canvas.getAttribute("width"), "256")
    assert.equal(canvas.getAttribute("height"), "144")
  })
})

test("Direct Web keeps GPU Islands disabled until explicitly opted in", async () => {
  const dom = new JSDOM("<!doctype html><main></main>", { pretendToBeVisual: true })
  dom.window.HTMLCanvasElement.prototype.getContext = () => null
  const container = dom.window.document.querySelector("main")
  const value = compileParticleFieldGPUIsland({ id: "fallback", count: 1, fallback: "static" }, { width: 64, height: 64 })
  const dispose = mount(value, container)
  const canvas = container.querySelector("canvas")
  assert.ok(canvas)
  assert.equal(canvas.dataset.munGpuOwner, "direct-web")
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(canvas.dataset.munGpuBackend, "static")
  assert.equal(canvas.dataset.munGpuFailure, undefined)
  dispose()
  assert.equal(container.childNodes.length, 0)
})

test("LineChart GPU Island stays one renderer-owned canvas boundary across SSR adapters", async () => {
  const value = compileLineChartGPUIsland({ id: "timeline-chart", count: 128 }, { width: 480, height: 160 })
  const outputs = [
    renderToHTML(value),
    renderToStaticMarkup(renderReact(value)),
    await renderToString(createSSRApp({ render: () => renderVue(value) })),
  ]
  outputs.forEach(html => {
    const canvas = new JSDOM(html).window.document.querySelector("canvas")
    assert.ok(canvas)
    assert.equal(canvas.getAttribute("data-mun-gpu-kind"), "line-chart")
    assert.equal(canvas.getAttribute("data-mun-gpu-readback"), "forbidden")
    assert.equal(canvas.getAttribute("width"), "480")
    assert.equal(canvas.getAttribute("height"), "160")
  })
})
