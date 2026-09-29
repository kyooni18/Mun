import { useRef } from 'react'
import {
  createViewIdentityStore as createCoreViewIdentityStore,
  ViewIdentityStore as CoreViewIdentityStore,
} from '@mun/core/compat'

/**
 * Per-mounted-View storage. The storage is owned by Mun's View runtime; the
 * React hook is only the host-specific lifetime primitive used underneath.
 */
export interface ViewIdentityStorage<T> {
  initialized: boolean
  value: T | undefined
}

/** Renderer-independent lifetime store keyed by a mounted View identity. */
export type ViewIdentityStore = CoreViewIdentityStore

export function createViewIdentityStore<T>(): ViewIdentityStore {
  return createCoreViewIdentityStore()
}

export function useViewIdentityStorage<T>(factory: () => T): T {
  const identity = useRef<object | null>(null)
  if (identity.current === null) identity.current = {}
  const store = useRef<ViewIdentityStore | null>(null)
  if (store.current === null) store.current = createViewIdentityStore<T>()
  return store.current.getOrCreate(identity.current, factory)
}
