import {
  Fragment,
  cloneVNode,
  createApp,
  customRef,
  defineComponent,
  getCurrentScope,
  h,
  createSSRApp,
  onBeforeUnmount,
  onMounted,
  onScopeDispose,
  shallowRef,
  watchEffect,
  withMemo,
  type Component as VueComponentType,
  type ComponentPublicInstance,
  type PropType,
  type Ref,
  type VNode,
  type VNodeChild,
} from "vue"
import {
  animationCSSStyle,
  Animation,
  Transaction,
  Binding,
  classNameOf,
  currentRenderTransaction,
  collectStateReads,
  defineView,
  ForeignComponent,
  frameStyle,
  initializer,
  isForeignComponent,
  isStateRef,
  layoutLength,
  renderViewNode,
  swiftUIAnimatableModifierNames,
  subscribeState,
  withRenderTransaction,
  viewIdentityKey,
  zeroGeometry,
  type CompiledTemplateValue,
  type GeometryProxy,
  type BindingRef,
  type ModifiableViewNode,
  type MunRenderer,
  type StateRef,
  type ViewGraphValue,
  type ViewHostNode,
  type ViewModifierNode,
  type ViewValue,
  viewElement,
} from "@mun/core/compat"
import { APPLE_CONTINUOUS_CORNER_SMOOTHING } from "@mun/core/corners"
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

import { geometryFromElement, sameGeometry } from "./geometry.js"

function runVueParticleFallback(canvas: HTMLCanvasElement, node: GPUIslandViewNode): () => void {
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

const VueGPUIslandCanvas = defineComponent({
  name: "MunGPUIslandCanvas",
  props: { node: { type: Object as PropType<GPUIslandViewNode>, required: true } },
  setup(props) {
    const canvas = shallowRef<HTMLCanvasElement | null>(null)
    let cleanup: (() => void) | undefined
    onMounted(() => {
      if (!canvas.value) return
      canvas.value.dataset.munGpuBackend = props.node.ir.fallback === "canvas" ? "cpu-canvas" : "static"
      cleanup = runVueParticleFallback(canvas.value, props.node)
    })
    onBeforeUnmount(() => cleanup?.())
    return () => h("canvas", {
      ref: canvas,
      width: props.node.options.width,
      height: props.node.options.height,
      class: props.node.options.class,
      style: props.node.options.style,
      "aria-label": props.node.options.ariaLabel,
      "data-mun-gpu-island": props.node.ir.id,
      "data-mun-gpu-kind": props.node.ir.kind,
      "data-mun-gpu-owner": "vue",
      "data-mun-gpu-readback": "forbidden",
      "data-mun-gpu-fallback": props.node.ir.fallback,
    })
  },
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
const finite = (value: unknown, fallback: number): number => typeof value === "number" && Number.isFinite(value) ? value : fallback
const filterTemplate = "blur(var(--mun-blur,0px)) brightness(var(--mun-brightness,1)) contrast(var(--mun-contrast,1)) saturate(var(--mun-saturation,1)) grayscale(var(--mun-grayscale,0)) hue-rotate(var(--mun-hue-rotation,0deg)) invert(var(--mun-color-invert,0))"
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
    onPointerdown(event: { clientX?: number; clientY?: number }) {
      clear()
      active = true
      originX = finite(event?.clientX, 0)
      originY = finite(event?.clientY, 0)
      if (typeof changed === "function") changed(true)
      timer = setTimeout(() => { timer = undefined; action() }, duration)
    },
    onPointermove(event: { clientX?: number; clientY?: number }) {
      if (!active) return
      if (Math.hypot(finite(event?.clientX, originX) - originX, finite(event?.clientY, originY) - originY) > distance) clear()
    },
    onPointerup: clear,
    onPointercancel: clear,
    onPointerleave: clear,
  }
}

const munVueSlots = Symbol.for("mun.vue.slots")

function sync(
  active: Map<StateRef<unknown>, () => void>,
  next: ReadonlySet<StateRef<unknown>>,
  invalidate: (transaction: Transaction, batch: StateMutationBatch, dependency: StateRef<unknown>) => void,
): void {
  for (const [state, stop] of active) {
    if (next.has(state)) continue
    stop()
    active.delete(state)
  }
  for (const state of next) {
    if (active.has(state)) continue
    active.set(state, subscribeState(state, (transaction, batch) => invalidate(transaction, batch, state)))
  }
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

function pruneCompilerOwnedDependencies(
  value: ViewGraphValue,
  dependencies: Set<StateRef<unknown>>,
  observedDependencies: ReadonlySet<StateRef<unknown>>,
): void {
  for (const dependency of collectCompilerOwnedCollectionStates(value)) {
    if (!observedDependencies.has(dependency)) dependencies.delete(dependency)
  }
}

export type MunVueSlot = ViewValue | ((props: any, ...args: any[]) => ViewValue)
export type VueComponentProps<C> = C extends abstract new (...args: any[]) => { $props: infer Props }
  ? Props
  : C extends (props: infer Props, ...args: any[]) => any ? Props : Record<string, unknown>
type VueComponentEmitProps<C> = C extends { emits?: infer Emits }
  ? Emits extends Record<string, unknown>
    ? { [Key in keyof Emits as Key extends string ? `on${Capitalize<Key>}` : never]?: Emits[Key] extends (...args: infer Args) => any ? (...args: Args) => any : (...args: any[]) => any }
    : {}
  : {}
type RequiredVuePropKeys<Props> = {
  [Key in keyof Props]-?: object extends Pick<Props, Key> ? never : Key
}[keyof Props]
type MunVueComponentProps<C> = Omit<VueComponentProps<C>, "slots"> & VueComponentEmitProps<C> & { readonly slots?: Record<string, MunVueSlot> }
type VueComponentArguments<C> = [RequiredVuePropKeys<VueComponentProps<C>>] extends [never]
  ? [props?: MunVueComponentProps<C> | null, ...children: ViewValue[]]
  : [props: MunVueComponentProps<C>, ...children: ViewValue[]]
export type VueComponentView<C extends object> = ((...args: VueComponentArguments<C>) => ModifiableViewNode) & {
  readonly component: C
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
    case "fontDesign": result = { style: { fontFamily: value === "serif" ? "ui-serif, Georgia, serif" : value === "rounded" ? "ui-rounded, system-ui, sans-serif" : value === "monospaced" ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined } }; break
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
    case "lineLimit": result = { style: typeof value === "number" && value > 0 ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: Math.floor(value), overflow: "hidden" } : {} }; break
    case "minimumScaleFactor": result = { style: { "--mun-minimum-scale-factor": Math.max(0, Math.min(1, finite(value, 1))) } }; break
    case "multilineTextAlignment": result = { style: { textAlign: value === "leading" ? "start" : value === "trailing" ? "end" : "center" } }; break
    case "truncationMode": result = { style: { textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", direction: value === "head" ? "rtl" : undefined } }; break
    case "textCase": result = { style: { textTransform: value === "uppercase" ? "uppercase" : value === "lowercase" ? "lowercase" : "none" } }; break
    case "allowsTightening": result = { style: { "--mun-allows-tightening": value === false ? 0 : 1 } }; break
    case "foreground":
    case "foregroundStyle": result = { style: { color: value } }; break
    case "background": result = { style: { background: value, backgroundPosition: alignmentCSSPosition(modifier.arguments[1]) } }; break
    case "opacity": {
      const opacity = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
      result = { style: { opacity } }; break
    }
    case "scaleEffect": {
      const scale = typeof value === "number" ? `${value}`
        : value && typeof value === "object" ? `${Number((value as { x?: unknown; width?: unknown }).x ?? (value as { width?: unknown }).width ?? 1)} ${Number((value as { y?: unknown; height?: unknown }).y ?? (value as { height?: unknown }).height ?? 1)}` : "1"
      result = { style: { scale, transformOrigin: alignmentCSSPosition(modifier.arguments[1]) } }; break
    }
    case "rotationEffect": result = { style: {
      rotate: `${typeof value === "number" && Number.isFinite(value) ? value : 0}deg`,
      transformOrigin: alignmentCSSPosition(modifier.arguments[1]),
    } }; break
    case "offset": {
      const second = modifier.arguments[1]
      let x = 0; let y = 0
      if (typeof value === "number") { x = value; y = typeof second === "number" ? second : 0 }
      else if (value && typeof value === "object") {
        const point = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
        x = Number(point.x ?? point.width ?? 0); y = Number(point.y ?? point.height ?? 0)
      }
      result = { style: { translate: `${Number.isFinite(x) ? x : 0}px ${Number.isFinite(y) ? y : 0}px` } }; break
    }
    case "aspectRatio": result = { style: { aspectRatio: typeof value === "number" ? value : undefined, objectFit: modifier.arguments[1] === "fill" ? "cover" : "contain" } }; break
    case "scaledToFit": result = { style: { objectFit: "contain", maxWidth: "100%", maxHeight: "100%" } }; break
    case "scaledToFill": result = { style: { objectFit: "cover", width: "100%", height: "100%" } }; break
    case "fixedSize": result = { style: { width: value !== false ? "max-content" : undefined, height: modifier.arguments[1] !== false ? "max-content" : undefined } }; break
    case "layoutPriority": result = { style: { flexShrink: finite(value, 0) > 0 ? 0 : 1, "--mun-layout-priority": finite(value, 0) } }; break
    case "position": result = { style: { position: "absolute", left: `${typeof value === "number" ? value : finite((value as { x?: unknown } | undefined)?.x, 0)}px`, top: `${typeof value === "number" ? finite(modifier.arguments[1], 0) : finite((value as { y?: unknown } | undefined)?.y, 0)}px`, transform: "translate(-50%, -50%)" } }; break
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
    case "mask": {
      const mask = modifier.props && typeof modifier.props === "object" && "style" in modifier.props ? (modifier.props as { style?: unknown }).style : undefined
      result = { style: mask && typeof mask === "object" ? Object.fromEntries(Object.entries(mask as Record<string, unknown>).map(([key, item]) => [key === "WebkitMask" ? "-webkit-mask" : key, item])) : {} }
      break
    }
    case "clipShape": result = { style: modifier.props && typeof modifier.props === "object" && "style" in modifier.props ? (modifier.props as { style?: unknown }).style : {} }; break
    case "clipped": result = { style: { overflow: "hidden" } }; break
    case "border": result = { style: { border: `${layoutLength(modifier.arguments[1] ?? 1) ?? "1px"} solid ${String(value)}` } }; break
    case "shadow": result = { style: { boxShadow: `${finite(modifier.arguments[2], 0)}px ${finite(modifier.arguments[3], 0)}px ${Math.max(0, finite(modifier.arguments[1], 0))}px ${String(value)}` } }; break
    case "blur": result = { style: { filter: filterTemplate, "--mun-blur": `${Math.max(0, finite(value, 0))}px` } }; break
    case "brightness": result = { style: { filter: filterTemplate, "--mun-brightness": Math.max(0, 1 + finite(value, 0)) } }; break
    case "contrast": result = { style: { filter: filterTemplate, "--mun-contrast": Math.max(0, finite(value, 1)) } }; break
    case "saturation": result = { style: { filter: filterTemplate, "--mun-saturation": Math.max(0, finite(value, 1)) } }; break
    case "grayscale": result = { style: { filter: filterTemplate, "--mun-grayscale": Math.max(0, Math.min(1, finite(value, 0))) } }; break
    case "hueRotation": result = { style: { filter: filterTemplate, "--mun-hue-rotation": `${finite(value, 0)}deg` } }; break
    case "colorInvert": result = { style: { filter: filterTemplate, "--mun-color-invert": 1 } }; break
    case "colorMultiply": result = { style: { "--mun-color-multiply": String(value) } }; break
    case "blendMode": result = { style: { mixBlendMode: value === "colorDodge" ? "color-dodge" : value === "colorBurn" ? "color-burn" : value === "softLight" ? "soft-light" : value === "hardLight" ? "hard-light" : value === "plusLighter" ? "plus-lighter" : value } }; break
    case "compositingGroup": result = { style: { isolation: "isolate" } }; break
    case "drawingGroup": result = { style: { isolation: "isolate", contain: "paint" } }; break
    case "luminanceToAlpha": result = { style: { filter: `${filterTemplate} grayscale(1)` } }; break
    case "tint": result = { style: { accentColor: value ?? "auto", "--mun-tint": value ?? "initial" } }; break
    case "backgroundStyle": result = { style: { background: String(value), "--mun-background-style": String(value) } }; break
    case "dynamicTypeSize": result = { style: { "--mun-dynamic-type-size": String(value) } }; break
    case "disabled": result = value === true ? { disabled: true, inert: true, "aria-disabled": true } : { disabled: false, inert: false, "aria-disabled": false }; break
    case "hidden": result = { style: { visibility: "hidden" } }; break
    case "allowsHitTesting": result = { style: { pointerEvents: value === false ? "none" : "auto" } }; break
    case "onTapGesture": {
      const count = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1
      const action = modifier.arguments[1]
      result = typeof action !== "function" ? {} : count === 1 ? { onClick: action } : count === 2 ? { onDblclick: action } : { onClick(event: { detail?: number }) { if (event?.detail === count) action() } }
      break
    }
    case "onLongPressGesture": result = longPressProps(modifier); break
    case "onHover": result = typeof value === "function" ? { onPointerenter: () => value(true), onPointerleave: () => value(false) } : {}; break
    case "preferredColorScheme": result = { style: { colorScheme: value === "light" || value === "dark" ? value : "normal" } }; break
    case "controlSize": result = { style: { "--mun-control-size": String(value) } }; break
    case "buttonStyle": result = { style: { "--mun-button-style": String(value) } }; break
    case "toggleStyle": result = { style: { "--mun-toggle-style": String(value) } }; break
    case "pickerStyle": result = { style: { "--mun-picker-style": String(value) } }; break
    case "textFieldStyle": result = { style: { "--mun-text-field-style": String(value) } }; break
    case "textEditorStyle": result = { style: { "--mun-text-editor-style": String(value) } }; break
    case "listStyle": result = { style: { "--mun-list-style": String(value) } }; break
    case "labelStyle": result = { style: { "--mun-label-style": String(value) } }; break
    case "progressViewStyle": result = { style: { "--mun-progress-view-style": String(value) } }; break
    case "scrollDisabled": result = { style: value === true ? { overflow: "hidden" } : {} }; break
    case "scrollIndicators": result = { style: value === "hidden" ? { scrollbarWidth: "none" } : {} }; break
    case "scrollBounceBehavior": result = { style: { overscrollBehavior: value === "always" || value === "basedOnSize" ? "auto" : "none" } }; break
    case "scrollClipDisabled": result = { style: value === false ? {} : { overflow: "visible" } }; break
    case "listRowInsets": result = { style: paddingStyle(value, modifier.arguments[1]) }; break
    case "listRowBackground": result = { style: typeof value === "string" ? { background: value } : {} }; break
    case "listRowSeparator":
    case "listSectionSeparator": result = { style: value === "hidden" ? { borderBlockStyle: "none" } : value === "visible" ? { borderBlockStyle: "solid" } : {} }; break
    case "symbolRenderingMode": result = { style: { "--mun-symbol-rendering-mode": value == null ? "automatic" : String(value) } }; break
    case "symbolVariant": result = { style: { "--mun-symbol-variant": String(value) } }; break
    case "id": result = { "data-mun-id": String(value), key: value }; break
    case "onSubmit": result = typeof value === "function" ? { onSubmit: (event: { preventDefault?: () => void }) => { event.preventDefault?.(); value() } } : {}; break
    case "focusable": result = value === false ? { tabindex: -1 } : { tabindex: 0, ...(typeof modifier.arguments[1] === "function" ? { onFocus: () => (modifier.arguments[1] as (focused: boolean) => void)(true), onBlur: () => (modifier.arguments[1] as (focused: boolean) => void)(false) } : {}) }; break
    case "draggable": result = { draggable: true, onDragstart: (event: { dataTransfer?: { setData?: (type: string, value: string) => void } }) => { let serialized = String(value); try { serialized = typeof value === "string" ? value : JSON.stringify(value) } catch {}; event.dataTransfer?.setData?.("application/x-mun+json", serialized) } }; break
    case "dropDestination": {
      const action = modifier.arguments[1]; const targeted = modifier.arguments[2]
      result = typeof action === "function" ? { onDragenter: (event: { preventDefault?: () => void }) => { event.preventDefault?.(); if (typeof targeted === "function") targeted(true) }, onDragover: (event: { preventDefault?: () => void }) => event.preventDefault?.(), onDragleave: () => { if (typeof targeted === "function") targeted(false) }, onDrop: (event: { preventDefault?: () => void; clientX?: number; clientY?: number; dataTransfer?: { getData?: (type: string) => string } }) => { event.preventDefault?.(); if (typeof targeted === "function") targeted(false); const raw = event.dataTransfer?.getData?.("application/x-mun+json") ?? ""; let item: unknown = raw; try { item = JSON.parse(raw) } catch {}; action([item], { x: finite(event.clientX, 0), y: finite(event.clientY, 0) }) } } : {}; break
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
    case "style": result = value && typeof value === "object" ? { style: value } : {}; break
    case "className": result = { class: classNameOf(value) }; break
    case "withProps": result = value && typeof value === "object" ? value as Record<string, unknown> : {}; break
    case "keyed": result = { key: value }; break
    case "elementRef": result = { ref: value }; break
    case "frame": result = { style: frameStyle(value && typeof value === "object" ? value : {}) }; break
    case "animation": {
      // `.animation()` deliberately has no Animation argument: the renderer
      // selects the default policy and animates only values that actually
      // change. Treating `undefined` as disabled made every zero-argument
      // animation silently become a 0 ms patch in the Vue host.
      const transaction = currentRenderTransaction()
      const selected = modifier.arguments.length === 0 ? Animation.default : value as Animation | null
      result = { style: transaction.disablesAnimations ? {} : animationCSSStyle(selected) ?? {} }
      break
    }
    case "animationAuto": {
      const properties = Array.isArray(value)
        ? value.filter((property): property is string => typeof property === "string")
        : []
      const style = currentRenderTransaction().disablesAnimations ? undefined : animationCSSStyle(Animation.default)
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

function mergeProps(current: Record<string, unknown> | null | undefined, extra: Record<string, unknown>): Record<string, unknown> {
  const currentStyle: Record<string, unknown> = current?.style && typeof current.style === "object" ? current.style as Record<string, unknown> : {}
  const extraStyle: Record<string, unknown> | undefined = extra.style && typeof extra.style === "object" ? extra.style as Record<string, unknown> : undefined
  const style: Record<string, unknown> = extraStyle ? { ...currentStyle, ...extraStyle } : currentStyle
  if (extraStyle && typeof extraStyle.transform === "string" && typeof currentStyle.transform === "string") {
    style.transform = `${currentStyle.transform} ${extraStyle.transform}`
  }
  return {
    ...(current ?? {}),
    ...extra,
    ...(extraStyle ? { style } : {}),
  }
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

function renderVueElement(type: unknown, props: Record<string, unknown> | null, children: VNodeChild[]): VNode {
  const rawSlots = (props as Record<PropertyKey, unknown> | null)?.[munVueSlots] as Record<string, MunVueSlot> | undefined
  if (typeof type === "string" && !rawSlots) {
    let needsNormalization = false
    for (const key of Object.keys(props ?? {})) {
      const value = props![key]
      if (key === "style" || key === "class" || (typeof value === "function" && /^on[a-z]/.test(key))
        || (key === "style" && value && typeof value === "object"
          && (value as Record<string, unknown>)["--mun-corner-style"] === "continuous")) {
        needsNormalization = true
        break
      }
    }
    if (!needsNormalization) return h(type, props, children)
  }
  let normalizedProps = props ? { ...props } : null
  if (normalizedProps) delete (normalizedProps as Record<PropertyKey, unknown>)[munVueSlots]
  if (normalizedProps) {
    for (const [key, value] of Object.entries(normalizedProps)) {
      if (typeof value === "function" && /^on[a-z]/.test(key)) {
        delete normalizedProps[key]
        normalizedProps[`on${key[2].toUpperCase()}${key.slice(3)}`] = value
      }
    }
  }
  const foreign = isForeignComponent(type) ? type : undefined
  if (foreign) {
    normalizedProps = { ...foreign.props, ...foreign.events, ...(normalizedProps ?? {}) }
    if (foreign.ref !== undefined) normalizedProps.ref = foreign.ref
    if (foreign.key !== undefined) normalizedProps.key = foreign.key
  }
  const style = normalizedProps?.style
  if (style && typeof style === "object" && (style as Record<string, unknown>)["--mun-corner-style"] === "continuous") {
    const previousRef = normalizedProps!.ref
    normalizedProps!.ref = (value: unknown) => {
      if (typeof previousRef === "function") previousRef(value)
      else if (previousRef && typeof previousRef === "object" && "value" in previousRef) (previousRef as { value: unknown }).value = value
      void import("./continuous-corners.js").then(({ attachContinuousCornerRef }) => attachContinuousCornerRef(value))
    }
  }
  if (typeof type === "string") return h(type, normalizedProps, children)
  const slots = foreign?.slots
    ? {
        ...Object.fromEntries(Object.entries(foreign.slots).map(([name, slot]) => [name, (...args: unknown[]) => render(typeof slot === "function" ? slot(...args) : slot)])),
        ...(children.length > 0 && !foreign.slots.default ? { default: () => children } : {}),
      }
    : rawSlots
    ? {
        ...Object.fromEntries(Object.entries(rawSlots).map(([name, slot]) => [name, (...args: unknown[]) => render(typeof slot === "function" ? slot(...(args as [any, ...any[]])) : slot)])),
        ...(children.length > 0 && !rawSlots.default ? { default: () => children } : {}),
      }
    : children.length > 0 ? { default: () => children } : undefined
  return h((foreign?.component ?? type) as VueComponentType, normalizedProps, slots)
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

function directCollectionText(value: unknown): { readonly ok: true; readonly value: VNodeChild } | { readonly ok: false } {
  if (value === null || value === undefined || typeof value === "boolean") return { ok: true, value: null }
  if (typeof value === "string" || typeof value === "number") return { ok: true, value }
  if (typeof value === "bigint") return { ok: true, value: String(value) }
  return { ok: false }
}

function renderDirectCollectionRow(node: KeyedCollectionViewNode, item: unknown, index: number, key: string): VNodeChild | undefined {
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
  return renderVueElement(type, props === null ? { key } : { ...props, key }, [text.value])
}

function renderDirectCollectionEntry(node: KeyedCollectionViewNode, entry: KeyedCollectionEntry): VNodeChild | undefined {
  return renderDirectCollectionRow(node, entry.item, entry.index, entry.key)
}

interface VueCollectionMutationEffects {
  readonly forceAll: boolean
  readonly touchedItems: ReadonlySet<object>
}

function vueCollectionItems(
  node: KeyedCollectionViewNode,
  previous: readonly unknown[] | undefined,
  notifications: readonly { readonly dependency: StateRef<unknown>; readonly batch: StateMutationBatch }[],
): readonly unknown[] {
  if (!node.readItems) return node.items
  const source = isStateRef(node.source) ? node.source : undefined
  if (!previous || !source) return node.readItems()
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
          if (Number.isSafeInteger(index) && index >= 0 && index < 0xffff_ffff && String(index) === mutation.property) {
            mutable()[index] = mutation.value
          }
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

function vueCollectionMutationEffects(
  node: KeyedCollectionViewNode,
  items: readonly unknown[],
  notifications: readonly { readonly dependency: StateRef<unknown>; readonly batch: StateMutationBatch }[],
): VueCollectionMutationEffects {
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
    if (!itemIdentities.has(target)) return { forceAll: true, touchedItems: candidateTargets }
  }
  return { forceAll: false, touchedItems: candidateTargets }
}

interface VueCompiledCollectionMemo {
  readonly cache: VNode[]
  readonly slots: Map<string, number>
  readonly freeSlots: number[]
  readonly directKeys: Set<string>
  readonly versions: Map<string, number>
}

interface VueCompiledCollectionRow {
  readonly key: string
  readonly baseKey: string
  readonly occurrence: number
  readonly itemIdentity: unknown
  readonly index: number
  readonly plan: NonNullable<KeyedCollectionViewNode["compiled"]>
}

function memoSlotForKey(memo: VueCompiledCollectionMemo, key: string): number {
  const existing = memo.slots.get(key)
  if (existing !== undefined) return existing
  const slot = memo.freeSlots.pop() ?? memo.cache.length
  memo.slots.set(key, slot)
  return slot
}

function clearCompiledCollectionMemo(memo: VueCompiledCollectionMemo): void {
  memo.cache.length = 0
  memo.slots.clear()
  memo.freeSlots.length = 0
  memo.directKeys.clear()
  memo.versions.clear()
}

function renderCompiledCollectionRows(
  node: KeyedCollectionViewNode,
  renderEntry: (entry: KeyedCollectionEntry) => VNodeChild,
  memo: VueCompiledCollectionMemo,
  notifications: readonly { readonly dependency: StateRef<unknown>; readonly batch: StateMutationBatch }[],
  items: readonly unknown[],
): { readonly children: VNodeChild[]; readonly rows: Array<VueCompiledCollectionRow | undefined> } | undefined {
  const plan = node.compiled
  if (plan?.kind !== "flat-text-host") return undefined
  const effects = vueCollectionMutationEffects(node, items, notifications)
  const occurrences = new Map<string, number>()
  const children = new Array<VNodeChild>(items.length)
  const rows = new Array<VueCompiledCollectionRow | undefined>(items.length)
  const activeKeys = new Set<string>()
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
    activeKeys.add(key)
    const identity = reactiveIdentity(item)
    const touched = identity && typeof identity === "object" && effects.touchedItems.has(identity)
    if (effects.forceAll || touched) memo.versions.set(key, (memo.versions.get(key) ?? 0) + 1)
    const signature = [plan, identity, plan.indexIndependent ? 0 : index, memo.versions.get(key) ?? 0]
    if (memo.directKeys.has(key)) {
      const slot = memoSlotForKey(memo, key)
      let fallback: VNodeChild | undefined
      const direct = withMemo(signature, () => {
        const next = renderDirectCollectionRow(node, item, index, key)
        if (next && typeof next === "object" && "__v_isVNode" in next) return next as VNode
        const entry: KeyedCollectionEntry = {
          key,
          baseKey: resolved.identity,
          displayKey: resolved.display,
          occurrence,
          item,
          index,
        }
        fallback = h(Fragment, { key }, [renderEntry(entry)])
        return fallback as VNode
      }, memo.cache, slot)
      if (fallback !== undefined) {
        memo.directKeys.delete(key)
        memo.slots.delete(key)
        memo.versions.delete(key)
        memo.cache[slot] = undefined as unknown as VNode
        memo.freeSlots.push(slot)
        children[index] = fallback
      } else {
        children[index] = direct
        rows[index] = { key, baseKey: resolved.identity, occurrence, itemIdentity: identity, index, plan }
      }
      continue
    }
    const direct = renderDirectCollectionRow(node, item, index, key)
    if (direct && typeof direct === "object" && "__v_isVNode" in direct) {
      const slot = memoSlotForKey(memo, key)
      memo.directKeys.add(key)
      children[index] = withMemo(signature, () => direct as VNode, memo.cache, slot)
      rows[index] = { key, baseKey: resolved.identity, occurrence, itemIdentity: identity, index, plan }
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
    children[index] = h(Fragment, { key }, [renderEntry(entry)])
  }
  for (const [key, slot] of [...memo.slots]) {
    if (activeKeys.has(key)) continue
    memo.slots.delete(key)
    memo.directKeys.delete(key)
    memo.versions.delete(key)
    memo.cache[slot] = undefined as unknown as VNode
    memo.freeSlots.push(slot)
  }
  return { children, rows }
}

function localizedVueCollectionIndex(
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

function renderLocalizedVueCollectionRow(
  node: KeyedCollectionViewNode,
  memo: VueCompiledCollectionMemo,
  previousRows: readonly (VueCompiledCollectionRow | undefined)[],
  previousChildren: readonly VNodeChild[],
  items: readonly unknown[],
  index: number,
): { readonly children: VNodeChild[]; readonly rows: Array<VueCompiledCollectionRow | undefined> } | undefined {
  const plan = node.compiled
  const previous = previousRows[index]
  if (plan?.kind !== "flat-text-host" || !previous || previous.plan !== plan || !memo.directKeys.has(previous.key)
    || previousRows.length !== items.length || previousChildren.length !== items.length) return undefined
  const item = items[index]
  const resolved = node.key(item, index)
  if (!resolved || resolved.identity !== previous.baseKey) return undefined
  const direct = renderDirectCollectionRow(node, item, index, previous.key)
  if (!direct || typeof direct !== "object" || !("__v_isVNode" in direct)) return undefined
  const itemIdentity = reactiveIdentity(item)
  const version = (memo.versions.get(previous.key) ?? 0) + 1
  memo.versions.set(previous.key, version)
  const signature = [plan, itemIdentity, plan.indexIndependent ? 0 : index, version]
  const slot = memoSlotForKey(memo, previous.key)
  const vnode = withMemo(signature, () => direct as VNode, memo.cache, slot)
  const children = previousChildren.slice()
  const rows = previousRows.slice()
  children[index] = vnode
  rows[index] = {
    key: previous.key,
    baseKey: previous.baseKey,
    occurrence: previous.occurrence,
    itemIdentity,
    index,
    plan,
  }
  return { children, rows }
}

function isStableVueCompiledReplacement(
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

function renderStableVueCompiledReplacementRows(
  node: KeyedCollectionViewNode,
  memo: VueCompiledCollectionMemo,
  previousRows: readonly (VueCompiledCollectionRow | undefined)[],
  items: readonly unknown[],
): { readonly children: VNodeChild[]; readonly rows: Array<VueCompiledCollectionRow | undefined> } | undefined {
  const plan = node.compiled
  if (plan?.kind !== "flat-text-host" || previousRows.length !== items.length) return undefined
  const children = new Array<VNodeChild>(items.length)
  const rows = new Array<VueCompiledCollectionRow | undefined>(items.length)
  for (let index = 0; index < items.length; index += 1) {
    const previous = previousRows[index]
    if (!previous || previous.plan !== plan || previous.index !== index || !memo.directKeys.has(previous.key)) return undefined
    const item = items[index]
    const resolved = node.key(item, index)
    if (!resolved || resolved.identity !== previous.baseKey) return undefined
    if (previous.occurrence > 0) node.onDuplicateKey?.(resolved.display, previous.occurrence)
    const direct = renderDirectCollectionRow(node, item, index, previous.key)
    if (!direct || typeof direct !== "object" || !("__v_isVNode" in direct)) return undefined
    const itemIdentity = reactiveIdentity(item)
    const signature = [plan, itemIdentity, plan.indexIndependent ? 0 : index, memo.versions.get(previous.key) ?? 0]
    const slot = memoSlotForKey(memo, previous.key)
    children[index] = withMemo(signature, () => direct as VNode, memo.cache, slot)
    rows[index] = {
      key: previous.key,
      baseKey: previous.baseKey,
      occurrence: previous.occurrence,
      itemIdentity,
      index,
      plan,
    }
  }
  return { children, rows }
}

const MunCollectionHost = defineComponent({
  name: "MunCollectionHost",
  props: {
    node: { type: Object as PropType<KeyedCollectionViewNode>, required: true },
    renderEntry: { type: Function as PropType<(entry: KeyedCollectionEntry) => VNodeChild>, required: true },
  },
  setup(props) {
    const value = shallowRef<VNodeChild>(null)
    const version = shallowRef(0)
    const transaction = shallowRef<Transaction | undefined>(undefined)
    const subscriptions = new Map<StateRef<unknown>, () => void>()
    const pendingNotifications: Array<{ readonly dependency: StateRef<unknown>; readonly batch: StateMutationBatch }> = []
    const compiledMemo: VueCompiledCollectionMemo = {
      cache: [],
      slots: new Map(),
      freeSlots: [],
      directKeys: new Set(),
      versions: new Map(),
    }
    let compiledItems: readonly unknown[] | undefined
    let compiledRows: Array<VueCompiledCollectionRow | undefined> = []
    let compiledChildren: VNodeChild[] = []
    let pendingTransaction: Transaction | undefined
    watchEffect(() => {
      void version.value
      const dependencies = new Set<StateRef<unknown>>()
      transaction.value = pendingTransaction
      const notifications = pendingNotifications.splice(0, pendingNotifications.length)
      value.value = withRenderTransaction(pendingTransaction, () => collectStateReads(() => {
        const nextItems = props.node.compiled?.kind === "flat-text-host"
          ? vueCollectionItems(props.node, compiledItems, notifications)
          : undefined
        const stableReplacement = nextItems && isStableVueCompiledReplacement(props.node, notifications, nextItems.length)
          ? renderStableVueCompiledReplacementRows(props.node, compiledMemo, compiledRows, nextItems)
          : undefined
        const localIndex = nextItems ? localizedVueCollectionIndex(props.node, notifications, nextItems.length) : undefined
        const localized = nextItems && localIndex !== undefined
          ? renderLocalizedVueCollectionRow(props.node, compiledMemo, compiledRows, compiledChildren, nextItems, localIndex)
          : undefined
        const compiled = stableReplacement ?? localized ?? (nextItems
          ? renderCompiledCollectionRows(props.node, props.renderEntry, compiledMemo, notifications, nextItems)
          : undefined)
        if (!compiled) {
          clearCompiledCollectionMemo(compiledMemo)
          compiledItems = undefined
          compiledRows = []
          compiledChildren = []
        } else {
          compiledItems = nextItems
          compiledRows = compiled.rows
          compiledChildren = compiled.children
        }
        return h(
          Fragment,
          null,
          compiled?.children ?? keyedCollectionEntries(props.node).map(entry => {
          const direct = renderDirectCollectionEntry(props.node, entry)
          return direct ?? h(Fragment, { key: entry.key }, [props.renderEntry(entry)])
          }),
        )
      }, dependency => dependencies.add(dependency)))
      pendingTransaction = undefined
      sync(subscriptions, dependencies, (nextTransaction, batch, dependency) => {
        pendingNotifications.push({ dependency, batch })
        pendingTransaction = nextTransaction
        version.value += 1
      })
    })
    onScopeDispose(() => subscriptions.forEach(stop => stop()))
    return () => withRenderTransaction(transaction.value, () => value.value)
  },
})

type VueTemplateFactory = (renderSlot: (index: number) => VNodeChild) => VNodeChild
const vueTemplateFactories = new WeakMap<object, VueTemplateFactory>()

function compileVueTemplate(value: CompiledTemplateValue): VueTemplateFactory {
  if (value !== null && typeof value === "object") {
    if (value.kind === "slot") {
      const index = value.index
      return renderSlot => renderSlot(index)
    }
    if (value.kind === "fragment") {
      const children = value.children.map(compileVueTemplate)
      return renderSlot => h(Fragment, null, children.map(child => child(renderSlot)))
    }
    if (value.kind === "element") {
      const type = value.type
      const props = value.props
      const children = value.children.map(compileVueTemplate)
      return renderSlot => renderVueElement(type, props, children.map(child => child(renderSlot)))
    }
  }
  const staticValue = value === null || value === undefined || value === false || value === true ? null : value as VNodeChild
  return () => staticValue
}

const renderer: MunRenderer<VNodeChild> = {
  element(type, props, ...children) {
    return renderVueElement(type, props, children)
  },
  fragment(children) {
    return h(Fragment, null, children)
  },
  value(value) {
    return value === null || value === undefined || value === false ? null : value as VNodeChild
  },
  gpuIsland(node, identity) {
    return h(VueGPUIslandCanvas, { key: viewIdentityKey(identity), node })
  },
  template(node, renderSlot) {
    let factory = vueTemplateFactories.get(node.template)
    if (!factory) {
      factory = compileVueTemplate(node.template.root)
      vueTemplateFactories.set(node.template, factory)
    }
    return factory(renderSlot)
  },
  collection(node, renderEntry, identity) {
    return h(MunCollectionHost, { key: viewIdentityKey(identity), node, renderEntry })
  },
  modifier(content, modifier, renderArgument) {
    if (modifier.name === "frame") {
      return h("div", modifierProps(modifier), [content])
    }
    if ((modifier.name === "background" || modifier.name === "overlay" || modifier.name === "listRowBackground") && typeof modifier.arguments[0] !== "string" && modifier.arguments[0] != null && renderArgument) {
      const layer = h("div", { style: { gridArea: "1 / 1", placeSelf: alignmentCSSPlace(modifier.arguments[1]), pointerEvents: modifier.name === "background" ? "none" : undefined } }, [renderArgument(0)])
      const body = h("div", { style: { gridArea: "1 / 1", minWidth: 0, minHeight: 0 } }, [content])
      return h("div", { style: { display: "grid", position: "relative" } }, modifier.name !== "overlay" ? [layer, body] : [body, layer])
    }
    const extra = modifierProps(modifier)
    if (content && typeof content === "object" && "type" in content) {
      const vnode = content as VNode
      const merged = mergeProps(vnode.props as Record<string, unknown> | null | undefined, extra)
      return cloneVNode(vnode, typeof vnode.type === "string" && !vnode.type.includes("-") ? nativeElementProps(merged) : merged)
    }
    return h(Fragment, extra, [content])
  },
  view(node, _render, identity) {
    return h(MunViewHost, { key: viewIdentityKey(identity), node })
  },
  geometry(_node, render) {
    return h(GeometryMunValue, { render })
  },
}

const ReactiveMunValue = defineComponent({
  name: "ReactiveMunValue",
  props: {
    factory: { type: Function as PropType<() => ViewGraphValue>, required: true },
    dependencies: { type: Function as PropType<() => readonly StateRef<unknown>[]>, required: false },
    dependenciesComplete: { type: Boolean, required: false, default: false },
    disablesAnimations: { type: Boolean, required: false, default: false },
  },
  setup(props) {
    const value = shallowRef<ViewGraphValue>(null)
    const version = shallowRef(0)
    const transaction = shallowRef<Transaction | undefined>(undefined)
    const subscriptions = new Map<StateRef<unknown>, () => void>()
    let pendingTransaction: Transaction | undefined
    const renderTransaction = (transaction: Transaction | undefined): Transaction | undefined => {
      if (!props.disablesAnimations) return transaction
      return new Transaction({
        animation: transaction?.animation ?? null,
        disablesAnimations: true,
        isContinuous: transaction?.isContinuous ?? false,
      })
    }
    const invalidate = (nextTransaction: Transaction) => {
      pendingTransaction = nextTransaction
      version.value += 1
    }
    watchEffect(() => {
      void version.value
      const declaredDependencies = props.dependencies?.()
      const dependencies = new Set<StateRef<unknown>>(declaredDependencies ?? [])
      const observedDependencies = new Set<StateRef<unknown>>()
      transaction.value = renderTransaction(pendingTransaction)
      value.value = withRenderTransaction(transaction.value, () => collectStateReads(props.factory, dependency => {
        observedDependencies.add(dependency)
        if (!(declaredDependencies && props.dependenciesComplete)) dependencies.add(dependency)
      }))
      pruneCompilerOwnedDependencies(value.value, dependencies, observedDependencies)
      pendingTransaction = undefined
      sync(subscriptions, dependencies, invalidate)
    })
    onScopeDispose(() => subscriptions.forEach(stop => stop()))
    return () => withRenderTransaction(transaction.value, () => renderViewNode(value.value, renderer))
  },
})

const GeometryMunValue = defineComponent({
  name: "MunGeometryReader",
  props: {
    render: { type: Function as PropType<(geometry: GeometryProxy) => VNodeChild>, required: true },
  },
  setup(props) {
    const host = shallowRef<Element | null>(null)
    const geometry = shallowRef<GeometryProxy>(zeroGeometry)
    const value = shallowRef<VNodeChild>(null)
    const version = shallowRef(0)
    let pendingTransaction: Transaction | undefined
    let disconnect = () => undefined
    const subscriptions = new Map<StateRef<unknown>, () => void>()
    watchEffect(() => {
      void version.value
      const dependencies = new Set<StateRef<unknown>>()
      value.value = withRenderTransaction(pendingTransaction, () => collectStateReads(() => props.render(geometry.value), dependency => dependencies.add(dependency)))
      pendingTransaction = undefined
      sync(subscriptions, dependencies, transaction => { pendingTransaction = transaction; version.value += 1 })
    })
    onScopeDispose(() => subscriptions.forEach(stop => stop()))
    onMounted(() => {
      const element = host.value
      if (!element) return
      const update = () => {
        const next = geometryFromElement(element)
        if (!sameGeometry(geometry.value, next)) geometry.value = next
      }
      update()
      let observer: ResizeObserver | undefined
      try {
        observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update)
        observer?.observe(element)
      } catch {
        try { observer?.disconnect() } catch {}
        observer = undefined
      }
      const view = element.ownerDocument.defaultView
      try { view?.addEventListener("resize", update) } catch {}
      disconnect = () => {
        try { observer?.disconnect() } catch {}
        try { view?.removeEventListener("resize", update) } catch {}
      }
    })
    onBeforeUnmount(() => disconnect())
    return () => h("div", { ref: host, "data-mun": "GeometryReader", style: { boxSizing: "border-box", width: "100%" } }, value.value === null ? undefined : [value.value])
  },
})

const MunViewHost = defineComponent({
  name: "MunViewHost",
  props: {
    node: { type: Object as PropType<ViewHostNode>, required: true },
  },
  setup(props) {
    const state = props.node.state?.(props.node.props) ?? {}
    return () => {
      const resolvedProps = { ...props.node.props, ...state }
      return h(ReactiveMunValue, {
        factory: () => props.node.render(resolvedProps),
        ...(props.node.dependencies ? { dependencies: () => props.node.dependencies!(resolvedProps) } : {}),
        ...(props.node.dependenciesComplete ? { dependenciesComplete: true } : {}),
      })
    }
  },
})

/** Render any renderer-independent Mün ViewGraph value as Vue VNodes. */
export function render(value: ViewGraphValue): VNodeChild {
  return renderViewNode(value, renderer)
}

export interface MunViewProps {
  readonly value?: ViewGraphValue
  readonly render?: () => ViewGraphValue
  readonly disablesAnimations?: boolean
}

/** Component for direct use from a Vue SFC template. */
export const MunView = defineComponent({
  name: "MunView",
  props: {
    value: { type: null as unknown as PropType<ViewGraphValue>, required: false },
    render: { type: Function as PropType<() => ViewGraphValue>, required: false },
    disablesAnimations: { type: Boolean, required: false, default: false },
  },
  setup(props) {
    return () => h(ReactiveMunValue, {
      factory: () => props.render ? props.render() : props.value ?? null,
      disablesAnimations: props.disablesAnimations,
    })
  },
})

/** Wrap a graph factory as a Vue component, retaining Vue props at the bridge. */
export function createVueView<Props extends Record<string, unknown> = Record<string, unknown>>(
  body: (props: Props) => ViewGraphValue,
): VueComponentType<Props> {
  return defineComponent({
    name: "MunViewAdapter",
    setup(_props, { attrs }) {
      return () => h(ReactiveMunValue, { factory: () => body(attrs as Props) })
    },
  }) as VueComponentType<Props>
}

function isComponentPropsRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  try {
    return !Array.isArray(value)
  } catch {
    return false
  }
}

function snapshotComponentProps(value: unknown): {
  readonly props: Record<string, unknown>
  readonly slots?: Record<string, MunVueSlot>
} {
  if (!isComponentPropsRecord(value)) return { props: {} }
  try {
    const props: Record<PropertyKey, unknown> = {}
    let slots: Record<string, MunVueSlot> | undefined
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) continue
      if (key === "slots") {
        if (isComponentPropsRecord(descriptor.value)) slots = descriptor.value as Record<string, MunVueSlot>
        continue
      }
      Object.defineProperty(props, key, { ...descriptor, configurable: true })
    }
    return { props: props as Record<string, unknown>, ...(slots ? { slots } : {}) }
  } catch {
    return { props: {} }
  }
}

/** Place a Vue component or native HTML element in the same Mün graph. */
export function Component<C extends object>(type: C, props: Omit<MunVueComponentProps<NoInfer<C>>, "slots"> & { readonly slots?: Record<string, any> }, ...children: ViewValue[]): ModifiableViewNode
export function Component<C extends object>(type: C, ...args: VueComponentArguments<NoInfer<C>>): ModifiableViewNode
export function Component(type: string, props?: Record<string, unknown> | null, ...children: ViewValue[]): ModifiableViewNode
export function Component(
  type: VueComponentType | string,
  props: (Record<string, unknown> & { readonly slots?: Record<string, MunVueSlot> }) | null = null,
  ...children: ViewValue[]
): ModifiableViewNode {
  if (typeof type === "string") return viewElement(type, props, children)
  const snapshot = snapshotComponentProps(props)
  return ForeignComponent(type, snapshot, ...children)
}

/** Adapt a Vue component definition into a Mun-callable, preserving its Vue prop surface. */
export function vueComponent<C extends object>(type: C): VueComponentView<C> {
  const name = typeof type === "function" && (type as { name?: string }).name ? (type as { name: string }).name : "VueComponent"
  const View = defineView(name, {
    initializers: [initializer(
      "VueComponent(props?)",
      args => args.length <= 1 && (args.length === 0 || isComponentPropsRecord(args[0])),
      args => ({ props: args[0] ?? null }),
    )],
    intrinsic: true,
    body: ({ props }: { readonly props: Record<string, unknown> | null }) => Component(type, (props ?? {}) as MunVueComponentProps<C>),
  }) as unknown as VueComponentView<C>
  Object.defineProperty(View, "component", { configurable: false, enumerable: false, value: type })
  return View
}

/** Generic foreign-component callable layer; Vue is the first host implementation. */
export function foreignComponent<C extends object>(type: C): VueComponentView<C> {
  return vueComponent(type)
}

/** Bridge Mun State to a Vue Ref without making State a Vue primitive. */
export function toVueRef<T>(state: StateRef<T>): Ref<T> {
  return customRef<T>((track, trigger) => {
    const unsubscribe = subscribeState(state, trigger)
    if (getCurrentScope()) onScopeDispose(unsubscribe)
    return {
      get() { track(); return state.value },
      set(value) { state.value = value },
    }
  })
}

/** Bridge any Vue Ref to a writable Mun Binding lens. */
export function fromVueRef<T>(ref: Ref<T>): BindingRef<T> {
  return Binding(() => ref.value, value => { ref.value = value })
}

/** Mount a graph into a Vue-managed DOM root. */
export interface VueMountOptions {
  readonly hydrate?: boolean
}

/** Mount a graph into Vue, optionally hydrating markup produced by SSR. */
export function mount(value: ViewGraphValue, target: Element, options: VueMountOptions = {}): () => void {
  const app = options.hydrate ? createSSRApp(MunView, { value }) : createApp(MunView, { value })
  app.mount(target)
  return () => app.unmount()
}

export type VueView = VueComponentType<ComponentPublicInstance>
