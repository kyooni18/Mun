import {
  cloneElement,
  createContext,
  createElement,
  isValidElement,
  useEffect,
  useContext,
  useId,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { layoutChild, layoutChildren, markIntrinsic } from './layout.js'
import { isStateRef, resolveValue } from './state.js'
import { defineView, initializer, initializerKinds, type ViewCallable } from './view-system.js'
import { collectChildren, type MunBuilder } from './builder.js'
import { viewElement, viewGraphChild, viewGraphChildren, viewHost, type ViewNode } from './runtime/view-graph.js'
import type { StateRef, StyledElement, Value } from './types.js'

export interface RouterLike {
  push(destination: unknown): unknown
  back?(): unknown
}

const NavigationContext = createContext<RouterLike | null>(null)

type PresentationViewCallable<Call extends (...args: any[]) => any> = ViewCallable<Call>

function flatten(children: ReactNode[]): ReactNode[] {
  const result: ReactNode[] = []
  for (const child of children) {
    if (Array.isArray(child)) result.push(...flatten(child))
    else result.push(child)
  }
  return result
}

function content(value: ReactNode | Value<string | number>): ReactNode {
  if (isValidElement(value) || Array.isArray(value)) return value as ReactNode
  if (isStateRef(value) || typeof value === 'function') {
    return String(resolveValue(value as Value<string | number>))
  }
  return value as ReactNode
}

const noTrailingFunction = (args: readonly unknown[]) => args.length > 0
  && !args.slice(1).some(value => typeof value === 'function')

interface NavigationStackHostProps {
  router: RouterLike
  children: ReactNode[]
}

function NavigationStackHost({ router, children }: NavigationStackHostProps) {
  return createElement(
    'div',
    { 'data-mun-navigation-stack': '' },
    createElement(
      NavigationContext.Provider,
      { value: router },
      ...layoutChildren(flatten(children)),
    ),
  )
}

function navigationStackGraph(props: object): ViewNode {
  const { children } = props as NavigationStackHostProps
  return viewElement('div', { 'data-mun-navigation-stack': '' }, viewGraphChildren(
    layoutChildren(flatten(children)),
  ))
}

interface NavigationLinkHostProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  destination: unknown
}

function NavigationLinkHost({ destination, children, onClick, ...props }: NavigationLinkHostProps) {
  const router = useContext(NavigationContext)
  return createElement('a', {
    ...props,
    href: props.href ?? (typeof destination === 'string' ? destination : undefined),
    onClick(event: ReactMouseEvent<HTMLAnchorElement>) {
      onClick?.(event)
      if (event.defaultPrevented) return
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (props.target === '_blank' || !router) return
      event.preventDefault()
      router.push(destination)
    },
    style: {
      color: 'inherit',
      textDecoration: 'inherit',
      display: 'block',
      width: '100%',
      height: '100%',
      ...props.style,
    },
  }, children)
}

const NavigationStackView = defineView('NavigationStack', {
  name: 'NavigationStack',
  initializers: [
    initializer(
      'NavigationStack(router, @ViewBuilder content)',
      args => args.length === 2 && typeof args[1] === 'function',
      args => ({
        router: args[0],
        children: flatten(collectChildren([args[1]]) as ReactNode[]),
      }),
      [initializerKinds.value(true, 'router'), initializerKinds.viewBuilder(true, 'content')],
    ),
    initializer('NavigationStack(router, ...children)', noTrailingFunction, args => ({
      router: args[0],
      children: flatten(args.slice(1) as ReactNode[]),
    })),
  ],
  body(props: NavigationStackHostProps) {
    return viewHost('NavigationStack', NavigationStackHost, props, navigationStackGraph)
  },
}) as unknown as PresentationViewCallable<{
  (router: RouterLike, ...children: Array<ReactNode | MunBuilder>): StyledElement
}>

export const NavigationStack = NavigationStackView

export type NavigationLinkProps = Omit<NavigationLinkHostProps, 'destination' | 'children'>

const NavigationLinkView = defineView('NavigationLink', {
  name: 'NavigationLink',
  initializers: [initializer(
    'NavigationLink(destination, label, props?)',
    args => args.length >= 2 && args.length <= 3 && (args.length < 3 || typeof args[2] === 'object'),
    args => ({
      ...(args[2] as NavigationLinkProps | undefined ?? {}),
      destination: args[0],
      children: content(args[1] as ReactNode | Value<string | number>),
    }),
    [initializerKinds.value(true, 'destination'), initializerKinds.value(true, 'label'), initializerKinds.value(false, 'props')],
  )],
  body(props: NavigationLinkHostProps & { children: ReactNode }) {
    return viewHost('NavigationLink', NavigationLinkHost, props, value => {
      const { destination: fallbackTarget, children: fallbackChildren, ...fallbackProps } = value as NavigationLinkHostProps & { children: ReactNode }
      return viewElement('a', {
        ...fallbackProps,
        href: fallbackProps.href ?? (typeof fallbackTarget === 'string' ? fallbackTarget : undefined),
        style: {
          color: 'inherit',
          textDecoration: 'inherit',
          display: 'block',
          width: '100%',
          height: '100%',
          ...fallbackProps.style,
        },
      }, [viewGraphChild(fallbackChildren)])
    })
  },
}) as unknown as PresentationViewCallable<{
  (destination: unknown, label: ReactNode | Value<string | number>, props?: NavigationLinkProps): StyledElement
}>

export const NavigationLink = NavigationLinkView

export interface SheetOptions {
  target?: string
  dismissOnBackdrop?: boolean
  ariaLabel?: string
  ariaLabelledBy?: string
  ariaDescribedBy?: string
  role?: 'dialog' | 'alertdialog'
  placement?: 'bottom' | 'center'
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    'a[href], area[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter(element => element.getAttribute('aria-hidden') !== 'true')
}

interface SheetHostProps {
  isPresented: StateRef<boolean>
  sheetContent: ReactNode
  options: SheetOptions
}

function SheetHost({ isPresented, sheetContent, options }: SheetHostProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    const panel = panelRef.current
    if (!mounted || !panel || !isPresented.value) return undefined
    const backdrop = panel.parentElement
    if (backdrop) {
      const backdrops = [...document.querySelectorAll<HTMLElement>('[data-mun-sheet-backdrop]')]
      backdrop.style.zIndex = String(1000 + Math.max(0, backdrops.indexOf(backdrop)))
    }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusables = focusableElements(panel)
    ;(focusables[0] ?? panel).focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        isPresented.value = false
        return
      }
      if (event.key !== 'Tab') return
      const current = focusableElements(panel)
      if (current.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = current[0]
      const last = current[current.length - 1]
      if (!panel.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    panel.addEventListener('keydown', onKeyDown)
    return () => {
      panel.removeEventListener('keydown', onKeyDown)
      if (previous?.isConnected) previous.focus()
    }
  }, [isPresented, mounted])

  if (!mounted || !isPresented.value || typeof document === 'undefined') return null
  const target = options.target ? document.querySelector(options.target) : document.body
  if (!target) return null

  const panelRadius = options.placement === 'center' ? '16px' : '16px 16px 0 0'
  const backdrop = createElement('div', {
    'data-mun-sheet-backdrop': '',
    role: 'presentation',
    onClick(event: ReactMouseEvent<HTMLDivElement>) {
      if (options.dismissOnBackdrop === false) return
      if (event.target === event.currentTarget) isPresented.value = false
    },
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 1000,
      display: 'grid',
      ...(options.placement === 'center' ? { placeItems: 'center' } : { alignItems: 'end' }),
      background: 'rgba(0, 0, 0, 0.32)',
    },
  }, createElement('div', {
    ref: panelRef,
    'data-mun-sheet': '',
    role: options.role ?? 'dialog',
    'aria-modal': true,
    'aria-label': options.ariaLabel,
    'aria-labelledby': options.ariaLabelledBy,
    'aria-describedby': options.ariaDescribedBy,
    tabIndex: -1,
    style: {
      minWidth: 0,
      maxHeight: '90vh',
      overflow: 'auto',
      background: 'Canvas',
      color: 'CanvasText',
      borderRadius: panelRadius,
    },
  }, layoutChild(sheetContent)))

  return createPortal(backdrop, target)
}

markIntrinsic(SheetHost)

function sheetGraph(props: object): ViewNode {
  const { sheetContent, options } = props as SheetHostProps
  const panelRadius = options.placement === 'center' ? '16px' : '16px 16px 0 0'
  return viewElement('div', {
    'data-mun-sheet-backdrop': '',
    role: 'presentation',
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 1000,
      display: 'grid',
      ...(options.placement === 'center' ? { placeItems: 'center' } : { alignItems: 'end' }),
      background: 'rgba(0, 0, 0, 0.32)',
    },
  }, [viewElement('div', {
    'data-mun-sheet': '',
    role: options.role ?? 'dialog',
    'aria-modal': true,
    'aria-label': options.ariaLabel,
    'aria-labelledby': options.ariaLabelledBy,
    'aria-describedby': options.ariaDescribedBy,
    tabIndex: -1,
    style: {
      minWidth: 0,
      maxHeight: '90vh',
      overflow: 'auto',
      background: 'Canvas',
      color: 'CanvasText',
      borderRadius: panelRadius,
    },
  }, [viewGraphChild(layoutChild(sheetContent))])])
}

const SheetView = defineView('Sheet', {
  name: 'Sheet',
  initializers: [initializer(
    'Sheet(isPresented, @ViewBuilder content, options?)',
    args => args.length >= 2 && args.length <= 3 && (args.length < 3 || typeof args[2] === 'object'),
    args => ({
      isPresented: args[0],
      sheetContent: typeof args[1] === 'function' ? collectChildren([args[1]]) : args[1],
      options: (args[2] as SheetOptions | undefined) ?? {},
    }),
    [initializerKinds.value(true, 'isPresented'), initializerKinds.viewBuilder(true, 'content'), initializerKinds.value(false, 'options', ['target', 'dismissOnBackdrop', 'ariaLabel', 'ariaLabelledBy', 'ariaDescribedBy', 'role', 'placement'])],
  )],
  body(props: SheetHostProps) {
    if (!props.isPresented.value) return null
    return viewHost('Sheet', SheetHost, props, sheetGraph)
  },
}) as unknown as PresentationViewCallable<{
  (isPresented: StateRef<boolean>, sheetContent: ReactNode, options?: SheetOptions): ReactNode
}>

export const Sheet = SheetView

export interface AlertAction {
  label: string
  action?: () => unknown
  role?: 'default' | 'cancel' | 'destructive'
}

export interface AlertOptions {
  title: string
  message?: string
  actions?: readonly AlertAction[]
  target?: string
}

interface AlertHostProps {
  isPresented: StateRef<boolean>
  options: AlertOptions
}

function AlertHost({ isPresented, options }: AlertHostProps): ReactNode {
  const actions = options.actions?.length ? options.actions : [{ label: 'OK', role: 'cancel' as const }]
  const identifier = useId().replace(/[^a-zA-Z0-9_-]/g, '-')
  const titleId = `mun-alert-title-${identifier}`
  const messageId = `mun-alert-message-${identifier}`
  const dialog = createElement('div', {
    style: {
      width: 'min(420px, calc(100vw - 32px))',
      padding: '20px',
      background: 'Canvas',
      color: 'CanvasText',
      borderRadius: '14px',
      boxShadow: '0 16px 50px rgba(0,0,0,0.28)',
    },
  },
  createElement('strong', { id: titleId }, options.title),
  options.message === undefined ? null : createElement('p', { id: messageId }, options.message),
  createElement('div', {
    style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
  }, ...actions.map(action => createElement('button', {
    key: action.label,
    type: 'button',
    'data-role': action.role ?? 'default',
    onClick() {
      action.action?.()
      isPresented.value = false
    },
  }, action.label))))

  return Sheet(isPresented, dialog, {
    target: options.target,
    dismissOnBackdrop: false,
    ariaLabelledBy: titleId,
    ...(options.message === undefined ? {} : { ariaDescribedBy: messageId }),
    role: 'alertdialog',
    placement: 'center',
  })
}

markIntrinsic(AlertHost)

function alertGraph(props: object): ViewNode {
  const { options } = props as AlertHostProps
  const actions = options.actions?.length ? options.actions : [{ label: 'OK', role: 'cancel' as const }]
  return viewElement('div', {
    role: 'alertdialog',
    'aria-modal': true,
    'aria-label': options.title,
  }, [
    viewElement('strong', null, [options.title]),
    options.message === undefined ? null : viewElement('p', null, [options.message]),
    viewElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, actions.map(action =>
      viewElement('button', {
        type: 'button',
        'data-role': action.role ?? 'default',
        onClick: action.action,
      }, [action.label]),
    )),
  ])
}

const AlertView = defineView('Alert', {
  name: 'Alert',
  initializers: [initializer(
    'Alert(isPresented, options)',
    args => args.length === 2 && typeof args[1] === 'object',
    args => ({ isPresented: args[0], options: args[1] }),
    [initializerKinds.value(true, 'isPresented'), initializerKinds.value(true, 'options', ['title', 'message', 'actions', 'target'])],
  )],
  body(props: AlertHostProps) {
    if (!props.isPresented.value) return null
    return viewHost('Alert', AlertHost, props, alertGraph)
  },
}) as unknown as PresentationViewCallable<{
  (isPresented: StateRef<boolean>, options: AlertOptions): ReactNode
}>

export const Alert = AlertView

interface MenuHostProps {
  label: ReactNode | Value<string | number>
  items: ReactNode[]
}

function MenuHost({ label, items }: MenuHostProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const menuIdentifier = useId().replace(/[^a-zA-Z0-9_-]/g, '-')
  const typeaheadRef = useRef('')
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressCloseFocusRef = useRef(false)

  useEffect(() => () => {
    if (typeaheadTimerRef.current !== null) clearTimeout(typeaheadTimerRef.current)
  }, [])

  const menuItems = layoutChildren(items).map((item, index) => {
    if (!isValidElement(item)) return item
    const props = item.props as {
      disabled?: boolean
      ['aria-disabled']?: boolean | 'true' | 'false'
      onClick?: (event: unknown) => unknown
    }
    const disabled = props.disabled === true || props['aria-disabled'] === true || props['aria-disabled'] === 'true'
    const originalOnClick = props.onClick
    return cloneElement(item, {
      role: 'menuitem',
      tabIndex: -1,
      'aria-disabled': disabled ? true : props['aria-disabled'],
      key: item.key ?? index,
      onClick(event: unknown) {
        if (disabled) return
        originalOnClick?.(event)
        const details = detailsRef.current
        details?.removeAttribute('open')
        details?.querySelector('summary')?.focus()
      },
    } as any)
  })

  const enabledItems = () => [...(detailsRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    .filter(item => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true')

  const focusItem = (index: number) => {
    const itemsInMenu = enabledItems()
    if (itemsInMenu.length === 0) return
    itemsInMenu[Math.max(0, Math.min(index, itemsInMenu.length - 1))]?.focus()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDetailsElement>) => {
    const details = detailsRef.current
    if (!details) return
    const itemsInMenu = enabledItems()
    const currentIndex = itemsInMenu.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Escape' && details.open) {
      event.preventDefault()
      details.removeAttribute('open')
      details.querySelector('summary')?.focus()
    } else if (event.key === 'Tab' && details.open) {
      suppressCloseFocusRef.current = true
      details.removeAttribute('open')
    } else if (event.key === 'ArrowDown' && details.open) {
      event.preventDefault()
      focusItem(currentIndex < 0 ? 0 : currentIndex + 1)
    } else if (event.key === 'ArrowUp' && details.open) {
      event.preventDefault()
      focusItem(currentIndex < 0 ? itemsInMenu.length - 1 : currentIndex - 1)
    } else if (event.key === 'Home' && details.open) {
      event.preventDefault()
      focusItem(0)
    } else if (event.key === 'End' && details.open) {
      event.preventDefault()
      focusItem(itemsInMenu.length - 1)
    } else if (details.open && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typeaheadRef.current += event.key.toLowerCase()
      if (typeaheadTimerRef.current !== null) clearTimeout(typeaheadTimerRef.current)
      typeaheadTimerRef.current = setTimeout(() => { typeaheadRef.current = '' }, 500)
      const match = itemsInMenu.find(item => item.textContent?.trim().toLowerCase().startsWith(typeaheadRef.current))
      if (match) {
        event.preventDefault()
        match.focus()
      }
    }
  }

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const details = event.currentTarget
    if (details.open) {
      queueMicrotask(() => focusItem(0))
    } else if (suppressCloseFocusRef.current) {
      suppressCloseFocusRef.current = false
    } else {
      details.querySelector('summary')?.focus()
    }
  }

  return createElement('details', { ref: detailsRef, 'data-mun-menu': '', onKeyDown, onToggle },
    createElement('summary', {
      id: `${menuIdentifier}-trigger`,
      'aria-haspopup': 'menu',
      'aria-controls': `${menuIdentifier}-items`,
      style: { cursor: 'pointer' },
    }, content(label)),
    createElement('div', {
      id: `${menuIdentifier}-items`,
      role: 'menu',
      'aria-labelledby': `${menuIdentifier}-trigger`,
      style: { display: 'flex', flexDirection: 'column', minWidth: 'max-content' },
    }, ...menuItems),
  )
}

function menuGraph(props: object): ViewNode {
  const { label, items } = props as MenuHostProps
  return viewElement('details', { 'data-mun-menu': '' }, [
    viewElement('summary', { 'aria-haspopup': 'menu', style: { cursor: 'pointer' } }, [
      viewGraphChild(content(label)),
    ]),
    viewElement('div', {
      role: 'menu',
      style: { display: 'flex', flexDirection: 'column', minWidth: 'max-content' },
    }, viewGraphChildren(layoutChildren(items))),
  ])
}

const MenuView = defineView('Menu', {
  name: 'Menu',
  initializers: [
    initializer(
      'Menu(label, @ViewBuilder content)',
      args => args.length === 2 && typeof args[1] === 'function',
      args => ({
        label: args[0],
        items: flatten(collectChildren([args[1]]) as ReactNode[]),
      }),
      [initializerKinds.value(true, 'label'), initializerKinds.viewBuilder(true, 'content')],
    ),
    initializer('Menu(label, ...items)', noTrailingFunction, args => ({
      label: args[0],
      items: flatten(args.slice(1) as ReactNode[]),
    })),
  ],
  body(props: MenuHostProps) {
    return viewHost('Menu', MenuHost, props, menuGraph)
  },
}) as unknown as PresentationViewCallable<{
  (label: ReactNode | Value<string | number>, ...items: Array<ReactNode | MunBuilder>): StyledElement
}>

export const Menu = MenuView
