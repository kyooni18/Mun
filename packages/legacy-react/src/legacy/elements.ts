import {
  Fragment,
  createElement,
  isValidElement,
  type ButtonHTMLAttributes,
  type ElementType,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react'
import { flattenTransparentFragments, isComponentElement, layoutChild, layoutChildren, layoutPropsOf } from './layout.js'
import { finalize } from './modifiers.js'
import { collectChildren, type MunBuilder } from './builder.js'
import { closureKindOf, markMunClosure } from './closures.js'
import { resolveValue } from './state.js'
import {
  defineBuiltinView,
  initializer,
  initializerKinds,
  type ViewCallable,
} from './view-system.js'
import { viewElement, viewFragment, viewGraphChild, viewGraphChildren, type ViewNode } from './runtime/view-graph.js'
import type {
  ComponentProps,
  GridOptions,
  HStackOptions,
  Length,
  NativeProps,
  ScrollAxis,
  StyledElement,
  Value,
  VStackOptions,
  ZStackOptions,
} from './types.js'

function flatten(children: ReactNode[]): ReactNode[] {
  const result: ReactNode[] = []
  for (const child of children) {
    if (Array.isArray(child)) result.push(...flatten(child))
    else result.push(child)
  }
  return result
}

function isOptions(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isValidElement(value)
}

function cssLength(value: Length): string {
  return typeof value === 'number' ? `${value}px` : value
}

function horizontalAlignment(value: 'leading' | 'center' | 'trailing'): 'flex-start' | 'center' | 'flex-end' {
  return value === 'leading' ? 'flex-start' : value === 'trailing' ? 'flex-end' : 'center'
}

function verticalAlignment(value: 'top' | 'center' | 'bottom'): 'flex-start' | 'center' | 'flex-end' {
  return value === 'top' ? 'flex-start' : value === 'bottom' ? 'flex-end' : 'center'
}

function stackAlignment(value: ZStackOptions['alignment']) {
  const horizontal = value?.includes('Leading') || value === 'leading'
    ? 'start'
    : value?.includes('Trailing') || value === 'trailing'
      ? 'end'
      : 'center'
  const vertical = value?.startsWith('top') || value === 'top'
    ? 'start'
    : value?.startsWith('bottom') || value === 'bottom'
      ? 'end'
      : 'center'
  return { justifyItems: horizontal, alignItems: vertical } as const
}

function cssTrack(value: number | string): string {
  return typeof value === 'number' ? `repeat(${value}, minmax(0, 1fr))` : value
}

const noFunction = (args: readonly unknown[]) => !args.some(value => typeof value === 'function')
const builderOnly = (args: readonly unknown[]) => args.length === 1 && typeof args[0] === 'function'
const optionsBuilder = (args: readonly unknown[]) => args.length === 2
  && isOptions(args[0]) && typeof args[1] === 'function'
const gridBuilder = (args: readonly unknown[]) => args.length === 2
  && (typeof args[0] === 'number' || typeof args[0] === 'string' || isOptions(args[0]))
  && typeof args[1] === 'function'

function builtinArgs(args: readonly unknown[]): Record<string, unknown> {
  return { args: [...args] }
}

type BuiltinViewCallable<Call extends (...args: any[]) => any> = ViewCallable<Call, { args: readonly unknown[] }>

type RequiredPropKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K
}[keyof T]

type ComponentArguments<C extends ElementType> = [RequiredPropKeys<ComponentProps<C>>] extends [never]
  ? [props?: ComponentProps<C> | null, ...children: ReactNode[]]
  : [props: ComponentProps<C>, ...children: ReactNode[]]

const ElementView = defineBuiltinView<{ args: readonly unknown[] }>('Element', [
  initializer('Element(tag, props?, ...children)', noFunction, builtinArgs),
], ({ args }) => {
  const [tag, props, ...children] = args
  return viewElement(tag, (props ?? null) as NativeProps | null, viewGraphChildren(flatten(children as ReactNode[])))
}) as unknown as BuiltinViewCallable<{
  (tag: string, props?: NativeProps | null, ...children: ReactNode[]): StyledElement
}>

export const Element = ElementView

const ComponentView = defineBuiltinView<{ args: readonly unknown[] }>('Component', [
  initializer('Component(component, props?, ...children)', args => args.length >= 1 && !args.slice(1).some(value => typeof value === 'function'), builtinArgs),
], ({ args }) => {
  const [component, props, ...children] = args
  return viewElement(component, (props ?? null) as object | null, viewGraphChildren(children as ReactNode[]))
}) as unknown as BuiltinViewCallable<{
  <C extends ElementType>(component: C, ...args: ComponentArguments<C>): StyledElement
}>

export const Component = ComponentView

export function Raw(element: ReactElement): StyledElement { return finalize(element) }
export function Key(key: string | number, child: ReactElement): StyledElement { return finalize(child).keyed(key) }
export function ElementRef(reference: Ref<unknown>, child: ReactElement): StyledElement { return finalize(child).elementRef(reference) }
const GroupView = defineBuiltinView<{ args: readonly unknown[] }>('Group', [
  initializer('Group(@ViewBuilder content)', builderOnly, builtinArgs, [initializerKinds.viewBuilder()]),
  initializer('Group(...children)', noFunction, builtinArgs),
], ({ args }) => viewFragment(
  viewGraphChildren(flatten(collectChildren([...args]) as ReactNode[])),
)) as unknown as BuiltinViewCallable<{
  (builder: MunBuilder): ReactElement
  (...children: ReactNode[]): ReactElement
}>

export const Group = GroupView

function buildBox(args: readonly unknown[]): ViewNode {
  const children = args.length === 1 && typeof args[0] === 'function' ? collectChildren([...args]) : [...args] as ReactNode[]
  return viewElement('div', { style: { outline: 'none' } }, viewGraphChildren(layoutChildren(flatten(children))))
}

export const Box = defineBuiltinView<{ args: readonly unknown[] }>('Box', [
  initializer('Box(@ViewBuilder content)', builderOnly, builtinArgs, [initializerKinds.viewBuilder(true, 'content')]),
  initializer('Box(...children)', noFunction, builtinArgs),
], ({ args }) => buildBox(args)) as unknown as BuiltinViewCallable<{
  (builder: MunBuilder): StyledElement
  (...children: ReactNode[]): StyledElement
}>

function buildScrollView(args: readonly unknown[]): ViewNode {
  const child = args[0] as ReactNode
  const axis = (args[1] ?? 'vertical') as ScrollAxis
  const resolved = typeof child === 'function' ? collectChildren([child]) : [child]
  const overflowX = axis === 'horizontal' || axis === 'both' ? 'auto' : 'hidden'
  const overflowY = axis === 'vertical' || axis === 'both' ? 'auto' : 'hidden'
  return viewElement('div', { style: { outline: 'none', overflowX, overflowY } }, viewGraphChildren(layoutChildren(flatten(resolved))))
}

export const ScrollView = defineBuiltinView<{ args: readonly unknown[] }>('ScrollView', [
  initializer('ScrollView(@ViewBuilder content)', args => args.length === 1 && typeof args[0] === 'function', builtinArgs, [initializerKinds.viewBuilder(true, 'content')]),
  initializer('ScrollView(content, axis?)', args => args.length >= 1 && args.length <= 2 && typeof args[0] !== 'function', builtinArgs, [initializerKinds.value(true, 'content'), initializerKinds.value(false, 'axis')]),
], ({ args }) => buildScrollView(args)) as unknown as BuiltinViewCallable<{
  (child: ReactNode, axis?: ScrollAxis): StyledElement
}>

const shapeArgs = (args: readonly unknown[]): Record<string, unknown> => ({ args: [...args] })

export const Rectangle = defineBuiltinView<{ args: readonly unknown[] }>('Rectangle', [
  initializer('Rectangle()', args => args.length === 0, shapeArgs),
], () => viewElement('div', { style: { outline: 'none' } })) as unknown as BuiltinViewCallable<{
  (): StyledElement
}>

export const RoundedRectangle = defineBuiltinView<{ args: readonly unknown[] }>('RoundedRectangle', [
  initializer('RoundedRectangle(radius?)', args => args.length <= 1 && typeof args[0] !== 'function', shapeArgs, [initializerKinds.value(false, 'radius')]),
], ({ args }) => viewElement('div', { style: { outline: 'none', borderRadius: cssLength((args[0] ?? 8) as Length) } })) as unknown as BuiltinViewCallable<{
  (radius?: Length): StyledElement
}>

export const Circle = defineBuiltinView<{ args: readonly unknown[] }>('Circle', [
  initializer('Circle()', args => args.length === 0, shapeArgs),
], () => viewElement('div', { style: { outline: 'none', borderRadius: '50%' } })) as unknown as BuiltinViewCallable<{
  (): StyledElement
}>

export const Capsule = defineBuiltinView<{ args: readonly unknown[] }>('Capsule', [
  initializer('Capsule()', args => args.length === 0, shapeArgs),
], () => viewElement('div', { style: { outline: 'none', borderRadius: '9999px' } })) as unknown as BuiltinViewCallable<{
  (): StyledElement
}>

function buildVStack(args: readonly unknown[]): ViewNode {
  const options: VStackOptions = isOptions(args[0]) ? args[0] as VStackOptions : {}
  const children = isOptions(args[0]) ? collectChildren([...args.slice(1)]) : collectChildren([...args])
  return viewElement('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      boxSizing: 'border-box',
      outline: 'none',
      ...(options.alignment === undefined ? {} : { alignItems: horizontalAlignment(options.alignment) }),
      ...(options.spacing === undefined ? {} : { gap: cssLength(options.spacing) }),
    },
  }, viewGraphChildren(layoutChildren(flatten(children))))
}

export const VStack = defineBuiltinView<{ args: readonly unknown[] }>('VStack', [
  initializer('VStack(@ViewBuilder content)', builderOnly, builtinArgs, [initializerKinds.viewBuilder(true, 'content')]),
  initializer('VStack(options, @ViewBuilder content)', optionsBuilder, builtinArgs, [initializerKinds.value(true, 'options', ['alignment', 'spacing']), initializerKinds.viewBuilder(true, 'content')]),
  initializer('VStack(...children)', noFunction, builtinArgs),
], ({ args }) => buildVStack(args)) as unknown as BuiltinViewCallable<{
  (builder: MunBuilder): StyledElement
  (...children: ReactNode[]): StyledElement
  (options: VStackOptions, ...children: ReactNode[]): StyledElement
  (options: VStackOptions, builder: MunBuilder): StyledElement
}>

function buildHStack(args: readonly unknown[]): ViewNode {
  const options: HStackOptions = isOptions(args[0]) ? args[0] as HStackOptions : {}
  const children = isOptions(args[0]) ? collectChildren([...args.slice(1)]) : collectChildren([...args])
  return viewElement('div', {
    style: {
      display: 'flex',
      flexDirection: 'row',
      width: '100%',
      boxSizing: 'border-box',
      outline: 'none',
      alignItems: verticalAlignment(options.alignment ?? 'center'),
      ...(options.spacing === undefined ? {} : { gap: cssLength(options.spacing) }),
    },
  }, viewGraphChildren(layoutChildren(flatten(children))))
}

export const HStack = defineBuiltinView<{ args: readonly unknown[] }>('HStack', [
  initializer('HStack(@ViewBuilder content)', builderOnly, builtinArgs, [initializerKinds.viewBuilder(true, 'content')]),
  initializer('HStack(options, @ViewBuilder content)', optionsBuilder, builtinArgs, [initializerKinds.value(true, 'options', ['alignment', 'spacing']), initializerKinds.viewBuilder(true, 'content')]),
  initializer('HStack(...children)', noFunction, builtinArgs),
], ({ args }) => buildHStack(args)) as unknown as BuiltinViewCallable<{
  (builder: MunBuilder): StyledElement
  (...children: ReactNode[]): StyledElement
  (options: HStackOptions, ...children: ReactNode[]): StyledElement
  (options: HStackOptions, builder: MunBuilder): StyledElement
}>

function buildZStack(args: readonly unknown[]): ViewNode {
  const options: ZStackOptions = isOptions(args[0]) ? args[0] as ZStackOptions : {}
  const children = isOptions(args[0]) ? collectChildren([...args.slice(1)]) : collectChildren([...args])
  const layers = flattenTransparentFragments(children).map((child, index) => {
    const component = isValidElement(child) && isComponentElement(child)
    const layout = component ? layoutPropsOf(child) : undefined
    return viewElement('div', {
      key: isValidElement(child) ? child.key ?? index : index,
      ...(component ? { 'data-mun-layout-host': '' } : {}),
      className: Array.isArray(layout?.className) ? layout.className.join(' ') : layout?.className,
      style: { gridArea: '1 / 1', minWidth: 0, minHeight: 0, ...(component ? layout?.style ?? {} : {}) },
    }, [viewGraphChild(child)])
  })
  return viewElement('div', {
    style: { display: 'grid', boxSizing: 'border-box', outline: 'none', ...(options.alignment === undefined ? {} : stackAlignment(options.alignment)) },
  }, layers)
}

export const ZStack = defineBuiltinView<{ args: readonly unknown[] }>('ZStack', [
  initializer('ZStack(@ViewBuilder content)', builderOnly, builtinArgs, [initializerKinds.viewBuilder(true, 'content')]),
  initializer('ZStack(options, @ViewBuilder content)', optionsBuilder, builtinArgs, [initializerKinds.value(true, 'options', ['alignment']), initializerKinds.viewBuilder(true, 'content')]),
  initializer('ZStack(...children)', noFunction, builtinArgs),
], ({ args }) => buildZStack(args)) as unknown as BuiltinViewCallable<{
  (builder: MunBuilder): StyledElement
  (...children: ReactNode[]): StyledElement
  (options: ZStackOptions, ...children: ReactNode[]): StyledElement
  (options: ZStackOptions, builder: MunBuilder): StyledElement
}>

function buildGrid(args: readonly unknown[]): ViewNode {
  const columnsOrOptions = (args[0] ?? 1) as ReactNode | GridOptions | MunBuilder
  const children = args.slice(1) as Array<ReactNode | MunBuilder>
  const builder = typeof columnsOrOptions === 'function'
  const hasOptions = !builder && (typeof columnsOrOptions === 'number'
    || typeof columnsOrOptions === 'string'
    || isOptions(columnsOrOptions))
  const options: GridOptions = hasOptions
    ? typeof columnsOrOptions === 'object' ? columnsOrOptions as GridOptions : { columns: columnsOrOptions as number | string }
    : {}
  const childArgs = builder ? [columnsOrOptions] : hasOptions ? children : [columnsOrOptions, ...children]
  const resolvedChildren = collectChildren(childArgs)
  return viewElement('div', {
    style: {
      display: 'grid',
      boxSizing: 'border-box',
      outline: 'none',
      gridTemplateColumns: cssTrack(options.columns ?? 1),
      ...(options.rows === undefined ? {} : { gridTemplateRows: cssTrack(options.rows) }),
      ...(options.autoFlow === undefined ? {} : { gridAutoFlow: options.autoFlow }),
    },
  }, viewGraphChildren(layoutChildren(flatten(resolvedChildren))))
}

export const Grid = defineBuiltinView<{ args: readonly unknown[] }>('Grid', [
  initializer('Grid(@ViewBuilder content)', builderOnly, builtinArgs, [initializerKinds.viewBuilder(true, 'content')]),
  initializer('Grid(columns, @ViewBuilder content)', gridBuilder, builtinArgs, [initializerKinds.value(true, 'columns'), initializerKinds.viewBuilder(true, 'content')]),
  initializer('Grid(...children)', noFunction, builtinArgs),
], ({ args }) => buildGrid(args)) as unknown as BuiltinViewCallable<{
  (...children: ReactNode[]): StyledElement
  (columnsOrOptions: number | string | GridOptions, ...children: ReactNode[]): StyledElement
  (builder: MunBuilder): StyledElement
  (columnsOrOptions: number | string | GridOptions, builder: MunBuilder): StyledElement
}>

export type TextProps = HTMLAttributes<HTMLSpanElement>
interface TextBuiltinProps {
  args: readonly unknown[]
  resolvedValue?: string | number
}

function textArgs(args: readonly unknown[]): Record<string, unknown> {
  const value = args[0] as Value<string | number>
  const named = isOptions(value) && 'value' in value ? value as Record<string, unknown> : null
  const actualValue = (named?.value ?? value) as Value<string | number>
  return { args: [...args], resolvedValue: resolveValue(actualValue) }
}

function buildText({ args, resolvedValue }: TextBuiltinProps): ViewNode {
  const value = args[0] as Value<string | number>
  const props = args[1] as TextProps | null | undefined
  const named = isOptions(value) && 'value' in value ? value as Record<string, unknown> : null
  const actualValue = (named?.value ?? value) as Value<string | number>
  const actualProps = named?.props as TextProps | null | undefined ?? props
  return viewElement('span', actualProps ?? null, [String(resolvedValue ?? resolveValue(actualValue))])
}

export const Text = defineBuiltinView<TextBuiltinProps>('Text', [
  initializer('Text(value)', args => args.length === 1 || (args.length === 2 && args[1] === null) || (args.length === 2 && isOptions(args[1])), textArgs, [initializerKinds.value(true, 'value')]),
], props => buildText(props)) as unknown as BuiltinViewCallable<{
  (value: Value<string | number>, props?: TextProps | null): StyledElement
}>

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>
export interface ButtonConfiguration extends ButtonProps {
  action: (event: any) => unknown
  label?: ReactNode | Value<string | number> | MunBuilder
  props?: ButtonProps | null
}
function buildButton(args: readonly unknown[]): ViewNode {
  let label: ReactNode | null = null
  let action: ((event: any) => unknown) | null = null
  let props: ButtonProps | null = null

  if (typeof args[0] === 'function' && typeof args[1] === 'function') {
    const firstKind = closureKindOf(args[0])
    const secondKind = closureKindOf(args[1])
    if (firstKind === 'viewBuilder' && secondKind === 'action') {
      label = collectChildren([args[0]]) as any
      action = args[1] as (event: any) => unknown
    } else {
      action = args[0] as (event: any) => unknown
      label = collectChildren([args[1]]) as any
    }
  } else if (typeof args[0] === 'function') {
    action = args[0] as (event: any) => unknown
    if (typeof args[1] === 'function') label = collectChildren([args[1]]) as any
    else props = args[1] ?? null
  } else if (isOptions(args[0]) && ('action' in args[0] || 'label' in args[0])) {
    const options = args[0] as Record<string, unknown>
    action = typeof options.action === 'function'
      ? markMunClosure(options.action as (event: any) => unknown, 'action')
      : null
    label = typeof options.label === 'function'
      ? collectChildren([options.label]) as any
      : (options.label ?? options.title) as ReactNode | null
    props = options.props as ButtonProps | null ?? null
    if (typeof args[1] === 'function' && label === undefined) label = collectChildren([args[1]]) as any
  } else if (isOptions(args[1]) && typeof (args[1] as any).action === 'function') {
    const options = args[1] as Record<string, unknown>
    label = args[0] as ReactNode
    action = markMunClosure(options.action as (event: any) => unknown, 'action')
    props = options.props as ButtonProps | null ?? null
  } else {
    label = args[0] as ReactNode
    action = args[1] as ((event: any) => unknown) | null
    props = args[2] ?? null
  }

  if (typeof action !== 'function') throw new TypeError('Button requires an action closure')
  const { onClick, ...rest } = props ?? {}
  return viewElement('button', {
    ...rest,
    type: rest.type ?? 'button',
    onClick(event: any) {
      onClick?.(event)
      if (!event.defaultPrevented) action?.(event)
    },
  }, (label === null || label === undefined
    ? []
    : Array.isArray(label)
      ? viewGraphChildren(label)
      : [isValidElement(label) ? viewGraphChild(label) : String(resolveValue(label as any))]))
}

export const Button = defineBuiltinView<{ args: readonly unknown[] }>('Button', [
  initializer('Button(@Action action)', args => args.length === 1 && typeof args[0] === 'function', builtinArgs, [initializerKinds.action(true, 'action')]),
  initializer('Button(title, @Action action)', args => args.length === 2 && typeof args[1] === 'function', builtinArgs, [initializerKinds.value(true, 'title'), initializerKinds.action(true, 'action')]),
  initializer('Button(@Action action, @ViewBuilder label)', args => args.length === 2 && typeof args[0] === 'function' && typeof args[1] === 'function' && (closureKindOf(args[0]) !== 'viewBuilder' && closureKindOf(args[1]) !== 'action'), builtinArgs, [initializerKinds.action(true, 'action'), initializerKinds.viewBuilder(true, 'label')]),
  initializer('Button(@ViewBuilder label, @Action action)', args => args.length === 2 && typeof args[0] === 'function' && typeof args[1] === 'function' && (closureKindOf(args[0]) !== 'action' && closureKindOf(args[1]) !== 'viewBuilder'), builtinArgs, [initializerKinds.viewBuilder(true, 'label'), initializerKinds.action(true, 'action')]),
  initializer('Button(configuration)', args => args.length === 1 && isOptions(args[0]) && typeof (args[0] as any).action === 'function', builtinArgs),
  initializer('Button(configuration, @ViewBuilder label)', args => args.length === 2 && isOptions(args[0]) && typeof args[1] === 'function', builtinArgs, [initializerKinds.value(), initializerKinds.viewBuilder()]),
  initializer('Button(title, action: @Action)', args => args.length === 2 && !isOptions(args[0]) && isOptions(args[1]) && typeof (args[1] as any).action === 'function', builtinArgs, [initializerKinds.value(true, 'title'), initializerKinds.value(true, 'action', ['action', 'props'])]),
  initializer('Button(title, @Action action, props)', args => args.length >= 2 && typeof args[1] === 'function' && args.length <= 3, builtinArgs),
], ({ args }) => buildButton(args)) as unknown as BuiltinViewCallable<{
  (action: (event: any) => unknown): StyledElement
  (label: Value<string | number>, action: (event: any) => unknown, props?: ButtonProps | null): StyledElement
  (configuration: ButtonConfiguration, label?: MunBuilder): StyledElement
}>

export type TextFieldOptions = InputHTMLAttributes<HTMLInputElement>
function buildTextField(args: readonly unknown[]): ViewNode {
  const value = args[0] as import('./types.js').StateRef<string>
  const options = (args[1] ?? {}) as TextFieldOptions
  const { onChange, ...rest } = options
  return viewElement('input', {
    ...rest,
    value: value.value,
    onChange(event: any) {
      value.value = event.currentTarget.value
      onChange?.(event)
    },
  })
}

export const TextField = defineBuiltinView<{ args: readonly unknown[] }>('TextField', [
  initializer('TextField(value, options?)', args => args.length >= 1 && args.length <= 2 && (args.length < 2 || typeof args[1] === 'object'), builtinArgs, [initializerKinds.value(true, 'value'), initializerKinds.value(false, 'options')]),
], ({ args }) => buildTextField(args)) as unknown as BuiltinViewCallable<{
  (value: import('./types.js').StateRef<string>, options?: TextFieldOptions): StyledElement
}>

export type TextAreaOptions = TextareaHTMLAttributes<HTMLTextAreaElement>
function buildTextArea(args: readonly unknown[]): ViewNode {
  const value = args[0] as import('./types.js').StateRef<string>
  const options = (args[1] ?? {}) as TextAreaOptions
  const { onChange, ...rest } = options
  return viewElement('textarea', {
    ...rest,
    value: value.value,
    onChange(event: any) {
      value.value = event.currentTarget.value
      onChange?.(event)
    },
  })
}

export const TextArea = defineBuiltinView<{ args: readonly unknown[] }>('TextArea', [
  initializer('TextArea(value, options?)', args => args.length >= 1 && args.length <= 2 && (args.length < 2 || typeof args[1] === 'object'), builtinArgs, [initializerKinds.value(true, 'value'), initializerKinds.value(false, 'options')]),
], ({ args }) => buildTextArea(args)) as unknown as BuiltinViewCallable<{
  (value: import('./types.js').StateRef<string>, options?: TextAreaOptions): StyledElement
}>

export type ToggleProps = InputHTMLAttributes<HTMLInputElement>
function buildToggle(args: readonly unknown[]): ViewNode {
  const labeled = isOptions(args[1]) && 'isOn' in args[1]
  const options = labeled ? args[1] as Record<string, unknown> : null
  const title = labeled ? args[0] as ReactNode : null
  const value = (options?.isOn ?? args[0]) as import('./types.js').StateRef<boolean>
  const props = (options?.props ?? (labeled ? null : args[1])) as ToggleProps | null | undefined
  const { onChange, ...rest } = props ?? {}
  const input = viewElement('input', {
    ...rest,
    type: 'checkbox',
    checked: value.value,
    onChange(event: any) {
      value.value = event.currentTarget.checked
      onChange?.(event)
    },
  })
  return title === null
    ? input
    : viewElement('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, [viewGraphChild(title), input])
}

export const Toggle = defineBuiltinView<{ args: readonly unknown[] }>('Toggle', [
  initializer('Toggle(title, isOn:)', args => args.length === 2 && typeof args[0] === 'string' && isOptions(args[1]) && 'isOn' in args[1], builtinArgs, [initializerKinds.value(true, 'title', undefined, 'string'), initializerKinds.value(true, 'isOn')]),
  initializer('Toggle(value, props?)', args => args.length >= 1 && args.length <= 2 && (args.length < 2 || args[1] === null || typeof args[1] === 'object'), builtinArgs, [initializerKinds.value(true, 'value'), initializerKinds.value(false, 'props')]),
], ({ args }) => buildToggle(args)) as unknown as BuiltinViewCallable<{
  (value: import('./types.js').StateRef<boolean>, props?: ToggleProps | null): StyledElement
}>

function buildSpacer(args: readonly unknown[]): ViewNode {
  const minLength = args[0] as Length | undefined
  return viewElement('div', {
    'aria-hidden': true,
    style: {
      flexGrow: 1,
      flexShrink: minLength === undefined ? 1 : 0,
      flexBasis: minLength === undefined ? '0px' : cssLength(minLength),
      minWidth: 0,
      minHeight: 0,
    },
  })
}

export const Spacer = defineBuiltinView<{ args: readonly unknown[] }>('Spacer', [
  initializer('Spacer(minLength?)', args => args.length <= 1 && typeof args[0] !== 'function', builtinArgs, [initializerKinds.value(false, 'minLength')]),
], ({ args }) => buildSpacer(args)) as unknown as BuiltinViewCallable<{
  (minLength?: Length): StyledElement
}>

export const Divider = defineBuiltinView<{ args: readonly unknown[] }>('Divider', [
  initializer('Divider()', args => args.length === 0, builtinArgs),
], () => viewElement('hr', null)) as unknown as BuiltinViewCallable<{
  (): StyledElement
}>
