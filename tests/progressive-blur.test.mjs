import assert from 'node:assert/strict'
import test from 'node:test'
import { Text, VStack } from '../packages/core/dist/index.js'
import { renderToHTML } from '../packages/web/dist/index.js'
import { BlurProfile, effectiveRadius, layerAlphas, layerCount, planBlur, strengthAt } from '../packages/progressive-blur/dist/plan.js'
import { ProgressiveBlur, blurFocus, focus, progressiveBlur } from '../packages/progressive-blur/dist/index.js'

test('effective radius follows the chosen curve from none to the full radius', () => {
  const radius = 16
  const count = layerCount(radius)
  const at = t => effectiveRadius(layerAlphas(strengthAt(BlurProfile.edge('bottom', 100), t), count), count, radius)
  assert.equal(at(0), 0)
  assert.ok(Math.abs(at(1) - radius) < 1e-9)
  assert.ok(Math.abs(at(0.5) - radius / 2) < 1e-9, 'linear curve gives a linear radius ramp')
  const inverted = effectiveRadius(layerAlphas(strengthAt(BlurProfile.edge('bottom', 100).inverted(), 0), count), count, radius)
  assert.ok(Math.abs(inverted - radius) < 1e-9)
})

test('profiles plan masks along the right axis and honour focus centers', () => {
  const edge = planBlur(BlurProfile.edge('bottom', 120), { radius: 12 })
  assert.equal(edge.length, layerCount(12))
  assert.match(edge[0].mask, /^linear-gradient\(to bottom,.*calc\(100% - 120px\)/)
  const diagonal = planBlur(BlurProfile.linear({ from: 'topLeading', to: 'bottomTrailing' }), { radius: 8 })
  assert.match(diagonal[0].mask, /to bottom right/)
  const live = planBlur(BlurProfile.radial({ around: focus('menu'), inner: 40, outer: 200 }), { radius: 8 })
  assert.match(live[0].mask, /circle at var\(--pb-cx,50%\) var\(--pb-cy,50%\)/)
  const fixed = planBlur(BlurProfile.radial({ around: focus('menu'), outer: 200 }), { radius: 8, focusCenter: { x: 10, y: 20 } })
  assert.match(fixed[0].mask, /circle at 10px 20px/)
  assert.deepEqual(planBlur(BlurProfile.uniform(), { radius: 6 }), [{ blur: 6 }])
  assert.deepEqual(planBlur(BlurProfile.edge('top', 50), { radius: 0 }), [])
})

test('the modifier overlays backdrop layers on the content and ProgressiveBlur stands alone', () => {
  const html = renderToHTML(Text('hello').modifier(progressiveBlur(BlurProfile.edge('bottom', 80), { radius: 10, amount: 0.5 })))
  assert.match(html, /hello/)
  assert.match(html, /backdrop-filter:blur\(/)
  assert.match(html, /data-pb-amount="0.5"/)
  assert.match(renderToHTML(VStack(ProgressiveBlur(BlurProfile.uniform()))), /backdrop-filter/)
  assert.match(renderToHTML(Text('menu').modifier(blurFocus('menu'))), /data-pb-focus="menu"/)
})

test('quality budgets reduce the stack while retaining its radius and profile', () => {
  const profile = BlurProfile.edge('bottom', 100)
  for (const radius of [4, 12, 24]) {
    assert.equal(layerCount(radius), Math.min(8, Math.max(3, Math.round(radius / 2))))
    const layers = planBlur(profile, { radius, quality: 'reduced' })
    assert.equal(layers.length, 2)
    assert.ok(Math.abs(Math.hypot(...layers.map(layer => layer.blur)) - radius) < 0.01)
    assert.match(layers[0].mask, /^linear-gradient\(to bottom,/)
    assert.deepEqual(planBlur(profile, { radius, quality: 'none' }), [])
    assert.deepEqual(planBlur(BlurProfile.uniform(), { radius, quality: 'none' }), [])
    assert.deepEqual(planBlur(BlurProfile.uniform(), { radius, quality: 'reduced' }), [{ blur: radius }])
  }
  assert.equal(layerCount(0, 'reduced'), 0)
  assert.equal(layerCount(12, 'none'), 0)
})

test('@mun-ui/ui exposes the same single progressive-blur implementation', async () => {
  const canonical = await import('@mun-ui/ui/progressive-blur')
  const plan = await import('@mun-ui/ui/progressive-blur/plan')
  const legacy = await import('@mun-ui/progressive-blur')
  for (const name of ['ProgressiveBlur', 'progressiveBlur', 'BlurProfile', 'blurFocus', 'focus', 'planBlur']) assert.equal(canonical[name], legacy[name], name)
  assert.equal(plan.planBlur, canonical.planBlur)
  assert.equal(plan.BlurProfile, canonical.BlurProfile)
})
