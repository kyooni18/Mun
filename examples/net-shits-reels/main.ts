import { defineView, initializer, Element, ForEach, Image, State, Text, VStack } from '@mun/core'
import type { ViewValue } from '@mun/core'
import { mount } from '@mun/web'
import './style.css'

interface MediaItem {
  id: string
  album: string
  type: 'video' | 'image'
  url: string
  poster: string | null
  mime: string
  bytes: number
  modifiedAt: number
}
interface LibraryResponse {
  items: MediaItem[]
  albumOrder: string[]
}

const albumLabels: Record<string, string> = {
  'Star Wars': 'Star Wars',
  IT: 'IT',
  'CATS (and others)': 'CATS',
  aerospace: 'Aerospace',
  meme_west: 'Western',
  meme_east: 'Eastern',
  KSP: 'KSP',
}

let library: MediaItem[] = []
let randomizedLibrary: MediaItem[] = []
let albumOrder: string[] = []
let lastOrder: MediaItem[] = []
let playbackScheduled = false
let playbackRetryTimer: number | undefined
let playbackFocusedId: string | undefined
const pendingVideoPlays = new WeakSet<HTMLVideoElement>()
const videoPlayFailures = new WeakMap<HTMLVideoElement, number>()
const maxPlaybackRetries = 4
let scrollScheduled = false
let programmaticJump = false
let disposed = false
let loadingError = ''

const loaded = State(false)
const revision = State(0)
const activeIndex = State(0)
const currentAlbum = State('All')
const onlyLiked = State(false)
const muted = State(true)
const paused = State(false)
const albumPickerOpen = State(false)
const favorites = State<string[]>(restoreFavorites())

function restoreFavorites(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('netshits:liked') || '[]')
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []
  } catch { return [] }
}

const svgElement = Element as (tag: string, props?: Record<string, unknown> | null, ...children: ViewValue[]) => ReturnType<typeof Element>

function icon(name: string, size = 20) {
  const paths: Record<string, string> = {
    heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
    play: 'm8 5 11 7-11 7V5Z', pause: 'M8 5v14M16 5v14',
    mute: 'M11 5 6 9H3v6h3l5 4V5ZM16 9l5 6m0-6-5 6',
    sound: 'M11 5 6 9H3v6h3l5 4V5ZM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12',
    arrowUp: 'm6 14 6-6 6 6', arrowDown: 'm6 10 6 6 6-6',
    shuffle: 'm18 14 4 4-4 4M2 18h2.5c6 0 8-12 14.5-12H22m-4-4 4 4-4 4M2 6h2.5c2.4 0 4.2 2.2 5.5 5',
    external: 'M13 5h6v6m0-6-9 9M19 14v5H5V5h5',
    chevronDown: 'm6 9 6 6 6-6', close: 'M5 5l14 14M19 5 5 19',
    check: 'm5 12 4 4 10-10',
    info: 'M12 17v-5m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  }
  return svgElement('svg', {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true,
  }, svgElement('path', { d: paths[name] || paths.info }))
}

function iconButton(className: string, label: string, glyph: string, action: () => void, selected?: boolean) {
  return Element('button', {
    type: 'button', className,
    'aria-label': label,
    title: label,
    ...(selected === undefined ? {} : { 'aria-pressed': selected }),
    onClick: event => { event.stopPropagation?.(); action() },
  }, icon(glyph))
}

// Crypto-backed, unbiased Fisher-Yates. Every permutation is equally likely.
// No featured items, album rotation, dates, weights, or deterministic seeds.
function secureIndex(bound: number): number {
  const span = 0x1_0000_0000
  const limit = span - (span % bound)
  const number = new Uint32Array(1)
  do { crypto.getRandomValues(number) } while (number[0] >= limit)
  return number[0] % bound
}

function shuffled<T>(source: readonly T[]): T[] {
  const result = [...source]
  for (let i = result.length - 1; i > 0; i--) {
    const j = secureIndex(i + 1)
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function reshuffle() {
  randomizedLibrary = shuffled(library)
  revision.value++
  resetFeed()
}

function filterItems(): MediaItem[] {
  void revision.value
  const album = currentAlbum.value
  const liked = onlyLiked.value
  const saved = new Set(favorites.value)
  const items = randomizedLibrary.filter(item =>
    (album === 'All' || item.album === album) && (!liked || saved.has(item.id)),
  )
  lastOrder = items
  return items
}

function selectedItem(): MediaItem | undefined { return lastOrder[activeIndex.value] }

function syncStageAspect() {
  const stage = document.querySelector<HTMLElement>('.reels-viewport')
  const current = document.querySelector<HTMLElement>('.reel-card[data-current="true"]')
  const media = current?.querySelector<HTMLVideoElement | HTMLImageElement>('.reel-video, .reel-image')
  if (!stage || !media) return
  const width = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth
  const height = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight
  if (!width || !height) return
  const ratio = width / height
  stage.classList.toggle('is-landscape', ratio >= 1.24)
  stage.classList.toggle('is-square', ratio >= 0.87 && ratio < 1.24)
  stage.dataset.aspect = ratio >= 1.24 ? 'landscape' : ratio >= 0.87 ? 'square' : 'portrait'
}

function onMediaReady(event: unknown) {
  const media = (event as { currentTarget: HTMLElement }).currentTarget
  if (media.closest('.reel-card')?.getAttribute('data-current') !== 'true') return
  syncStageAspect()
  if (media instanceof HTMLVideoElement) {
    syncTimeline(media)
    schedulePlayback()
  }
}

function activeVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>('.reel-card[data-current="true"] .reel-video')
}

function shouldAutoplay(video: HTMLVideoElement): boolean {
  return !disposed && !document.hidden && !paused.value && video.isConnected &&
    video.dataset.id === selectedItem()?.id &&
    video.closest('.reel-card')?.getAttribute('data-current') === 'true'
}

function clearPlaybackRetry() {
  if (playbackRetryTimer !== undefined) {
    window.clearTimeout(playbackRetryTimer)
    playbackRetryTimer = undefined
  }
}

function markPlaying(video: HTMLVideoElement) {
  videoPlayFailures.delete(video)
  video.closest('.reel-card')?.classList.remove('autoplay-blocked')
  clearPlaybackRetry()
}

function queuePlaybackRetry(video: HTMLVideoElement, error: unknown) {
  if (!shouldAutoplay(video) || video.error) return
  const failures = (videoPlayFailures.get(video) ?? 0) + 1
  videoPlayFailures.set(video, failures)
  clearPlaybackRetry()
  if (failures > maxPlaybackRetries) {
    video.closest('.reel-card')?.classList.add('autoplay-blocked')
    console.warn('Memes: playback needs a user gesture', {
      id: video.dataset.id, error: error instanceof Error ? error.name : String(error),
    })
    return
  }
  const delay = [160, 350, 750, 1500][failures - 1]
  playbackRetryTimer = window.setTimeout(() => {
    playbackRetryTimer = undefined
    schedulePlayback()
  }, delay)
}

function requestVideoPlay(video: HTMLVideoElement) {
  if (!shouldAutoplay(video) || !video.paused || pendingVideoPlays.has(video) ||
      (videoPlayFailures.get(video) ?? 0) > maxPlaybackRetries) return
  try {
    pendingVideoPlays.add(video)
    Promise.resolve(video.play())
      .then(() => {
        if (shouldAutoplay(video) && !video.paused) markPlaying(video)
      })
      .catch((error: unknown) => {
        if (!shouldAutoplay(video)) return
        // Autoplay with sound may be rejected even after a previous user click.
        // Prefer reliable muted playback over a permanently frozen clip.
        const errorName = error && typeof error === 'object' && 'name' in error
          ? String(error.name) : ''
        if (errorName === 'NotAllowedError' && !video.muted) {
          video.muted = true
          muted.value = true
        }
        queuePlaybackRetry(video, error)
      })
      .finally(() => pendingVideoPlays.delete(video))
  } catch (error) {
    pendingVideoPlays.delete(video)
    queuePlaybackRetry(video, error)
  }
}

function onVideoPlaying(event: unknown) {
  const video = (event as { currentTarget: HTMLVideoElement }).currentTarget
  if (shouldAutoplay(video)) markPlaying(video)
}

function onVideoCanPlay(event: unknown) {
  const video = (event as { currentTarget: HTMLVideoElement }).currentTarget
  if (shouldAutoplay(video) && video.paused) schedulePlayback()
}

function onUnexpectedVideoPause(event: unknown) {
  const video = (event as { currentTarget: HTMLVideoElement }).currentTarget
  // Browsers may pause an active clip independently of user controls. Resume
  // only if the user did not intentionally pause it and no play is pending.
  if (shouldAutoplay(video) && video.paused &&
      !pendingVideoPlays.has(video) && playbackRetryTimer === undefined) {
    queuePlaybackRetry(video, new Error('UnexpectedPause'))
  }
}

function schedulePlayback() {
  if (playbackScheduled || disposed) return
  playbackScheduled = true
  requestAnimationFrame(() => {
    playbackScheduled = false
    const selectedId = selectedItem()?.id
    if (selectedId !== playbackFocusedId) {
      playbackFocusedId = selectedId
      clearPlaybackRetry()
    }
    let selectedVideo: HTMLVideoElement | undefined
    for (const video of document.querySelectorAll<HTMLVideoElement>('.reel-video')) {
      if (video.dataset.id === selectedId &&
          video.closest('.reel-card')?.getAttribute('data-current') === 'true') {
        video.muted = muted.value
        selectedVideo = video
      } else if (!video.paused) {
        video.pause()
      }
    }
    if (!selectedVideo) return
    if (shouldAutoplay(selectedVideo)) requestVideoPlay(selectedVideo)
    else if (!selectedVideo.paused) selectedVideo.pause()
  })
}

function seekTo(index: number, behavior: ScrollBehavior = 'smooth') {
  const scroller = document.querySelector<HTMLElement>('#reels-scroller')
  if (!scroller || !lastOrder.length) return
  const target = Math.max(0, Math.min(lastOrder.length - 1, index))
  scroller.scrollTo({ top: target * scroller.clientHeight, behavior })
  if (behavior === 'instant') {
    activeIndex.value = target
    paused.value = false
    schedulePlayback()
  }
}
function move(amount: number) { seekTo(activeIndex.value + amount) }

function resetFeed() {
  activeIndex.value = 0
  paused.value = false
  programmaticJump = true
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('#reels-scroller')?.scrollTo({ top: 0, behavior: 'instant' })
    programmaticJump = false
    schedulePlayback()
  })
}
function chooseAlbum(album: string) {
  onlyLiked.value = false
  currentAlbum.value = album
  albumPickerOpen.value = false
  resetFeed()
}
function chooseSaved() {
  onlyLiked.value = true
  currentAlbum.value = 'All'
  albumPickerOpen.value = false
  resetFeed()
}
function toggleFavorite(id?: string) {
  if (!id) return
  const next = new Set(favorites.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  favorites.value = [...next]
  try { localStorage.setItem('netshits:liked', JSON.stringify([...next])) } catch { /* Private mode */ }
  if (onlyLiked.value && !next.has(id)) {
    requestAnimationFrame(() => seekTo(Math.max(0, Math.min(activeIndex.value, next.size - 1)), 'instant'))
  }
}
function toggleMute() {
  muted.value = !muted.value
  const video = activeVideo()
  if (video) video.muted = muted.value
  schedulePlayback()
}
function togglePlay() {
  const video = activeVideo()
  if (paused.value || video?.paused) {
    paused.value = false
    if (video) {
      // Called from the real tap/click/keyboard gesture, not a delayed frame.
      videoPlayFailures.delete(video)
      video.closest('.reel-card')?.classList.remove('autoplay-blocked')
      requestVideoPlay(video)
    }
  } else {
    paused.value = true
    video?.pause()
  }
  schedulePlayback()
}

function handleScroll(event: unknown) {
  if (programmaticJump || scrollScheduled) return
  const scroller = (event as { currentTarget: HTMLElement }).currentTarget
  scrollScheduled = true
  requestAnimationFrame(() => {
    scrollScheduled = false
    if (!scroller.clientHeight || programmaticJump || !lastOrder.length) return
    const index = Math.max(0, Math.min(lastOrder.length - 1, Math.round(scroller.scrollTop / scroller.clientHeight)))
    if (index !== activeIndex.value) {
      activeIndex.value = index
      paused.value = false
      const item = selectedItem()
      if (item) history.replaceState(null, '', `${location.pathname}?item=${item.id}`)
      schedulePlayback()
    }
  })
}
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function syncTimeline(video: HTMLVideoElement) {
  const card = video.closest<HTMLElement>('.reel-card')
  const slider = card?.querySelector<HTMLInputElement>('.seek-slider')
  if (!slider) return
  const duration = video.duration
  const valid = Number.isFinite(duration) && duration > 0
  slider.disabled = !valid
  if (!valid) return
  const played = Math.max(0, Math.min(1, video.currentTime / duration))
  slider.value = String(Math.round(played * 1000))
  slider.style.setProperty('--played', `${(played * 100).toFixed(2)}%`)
  slider.setAttribute('aria-valuetext', `${formatTime(video.currentTime)} / ${formatTime(duration)}`)
}

function onSeekInput(event: unknown) {
  const slider = (event as { currentTarget: HTMLInputElement }).currentTarget
  const card = slider.closest<HTMLElement>('.reel-card')
  if (card?.dataset.current !== 'true') return
  const video = card.querySelector<HTMLVideoElement>('.reel-video')
  if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return
  const fraction = Math.max(0, Math.min(1, Number(slider.value) / 1000))
  video.currentTime = Math.min(fraction * video.duration, video.duration)
  syncTimeline(video)
}

function onMediaTimeUpdate(event: unknown) {
  const video = (event as { currentTarget: HTMLVideoElement }).currentTarget
  if (video.dataset.id !== selectedItem()?.id) return
  syncTimeline(video)
}
function onMediaError(event: unknown) {
  const target = (event as { currentTarget: HTMLElement }).currentTarget
  target.closest<HTMLElement>('.reel-card')?.classList.add('media-failed')
}

function reelCard(item: MediaItem, index: number, active: number, likes: Set<string>) {
  const isActive = index === active
  const isNeighbor = Math.abs(index - active) <= 1
  const isVideo = item.type === 'video'
  const isSaved = likes.has(item.id)

  // The source is played in full. Do not crop, scale beyond contain, trim,
  // accelerate, or advance to the next reel before the original completes.
  const media = !isNeighbor ? null : isVideo
    ? Element('video', {
        className: 'reel-video', 'data-id': item.id,
        'data-testid': isActive ? 'active-video' : undefined,
        src: item.url, poster: item.poster || undefined, playsInline: true,
        muted: true, loop: true, autoplay: isActive,
        preload: isActive ? 'auto' : 'metadata',
        onClick: togglePlay, onLoadedMetadata: onMediaReady,
        onLoadedData: onVideoCanPlay, onCanPlay: onVideoCanPlay,
        onPlaying: onVideoPlaying, onPause: onUnexpectedVideoPause,
        onTimeUpdate: onMediaTimeUpdate, onError: onMediaError,
      } as any)
    : Image(item.url, { alt: `${albumLabels[item.album] || item.album} 이미지` })
        .className('reel-image')
        .withProps({ loading: isActive ? 'eager' : 'lazy', decoding: 'async',
          onLoad: onMediaReady, onError: onMediaError })

  return Element('section', {
    className: `reel-card${isActive ? ' is-active' : ''}`,
    'data-item-id': item.id, 'data-current': String(isActive),
    'data-testid': isActive ? 'active-reel' : undefined,
    'aria-label': `${albumLabels[item.album] || item.album} 릴스`,
  },
    Element('div', { className: 'reel-media', 'data-fit': 'contain' },
      media,
      Element('div', { className: 'media-fallback', role: 'status' },
        icon('info', 21), Text('미디어를 표시할 수 없어'),
      ),
      isVideo && isNeighbor ? Element('div', { className: 'video-progress' },
        Element('input', {
          className: 'seek-slider', type: 'range',
          min: '0', max: '1000', step: '1', value: '0',
          'aria-label': '재생 위치 조절',
          'data-testid': isActive ? 'active-seek-slider' : undefined,
          onInput: onSeekInput, onChange: onSeekInput,
        }),
      ) : null,
    ),
    isVideo && isNeighbor ? Element('button', {
      className: 'autoplay-retry', type: 'button', 'aria-label': '영상 재생 다시 시도',
      onClick: event => { event.stopPropagation?.(); togglePlay() },
    }, icon('play', 21), Text('탭하여 재생')) : null,
    Element('div', { className: 'reel-shade', 'aria-hidden': true }),
    Text(albumLabels[item.album] || item.album).className('reel-caption'),
    isNeighbor ? floatingControls(item, isSaved) : null,
  )
}

function floatingControls(item: MediaItem, saved: boolean) {
  const isVideo = item.type === 'video'
  return Element('div', { className: 'floating-controls', role: 'group', 'aria-label': '릴스 조작' },
    iconButton(`float-action${saved ? ' is-saved' : ''}`,
      saved ? '저장 취소' : '저장', 'heart', () => toggleFavorite(item.id), saved),
    isVideo ? iconButton('float-action', muted.value ? '소리 켜기' : '소리 끄기',
      muted.value ? 'mute' : 'sound', toggleMute, !muted.value) : null,
    isVideo ? iconButton('float-action', paused.value ? '재생' : '일시정지',
      paused.value ? 'play' : 'pause', togglePlay) : null,
    Element('a', {
      className: 'float-action', href: `/media/${item.id}`,
      target: '_blank', rel: 'noopener noreferrer',
      title: '원본 보기', 'aria-label': '원본 보기',
    }, icon('external')),
  )
}

function navButton(text: string, selected: boolean, action: () => void, testId?: string) {
  return Element('button', {
    type: 'button', className: `nav-item${selected ? ' is-selected' : ''}`,
    'aria-current': selected ? 'page' : undefined,
    'data-testid': testId,
    onClick: action,
  }, Text(text))
}

function albumNavigation() {
  const selected = currentAlbum.value
  const saved = onlyLiked.value
  return Element('aside', { className: 'app-sidebar', 'aria-label': '라이브러리 탐색' },
    Element('div', { className: 'sidebar-header' },
      Text(categoryName()).className('sidebar-title'),
      iconButton('shuffle-button', '순서 섞기', 'shuffle', reshuffle),
    ),
    Element('nav', { className: 'sidebar-nav', 'aria-label': '피드 선택' },
      navButton('전체', selected === 'All' && !saved, () => chooseAlbum('All'), 'all-filter'),
      navButton('저장', saved, chooseSaved, 'liked-filter'),
      Text('앨범').className('nav-heading'),
      VStack({ alignment: 'stretch', spacing: 1 }, ...albumOrder.map(album =>
        navButton(albumLabels[album] || album, selected === album && !saved, () => chooseAlbum(album), `album-${album}`),
      )).className('album-nav'),
    ),
  )
}

function mobilePicker() {
  return Element('div', { className: 'picker-backdrop', role: 'presentation', onClick: () => { albumPickerOpen.value = false } },
    Element('section', {
      className: 'picker-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': '앨범 선택',
      onClick: event => event.stopPropagation?.(),
    },
      Element('div', { className: 'picker-heading' },
        Text('앨범').className('picker-title'),
        iconButton('picker-close', '닫기', 'close', () => { albumPickerOpen.value = false }),
      ),
      navButton('전체', !onlyLiked.value && currentAlbum.value === 'All', () => chooseAlbum('All')),
      navButton('저장', onlyLiked.value, chooseSaved),
      Element('div', { className: 'picker-divider' }),
      ...albumOrder.map(album => navButton(albumLabels[album] || album,
        !onlyLiked.value && currentAlbum.value === album, () => chooseAlbum(album))),
    ),
  )
}

function emptyState() {
  return VStack({ alignment: 'center', spacing: 14 },
    Text(onlyLiked.value ? '저장한 항목이 없어' : '표시할 항목이 없어').className('empty-title'),
    Text(onlyLiked.value ? '마음에 드는 항목에서 하트를 눌러 봐.' : '다른 앨범을 선택해 봐.').className('empty-detail'),
    Element('button', { type: 'button', className: 'reset-button', onClick: () => chooseAlbum('All') }, Text('전체 보기')),
  ).className('empty-state')
}

function categoryName() {
  return onlyLiked.value ? '저장' : currentAlbum.value === 'All' ? '전체' : albumLabels[currentAlbum.value] || currentAlbum.value
}

const App = defineView('NetShitsReelsApp', {
  initializers: [initializer('NetShitsReelsApp()', args => args.length === 0)],
  body: () => {
    const ready = loaded.value
    const items = filterItems()
    const currentIndex = Math.max(0, Math.min(activeIndex.value, items.length - 1))
    const likedIds = new Set(favorites.value)
    const pickerOpen = albumPickerOpen.value
    const category = categoryName()

    return Element('div', { className: 'app-shell', 'data-mun-reels': 'true', 'data-testid': 'app-shell' },
      albumNavigation(),
      Element('main', { className: 'app-main' },
        Element('div', { className: 'mobile-toolbar' },
          Element('button', {
            type: 'button', className: 'album-picker-trigger',
            'aria-label': `앨범 선택: ${category}`, 'aria-expanded': pickerOpen,
            onClick: () => { albumPickerOpen.value = !albumPickerOpen.value },
          }, Text(category), icon('chevronDown', 15)),
        ),
        Element('div', { className: 'reels-area' },
          !ready ? Text('불러오는 중…').className('loading-text')
            : !items.length ? emptyState()
            : Element('div', { className: 'reels-viewport' },
              Element('div', {
                className: 'reels-scroller', id: 'reels-scroller', role: 'feed', tabIndex: 0,
                onScroll: handleScroll, 'aria-label': '스크롤해서 릴스 넘기기', 'data-testid': 'reels-scroller',
              }, ForEach(items, media => media.id, (media, index) => reelCard(media, index, currentIndex, likedIds))),
              Element('div', { className: 'viewport-navigation' },
                iconButton('nav-arrow', '이전 항목', 'arrowUp', () => move(-1)),
                iconButton('nav-arrow', '다음 항목', 'arrowDown', () => move(1)),
              ),
            ),
        ),
      ),
      pickerOpen ? mobilePicker() : null,
      loadingError ? Element('div', { className: 'error-toast', role: 'alert' }, Text(loadingError)) : null,
    )
  },
})

const root = document.getElementById('app')
if (!root) throw new Error('Missing app root')
const unmount = mount(App(), root)

async function loadLibrary() {
  try {
    const response = await fetch('/api/library')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json() as LibraryResponse
    if (!Array.isArray(data.items)) throw new Error('Invalid media index')
    library = data.items
    randomizedLibrary = shuffled(library)
    albumOrder = data.albumOrder
    revision.value++
    loaded.value = true
    const deepLink = new URLSearchParams(location.search).get('item')
    if (deepLink) {
      const position = randomizedLibrary.findIndex(item => item.id === deepLink)
      if (position >= 0) requestAnimationFrame(() => seekTo(position, 'instant'))
    }
    schedulePlayback()
  } catch (error) {
    loaded.value = true
    loadingError = `보관함 사본을 불러오지 못했어: ${String(error)}`
    revision.value++
    console.error(error)
  }
}

window.addEventListener('keydown', event => {
  const target = event.target as HTMLElement
  // Do not intercept text input. A focused seek range keeps its native arrow,
  // Home and End controls, while Space/P/M/L still operate the reel as requested.
  if (target.closest('input:not([type="range"]), textarea, select, [contenteditable="true"]')) return
  const range = target.closest('input[type="range"]')
  if (range && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  if (event.key === 'Escape') { albumPickerOpen.value = false; return }
  if (albumPickerOpen.value || event.repeat) return
  const key = event.key.toLowerCase()
  if (event.key === 'ArrowDown' || event.key === 'PageDown' || key === 'j' || event.key === ' ') {
    event.preventDefault(); move(1)
  } else if (event.key === 'ArrowUp' || event.key === 'PageUp' || key === 'k') {
    event.preventDefault(); move(-1)
  } else if (event.key === 'Home') {
    event.preventDefault(); seekTo(0)
  } else if (event.key === 'End') {
    event.preventDefault(); seekTo(lastOrder.length - 1)
  } else if (key === 'm') toggleMute()
  else if (key === 'p') togglePlay()
  else if (key === 'l') toggleFavorite(selectedItem()?.id)
})
// Mun mounts/unmounts neighbor videos asynchronously as activeIndex changes.
// A DOM observer catches the completed update even when the previous RAF ran
// before the newly selected <video> existed.
const mediaObserver = new MutationObserver(records => {
  if (records.some(record =>
    (record.type === 'attributes' && record.attributeName === 'data-current') ||
    (record.type === 'childList' && [...record.addedNodes].some(node =>
      node instanceof HTMLElement &&
      (node.matches('video, .reel-card, .reels-scroller') || !!node.querySelector('video')),
    )),
  )) schedulePlayback()
})
mediaObserver.observe(root, {
  childList: true, subtree: true, attributes: true,
  attributeFilter: ['data-current'],
})
document.addEventListener('visibilitychange', schedulePlayback)
window.addEventListener('pageshow', schedulePlayback)
window.addEventListener('focus', schedulePlayback)
window.addEventListener('resize', () => {
  const scroller = document.getElementById('reels-scroller')
  if (scroller) scroller.scrollTop = activeIndex.value * scroller.clientHeight
  schedulePlayback()
})
window.addEventListener('pagehide', () => {
  disposed = true
  clearPlaybackRetry()
  mediaObserver.disconnect()
  unmount()
}, { once: true })
void loadLibrary()
