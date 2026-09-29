import type { ReactElement } from 'react'

export const munNode = Symbol.for('mun.node')

export interface MunNodeMetadata {
  modifiers: unknown[]
  layout?: unknown
}

const metadata = new WeakMap<object, MunNodeMetadata>()

export function markMunNode(element: ReactElement, data: MunNodeMetadata): ReactElement {
  metadata.set(element, data)
  return element
}

export function getMunNodeMetadata(element: ReactElement): MunNodeMetadata | undefined {
  return metadata.get(element)
}
