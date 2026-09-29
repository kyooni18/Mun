import { Animation, animationCSSStyle, type Transition, type TransitionEffect } from "@mun/core/compat"

export interface WebTransitionPlayback {
  readonly durationMs: number
  cancel(): void
}

function transformPart(effect: TransitionEffect): string | undefined {
  if (effect.kind === "scale") return `scale(${effect.scale})`
  if (effect.kind !== "move") return undefined
  const distance = effect.distance
  switch (effect.edge) {
    case "top": return `translate3d(0, -${distance}px, 0)`
    case "bottom": return `translate3d(0, ${distance}px, 0)`
    case "leading":
    case "left": return `translate3d(-${distance}px, 0, 0)`
    case "trailing":
    case "right": return `translate3d(${distance}px, 0, 0)`
  }
}

function reducedMotion(element: Element): boolean {
  try {
    return element.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  } catch {
    return false
  }
}

function currentPresentation(element: Element): { opacity: string; transform: string } {
  try {
    const style = element.ownerDocument.defaultView?.getComputedStyle?.(element)
    return {
      opacity: style?.opacity || "1",
      transform: style?.transform && style.transform !== "none" ? style.transform : "",
    }
  } catch {
    return { opacity: "1", transform: "" }
  }
}

export function transitionFrames(
  transition: Transition,
  entering: boolean,
  current: { opacity?: string; transform?: string } = {},
): [Keyframe, Keyframe] {
  const effects = entering ? transition.descriptor.insertion : transition.descriptor.removal
  const baseOpacity = current.opacity || "1"
  const baseTransform = current.transform && current.transform !== "none" ? current.transform : ""
  const hasOpacity = effects.some(effect => effect.kind === "opacity")
  const extras = effects.map(transformPart).filter((value): value is string => Boolean(value))
  const transformed = [baseTransform, ...extras].filter(Boolean).join(" ") || "none"
  const identityTransform = baseTransform || "none"
  const inactive: Keyframe = {
    ...(hasOpacity ? { opacity: 0 } : {}),
    ...(extras.length > 0 ? { transform: transformed } : {}),
  }
  const active: Keyframe = {
    ...(hasOpacity ? { opacity: Number.parseFloat(baseOpacity) || 1 } : {}),
    ...(extras.length > 0 ? { transform: identityTransform } : {}),
  }
  return entering ? [inactive, active] : [active, inactive]
}

export function transitionDurationMs(transition: Transition, fallback?: Animation | null): number {
  const animation = transition.descriptor.animation ?? fallback ?? Animation.default
  const style = animationCSSStyle(animation)
  if (!style) return 0
  const duration = Number.parseFloat(style.transitionDuration) * 1000
  const delay = Number.parseFloat(style.transitionDelay) * 1000
  return Math.max(0, Number.isFinite(duration) ? duration : 0) + Math.max(0, Number.isFinite(delay) ? delay : 0)
}

export function playWebTransition(
  element: Element,
  transition: Transition,
  entering: boolean,
  fallbackAnimation: Animation | null | undefined,
  onFinish?: () => void,
): WebTransitionPlayback {
  const effects = entering ? transition.descriptor.insertion : transition.descriptor.removal
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let animation: globalThis.Animation | undefined
  const finish = () => {
    if (finished) return
    finished = true
    if (timer !== undefined) clearTimeout(timer)
    try { animation?.cancel() } catch { /* best effort */ }
    onFinish?.()
  }
  if (effects.length === 0 || reducedMotion(element)) {
    queueMicrotask(finish)
    return { durationMs: 0, cancel: finish }
  }

  const chosen = transition.descriptor.animation ?? fallbackAnimation ?? Animation.default
  const css = animationCSSStyle(chosen)
  const duration = Math.max(0, Number.parseFloat(css?.transitionDuration ?? "0") * 1000 || 0)
  const delay = Math.max(0, Number.parseFloat(css?.transitionDelay ?? "0") * 1000 || 0)
  const total = duration + delay
  const frames = transitionFrames(transition, entering, currentPresentation(element))
  const animate = (element as Element & { animate?: Element["animate"] }).animate
  if (typeof animate === "function") {
    try {
      animation = animate.call(element, frames, {
        duration,
        delay,
        easing: css?.transitionTimingFunction ?? "ease",
        // Keep the insertion/removal start frame applied during a delay. With
        // `none`, a delayed enter briefly exposes the live final DOM state and
        // then jumps backwards when playback begins.
        fill: "backwards",
      })
      animation.addEventListener("finish", finish, { once: true })
      animation.addEventListener("cancel", finish, { once: true })
      // Some synthetic DOM implementations expose animate() but never dispatch
      // finish. The timer is a bounded fallback, not a second animation clock.
      timer = setTimeout(finish, total + 34)
      return { durationMs: total, cancel: finish }
    } catch {
      // Fall back to a lifecycle timer below. Rendering semantics still hold.
    }
  }
  timer = setTimeout(finish, total)
  return { durationMs: total, cancel: finish }
}
