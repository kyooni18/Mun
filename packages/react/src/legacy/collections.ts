import {
  Fragment,
  createElement,
  isValidElement,
  type Key,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Grid, HStack, Text, VStack } from './elements.js'
import { collectChildren, type MunBuilder } from './builder.js'
import { layoutChild, layoutChildren, markIntrinsic } from './layout.js'
import { styled } from './modifiers.js'
import { resolveValue, useReactiveValue } from './state.js'
import { defineBuiltinView, initializer, initializerKinds, type ViewCallable } from './view-system.js'
import { viewElement, viewFragment, viewGraphChild, viewGraphChildren, viewHost, type ViewGraphChild, type ViewNode } from './runtime/view-graph.js'
import type {
  GridOptions,
  HStackOptions,
  Length,
  StyledElement,
  VStackOptions,
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

type BuiltinViewCallable<Call extends (...args: any[]) => any> = ViewCallable<Call, { args: readonly unknown[] }>

const noFunction = (args: readonly unknown[]) => !args.some(value => typeof value === 'function')
const optionsBuilder = (args: readonly unknown[]) => args.length === 2
  && typeof args[0] === 'object' && args[0] !== null && typeof args[1] === 'function'

export interface ListOptions {
  spacing?: Length
  inset?: Length
  separators?: boolean
}

function buildList(args: readonly unknown[]): ViewNode {
  const options: ListOptions = isOptions(args[0]) ? args[0] as ListOptions : {}
  const children = (isOptions(args[0]) ? args.slice(1) : args) as ReactNode[]
  const flat = flatten(children)
  const rows = flat.map((child, index) => viewElement(
    'div',
    {
      role: 'listitem',
      key: isValidElement(child) ? child.key ?? index : index,
      style: {
        minWidth: 0,
        ...(options.inset === undefined ? {} : { padding: cssLength(options.inset) }),
        ...(options.separators === false || index === 0
          ? {}
          : { borderTop: '1px solid rgba(127, 127, 127, 0.22)' }),
      },
    },
    [viewGraphChild(layoutChild(child))],
  ))

  return viewElement('div', {
    role: 'list',
    style: {
      display: 'flex',
      flexDirection: 'column',
      ...(options.spacing === undefined ? {} : { gap: cssLength(options.spacing) }),
    },
  }, rows)
}

export const List = defineBuiltinView<{ args: readonly unknown[] }>('List', [
  initializer('List(options, ...children)', args => !args.some(value => typeof value === 'function'), args => ({ args: [...args] })),
], ({ args }) => buildList(args)) as unknown as BuiltinViewCallable<{
  (...children: ReactNode[]): StyledElement
  (options: ListOptions, ...children: ReactNode[]): StyledElement
}>

export interface SectionOptions {
  header?: ReactNode | string
  footer?: ReactNode | string
  spacing?: Length
}

interface ForEachHostProps<Item> {
  items: import('./types.js').Value<readonly Item[]>
  content: (item: Item, index: number) => ReactNode
  keyOf?: (item: Item, index: number) => Key
}

function ForEachHost<Item>({ items, content, keyOf }: ForEachHostProps<Item>) {
  const values = useReactiveValue(() => resolveValue(items) ?? [])
  return createElement(Fragment, null, values.map((item, index) => createElement(
    Fragment,
    { key: keyOf?.(item, index) ?? index },
    content(item, index),
  )))
}

markIntrinsic(ForEachHost)

interface ForEachBuiltinProps { args: readonly unknown[] }

export const ForEach = defineBuiltinView<ForEachBuiltinProps>('ForEach', [
  initializer('ForEach(data, @ViewBuilder content)', args => args.length === 2 && typeof args[1] === 'function', args => ({ args: [...args] }), [initializerKinds.value(true, 'data'), initializerKinds.viewBuilder(true, 'content')]),
  initializer('ForEach(data, @ViewBuilder content, key)', args => args.length === 3 && typeof args[1] === 'function' && typeof args[2] === 'function', args => ({ args: [...args] }), [initializerKinds.value(true, 'data'), initializerKinds.viewBuilder(true, 'content'), initializerKinds.value(true, 'key')]),
], ({ args }) => {
  const items = args[0] as import('./types.js').Value<readonly unknown[]>
  const content = args[1] as (item: unknown, index: number) => ReactNode
  const keyOf = args[2] as ((item: unknown, index: number) => Key) | undefined
  if (typeof content !== 'function') throw new TypeError('ForEach requires a trailing @ViewBuilder closure')
  const props = { items, content, keyOf }
  return viewHost(
    'ForEach',
    ForEachHost,
    props,
    value => {
      const { items: source, content: builder, keyOf: key } = value as ForEachHostProps<unknown>
      const values = resolveValue(source) ?? []
      return viewFragment(values.map((item, index) => {
        const rendered = builder(item, index)
        return viewGraphChild(rendered as ReactNode | ViewNode)
      }))
    },
  )
}) as unknown as BuiltinViewCallable<{
  <Item>(items: import('./types.js').Value<readonly Item[]>, content: (item: Item, index: number) => ReactNode, keyOf?: (item: Item, index: number) => Key): StyledElement
}>

function sectionPart(value: ReactNode | string | undefined, role: 'heading' | 'note'): ViewGraphChild {
  if (value === undefined) return null
  const child = typeof value === 'string' ? Text(value) : value
  return viewElement('div', { role }, [viewGraphChild(layoutChild(child))])
}

function buildSection(args: readonly unknown[]): ViewNode {
  let options: SectionOptions = {}
  let children: ReactNode[] = [...args] as ReactNode[]

  if (typeof args[0] === 'string') {
    options = { header: args[0] }
    children = args.slice(1) as ReactNode[]
  } else if (isOptions(args[0])) {
    options = args[0] as SectionOptions
    children = args.slice(1) as ReactNode[]
  }

  return viewElement('section', { style: { display: 'flex', flexDirection: 'column', gap: cssLength(options.spacing ?? 8) } }, [
    sectionPart(options.header, 'heading'),
    viewElement('div', { role: 'group' }, viewGraphChildren(layoutChildren(flatten(children)))),
    sectionPart(options.footer, 'note'),
  ])
}

export const Section = defineBuiltinView<{ args: readonly unknown[] }>('Section', [
  initializer('Section(options, ...children)', args => !args.some(value => typeof value === 'function'), args => ({ args: [...args] })),
], ({ args }) => buildSection(args)) as unknown as BuiltinViewCallable<{
  (...children: ReactNode[]): StyledElement
  (title: string, ...children: ReactNode[]): StyledElement
  (options: SectionOptions, ...children: ReactNode[]): StyledElement
}>

export interface LazyOptions { estimatedItemSize?: Length }
export type LazyVStackOptions = VStackOptions & LazyOptions
export type LazyHStackOptions = HStackOptions & LazyOptions
export type LazyGridOptions = GridOptions & LazyOptions

function lazyStyle(estimatedItemSize: Length = 44): CSSProperties {
  return {
    contentVisibility: 'auto',
    containIntrinsicSize: `auto ${cssLength(estimatedItemSize)}`,
  }
}

function lazyChild(child: ReactNode, estimatedItemSize?: Length): ReactNode {
  if (!isValidElement(child) || child.type === Fragment) return child
  return styled(child).style(lazyStyle(estimatedItemSize))
}

function buildLazyVStack(args: readonly unknown[]): ReactNode {
  const options: LazyVStackOptions = isOptions(args[0]) ? args[0] as LazyVStackOptions : {}
  const children = isOptions(args[0]) ? collectChildren([...args.slice(1)]) : collectChildren([...args])
  const { estimatedItemSize, ...stackOptions } = options
  return VStack(stackOptions, ...flatten(children).map(child => lazyChild(child, estimatedItemSize)))
}

export const LazyVStack = defineBuiltinView<{ args: readonly unknown[] }>('LazyVStack', [
  initializer('LazyVStack(@ViewBuilder content)', args => args.length === 1 && typeof args[0] === 'function', args => ({ args: [...args] }), [initializerKinds.viewBuilder()]),
  initializer('LazyVStack(options, @ViewBuilder content)', optionsBuilder, args => ({ args: [...args] }), [initializerKinds.value(true, 'options'), initializerKinds.viewBuilder(true, 'content')]),
  initializer('LazyVStack(...children)', noFunction, args => ({ args: [...args] })),
], ({ args }) => buildLazyVStack(args)) as unknown as BuiltinViewCallable<{
  (...children: ReactNode[]): StyledElement
  (options: LazyVStackOptions, ...children: ReactNode[]): StyledElement
  (builder: MunBuilder): StyledElement
  (options: LazyVStackOptions, builder: MunBuilder): StyledElement
}>

function buildLazyHStack(args: readonly unknown[]): ReactNode {
  const options: LazyHStackOptions = isOptions(args[0]) ? args[0] as LazyHStackOptions : {}
  const children = isOptions(args[0]) ? collectChildren([...args.slice(1)]) : collectChildren([...args])
  const { estimatedItemSize, ...stackOptions } = options
  return HStack(stackOptions, ...flatten(children).map(child => lazyChild(child, estimatedItemSize)))
}

export const LazyHStack = defineBuiltinView<{ args: readonly unknown[] }>('LazyHStack', [
  initializer('LazyHStack(@ViewBuilder content)', args => args.length === 1 && typeof args[0] === 'function', args => ({ args: [...args] }), [initializerKinds.viewBuilder()]),
  initializer('LazyHStack(options, @ViewBuilder content)', optionsBuilder, args => ({ args: [...args] }), [initializerKinds.value(true, 'options'), initializerKinds.viewBuilder(true, 'content')]),
  initializer('LazyHStack(...children)', noFunction, args => ({ args: [...args] })),
], ({ args }) => buildLazyHStack(args)) as unknown as BuiltinViewCallable<{
  (...children: ReactNode[]): StyledElement
  (options: LazyHStackOptions, ...children: ReactNode[]): StyledElement
  (builder: MunBuilder): StyledElement
  (options: LazyHStackOptions, builder: MunBuilder): StyledElement
}>

function buildLazyGrid(args: readonly unknown[]): ReactNode {
  const columnsOrOptions = (args[0] ?? 1) as number | string | LazyGridOptions | MunBuilder
  const children = args.slice(1) as Array<ReactNode | MunBuilder>
  const builder = typeof columnsOrOptions === 'function'
  const options: LazyGridOptions = builder ? {} : typeof columnsOrOptions === 'object'
    ? columnsOrOptions
    : { columns: columnsOrOptions }
  const { estimatedItemSize, ...gridOptions } = options
  const resolvedChildren = builder ? collectChildren([columnsOrOptions]) : collectChildren(children)
  return Grid(gridOptions, ...flatten(resolvedChildren).map(child => lazyChild(child, estimatedItemSize)))
}

export const LazyGrid = defineBuiltinView<{ args: readonly unknown[] }>('LazyGrid', [
  initializer('LazyGrid(@ViewBuilder content)', args => args.length === 1 && typeof args[0] === 'function', args => ({ args: [...args] }), [initializerKinds.viewBuilder()]),
  initializer('LazyGrid(columns, @ViewBuilder content)', args => args.length === 2 && typeof args[1] === 'function', args => ({ args: [...args] }), [initializerKinds.value(true, 'columns'), initializerKinds.viewBuilder(true, 'content')]),
  initializer('LazyGrid(...children)', noFunction, args => ({ args: [...args] })),
], ({ args }) => buildLazyGrid(args)) as unknown as BuiltinViewCallable<{
  (builder: MunBuilder): StyledElement
  (columnsOrOptions: number | string | LazyGridOptions, builder: MunBuilder): StyledElement
}>
