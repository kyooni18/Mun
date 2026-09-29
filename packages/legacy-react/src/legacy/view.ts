import type { ComponentType, ReactNode } from 'react'
import { layoutChild } from './layout.js'
import { defineView, initializer, type ViewConstructor } from './view-system.js'

export type ViewContent<Props extends object = {}> = ReactNode | ((props: Props) => ReactNode)

export interface ViewDefinition<
  State extends Record<string, unknown>,
  Props extends object = {},
> {
  state: (props: Props) => State
  body: (state: State, props: Props) => ReactNode
}

function isViewDefinition<
  State extends Record<string, unknown>,
  Props extends object,
>(
  value: ViewContent<Props> | ViewDefinition<State, Props>,
): value is ViewDefinition<State, Props> {
  return typeof value === 'object'
    && value !== null
    && 'state' in value
    && typeof (value as ViewDefinition<State, Props>).state === 'function'
    && 'body' in value
    && typeof (value as ViewDefinition<State, Props>).body === 'function'
}

type RuntimeViewProps<State extends Record<string, unknown>, Props extends object> = {
  inputProps: Props
  instanceState?: State
}

export function view<
  State extends Record<string, unknown>,
  Props extends object = {},
>(definition: ViewDefinition<State, Props>): ComponentType<Props> & Pick<ViewConstructor<RuntimeViewProps<State, Props>>, 'viewType'>
export function view<Props extends object = {}>(content: ViewContent<Props>): ComponentType<Props> & Pick<ViewConstructor<RuntimeViewProps<Record<string, unknown>, Props>>, 'viewType'>
export function view<
  State extends Record<string, unknown>,
  Props extends object = {},
>(
  input: ViewContent<Props> | ViewDefinition<State, Props>,
): ComponentType<Props> & Pick<ViewConstructor<RuntimeViewProps<State, Props>>, 'viewType'> {
  const definition = isViewDefinition(input) ? input : null
  const View = defineView<RuntimeViewProps<State, Props>>('MunView', {
    name: 'MunView',
    initializers: [initializer(
      'MunView(props?)',
      args => args.length <= 1 && (args.length === 0 || args[0] === null || typeof args[0] === 'object'),
      args => ({ inputProps: (args[0] ?? {}) as Props }),
    )],
    state: definition
      ? props => ({ instanceState: definition.state(props.inputProps) })
      : undefined,
    body: props => {
      const result = definition
        ? definition.body(props.instanceState as State, props.inputProps)
        : typeof input === 'function'
          ? (input as (props: Props) => ReactNode)(props.inputProps)
          : input as ReactNode
      return layoutChild(result)
    },
  })
  return View as unknown as ComponentType<Props> & Pick<ViewConstructor<RuntimeViewProps<State, Props>>, 'viewType'>
}
