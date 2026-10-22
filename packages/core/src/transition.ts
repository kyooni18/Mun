import type { Animation } from "./animation.js"
import type { MunStyleProperties } from "./html.js"

export type TransitionEdge = "top" | "bottom" | "leading" | "trailing" | "left" | "right"

export type TransitionEffect =
  | Readonly<{ kind: "opacity" }>
  | Readonly<{ kind: "scale"; scale: number }>
  | Readonly<{ kind: "move"; edge: TransitionEdge; distance: number }>
  | Readonly<{ kind: "blur"; radius: number }>
  /**
   * Renderer-specific escape hatch, like SwiftUI's `.modifier(active:identity:)`.
   * Web animates every listed property between the two styles; numeric tokens
   * inside compound values (`blur(4px)`, `saturate(120%)`) interpolate.
   */
  | Readonly<{ kind: "style"; active: Readonly<MunStyleProperties>; identity: Readonly<MunStyleProperties> }>

export interface TransitionDescriptor {
  readonly insertion: readonly TransitionEffect[]
  readonly removal: readonly TransitionEffect[]
  readonly animation?: Animation
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function normalizedEffects(effects: readonly TransitionEffect[]): readonly TransitionEffect[] {
  const result: TransitionEffect[] = []
  const seen = new Set<string>()
  for (const effect of effects) {
    // Style effects are opaque to dedupe: two may target different properties.
    const key = effect.kind === "move" ? `move:${effect.edge}` : effect.kind === "style" ? undefined : effect.kind
    if (key !== undefined && seen.has(key)) continue
    if (key !== undefined) seen.add(key)
    result.push(Object.freeze(effect.kind === "style"
      ? { kind: "style", active: Object.freeze({ ...effect.active }), identity: Object.freeze({ ...effect.identity }) }
      : { ...effect }))
  }
  return Object.freeze(result)
}

/**
 * Renderer-independent insertion/removal transition.
 *
 * The graph stores lifecycle semantics while each renderer decides how to
 * materialize them. Web uses WAAPI when available and keeps removal logically
 * separate from the live reconciliation tree while the exit animation runs.
 */
export class Transition {
  readonly descriptor: TransitionDescriptor

  private constructor(descriptor: TransitionDescriptor) {
    this.descriptor = Object.freeze({
      insertion: normalizedEffects(descriptor.insertion),
      removal: normalizedEffects(descriptor.removal),
      ...(descriptor.animation ? { animation: descriptor.animation } : {}),
    })
    Object.freeze(this)
  }

  static readonly identity = new Transition({ insertion: [], removal: [] })
  static readonly opacity = new Transition({ insertion: [{ kind: "opacity" }], removal: [{ kind: "opacity" }] })

  static scale(scale = 0.95): Transition {
    const normalized = finitePositive(scale, 0.95)
    return new Transition({
      insertion: [{ kind: "scale", scale: normalized }],
      removal: [{ kind: "scale", scale: normalized }],
    })
  }

  static move(edge: TransitionEdge, distance = 24): Transition {
    const normalized = finitePositive(Math.abs(distance), 24)
    return new Transition({
      insertion: [{ kind: "move", edge, distance: normalized }],
      removal: [{ kind: "move", edge, distance: normalized }],
    })
  }

  /** Blurs the view in from / out to `radius`. */
  static blur(radius = 8): Transition {
    const normalized = finitePositive(radius, 8)
    return new Transition({
      insertion: [{ kind: "blur", radius: normalized }],
      removal: [{ kind: "blur", radius: normalized }],
    })
  }

  /**
   * Animates between an `active` style (before insertion / after removal) and
   * the `identity` style (while present). Web-only; other renderers ignore it.
   */
  static modifier(active: MunStyleProperties, identity: MunStyleProperties): Transition {
    const effect: TransitionEffect = { kind: "style", active, identity }
    return new Transition({ insertion: [effect], removal: [effect] })
  }

  static asymmetric(insertion: Transition, removal: Transition): Transition {
    return new Transition({
      insertion: insertion.descriptor.insertion,
      removal: removal.descriptor.removal,
      animation: insertion.descriptor.animation ?? removal.descriptor.animation,
    })
  }

  combined(withTransition: Transition): Transition {
    return new Transition({
      insertion: [...this.descriptor.insertion, ...withTransition.descriptor.insertion],
      removal: [...this.descriptor.removal, ...withTransition.descriptor.removal],
      animation: this.descriptor.animation ?? withTransition.descriptor.animation,
    })
  }

  animation(animation: Animation): Transition {
    return new Transition({ ...this.descriptor, animation })
  }
}
