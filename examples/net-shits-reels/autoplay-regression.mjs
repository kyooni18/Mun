/** Force native playback failures to verify the Memes autoplay recovery path. */
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const origin = process.env.REELS_URL || 'http://127.0.0.1:3133/'
const library = await (await fetch(new URL('/api/library', origin))).json()
const sample = library.items.find(x => x.type === 'video' && x.url.startsWith('/media/'))
assert.ok(sample)

const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox'],
})

async function probeFault(variant) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(({ id, variant }) => {
    window.__armed = false
    window.__testKind = variant
    window.__injectedCount = 0
    window.__playAttempts = 0
    const original = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (...args) {
      if (this.dataset.id === id && window.__armed) {
        window.__playAttempts++
        if (variant === 'abort' && window.__injectedCount < 2) {
          window.__injectedCount++
          return Promise.reject(new DOMException('Simulated transient playback abort', 'AbortError'))
        }
        if (variant === 'sound' && !this.muted) {
          window.__injectedCount++
          return Promise.reject(new DOMException('Simulated sound autoplay denial', 'NotAllowedError'))
        }
      }
      return original.apply(this, args)
    }
  }, { id: sample.id, variant })
  try {
    await page.goto(new URL(`/?item=${sample.id}`, origin).href)
    await page.locator(`[data-current="true"][data-item-id="${sample.id}"]`).waitFor()
    await page.locator('[data-testid="active-video"]').waitFor()
    await page.waitForFunction(() => {
      const v = document.querySelector('[data-testid="active-video"]')
      return v && !v.paused && v.readyState >= 2
    }, undefined, { timeout: 11000 })
    await page.keyboard.press('p')
    await page.waitForTimeout(150)
    assert.equal(await page.locator('[data-testid="active-video"]').evaluate(v => v.paused), true)
    if (variant === 'sound') {
      await page.keyboard.press('m')
      assert.equal(await page.locator('[data-testid="active-video"]').evaluate(v => v.muted), false)
    }
    await page.evaluate(() => { window.__armed = true })
    await page.keyboard.press('p')
    await page.waitForFunction(() => {
      const v = document.querySelector('[data-testid="active-video"]')
      return v && !v.paused && v.readyState >= 2 && window.__injectedCount >= (window.__testKind === 'abort' ? 2 : 1)
    }, undefined, { timeout: 9000 })
    const state = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="active-video"]')
      return { paused: v?.paused, readyState: v?.readyState, muted: v?.muted,
        attempts: window.__playAttempts, injections: window.__injectedCount,
        blocked: !!document.querySelector('.reel-card.autoplay-blocked'),
        error: v?.error?.code,
      }
    })
    assert.equal(state.paused, false, `Video stayed paused after ${variant} fault: ${JSON.stringify(state)}`)
    assert.ok(state.injections >= (variant === 'abort' ? 2 : 1), `Injection not exercised: ${JSON.stringify(state)}`)
    assert.equal(state.blocked, false)
    if (variant === 'sound') {
      assert.equal(state.muted, true, 'Sound denial must fall back to muted autoplay')
      assert.equal(await page.locator('[data-testid="active-reel"] button[aria-label="소리 켜기"]').count(), 1)
    }
    assert.deepEqual(errors, [])
    console.log(`PASS ${variant} recovery:`, state)
  } finally { await page.close() }
}

async function interruptedPause() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    await page.goto(new URL(`/?item=${sample.id}`, origin).href)
    await page.locator(`[data-current="true"][data-item-id="${sample.id}"]`).waitFor()
    const video = page.locator('[data-testid="active-video"]')
    await page.waitForFunction(() => {
      const v = document.querySelector('[data-testid="active-video"]')
      return v && !v.paused && v.readyState >= 2
    }, undefined, { timeout: 8000 })
    // A browser or OS pause, without the user explicitly pressing P.
    await video.evaluate(v => v.pause())
    await page.waitForFunction(() => {
      const v = document.querySelector('[data-testid="active-video"]')
      return v && !v.paused && v.readyState >= 2
    }, undefined, { timeout: 6000 })
    console.log('PASS unexpected native pause recovers without overriding explicit P pause')
  } finally { await page.close() }
}

async function hardBlockFallback() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(({ id }) => {
    window.__denyPlayback = true
    window.__blockCounter = 0
    const original = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (...args) {
      if (this.dataset.id === id && window.__denyPlayback) {
        window.__blockCounter++
        return Promise.reject(new DOMException('Simulated autoplay denial', 'NotAllowedError'))
      }
      return original.apply(this, args)
    }
  }, { id: sample.id })
  try {
    await page.goto(new URL(`/?item=${sample.id}`, origin).href)
    await page.locator(`[data-current="true"][data-item-id="${sample.id}"]`).waitFor()
    await page.locator('[data-testid="active-video"]').waitFor()
    // Ensure the manual pause is real even if native autoplay has already begun.
    await page.waitForFunction(() => {
      const v = document.querySelector('[data-testid="active-video"]')
      return v && v.readyState >= 2
    }, undefined, { timeout: 11000 })
    await page.keyboard.press('p')
    await page.waitForTimeout(120)
    await page.keyboard.press('p')
    await page.locator('[data-testid="active-reel"] .autoplay-retry:visible').waitFor({ timeout: 11000 })
    const blockCount = await page.evaluate(() => window.__blockCounter)
    assert.ok(blockCount >= 5, `Expected bounded retries before fallback, got ${blockCount}`)
    // The user can always override a browser's autoplay rejection with a tap.
    await page.evaluate(() => { window.__denyPlayback = false })
    await page.locator('[data-testid="active-reel"] .autoplay-retry').click()
    await page.waitForFunction(() => {
      const v = document.querySelector('[data-testid="active-video"]')
      return v && !v.paused && v.readyState >= 2
    }, undefined, { timeout: 7000 })
    assert.equal(await page.locator('[data-testid="active-reel"] .autoplay-retry:visible').count(), 0)
    assert.deepEqual(errors, [])
    console.log('PASS permanent denial shows working tap-to-play fallback after bounded retries')
  } finally { await page.close() }
}

async function rapidScroll() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 880 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(origin)
    await page.locator('[data-testid="active-reel"]').waitFor()
    await page.locator('[data-testid="album-CATS (and others)"]').click()
    const frozen = []
    let videos = 0
    for (let i = 0; i < 44; i++) {
      await page.waitForTimeout(575)
      let status = await page.evaluate(() => {
        const card = document.querySelector('.reel-card[data-current="true"]')
        const v = card?.querySelector('video')
        return { id: card?.dataset.itemId, video: !!v,
          paused: v?.paused, ready: v?.readyState, error: v?.error?.code,
          muted: v?.muted,
        }
      })
      if (status.video) {
        videos++
        if (status.paused || status.error || (status.ready ?? 0) < 2) {
          await page.waitForTimeout(1250)
          status = await page.evaluate(() => {
            const c = document.querySelector('.reel-card[data-current="true"]')
            const v = c?.querySelector('video')
            return { id: c?.dataset.itemId, video: !!v, paused: v?.paused,
              ready: v?.readyState, error: v?.error?.code }
          })
          if (status.paused || status.error || (status.ready ?? 0) < 2) frozen.push(status)
        }
      }
      await page.keyboard.press('ArrowDown')
    }
    assert.ok(videos >= 25, `Not enough videos traversed: ${videos}`)
    assert.deepEqual(frozen, [], `Unrecoverable playback after scrolling: ${JSON.stringify(frozen)}`)
    assert.deepEqual(errors, [])
    console.log(`PASS repeated scroll autoplay: ${videos} video reels across 44 transitions`)
  } finally { await page.close() }
}

try {
  await probeFault('abort')
  await probeFault('sound')
  await interruptedPause()
  await hardBlockFallback()
  await rapidScroll()
  console.log('PASS autoplay recovery regression suite')
} finally { await browser.close() }
