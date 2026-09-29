const stateArraySubscriptionSnapshot = Symbol("mun.state.array-subscription-snapshot")

export type StateArraySubscriptionSnapshotHook = () => readonly unknown[] | undefined

export function stateArraySubscriptionSnapshotSymbol(): symbol {
  return stateArraySubscriptionSnapshot
}

export function snapshotStateArrayForSubscription(value: unknown): readonly unknown[] | undefined {
  if (typeof value !== "object" || value === null) return undefined
  try {
    const hook = Reflect.get(value, stateArraySubscriptionSnapshot)
    return typeof hook === "function" ? (hook as StateArraySubscriptionSnapshotHook)() : undefined
  } catch {
    return undefined
  }
}
