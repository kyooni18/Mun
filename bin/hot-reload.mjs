// Hot-reload compatibility between the running and the newly compiled program.
//
// State identity is the compiler's semantic identity (`@component/<View path>/
// <name>`), never a source line. A state value may survive only when the new
// program declares the same identity with the same declared Mün type and the
// same owning keyed scope. Anything else starts from its new initial value;
// changes that alter what "the application" is require a process restart.

/**
 * @param {{ program: any, metadata: { states: { name: string, type: string, scope?: string }[] } }} previous
 * @param {{ program: any, metadata: { states: { name: string, type: string, scope?: string }[] } }} next
 */
export function analyzeCompatibility(previous, next) {
  const restart = reason => ({ mode: 'restart', reason, preserve: [], reset: [], added: [], removed: [] })
  if (previous.program.version !== next.program.version) return restart('Semantic UI IR version changed')
  if (previous.program.entry !== next.program.entry) return restart(`@main entry changed (${previous.program.entry} → ${next.program.entry})`)
  if (previous.program.root.id !== next.program.root.id) return restart('Root window identity changed')

  const before = new Map(previous.metadata.states.map(state => [state.name, state]))
  const preserve = [], reset = [], added = []
  for (const state of next.metadata.states) {
    const old = before.get(state.name)
    if (!old) added.push(state.name)
    else if (old.type === state.type && (old.scope ?? null) === (state.scope ?? null)) preserve.push(state.name)
    else reset.push({ name: state.name, reason: old.type !== state.type ? `type ${old.type} → ${state.type}` : 'owning keyed scope changed' })
    before.delete(state.name)
  }
  return { mode: 'hot', reason: undefined, preserve, reset, added, removed: [...before.keys()] }
}

/** Human-readable name for a state identity: `Row.on` instead of the full path. */
export function stateLabel(name) {
  const parts = name.split('/')
  const field = parts.at(-1)
  const component = parts.lastIndexOf('component')
  const owner = component >= 0 ? parts[component + 1] : parts[2]
  return `${owner}.${field}`
}
