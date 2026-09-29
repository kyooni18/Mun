import {
  ViewBuilder,
  defineBuiltinView,
  initializer,
  initializerKinds,
  lazyView,
  resolveBuilderInput,
  type ModifiableViewNode,
  type TypedViewConstructor,
  type ViewBuilderClosure,
  type ViewBuilderContent,
  type ViewValue,
  viewElement,
} from "./graph.js"
import { isBinding, isStateRef, resolveValue, type BindingRef, type Value } from "./state.js"
import { layoutLength } from "./layout.js"
import { requireOptionRecord, snapshotOptionRecord } from "./options.js"
import { HStack, ScrollView, Text } from "./views.js"
import { arrayCheck } from "./graph/arrays.js"
import { APPLE_CONTINUOUS_CORNER_SMOOTHING } from "./corners.js"

function flattenChildren(values: readonly ViewBuilderContent[]): ViewValue[] {
  return ViewBuilder.buildArray(values)
}

const staticChildren = (args: readonly unknown[]) => args.every(value => typeof value !== "function")
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && arrayCheck(value) === false

export interface BoxProps { readonly children: ViewValue[] }
interface BoxCall {
  (content: ViewBuilderClosure): ModifiableViewNode
  (...children: ViewBuilderContent[]): ModifiableViewNode
}

export const Box = defineBuiltinView<BoxProps>(
  "Box",
  [
    initializer("Box(@ViewBuilder content)", args => args.length === 1 && typeof args[0] === "function", args => ({ children: resolveBuilderInput(args[0]) }), [initializerKinds.viewBuilder(true, "content")]),
    initializer("Box(...children)", staticChildren, args => ({ children: flattenChildren(args as ViewBuilderContent[]) })),
  ],
  ({ children }) => viewElement("div", { "data-mun": "Box" }, children),
) as TypedViewConstructor<BoxProps, BoxCall>

const emptyView = (name: string, style?: Record<string, unknown>) => defineBuiltinView(
  name,
  [initializer(`${name}()`, args => args.length === 0)],
  () => viewElement("div", { "data-mun": name, style }),
)

const continuousCornerStyle = (borderRadius: string): Record<string, unknown> => ({
  borderRadius,
  cornerShape: "squircle",
  "--mun-corner-style": "continuous",
  "--mun-corner-smoothing": String(APPLE_CONTINUOUS_CORNER_SMOOTHING),
  "--mun-corner-preserve-smoothing": "1",
})

export const Rectangle = emptyView("Rectangle") as TypedViewConstructor<Record<string, never>, { (): ModifiableViewNode }>
export const Circle = emptyView("Circle", { borderRadius: "50%" }) as TypedViewConstructor<Record<string, never>, { (): ModifiableViewNode }>
export const Capsule = emptyView("Capsule", continuousCornerStyle("9999px")) as TypedViewConstructor<Record<string, never>, { (): ModifiableViewNode }>

export interface RoundedRectangleProps { readonly radius?: number | string }
interface RoundedRectangleCall { (radius?: number | string): ModifiableViewNode }
export const RoundedRectangle = defineBuiltinView<RoundedRectangleProps>(
  "RoundedRectangle",
  [initializer("RoundedRectangle(radius?)", args => args.length <= 1 && (args[0] === undefined || typeof args[0] === "number" || typeof args[0] === "string"), args => ({ radius: args[0] as number | string | undefined }), [initializerKinds.value(false, "radius", undefined, "number | string")])],
  ({ radius = 8 }) => viewElement("div", {
    "data-mun": "RoundedRectangle",
    style: continuousCornerStyle(layoutLength(radius) ?? "8px"),
  }),
) as TypedViewConstructor<RoundedRectangleProps, RoundedRectangleCall>

export interface GridOptions { readonly columns?: number | string; readonly rows?: number | string; readonly autoFlow?: string }

function gridTrackTemplate(value: unknown): string | undefined {
  if (typeof value === "string") return value
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? `repeat(${value}, minmax(0, 1fr))`
    : undefined
}

function normalizedGridAutoFlow(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function normalizedLazyEstimate(value: unknown): number | string | undefined {
  if (typeof value === "string") return value
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function normalizedLazyOverscan(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export interface GridProps { readonly options?: GridOptions; readonly children: ViewValue[] }
interface GridCall {
  // Keep overload order aligned with the runtime initializer table below.
  (options: GridOptions, content: ViewBuilderClosure): ModifiableViewNode
  (content: ViewBuilderClosure): ModifiableViewNode
  (options: GridOptions, ...children: ViewBuilderContent[]): ModifiableViewNode
  (...children: ViewBuilderContent[]): ModifiableViewNode
}

export const Grid = defineBuiltinView<GridProps>(
  "Grid",
  [
    initializer("Grid(options, @ViewBuilder content)", args => args.length === 2 && snapshotOptionRecord(args[0], ["columns", "rows", "autoFlow"]) !== undefined && typeof args[1] === "function", args => ({ options: requireOptionRecord(args[0], ["columns", "rows", "autoFlow"], "Grid") as GridOptions, children: resolveBuilderInput(args[1]) }), [initializerKinds.value(true, "options", ["columns", "rows", "autoFlow"], "object"), initializerKinds.viewBuilder(true, "content")]),
    initializer("Grid(@ViewBuilder content)", args => args.length === 1 && typeof args[0] === "function", args => ({ children: resolveBuilderInput(args[0]) }), [initializerKinds.viewBuilder(true, "content")]),
    initializer("Grid(options, ...children)", args => args.length >= 1 && snapshotOptionRecord(args[0], ["columns", "rows", "autoFlow"]) !== undefined && staticChildren(args.slice(1)), args => ({ options: requireOptionRecord(args[0], ["columns", "rows", "autoFlow"], "Grid") as GridOptions, children: flattenChildren(args.slice(1) as ViewBuilderContent[]) }), [initializerKinds.value(true, "options", ["columns", "rows", "autoFlow"], "object", true)]),
    initializer("Grid(...children)", staticChildren, args => ({ children: flattenChildren(args as ViewBuilderContent[]) })),
  ],
  ({ options = {}, children }) => viewElement("div", {
    "data-mun": "Grid",
    style: {
      display: "grid",
      gridTemplateColumns: gridTrackTemplate(options.columns),
      gridTemplateRows: gridTrackTemplate(options.rows),
      gridAutoFlow: normalizedGridAutoFlow(options.autoFlow),
    },
  }, children),
) as TypedViewConstructor<GridProps, GridCall>

export interface TextAreaProps { readonly value: BindingRef<string>; readonly placeholder?: string }
interface TextAreaCall { (value: BindingRef<string>, placeholder?: string): ModifiableViewNode }
export const TextArea = defineBuiltinView<TextAreaProps>(
  "TextArea",
  [initializer("TextArea(value, placeholder?)", args => args.length >= 1 && args.length <= 2 && isBinding(args[0]) && (args[1] === undefined || typeof args[1] === "string"), args => ({ value: args[0] as BindingRef<string>, placeholder: args[1] as string | undefined }), [initializerKinds.binding(true, "value", "string"), initializerKinds.value(false, "placeholder", undefined, "string")])],
  ({ value, placeholder }) => viewElement("textarea", { "data-mun": "TextArea", value: value.value, placeholder, onInput(event: { target?: { value?: string } }) { value.value = String(event.target && event.target.value !== undefined ? event.target.value : "") } }),
) as TypedViewConstructor<TextAreaProps, TextAreaCall>

export interface PickerOption<T extends string | number> { readonly label: string; readonly value: T; readonly disabled?: boolean }
export interface PickerProps { readonly value: BindingRef<string | number>; readonly options: readonly PickerOption<string | number>[] }
interface PickerCall { <T extends string | number>(value: BindingRef<T>, options: readonly PickerOption<NoInfer<T>>[]): ModifiableViewNode }

function snapshotPickerOptions(value: unknown): readonly PickerOption<string | number>[] | undefined {
  if (arrayCheck(value) !== true) return undefined
  const values = value as readonly unknown[]
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(values, "length")
    if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return undefined
    const result: PickerOption<string | number>[] = []
    const serializedValues = new Set<string>()
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const itemDescriptor = Object.getOwnPropertyDescriptor(values, String(index))
      if (!itemDescriptor || !("value" in itemDescriptor) || !isObject(itemDescriptor.value)) return undefined
      const labelDescriptor = Object.getOwnPropertyDescriptor(itemDescriptor.value, "label")
      const valueDescriptor = Object.getOwnPropertyDescriptor(itemDescriptor.value, "value")
      const disabledDescriptor = Object.getOwnPropertyDescriptor(itemDescriptor.value, "disabled")
      if (!labelDescriptor || !("value" in labelDescriptor) || typeof labelDescriptor.value !== "string") return undefined
      if (!valueDescriptor || !("value" in valueDescriptor) || (typeof valueDescriptor.value !== "string" && typeof valueDescriptor.value !== "number")) return undefined
      if (typeof valueDescriptor.value === "number" && !Number.isFinite(valueDescriptor.value)) return undefined
      if (disabledDescriptor && (!("value" in disabledDescriptor) || (disabledDescriptor.value !== undefined && typeof disabledDescriptor.value !== "boolean"))) return undefined
      const serializedValue = String(valueDescriptor.value)
      if (serializedValues.has(serializedValue)) return undefined
      serializedValues.add(serializedValue)
      result.push(Object.freeze({
        label: labelDescriptor.value,
        value: valueDescriptor.value,
        ...(!disabledDescriptor || disabledDescriptor.value === undefined ? {} : { disabled: disabledDescriptor.value }),
      }))
    }
    return Object.freeze(result)
  } catch {
    return undefined
  }
}

function requirePickerOptions(value: unknown): readonly PickerOption<string | number>[] {
  const options = snapshotPickerOptions(value)
  if (options === undefined) throw new TypeError("Picker options must contain data-only records with finite, uniquely serialized string or number values")
  return options
}

export const Picker = defineBuiltinView<PickerProps>(
  "Picker",
  [initializer("Picker(value, options)", args => args.length === 2 && isBinding(args[0]) && snapshotPickerOptions(args[1]) !== undefined, args => ({ value: args[0] as BindingRef<string | number>, options: requirePickerOptions(args[1]) }), [initializerKinds.binding(true, "value", "string | number"), initializerKinds.value(true, "options", undefined, "array")])],
  ({ value, options }) => viewElement("select", { "data-mun": "Picker", value: value.value, onChange(event: { target?: { value?: string } }) { const selectedValue = event.target ? event.target.value : undefined; const option = options.find(item => String(item.value) === selectedValue); if (option) value.value = option.value } }, options.map(option => viewElement("option", { value: option.value, disabled: option.disabled }, [option.label]))),
) as TypedViewConstructor<PickerProps, PickerCall>

export type RadioGroupProps = PickerProps
interface RadioGroupCall { <T extends string | number>(value: BindingRef<T>, options: readonly PickerOption<NoInfer<T>>[]): ModifiableViewNode }

export const RadioGroup = defineBuiltinView<RadioGroupProps>(
  "RadioGroup",
  [initializer("RadioGroup(value, options)", args => args.length === 2 && isBinding(args[0]) && snapshotPickerOptions(args[1]) !== undefined, args => ({ value: args[0] as BindingRef<string | number>, options: requirePickerOptions(args[1]) }), [initializerKinds.binding(true, "value", "string | number"), initializerKinds.value(true, "options", undefined, "array")])],
  ({ value, options }) => viewElement("div", { "data-mun": "RadioGroup", role: "radiogroup" }, options.map(option =>
    viewElement("label", {}, [
      viewElement("input", {
        type: "radio",
        checked: String(value.value) === String(option.value),
        disabled: option.disabled,
        onChange() { if (!option.disabled) value.value = option.value },
      }),
      option.label,
    ]),
  )),
) as TypedViewConstructor<RadioGroupProps, RadioGroupCall>

export interface ProgressViewOptions { readonly label?: string; readonly max?: number }
export interface ProgressViewProps extends ProgressViewOptions { readonly value?: number }
interface ProgressViewCall { (value?: Value<number>, options?: ProgressViewOptions): ModifiableViewNode }
export const ProgressView = defineBuiltinView<ProgressViewProps>(
  "ProgressView",
  [initializer("ProgressView(value?, options?)", args => args.length <= 2 && (args[0] === undefined || typeof args[0] === "number" || typeof args[0] === "function" || isBinding(args[0]) || isStateRef(args[0])) && (args[1] === undefined || isObject(args[1])), args => {
    const options = args[1] === undefined ? {} : requireOptionRecord(args[1], ["label", "max"], "ProgressView")
    return {
      value: args[0] === undefined ? undefined : Number(resolveValue(args[0] as Value<number>)),
      label: typeof options.label === "string" ? options.label : undefined,
      max: options.max as number | undefined,
    }
  }, [initializerKinds.value(false, "value", undefined, "Value<number>"), initializerKinds.value(false, "options", ["label", "max"], "object")])],
  ({ value, label, max = 1 }) => {
    const normalizedMax = Number.isFinite(max) && max > 0 ? max : 1
    const normalizedValue = value !== undefined && Number.isFinite(value) ? Math.min(normalizedMax, Math.max(0, value)) : undefined
    return viewElement("div", { "data-mun": "ProgressView" }, [viewElement("progress", { max: normalizedMax, ...(normalizedValue === undefined ? {} : { value: normalizedValue }) }), ...(label === undefined ? [] : [Text(label)])])
  },
) as TypedViewConstructor<ProgressViewProps, ProgressViewCall>

export interface LabelProps { readonly title: string; readonly icon: ModifiableViewNode }
interface LabelCall { (title: string, icon: ModifiableViewNode): ModifiableViewNode }
export const Label = defineBuiltinView<LabelProps>(
  "Label",
  [initializer("Label(title, icon)", args => args.length === 2 && typeof args[0] === "string", args => ({ title: args[0] as string, icon: args[1] as ModifiableViewNode }), [initializerKinds.value(true, "title", undefined, "string"), initializerKinds.value(true, "icon", undefined, "View")])],
  ({ title, icon }) => HStack(icon, Text(title)),
) as TypedViewConstructor<LabelProps, LabelCall>

export interface StepperProps { readonly value: BindingRef<number>; readonly step?: number }
interface StepperCall { (value: BindingRef<number>, step?: number): ModifiableViewNode }
export const Stepper = defineBuiltinView<StepperProps>(
  "Stepper",
  [initializer("Stepper(value, step?)", args => args.length >= 1 && args.length <= 2 && isBinding(args[0]) && (args[1] === undefined || typeof args[1] === "number"), args => ({ value: args[0] as BindingRef<number>, step: args[1] as number | undefined }), [initializerKinds.binding(true, "value", "number"), initializerKinds.value(false, "step", undefined, "number")])],
  ({ value, step = 1 }) => {
    const normalizedStep = Number.isFinite(step) ? step : 1
    return HStack(Text(String(value.value)), viewElement("button", { type: "button", onClick() { value.value += normalizedStep } }, ["+"])).withProps({ "data-mun": "Stepper" })
  },
) as TypedViewConstructor<StepperProps, StepperCall>

export interface LazyGridOptions extends GridOptions {
  readonly estimatedItemSize?: number | string
  readonly overscan?: number
}
export interface LazyGridProps { readonly options?: LazyGridOptions; readonly children: ViewValue[] }
interface LazyGridCall {
  // Keep overload order aligned with the runtime initializer table below.
  (options: LazyGridOptions, content: ViewBuilderClosure): ModifiableViewNode
  (content: ViewBuilderClosure): ModifiableViewNode
  (options: LazyGridOptions, ...children: ViewBuilderContent[]): ModifiableViewNode
  (...children: ViewBuilderContent[]): ModifiableViewNode
}

export const LazyGrid = defineBuiltinView<LazyGridProps>(
  "LazyGrid",
  [
    initializer("LazyGrid(options, @ViewBuilder content)", args => args.length === 2 && snapshotOptionRecord(args[0], ["columns", "rows", "autoFlow", "estimatedItemSize", "overscan"]) !== undefined && typeof args[1] === "function", args => ({ options: requireOptionRecord(args[0], ["columns", "rows", "autoFlow", "estimatedItemSize", "overscan"], "LazyGrid") as LazyGridOptions, children: resolveBuilderInput(args[1]) }), [initializerKinds.value(true, "options", ["columns", "rows", "autoFlow", "estimatedItemSize", "overscan"], "object"), initializerKinds.viewBuilder(true, "content")]),
    initializer("LazyGrid(@ViewBuilder content)", args => args.length === 1 && typeof args[0] === "function", args => ({ children: resolveBuilderInput(args[0]) }), [initializerKinds.viewBuilder(true, "content")]),
    initializer("LazyGrid(options, ...children)", args => args.length >= 1 && snapshotOptionRecord(args[0], ["columns", "rows", "autoFlow", "estimatedItemSize", "overscan"]) !== undefined && staticChildren(args.slice(1)), args => ({ options: requireOptionRecord(args[0], ["columns", "rows", "autoFlow", "estimatedItemSize", "overscan"], "LazyGrid") as LazyGridOptions, children: flattenChildren(args.slice(1) as ViewBuilderContent[]) }), [initializerKinds.value(true, "options", ["columns", "rows", "autoFlow", "estimatedItemSize", "overscan"], "object", true)]),
    initializer("LazyGrid(...children)", staticChildren, args => ({ children: flattenChildren(args as ViewBuilderContent[]) })),
  ],
  ({ options = {}, children }) => {
    const normalizedEstimate = normalizedLazyEstimate(options.estimatedItemSize)
    const estimated = layoutLength(normalizedEstimate) ?? "44px"
    return lazyView("LazyGrid", "grid", {
      "data-mun": "LazyGrid",
      "data-mun-lazy": "grid",
      "data-mun-lazy-estimate": normalizedEstimate,
      "data-mun-lazy-overscan": normalizedLazyOverscan(options.overscan),
      style: {
        display: "grid",
        gridTemplateColumns: gridTrackTemplate(options.columns),
        gridTemplateRows: gridTrackTemplate(options.rows),
        gridAutoFlow: normalizedGridAutoFlow(options.autoFlow),
        contentVisibility: "auto",
        containIntrinsicSize: `auto ${estimated}`,
      },
    }, children)
  },
) as TypedViewConstructor<LazyGridProps, LazyGridCall>

export function Key<T extends ModifiableViewNode>(key: string | number, child: T): T {
  return child.keyed(key) as T
}

export function ElementRef<T extends ModifiableViewNode>(reference: unknown, child: T): T {
  return child.elementRef(reference) as T
}

export { ScrollView }
