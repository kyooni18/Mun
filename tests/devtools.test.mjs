import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getMunBoundaryElement,
  getMunDevtoolsSnapshot,
  recordMunBoundaryDisposed,
  recordMunBoundaryRender,
  recordMunRuntimeEvent,
  resetMunDevtools,
  setMunDevtoolsEnabled,
  subscribeMunDevtools,
} from '../packages/web/dist/devtools.js'

test('web devtools aggregates boundary costs without affecting disabled builds', async () => {
  resetMunDevtools()
  setMunDevtoolsEnabled(false)
  recordMunBoundaryRender({ key: 'ignored', name: 'Ignored', durationMs: 9, dependencyCount: 1, nodeCount: 1, mode: 'compiled' })
  recordMunRuntimeEvent('compiledPatches')
  assert.equal(getMunDevtoolsSnapshot().boundaries.length, 0)
  assert.equal(getMunDevtoolsSnapshot().runtime.compiledPatches, 0)

  let notifications = 0
  const unsubscribe = subscribeMunDevtools(() => { notifications += 1 })
  setMunDevtoolsEnabled(true)
  const element = { isConnected: true }
  recordMunBoundaryRender({ key: 'root/Card', name: 'Card', durationMs: 2, dependencyCount: 3, nodeCount: 4, mode: 'compiled', element })
  recordMunBoundaryRender({ key: 'root/Card', name: 'Card', durationMs: 4, dependencyCount: 2, nodeCount: 4, mode: 'reconcile' })
  recordMunRuntimeEvent('boundaryInvalidations', 2)
  recordMunRuntimeEvent('compiledPatches')
  await new Promise(resolve => queueMicrotask(resolve))
  const card = getMunDevtoolsSnapshot().boundaries[0]
  assert.equal(card.renderCount, 2)
  assert.equal(card.totalDurationMs, 6)
  assert.equal(card.maxDurationMs, 4)
  assert.equal(card.dependencyCount, 2)
  assert.equal(card.mode, 'reconcile')
  assert.equal(getMunDevtoolsSnapshot().runtime.boundaryInvalidations, 2)
  assert.equal(getMunDevtoolsSnapshot().runtime.compiledPatches, 1)
  assert.equal(notifications, 1)
  assert.equal(getMunBoundaryElement('root/Card'), element)

  recordMunBoundaryDisposed('root/Card')
  assert.equal(getMunDevtoolsSnapshot().boundaries.length, 0)
  assert.equal(getMunBoundaryElement('root/Card'), null)
  resetMunDevtools()
  assert.deepEqual(getMunDevtoolsSnapshot().runtime, {
    boundaryInvalidations: 0,
    boundaryFlushes: 0,
    boundaryUpdates: 0,
    compiledPatches: 0,
    reconcilePasses: 0,
    rootRequests: 0,
    rootPasses: 0,
    rootEscalations: 0,
    collectionFallbacks: 0,
  })
  unsubscribe()
  setMunDevtoolsEnabled(false)
})
