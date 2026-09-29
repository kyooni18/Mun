import { initializersOf, munView, namedArguments, type ViewGraphValue } from "@mun/core/compat"

export type MunAstroComponent = ((...args: unknown[]) => ViewGraphValue) & {
  readonly __munComponent?: boolean
}

export function isMunAstroComponent(value: unknown): value is MunAstroComponent {
  if (typeof value !== "function") return false
  const component = value as MunAstroComponent
  if (component.__munComponent === true) return true
  return Object.getOwnPropertyDescriptor(component, munView)?.value === true
}


function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function parameterKey(parameter: {
  readonly name?: string
  readonly label?: string
  readonly labelRequired?: boolean
}): string | undefined {
  return parameter.label ?? parameter.name
}


export function instantiateMunAstroComponent(
  Component: MunAstroComponent,
  props: Record<string, unknown>,
): ViewGraphValue {
  if (Component.__munComponent === true) return Component(props)

  const keys = Object.keys(props)
  if (keys.length === 0) return Component()

  const candidates = initializersOf(Component).filter(initializer => {
    const parameters = initializer.parameters
    if (!parameters) return false
    const knownKeys = new Set(parameters.flatMap(parameter => {
      const key = parameterKey(parameter)
      return key ? [key] : []
    }))
    if (keys.some(key => !knownKeys.has(key))) return false
    return parameters.every(parameter => {
      if (!parameter.required) return true
      const key = parameterKey(parameter)
      return key !== undefined && hasOwn(props, key)
    })
  })

  if (candidates.length === 1 && candidates[0].parameters) {
    if (candidates[0].parameters.some(parameter => parameter.labelRequired || parameter.label !== undefined)) {
      return Component(namedArguments({ ...props }))
    }
    const args = candidates[0].parameters.map(parameter => {
      const key = parameterKey(parameter)
      return key !== undefined && hasOwn(props, key) ? props[key] : undefined
    })
    return Component(...args)
  }

  return Component(namedArguments({ ...props }))
}
