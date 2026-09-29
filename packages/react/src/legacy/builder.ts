import type { ReactNode } from 'react'
import { resolveBuilderClosure, type ViewBuilderClosure } from './view-system.js'

export type MunBuilder = ViewBuilderClosure

export function resolveBuilder(value: unknown): ReactNode[] | null {
  if (typeof value !== 'function') return null
  return resolveBuilderClosure(value as MunBuilder) as ReactNode[]
}

export function collectChildren(args: unknown[]): ReactNode[] {
  const built = resolveBuilder(args[0])
  if (built) return built
  return args as ReactNode[]
}
