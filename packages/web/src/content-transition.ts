import { Animation, type ContentTransition, type SymbolReplacementFallback, type TextTransitionDirection } from "@mun/core/compat"
import { createInterpolator } from "@mun/animation"
import { munMotion, type MotionHandle } from "./element-motion.js"
import {
  createSvgPathInterpolator,
  mapSvgPathBetweenViewBoxes,
  matchSvgPathLayers,
  svgPathLength,
  type SvgPathMatchInput,
} from "./path-interpolation.js"

interface ContentRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface WebSymbolContentTransitionPlan {
  complete(): void
  cancel(): void
}

export type WebCandidatePropsReader = (element: Element) => Record<string, unknown> | null | undefined

const activeContentTransitions = new WeakMap<Element, { cancel(): void }>()

function normalizedRect(element: Element): ContentRect | undefined {
  try {
    const rect = element.getBoundingClientRect()
    const value = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    return Object.values(value).every(Number.isFinite) && value.width > 0 && value.height > 0 ? value : undefined
  } catch {
    return undefined
  }
}

function reducedMotion(element: Element): boolean {
  try { return element.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true }
  catch { return false }
}

function replaceActiveTransition(element: Element, next: { cancel(): void } | undefined): void {
  activeContentTransitions.get(element)?.cancel()
  if (next) activeContentTransitions.set(element, next)
  else activeContentTransitions.delete(element)
}

export function cancelWebContentTransition(element: Element): void {
  replaceActiveTransition(element, undefined)
}

function finishTracked(element: Element, handle: MotionHandle, cleanup: () => void): MotionHandle {
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    cleanup()
    if (activeContentTransitions.get(element) === tracked) activeContentTransitions.delete(element)
  }
  const tracked: MotionHandle = {
    finished: handle.finished,
    cancel() { handle.cancel(); finish() },
  }
  replaceActiveTransition(element, tracked)
  void handle.finished.then(finish, finish)
  return tracked
}

function fallbackDirection(fallback: SymbolReplacementFallback): number {
  if (fallback === "downUp") return -1
  if (fallback === "upDown") return 1
  return 0
}

function unitProgress(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function stagedString(element: Element, name: string, propsReader?: WebCandidatePropsReader): string | undefined {
  const value = propsReader?.(element)?.[name]
  if (typeof value === "string") return value
  const attribute = element.getAttribute(name)
  return attribute === null ? undefined : attribute
}

function svgLayerMap(root: Element, propsReader?: WebCandidatePropsReader): Map<string, Element> {
  const result = new Map<string, Element>()
  for (const child of root.children) {
    const id = stagedString(child, "data-mun-symbol-layer", propsReader)
    if (id) result.set(id, child)
  }
  return result
}

function isOrdinalLayerId(id: string): boolean {
  return /^layer:\d+$/.test(id)
}

interface SymbolLayerTarget {
  readonly id: string
  readonly d?: string
  readonly fill?: string
  readonly stroke?: string
  readonly strokeWidth?: string
  readonly opacity?: string
  readonly transform?: string
}

function symbolLayerTarget(element: Element, id: string, propsReader?: WebCandidatePropsReader): SymbolLayerTarget {
  return {
    id,
    d: stagedString(element, "d", propsReader),
    fill: stagedString(element, "fill", propsReader),
    stroke: stagedString(element, "stroke", propsReader),
    strokeWidth: stagedString(element, "stroke-width", propsReader) ?? stagedString(element, "strokeWidth", propsReader),
    opacity: stagedString(element, "opacity", propsReader),
    transform: stagedString(element, "transform", propsReader),
  }
}

function fixedSvgOverlay(root: Element, rect: ContentRect): SVGSVGElement | undefined {
  const document = root.ownerDocument
  if (!document.body) return undefined
  const overlay = root.namespaceURI === "http://www.w3.org/2000/svg" && root.localName === "svg"
    ? root.cloneNode(false) as SVGSVGElement
    : document.createElementNS("http://www.w3.org/2000/svg", "svg")
  overlay.removeAttribute("id")
  overlay.removeAttribute("role")
  overlay.removeAttribute("aria-label")
  overlay.setAttribute("aria-hidden", "true")
  overlay.setAttribute("data-mun-symbol-transition-layer", "")
  // Preserve inherited presentation attributes/classes and inline styling from
  // the live symbol. Paths commonly use currentColor or inherit fill/stroke,
  // so recreating a bare <svg> can visibly change the disappearing layer.
  overlay.style.position = "fixed"
  overlay.style.left = `${rect.left}px`
  overlay.style.top = `${rect.top}px`
  overlay.style.width = `${rect.width}px`
  overlay.style.height = `${rect.height}px`
  overlay.style.pointerEvents = "none"
  overlay.style.overflow = "visible"
  overlay.style.zIndex = "2147483645"
  document.body.appendChild(overlay)
  return overlay
}

function startWholeSymbolTransition(
  live: Element,
  oldClone: SVGSVGElement,
  animation: Animation,
  fallback: SymbolReplacementFallback,
): void {
  const style = (live as SVGSVGElement).style
  const oldStyle = oldClone.style
  const previousOpacity = style.opacity
  const previousTransform = style.transform
  const direction = fallbackDirection(fallback)
  const distance = Math.max(4, (normalizedRect(live)?.height ?? 24) * 0.14)
  const handle = munMotion.animate({
    animation,
    onUpdate(raw) {
      const progress = unitProgress(raw)
      style.opacity = String(progress)
      oldStyle.opacity = String(1 - progress)
      if (direction !== 0) {
        style.transform = `translateY(${direction * distance * (1 - raw)}px)`
        oldStyle.transform = `translateY(${-direction * distance * raw}px)`
      }
    },
  })
  finishTracked(live, handle, () => {
    style.opacity = previousOpacity
    style.transform = previousTransform
    oldClone.remove()
  })
}

function startLayerTransition(
  live: Element,
  oldOverlay: SVGSVGElement | undefined,
  enteringIds: ReadonlySet<string>,
  animation: Animation,
  fallback: SymbolReplacementFallback,
): void {
  const layers = svgLayerMap(live)
  const entering = [...enteringIds].map(id => layers.get(id)).filter((value): value is Element => Boolean(value))
  const oldPaths = oldOverlay ? [...oldOverlay.children] as Element[] : []
  if (entering.length === 0 && oldPaths.length === 0) {
    oldOverlay?.remove()
    return
  }
  const direction = fallbackDirection(fallback)
  const distance = Math.max(3, (normalizedRect(live)?.height ?? 24) * 0.11)
  const saved = entering.map(element => {
    const style = (element as SVGElement).style
    const value = { element, opacity: style.opacity, transform: style.transform, transformBox: style.transformBox, transformOrigin: style.transformOrigin }
    style.transformBox = "fill-box"
    style.transformOrigin = "center"
    return value
  })
  for (const element of oldPaths) {
    const style = (element as SVGElement).style
    style.transformBox = "fill-box"
    style.transformOrigin = "center"
  }
  const handle = munMotion.animate({
    animation,
    onUpdate(raw) {
      const progress = unitProgress(raw)
      for (const { element } of saved) {
        const style = (element as SVGElement).style
        style.opacity = String(progress)
        if (direction !== 0) style.transform = `translateY(${direction * distance * (1 - raw)}px)`
      }
      for (const element of oldPaths) {
        const style = (element as SVGElement).style
        style.opacity = String(1 - progress)
        if (direction !== 0) style.transform = `translateY(${-direction * distance * raw}px)`
      }
    },
  })
  finishTracked(live, handle, () => {
    for (const item of saved) {
      const style = (item.element as SVGElement).style
      style.opacity = item.opacity
      style.transform = item.transform
      style.transformBox = item.transformBox
      style.transformOrigin = item.transformOrigin
    }
    oldOverlay?.remove()
  })
}

function pathMorph(from: string | null, to: string | undefined): ((progress: number) => string) | undefined {
  if (!from || !to) return undefined
  try { return createSvgPathInterpolator(from, to) }
  catch { return undefined }
}

function pathInput(element: Element): SvgPathMatchInput | undefined {
  const d = element.getAttribute("d")
  if (!d) return undefined
  return {
    id: element.getAttribute("data-mun-symbol-layer") ?? undefined,
    d,
    fill: element.getAttribute("fill") ?? undefined,
    stroke: element.getAttribute("stroke") ?? undefined,
    strokeWidth: element.getAttribute("stroke-width") ?? undefined,
  }
}

function targetInput(target: SymbolLayerTarget): SvgPathMatchInput | undefined {
  if (!target.d) return undefined
  return { id: target.id, d: target.d, fill: target.fill, stroke: target.stroke, strokeWidth: target.strokeWidth }
}

function colorMixer(from: string | null, to: string | undefined): ((progress: number) => string) | undefined {
  if (!from || !to || from === to || from === "none" || to === "none") return undefined
  try { return createInterpolator(from, to, { type: "color", color: { space: "oklab" } }) as (progress: number) => string }
  catch { return undefined }
}

function numericMixer(from: string | null, to: string | undefined): ((progress: number) => string) | undefined {
  const left = from === null ? Number.NaN : Number(from)
  const right = to === undefined ? Number.NaN : Number(to)
  if (!Number.isFinite(left) || !Number.isFinite(right) || left === right) return undefined
  return progress => String(left + (right - left) * progress)
}

function transformMixer(from: string | null, to: string | undefined): ((progress: number) => string) | undefined {
  if (!from || !to || from === to) return undefined
  try { return createInterpolator(from, to, { type: "transform" }) as (progress: number) => string }
  catch { return undefined }
}

function presentationMorph(source: Element, target: SymbolLayerTarget): (progress: number) => void {
  const fill = colorMixer(source.getAttribute("fill"), target.fill)
  const stroke = colorMixer(source.getAttribute("stroke"), target.stroke)
  const strokeWidth = numericMixer(source.getAttribute("stroke-width"), target.strokeWidth)
  const opacity = numericMixer(source.getAttribute("opacity"), target.opacity)
  const transform = transformMixer(source.getAttribute("transform"), target.transform)
  return progress => {
    if (fill) source.setAttribute("fill", fill(progress))
    if (stroke) source.setAttribute("stroke", stroke(progress))
    if (strokeWidth) source.setAttribute("stroke-width", strokeWidth(progress))
    if (opacity) source.setAttribute("opacity", opacity(progress))
    if (transform) source.setAttribute("transform", transform(progress))
  }
}

function isStrokeOnly(target: SymbolLayerTarget): boolean {
  return Boolean(target.stroke && target.stroke !== "none" && (!target.fill || target.fill === "none"))
}

function presentationKindForElement(element: Element): "stroke" | "fill" | "mixed" {
  const stroke = element.getAttribute("stroke")
  const fill = element.getAttribute("fill")
  const hasStroke = Boolean(stroke && stroke !== "none")
  const hasFill = Boolean(fill && fill !== "none")
  if (hasStroke && hasFill) return "mixed"
  return hasStroke ? "stroke" : "fill"
}

/**
 * Morph unmatched semantic layers instead of fading the entire symbol. This is
 * what makes arbitrary icon packs useful: explicit layer names may differ, but
 * their actual geometry still has a continuous path from old to new.
 */
function startMorphingLayerTransition(
  live: Element,
  oldOverlay: SVGSVGElement | undefined,
  targets: readonly SymbolLayerTarget[],
  animation: Animation,
  fallback: SymbolReplacementFallback,
  allowTopologyDuplication: boolean,
): void {
  const liveLayers = svgLayerMap(live)
  const entering = targets.map(target => liveLayers.get(target.id)).filter((value): value is Element => Boolean(value))
  const oldPaths = oldOverlay ? [...oldOverlay.children] as Element[] : []
  if (entering.length === 0 && oldPaths.length === 0) {
    oldOverlay?.remove()
    return
  }

  const savedEntering = entering.map(element => {
    const style = (element as SVGElement).style
    const saved = {
      element,
      opacity: style.opacity,
      transform: style.transform,
      transformBox: style.transformBox,
      transformOrigin: style.transformOrigin,
    }
    style.opacity = "0"
    style.transformBox = "fill-box"
    style.transformOrigin = "center"
    return saved
  })
  const sourceInputs = oldPaths.map(pathInput)
  const targetInputs = targets.map(targetInput)
  const validSourceIndices = sourceInputs.map((value, index) => value ? index : -1).filter(index => index >= 0)
  const validTargetIndices = targetInputs.map((value, index) => value ? index : -1).filter(index => index >= 0)
  const matches = matchSvgPathLayers(
    validSourceIndices.map(index => sourceInputs[index]!),
    validTargetIndices.map(index => targetInputs[index]!),
  )
  const matchedSources = new Set<number>()
  const matchedTargets = new Set<number>()
  const pairs = matches.map(match => {
    const sourceIndex = validSourceIndices[match.sourceIndex]
    const targetIndex = validTargetIndices[match.targetIndex]
    const source = oldPaths[sourceIndex]
    const target = targets[targetIndex]
    matchedSources.add(sourceIndex)
    matchedTargets.add(targetIndex)
    const morph = pathMorph(source.getAttribute("d"), target.d)
    const style = (source as SVGElement).style
    style.transformBox = "fill-box"
    style.transformOrigin = "center"
    return { source, target, morph, presentation: presentationMorph(source, target), confidence: match.confidence }
  })

  // For unrelated shapes with no semantic common layer, preserve full
  // continuity across topology changes by splitting/merging the closest
  // geometry. When semantic common layers exist, additions/removals should
  // remain additions/removals (e.g. a slash drawing onto Wi-Fi), not steal an
  // unrelated base contour merely to avoid an appearance animation.
  if (allowTopologyDuplication && oldPaths.length > 0) {
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      if (matchedTargets.has(targetIndex) || !targets[targetIndex].d) continue
      const candidates = oldPaths.map((source, sourceIndex) => ({ source, sourceIndex, input: pathInput(source) })).filter(item => item.input)
      const one = targetInput(targets[targetIndex])
      if (!one || candidates.length === 0) continue
      const best = matchSvgPathLayers(candidates.map(item => item.input!), [one]).sort((a, b) => b.confidence - a.confidence)[0]
      if (!best) continue
      const template = candidates[best.sourceIndex].source
      const duplicate = template.cloneNode(true) as Element
      oldOverlay?.appendChild(duplicate)
      const style = (duplicate as SVGElement).style
      style.transformBox = "fill-box"
      style.transformOrigin = "center"
      const target = targets[targetIndex]
      pairs.push({
        source: duplicate,
        target,
        morph: pathMorph(duplicate.getAttribute("d"), target.d),
        presentation: presentationMorph(duplicate, target),
        confidence: best.confidence,
      })
      matchedTargets.add(targetIndex)
    }
  }

  const disappearing = oldPaths.filter((_path, index) => !matchedSources.has(index))
  const appearing = savedEntering.filter((_item, index) => !matchedTargets.has(index))
  for (const element of disappearing) {
    const style = (element as SVGElement).style
    style.transformBox = "fill-box"
    style.transformOrigin = "center"
  }
  const disappearingStrokes = new Map<Element, number>()
  for (const element of disappearing) {
    const input = pathInput(element)
    if (input && presentationKindForElement(element) === "stroke") {
      try { disappearingStrokes.set(element, Math.max(0.01, svgPathLength(input.d))) }
      catch { /* malformed external paths retain the regular fallback */ }
    }
  }
  const direction = fallbackDirection(fallback)
  const distance = Math.max(3, (normalizedRect(live)?.height ?? 24) * 0.1)

  const handle = munMotion.animate({
    animation,
    onUpdate(raw) {
      const progress = unitProgress(raw)
      // Opacity must remain a legal CSS value, while transforms deliberately
      // consume unclamped spring progress so the visual can overshoot/settle.
      const springScale = Math.max(0.5, 1 + (raw - progress) * 0.28)
      for (const { source, morph, presentation, confidence } of pairs) {
        // Poor correspondence should not extrapolate geometry far enough to
        // invert a concave shape. High-confidence matches retain the full
        // spring overshoot; uncertain matches keep the silhouette monotonic
        // while the wrapper still carries spring energy.
        const geometryProgress = confidence >= 0.55 ? raw : progress
        if (morph) source.setAttribute("d", morph(geometryProgress))
        presentation(progress)
        const style = (source as SVGElement).style
        style.opacity = "1"
        style.transform = `scale(${springScale})`
      }
      for (const element of disappearing) {
        const style = (element as SVGElement).style
        const strokeLength = disappearingStrokes.get(element)
        if (strokeLength !== undefined) {
          style.opacity = "1"
          style.strokeDasharray = String(strokeLength)
          style.strokeDashoffset = String(strokeLength * progress)
          style.transform = ""
        } else {
          style.opacity = String(1 - progress)
          style.transform = direction === 0
            ? `scale(${Math.max(0.8, 1 - raw * 0.12)})`
            : `translateY(${-direction * distance * raw}px) scale(${Math.max(0.8, 1 - raw * 0.08)})`
        }
      }
      for (const { element } of appearing) {
        const style = (element as SVGElement).style
        const target = targets.find(item => item.id === element.getAttribute("data-mun-symbol-layer"))
        if (target && isStrokeOnly(target) && target.d) {
          const length = Math.max(0.01, svgPathLength(target.d))
          style.opacity = "1"
          style.strokeDasharray = String(length)
          style.strokeDashoffset = String(length * (1 - progress))
          style.transform = ""
        } else {
          style.opacity = String(progress)
          style.transform = direction === 0
            ? `scale(${0.88 + raw * 0.12})`
            : `translateY(${direction * distance * (1 - raw)}px) scale(${0.92 + raw * 0.08})`
        }
      }
    },
  })
  finishTracked(live, handle, () => {
    for (const item of savedEntering) {
      const style = (item.element as SVGElement).style
      style.opacity = item.opacity
      style.transform = item.transform
      style.transformBox = item.transformBox
      style.transformOrigin = item.transformOrigin
      style.strokeDasharray = ""
      style.strokeDashoffset = ""
    }
    oldOverlay?.remove()
  })
}

/**
 * Snapshot the disappearing part of a VectorSymbol before reconciliation.
 * Matched layers remain live and are morphed through the attribute-motion lane.
 */
export function prepareWebSymbolContentTransition(
  live: Element,
  candidate: Element,
  transition: ContentTransition,
  animation: Animation | null | undefined,
  candidateProps?: WebCandidatePropsReader,
): WebSymbolContentTransitionPlan | undefined {
  if (transition.descriptor.kind !== "symbolEffect" || !animation || reducedMotion(live)) return undefined
  if (live.getAttribute("data-mun") !== "VectorSymbol" || stagedString(candidate, "data-mun", candidateProps) !== "VectorSymbol") return undefined
  const rect = normalizedRect(live)
  if (!rect) return undefined
  replaceActiveTransition(live, undefined)
  const before = svgLayerMap(live)
  const after = svgLayerMap(candidate, candidateProps)
  const beforeViewBox = live.getAttribute("viewBox") ?? undefined
  const afterViewBox = stagedString(candidate, "viewBox", candidateProps)
  const effect = transition.descriptor.effect.descriptor
  const matchingIds = [...before.keys()].filter(id => after.has(id))
  // Generated ordinal IDs describe source order, not semantic identity. For
  // automatic/magic replacement we therefore morph the complete geometry.
  // Explicit author IDs still preserve true semantic sublayers in-place.
  const common = new Set(
    effect.mode === "magicReplace" || effect.mode === "automatic"
      ? matchingIds.filter(id => !isOrdinalLayerId(id))
      : matchingIds,
  )
  const whole = effect.mode === "wholeSymbol"

  if (whole) {
    const overlay = fixedSvgOverlay(live, rect)
    if (!overlay) return undefined
    for (const child of live.children) overlay.appendChild(child.cloneNode(true))
    let cancelled = false
    return {
      complete() {
        if (cancelled) return
        startWholeSymbolTransition(live, overlay, animation, effect.fallback)
      },
      cancel() { cancelled = true; overlay.remove() },
    }
  }

  const oldOnly = [...before.keys()].filter(id => !common.has(id))
  const newOnlyIds = [...after.keys()].filter(id => !common.has(id))
  const newOnly = new Set(newOnlyIds)
  const morphTargets = newOnlyIds.map(id => {
    const target = symbolLayerTarget(after.get(id)!, id, candidateProps)
    return target.d && beforeViewBox !== afterViewBox
      ? { ...target, d: mapSvgPathBetweenViewBoxes(target.d, afterViewBox, beforeViewBox) }
      : target
  })
  let overlay: SVGSVGElement | undefined
  if (oldOnly.length > 0) {
    overlay = fixedSvgOverlay(live, rect)
    if (overlay) for (const id of oldOnly) overlay.appendChild(before.get(id)!.cloneNode(true))
  }
  let cancelled = false
  return {
    complete() {
      if (cancelled) return
      if (effect.mode === "magicReplace" || effect.mode === "automatic") {
        startMorphingLayerTransition(live, overlay, morphTargets, animation, effect.fallback, common.size === 0)
      } else {
        startLayerTransition(live, overlay, newOnly, animation, effect.fallback)
      }
    },
    cancel() { cancelled = true; overlay?.remove() },
  }
}

function graphemes(value: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => { segment(value: string): Iterable<{ segment: string }> } }).Segmenter
  if (!Segmenter) return Array.from(value)
  try { return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map(item => item.segment) }
  catch { return Array.from(value) }
}

function lcsPairs(left: readonly string[], right: readonly string[]): Map<number, number> {
  const rows = left.length + 1
  const columns = right.length + 1
  const table = Array.from({ length: rows }, () => new Uint16Array(columns))
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const result = new Map<number, number>()
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { result.set(i, j); i += 1; j += 1 }
    else if (table[i + 1][j] >= table[i][j + 1]) i += 1
    else j += 1
  }
  return result
}

const maximumGraphemeMatchingCells = 65_536

function copyTextStyle(source: Element, target: HTMLElement): void {
  try {
    const style = source.ownerDocument.defaultView?.getComputedStyle(source)
    if (!style) return
    for (const name of ["font", "font-family", "font-size", "font-weight", "font-style", "letter-spacing", "line-height", "color", "text-align", "text-transform", "direction", "white-space"]) {
      const value = style.getPropertyValue(name)
      if (value) target.style.setProperty(name, value)
    }
  } catch { /* detached/synthetic DOM can omit computed styles */ }
}

function makeTextOverlay(element: Element, rect: ContentRect): HTMLDivElement | undefined {
  const document = element.ownerDocument
  if (!document.body) return undefined
  const overlay = document.createElement("div")
  overlay.setAttribute("aria-hidden", "true")
  overlay.setAttribute("data-mun-text-transition-layer", "")
  overlay.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;pointer-events:none;overflow:visible;z-index:2147483645;`
  copyTextStyle(element, overlay)
  document.body.appendChild(overlay)
  return overlay
}

function concealLiveText(element: Element): () => void {
  const style = (element as HTMLElement).style
  const properties = ["color", "text-shadow", "-webkit-text-fill-color"] as const
  const previous = properties.map(name => ({
    name,
    value: style.getPropertyValue(name),
    priority: style.getPropertyPriority(name),
  }))
  style.setProperty("color", "transparent", "important")
  style.setProperty("text-shadow", "none", "important")
  style.setProperty("-webkit-text-fill-color", "transparent", "important")
  return () => {
    for (const item of previous) {
      if (item.value) style.setProperty(item.name, item.value, item.priority)
      else style.removeProperty(item.name)
    }
  }
}

function measureGraphemeRow(overlay: HTMLElement, text: string): { spans: HTMLSpanElement[]; rects: ContentRect[] } {
  const row = overlay.ownerDocument.createElement("div")
  row.style.cssText = "position:absolute;inset:0;white-space:pre;"
  const spans = graphemes(text).map(value => {
    const span = overlay.ownerDocument.createElement("span")
    span.textContent = value
    row.appendChild(span)
    return span
  })
  overlay.appendChild(row)
  const base = overlay.getBoundingClientRect()
  const rects = spans.map(span => {
    const rect = span.getBoundingClientRect()
    return { left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height }
  })
  row.remove()
  return { spans, rects }
}

function visualGlyph(overlay: HTMLElement, value: string, rect: ContentRect): HTMLSpanElement {
  const span = overlay.ownerDocument.createElement("span")
  span.textContent = value
  span.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;white-space:pre;transform-origin:center;`
  overlay.appendChild(span)
  return span
}

function numericDirection(from: string, to: string, explicit?: number): number {
  const before = Number(from.replaceAll(",", ""))
  const after = explicit ?? Number(to.replaceAll(",", ""))
  if (Number.isFinite(before) && Number.isFinite(after) && before !== after) return after > before ? -1 : 1
  return -1
}

function textPushVector(element: Element, direction: TextTransitionDirection): { x: number; y: number } {
  if (direction === "up") return { x: 0, y: -1 }
  if (direction === "down") return { x: 0, y: 1 }
  let rtl = false
  try { rtl = element.ownerDocument.defaultView?.getComputedStyle(element).direction === "rtl" }
  catch { /* detached/synthetic DOM */ }
  const leading = rtl ? 1 : -1
  return { x: direction === "leading" ? leading : -leading, y: 0 }
}

/** Animate replacement of the single text payload inside a stable Text View. */
export function playWebTextContentTransition(
  element: Element,
  from: string,
  to: string,
  transition: ContentTransition,
  animation: Animation | null | undefined,
  beforeRect?: ContentRect,
): MotionHandle | undefined {
  const descriptor = transition.descriptor
  if (descriptor.kind === "identity" || from === to || !animation || reducedMotion(element)) return undefined
  const rect = normalizedRect(element) ?? beforeRect
  if (!rect) return undefined
  const overlay = makeTextOverlay(element, rect)
  if (!overlay) return undefined
  replaceActiveTransition(element, undefined)
  const reveal = concealLiveText(element)

  if (descriptor.kind === "numericText") {
    const oldSpan = visualGlyph(overlay, from, { left: 0, top: 0, width: rect.width, height: rect.height })
    const newSpan = visualGlyph(overlay, to, { left: 0, top: 0, width: rect.width, height: rect.height })
    const direction = numericDirection(from, to, descriptor.value)
    const distance = Math.max(4, rect.height * 0.58)
    const handle = munMotion.animate({ animation, onUpdate(raw) {
      const progress = unitProgress(raw)
      oldSpan.style.opacity = String(1 - progress)
      oldSpan.style.transform = `translateY(${direction * distance * raw}px)`
      newSpan.style.opacity = String(progress)
      newSpan.style.transform = `translateY(${-direction * distance * (1 - raw)}px)`
    } })
    return finishTracked(element, handle, () => { reveal(); overlay.remove() })
  }

  if (descriptor.kind === "blurReplace") {
    const oldSpan = visualGlyph(overlay, from, { left: 0, top: 0, width: rect.width, height: rect.height })
    const newSpan = visualGlyph(overlay, to, { left: 0, top: 0, width: rect.width, height: rect.height })
    const radius = descriptor.radius
    const handle = munMotion.animate({ animation, onUpdate(raw) {
      const progress = unitProgress(raw)
      oldSpan.style.opacity = String(1 - progress)
      oldSpan.style.filter = `blur(${radius * progress}px)`
      oldSpan.style.transform = `scale(${1 + raw * 0.035})`
      newSpan.style.opacity = String(progress)
      newSpan.style.filter = `blur(${radius * (1 - progress)}px)`
      newSpan.style.transform = `scale(${0.965 + raw * 0.035})`
    } })
    return finishTracked(element, handle, () => { reveal(); overlay.remove() })
  }

  if (descriptor.kind === "push") {
    const oldSpan = visualGlyph(overlay, from, { left: 0, top: 0, width: rect.width, height: rect.height })
    const newSpan = visualGlyph(overlay, to, { left: 0, top: 0, width: rect.width, height: rect.height })
    const vector = textPushVector(element, descriptor.direction)
    const distance = Math.max(6, (vector.y === 0 ? rect.width : rect.height) * 0.32)
    const handle = munMotion.animate({ animation, onUpdate(raw) {
      const progress = unitProgress(raw)
      oldSpan.style.opacity = String(1 - progress)
      oldSpan.style.transform = `translate(${vector.x * distance * raw}px, ${vector.y * distance * raw}px)`
      newSpan.style.opacity = String(progress)
      newSpan.style.transform = `translate(${-vector.x * distance * (1 - raw)}px, ${-vector.y * distance * (1 - raw)}px)`
    } })
    return finishTracked(element, handle, () => { reveal(); overlay.remove() })
  }

  if (descriptor.kind === "scale") {
    const oldSpan = visualGlyph(overlay, from, { left: 0, top: 0, width: rect.width, height: rect.height })
    const newSpan = visualGlyph(overlay, to, { left: 0, top: 0, width: rect.width, height: rect.height })
    const targetScale = descriptor.scale
    const handle = munMotion.animate({ animation, onUpdate(raw) {
      const progress = unitProgress(raw)
      oldSpan.style.opacity = String(1 - progress)
      oldSpan.style.transform = `scale(${1 + (targetScale - 1) * raw})`
      newSpan.style.opacity = String(progress)
      newSpan.style.transform = `scale(${targetScale + (1 - targetScale) * raw})`
    } })
    return finishTracked(element, handle, () => { reveal(); overlay.remove() })
  }

  if (descriptor.kind !== "interpolate") {
    const oldSpan = visualGlyph(overlay, from, { left: 0, top: 0, width: rect.width, height: rect.height })
    const newSpan = visualGlyph(overlay, to, { left: 0, top: 0, width: rect.width, height: rect.height })
    const handle = munMotion.animate({ animation, onUpdate(raw) {
      const progress = unitProgress(raw)
      oldSpan.style.opacity = String(1 - progress)
      newSpan.style.opacity = String(progress)
    } })
    return finishTracked(element, handle, () => { reveal(); overlay.remove() })
  }

  const oldValues = graphemes(from)
  const newValues = graphemes(to)
  // LCS gives stable repeated-grapheme matching, but its matrix is O(n*m).
  // Long prose is better served by a bounded whole-text crossfade than by
  // allocating a large table for an effect intended primarily for labels.
  if (oldValues.length * newValues.length > maximumGraphemeMatchingCells) {
    const oldSpan = visualGlyph(overlay, from, { left: 0, top: 0, width: rect.width, height: rect.height })
    const newSpan = visualGlyph(overlay, to, { left: 0, top: 0, width: rect.width, height: rect.height })
    const handle = munMotion.animate({ animation, onUpdate(raw) {
      const progress = unitProgress(raw)
      oldSpan.style.opacity = String(1 - progress)
      newSpan.style.opacity = String(progress)
    } })
    return finishTracked(element, handle, () => { reveal(); overlay.remove() })
  }
  const oldLayout = measureGraphemeRow(overlay, from).rects
  const newLayout = measureGraphemeRow(overlay, to).rects
  const pairs = lcsPairs(oldValues, newValues)
  const matchedNew = new Set(pairs.values())
  const oldGlyphs = oldValues.map((value, index) => visualGlyph(overlay, value, oldLayout[index] ?? { left: 0, top: 0, width: 0, height: rect.height }))
  const newGlyphs = newValues.map((value, index) => matchedNew.has(index) ? undefined : visualGlyph(overlay, value, newLayout[index] ?? { left: 0, top: 0, width: 0, height: rect.height }))
  const handle = munMotion.animate({ animation, onUpdate(raw) {
    const progress = unitProgress(raw)
    for (let index = 0; index < oldGlyphs.length; index += 1) {
      const glyph = oldGlyphs[index]
      const match = pairs.get(index)
      if (match === undefined) {
        glyph.style.opacity = String(1 - progress)
        glyph.style.transform = `scale(${1 - raw * 0.12})`
        continue
      }
      const fromRect = oldLayout[index]
      const toRect = newLayout[match]
      if (!fromRect || !toRect) continue
      glyph.style.transform = `translate(${(toRect.left - fromRect.left) * raw}px, ${(toRect.top - fromRect.top) * raw}px)`
    }
    for (const glyph of newGlyphs) if (glyph) {
      glyph.style.opacity = String(progress)
      glyph.style.transform = `scale(${0.88 + raw * 0.12})`
    }
  } })
  return finishTracked(element, handle, () => { reveal(); overlay.remove() })
}
