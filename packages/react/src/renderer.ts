import {
  Fragment,
  cloneElement,
  createElement,
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
  type ReactNode,
} from "react"
import { createRoot, hydrateRoot, type Root } from "react-dom/client"
import {
  animationCSSStyle,
  Animation,
  collectStateReads,
  currentRenderTransaction,
  classNameOf,
  edgeInsetsFromCss,
  frameStyle,
  isForeignComponent,
  isStateRef,
  layoutLength,
  renderViewNode,
  stateTransaction,
  stateVersion,
  subscribeState,
  swiftUIAnimatableModifierNames,
  viewIdentityKey,
  withRenderTransaction,
  zeroGeometry,
  type CompiledTemplateValue,
  type GeometryProxy,
  type ModifiableViewNode,
  type MunRenderer,
  type StateRef,
  type Transaction,
  type ViewGraphValue,
  type ViewHostNode,
  type ViewModifierNode,
} from "@mun/core/compat"
import { ignoresSafeAreaStyle, paddingStyle, safeAreaPaddingStyle } from "@mun/core/internal/runtime"
import {
  keyedCollectionEntryKey,
  keyedCollectionEntries,
  reactiveIdentity,
  type KeyedCollectionEntry,
  type KeyedCollectionViewNode,
  type StateMutationBatch,
} from "@mun/core/internal/runtime"
import type { GPUIslandViewNode } from "@mun/core/internal/runtime"
import { APPLE_CONTINUOUS_CORNER_SMOOTHING } from "@mun/core/corners"
import { attachContinuousCorners, disposeContinuousCorners, isContinuousCornerStyle } from "./continuous-corners.js"

function setForwardedRef(reference: unknown, value: HTMLElement | null): void {
  if (typeof reference === "function") {
    reference(value)
    return
  }
  if (!reference || typeof reference !== "object") return
  try {
    const target = reference as { current?: HTMLElement | null }
    target.current = value
  } catch { /* readonly or hostile refs are ignored */ }
}

type ContinuousCornerHostProps = Record<string, unknown> & {
  readonly as: string
  readonly children?: ReactNode
}

function runReactParticleFallback(canvas: HTMLCanvasElement, node: GPUIslandViewNode): () => void {
  const context = canvas.getContext("2d")
  if (!context) return () => undefined
  const count = node.ir.render.vertexCount
  const data = node.options.initialData ? new Float32Array(node.options.initialData) : new Float32Array(count * 8)
  if (!node.options.initialData) for (let index = 0; index < count; index += 1) {
    const offset = index * 8
    data[offset] = ((index * 37) % Math.max(1, count)) / Math.max(1, count - 1) * 2 - 1
    data[offset + 1] = ((index * 53) % Math.max(1, count)) / Math.max(1, count - 1) * 2 - 1
    data[offset + 2] = (((index * 17) % 31) - 15) / 150
    data[offset + 3] = (((index * 23) % 29) - 14) / 150
    data[offset + 4] = 0.7; data[offset + 5] = 0.8; data[offset + 6] = 1; data[offset + 7] = 1
  }
  let request = 0
  let stopped = false
  const draw = () => {
    context.clearRect(0, 0, canvas.width, canvas.height)
    for (let index = 0; index < count; index += 1) {
      const offset = index * 8
      context.fillStyle = `rgba(${data[offset + 4]! * 255},${data[offset + 5]! * 255},${data[offset + 6]! * 255},${data[offset + 7]!})`
      context.fillRect((data[offset]! + 1) * canvas.width / 2, (1 - data[offset + 1]!) * canvas.height / 2, 2, 2)
      if (node.ir.fallback === "canvas") {
        data[offset] = Math.max(-1, Math.min(1, data[offset]! + data[offset + 2]!))
        data[offset + 1] = Math.max(-1, Math.min(1, data[offset + 1]! + data[offset + 3]!))
      }
    }
    if (!stopped && node.ir.fallback === "canvas") request = requestAnimationFrame(draw)
  }
  draw()
  return () => { stopped = true; if (request) cancelAnimationFrame(request) }
}

function ReactGPUIslandCanvas({ node }: { readonly node: GPUIslandViewNode }): ReactNode {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    if (!canvas.current) return
    canvas.current.dataset.munGpuBackend = node.ir.fallback === "canvas" ? "cpu-canvas" : "static"
    return runReactParticleFallback(canvas.current, node)
  }, [node])
  return createElement("canvas", {
    ref: canvas as RefObject<HTMLCanvasElement>,
    width: node.options.width,
    height: node.options.height,
    className: node.options.class,
    style: node.options.style as CSSProperties | undefined,
    "aria-label": node.options.ariaLabel,
    "data-mun-gpu-island": node.ir.id,
    "data-mun-gpu-kind": node.ir.kind,
    "data-mun-gpu-owner": "react",
    "data-mun-gpu-readback": "forbidden",
    "data-mun-gpu-fallback": node.ir.fallback,
  })
}

const ContinuousCornerHost = forwardRef<HTMLElement, ContinuousCornerHostProps>(function ContinuousCornerHost(input, forwardedRef) {
  const { as, children, ...hostProps } = input
  const host = useRef<HTMLElement | null>(null)
  useEffect(() => {
    setForwardedRef(forwardedRef, host.current)
    return () => setForwardedRef(forwardedRef, null)
  }, [forwardedRef])
  useEffect(() => {
    const element = host.current
    if (!element) return
    attachContinuousCorners(element)
    return () => disposeContinuousCorners(element)
  }, [hostProps.style])
  return createElement(as as string, { ...hostProps, ref: host } as any, children as ReactNode)
})

function alignmentCSSPosition(value: unknown, fallback = "center"): string {
  switch (value) {
    case "leading": return "left center"
    case "trailing": return "right center"
    case "top": return "center top"
    case "bottom": return "center bottom"
    case "topLeading": return "left top"
    case "topTrailing": return "right top"
    case "bottomLeading": return "left bottom"
    case "bottomTrailing": return "right bottom"
    case "center": return "center"
    default: return fallback
  }
}

function alignmentCSSPlace(value: unknown, fallback = "center"): string {
  switch (value) {
    case "leading": return "center start"
    case "trailing": return "center end"
    case "top": return "start center"
    case "bottom": return "end center"
    case "topLeading": return "start start"
    case "topTrailing": return "start end"
    case "bottomLeading": return "end start"
    case "bottomTrailing": return "end end"
    default: return fallback
  }
}

const filterTemplate = "blur(var(--mun-blur,0px)) brightness(var(--mun-brightness,1)) contrast(var(--mun-contrast,1)) saturate(var(--mun-saturation,1)) grayscale(var(--mun-grayscale,0)) hue-rotate(var(--mun-hue-rotation,0deg)) invert(var(--mun-color-invert,0))"
const finite = (value: unknown, fallback: number): number => typeof value === "number" && Number.isFinite(value) ? value : fallback
const fontWeights: Readonly<Record<string, number>> = Object.freeze({ ultraLight: 100, thin: 200, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, heavy: 800, black: 900 })

function longPressProps(modifier: ViewModifierNode): Record<string, unknown> {
  const duration = Math.max(0, finite(modifier.arguments[0], 0.5)) * 1000
  const distance = Math.max(0, finite(modifier.arguments[1], 10))
  const action = modifier.arguments[2]
  const changed = modifier.arguments[3]
  if (typeof action !== "function") return {}
  let timer: ReturnType<typeof setTimeout> | undefined
  let originX = 0
  let originY = 0
  let active = false
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (active && typeof changed === "function") changed(false)
    active = false
  }
  return {
    onPointerDown(event: { clientX?: number; clientY?: number }) {
      clear()
      active = true
      originX = finite(event?.clientX, 0)
      originY = finite(event?.clientY, 0)
      if (typeof changed === "function") changed(true)
      timer = setTimeout(() => { timer = undefined; action() }, duration)
    },
    onPointerMove(event: { clientX?: number; clientY?: number }) {
      if (!active) return
      if (Math.hypot(finite(event?.clientX, originX) - originX, finite(event?.clientY, originY) - originY) > distance) clear()
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
  }
}

function modifierProps(modifier: ViewModifierNode): Record<string, unknown> {
  const [value] = modifier.arguments
  let result: Record<string, unknown>
  switch (modifier.name) {
    case "padding": result = { style: paddingStyle(value, modifier.arguments[1]) }; break
    case "margin": result = { style: { margin: layoutLength(value) } }; break
    case "gap": result = { style: { gap: layoutLength(value) } }; break
    case "font": result = { style: { font: value } }; break
    case "fontSize": result = { style: { fontSize: layoutLength(value) } }; break
    case "bold": result = { style: { fontWeight: value === false ? "normal" : 700 } }; break
    case "fontWeight": result = { style: { fontWeight: typeof value === "number" ? value : typeof value === "string" ? fontWeights[value] ?? value : undefined } }; break
    case "fontDesign": result = { style: { fontFamily: value === "serif" ? "ui-serif, Georgia, serif" : value === "rounded" ? "ui-rounded, system-ui, sans-serif" : value === "monospaced" ? "ui-monospace, SFMono-Regular, Menlo, monospace" : value === "default" ? "system-ui, -apple-system, sans-serif" : undefined } }; break
    case "fontWidth": result = { style: { fontStretch: value === "compressed" ? "50%" : value === "condensed" ? "75%" : value === "expanded" ? "125%" : "100%" } }; break
    case "italic": result = { style: { fontStyle: value === false ? "normal" : "italic" } }; break
    case "underline": result = { style: value === false ? { textDecorationLine: "none" } : { textDecorationLine: "underline", textDecorationStyle: modifier.arguments[1] ?? "solid", textDecorationColor: modifier.arguments[2] ?? undefined } }; break
    case "strikethrough": result = { style: value === false ? { textDecorationLine: "none" } : { textDecorationLine: "line-through", textDecorationStyle: modifier.arguments[1] ?? "solid", textDecorationColor: modifier.arguments[2] ?? undefined } }; break
    case "monospaced": result = { style: value === false ? {} : { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" } }; break
    case "monospacedDigit": result = { style: { fontVariantNumeric: "tabular-nums" } }; break
    case "kerning":
    case "tracking": result = { style: { letterSpacing: `${finite(value, 0)}px` } }; break
    case "baselineOffset": result = { style: { position: "relative", top: `${-finite(value, 0)}px` } }; break
    case "lineSpacing": result = { style: { lineHeight: `calc(1em + ${finite(value, 0)}px)` } }; break
    case "lineLimit": {
      const lines = typeof value === "number" && value > 0 ? Math.floor(value) : undefined
      result = { style: lines ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden", minHeight: modifier.arguments[1] ? `${lines}lh` : undefined } : { WebkitLineClamp: "unset" } }
      break
    }
    case "minimumScaleFactor": result = { style: { "--mun-minimum-scale-factor": Math.max(0, Math.min(1, finite(value, 1))) } as CSSProperties }; break
    case "multilineTextAlignment": result = { style: { textAlign: value === "leading" ? "start" : value === "trailing" ? "end" : "center" } }; break
    case "truncationMode": result = { style: { textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", direction: value === "head" ? "rtl" : undefined } }; break
    case "textCase": result = { style: { textTransform: value === "uppercase" ? "uppercase" : value === "lowercase" ? "lowercase" : "none" } }; break
    case "allowsTightening": result = { style: { "--mun-allows-tightening": value === false ? 0 : 1 } as CSSProperties }; break
    case "foreground":
    case "foregroundStyle": result = { style: { color: value } }; break
    case "background": result = { style: { background: value, backgroundPosition: alignmentCSSPosition(modifier.arguments[1]) } }; break
    case "opacity": {
      const opacity = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
      result = { style: { opacity } }
      break
    }
    case "scaleEffect": {
      const scale = typeof value === "number" ? `${value}`
        : value && typeof value === "object" ? `${Number((value as { x?: unknown; width?: unknown }).x ?? (value as { width?: unknown }).width ?? 1)} ${Number((value as { y?: unknown; height?: unknown }).y ?? (value as { height?: unknown }).height ?? 1)}` : "1"
      result = { style: { scale, transformOrigin: alignmentCSSPosition(modifier.arguments[1]) } }
      break
    }
    case "rotationEffect": result = { style: {
      rotate: `${typeof value === "number" && Number.isFinite(value) ? value : 0}deg`,
      transformOrigin: alignmentCSSPosition(modifier.arguments[1]),
    } }; break
    case "offset": {
      const second = modifier.arguments[1]
      let x = 0
      let y = 0
      if (typeof value === "number") { x = value; y = typeof second === "number" ? second : 0 }
      else if (value && typeof value === "object") {
        const point = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
        x = Number(point.x ?? point.width ?? 0); y = Number(point.y ?? point.height ?? 0)
      }
      result = { style: { translate: `${Number.isFinite(x) ? x : 0}px ${Number.isFinite(y) ? y : 0}px` } }
      break
    }
    case "aspectRatio": {
      const ratio = typeof value === "number" && value > 0 ? value : value && typeof value === "object" ? finite((value as { width?: unknown }).width, 0) / Math.max(finite((value as { height?: unknown }).height, 0), Number.EPSILON) : undefined
      result = { style: { aspectRatio: ratio, objectFit: modifier.arguments[1] === "fill" ? "cover" : "contain" } }; break
    }
    case "scaledToFit": result = { style: { objectFit: "contain", maxWidth: "100%", maxHeight: "100%" } }; break
    case "scaledToFill": result = { style: { objectFit: "cover", width: "100%", height: "100%" } }; break
    case "fixedSize": result = { style: { width: value !== false ? "max-content" : undefined, height: modifier.arguments[1] !== false ? "max-content" : undefined } }; break
    case "layoutPriority": result = { style: { flexShrink: finite(value, 0) > 0 ? 0 : 1, "--mun-layout-priority": finite(value, 0) } as CSSProperties }; break
    case "position": {
      const x = typeof value === "number" ? value : finite((value as { x?: unknown } | undefined)?.x, 0)
      const y = typeof value === "number" ? finite(modifier.arguments[1], 0) : finite((value as { y?: unknown } | undefined)?.y, 0)
      result = { style: { position: "absolute", left: `${x}px`, top: `${y}px`, transform: "translate(-50%, -50%)" } }; break
    }
    case "zIndex": result = { style: { zIndex: finite(value, 0), position: "relative" } }; break
    case "ignoresSafeArea": result = { style: ignoresSafeAreaStyle(modifier.arguments[1]) }; break
    case "safeAreaPadding": result = { style: safeAreaPaddingStyle(value, modifier.arguments[1]) }; break
    case "gridCellColumns": result = { style: { gridColumn: `span ${Math.max(1, Math.floor(finite(value, 1)))}` } }; break
    case "gridCellUnsizedAxes": result = { style: { minWidth: value === "horizontal" || value === "all" ? 0 : undefined, minHeight: value === "vertical" || value === "all" ? 0 : undefined } }; break
    case "gridCellAnchor": result = { style: { placeSelf: alignmentCSSPlace(value) } }; break
    case "gridColumnAlignment": result = { style: { justifySelf: value === "leading" ? "start" : value === "trailing" ? "end" : "center" } }; break
    case "transformEffect": {
      const t = value && typeof value === "object" ? value as { a?: unknown; b?: unknown; c?: unknown; d?: unknown; tx?: unknown; ty?: unknown } : {}
      result = { style: { transform: `matrix(${finite(t.a, 1)}, ${finite(t.b, 0)}, ${finite(t.c, 0)}, ${finite(t.d, 1)}, ${finite(t.tx, 0)}, ${finite(t.ty, 0)})` } }; break
    }
    case "projectionEffect": result = { style: { transform: typeof value === "string" ? value : Array.isArray(value) && value.length === 16 ? `matrix3d(${value.map(item => finite(item, 0)).join(",")})` : undefined } }; break
    case "rotation3DEffect": {
      const axis = modifier.arguments[1] && typeof modifier.arguments[1] === "object" ? modifier.arguments[1] as { x?: unknown; y?: unknown; z?: unknown } : {}
      result = { style: { transform: `rotate3d(${finite(axis.x, 0)}, ${finite(axis.y, 0)}, ${finite(axis.z, 1)}, ${finite(value, 0)}deg)`, transformOrigin: alignmentCSSPosition(modifier.arguments[2]) } }; break
    }
    case "mask": result = { style: modifier.props && typeof modifier.props === "object" && "style" in modifier.props ? (modifier.props as { style?: unknown }).style : {} }; break
    case "clipShape": result = { style: modifier.props && typeof modifier.props === "object" && "style" in modifier.props ? (modifier.props as { style?: unknown }).style : {} }; break
    case "clipped": result = { style: { overflow: "hidden" } }; break
    case "border": result = { style: { border: `${layoutLength(modifier.arguments[1] ?? 1) ?? "1px"} solid ${String(value)}` } }; break
    case "shadow": result = { style: { boxShadow: `${finite(modifier.arguments[2], 0)}px ${finite(modifier.arguments[3], 0)}px ${Math.max(0, finite(modifier.arguments[1], 0))}px ${String(value)}` } }; break
    case "blur": result = { style: { filter: filterTemplate, "--mun-blur": `${Math.max(0, finite(value, 0))}px` } as CSSProperties }; break
    case "brightness": result = { style: { filter: filterTemplate, "--mun-brightness": Math.max(0, 1 + finite(value, 0)) } as CSSProperties }; break
    case "contrast": result = { style: { filter: filterTemplate, "--mun-contrast": Math.max(0, finite(value, 1)) } as CSSProperties }; break
    case "saturation": result = { style: { filter: filterTemplate, "--mun-saturation": Math.max(0, finite(value, 1)) } as CSSProperties }; break
    case "grayscale": result = { style: { filter: filterTemplate, "--mun-grayscale": Math.max(0, Math.min(1, finite(value, 0))) } as CSSProperties }; break
    case "hueRotation": result = { style: { filter: filterTemplate, "--mun-hue-rotation": `${finite(value, 0)}deg` } as CSSProperties }; break
    case "colorInvert": result = { style: { filter: filterTemplate, "--mun-color-invert": 1 } as CSSProperties }; break
    case "colorMultiply": result = { style: { "--mun-color-multiply": String(value) } as CSSProperties }; break
    case "blendMode": result = { style: { mixBlendMode: value === "colorDodge" ? "color-dodge" : value === "colorBurn" ? "color-burn" : value === "softLight" ? "soft-light" : value === "hardLight" ? "hard-light" : value === "plusLighter" ? "plus-lighter" : value } }; break
    case "compositingGroup": result = { style: { isolation: "isolate" } }; break
    case "drawingGroup": result = { style: { isolation: "isolate", contain: "paint" } }; break
    case "luminanceToAlpha": result = { style: { filter: `${filterTemplate} grayscale(1)` } }; break
    case "tint": {
      const tint = typeof value === "string" ? value : undefined
      result = { style: { accentColor: tint ?? "auto", "--mun-tint": tint ?? "initial" } }
      break
    }
    case "backgroundStyle": result = { style: { background: String(value), "--mun-background-style": String(value) } as CSSProperties }; break
    case "dynamicTypeSize": result = { style: { "--mun-dynamic-type-size": String(value) } as CSSProperties }; break
    case "disabled": result = value === true ? { disabled: true, inert: true, "aria-disabled": true } : { disabled: false, inert: false, "aria-disabled": false }; break
    case "hidden": result = { style: { visibility: "hidden" } }; break
    case "allowsHitTesting": result = { style: { pointerEvents: value === false ? "none" : "auto" } }; break
    case "onTapGesture": {
      const count = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1
      const action = modifier.arguments[1]
      result = typeof action !== "function" ? {} : count === 1 ? { onClick: action } : count === 2 ? { onDoubleClick: action } : { onClick(event: { detail?: number }) { if (event?.detail === count) action() } }
      break
    }
    case "onLongPressGesture": result = longPressProps(modifier); break
    case "onHover": result = typeof value === "function" ? { onPointerEnter: () => value(true), onPointerLeave: () => value(false) } : {}; break
    case "preferredColorScheme": result = { style: { colorScheme: value === "light" || value === "dark" ? value : "normal" } }; break
    case "controlSize": result = { style: { "--mun-control-size": String(value) } as CSSProperties }; break
    case "buttonStyle": result = { style: { "--mun-button-style": String(value) } as CSSProperties }; break
    case "toggleStyle": result = { style: { "--mun-toggle-style": String(value) } as CSSProperties }; break
    case "pickerStyle": result = { style: { "--mun-picker-style": String(value) } as CSSProperties }; break
    case "textFieldStyle": result = { style: { "--mun-text-field-style": String(value) } as CSSProperties }; break
    case "textEditorStyle": result = { style: { "--mun-text-editor-style": String(value) } as CSSProperties }; break
    case "listStyle": result = { style: { "--mun-list-style": String(value) } as CSSProperties }; break
    case "labelStyle": result = { style: { "--mun-label-style": String(value) } as CSSProperties }; break
    case "progressViewStyle": result = { style: { "--mun-progress-view-style": String(value) } as CSSProperties }; break
    case "scrollDisabled": result = { style: value === true ? { overflow: "hidden" } : {} }; break
    case "scrollIndicators": result = { style: value === "hidden" ? { scrollbarWidth: "none" } : {} }; break
    case "scrollBounceBehavior": result = { style: { overscrollBehavior: value === "always" || value === "basedOnSize" ? "auto" : "none" } }; break
    case "scrollClipDisabled": result = { style: value === false ? {} : { overflow: "visible" } }; break
    case "listRowInsets": result = { style: paddingStyle(value, modifier.arguments[1]) }; break
    case "listRowBackground": result = { style: typeof value === "string" ? { background: value } : {} }; break
    case "listRowSeparator":
    case "listSectionSeparator": result = { style: value === "hidden" ? { borderBlockStyle: "none" } : value === "visible" ? { borderBlockStyle: "solid" } : {} }; break
    case "symbolRenderingMode": result = { style: { "--mun-symbol-rendering-mode": value == null ? "automatic" : String(value) } as CSSProperties }; break
    case "symbolVariant": result = { style: { "--mun-symbol-variant": String(value) } as CSSProperties }; break
    case "id": result = { "data-mun-id": String(value), key: value }; break
    case "onSubmit": result = typeof value === "function" ? { onSubmit: (event: { preventDefault?: () => void }) => { event.preventDefault?.(); value() } } : {}; break
    case "focusable": result = value === false ? { tabIndex: -1 } : { tabIndex: 0, ...(typeof modifier.arguments[1] === "function" ? { onFocus: () => (modifier.arguments[1] as (focused: boolean) => void)(true), onBlur: () => (modifier.arguments[1] as (focused: boolean) => void)(false) } : {}) }; break
    case "draggable": result = { draggable: true, onDragStart: (event: { dataTransfer?: { setData?: (type: string, value: string) => void } }) => { let serialized = String(value); try { serialized = typeof value === "string" ? value : JSON.stringify(value) } catch {}; event.dataTransfer?.setData?.("application/x-mun+json", serialized) } }; break
    case "dropDestination": {
      const action = modifier.arguments[1]
      const targeted = modifier.arguments[2]
      result = typeof action === "function" ? {
        onDragEnter: (event: { preventDefault?: () => void }) => { event.preventDefault?.(); if (typeof targeted === "function") targeted(true) },
        onDragOver: (event: { preventDefault?: () => void }) => event.preventDefault?.(),
        onDragLeave: () => { if (typeof targeted === "function") targeted(false) },
        onDrop: (event: { preventDefault?: () => void; clientX?: number; clientY?: number; dataTransfer?: { getData?: (type: string) => string } }) => { event.preventDefault?.(); if (typeof targeted === "function") targeted(false); const raw = event.dataTransfer?.getData?.("application/x-mun+json") ?? ""; let item: unknown = raw; try { item = JSON.parse(raw) } catch {}; action([item], { x: finite(event.clientX, 0), y: finite(event.clientY, 0) }) },
      } : {}; break
    }
    case "scrollDismissesKeyboard": result = value === "never" ? {} : { onScroll(event: { currentTarget?: { ownerDocument?: Document } }) { const active = event?.currentTarget?.ownerDocument?.activeElement as HTMLElement | null | undefined; active?.blur?.() } }; break
    case "accessibilityLabel": result = { "aria-label": String(value) }; break
    case "accessibilityHint": result = { "aria-description": String(value) }; break
    case "accessibilityValue": result = { "aria-valuetext": String(value) }; break
    case "accessibilityHidden": result = { "aria-hidden": Boolean(value) }; break
    case "accessibilityIdentifier": result = { "data-accessibility-id": String(value) }; break
    case "accessibilityHeading": result = { role: "heading", "aria-level": /^h([1-6])$/.test(String(value)) ? Number(String(value).slice(1)) : 2 }; break
    case "accessibilitySortPriority": result = { "data-accessibility-sort-priority": String(finite(value, 0)) }; break
    case "accessibilityElement": result = { role: value === "contain" ? "group" : undefined, "data-accessibility-children": String(value ?? "ignore") }; break
    case "accessibilityAction": result = typeof modifier.arguments[1] === "function" ? { "data-accessibility-action": String(value), onClick: modifier.arguments[1] } : {}; break
    case "continuousCorners": {
      const smoothing = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : APPLE_CONTINUOUS_CORNER_SMOOTHING
      result = { style: { cornerShape: "squircle", "--mun-corner-style": "continuous", "--mun-corner-smoothing": smoothing, "--mun-corner-preserve-smoothing": 1 } }
      break
    }
    case "style": result = { style: value }; break
    case "className": result = { className: classNameOf(value) }; break
    case "withProps": result = value && typeof value === "object" ? value as Record<string, unknown> : {}; break
    case "keyed": result = { key: value }; break
    case "elementRef": result = { ref: value }; break
    case "frame": result = { style: frameStyle(value && typeof value === "object" ? value : {}) }; break
    case "animation": {
      const selected = modifier.arguments.length === 0 ? Animation.default : value as Animation | null
      result = { style: animationCSSStyle(selected) ?? {} }
      break
    }
    case "animationAuto": {
      const properties = Array.isArray(value)
        ? value.filter((property): property is string => typeof property === "string")
        : []
      const style = animationCSSStyle(Animation.default)
      result = {
        style: style
          ? { ...style, ...(properties.length > 0 ? { transitionProperty: properties.join(", ") } : {}) }
          : {},
      }
      break
    }
    default: result = {}
  }
  const transaction = currentRenderTransaction()
  if (swiftUIAnimatableModifierNames.has(modifier.name) && transaction.animation && !transaction.disablesAnimations) {
    const animationStyle = animationCSSStyle(transaction.animation)
    if (animationStyle) result = { ...result, style: { ...(result.style && typeof result.style === "object" ? result.style : {}), ...animationStyle } }
  }
  return result
}

function nativeElementProps(props: Record<string, unknown>): Record<string, unknown> {
  try {
    const normalized: Record<string, unknown> = {}
    for (const key of Reflect.ownKeys(props)) {
      if (typeof key !== "string") continue
      const descriptor = Object.getOwnPropertyDescriptor(props, key)
      if (!descriptor || !("value" in descriptor)) continue
      const value = descriptor.value
      const primitive = value === undefined || value === null || typeof value === "string" || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))
      if (primitive
        || (key === "style" && typeof value === "object" && value !== null)
        || (key === "ref" && (typeof value === "object" || typeof value === "function"))
        || (/^on[A-Za-z]/.test(key) && typeof value === "function")) {
        Object.defineProperty(normalized, key, { ...descriptor, configurable: true })
      }
    }
    return normalized
  } catch {
    return {}
  }
}

function applyProps(content: ReactNode, extra: Record<string, unknown>): ReactNode {
  if (content && typeof content === "object" && "type" in content && "props" in content) {
    const element = content as Parameters<typeof cloneElement>[0]
    const appliedExtra = typeof element.type === "string" && !element.type.includes("-") ? nativeElementProps(extra) : extra
    const current = (element.props ?? {}) as Record<string, unknown>
    const currentStyle = current.style && typeof current.style === "object" ? current.style as CSSProperties : {}
    const nextStyle = appliedExtra.style && typeof appliedExtra.style === "object" ? appliedExtra.style as CSSProperties : undefined
    const currentClass = typeof current.className === "string" ? current.className : ""
    const nextClass = typeof appliedExtra.className === "string" ? appliedExtra.className : ""
    const className = [currentClass, nextClass].filter(Boolean).join(" ")
    const composedStyle = nextStyle ? { ...currentStyle, ...nextStyle } : currentStyle
    if (nextStyle?.transform && currentStyle.transform) composedStyle.transform = `${currentStyle.transform} ${nextStyle.transform}`
    const props = {
      ...appliedExtra,
      ...(className ? { className } : {}),
      ...( "style" in appliedExtra ? { style: composedStyle } : {}),
    }
    return cloneElement(element, props)
  }
  return createElement(Fragment, null, content)
}

function normalizeElementProps(props: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!props) return null
  // Core element props are immutable snapshots. The overwhelming majority of
  // host rows (key/data/aria/primitive props) already use names React accepts,
  // so avoid cloning and enumerating them twice merely to discover there was
  // nothing to normalize.
  let needsNormalization = false
  for (const key of Object.keys(props)) {
    const value = props[key]
    if (key === "class" || key === "for" || (key === "style" && typeof value === "string")
      || (typeof value === "function" && /^on[a-z]/.test(key))) {
      needsNormalization = true
      break
    }
  }
  if (!needsNormalization) return props
  const next = { ...props }
  if ("class" in next && !("className" in next)) {
    next.className = next.class
    delete next.class
  }
  if ("for" in next && !("htmlFor" in next)) {
    next.htmlFor = next.for
    delete next.for
  }
  if (typeof next.style === "string") {
    next.style = Object.fromEntries(next.style.split(";").flatMap(declaration => {
      const colon = declaration.indexOf(":")
      if (colon < 0) return []
      const rawName = declaration.slice(0, colon).trim()
      const value = declaration.slice(colon + 1).trim()
      if (!rawName || !value) return []
      const name = rawName.startsWith("--") ? rawName : rawName.replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase())
      return [[name, value]]
    }))
  }
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "function" && /^on[a-z]/.test(key)) {
      delete next[key]
      next[`on${key[2].toUpperCase()}${key.slice(3)}`] = value
    }
  }
  return next
}

const directCollectionUnsafeTags = new Set([
  "script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes", "plaintext",
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
  "table", "caption", "colgroup", "thead", "tbody", "tfoot", "tr", "td", "th",
  "select", "option", "optgroup", "template", "svg", "math",
])

const directCollectionUnsafeProps = new Set([
  "children", "key", "ref", "innerHTML", "outerHTML", "textContent", "innerText", "dangerouslySetInnerHTML", "__proto__",
])

function directCollectionPropsSafe(props: Record<string, unknown> | null): boolean {
  if (!props) return true
  try {
    for (const key of Reflect.ownKeys(props)) {
      if (typeof key !== "string") return false
      const descriptor = Object.getOwnPropertyDescriptor(props, key)
      if (!descriptor || !("value" in descriptor)) return false
      const value = descriptor.value
      if (directCollectionUnsafeProps.has(key) || key.startsWith("data-mun-") || /^on[a-z]/i.test(key)) return false
      if (key === "style") {
        if (value === undefined || value === null || typeof value === "string") continue
        if (typeof value !== "object") return false
        for (const styleKey of Reflect.ownKeys(value)) {
          if (typeof styleKey !== "string" || styleKey === "__proto__") return false
          const styleDescriptor = Object.getOwnPropertyDescriptor(value, styleKey)
          if (!styleDescriptor || !("value" in styleDescriptor)) return false
          const item = styleDescriptor.value
          if (item !== undefined && item !== null && typeof item !== "string"
            && (typeof item !== "number" || !Number.isFinite(item))) return false
        }
        continue
      }
      const primitive = value === undefined || value === null || typeof value === "string" || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))
      if (!primitive) return false
    }
    return true
  } catch {
    return false
  }
}

function directCollectionText(value: unknown): { readonly ok: true; readonly value: ReactNode } | { readonly ok: false } {
  if (value === null || value === undefined || typeof value === "boolean") return { ok: true, value: null }
  if (typeof value === "string" || typeof value === "number") return { ok: true, value }
  if (typeof value === "bigint") return { ok: true, value: String(value) }
  return { ok: false }
}

function renderDirectCollectionRow(node: KeyedCollectionViewNode, item: unknown, index: number, key: string): ReactNode | undefined {
  const plan = node.compiled
  if (plan?.kind !== "flat-text-host") return undefined
  let type: string
  let props: Record<string, unknown> | null
  let textValue: unknown
  if (typeof plan.hostType === "string" && typeof plan.evaluateText === "function") {
    type = plan.hostType
    if (type.includes("-") || directCollectionUnsafeTags.has(type.toLowerCase())) return undefined
    if (plan.staticProps === null) props = null
    else if (plan.staticProps !== undefined) props = plan.staticProps
    else if (plan.evaluateProps) props = plan.evaluateProps(item, index)
    else return undefined
    if (!directCollectionPropsSafe(props)) return undefined
    textValue = plan.evaluateText(item, index)
  } else {
    const row = plan.evaluate(item, index)
    if (!row || typeof row !== "object" || typeof row.type !== "string" || row.type.includes("-")
      || directCollectionUnsafeTags.has(row.type.toLowerCase()) || !directCollectionPropsSafe(row.props)) return undefined
    type = row.type
    props = row.props
    textValue = row.text
  }
  const text = directCollectionText(textValue)
  if (!text.ok) return undefined
  if (props === null) return createElement(type, { key }, text.value)
  return createElement(type, { ...(normalizeElementProps(props) ?? {}), key }, text.value)
}

function renderDirectCollectionEntry(node: KeyedCollectionViewNode, entry: KeyedCollectionEntry): ReactNode | undefined {
  return renderDirectCollectionRow(node, entry.item, entry.index, entry.key)
}

interface ReactCompiledCollectionRow {
  readonly key: string
  readonly baseKey: string
  readonly occurrence: number
  readonly itemIdentity: unknown
  readonly index: number
  readonly plan: NonNullable<KeyedCollectionViewNode["compiled"]>
  readonly node: ReactNode
}

interface ReactCollectionMutationEffects {
  readonly forceAll: boolean
  readonly touchedItems: ReadonlySet<object>
}

function reactCollectionItems(
  node: KeyedCollectionViewNode,
  previous: readonly unknown[] | undefined,
  notifications: readonly { readonly dependency: StateRef<unknown>; readonly batch: StateMutationBatch }[],
  forceFullSnapshot = false,
): readonly unknown[] {
  if (!node.readItems) return node.items
  const source = isStateRef(node.source) ? node.source : undefined
  if (forceFullSnapshot || !previous || !source) return node.readItems()
  const sourceIdentity = reactiveIdentity(source.value)
  let next: unknown[] | undefined
  const mutable = (): unknown[] => next ??= [...previous]
  for (const notification of notifications) {
    if (notification.dependency !== source) continue
    for (const mutation of notification.batch.mutations) {
      const target = mutation.target
      if (mutation.kind === "replace") {
        if (mutation.snapshot) return mutation.snapshot
        if (!target || !Object.is(target, sourceIdentity)) return node.readItems()
        if (typeof mutation.property !== "string") return node.readItems()
        const index = Number(mutation.property)
        if (!Number.isSafeInteger(index) || index < 0 || index >= previous.length || String(index) !== mutation.property) return node.readItems()
        mutable()[index] = mutation.value
        continue
      }
      if (!target || !Object.is(target, sourceIdentity)) continue
      if (mutation.kind === "set") {
        if (mutation.property === "length") {
          const length = typeof mutation.value === "number" ? mutation.value : Number.NaN
          if (!Number.isSafeInteger(length) || length < 0) return node.readItems()
          mutable().length = length
          continue
        }
        if (typeof mutation.property === "string") {
          const index = Number(mutation.property)
          if (Number.isSafeInteger(index) && index >= 0 && index < 0xffff_ffff && String(index) === mutation.property) mutable()[index] = mutation.value
        }
        continue
      }
      if (mutation.kind === "delete") {
        if (typeof mutation.property === "string") {
          const index = Number(mutation.property)
          if (Number.isSafeInteger(index) && index >= 0 && index < 0xffff_ffff && String(index) === mutation.property) delete mutable()[index]
        }
        continue
      }
      if (mutation.kind !== "array") {
        if (mutation.kind === "invalidate" || mutation.kind === "define") return node.readItems()
        continue
      }
      const values = mutable()
      const arguments_ = [...(mutation.arguments ?? [])]
      switch (mutation.method) {
        case "push": values.push(...arguments_); break
        case "pop": values.pop(); break
        case "shift": values.shift(); break
        case "unshift": values.unshift(...arguments_); break
        case "splice": Array.prototype.splice.apply(values, arguments_ as [number, number, ...unknown[]]); break
        case "reverse": values.reverse(); break
        case "copyWithin": Array.prototype.copyWithin.apply(values, arguments_ as [number, number, number?]); break
        case "fill": Array.prototype.fill.apply(values, arguments_ as [unknown, number?, number?]); break
        default: return node.readItems()
      }
    }
  }
  return next ?? previous
}

function reactCollectionMutationEffects(
  node: KeyedCollectionViewNode,
  items: readonly unknown[],
  notifications: readonly { readonly dependency: StateRef<unknown>; readonly batch: StateMutationBatch }[],
  forceAllWithoutBatch = false,
): ReactCollectionMutationEffects {
  if (forceAllWithoutBatch) return { forceAll: true, touchedItems: new Set() }
  if (notifications.length === 0) return { forceAll: false, touchedItems: new Set() }
  const source = isStateRef(node.source) ? node.source : undefined
  const sourceIdentity = source ? reactiveIdentity(source.value) : undefined
  const candidateTargets = new Set<object>()
  let forceAll = false
  for (const notification of notifications) {
    if (source && notification.dependency !== source) {
      forceAll = true
      break
    }
    for (const mutation of notification.batch.mutations) {
      const target = mutation.target
      if (!target) {
        if (mutation.kind === "invalidate") forceAll = true
        continue
      }
      if (sourceIdentity && Object.is(target, sourceIdentity)) continue
      candidateTargets.add(target)
    }
  }
  if (forceAll || candidateTargets.size === 0) return { forceAll, touchedItems: candidateTargets }
  const itemIdentities = new Set<object>()
  for (const item of items) {
    const identity = reactiveIdentity(item)
    if (identity && typeof identity === "object") itemIdentities.add(identity)
  }
  for (const target of candidateTargets) {
    // A direct row-object mutation can invalidate that row precisely. A deeper
    // nested target is not cheaply attributable to one row here, so retain the
    // compiler's correctness contract by invalidating all rows conservatively.
    if (!itemIdentities.has(target)) return { forceAll: true, touchedItems: candidateTargets }
  }
  return { forceAll: false, touchedItems: candidateTargets }
}

function renderCompiledCollectionRows(
  node: KeyedCollectionViewNode,
  renderEntry: (entry: KeyedCollectionEntry) => ReactNode,
  previousRows: readonly (ReactCompiledCollectionRow | undefined)[],
  notifications: readonly { readonly dependency: StateRef<unknown>; readonly batch: StateMutationBatch }[],
  items: readonly unknown[],
  forceAllWithoutBatch = false,
): { readonly children: ReactNode[]; readonly rows: Array<ReactCompiledCollectionRow | undefined> } | undefined {
  const plan = node.compiled
  if (plan?.kind !== "flat-text-host") return undefined
  const effects = reactCollectionMutationEffects(node, items, notifications, forceAllWithoutBatch)
  const occurrences = new Map<string, number>()
  const children = new Array<ReactNode>(items.length)
  const rows = new Array<ReactCompiledCollectionRow | undefined>(items.length)
  let previousByKey: Map<string, ReactCompiledCollectionRow> | undefined
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const resolved = node.key(item, index)
    if (!resolved || typeof resolved.identity !== "string" || typeof resolved.display !== "string") {
      throw new TypeError("Keyed collection identity must contain string identity and display values")
    }
    const occurrence = occurrences.get(resolved.identity) ?? 0
    occurrences.set(resolved.identity, occurrence + 1)
    if (occurrence > 0) node.onDuplicateKey?.(resolved.display, occurrence)
    const key = keyedCollectionEntryKey(resolved.identity, occurrence)
    const itemIdentity = reactiveIdentity(item)
    let previous = previousRows[index]
    if (previous?.key !== key && plan.indexIndependent && previousRows.length > 0) {
      previousByKey ??= new Map(previousRows.flatMap(row => row ? [[row.key, row] as const] : []))
      previous = previousByKey.get(key)
    }
    const touched = itemIdentity && typeof itemIdentity === "object" && effects.touchedItems.has(itemIdentity)
    if (!effects.forceAll && !touched && previous && previous.key === key && previous.plan === plan
      && Object.is(previous.itemIdentity, itemIdentity) && (plan.indexIndependent || previous.index === index)) {
      children[index] = previous.node
      rows[index] = previous
      continue
    }
    const direct = renderDirectCollectionRow(node, item, index, key)
    if (direct !== undefined) {
      children[index] = direct
      rows[index] = { key, baseKey: resolved.identity, occurrence, itemIdentity, index, plan, node: direct }
      continue
    }
    const entry: KeyedCollectionEntry = {
      key,
      baseKey: resolved.identity,
      displayKey: resolved.display,
      occurrence,
      item,
      index,
    }
    const fallback = createElement(Fragment, { key }, renderEntry(entry))
    children[index] = fallback
  }
  return { children, rows }
}

function localizedCompiledCollectionIndex(
  node: KeyedCollectionViewNode,
  notifications: readonly { readonly dependency: StateRef<unknown>; readonly batch: StateMutationBatch }[],
  itemCount: number,
): number | undefined {
  const source = isStateRef(node.source) ? node.source : undefined
  if (!source || notifications.length !== 1) return undefined
  const notification = notifications[0]
  if (notification.dependency !== source || notification.batch.mutations.length !== 1) return undefined
  const mutation = notification.batch.mutations[0]
  if (mutation.kind !== "replace" && mutation.kind !== "set") return undefined
  const target = mutation.target ? reactiveIdentity(mutation.target) : undefined
  if (!target || !Object.is(target, reactiveIdentity(source.value)) || typeof mutation.property !== "string") return undefined
  const index = Number(mutation.property)
  return Number.isSafeInteger(index) && index >= 0 && index < itemCount && String(index) === mutation.property
    ? index
    : undefined
}

function renderLocalizedCompiledCollectionRow(
  node: KeyedCollectionViewNode,
  previousRows: readonly (ReactCompiledCollectionRow | undefined)[],
  previousChildren: readonly ReactNode[],
  items: readonly unknown[],
  index: number,
): { readonly children: ReactNode[]; readonly rows: Array<ReactCompiledCollectionRow | undefined> } | undefined {
  const plan = node.compiled
  const previous = previousRows[index]
  if (plan?.kind !== "flat-text-host" || !previous || previous.plan !== plan
    || previousRows.length !== items.length || previousChildren.length !== items.length) return undefined
  const item = items[index]
  const resolved = node.key(item, index)
  if (!resolved || resolved.identity !== previous.baseKey) return undefined
  const direct = renderDirectCollectionRow(node, item, index, previous.key)
  if (direct === undefined) return undefined
  const children = previousChildren.slice()
  const rows = previousRows.slice()
  children[index] = direct
  rows[index] = {
    key: previous.key,
    baseKey: previous.baseKey,
    occurrence: previous.occurrence,
    itemIdentity: reactiveIdentity(item),
    index,
    plan,
    node: direct,
  }
  return { children, rows }
}

function isStableCompiledReplacement(
  node: KeyedCollectionViewNode,
  notifications: readonly { readonly dependency: StateRef<unknown>; readonly batch: StateMutationBatch }[],
  itemCount: number,
): boolean {
  const source = isStateRef(node.source) ? node.source : undefined
  if (!source || notifications.length !== 1) return false
  const notification = notifications[0]
  if (notification.dependency !== source || notification.batch.mutations.length !== 1) return false
  const mutation = notification.batch.mutations[0]
  return mutation.kind === "replace" && mutation.property === undefined
    && mutation.snapshot?.length === itemCount
}

/**
 * Full immutable map-style updates commonly replace every row object while
 * preserving the key sequence. Reuse each row's already-encoded occurrence
 * key instead of rebuilding occurrence maps and entry-key strings.
 */
function renderStableCompiledReplacementRows(
  node: KeyedCollectionViewNode,
  previousRows: readonly (ReactCompiledCollectionRow | undefined)[],
  items: readonly unknown[],
): { readonly children: ReactNode[]; readonly rows: Array<ReactCompiledCollectionRow | undefined> } | undefined {
  const plan = node.compiled
  if (plan?.kind !== "flat-text-host" || previousRows.length !== items.length) return undefined
  const children = new Array<ReactNode>(items.length)
  const rows = new Array<ReactCompiledCollectionRow | undefined>(items.length)
  for (let index = 0; index < items.length; index += 1) {
    const previous = previousRows[index]
    if (!previous || previous.plan !== plan || previous.index !== index) return undefined
    const item = items[index]
    const resolved = node.key(item, index)
    if (!resolved || resolved.identity !== previous.baseKey) return undefined
    if (previous.occurrence > 0) node.onDuplicateKey?.(resolved.display, previous.occurrence)
    const direct = renderDirectCollectionRow(node, item, index, previous.key)
    if (direct === undefined) return undefined
    children[index] = direct
    rows[index] = {
      key: previous.key,
      baseKey: previous.baseKey,
      occurrence: previous.occurrence,
      itemIdentity: reactiveIdentity(item),
      index,
      plan,
      node: direct,
    }
  }
  return { children, rows }
}

function ReactCollectionHost({
  node,
  renderEntry,
}: {
  readonly node: KeyedCollectionViewNode
  readonly renderEntry: (entry: KeyedCollectionEntry) => ReactNode
}): ReactNode {
  const compiledRows = useRef<Array<ReactCompiledCollectionRow | undefined>>([])
  const compiledChildren = useRef<ReactNode[]>([])
  const pendingNotifications = useRef<Array<{ readonly dependency: StateRef<unknown>; readonly batch: StateMutationBatch }>>([])
  const sourceVersion = useRef<number | undefined>(undefined)
  const compiledItems = useRef<readonly unknown[] | undefined>(undefined)
  // Keep collection reads below their own React boundary. The direct plan
  // avoids rebuilding row View graphs, while collectStateReads still retains
  // the generic fallback's dependency semantics for manually supplied plans
  // and ordinary State-backed ForEach nodes.
  const reactive = useReactiveGraph(() => {
    const notifications = pendingNotifications.current
    pendingNotifications.current = []
    const source = isStateRef(node.source) ? node.source : undefined
    const nextSourceVersion = source ? stateVersion(source) : undefined
    const missedMutation = compiledRows.current.length > 0
      && sourceVersion.current !== undefined
      && nextSourceVersion !== sourceVersion.current
      && notifications.length === 0
    sourceVersion.current = nextSourceVersion
    const nextItems = node.compiled?.kind === "flat-text-host"
      ? reactCollectionItems(node, compiledItems.current, notifications, missedMutation)
      : undefined
    const stableReplacement = !missedMutation && nextItems && isStableCompiledReplacement(node, notifications, nextItems.length)
      ? renderStableCompiledReplacementRows(node, compiledRows.current, nextItems)
      : undefined
    const localIndex = !missedMutation && nextItems
      ? localizedCompiledCollectionIndex(node, notifications, nextItems.length)
      : undefined
    const localized = nextItems && localIndex !== undefined
      ? renderLocalizedCompiledCollectionRow(node, compiledRows.current, compiledChildren.current, nextItems, localIndex)
      : undefined
    const compiled = stableReplacement ?? localized ?? (nextItems
      ? renderCompiledCollectionRows(node, renderEntry, compiledRows.current, notifications, nextItems, missedMutation)
      : undefined)
    if (compiled) {
      compiledRows.current = compiled.rows
      compiledChildren.current = compiled.children
      compiledItems.current = nextItems
      return createElement(Fragment, null, compiled.children)
    }
    compiledRows.current = []
    compiledChildren.current = []
    compiledItems.current = undefined
    return createElement(Fragment, null, keyedCollectionEntries(node).map(entry => {
      const direct = renderDirectCollectionEntry(node, entry)
      return direct ?? createElement(Fragment, { key: entry.key }, renderEntry(entry))
    }))
  }, undefined, false, (dependency, batch) => {
    pendingNotifications.current.push({ dependency, batch })
  })
  return withRenderTransaction(reactive.transaction, () => reactive.value)
}

function normalizeForeignProps(
  type: Parameters<NonNullable<MunRenderer<ReactNode>["element"]>>[0],
  props: Record<string, unknown> | null,
  children: ReactNode[],
): Record<string, unknown> | null {
  if (!isForeignComponent(type)) return normalizeElementProps(props)
  const next = normalizeElementProps({ ...type.props, ...type.events, ...(props ?? {}) }) ?? {}
  if (type.key !== undefined) next.key = type.key
  for (const [name, slot] of Object.entries(type.slots)) {
    next[name] = (...args: unknown[]) => renderViewNode(typeof slot === "function" ? slot(...args) : slot, renderer)
  }
  if (children.length > 0 && !("children" in next)) next.children = children
  return next
}

interface ReactiveGraph<T> {
  readonly value: T
  readonly transaction?: Transaction
}

let nextStateDependencyId = 1
const stateDependencyIds = new WeakMap<StateRef<unknown>, number>()

function stateDependencyId(state: StateRef<unknown>): number {
  let id = stateDependencyIds.get(state)
  if (id === undefined) {
    id = nextStateDependencyId++
    stateDependencyIds.set(state, id)
  }
  return id
}

function collectCompilerOwnedCollectionStates(value: ViewGraphValue, result = new Set<StateRef<unknown>>()): Set<StateRef<unknown>> {
  if (Array.isArray(value)) {
    for (const child of value) collectCompilerOwnedCollectionStates(child, result)
    return result
  }
  if (value === null || typeof value !== "object") return result
  const node = value as any
  switch (node.kind) {
    case "collection":
      if (node.compiled?.evaluateKey && isStateRef(node.source)) result.add(node.source)
      return result
    case "element":
    case "fragment":
    case "lazy":
      for (const child of node.children ?? []) collectCompilerOwnedCollectionStates(child, result)
      return result
    case "template":
      for (const slot of node.slots ?? []) collectCompilerOwnedCollectionStates(slot, result)
      return result
    case "modified":
      collectCompilerOwnedCollectionStates(node.content, result)
      return result
    default:
      return result
  }
}

function pruneCompilerOwnedDependencies<T>(
  value: T,
  dependencies: Set<StateRef<unknown>>,
  observedDependencies: ReadonlySet<StateRef<unknown>>,
): void {
  for (const dependency of collectCompilerOwnedCollectionStates(value as ViewGraphValue)) {
    if (!observedDependencies.has(dependency)) dependencies.delete(dependency)
  }
}

function useReactiveGraph<T>(
  compute: () => T,
  staticDependencies?: () => readonly StateRef<unknown>[],
  staticDependenciesComplete = false,
  onMutation?: (dependency: StateRef<unknown>, batch: StateMutationBatch) => void,
  pruneDependencies?: (value: T, dependencies: Set<StateRef<unknown>>, observedDependencies: ReadonlySet<StateRef<unknown>>) => void,
): ReactiveGraph<T> {
  const mutationObserver = useRef(onMutation)
  mutationObserver.current = onMutation
  const previousVersions = useRef(new Map<StateRef<unknown>, number>())
  let transaction: Transaction | undefined
  for (const [dependency, previousVersion] of previousVersions.current) {
    if (stateVersion(dependency) === previousVersion) continue
    const candidate = stateTransaction(dependency)
    if (!transaction || candidate.animation || candidate.disablesAnimations) transaction = candidate
  }
  const declaredDependencies = staticDependencies?.()
  const dependencies = new Set<StateRef<unknown>>(declaredDependencies ?? [])
  const observedDependencies = new Set<StateRef<unknown>>()
  const needsObservedDependencies = Boolean(pruneDependencies)
  const value = withRenderTransaction(transaction, () => declaredDependencies && staticDependenciesComplete && !needsObservedDependencies
    ? compute()
    : collectStateReads(compute, dependency => {
        observedDependencies.add(dependency)
        if (!(declaredDependencies && staticDependenciesComplete)) dependencies.add(dependency)
      }))
  pruneDependencies?.(value, dependencies, observedDependencies)
  const dependencyList = [...dependencies]
  const nextVersions = new Map<StateRef<unknown>, number>()
  for (const dependency of dependencyList) nextVersions.set(dependency, stateVersion(dependency))
  previousVersions.current = nextVersions
  // Subscribe keyed by the dependency-set identity so useSyncExternalStore
  // only re-subscribes when the set actually changes instead of every commit.
  const dependencyKey = dependencyList.map(stateDependencyId).sort((left, right) => left - right).join(",")
  const subscribe = useMemo(
    () => (listener: () => void) => {
      const unsubscribers = dependencyList.map(dependency => subscribeState(dependency, (_transaction, batch) => {
        mutationObserver.current?.(dependency, batch)
        listener()
      }))
      return () => unsubscribers.forEach(unsubscribe => unsubscribe())
    },
    // The dependency list is rebuilt every render, but this key changes only
    // when the actual set changes.
    [dependencyKey],
  )
  const getSnapshot = useMemo(
    () => () => {
      let version = 0
      for (const dependency of dependencyList) version += stateVersion(dependency)
      return version
    },
    [dependencyKey],
  )
  useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  )
  return { value, transaction }
}

function geometryFromElement(element: Element): GeometryProxy {
  let rect: DOMRect
  try { rect = element.getBoundingClientRect() } catch { return zeroGeometry }
  const frame = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  }
  const document = element.ownerDocument
  const view = document.defaultView
  const fallback = { frame, size: { width: rect.width, height: rect.height }, safeAreaInsets: zeroGeometry.safeAreaInsets }
  if (!view?.getComputedStyle || !document.body) return fallback
  const probe = document.createElement("div")
  probe.style.cssText = "position:fixed;inset:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"
  try {
    document.body.appendChild(probe)
    const style = view.getComputedStyle(probe)
    const safeAreaInsets = edgeInsetsFromCss({ top: style.paddingTop, right: style.paddingRight, bottom: style.paddingBottom, left: style.paddingLeft })
    return { frame, size: { width: rect.width, height: rect.height }, safeAreaInsets }
  } catch {
    // Geometry is still useful when CSSOM access is unavailable (sandboxed or
    // synthetic documents). Safe-area measurement is optional, not fatal.
    return fallback
  } finally {
    try { probe.remove() } catch { /* detached/synthetic DOM cleanup is best-effort */ }
  }
}

function sameGeometry(left: GeometryProxy, right: GeometryProxy): boolean {
  return left.frame.x === right.frame.x
    && left.frame.y === right.frame.y
    && left.frame.width === right.frame.width
    && left.frame.height === right.frame.height
    && left.safeAreaInsets.top === right.safeAreaInsets.top
    && left.safeAreaInsets.right === right.safeAreaInsets.right
    && left.safeAreaInsets.bottom === right.safeAreaInsets.bottom
    && left.safeAreaInsets.left === right.safeAreaInsets.left
}

function GeometryHost({ render }: { render: (geometry: GeometryProxy) => ReactNode }): ReactNode {
  const host = useRef<HTMLDivElement | null>(null)
  const [geometry, setGeometry] = useState<GeometryProxy>(zeroGeometry)
  const reactive = useReactiveGraph(() => render(geometry))
  useEffect(() => {
    const element = host.current
    if (!element) return undefined
    const update = () => {
      const next = geometryFromElement(element)
      setGeometry(previous => sameGeometry(previous, next) ? previous : next)
    }
    update()
    let observer: ResizeObserver | undefined
    try {
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(update)
        observer.observe(element)
      }
    } catch {
      try { observer?.disconnect() } catch { /* broken observers are already inert */ }
      observer = undefined
    }
    const view = element.ownerDocument.defaultView
    try { view?.addEventListener("resize", update) } catch { /* synthetic window: initial measurement is still valid */ }
    return () => {
      try { observer?.disconnect() } catch { /* best-effort cleanup */ }
      try { view?.removeEventListener("resize", update) } catch { /* best-effort cleanup */ }
    }
  }, [])
  return createElement("div", { ref: host, "data-mun": "GeometryReader", style: { boxSizing: "border-box", width: "100%" } }, reactive.value)
}

function renderStatefulView({ node, ...forwardedProps }: { node: ViewHostNode } & Record<string, unknown>): ReactNode {
  const [state] = useState(() => node.state?.(node.props) ?? {})
  const resolvedProps = { ...node.props, ...state }
  const reactive = useReactiveGraph(
    () => node.render(resolvedProps),
    node.dependencies ? () => node.dependencies!(resolvedProps) : undefined,
    node.dependenciesComplete === true,
    undefined,
    pruneCompilerOwnedDependencies,
  )
  return applyProps(withRenderTransaction(reactive.transaction, () => renderViewNode(reactive.value, renderer)), forwardedProps)
}

type ReactTemplateFactory = (renderSlot: (index: number) => ReactNode) => ReactNode
const reactTemplateFactories = new WeakMap<object, ReactTemplateFactory>()

function compileReactTemplate(value: CompiledTemplateValue): ReactTemplateFactory {
  if (value !== null && typeof value === "object") {
    if (value.kind === "slot") {
      const index = value.index
      return renderSlot => renderSlot(index)
    }
    if (value.kind === "fragment") {
      const children = value.children.map(compileReactTemplate)
      return renderSlot => createElement(Fragment, null, ...children.map(child => child(renderSlot)))
    }
    if (value.kind === "element") {
      const type = value.type
      const props = value.props as any
      const children = value.children.map(compileReactTemplate)
      return renderSlot => createElement(type, props, ...children.map(child => child(renderSlot)))
    }
  }
  const staticValue = value === null || value === undefined || value === false || value === true ? null : value as ReactNode
  return () => staticValue
}

const renderer: MunRenderer<ReactNode> = {
  element(type, props, ...children) {
    const component = isForeignComponent(type) ? type.component : type
    const normalizedProps = normalizeForeignProps(type, props, children)
    if (typeof component === "string" && isContinuousCornerStyle(normalizedProps?.style)) {
      return createElement(ContinuousCornerHost, { as: component, ...(normalizedProps ?? {}) } as ContinuousCornerHostProps, ...children)
    }
    return createElement(component as any, normalizedProps as any, ...children)
  },
  fragment(children) {
    return createElement(Fragment, null, ...children)
  },
  value(value) {
    return value as ReactNode
  },
  gpuIsland(node, identity) {
    return createElement(ReactGPUIslandCanvas, { key: viewIdentityKey(identity), node })
  },
  template(node, renderSlot) {
    let factory = reactTemplateFactories.get(node.template)
    if (!factory) {
      factory = compileReactTemplate(node.template.root)
      reactTemplateFactories.set(node.template, factory)
    }
    return factory(renderSlot)
  },
  collection(node, renderEntry, identity) {
    return createElement(ReactCollectionHost, { key: viewIdentityKey(identity), node, renderEntry })
  },
  modifier(content, modifier, renderArgument) {
    if (modifier.name === "frame") {
      return createElement("div", modifierProps(modifier), content)
    }
    if ((modifier.name === "background" || modifier.name === "overlay" || modifier.name === "listRowBackground") && typeof modifier.arguments[0] !== "string" && modifier.arguments[0] != null && renderArgument) {
      const layer = renderArgument(0)
      const layerNode = createElement("div", { style: { gridArea: "1 / 1", placeSelf: alignmentCSSPlace(modifier.arguments[1]), pointerEvents: modifier.name === "overlay" ? undefined : "none" } }, layer)
      const contentNode = createElement("div", { style: { gridArea: "1 / 1", minWidth: 0, minHeight: 0 } }, content)
      return createElement("div", { style: { display: "grid", position: "relative" } }, modifier.name !== "overlay" ? layerNode : contentNode, modifier.name !== "overlay" ? contentNode : layerNode)
    }
    return applyProps(content, modifierProps(modifier))
  },
  view(node, _render, identity) {
    return createElement(renderStatefulView, { key: viewIdentityKey(identity), node })
  },
  geometry(_node, render) {
    return createElement(GeometryHost, { render })
  },
}

function RenderValue({ value, body }: { value?: ViewGraphValue; body?: () => ViewGraphValue }): ReactNode {
  const reactive = useReactiveGraph(() => body ? body() : value ?? null)
  return withRenderTransaction(reactive.transaction, () => renderViewNode(reactive.value, renderer))
}

export function render(value: ViewGraphValue): ReactNode {
  return renderViewNode(value, renderer)
}

/** Subscribe a React component to a Mun State without making State a React primitive. */
export function useMunState<T>(state: StateRef<T>): T {
  useSyncExternalStore(
    listener => subscribeState(state, listener),
    () => stateVersion(state),
    () => stateVersion(state),
  )
  return state.value
}

export interface MunViewProps<Props extends Record<string, unknown> = Record<string, unknown>> {
  readonly value?: ViewGraphValue
  readonly render?: () => ViewGraphValue
  /** Compatibility graph factory used by the existing `view()` adapter. */
  readonly body?: (props: Props) => ViewGraphValue
  readonly props?: Props
}

export function MunView<Props extends Record<string, unknown> = Record<string, unknown>>({ value, render: renderBody, body, props }: MunViewProps<Props>): ReactNode {
  const factory = renderBody ?? (body ? () => body(props ?? {} as Props) : undefined)
  return createElement(RenderValue, { value, body: factory })
}

/** Wrap a graph factory as a React component, retaining React props at the bridge. */
export function createReactView<Props extends Record<string, unknown> = Record<string, unknown>>(
  body: (props: Props) => ViewGraphValue,
): (props: Props) => ReactNode {
  return (props: Props) => createElement(MunView<Props>, { body, props })
}

export interface StatefulViewDefinition<State extends object, Props extends object = Record<string, unknown>> {
  readonly state: (props: Props) => State
  /** Optional compiler-proven State dependencies for the body. */
  readonly dependencies?: (state: State, props: Props) => readonly StateRef<unknown>[]
  /** True only for compiler-proven exhaustive dependency lists. */
  readonly dependenciesComplete?: boolean
  readonly body: (state: State, props: Props) => ViewGraphValue
}

function StatefulMunView<State extends object, Props extends object>({
  definition,
  props,
}: {
  definition: StatefulViewDefinition<State, Props>
  props: Props
}): ReactNode {
  const [state] = useState(() => definition.state(props))
  const reactive = useReactiveGraph(
    () => definition.body(state, props),
    definition.dependencies ? () => definition.dependencies!(state, props) : undefined,
    definition.dependenciesComplete === true,
  )
  return withRenderTransaction(reactive.transaction, () => renderViewNode(reactive.value, renderer))
}

export function statefulView<State extends object, Props extends object = Record<string, unknown>>(
  definition: StatefulViewDefinition<State, Props>,
): (props: Props) => ReactNode {
  return (props: Props) => createElement(StatefulMunView as any, { definition, props })
}

export function view<State extends object, Props extends object = Record<string, unknown>>(
  definition: StatefulViewDefinition<State, Props>,
): (props: Props) => ReactNode
export function view<Props extends Record<string, unknown> = Record<string, unknown>>(
  body: (props: Props) => ViewGraphValue,
): (props: Props) => ReactNode
export function view(input: ((props: Record<string, unknown>) => ViewGraphValue) | StatefulViewDefinition<object, Record<string, unknown>>): (props: Record<string, unknown>) => ReactNode {
  if (typeof input === "function") return createReactView(input)
  return (props: Record<string, unknown>) => createElement(StatefulMunView as any, { definition: input, props })
}

export interface ReactMountOptions {
  readonly hydrate?: boolean
}

/** Mount a graph into a React-managed DOM root, optionally hydrating SSR markup. */
export function mount(value: ViewGraphValue, target: Element, options: ReactMountOptions = {}): () => void {
  const element = createElement(MunView, { value })
  let root: Root
  if (options.hydrate) {
    root = hydrateRoot(target, element)
  } else {
    root = createRoot(target)
    root.render(element)
  }
  return () => root.unmount()
}

export function createRenderer(): MunRenderer<ReactNode> {
  return renderer
}

export type ReactView = ModifiableViewNode
