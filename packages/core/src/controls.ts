import {
  defineBuiltinView,
  initializer,
  initializerKinds,
  type ModifiableViewNode,
  type TypedViewConstructor,
  viewElement,
} from "./graph.js"
import { Animation } from "./animation.js"
import { isBinding, resolveValue, type BindingRef, type Value } from "./state.js"
import { requireOptionRecord } from "./options.js"
import { Text } from "./views.js"
import { isVectorSymbol, type VectorSymbol } from "./vector-symbol.js"

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export interface ToggleProps { readonly title: string; readonly isOn: BindingRef<boolean> }
interface ToggleCall { (title: string, isOn: BindingRef<boolean>): ModifiableViewNode }

export const Toggle = defineBuiltinView<ToggleProps>(
  "Toggle",
  [initializer(
    "Toggle(title, isOn)",
    args => args.length === 2 && typeof args[0] === "string" && isBinding(args[1]),
    args => ({ title: args[0] as string, isOn: args[1] as BindingRef<boolean> }),
    [initializerKinds.value(true, "title", undefined, "string"), initializerKinds.binding(true, "isOn", "boolean")],
  )],
  ({ title, isOn }) => viewElement("label", { "data-mun": "Toggle" }, [
    viewElement("input", {
      type: "checkbox",
      checked: Boolean(isOn.value),
      onChange(event: { target?: { checked?: boolean } }) { isOn.value = Boolean(event.target ? event.target.checked : undefined) },
    }),
    Text(title),
  ]),
) as TypedViewConstructor<ToggleProps, ToggleCall>

export interface SwitchOptions {
  readonly tint?: string
  readonly offTint?: string
  readonly size?: number
  readonly label?: string
  /** Render only the visual switch when an ancestor owns interaction. */
  readonly interactive?: boolean
  /** undefined uses smart .animation(); null disables switch motion. */
  readonly animation?: Animation | null
}
export interface SwitchProps extends SwitchOptions { readonly isOn: BindingRef<boolean>; readonly title?: string }
interface SwitchCall {
  // Keep overload order aligned with the runtime initializer table below.
  (title: string, isOn: BindingRef<boolean>, options?: SwitchOptions): ModifiableViewNode
  (isOn: BindingRef<boolean>, options?: SwitchOptions): ModifiableViewNode
}

export const Switch = defineBuiltinView<SwitchProps>(
  "Switch",
  [
    initializer(
      "Switch(_ title: string, isOn, options?)",
      args => args.length >= 2 && args.length <= 3 && typeof args[0] === "string" && isBinding(args[1]) && (args[2] === undefined || isObject(args[2])),
      args => {
        const options = args[2] === undefined ? {} : requireOptionRecord(args[2], ["tint", "offTint", "size", "label", "interactive", "animation"], "Switch")
        return {
          title: args[0] as string,
          isOn: args[1] as BindingRef<boolean>,
          tint: typeof options.tint === "string" ? options.tint : undefined,
          offTint: typeof options.offTint === "string" ? options.offTint : undefined,
          size: typeof options.size === "number" && Number.isFinite(options.size) && options.size > 0 ? options.size : undefined,
          label: typeof options.label === "string" ? options.label : undefined,
          interactive: typeof options.interactive === "boolean" ? options.interactive : undefined,
          animation: options.animation instanceof Animation || options.animation === null ? options.animation : undefined,
        }
      },
      [
        initializerKinds.value(true, undefined, undefined, "string"),
        initializerKinds.binding(true, "isOn", "boolean"),
        initializerKinds.value(false, "options", ["tint", "offTint", "size", "label", "interactive", "animation"], "object"),
      ],
    ),
    initializer(
      "Switch(isOn, options?)",
      args => args.length >= 1 && args.length <= 2 && isBinding(args[0]) && (args[1] === undefined || isObject(args[1])),
      args => {
        const options = args[1] === undefined ? {} : requireOptionRecord(args[1], ["tint", "offTint", "size", "label", "interactive", "animation"], "Switch")
        return {
          isOn: args[0] as BindingRef<boolean>,
          tint: typeof options.tint === "string" ? options.tint : undefined,
          offTint: typeof options.offTint === "string" ? options.offTint : undefined,
          size: typeof options.size === "number" && Number.isFinite(options.size) && options.size > 0 ? options.size : undefined,
          label: typeof options.label === "string" ? options.label : undefined,
          interactive: typeof options.interactive === "boolean" ? options.interactive : undefined,
          animation: options.animation instanceof Animation || options.animation === null ? options.animation : undefined,
        }
      },
      [
        initializerKinds.binding(true, "isOn", "boolean"),
        initializerKinds.value(false, "options", ["tint", "offTint", "size", "label", "interactive", "animation"], "object"),
      ],
    ),
  ],
  ({ title, isOn, tint, offTint, size, label, interactive = true, animation }) => {
    const height = size !== undefined ? size : 28
    // Keep geometry mathematically consistent with the authored 1.8 aspect
    // ratio. Rounding the track but not the CSS host made the 22px Misutgaru
    // switch travel 18px inside a 39.6px track, overshooting by 0.4px.
    const width = height * 1.8
    const inset = Math.max(2, Math.round(height / 10))
    const thumbSize = height - inset * 2
    const thumbTravel = Math.max(0, width - thumbSize - inset * 2)
    const switchColor = (name: string, fallback: string): string => `var(--mun-switch-${name}, ${fallback})`
    const activeTrackColor = tint ?? switchColor("on-bg", "light-dark(#34c759, #0a84ff)")
    const inactiveTrackColor = offTint ?? switchColor("off-bg", "light-dark(#e9e9ea, #3a3a3c)")
    const thumbColor = isOn.value
      ? switchColor("on-fg", "light-dark(#ffffff, #ffffff)")
      : switchColor("off-fg", "light-dark(#ffffff, #b8b8b8)")
    const animateChange = <T extends ModifiableViewNode>(node: T): ModifiableViewNode => animation === undefined
      ? node.animation()
      : node.animation(animation)
    // Do not interpolate theme colors directly. CSS custom properties such as
    // var(--accent) cannot be resolved by a renderer-agnostic color parser and
    // therefore used to fall back to a discrete patch. A static off track plus
    // an opacity-animated active layer keeps the hot path compositor-friendly
    // and makes the visual transition independent from color syntax.
    const activeTrack = animateChange(viewElement("span", {
      "data-mun": "SwitchTrack",
      "aria-hidden": "true",
    }).style({
      position: "absolute",
      top: "0",
      right: "0",
      bottom: "0",
      left: "0",
      borderRadius: `${height / 2}px`,
      cornerShape: "squircle",
      background: activeTrackColor,
      opacity: isOn.value ? 1 : 0,
      pointerEvents: "none",
    }))
    const thumb = animateChange(viewElement("span", {
      "data-mun": "SwitchThumb",
    }).style({
      position: "absolute",
      top: `${inset}px`,
      left: `${inset}px`,
      translate: isOn.value ? `${thumbTravel}px 0px` : "0px 0px",
      width: `${thumbSize}px`,
      height: `${thumbSize}px`,
      borderRadius: "50%",
      cornerShape: "round",
      background: thumbColor,
      boxShadow: "0 1px 3px rgb(0 0 0 / 0.24)",
      zIndex: "1",
    }))
    const controlProps = interactive
      ? {
          type: "button",
          role: "switch",
          "data-mun": "Switch",
          "aria-checked": Boolean(isOn.value),
          ...(label !== undefined ? { "aria-label": label } : title === undefined ? {} : { "aria-label": title }),
          onClick() { isOn.value = !isOn.value },
        }
      : {
          "data-mun": "Switch",
          "aria-hidden": "true",
        }
    const control = viewElement(interactive ? "button" : "span", controlProps, [activeTrack, thumb]).style({
      position: "relative",
      width: `${width}px`,
      height: `${height}px`,
      borderRadius: `${height / 2}px`,
      cornerShape: "squircle",
      border: "none",
      padding: "0",
      cursor: interactive ? "pointer" : "inherit",
      background: inactiveTrackColor,
    })
    if (title === undefined) return control
    return viewElement("span", {
      "data-mun": "Switch",
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: `${Math.round(height * 0.32)}px`,
      },
    }, [Text(title), control])
  },
) as TypedViewConstructor<SwitchProps, SwitchCall>

export interface TextFieldProps { readonly value: BindingRef<string>; readonly placeholder?: string }
interface TextFieldCall { (value: BindingRef<string>, placeholder?: string): ModifiableViewNode }

export const TextField = defineBuiltinView<TextFieldProps>(
  "TextField",
  [initializer(
    "TextField(value, placeholder?)",
    args => args.length >= 1 && args.length <= 2 && isBinding(args[0]) && (args[1] === undefined || typeof args[1] === "string"),
    args => ({ value: args[0] as BindingRef<string>, placeholder: args[1] as string | undefined }),
    [initializerKinds.binding(true, "value", "string"), initializerKinds.value(false, "placeholder", undefined, "string")],
  )],
  ({ value, placeholder }) => viewElement("input", {
    "data-mun": "TextField",
    type: "text",
    value: value.value,
    placeholder,
    onInput(event: { target?: { value?: string } }) { value.value = String(event.target && event.target.value !== undefined ? event.target.value : "") },
  }),
) as TypedViewConstructor<TextFieldProps, TextFieldCall>

export interface SliderOptions { readonly min?: number; readonly max?: number; readonly step?: number }
export interface SliderProps extends SliderOptions { readonly value: BindingRef<number> }
interface SliderCall { (value: BindingRef<number>, options?: SliderOptions): ModifiableViewNode }

export const Slider = defineBuiltinView<SliderProps>(
  "Slider",
  [initializer(
    "Slider(value, range?)",
    args => args.length >= 1 && args.length <= 2 && isBinding(args[0]) && (args[1] === undefined || isObject(args[1])),
    args => {
      const options = args[1] === undefined ? {} : requireOptionRecord(args[1], ["min", "max", "step"], "Slider")
      return {
        value: args[0] as BindingRef<number>,
        min: options.min as number | undefined,
        max: options.max as number | undefined,
        step: options.step as number | undefined,
      }
    },
    [initializerKinds.binding(true, "value", "number"), initializerKinds.value(false, "range", ["min", "max", "step"], "object")],
  )],
  ({ value, min = 0, max = 1, step }) => {
    const normalizedMin = Number.isFinite(min) ? min : 0
    const finiteMax = Number.isFinite(max) ? max : 1
    const normalizedMax = Math.max(normalizedMin, finiteMax)
    const normalizedValue = Number.isFinite(value.value) ? value.value : normalizedMin
    const normalizedStep = step !== undefined && Number.isFinite(step) && step > 0 ? step : undefined
    return viewElement("input", {
      "data-mun": "Slider",
      type: "range",
      value: normalizedValue,
      min: normalizedMin,
      max: normalizedMax,
      step: normalizedStep,
      onInput(event: { target?: { value?: string } }) {
        const raw = event.target && event.target.value !== undefined ? Number(event.target.value) : Number.NaN
        // An empty input parses as 0 and would silently bypass the range, so
        // reject non-finite values and clamp to the configured bounds.
        const parsed = Number.isFinite(raw) ? raw : normalizedMin
        value.value = Math.min(normalizedMax, Math.max(normalizedMin, parsed))
      },
    })
  },
) as TypedViewConstructor<SliderProps, SliderCall>

export interface ImageOptions { readonly alt?: string }
export interface ImageProps extends ImageOptions { readonly source?: string; readonly symbol?: VectorSymbol }
interface ImageCall {
  (source: Value<string>, options?: ImageOptions): ModifiableViewNode
  (symbol: VectorSymbol, options?: ImageOptions): ModifiableViewNode
}

export const Image = defineBuiltinView<ImageProps>(
  "Image",
  [initializer(
    "Image(source, options?)",
    args => args.length >= 1 && args.length <= 2 && (typeof args[0] === "string" || typeof args[0] === "function" || isVectorSymbol(args[0])) && (args[1] === undefined || isObject(args[1])),
    args => {
      const options = args[1] === undefined ? {} : requireOptionRecord(args[1], ["alt"], "Image")
      return isVectorSymbol(args[0])
        ? { symbol: args[0], alt: typeof options.alt === "string" ? options.alt : undefined }
        : { source: String(resolveValue(args[0] as Value<string>)), alt: typeof options.alt === "string" ? options.alt : undefined }
    },
    [initializerKinds.value(true, "source", undefined, "Value<string> | VectorSymbol"), initializerKinds.value(false, "options", ["alt"], "object")],
  )],
  ({ source, symbol, alt }) => {
    if (!symbol) return viewElement("img", { src: source, alt })
    const descriptor = symbol.descriptor
    return viewElement("svg", {
      "data-mun": "VectorSymbol",
      "data-mun-symbol": descriptor.name ?? "",
      viewBox: descriptor.viewBox,
      xmlns: "http://www.w3.org/2000/svg",
      ...(alt ? { role: "img", "aria-label": alt } : { "aria-hidden": "true" }),
    }, descriptor.layers.map(layer => viewElement("path", {
      key: layer.id,
      "data-mun-symbol-layer": layer.id,
      d: layer.d,
      ...(layer.fill !== undefined ? { fill: layer.fill } : {}),
      ...(layer.stroke !== undefined ? { stroke: layer.stroke } : {}),
      ...(layer.strokeWidth !== undefined ? { strokeWidth: layer.strokeWidth } : {}),
      ...(layer.strokeLinecap !== undefined ? { strokeLinecap: layer.strokeLinecap } : {}),
      ...(layer.strokeLinejoin !== undefined ? { strokeLinejoin: layer.strokeLinejoin } : {}),
      ...(layer.fillRule !== undefined ? { fillRule: layer.fillRule } : {}),
      ...(layer.clipRule !== undefined ? { clipRule: layer.clipRule } : {}),
      ...(layer.transform !== undefined ? { transform: layer.transform } : {}),
      ...(layer.vectorEffect !== undefined ? { vectorEffect: layer.vectorEffect } : {}),
      ...(layer.opacity !== undefined ? { opacity: layer.opacity } : {}),
    })))
  },
) as TypedViewConstructor<ImageProps, ImageCall>

export interface LinkProps { readonly label: string; readonly href: string }
interface LinkCall { (label: string, href: Value<string>): ModifiableViewNode }

export const Link = defineBuiltinView<LinkProps>(
  "Link",
  [initializer(
    "Link(label, href)",
    args => args.length === 2 && typeof args[0] === "string" && (typeof args[1] === "string" || typeof args[1] === "function"),
    args => ({ label: args[0] as string, href: String(resolveValue(args[1] as Value<string>)) }),
    [initializerKinds.value(true, "label", undefined, "string"), initializerKinds.value(true, "href", undefined, "Value<string>")],
  )],
  ({ label, href }) => viewElement("a", { href }, [Text(label)]),
) as TypedViewConstructor<LinkProps, LinkCall>
