/** Browser checks for the local Mün Reels app. The Vite server must be running on port 3133. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium } from '@playwright/test'

const origin = process.env.REELS_URL || 'http://127.0.0.1:3133/'
const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox'],
})
const names = ['Star Wars', 'IT', 'CATS', 'Aerospace', 'Western', 'Eastern', 'KSP']

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const response = await page.goto(origin, { waitUntil: 'domcontentloaded' })
  assert.equal(response?.status(), 200)
  await page.locator('[data-testid="active-reel"]').waitFor()

  const libraryResponse = await page.request.get(new URL('/api/library', origin).href)
  assert.equal(libraryResponse.status(), 200)
  const library = await libraryResponse.json()
  assert.equal(library.items.length, 445)
  assert.deepEqual(Object.keys(library).sort(), ['albumOrder', 'items'])
  assert.ok(library.items.every(item => !('filename' in item) && !('_path' in item) && !('_ext' in item)))
  assert.ok(library.items.every(item => item.bytes > 0))
  assert.equal(await page.locator('.reel-card').count(), 445)
  assert.deepEqual((await page.locator('.album-nav .nav-item').allTextContents()).map(s => s.trim()), names)
  assert.equal(await page.locator('.main-header').count(), 0)
  assert.equal(await page.locator('.sidebar-header:visible').count(), 1)
  assert.equal(await page.locator('.sidebar-header .shuffle-button').count(), 1)
  const text = await page.locator('body').innerText()
  assert.ok(!text.includes('445'), 'A count is visible')
  assert.doesNotMatch(text, /\b\d+\s*\/\s*\d+\b/)
  assert.equal(await page.locator('.reel-position, .reel-title, .app-inspector').count(), 0)
  assert.ok(await page.locator('.reel-video, .reel-image').count() <= 3)
  console.log('PASS exact album names, zero count labels, no exposed filenames')

  const ids = async () => page.locator('.reel-card').evaluateAll(nodes => nodes.map(el => el.dataset.itemId))
  const firstOrder = await ids()
  assert.equal(new Set(firstOrder).size, 445)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="active-reel"]').waitFor()
  const secondOrder = await ids()
  assert.notDeepEqual(secondOrder.slice(0, 20), firstOrder.slice(0, 20), 'Reload should randomize all items')
  await page.locator('.shuffle-button').click()
  const thirdOrder = await ids()
  assert.notDeepEqual(thirdOrder.slice(0, 20), secondOrder.slice(0, 20), 'Shuffle should randomize all items')
  assert.deepEqual(new Set(thirdOrder), new Set(firstOrder), 'Shuffle must neither lose nor duplicate items')
  console.log('PASS randomized initial feed, reload, and Fisher–Yates reshuffle')

  const first = await page.locator('[data-testid="active-reel"]').getAttribute('data-item-id')
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(850)
  assert.notEqual(await page.locator('[data-testid="active-reel"]').getAttribute('data-item-id'), first)
  await page.keyboard.press('k')
  await page.waitForTimeout(850)
  assert.equal(await page.locator('[data-testid="active-reel"]').getAttribute('data-item-id'), first)
  console.log('PASS keyboard navigation and scroll snap')

  await page.locator('[data-testid="active-reel"] button[aria-label="저장"]').click()
  await page.locator('[data-testid="liked-filter"]').click()
  assert.equal(await page.locator('.reel-card').count(), 1)
  await page.locator('[data-testid="active-reel"] button[aria-label="저장 취소"]').click()
  await page.waitForTimeout(150)
  assert.equal(await page.locator('.reel-card').count(), 0)
  assert.equal(await page.locator('.empty-state').count(), 1)
  await page.locator('[data-testid="all-filter"]').click()
  await page.locator('[data-testid="album-meme_west"]').click()
  assert.equal(await page.locator('.reel-card').count(), 179)
  await page.locator('[data-testid="all-filter"]').click()
  console.log('PASS saved items, album filtering, and empty state')

  const stream = await page.request.get(new URL(library.items[0].url, origin).href, { headers: { range: 'bytes=0-1023' } })
  assert.equal(stream.status(), 206)
  assert.equal((await stream.body()).length, 1024)
  assert.match(stream.headers()['content-range'], /^bytes 0-1023\//)
  console.log('PASS read-only local media byte-range streaming')

  // The first reel is genuinely random, and may be an image. Exercise playback
  // using a deep link to a known video rather than assuming a fixed first item.
  const video = library.items.find(item => item.type === 'video' && item.url.startsWith('/media/'))
  assert.ok(video)
  const videoPage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  videoPage.on('pageerror', error => errors.push('video: ' + error.message))
  await videoPage.goto(new URL(`/?item=${video.id}`, origin).href, { waitUntil: 'domcontentloaded' })
  await videoPage.locator(`[data-item-id="${video.id}"][data-current="true"]`).waitFor({ timeout: 20000 })
  const player = videoPage.locator('[data-testid="active-video"]')
  await player.waitFor()
  await videoPage.waitForTimeout(400)
  assert.equal(await player.evaluate(el => el.paused), false)
  assert.equal(await player.evaluate(el => el.muted), true)
  await videoPage.locator('[data-testid="active-reel"] button[aria-label="소리 켜기"]').click()
  await videoPage.waitForTimeout(100)
  assert.equal(await player.evaluate(el => el.muted), false)
  await videoPage.locator('[data-testid="active-reel"] button[aria-label="일시정지"]').click()
  await videoPage.waitForTimeout(100)
  assert.equal(await player.evaluate(el => el.paused), true)
  await videoPage.locator('[data-testid="active-reel"] button[aria-label="재생"]').click()
  await videoPage.waitForTimeout(100)
  assert.equal(await player.evaluate(el => el.paused), false)
  const seek = videoPage.locator('[data-testid="active-seek-slider"]')
  await seek.waitFor()
  assert.equal(await seek.getAttribute('type'), 'range')
  const duration = await player.evaluate(el => el.duration)
  assert.ok(Number.isFinite(duration) && duration > 0)
  await seek.evaluate(el => {
    el.value = '720'
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await videoPage.waitForTimeout(160)
  assert.ok(Math.abs(await player.evaluate(el => el.currentTime) / duration - 0.72) < 0.04)
  const bar = await seek.boundingBox()
  assert.ok(bar && bar.width > 100)
  await videoPage.mouse.move(bar.x + bar.width * 0.15, bar.y + bar.height / 2)
  await videoPage.mouse.down()
  await videoPage.mouse.move(bar.x + bar.width * 0.62, bar.y + bar.height / 2, { steps: 9 })
  await videoPage.mouse.up()
  await videoPage.waitForTimeout(150)
  assert.ok(Math.abs(await player.evaluate(el => el.currentTime / el.duration) - 0.62) < 0.075, 'Scrubber pointer drag must seek')
  await seek.focus()
  await seek.press('ArrowLeft')
  await videoPage.waitForTimeout(100)
  assert.equal(await videoPage.locator('[data-testid="active-reel"]').getAttribute('data-item-id'), video.id)
  const pos = await player.evaluate(el => el.currentTime)
  await videoPage.keyboard.press('p')
  await videoPage.waitForTimeout(140)
  assert.equal(await player.evaluate(el => el.paused), true)
  await videoPage.keyboard.press('p')
  await videoPage.waitForTimeout(140)
  assert.equal(await player.evaluate(el => el.paused), false)
  assert.ok(await player.evaluate(el => el.currentTime) >= pos)
  await videoPage.keyboard.press('m')
  await videoPage.waitForTimeout(100)
  assert.equal(await player.evaluate(el => el.muted), true)
  await videoPage.keyboard.press('l')
  await videoPage.waitForTimeout(120)
  assert.equal(await videoPage.evaluate(id => JSON.parse(localStorage.getItem('netshits:liked') || '[]').includes(id), video.id), true)
  await videoPage.reload({ waitUntil: 'domcontentloaded' })
  await videoPage.locator(`[data-item-id="${video.id}"][data-current="true"]`).waitFor()
  assert.equal(await videoPage.evaluate(id => JSON.parse(localStorage.getItem('netshits:liked') || '[]').includes(id), video.id), true)
  await videoPage.keyboard.press('l')
  await videoPage.waitForTimeout(120)
  assert.equal(await videoPage.evaluate(id => JSON.parse(localStorage.getItem('netshits:liked') || '[]').includes(id), video.id), false)
  const cardBeforeSpace = await videoPage.locator('[data-testid="active-reel"]').getAttribute('data-item-id')
  await videoPage.keyboard.press('Space')
  await videoPage.waitForTimeout(800)
  assert.notEqual(await videoPage.locator('[data-testid="active-reel"]').getAttribute('data-item-id'), cardBeforeSpace)
  await videoPage.close()
  console.log('PASS native scrubbing, range keyboard controls, Space/P/M/L and persisted local likes')

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  mobile.on('pageerror', error => errors.push('mobile: ' + error.message))
  await mobile.goto(origin, { waitUntil: 'domcontentloaded' })
  await mobile.locator('[data-testid="active-reel"]').waitFor()
  assert.equal(await mobile.locator('.mobile-brand:visible').count(), 0)
  assert.equal(await mobile.locator('.app-sidebar:visible').count(), 0)
  assert.equal(await mobile.locator('.reel-card').count(), 445)
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2))
  await mobile.locator('.album-picker-trigger').click()
  assert.equal(await mobile.locator('.picker-dialog:visible').count(), 1)
  assert.deepEqual((await mobile.locator('.picker-dialog .nav-item').allTextContents()).map(s => s.trim()).slice(2), names)
  await mobile.locator('.picker-dialog .nav-item').filter({ hasText: 'CATS' }).click()
  assert.equal(await mobile.locator('.picker-dialog').count(), 0)
  assert.equal(await mobile.locator('.reel-card').count(), 70)
  assert.doesNotMatch(await mobile.locator('body').innerText(), /\b\d+\s*\/\s*\d+\b/)
  await mobile.close()
  console.log('PASS mobile view and compact album selection, no brand header')

  // The glass controls are intentionally overlaid on the picture, like the
  // original visual design. The actual media uses contain rather than crop.
  const hashId = (album, filename) => createHash('sha256').update(`${album}\0${filename}`).digest('hex').slice(0, 20)
  for (const [name, album, filename, minWidth, maxWidth] of [
    ['landscape', 'aerospace', '2047804416548622336_1.mp4', 840, Infinity],
    ['portrait', 'meme_west', '1937596374930878464_1.mp4', 940, Infinity],
  ]) {
    const id = hashId(album, filename)
    assert.ok(library.items.some(item => item.id === id), `Expected ${name} test video in library`)
    const view = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    view.on('pageerror', error => errors.push(`${name}: ${error.message}`))
    await view.goto(new URL(`/?item=${id}`, origin).href, { waitUntil: 'domcontentloaded' })
    await view.locator(`[data-item-id="${id}"][data-current="true"]`).waitFor()
    await view.waitForFunction(() => document.querySelector('.reels-viewport')?.dataset.aspect !== undefined)
    await view.waitForTimeout(550)
    const dimensions = await view.evaluate(() => {
      const stage = document.querySelector('.reels-viewport')
      const card = document.querySelector('[data-testid="active-reel"]')
      const player = card.querySelector('video')
      const buttons = card.querySelector('.floating-controls')
      const stageRect = stage.getBoundingClientRect()
      const buttonRect = buttons.getBoundingClientRect()
      return {
        aspect: stage.dataset.aspect,
        stageWidth: stageRect.width,
        floatInside: buttonRect.x > stageRect.x && buttonRect.right < stageRect.right + 2,
        mediaFit: getComputedStyle(player).objectFit,
        duration: player.duration,
        loop: player.loop,
        clipped: getComputedStyle(player).clipPath,
      }
    })
    assert.equal(dimensions.aspect, name)
    assert.ok(dimensions.stageWidth >= minWidth && dimensions.stageWidth <= maxWidth, `Wrong ${name} width: ${dimensions.stageWidth}`)
    assert.equal(dimensions.floatInside, true, `Controls missing inside ${name} stage`)
    assert.equal(dimensions.mediaFit, 'contain')
    assert.equal(dimensions.clipped, 'none')
    assert.equal(dimensions.loop, true)
    assert.ok(dimensions.duration > 0)
    await view.screenshot({ path: `/tmp/netshits-restored-${name}.png` })
    await view.close()
  }
  console.log('PASS original in-video floating UI + adaptive wide landscape player + full video frames')
  const landscapeMobile = await browser.newPage({
    viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true,
  })
  landscapeMobile.on('pageerror', error => errors.push('landscape mobile: ' + error.message))
  await landscapeMobile.goto(new URL(`/?item=${video.id}`, origin).href, { waitUntil: 'domcontentloaded' })
  await landscapeMobile.locator(`[data-item-id="${video.id}"][data-current="true"]`).waitFor()
  const landscape = await landscapeMobile.evaluate(() => ({
    width: document.querySelector('.reels-viewport').getBoundingClientRect().width,
    sideVisible: getComputedStyle(document.querySelector('.app-sidebar')).display !== 'none',
    sidebarTitle: document.querySelector('.sidebar-title')?.textContent,
    shuffleCount: document.querySelectorAll('.sidebar-header .shuffle-button').length,
    topHeaderCount: document.querySelectorAll('.main-header').length,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
  }))
  assert.ok(landscape.width >= 650, `Landscape mobile viewer too narrow: ${landscape.width}`)
  assert.equal(landscape.sideVisible, true)
  assert.equal(landscape.sidebarTitle, '전체')
  assert.equal(landscape.shuffleCount, 1)
  assert.equal(landscape.topHeaderCount, 0)
  assert.equal(landscape.horizontalOverflow, false)
  await landscapeMobile.close()
  console.log('PASS landscape phone uses all available width with header/shuffle in sidebar')

  const comparison = await browser.newPage({ viewport: { width: 1500, height: 980 } })
  comparison.on('pageerror', error => errors.push('compare: ' + error.message))
  const compareResponse = await comparison.goto(new URL('/compare.html', origin).href, { waitUntil: 'domcontentloaded' })
  assert.equal(compareResponse?.status(), 200)
  assert.equal(await comparison.locator('.frame').count(), 2)
  await comparison.locator('.frame img').evaluate(img => img.decode())
  assert.equal(await comparison.locator('.frame img').evaluate(img => img.naturalWidth), 1440)
  const live = comparison.frameLocator('iframe[title="현재 디자인의 실시간 Mün 릴스 앱"]')
  await live.locator('[data-testid="active-reel"]').waitFor()
  assert.equal(await live.locator('.reel-card').count(), 445)
  await comparison.screenshot({ path: '/tmp/netshits-reels-comparison.png', fullPage: true })
  await comparison.close()
  console.log('PASS preserved pre-guideline screenshot alongside live current app')

  assert.deepEqual(errors, [], `Browser errors: ${errors.join(', ')}`)
  console.log('PASS all browser smoke tests')
} finally { await browser.close() }
