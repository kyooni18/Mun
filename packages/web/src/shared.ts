import type { LazyMeasurementIndex } from "./lazy-index.js"
import { animationCSSStyle, classNameOf, currentRenderTransaction, frameStyle, layoutLength, swiftUIAnimatableModifierNames, type Animation, type GeometryProxy, type LazyViewNode, type LazyViewRange, type Transaction, type ViewModifierNode } from "@mun/core/compat"
import { APPLE_CONTINUOUS_CORNER_SMOOTHING } from "@mun/core/corners"
import { ignoresSafeAreaStyle, paddingStyle, safeAreaPaddingStyle } from "@mun/core/internal/runtime"

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
export { classNameOf }

export function alignmentCSSPlace(value: unknown, fallback = "center"): string {
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

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function point(value: unknown, second?: unknown): { x: number; y: number } {
  if (typeof value === "number") return { x: finite(value, 0), y: finite(second, 0) }
  if (value && typeof value === "object") {
    const candidate = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
    return { x: finite(candidate.x ?? candidate.width, 0), y: finite(candidate.y ?? candidate.height, 0) }
  }
  return { x: 0, y: 0 }
}

function fontWeight(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  const weights: Record<string, string> = { ultraLight: "100", thin: "200", light: "300", regular: "400", medium: "500", semibold: "600", bold: "700", heavy: "800", black: "900" }
  return typeof value === "string" ? weights[value] ?? value : "inherit"
}

function fontFamilyForDesign(value: unknown): string | undefined {
  if (value === "serif") return "ui-serif, Georgia, serif"
  if (value === "rounded") return "ui-rounded, system-ui, sans-serif"
  if (value === "monospaced") return "ui-monospace, SFMono-Regular, Menlo, monospace"
  if (value === "default") return "system-ui, -apple-system, sans-serif"
  return undefined
}

function fontStretchForWidth(value: unknown): string | undefined {
  if (value === "compressed") return "50%"
  if (value === "condensed") return "75%"
  if (value === "standard") return "100%"
  if (value === "expanded") return "125%"
  return undefined
}

function blendMode(value: unknown): string {
  const aliases: Record<string, string> = { colorDodge: "color-dodge", colorBurn: "color-burn", softLight: "soft-light", hardLight: "hard-light", plusDarker: "darken", plusLighter: "plus-lighter" }
  return typeof value === "string" ? aliases[value] ?? value : "normal"
}

const htmlAttributeAliases: Readonly<Record<string, string>> = Object.freeze({
  allowFullScreen: "allowfullscreen",
  autoFocus: "autofocus",
  autoPlay: "autoplay",
  className: "class",
  contentEditable: "contenteditable",
  formNoValidate: "formnovalidate",
  htmlFor: "for",
  itemScope: "itemscope",
  noModule: "nomodule",
  noValidate: "novalidate",
  playsInline: "playsinline",
  readOnly: "readonly",
  spellCheck: "spellcheck",
  tabIndex: "tabindex",
  xlinkHref: "xlink:href",
  xmlLang: "xml:lang",
  xmlSpace: "xml:space",
})

const booleanHtmlAttributes = new Set([
  "allowfullscreen", "async", "autofocus", "autoplay", "checked", "controls", "default", "defer",
  "disabled", "formnovalidate", "hidden", "inert", "ismap", "itemscope", "loop", "multiple", "muted",
  "nomodule", "novalidate", "open", "playsinline", "readonly", "required", "reversed", "selected",
])

const enumeratedBooleanAttributes = new Set(["contenteditable", "draggable", "spellcheck", "translate"])

// DOM createElement/setAttribute validate names against the XML Name production.
const htmlNamePattern = /^(?:[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]|[\u{10000}-\u{EFFFF}])(?:[:A-Z_a-z\-.0-9\u00B7\u0300-\u036F\u203F-\u2040\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]|[\u{10000}-\u{EFFFF}])*$/u

export function assertHtmlName(value: string, kind: "tag" | "attribute"): string {
  if (!htmlNamePattern.test(value)) throw new TypeError(`Invalid HTML ${kind} name: ${JSON.stringify(value)}`)
  return value
}

export function htmlAttributeName(key: string): string {
  return htmlAttributeAliases[key] ?? key
}

export function isBooleanHtmlAttribute(name: string): boolean {
  return booleanHtmlAttributes.has(name.toLowerCase())
}

export function isEnumeratedBooleanAttribute(name: string): boolean {
  return enumeratedBooleanAttributes.has(name.toLowerCase())
}

export function escape(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

export function styleOf(modifier: ViewModifierNode, includeAnimationFallback = true): Record<string, string> {
  const value = modifier.arguments[0]
  let style: Record<string, string>
  switch (modifier.name) {
    case "padding": style = Object.fromEntries(Object.entries(paddingStyle(value, modifier.arguments[1])).map(([key, item]) => [cssPropertyName(key), item])); break
    case "margin": style = { margin: layoutLength(value) ?? "" }; break
    case "gap": style = { gap: layoutLength(value) ?? "" }; break
    case "font": style = { font: String(value) }; break
    case "fontSize": style = { "font-size": layoutLength(value) ?? "" }; break
    case "bold": style = { "font-weight": value === false ? "normal" : "700" }; break
    case "fontWeight": style = { "font-weight": fontWeight(value) }; break
    case "fontDesign": style = { "font-family": fontFamilyForDesign(value) ?? "" }; break
    case "fontWidth": style = { "font-stretch": fontStretchForWidth(value) ?? "" }; break
    case "italic": style = { "font-style": value === false ? "normal" : "italic" }; break
    case "underline": style = value === false ? { "text-decoration-line": "none" } : { "text-decoration-line": "underline", "text-decoration-style": String(modifier.arguments[1] ?? "solid"), ...(modifier.arguments[2] ? { "text-decoration-color": String(modifier.arguments[2]) } : {}) }; break
    case "strikethrough": style = value === false ? { "text-decoration-line": "none" } : { "text-decoration-line": "line-through", "text-decoration-style": String(modifier.arguments[1] ?? "solid"), ...(modifier.arguments[2] ? { "text-decoration-color": String(modifier.arguments[2]) } : {}) }; break
    case "monospaced": style = value === false ? {} : { "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace" }; break
    case "monospacedDigit": style = { "font-variant-numeric": "tabular-nums" }; break
    case "kerning": style = { "font-kerning": "normal", "letter-spacing": `${finite(value, 0)}px` }; break
    case "tracking": style = { "letter-spacing": `${finite(value, 0)}px` }; break
    case "baselineOffset": style = { position: "relative", top: `${-finite(value, 0)}px` }; break
    case "lineSpacing": style = { "line-height": `calc(1em + ${finite(value, 0)}px)` }; break
    case "lineLimit": {
      const lines = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
      style = lines ? { display: "-webkit-box", "-webkit-box-orient": "vertical", "-webkit-line-clamp": String(lines), overflow: "hidden", ...(modifier.arguments[1] ? { "min-height": `${lines}lh` } : {}) } : { "-webkit-line-clamp": "unset" }
      break
    }
    case "minimumScaleFactor": style = { "--mun-minimum-scale-factor": String(Math.max(0, Math.min(1, finite(value, 1)))) }; break
    case "multilineTextAlignment": style = { "text-align": value === "leading" ? "start" : value === "trailing" ? "end" : "center" }; break
    case "truncationMode": style = { "text-overflow": "ellipsis", overflow: "hidden", "white-space": "nowrap", ...(value === "head" ? { direction: "rtl" } : {}) }; break
    case "textCase": style = { "text-transform": value === "uppercase" ? "uppercase" : value === "lowercase" ? "lowercase" : "none" }; break
    case "allowsTightening": style = { "--mun-allows-tightening": value === false ? "0" : "1" }; break
    case "foreground":
    case "foregroundStyle": style = { color: String(value), ...(modifier.arguments[1] !== undefined ? { "--mun-secondary-foreground": String(modifier.arguments[1]) } : {}), ...(modifier.arguments[2] !== undefined ? { "--mun-tertiary-foreground": String(modifier.arguments[2]) } : {}) }; break
    case "background": style = typeof value === "string" ? { background: value, "background-position": alignmentCSSPosition(modifier.arguments[1]) } : {}; break
    case "opacity": {
      const opacity = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
      style = { opacity: String(opacity) }
      break
    }
    case "scaleEffect": {
      let x = 1
      let y = 1
      if (typeof value === "number" && Number.isFinite(value)) { x = value; y = value }
      else if (value && typeof value === "object") {
        const scale = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
        const rawX = Number(scale.x ?? scale.width ?? 1)
        const rawY = Number(scale.y ?? scale.height ?? 1)
        x = Number.isFinite(rawX) ? rawX : 1
        y = Number.isFinite(rawY) ? rawY : 1
      }
      // Keep transform components on separate CSS channels. This lets scale,
      // rotation and translation run with independent motion plans instead of
      // fighting over one monolithic `transform` string.
      style = {
        scale: x === y ? `${x}` : `${x} ${y}`,
        "transform-origin": alignmentCSSPosition(modifier.arguments[1]),
      }
      break
    }
    case "rotationEffect": {
      const degrees = typeof value === "number" && Number.isFinite(value) ? value : 0
      style = { rotate: `${degrees}deg`, "transform-origin": alignmentCSSPosition(modifier.arguments[1]) }
      break
    }
    case "offset": {
      const second = modifier.arguments[1]
      let x = 0
      let y = 0
      if (typeof value === "number") { x = value; y = typeof second === "number" ? second : 0 }
      else if (value && typeof value === "object") {
        const point = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
        x = Number(point.x ?? point.width ?? 0)
        y = Number(point.y ?? point.height ?? 0)
      }
      style = { translate: `${Number.isFinite(x) ? x : 0}px ${Number.isFinite(y) ? y : 0}px` }
      break
    }
    case "aspectRatio": {
      let ratio = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
      if (!ratio && value && typeof value === "object") {
        const size = value as { width?: unknown; height?: unknown }
        const width = finite(size.width, 0); const height = finite(size.height, 0)
        if (width > 0 && height > 0) ratio = width / height
      }
      style = { ...(ratio ? { "aspect-ratio": String(ratio) } : {}), "object-fit": modifier.arguments[1] === "fill" ? "cover" : "contain" }
      break
    }
    case "scaledToFit": style = { "object-fit": "contain", "max-width": "100%", "max-height": "100%" }; break
    case "scaledToFill": style = { "object-fit": "cover", width: "100%", height: "100%" }; break
    case "fixedSize": style = { ...(value !== false ? { width: "max-content" } : {}), ...(modifier.arguments[1] !== false ? { height: "max-content" } : {}) }; break
    case "layoutPriority": style = { "flex-shrink": finite(value, 0) > 0 ? "0" : "1", "--mun-layout-priority": String(finite(value, 0)) }; break
    case "position": {
      const resolved = point(value, modifier.arguments[1])
      style = { position: "absolute", left: `${resolved.x}px`, top: `${resolved.y}px`, transform: "translate(-50%, -50%)" }
      break
    }
    case "zIndex": style = { "z-index": String(finite(value, 0)), position: "relative" }; break
    case "ignoresSafeArea": style = Object.fromEntries(Object.entries(ignoresSafeAreaStyle(modifier.arguments[1])).map(([key, item]) => [cssPropertyName(key), item])); break
    case "safeAreaPadding": style = Object.fromEntries(Object.entries(safeAreaPaddingStyle(value, modifier.arguments[1])).map(([key, item]) => [cssPropertyName(key), item])); break
    case "gridCellColumns": style = { "grid-column": `span ${Math.max(1, Math.floor(finite(value, 1)))}` }; break
    case "gridCellUnsizedAxes": style = { ...(value === "horizontal" || value === "all" ? { "min-width": "0", width: "auto" } : {}), ...(value === "vertical" || value === "all" ? { "min-height": "0", height: "auto" } : {}) }; break
    case "gridCellAnchor": style = { "place-self": alignmentCSSPlace(value) }; break
    case "gridColumnAlignment": style = { "justify-self": value === "leading" ? "start" : value === "trailing" ? "end" : "center" }; break
    case "transformEffect": {
      const t = value && typeof value === "object" ? value as { a?: unknown; b?: unknown; c?: unknown; d?: unknown; tx?: unknown; ty?: unknown } : {}
      style = { transform: `matrix(${finite(t.a, 1)}, ${finite(t.b, 0)}, ${finite(t.c, 0)}, ${finite(t.d, 1)}, ${finite(t.tx, 0)}, ${finite(t.ty, 0)})` }
      break
    }
    case "projectionEffect": style = { transform: typeof value === "string" ? value : Array.isArray(value) && value.length === 16 ? `matrix3d(${value.map(item => finite(item, 0)).join(",")})` : "" }; break
    case "rotation3DEffect": {
      const axis = modifier.arguments[1] && typeof modifier.arguments[1] === "object" ? modifier.arguments[1] as { x?: unknown; y?: unknown; z?: unknown } : {}
      const perspective = finite(modifier.arguments[4], 1)
      style = { transform: `${perspective > 0 ? `perspective(${Math.max(1, 1000 / perspective)}px) ` : ""}rotate3d(${finite(axis.x, 0)}, ${finite(axis.y, 0)}, ${finite(axis.z, 1)}, ${finite(value, 0)}deg)`, "transform-origin": alignmentCSSPosition(modifier.arguments[2]) }
      break
    }
    case "mask": {
      const props = modifier.props && typeof modifier.props === "object" && "style" in modifier.props ? (modifier.props as { style?: unknown }).style : undefined
      style = props && typeof props === "object" ? Object.fromEntries(Object.entries(props as Record<string, unknown>).map(([key, item]) => [cssPropertyName(key), String(item)])) : {}
      break
    }
    case "clipShape": {
      const props = modifier.props && typeof modifier.props === "object" && "style" in modifier.props ? (modifier.props as { style?: unknown }).style : undefined
      style = props && typeof props === "object" ? Object.fromEntries(Object.entries(props as Record<string, unknown>).map(([key, item]) => [cssPropertyName(key), String(item)])) : {}
      break
    }
    case "clipped": style = { overflow: "hidden" }; break
    case "border": style = { border: `${layoutLength(modifier.arguments[1] ?? 1) ?? "1px"} solid ${String(value)}` }; break
    case "shadow": style = { "box-shadow": `${finite(modifier.arguments[2], 0)}px ${finite(modifier.arguments[3], 0)}px ${Math.max(0, finite(modifier.arguments[1], 0))}px ${String(value)}` }; break
    case "blur": style = { filter: filterTemplate, "--mun-blur": `${Math.max(0, finite(value, 0))}px` }; break
    case "brightness": style = { filter: filterTemplate, "--mun-brightness": String(Math.max(0, 1 + finite(value, 0))) }; break
    case "contrast": style = { filter: filterTemplate, "--mun-contrast": String(Math.max(0, finite(value, 1))) }; break
    case "saturation": style = { filter: filterTemplate, "--mun-saturation": String(Math.max(0, finite(value, 1))) }; break
    case "grayscale": style = { filter: filterTemplate, "--mun-grayscale": String(Math.max(0, Math.min(1, finite(value, 0)))) }; break
    case "hueRotation": style = { filter: filterTemplate, "--mun-hue-rotation": `${finite(value, 0)}deg` }; break
    case "colorInvert": style = { filter: filterTemplate, "--mun-color-invert": "1" }; break
    case "colorMultiply": style = { "--mun-color-multiply": String(value) }; break
    case "blendMode": style = { "mix-blend-mode": blendMode(value) }; break
    case "compositingGroup": style = { isolation: "isolate" }; break
    case "drawingGroup": style = { isolation: "isolate", contain: "paint", ...(value === true ? { background: "Canvas" } : {}) }; break
    case "luminanceToAlpha": style = { filter: `${filterTemplate} grayscale(1)`, "--mun-luminance-to-alpha": "1" }; break
    case "tint": style = value == null ? { "accent-color": "auto", "--mun-tint": "initial" } : { "accent-color": String(value), "--mun-tint": String(value) }; break
    case "backgroundStyle": style = { "--mun-background-style": String(value), background: String(value) }; break
    case "dynamicTypeSize": style = { "--mun-dynamic-type-size": String(value), "font-size": `var(--mun-dynamic-type-${String(value)}, inherit)` }; break
    case "hidden": style = { visibility: "hidden" }; break
    case "allowsHitTesting": style = value === false ? { "pointer-events": "none" } : { "pointer-events": "auto" }; break
    case "preferredColorScheme": style = value === "light" || value === "dark" ? { "color-scheme": String(value) } : { "color-scheme": "normal" }; break
    case "controlSize": style = { "--mun-control-size": String(value) }; break
    case "buttonStyle": style = { "--mun-button-style": String(value) }; break
    case "toggleStyle": style = { "--mun-toggle-style": String(value) }; break
    case "pickerStyle": style = { "--mun-picker-style": String(value) }; break
    case "textFieldStyle": style = { "--mun-text-field-style": String(value) }; break
    case "textEditorStyle": style = { "--mun-text-editor-style": String(value) }; break
    case "listStyle": style = { "--mun-list-style": String(value) }; break
    case "labelStyle": style = { "--mun-label-style": String(value) }; break
    case "progressViewStyle": style = { "--mun-progress-view-style": String(value) }; break
    case "scrollDisabled": style = value === true ? { overflow: "hidden" } : {}; break
    case "scrollIndicators": style = value === "hidden" ? { "scrollbar-width": "none", "--mun-scroll-indicators": "hidden" } : { "--mun-scroll-indicators": String(value) }; break
    case "scrollBounceBehavior": style = { "overscroll-behavior": value === "basedOnSize" ? "auto" : value === "always" ? "auto" : "none" }; break
    case "scrollClipDisabled": style = value === false ? {} : { overflow: "visible" }; break
    case "scrollDismissesKeyboard": style = { "--mun-scroll-dismisses-keyboard": String(value) }; break
    case "listRowInsets": style = Object.fromEntries(Object.entries(paddingStyle(value, modifier.arguments[1])).map(([key, item]) => [cssPropertyName(key), item])); break
    case "listRowBackground": style = typeof value === "string" ? { background: value } : {}; break
    case "listRowSeparator": style = value === "hidden" ? { "border-block-style": "none" } : value === "visible" ? { "border-block-style": "solid" } : {}; break
    case "listSectionSeparator": style = value === "hidden" ? { "border-block-style": "none" } : value === "visible" ? { "border-block-style": "solid" } : {}; break
    case "symbolRenderingMode": style = { "--mun-symbol-rendering-mode": value == null ? "automatic" : String(value) }; break
    case "symbolVariant": style = { "--mun-symbol-variant": String(value) }; break
    case "continuousCorners": {
      const smoothing = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : APPLE_CONTINUOUS_CORNER_SMOOTHING
      style = { "corner-shape": "squircle", "--mun-corner-style": "continuous", "--mun-corner-smoothing": String(smoothing), "--mun-corner-preserve-smoothing": "1" }
      break
    }
    case "frame": {
      style = Object.fromEntries(Object.entries(frameStyle(value && typeof value === "object" ? value : {}))
        .map(([key, item]) => [cssPropertyName(key), item ?? ""]))
      break
    }
    case "style": style = typeof value === "object" && value !== null
      ? normalizedStyle(value as Record<string, unknown>)
      : {}; break
    case "animation": {
      const animationStyle = includeAnimationFallback ? animationCSSStyle(value as Animation | null) : undefined
      style = animationStyle ? Object.fromEntries(Object.entries(animationStyle).map(([key, item]) => [cssPropertyName(key), item])) : {}
      break
    }
    default: style = {}
  }
  const transaction = currentRenderTransaction()
  if (includeAnimationFallback && swiftUIAnimatableModifierNames.has(modifier.name) && !transaction.disablesAnimations && transaction.animation) {
    const animationStyle = animationCSSStyle(transaction.animation)
    if (animationStyle) style = { ...style, ...Object.fromEntries(Object.entries(animationStyle).map(([key, item]) => [cssPropertyName(key), item])) }
  }
  return style
}

export function propsOf(modifier: ViewModifierNode): Record<string, unknown> {
  const [value] = modifier.arguments
  switch (modifier.name) {
    case "className": return { class: classNameOf(value) }
    case "withProps": return value && typeof value === "object" ? value as Record<string, unknown> : {}
    case "id": return { "data-mun-id": String(value) }
    case "disabled": return value === true ? { disabled: true, inert: true, "aria-disabled": true } : { disabled: false, inert: false, "aria-disabled": false }
    case "onTapGesture": {
      const count = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1
      const action = modifier.arguments[1]
      if (typeof action !== "function") return {}
      if (count === 1) return { onClick: action }
      if (count === 2) return { onDoubleClick: action }
      return { onClick(event: { detail?: number }) { if (event?.detail === count) action() } }
    }
    case "onLongPressGesture": {
      const duration = Math.max(0, finite(value, 0.5)) * 1000
      const distance = Math.max(0, finite(modifier.arguments[1], 10))
      const action = modifier.arguments[2]
      const changed = modifier.arguments[3]
      if (typeof action !== "function") return {}
      let timer: ReturnType<typeof setTimeout> | undefined
      let originX = 0; let originY = 0; let active = false
      const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; if (active && typeof changed === "function") changed(false); active = false }
      return {
        onPointerDown(event: { clientX?: number; clientY?: number }) {
          clear(); active = true; originX = finite(event?.clientX, 0); originY = finite(event?.clientY, 0); if (typeof changed === "function") changed(true)
          timer = setTimeout(() => { timer = undefined; action() }, duration)
        },
        onPointerMove(event: { clientX?: number; clientY?: number }) {
          if (!active) return
          const dx = finite(event?.clientX, originX) - originX; const dy = finite(event?.clientY, originY) - originY
          if (Math.hypot(dx, dy) > distance) clear()
        },
        onPointerUp: clear,
        onPointerCancel: clear,
        onPointerLeave: clear,
      }
    }
    case "onHover": return typeof value === "function" ? { onPointerEnter() { value(true) }, onPointerLeave() { value(false) } } : {}
    case "onSubmit": return typeof value === "function" ? { onSubmit(event: { preventDefault?: () => void }) { event?.preventDefault?.(); value() } } : {}
    case "focusable": {
      const changed = modifier.arguments[1]
      return value === false ? { tabIndex: -1 } : { tabIndex: 0, ...(typeof changed === "function" ? { onFocus() { changed(true) }, onBlur() { changed(false) } } : {}) }
    }
    case "draggable": return {
      draggable: true,
      onDragStart(event: { dataTransfer?: { setData?: (type: string, value: string) => void } }) {
        let serialized: string
        try { serialized = typeof value === "string" ? value : JSON.stringify(value) } catch { serialized = String(value) }
        event?.dataTransfer?.setData?.("application/x-mun+json", serialized)
        event?.dataTransfer?.setData?.("text/plain", serialized)
      },
    }
    case "dropDestination": {
      const action = modifier.arguments[1]
      const targeted = modifier.arguments[2]
      if (typeof action !== "function") return {}
      return {
        onDragEnter(event: { preventDefault?: () => void }) { event?.preventDefault?.(); if (typeof targeted === "function") targeted(true) },
        onDragOver(event: { preventDefault?: () => void }) { event?.preventDefault?.() },
        onDragLeave() { if (typeof targeted === "function") targeted(false) },
        onDrop(event: { preventDefault?: () => void; clientX?: number; clientY?: number; dataTransfer?: { getData?: (type: string) => string } }) {
          event?.preventDefault?.(); if (typeof targeted === "function") targeted(false)
          const raw = event?.dataTransfer?.getData?.("application/x-mun+json") || event?.dataTransfer?.getData?.("text/plain") || ""
          let item: unknown = raw
          try { item = JSON.parse(raw) } catch {}
          action([item], { x: finite(event?.clientX, 0), y: finite(event?.clientY, 0) })
        },
      }
    }
    case "scrollDismissesKeyboard": return value === "never" ? {} : { onScroll(event: { currentTarget?: { ownerDocument?: Document } }) { const active = event?.currentTarget?.ownerDocument?.activeElement as HTMLElement | null | undefined; active?.blur?.() } }
    case "accessibilityLabel": return { "aria-label": String(value) }
    case "accessibilityHint": return { "aria-description": String(value) }
    case "accessibilityValue": return { "aria-valuetext": String(value) }
    case "accessibilityHidden": return { "aria-hidden": Boolean(value) }
    case "accessibilityIdentifier": return { "data-accessibility-id": String(value) }
    case "accessibilityHeading": return { role: "heading", "aria-level": /^h([1-6])$/.test(String(value)) ? Number(String(value).slice(1)) : 2 }
    case "accessibilitySortPriority": return { "data-accessibility-sort-priority": String(finite(value, 0)) }
    case "accessibilityElement": return { role: value === "contain" ? "group" : undefined, "data-accessibility-children": String(value ?? "ignore") }
    case "accessibilityAction": return typeof modifier.arguments[1] === "function" ? { "data-accessibility-action": String(value), onClick: modifier.arguments[1] } : {}
    default: return {}
  }
}

export function styleText(value: Record<string, string>): string {
  return Object.entries(value).filter(([, item]) => item !== "undefined" && item !== "").map(([key, item]) => `${key}:${item}`).join(";")
}

export function cssPropertyName(value: string): string {
  return value.startsWith("--") ? value : value.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`)
}

function normalizedStyle(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) =>
    item === undefined || item === null ? [] : [[cssPropertyName(key), String(item)]],
  ))
}

export function styleAttribute(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return typeof value === "string" ? value : undefined
  return styleText(normalizedStyle(value as Record<string, unknown>))
}

export function nativeElementProps(props: Record<string, unknown>): Record<string, unknown> {
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

export function escapeAttribute(value: unknown): string {
  return escape(value).replaceAll("'", "&#39;")
}

export function normalizedTextAreaValue(value: unknown): string {
  return String(value).replace(/\r\n?/g, "\n")
}

export const rawTextHtmlElements = new Set(["script", "style"])

export function normalizedRawTextValue(tag: string, value: unknown): string {
  const lowerTag = tag.toLowerCase()
  const text = String(value).replace(/\r\n?/g, "\n").replaceAll("\0", "\uFFFD")
  if (new RegExp(`</${lowerTag}`, "i").test(text)) {
    throw new TypeError(`<${lowerTag}> text cannot contain its HTML closing-tag sequence`)
  }
  return text
}

export function domContentContainer(element: Element): Element | DocumentFragment {
  const candidate = element as Element & { readonly content?: DocumentFragment }
  return element.namespaceURI === "http://www.w3.org/1999/xhtml"
    && element.localName.toLowerCase() === "template"
    && candidate.content?.nodeType === 11
    ? candidate.content
    : element
}

export const validTableChildElements = new Set(["caption", "colgroup", "thead", "tbody", "tfoot", "script", "template"])

export const voidHtmlElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"])

export interface DomRenderContext {
  readonly document: Document
  readonly experimentalResidentCompute?: boolean
  readonly states: Map<string, { readonly host: unknown; readonly value: Record<string, unknown> }>
  readonly visitedStateIdentities: Set<string>
  readonly geometries: Map<number, GeometryProxy>
  readonly hydrationProps: WeakMap<Element, Record<string, unknown> | null | undefined>
  readonly domProps: WeakMap<Element, Record<string, unknown>>
  readonly eventListeners: WeakMap<Element, Map<string, EventListener>>
  eventTargetCount: number
  readonly domKeys: WeakMap<Node, string | number | undefined>
  /** Parents that have ever owned a keyed direct child in this mount. */
  readonly keyedParents: WeakSet<Node>
  hasDomKeys: boolean
  readonly domTags: WeakMap<Element, string>
  readonly lazyRanges: Map<string, LazyViewRange>
  readonly lazyMeasurements: Map<string, number>
  readonly lazySizeIndexes: Map<string, LazyMeasurementIndex>
  readonly lazyItemMetadata: WeakMap<Element, { readonly key: string; readonly index: number }>
  readonly lazyNodes: Map<string, LazyViewNode>
  readonly preservedLazyStatePrefixes: Map<string, Set<string>>
  readonly visitedLazyIdentities: Set<string>
  readonly lazyKeys: WeakMap<Node, string>
  geometryIndex: number
  hasRefs: boolean
  /** Elements whose currently remembered DOM props contain a non-null ref. */
  readonly refElements: Set<Element>
  hydrating: boolean
  /** Live SSR nodes tentatively reused by the speculative hydration pass. */
  hydrationLiveNodes?: WeakSet<Node>
  stagingEvents: boolean
  stagingProps: boolean
  activeTransaction?: Transaction
}
