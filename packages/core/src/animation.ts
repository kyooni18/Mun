/** Renderer-independent SwiftUI-style animation and transaction primitives. */

export type AnimationKind = "linear" | "easeIn" | "easeOut" | "easeInOut" | "spring"

const animationFactoryArgumentLabels = Object.freeze({
  linear: Object.freeze(["duration"]),
  easeIn: Object.freeze(["duration"]),
  easeOut: Object.freeze(["duration"]),
  easeInOut: Object.freeze(["duration"]),
  spring: Object.freeze(["response", "dampingFraction", "blendDuration"]),
  interactiveSpring: Object.freeze(["response", "dampingFraction", "blendDuration"]),
  smooth: Object.freeze(["duration", "extraBounce"]),
  snappy: Object.freeze(["duration", "extraBounce"]),
  bouncy: Object.freeze(["duration", "extraBounce"]),
} as const)

/** Compiler-facing labels for Swift-style Animation factory calls. */
export function swiftUIAnimationFactoryArgumentLabels(name: string): readonly string[] | undefined {
  return animationFactoryArgumentLabels[name as keyof typeof animationFactoryArgumentLabels]
}

export interface AnimationDescriptor {
  readonly kind: AnimationKind
  readonly duration: number
  readonly delay: number
  readonly speed: number
  readonly repeatCount?: number
  readonly autoreverses?: boolean
  readonly response?: number
  readonly dampingFraction?: number
  readonly blendDuration?: number
}

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function freezeDescriptor(value: AnimationDescriptor): AnimationDescriptor {
  return Object.freeze({ ...value })
}

/**
 * The way a View changes over time.
 *
 * The public surface deliberately follows SwiftUI naming. The current web
 * backends translate this value to CSS/WAAPI-compatible timing; the value is
 * renderer independent so that translation can later be replaced by Mun's
 * own clock/interpolator without changing authoring code.
 */
export class Animation {
  readonly descriptor: AnimationDescriptor

  private constructor(descriptor: AnimationDescriptor) {
    this.descriptor = freezeDescriptor(descriptor)
    Object.freeze(this)
  }

  /** The standard Mun motion preset used when no animation is specified. */
  static readonly default = Animation.spring()

  static linear(duration = 0.35): Animation {
    return new Animation({ kind: "linear", duration: finiteNonNegative(duration, 0.35), delay: 0, speed: 1 })
  }

  static easeIn(duration = 0.35): Animation {
    return new Animation({ kind: "easeIn", duration: finiteNonNegative(duration, 0.35), delay: 0, speed: 1 })
  }

  static easeOut(duration = 0.35): Animation {
    return new Animation({ kind: "easeOut", duration: finiteNonNegative(duration, 0.35), delay: 0, speed: 1 })
  }

  static easeInOut(duration = 0.35): Animation {
    return new Animation({ kind: "easeInOut", duration: finiteNonNegative(duration, 0.35), delay: 0, speed: 1 })
  }

  static spring(response = 0.55, dampingFraction = 0.825, blendDuration = 0): Animation {
    return new Animation({
      kind: "spring",
      duration: finiteNonNegative(response, 0.55),
      delay: 0,
      speed: 1,
      response: finitePositive(response, 0.55),
      dampingFraction: finiteNonNegative(dampingFraction, 0.825),
      blendDuration: finiteNonNegative(blendDuration, 0),
    })
  }

  static interactiveSpring(response = 0.15, dampingFraction = 0.86, blendDuration = 0.25): Animation {
    return Animation.spring(response, dampingFraction, blendDuration)
  }

  static smooth(duration = 0.5, extraBounce = 0): Animation {
    const damping = Math.max(0.55, Math.min(1, 1 - finiteNonNegative(extraBounce, 0) * 0.25))
    return Animation.spring(duration, damping, 0)
  }

  static snappy(duration = 0.5, extraBounce = 0): Animation {
    const damping = Math.max(0.45, Math.min(0.92, 0.86 - finiteNonNegative(extraBounce, 0) * 0.3))
    return Animation.spring(duration, damping, 0)
  }

  static bouncy(duration = 0.5, extraBounce = 0): Animation {
    const damping = Math.max(0.3, Math.min(0.8, 0.7 - finiteNonNegative(extraBounce, 0) * 0.35))
    return Animation.spring(duration, damping, 0)
  }

  delay(delay: number): Animation {
    return new Animation({ ...this.descriptor, delay: finiteNonNegative(delay, 0) })
  }

  speed(speed: number): Animation {
    return new Animation({ ...this.descriptor, speed: finitePositive(speed, 1) })
  }

  repeatCount(repeatCount: number, autoreverses = true): Animation {
    return new Animation({
      ...this.descriptor,
      repeatCount: Math.max(1, Math.floor(finitePositive(repeatCount, 1))),
      autoreverses,
    })
  }

  repeatForever(autoreverses = true): Animation {
    return new Animation({ ...this.descriptor, repeatCount: Number.POSITIVE_INFINITY, autoreverses })
  }
}

export interface TransactionOptions {
  readonly animation?: Animation | null
  readonly disablesAnimations?: boolean
  readonly isContinuous?: boolean
}

/** Context for a state-processing update, matching SwiftUI's Transaction role. */
export class Transaction {
  animation: Animation | null
  disablesAnimations: boolean
  isContinuous: boolean

  constructor(animation?: Animation | null)
  constructor(options?: TransactionOptions)
  constructor(value: Animation | null | TransactionOptions = null) {
    if (value instanceof Animation || value === null) {
      this.animation = value
      this.disablesAnimations = false
      this.isContinuous = false
    } else {
      this.animation = value.animation ?? null
      this.disablesAnimations = value.disablesAnimations ?? false
      this.isContinuous = value.isContinuous ?? false
    }
  }
}

const transactionStack: Transaction[] = []
const renderTransactionStack: Transaction[] = []
const emptyTransaction = Object.freeze(new Transaction()) as Transaction

export function snapshotTransaction(transaction: Transaction | undefined | null): Transaction {
  if (!transaction) return new Transaction()
  return new Transaction({
    animation: transaction.animation,
    disablesAnimations: transaction.disablesAnimations,
    isContinuous: transaction.isContinuous,
  })
}

/** Current mutation transaction. State writes snapshot this value. */
export function currentTransaction(): Transaction {
  return transactionStack.at(-1) ?? emptyTransaction
}

/** Current renderer transaction. Renderers use this for the initial wrapper backend. */
export function currentRenderTransaction(): Transaction {
  return renderTransactionStack.at(-1) ?? emptyTransaction
}

export function withTransaction<Result>(transaction: Transaction, body: () => Result): Result {
  transactionStack.push(transaction)
  try {
    return body()
  } finally {
    transactionStack.pop()
  }
}

export function withAnimation<Result>(animation: Animation | null = Animation.default, body: () => Result): Result {
  const transaction = snapshotTransaction(currentTransaction())
  transaction.animation = animation
  return withTransaction(transaction, body)
}

/** Internal renderer bridge; exported so first-party renderers share one contract. */
export function withRenderTransaction<Result>(transaction: Transaction | undefined, body: () => Result): Result {
  if (!transaction) return body()
  renderTransactionStack.push(transaction)
  try {
    return body()
  } finally {
    // Only pop our own frame; a body that left a foreign frame on the stack
    // must not have it silently discarded.
    if (renderTransactionStack.at(-1) === transaction) renderTransactionStack.pop()
  }
}

export interface AnimationCSSStyle {
  readonly transitionProperty: string
  readonly transitionDuration: string
  readonly transitionTimingFunction: string
  readonly transitionDelay: string
}

/**
 * Initial web-wrapper timing translation. This is intentionally not the
 * long-term animation engine.
 *
 * Known limitation: CSS transitions cannot express iteration, so descriptor
 * `repeatCount`/`autoreverses` (including `repeatForever`) have no effect in
 * this translation and repeating animations render once until Mun ships its
 * own clock/interpolator backend.
 */
export function animationCSSStyle(animation: Animation | null | undefined): AnimationCSSStyle | undefined {
  if (!animation) return undefined
  const descriptor = animation.descriptor
  const speed = finitePositive(descriptor.speed, 1)
  const duration = finiteNonNegative(descriptor.duration, 0.35) / speed
  const delay = finiteNonNegative(descriptor.delay, 0) / speed
  const timing = descriptor.kind === "linear" ? "linear"
    : descriptor.kind === "easeIn" ? "cubic-bezier(0.42, 0, 1, 1)"
      : descriptor.kind === "easeOut" ? "cubic-bezier(0, 0, 0.58, 1)"
        : descriptor.kind === "spring" ? "cubic-bezier(0.34, 1.56, 0.64, 1)"
          : "cubic-bezier(0.42, 0, 0.58, 1)"
  return {
    transitionProperty: "opacity, transform, translate, scale, rotate, color, background-color, width, height, min-width, min-height, max-width, max-height",
    transitionDuration: `${duration}s`,
    transitionTimingFunction: timing,
    transitionDelay: `${delay}s`,
  }
}
