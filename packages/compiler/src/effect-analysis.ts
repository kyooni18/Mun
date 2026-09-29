import * as ts from "typescript"

/**
 * Renderer-neutral facts about a scalar expression that may eventually be
 * lowered into a JS/WASM/WGSL compute kernel. This analysis intentionally
 * proves only syntax-level purity. Type/layout proof is a later compiler stage.
 */
export interface MunScalarEffectFacts {
  /** No call, allocation, mutation, closure, or unknown expression was seen. */
  readonly pure: boolean
  /** The expression reads the collection item parameter. */
  readonly itemDependent: boolean
  /** The expression reads the compiler-provided collection index parameter. */
  readonly indexDependent: boolean
  /** Ambient identifiers read directly as scalar inputs. */
  readonly captures: readonly string[]
  /** Deepest property/element chain rooted in the item parameter. */
  readonly maxItemAccessDepth: number
  /** At least one item element access used a non-literal index. */
  readonly dynamicItemElementAccess: boolean
  /** The expression contains the bare item value, not only one of its fields. */
  readonly bareItem: boolean
  /** Stable diagnostic category for the first intrinsic purity failure. */
  readonly blocker?: MunScalarEffectBlocker
}

export type MunScalarEffectBlocker =
  | "ambient-member-read"
  | "assignment"
  | "comma"
  | "unsupported-expression"

export interface MunScalarEffectPolicy {
  readonly allowCapturedIdentifiers?: boolean
  readonly allowBareItem?: boolean
  readonly allowDynamicItemElementAccess?: boolean
  readonly maxItemAccessDepth?: number
}

export interface MunMapperEffectFacts extends MunScalarEffectFacts {
  readonly itemName: string
  readonly indexName?: string
  readonly allocatesObject: boolean
  readonly spreadsItem: boolean
}

export interface MunScalarFunctionEffectFacts extends MunScalarEffectFacts {
  readonly itemName: string
  readonly indexName?: string
}

interface MutableFacts {
  pure: boolean
  itemDependent: boolean
  indexDependent: boolean
  captures: Set<string>
  maxItemAccessDepth: number
  dynamicItemElementAccess: boolean
  bareItem: boolean
  blocker?: MunScalarEffectBlocker
}

function emptyFacts(): MutableFacts {
  return {
    pure: true,
    itemDependent: false,
    indexDependent: false,
    captures: new Set(),
    maxItemAccessDepth: 0,
    dynamicItemElementAccess: false,
    bareItem: false,
  }
}

export function unwrapCompilerExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)) current = current.expression
  return current
}

function fail(facts: MutableFacts, blocker: MunScalarEffectBlocker): MutableFacts {
  facts.pure = false
  facts.blocker ??= blocker
  return facts
}

function merge(target: MutableFacts, source: MutableFacts): MutableFacts {
  target.pure = target.pure && source.pure
  target.itemDependent ||= source.itemDependent
  target.indexDependent ||= source.indexDependent
  for (const capture of source.captures) target.captures.add(capture)
  target.maxItemAccessDepth = Math.max(target.maxItemAccessDepth, source.maxItemAccessDepth)
  target.dynamicItemElementAccess ||= source.dynamicItemElementAccess
  target.bareItem ||= source.bareItem
  target.blocker ??= source.blocker
  return target
}

function rootItemAccessDepth(
  expression: ts.Expression,
  itemName: string,
  indexName: string | undefined,
): { readonly facts: MutableFacts; readonly depth?: number } {
  const value = unwrapCompilerExpression(expression)
  if (ts.isIdentifier(value)) {
    const facts = analyzeMutable(value, itemName, indexName)
    return { facts, ...(value.text === itemName ? { depth: 0 } : {}) }
  }
  if (ts.isPropertyAccessExpression(value)) {
    const owner = rootItemAccessDepth(value.expression, itemName, indexName)
    if (owner.depth === undefined) {
      // Reading a member from an ambient capture can invoke a getter/proxy and
      // is therefore not portable merely because the identifier itself is.
      if (owner.facts.captures.size > 0) fail(owner.facts, "ambient-member-read")
      return owner
    }
    owner.facts.bareItem = false
    const depth = owner.depth + 1
    owner.facts.maxItemAccessDepth = Math.max(owner.facts.maxItemAccessDepth, depth)
    return { facts: owner.facts, depth }
  }
  if (ts.isElementAccessExpression(value) && value.argumentExpression) {
    const owner = rootItemAccessDepth(value.expression, itemName, indexName)
    const argument = analyzeMutable(value.argumentExpression, itemName, indexName)
    merge(owner.facts, argument)
    if (owner.depth === undefined) {
      if (owner.facts.captures.size > 0) fail(owner.facts, "ambient-member-read")
      return owner
    }
    owner.facts.bareItem = false
    const argumentValue = unwrapCompilerExpression(value.argumentExpression)
    if (!ts.isStringLiteralLike(argumentValue) && !ts.isNumericLiteral(argumentValue)) {
      owner.facts.dynamicItemElementAccess = true
    }
    const depth = owner.depth + 1
    owner.facts.maxItemAccessDepth = Math.max(owner.facts.maxItemAccessDepth, depth)
    return { facts: owner.facts, depth }
  }
  return { facts: analyzeMutable(value, itemName, indexName) }
}

function analyzeMutable(expression: ts.Expression, itemName: string, indexName: string | undefined): MutableFacts {
  const value = unwrapCompilerExpression(expression)
  const facts = emptyFacts()

  if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) || ts.isBigIntLiteral(value)
    || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword
    || value.kind === ts.SyntaxKind.NullKeyword) return facts

  if (ts.isIdentifier(value)) {
    if (value.text === itemName) {
      facts.itemDependent = true
      facts.bareItem = true
      return facts
    }
    if (indexName && value.text === indexName) {
      facts.indexDependent = true
      return facts
    }
    if (value.text !== "undefined") facts.captures.add(value.text)
    return facts
  }

  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    return rootItemAccessDepth(value, itemName, indexName).facts
  }

  if (ts.isPrefixUnaryExpression(value)) {
    if (value.operator !== ts.SyntaxKind.PlusToken
      && value.operator !== ts.SyntaxKind.MinusToken
      && value.operator !== ts.SyntaxKind.ExclamationToken
      && value.operator !== ts.SyntaxKind.TildeToken) return fail(facts, "unsupported-expression")
    return analyzeMutable(value.operand, itemName, indexName)
  }

  if (ts.isBinaryExpression(value)) {
    const operator = value.operatorToken.kind
    if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) return fail(facts, "assignment")
    if (operator === ts.SyntaxKind.CommaToken) return fail(facts, "comma")
    merge(facts, analyzeMutable(value.left, itemName, indexName))
    merge(facts, analyzeMutable(value.right, itemName, indexName))
    return facts
  }

  if (ts.isConditionalExpression(value)) {
    merge(facts, analyzeMutable(value.condition, itemName, indexName))
    merge(facts, analyzeMutable(value.whenTrue, itemName, indexName))
    merge(facts, analyzeMutable(value.whenFalse, itemName, indexName))
    return facts
  }

  if (ts.isTemplateExpression(value)) {
    for (const span of value.templateSpans) merge(facts, analyzeMutable(span.expression, itemName, indexName))
    return facts
  }

  return fail(facts, "unsupported-expression")
}

export function analyzeMunScalarExpression(
  expression: ts.Expression,
  itemName: string,
  indexName?: string,
): MunScalarEffectFacts {
  const facts = analyzeMutable(expression, itemName, indexName)
  return Object.freeze({
    pure: facts.pure,
    itemDependent: facts.itemDependent,
    indexDependent: facts.indexDependent,
    captures: Object.freeze([...facts.captures].sort()),
    maxItemAccessDepth: facts.maxItemAccessDepth,
    dynamicItemElementAccess: facts.dynamicItemElementAccess,
    bareItem: facts.bareItem,
    ...(facts.blocker ? { blocker: facts.blocker } : {}),
  })
}

/** Apply a consumer-specific proof policy without redefining expression purity. */
export function scalarExpressionMatchesPolicy(
  facts: MunScalarEffectFacts,
  policy: MunScalarEffectPolicy,
): boolean {
  if (!facts.pure) return false
  if (!policy.allowCapturedIdentifiers && facts.captures.length > 0) return false
  if (!policy.allowBareItem && facts.bareItem) return false
  if (!policy.allowDynamicItemElementAccess && facts.dynamicItemElementAccess) return false
  if (policy.maxItemAccessDepth !== undefined && facts.maxItemAccessDepth > policy.maxItemAccessDepth) return false
  return true
}

export function compilerFunctionResultExpression(
  closure: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | undefined {
  if (!ts.isBlock(closure.body)) return unwrapCompilerExpression(closure.body)
  if (closure.body.statements.length !== 1) return undefined
  const statement = closure.body.statements[0]
  return ts.isReturnStatement(statement) && statement.expression
    ? unwrapCompilerExpression(statement.expression)
    : undefined
}

function mergedPublicFacts(values: readonly MunScalarEffectFacts[]): MunScalarEffectFacts {
  const captures = new Set<string>()
  for (const value of values) for (const capture of value.captures) captures.add(capture)
  const blocker = values.find(value => value.blocker)?.blocker
  return Object.freeze({
    pure: values.every(value => value.pure),
    itemDependent: values.some(value => value.itemDependent),
    indexDependent: values.some(value => value.indexDependent),
    captures: Object.freeze([...captures].sort()),
    maxItemAccessDepth: Math.max(0, ...values.map(value => value.maxItemAccessDepth)),
    dynamicItemElementAccess: values.some(value => value.dynamicItemElementAccess),
    bareItem: values.some(value => value.bareItem),
    ...(blocker ? { blocker } : {}),
  })
}

function analyzeMappedResult(
  expression: ts.Expression,
  itemName: string,
  indexName: string | undefined,
): { readonly facts: MunScalarEffectFacts; readonly allocatesObject: boolean; readonly spreadsItem: boolean } {
  const value = unwrapCompilerExpression(expression)
  if (ts.isIdentifier(value) && value.text === itemName) {
    return { facts: analyzeMunScalarExpression(value, itemName, indexName), allocatesObject: false, spreadsItem: false }
  }
  if (ts.isObjectLiteralExpression(value)) {
    const facts: MunScalarEffectFacts[] = []
    let spreadsItem = false
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = unwrapCompilerExpression(property.expression)
        if (!ts.isIdentifier(spread) || spread.text !== itemName) {
          return {
            facts: Object.freeze({
              pure: false,
              itemDependent: false,
              indexDependent: false,
              captures: Object.freeze([]),
              maxItemAccessDepth: 0,
              dynamicItemElementAccess: false,
              bareItem: false,
              blocker: "unsupported-expression" as const,
            }),
            allocatesObject: true,
            spreadsItem,
          }
        }
        spreadsItem = true
        facts.push(analyzeMunScalarExpression(spread, itemName, indexName))
        continue
      }
      if (!ts.isPropertyAssignment(property)
        || (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name) && !ts.isNumericLiteral(property.name))) {
        return {
          facts: Object.freeze({
            pure: false,
            itemDependent: false,
            indexDependent: false,
            captures: Object.freeze([]),
            maxItemAccessDepth: 0,
            dynamicItemElementAccess: false,
            bareItem: false,
            blocker: "unsupported-expression" as const,
          }),
          allocatesObject: true,
          spreadsItem,
        }
      }
      facts.push(analyzeMunScalarExpression(property.initializer, itemName, indexName))
    }
    return { facts: mergedPublicFacts(facts), allocatesObject: true, spreadsItem }
  }
  if (ts.isConditionalExpression(value)) {
    const condition = analyzeMunScalarExpression(value.condition, itemName, indexName)
    const whenTrue = analyzeMappedResult(value.whenTrue, itemName, indexName)
    const whenFalse = analyzeMappedResult(value.whenFalse, itemName, indexName)
    return {
      facts: mergedPublicFacts([condition, whenTrue.facts, whenFalse.facts]),
      allocatesObject: whenTrue.allocatesObject || whenFalse.allocatesObject,
      spreadsItem: whenTrue.spreadsItem || whenFalse.spreadsItem,
    }
  }
  const unsupported = analyzeMunScalarExpression(value, itemName, indexName)
  return {
    facts: unsupported.pure
      ? Object.freeze({ ...unsupported, pure: false, blocker: "unsupported-expression" as const })
      : unsupported,
    allocatesObject: false,
    spreadsItem: false,
  }
}

/**
 * Analyze the restricted map closure shape used by compiler-owned State data
 * transforms. The returned facts are also the seed for future Kernel IR.
 */
export function analyzeMunMapperFunction(expression: ts.Expression): MunMapperEffectFacts | undefined {
  const value = unwrapCompilerExpression(expression)
  if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return undefined
  if (value.asteriskToken || value.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return undefined
  if (value.parameters.length < 1 || value.parameters.length > 2) return undefined
  const item = value.parameters[0]
  const index = value.parameters[1]
  if (!ts.isIdentifier(item.name) || item.dotDotDotToken || item.initializer) return undefined
  if (index && (!ts.isIdentifier(index.name) || index.dotDotDotToken || index.initializer)) return undefined
  const result = compilerFunctionResultExpression(value)
  if (!result) return undefined
  const itemName = item.name.text
  const indexName = index && ts.isIdentifier(index.name) ? index.name.text : undefined
  const mapped = analyzeMappedResult(result, itemName, indexName)
  return Object.freeze({
    ...mapped.facts,
    itemName,
    ...(indexName ? { indexName } : {}),
    allocatesObject: mapped.allocatesObject,
    spreadsItem: mapped.spreadsItem,
  })
}

/** Analyze a single-expression scalar row/key evaluator. */
export function analyzeMunScalarFunction(expression: ts.Expression): MunScalarFunctionEffectFacts | undefined {
  const value = unwrapCompilerExpression(expression)
  if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return undefined
  if (value.asteriskToken || value.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return undefined
  if (value.parameters.length < 1 || value.parameters.length > 2) return undefined
  const item = value.parameters[0]
  const index = value.parameters[1]
  if (!ts.isIdentifier(item.name) || item.dotDotDotToken || item.initializer) return undefined
  if (index && (!ts.isIdentifier(index.name) || index.dotDotDotToken || index.initializer)) return undefined
  const result = compilerFunctionResultExpression(value)
  if (!result) return undefined
  const itemName = item.name.text
  const indexName = index && ts.isIdentifier(index.name) ? index.name.text : undefined
  return Object.freeze({
    ...analyzeMunScalarExpression(result, itemName, indexName),
    itemName,
    ...(indexName ? { indexName } : {}),
  })
}
