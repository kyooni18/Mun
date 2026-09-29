interface PresentationEntry {
  readonly element: HTMLElement
  readonly restoreFocus: Element | null
  readonly kind: "modal" | "popover"
  readonly cleanup: () => void
}

interface PresentationState {
  readonly entries: PresentationEntry[]
  bodyOverflow?: string
}

const presentationStates = new WeakMap<Document, PresentationState>()
const presentationEntries = new WeakMap<HTMLElement, PresentationEntry>()

function stateFor(document: Document): PresentationState {
  let state = presentationStates.get(document)
  if (!state) {
    state = { entries: [] }
    presentationStates.set(document, state)
  }
  return state
}

function focusElement(element: Element | null): void {
  if (!element || !element.isConnected) return
  const focus = (element as HTMLElement).focus
  if (typeof focus !== "function") return
  try { focus.call(element, { preventScroll: true }) } catch {
    try { focus.call(element) } catch { /* best effort */ }
  }
}

function focusableElements(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>(
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
  )].filter(candidate => candidate.isConnected && candidate.getAttribute("aria-hidden") !== "true")
}

function closePresentationElement(element: HTMLElement, kind: "modal" | "popover"): void {
  if (kind === "modal") {
    const close = (element as HTMLDialogElement).close
    if (typeof close === "function") {
      try { close.call(element) } catch { disposeWebPresentation(element) }
    } else {
      element.removeAttribute("open")
      disposeWebPresentation(element)
    }
    return
  }
  const hide = (element as HTMLElement & { hidePopover?: () => void }).hidePopover
  if (typeof hide === "function") {
    try { hide.call(element) } catch { disposeWebPresentation(element) }
  } else {
    disposeWebPresentation(element)
  }
}

function syncScrollLock(document: Document, state: PresentationState): void {
  const body = document.body
  if (!body) return
  const hasModal = state.entries.some(entry => entry.kind === "modal")
  if (hasModal) {
    if (state.bodyOverflow === undefined) state.bodyOverflow = body.style.overflow
    body.style.overflow = "hidden"
  } else if (state.bodyOverflow !== undefined) {
    body.style.overflow = state.bodyOverflow
    state.bodyOverflow = undefined
  }
}

export function activateWebPresentation(element: HTMLElement): void {
  if (presentationEntries.has(element)) return
  const document = element.ownerDocument
  const state = stateFor(document)
  const kind = element.getAttribute("data-mun-presentation") === "popover" ? "popover" : "modal"
  const restoreFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null
  const onPointer = (event: Event) => {
    if (event.target !== element) return
    if (kind === "modal") closePresentationElement(element, kind)
  }
  const onClose = () => disposeWebPresentation(element)
  const onToggle = (event: Event) => {
    const toggle = event as Event & { newState?: string }
    if (toggle.newState === "closed") disposeWebPresentation(element)
  }
  const onKeydown = (event: KeyboardEvent) => {
    const current = stateFor(document).entries.at(-1)
    if (current?.element !== element) return
    if (event.key === "Escape") {
      event.preventDefault()
      closePresentationElement(element, kind)
      return
    }
    if (event.key !== "Tab" || kind !== "modal") return
    const focusable = focusableElements(element)
    if (focusable.length === 0) {
      event.preventDefault()
      focusElement(element)
      return
    }
    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement)
    const nextIndex = event.shiftKey
      ? (activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1)
      : (activeIndex < 0 || activeIndex === focusable.length - 1 ? 0 : activeIndex + 1)
    if (activeIndex < 0 || (event.shiftKey && activeIndex === 0) || (!event.shiftKey && activeIndex === focusable.length - 1)) {
      event.preventDefault()
      focusElement(focusable[nextIndex])
    }
  }
  element.addEventListener("click", onPointer)
  element.addEventListener("close", onClose, { once: true })
  element.addEventListener("toggle", onToggle, { once: true })
  document.addEventListener("keydown", onKeydown, true)
  const entry: PresentationEntry = {
    element,
    restoreFocus,
    kind,
    cleanup: () => {
      element.removeEventListener("click", onPointer)
      element.removeEventListener("close", onClose)
      element.removeEventListener("toggle", onToggle)
      document.removeEventListener("keydown", onKeydown, true)
    },
  }
  presentationEntries.set(element, entry)
  state.entries.push(entry)
  syncScrollLock(document, state)

  if (kind === "modal") {
    const dialog = element as HTMLDialogElement
    if (!dialog.open) {
      try {
        if (typeof dialog.showModal === "function") dialog.showModal()
        else dialog.setAttribute("open", "")
      } catch {
        dialog.setAttribute("open", "")
      }
    }
  } else {
    const popover = element as HTMLElement & { showPopover?: () => void }
    if (!element.hasAttribute("popover")) element.setAttribute("popover", "auto")
    try { popover.showPopover?.() } catch { /* unsupported/synthetic document */ }
  }

  if (kind === "modal" && !element.contains(document.activeElement)) {
    const first = focusableElements(element)[0]
    if (first) focusElement(first)
    else {
      if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1")
      focusElement(element)
    }
  }
}

export function disposeWebPresentation(element: HTMLElement): void {
  const entry = presentationEntries.get(element)
  if (!entry) return
  presentationEntries.delete(element)
  entry.cleanup()
  const document = element.ownerDocument
  const state = stateFor(document)
  const index = state.entries.indexOf(entry)
  const wasTop = index === state.entries.length - 1
  if (index >= 0) state.entries.splice(index, 1)
  syncScrollLock(document, state)
  if (wasTop) {
    const nextTop = state.entries.at(-1)
    if (nextTop) focusElement(nextTop.element)
    else focusElement(entry.restoreFocus)
  }
  if (state.entries.length === 0 && state.bodyOverflow === undefined) presentationStates.delete(document)
}

export function activePresentationCount(document: Document): number {
  return presentationStates.get(document)?.entries.length ?? 0
}
