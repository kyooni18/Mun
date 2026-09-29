import { Animation } from "@mun/core/compat"
import {
  MotionEngine,
  createInterpolator,
  defaultEngine,
  motionValue,
  type AnimationControls,
  type InterpolatorOptions,
} from "@mun/animation"
import { motionSpecForAnimation } from "./motion.js"

export type MotionStatus = "finished" | "cancelled"
export type MotionUpdate = (progress: number) => void

export interface MotionOptions {
  readonly animation?: Animation | null
  readonly reducedMotion?: "respect" | "ignore"
  readonly onUpdate: MotionUpdate
  readonly onComplete?: (status: MotionStatus) => void
}

export interface ElementMotionOptions {
  readonly animation?: Animation | null
  readonly reducedMotion?: "respect" | "ignore"
  readonly fill?: FillMode
  readonly composite?: CompositeOperation
}

export interface MotionHandle {
  readonly finished: Promise<MotionStatus>
  cancel(): void
}

const styleAnimationOwners = new WeakMap<Element, Map<string, MotionHandle>>()

function ownStyleAnimation(element: Element, properties: readonly string[], handle: MotionHandle): void {
  const uniqueProperties = [...new Set(properties)]
  if (uniqueProperties.length === 0) return
  let owners = styleAnimationOwners.get(element)
  if (!owners) {
    owners = new Map()
    styleAnimationOwners.set(element, owners)
  }
  const displaced = new Set<MotionHandle>()
  for (const property of uniqueProperties) {
    const previous = owners.get(property)
    if (previous && previous !== handle) displaced.add(previous)
  }
  for (const previous of displaced) previous.cancel()
  for (const property of uniqueProperties) owners.set(property, handle)
  const release = () => {
    const current = styleAnimationOwners.get(element)
    if (!current) return
    for (const property of uniqueProperties) {
      if (current.get(property) === handle) current.delete(property)
    }
    if (current.size === 0) styleAnimationOwners.delete(element)
  }
  void handle.finished.then(release, release)
}

interface AnimationTiming {
  readonly durationMs: number
  readonly delayMs: number
  readonly repeatCount: number
  readonly autoreverses: boolean
}

interface Segment {
  readonly from: unknown
  readonly to: unknown
  readonly start: number
  readonly end: number
  readonly interpolate: (progress: number) => unknown
}

const unrestrictedEngine = new MotionEngine({ respectReducedMotion: false })
let reducedMotionQuery: MediaQueryList | null | undefined
let reducedMotionMatcher: typeof globalThis.matchMedia | undefined
const keyframeMetadata = new Set(["offset", "easing", "composite", "computedOffset", "timeline", "rangeStart", "rangeEnd"])

function reducedMotionRequested(): boolean {
  const matcher = typeof globalThis.matchMedia === "function" ? globalThis.matchMedia : undefined
  if (reducedMotionQuery === undefined || reducedMotionMatcher !== matcher) {
    reducedMotionMatcher = matcher
    try { reducedMotionQuery = matcher ? matcher.call(globalThis, "(prefers-reduced-motion: reduce)") : null }
    catch { reducedMotionQuery = null }
  }
  return reducedMotionQuery?.matches ?? false
}

function animationTiming(animation: Animation): AnimationTiming {
  const descriptor = animation.descriptor
  const speed = Number.isFinite(descriptor.speed) && descriptor.speed > 0 ? descriptor.speed : 1
  const repeatCount = descriptor.repeatCount === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.floor(Number.isFinite(descriptor.repeatCount) ? descriptor.repeatCount! : 1))
  return {
    durationMs: Math.max(0, descriptor.duration * 1000 / speed),
    delayMs: Math.max(0, descriptor.delay * 1000 / speed),
    repeatCount,
    autoreverses: descriptor.autoreverses ?? false,
  }
}

function easingFor(animation: Animation): string {
  switch (animation.descriptor.kind) {
    case "linear": return "linear"
    case "easeIn": return "cubic-bezier(0.42, 0, 1, 1)"
    case "easeOut": return "cubic-bezier(0, 0, 0.58, 1)"
    case "spring": return "cubic-bezier(0.22, 1, 0.36, 1)"
    default: return "cubic-bezier(0.42, 0, 0.58, 1)"
  }
}

function normalizedFill(fill: FillMode | undefined): FillMode {
  return fill === "auto" ? "none" : fill ?? "both"
}

function cssPropertyName(value: string): string {
  if (value.startsWith("--") || value.includes("-")) return value
  return value.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`)
}

function keyframeProperties(keyframes: Keyframe[] | PropertyIndexedKeyframes): string[] {
  const names = Array.isArray(keyframes) ? keyframes.flatMap(frame => Object.keys(frame)) : Object.keys(keyframes)
  return [...new Set(names.filter(name => !keyframeMetadata.has(name)).map(cssPropertyName))]
}

function keyframesForProperty(keyframes: Keyframe[] | PropertyIndexedKeyframes, property: string): Keyframe[] | PropertyIndexedKeyframes {
  const keep = (name: string) => keyframeMetadata.has(name) || cssPropertyName(name) === property
  if (Array.isArray(keyframes)) {
    return keyframes.map(frame => Object.fromEntries(Object.entries(frame).filter(([name]) => keep(name))) as Keyframe)
  }
  return Object.fromEntries(Object.entries(keyframes).filter(([name]) => keep(name))) as PropertyIndexedKeyframes
}

function finalFrameIsReverse(timing: AnimationTiming): boolean {
  return timing.autoreverses && Number.isFinite(timing.repeatCount) && timing.repeatCount > 1 && timing.repeatCount % 2 === 0
}

function finalFrame(keyframes: Keyframe[] | PropertyIndexedKeyframes, reverse: boolean): Record<string, unknown> {
  if (Array.isArray(keyframes)) return (keyframes[reverse ? 0 : keyframes.length - 1] ?? {}) as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [name, raw] of Object.entries(keyframes)) {
    if (keyframeMetadata.has(name)) continue
    result[name] = Array.isArray(raw) ? raw[reverse ? 0 : raw.length - 1] : raw
  }
  return result
}

function applyFrame(element: Element, frame: Record<string, unknown>): void {
  const style = (element as Element & { style?: CSSStyleDeclaration }).style
  if (!style) return
  for (const [name, value] of Object.entries(frame)) {
    if (keyframeMetadata.has(name) || value === undefined || value === null) continue
    style.setProperty(cssPropertyName(name), String(value))
  }
}

function interpolationOptions(property: string, from: unknown, to: unknown): InterpolatorOptions | undefined {
  if (property === "transform") return { type: "transform" }
  if (property === "color" || property === "background" || property === "background-color" || property.endsWith("-color")) {
    return { type: "color", color: { space: "oklab" } }
  }
  const left = String(from).trim().match(/^(-?(?:\d+\.?\d*|\.\d+))(.*)$/)
  const right = String(to).trim().match(/^(-?(?:\d+\.?\d*|\.\d+))(.*)$/)
  if (!left || !right || left[2] !== right[2]) return undefined
  const start = Number(left[1])
  const end = Number(right[1])
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  const unit = left[2]
  return { interpolate: (_from, _to, progress) => `${start + (end - start) * progress}${unit}` }
}

function interpolatedSegments(keyframes: Keyframe[] | PropertyIndexedKeyframes, property: string): Segment[] | undefined {
  if (!Array.isArray(keyframes) || keyframes.length < 2) return undefined
  const frames = keyframes as Keyframe[]
  if (frames.some(frame => frame.easing != null || (frame.composite != null && frame.composite !== "replace"))) return undefined
  const authoredNames = frames.map(frame => Object.keys(frame).find(name => cssPropertyName(name) === property))
  if (authoredNames.some(name => name === undefined)) return undefined
  const values = frames.map((frame, index) => (frame as Record<string, unknown>)[authoredNames[index]!])
  if (values.some(value => value === undefined || value === null)) return undefined

  const rawOffsets = frames.map(frame => frame.offset)
  const hasOffsets = rawOffsets.some(offset => offset != null)
  if (hasOffsets && rawOffsets.some(offset => typeof offset !== "number" || !Number.isFinite(offset))) return undefined
  const offsets = hasOffsets
    ? rawOffsets as number[]
    : frames.map((_frame, index) => index / (frames.length - 1))
  if (offsets.some((offset, index) => offset < 0 || offset > 1 || (index > 0 && offset < offsets[index - 1]))) return undefined

  const result: Segment[] = []
  for (let index = 0; index < values.length - 1; index += 1) {
    const from = values[index]
    const to = values[index + 1]
    try {
      result.push({
        from,
        to,
        start: offsets[index],
        end: offsets[index + 1],
        interpolate: createInterpolator(from, to, interpolationOptions(property, from, to)),
      })
    } catch {
      return undefined
    }
  }
  return result
}

function sampleSegments(segments: readonly Segment[], progress: number): unknown {
  if (segments.length === 0) return undefined
  const clamped = Math.max(0, Math.min(1, progress))
  const segment = segments.find(item => clamped <= item.end) ?? segments[segments.length - 1]
  const span = segment.end - segment.start
  const local = span <= 0 ? 1 : (progress - segment.start) / span
  return segment.interpolate(local)
}

export class MunMotionEngine {
  readonly #cancels = new Set<() => void>()

  #track(handle: MotionHandle): MotionHandle {
    let active = true
    const cancel = () => {
      if (!active) return
      active = false
      this.#cancels.delete(cancel)
      handle.cancel()
    }
    this.#cancels.add(cancel)
    void handle.finished.then(
      () => { active = false; this.#cancels.delete(cancel) },
      () => { active = false; this.#cancels.delete(cancel) },
    )
    return { finished: handle.finished, cancel }
  }

  animate(options: MotionOptions): MotionHandle {
    const animation = options.animation ?? Animation.default
    const timing = animationTiming(animation)
    const reduced = options.reducedMotion !== "ignore" && reducedMotionRequested()
    const finalProgress = finalFrameIsReverse(timing) ? 0 : 1
    let resolve!: (status: MotionStatus) => void
    const finished = new Promise<MotionStatus>(done => { resolve = done })

    const complete = (status: MotionStatus) => {
      try { options.onComplete?.(status) } catch { /* user callback must not poison the motion scheduler */ }
      resolve(status)
    }
    if (reduced || timing.durationMs === 0) {
      let status: MotionStatus = "finished"
      try { options.onUpdate(finalProgress) } catch { status = "cancelled" }
      complete(status)
      return { finished, cancel() {} }
    }

    const engine = options.reducedMotion === "ignore" ? unrestrictedEngine : defaultEngine
    const progress = motionValue(0)
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let control: AnimationControls | undefined
    let cycle = 0
    let cancel: () => void = () => undefined
    const finish = (status: MotionStatus) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
      complete(status)
    }
    const unsubscribe = progress.subscribeValue(value => {
      try { options.onUpdate(value) }
      catch { control?.cancel(); finish("cancelled") }
    }, { emitCurrent: false })
    cancel = () => { control?.cancel(); finish("cancelled") }

    const runCycle = async (): Promise<void> => {
      while (!settled && (timing.repeatCount === Number.POSITIVE_INFINITY || cycle < timing.repeatCount)) {
        const reverse = timing.autoreverses && cycle % 2 === 1
        progress.set(reverse ? 1 : 0, 0)
        try { control = engine.animate(progress, reverse ? 0 : 1, motionSpecForAnimation(animation)) }
        catch { finish("cancelled"); return }
        const result = await control.finished
        if (settled || result.status !== "finished") { if (!settled) finish("cancelled"); return }
        cycle += 1
      }
      finish("finished")
    }
    if (timing.delayMs > 0) timer = setTimeout(() => { void runCycle() }, timing.delayMs)
    else void runCycle()
    return this.#track({ finished, cancel })
  }

  animateNumber(from: number, to: number, animation: Animation | null | undefined, onUpdate: (value: number) => void): MotionHandle {
    return this.animate({ animation, onUpdate: progress => onUpdate(from + (to - from) * progress) })
  }

  #interpolateElement(
    element: Element,
    keyframes: Keyframe[] | PropertyIndexedKeyframes,
    property: string,
    animation: Animation,
    options: ElementMotionOptions,
  ): MotionHandle | undefined {
    const style = (element as Element & { style?: CSSStyleDeclaration }).style
    const segments = interpolatedSegments(keyframes, property)
    if (!style || !segments || options.composite && options.composite !== "replace") return undefined
    const timing = animationTiming(animation)
    const fill = normalizedFill(options.fill)
    const initialValue = style.getPropertyValue(property)
    const initialPriority = typeof style.getPropertyPriority === "function" ? style.getPropertyPriority(property) : ""
    const firstValue = segments[0].from
    const lastValue = segments[segments.length - 1].to
    const reduced = options.reducedMotion !== "ignore" && reducedMotionRequested()
    let played = false
    let resolve!: (status: MotionStatus) => void
    const finished = new Promise<MotionStatus>(done => { resolve = done })
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let control: AnimationControls | undefined
    let cycle = 0
    let reverse = false
    const engine = options.reducedMotion === "ignore" ? unrestrictedEngine : defaultEngine
    const progress = motionValue(0)
    const unsubscribe = progress.subscribeValue(value => {
      style.setProperty(property, String(sampleSegments(segments, reverse ? 1 - value : value)))
    }, { emitCurrent: false })

    const restore = () => initialValue
      ? style.setProperty(property, initialValue, initialPriority)
      : style.removeProperty(property)
    const finish = (status: MotionStatus) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
      if (status === "cancelled" || (played && (fill === "none" || fill === "backwards"))) restore()
      resolve(status)
    }
    const cancel = () => { control?.cancel(); finish("cancelled") }

    if (reduced || timing.durationMs === 0) {
      if (fill === "forwards" || fill === "both") style.setProperty(property, String(finalFrameIsReverse(timing) ? firstValue : lastValue))
      finish("finished")
      return { finished, cancel }
    }

    const run = async () => {
      while (!settled && (timing.repeatCount === Number.POSITIVE_INFINITY || cycle < timing.repeatCount)) {
        played = true
        reverse = timing.autoreverses && cycle % 2 === 1
        progress.set(0, 0)
        try { control = engine.animate(progress, 1, motionSpecForAnimation(animation)) }
        catch { finish("cancelled"); return }
        const result = await control.finished
        if (settled || result.status !== "finished") { if (!settled) finish("cancelled"); return }
        cycle += 1
      }
      finish("finished")
    }

    if (timing.delayMs > 0) {
      if (fill === "both" || fill === "backwards") style.setProperty(property, String(firstValue))
      timer = setTimeout(() => { void run() }, timing.delayMs)
    } else {
      style.setProperty(property, String(firstValue))
      void run()
    }
    return { finished, cancel }
  }

  animateElement(element: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes, options: ElementMotionOptions = {}): MotionHandle {
    const properties = keyframeProperties(keyframes)
    if (properties.length > 1) {
      const handles = properties.map(property => this.animateElement(element, keyframesForProperty(keyframes, property), options))
      const finished = Promise.all(handles.map(handle => handle.finished)).then(statuses => (
        statuses.every(status => status === "finished") ? "finished" : "cancelled"
      ) as MotionStatus)
      return { finished, cancel: () => handles.forEach(handle => handle.cancel()) }
    }

    const property = properties[0]
    const animation = options.animation ?? Animation.default
    const timing = animationTiming(animation)
    const reduced = options.reducedMotion !== "ignore" && reducedMotionRequested()
    const fill = normalizedFill(options.fill)
    const canUseNative = typeof element.animate === "function" && !Object.prototype.hasOwnProperty.call(element, "animate")

    if (property && !canUseNative) {
      const fallback = this.#interpolateElement(element, keyframes, property, animation, options)
      if (fallback) {
        const tracked = this.#track(fallback)
        ownStyleAnimation(element, [property], tracked)
        return tracked
      }
    }

    let resolve!: (status: MotionStatus) => void
    const finished = new Promise<MotionStatus>(done => { resolve = done })
    if (reduced || timing.durationMs === 0 || !canUseNative) {
      if (fill === "forwards" || fill === "both") applyFrame(element, finalFrame(keyframes, finalFrameIsReverse(timing)))
      resolve("finished")
      const handle: MotionHandle = { finished, cancel() {} }
      if (property) ownStyleAnimation(element, [property], handle)
      return handle
    }

    let native: globalThis.Animation
    try {
      native = element.animate(keyframes, {
        duration: timing.durationMs,
        delay: timing.delayMs,
        iterations: timing.repeatCount,
        direction: timing.autoreverses ? "alternate" : "normal",
        easing: easingFor(animation),
        fill,
        composite: options.composite ?? "replace",
      })
    } catch {
      if (fill === "forwards" || fill === "both") applyFrame(element, finalFrame(keyframes, finalFrameIsReverse(timing)))
      resolve("cancelled")
      const handle: MotionHandle = { finished, cancel() {} }
      if (property) ownStyleAnimation(element, [property], handle)
      return handle
    }

    let settled = false
    const finiteWatchdog = Number.isFinite(timing.repeatCount)
      ? setTimeout(() => {
          if (settled) return
          try { native.cancel() } catch { /* detached animations can already be inert */ }
          if (fill === "forwards" || fill === "both") applyFrame(element, finalFrame(keyframes, finalFrameIsReverse(timing)))
          finish("finished")
        }, timing.delayMs + timing.durationMs * timing.repeatCount + 100)
      : undefined
    const finish = (status: MotionStatus) => {
      if (settled) return
      settled = true
      if (finiteWatchdog !== undefined) clearTimeout(finiteWatchdog)
      resolve(status)
    }
    const cancel = () => {
      if (settled) return
      try { native.cancel() } finally { finish("cancelled") }
    }
    void native.finished.then(() => finish("finished"), () => finish("cancelled"))
    const tracked = this.#track({ finished, cancel })
    if (property) ownStyleAnimation(element, [property], tracked)
    return tracked
  }

  cancelAll(): void {
    for (const cancel of [...this.#cancels]) cancel()
    this.#cancels.clear()
  }
}

export const munMotion = new MunMotionEngine()

export function animateMunTransition(
  element: Element,
  keyframes: Keyframe[],
  animation: Animation,
  done: () => void,
): MotionHandle {
  const handle = munMotion.animateElement(element, keyframes, { animation, fill: "forwards" })
  void handle.finished.then(done, done)
  return handle
}
