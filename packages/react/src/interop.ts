import { createElement, type ComponentProps, type Dispatch, type ElementType, type ReactNode, type SetStateAction } from "react"
import {
  ForeignComponent,
  Binding,
  defineView,
  initializer,
  viewElement,
  type ModifiableViewNode,
  type ViewValue,
  type BindingRef,
} from "@mun/core/compat"

export type ReactComponentProps<C extends ElementType> = ComponentProps<C>
type RequiredReactPropKeys<Props> = {
  [Key in keyof Props]-?: object extends Pick<Props, Key> ? never : Key
}[keyof Props]
type ReactComponentArguments<C extends ElementType> = [RequiredReactPropKeys<ReactComponentProps<C>>] extends [never]
  ? [props?: ReactComponentProps<C> | null, ...children: ViewValue[]]
  : [props: ReactComponentProps<C>, ...children: ViewValue[]]
export type ReactComponentView<C extends ElementType> = ((...args: ReactComponentArguments<C>) => ModifiableViewNode) & {
  readonly component: C
}

function isComponentPropsRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  try { return !Array.isArray(value) } catch { return false }
}

function snapshotComponentProps(value: unknown): Record<string, unknown> {
  if (!isComponentPropsRecord(value)) return {}
  try {
    const props: Record<PropertyKey, unknown> = {}
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) continue
      Object.defineProperty(props, key, { ...descriptor, configurable: true })
    }
    return props as Record<string, unknown>
  } catch { return {} }
}

function componentName(type: unknown): string {
  try {
    const descriptor = typeof type === "function" || (typeof type === "object" && type !== null)
      ? Object.getOwnPropertyDescriptor(type, "displayName") ?? Object.getOwnPropertyDescriptor(type, "name")
      : undefined
    return descriptor && "value" in descriptor && typeof descriptor.value === "string" && descriptor.value
      ? descriptor.value
      : "ReactComponent"
  } catch { return "ReactComponent" }
}

/** Place a React component or native HTML element in the same Mün graph. */
export function Component<C extends ElementType>(type: C, ...args: ReactComponentArguments<C>): ModifiableViewNode
export function Component(type: ElementType, props: Record<string, unknown> | null = null, ...children: ViewValue[]): ModifiableViewNode {
  if (typeof type === "string") return viewElement(type, props, children)
  return ForeignComponent(type, { props: snapshotComponentProps(props), adapter: "react", name: componentName(type) }, ...children)
}

/** Adapt a React component into a Mun-callable while preserving its prop surface. */
export function reactComponent<C extends ElementType>(type: C): ReactComponentView<C> {
  const name = componentName(type)
  const View = defineView(name, {
    initializers: [initializer(
      "ReactComponent(props?)",
      args => args.length <= 1 && (args.length === 0 || isComponentPropsRecord(args[0])),
      args => ({ props: args[0] ?? null }),
    )],
    intrinsic: true,
    body: ({ props }: { readonly props: Record<string, unknown> | null }) => Component(type, (props ?? {}) as ReactComponentProps<C>),
  }) as unknown as ReactComponentView<C>
  Object.defineProperty(View, "component", { configurable: false, enumerable: false, value: type })
  return View
}

/** Renderer-specific alias matching the generic foreign-component adapter API. */
export function foreignComponent<C extends ElementType>(type: C): ReactComponentView<C> {
  return reactComponent(type)
}

/** Embed an already-created React node as an explicitly React-owned boundary. */
export function Raw(value: ReactNode): ViewValue {
  const RawReactValue = () => value
  return ForeignComponent(RawReactValue, { name: "React.Raw", adapter: "react" })
}

export function reactElement(type: ElementType, props?: Record<string, unknown> | null, ...children: ReactNode[]): ReactNode {
  return createElement(type as any, props, ...children)
}

/** Adapt a React `useState` pair into a writable Mun Binding lens. */
export function fromReactState<T>(value: T, setValue: Dispatch<SetStateAction<T>>): BindingRef<T> {
  return Binding(() => value, next => setValue(next))
}
