import type { ReactElement } from 'react'

export interface MunPlugin {
  name: string
  apply(element: ReactElement): ReactElement
}

const plugins = new Map<string, MunPlugin>()

export function registerMunPlugin(plugin: MunPlugin): void {
  plugins.set(plugin.name, plugin)
}

export function unregisterMunPlugin(name: string): boolean {
  return plugins.delete(name)
}

export function applyMunPlugins(element: ReactElement): ReactElement {
  let result = element
  for (const plugin of plugins.values()) result = plugin.apply(result)
  return result
}

export function useMunPlugin(name: string, element: ReactElement) {
  return plugins.get(name)?.apply(element) ?? element
}
