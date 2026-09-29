import {
  Fragment,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { ClassValue, StyleValue } from './types.js'

export interface ComponentLayoutProps {
  className?: ClassValue
  style?: StyleValue
}

export const munIntrinsic = Symbol.for('mun.intrinsic')

const componentLayoutProps = new WeakMap<object, ComponentLayoutProps>()
const proxyTargets = new WeakMap<object, ReactElement>()

function identity(element: ReactElement): ReactElement {
  return proxyTargets.get(element as object) ?? element
}

export function registerStyledProxy(proxy: object, target: ReactElement): void {
  proxyTargets.set(proxy, target)
}

export function markIntrinsic<T extends Function>(component: T): T {
  Object.defineProperty(component, munIntrinsic, { value: true })
  return component
}

export function isComponentElement(element: ReactElement): boolean {
  const type = element.type as any
  if (typeof type === 'string' || type === Fragment) return false
  if (type?.[munIntrinsic] === true) return false
  return true
}

export function layoutPropsOf(element: ReactElement): ComponentLayoutProps | undefined {
  return componentLayoutProps.get(identity(element) as object)
}

export function copyLayoutProps(source: ReactElement, target: ReactElement): void {
  const props = layoutPropsOf(source)
  if (!props) return
  componentLayoutProps.set(target as object, {
    ...props,
    ...(props.style ? { style: { ...props.style } } : {}),
  })
}

export function setLayoutStyle(element: ReactElement, style: StyleValue): void {
  const target = identity(element)
  const current = componentLayoutProps.get(target as object)
  componentLayoutProps.set(target as object, {
    ...current,
    style: { ...(current?.style ?? {}), ...style },
  })
}

export function setLayoutClass(element: ReactElement, className: ClassValue): void {
  const target = identity(element)
  const current = componentLayoutProps.get(target as object)
  componentLayoutProps.set(target as object, { ...current, className })
}

export function classNameOf(...values: ClassValue[]): string | undefined {
  const names: string[] = []
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) if (item) names.push(item)
    } else if (typeof value === 'string') {
      names.push(value)
    }
  }
  return names.length > 0 ? names.join(' ') : undefined
}

export function layoutChild(child: ReactNode): ReactNode {
  if (isValidElement(child) && child.type === Fragment) {
    return createElement(Fragment, null, ...layoutChildren(fragmentChildren(child)))
  }
  if (!isValidElement(child) || !isComponentElement(child)) return child
  const layout = layoutPropsOf(child)
  return createElement(
    'div',
    {
      key: child.key ?? undefined,
      'data-mun-layout-host': '',
      className: classNameOf(layout?.className),
      style: {
        minWidth: 0,
        minHeight: 0,
        ...(layout?.style ?? {}),
      },
    },
    child,
  )
}

function fragmentChildren(fragment: ReactElement): ReactNode[] {
  const children = (fragment.props as { children?: ReactNode }).children
  return Array.isArray(children) ? children : [children]
}

export function flattenTransparentFragments(children: ReactNode[]): ReactNode[] {
  const result: ReactNode[] = []
  for (const child of children) {
    if (Array.isArray(child)) {
      result.push(...flattenTransparentFragments(child))
    } else if (isValidElement(child) && child.type === Fragment) {
      result.push(...flattenTransparentFragments(fragmentChildren(child)))
    } else {
      result.push(child)
    }
  }
  return result
}

export function layoutChildren(children: ReactNode[]): ReactNode[] {
  return flattenTransparentFragments(children).map(layoutChild)
}
