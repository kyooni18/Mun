import { useSyncExternalStore } from "react"
import {
  collectStateReads,
  isBinding,
  isStateRef,
  stateVersion,
  subscribeState,
} from "@mun/core/compat"
import type { StateRef as CoreStateRef } from "@mun/core/compat"
import type { BindingRef, StateRef, Value } from "./types.js"

/** React is only the subscription adapter; storage and Binding live in core. */
export {
  Action,
  Binding,
  State,
  isBinding,
  isStateRef,
} from "@mun/core/compat"
export { collectStateReads, stateVersion, subscribeState } from "@mun/core/compat"
export type { BindingRef, StateRef, Value }

export function resolveValue<T>(value: Value<T>): T {
  if (typeof value === "function") return (value as () => T)()
  if (isStateRef(value) || isBinding(value)) return value.value as T
  return value as T
}

export function useReactiveValue<T>(compute: () => T): T {
  const dependencies = new Set<CoreStateRef<unknown>>()
  const value = collectStateReads(compute, state => dependencies.add(state))
  const getVersion = () => [...dependencies].reduce((version, state) => version + stateVersion(state), 0)

  useSyncExternalStore(
    listener => {
      const unsubscribers = [...dependencies].map(state => subscribeState(state, listener))
      return () => unsubscribers.forEach(unsubscribe => unsubscribe())
    },
    getVersion,
    getVersion,
  )
  return value
}
