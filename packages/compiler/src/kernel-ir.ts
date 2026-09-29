import * as ts from "typescript"
import type {
  KernelBinaryOperator,
  KernelExpression,
  KernelIR,
  KernelMapIR,
  KernelMapOutput,
  KernelScalarIR,
  KernelUnaryOperator,
} from "@mun/core/internal/execution"
import { compilerFunctionResultExpression, unwrapCompilerExpression } from "./effect-analysis.js"

export type MunKernelUnaryOperator = KernelUnaryOperator
export type MunKernelBinaryOperator = KernelBinaryOperator
export type MunKernelExpression = KernelExpression
export type MunKernelMapOutput = KernelMapOutput
export type MunKernelMapIR = KernelMapIR
export type MunKernelScalarIR = KernelScalarIR
export type MunKernelIR = KernelIR

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined
}

function propertyPath(expression: ts.Expression, itemName: string): readonly (string | number)[] | undefined {
  const value = unwrapCompilerExpression(expression)
  if (ts.isIdentifier(value)) return value.text === itemName ? Object.freeze([]) : undefined
  if (ts.isPropertyAccessExpression(value)) {
    const owner = propertyPath(value.expression, itemName)
    return owner ? Object.freeze([...owner, value.name.text]) : undefined
  }
  if (ts.isElementAccessExpression(value) && value.argumentExpression) {
    const owner = propertyPath(value.expression, itemName)
    if (!owner) return undefined
    const key = unwrapCompilerExpression(value.argumentExpression)
    if (ts.isStringLiteralLike(key)) return Object.freeze([...owner, key.text])
    if (ts.isNumericLiteral(key)) return Object.freeze([...owner, Number(key.text)])
  }
  return undefined
}

function unaryOperator(kind: ts.PrefixUnaryOperator): MunKernelUnaryOperator | undefined {
  if (kind === ts.SyntaxKind.PlusToken) return "+"
  if (kind === ts.SyntaxKind.MinusToken) return "-"
  if (kind === ts.SyntaxKind.ExclamationToken) return "!"
  if (kind === ts.SyntaxKind.TildeToken) return "~"
  return undefined
}

function binaryOperator(kind: ts.SyntaxKind): MunKernelBinaryOperator | undefined {
  switch (kind) {
    case ts.SyntaxKind.PlusToken: return "+"
    case ts.SyntaxKind.MinusToken: return "-"
    case ts.SyntaxKind.AsteriskToken: return "*"
    case ts.SyntaxKind.SlashToken: return "/"
    case ts.SyntaxKind.PercentToken: return "%"
    case ts.SyntaxKind.AsteriskAsteriskToken: return "**"
    case ts.SyntaxKind.LessThanToken: return "<"
    case ts.SyntaxKind.LessThanEqualsToken: return "<="
    case ts.SyntaxKind.GreaterThanToken: return ">"
    case ts.SyntaxKind.GreaterThanEqualsToken: return ">="
    case ts.SyntaxKind.EqualsEqualsToken: return "=="
    case ts.SyntaxKind.ExclamationEqualsToken: return "!="
    case ts.SyntaxKind.EqualsEqualsEqualsToken: return "==="
    case ts.SyntaxKind.ExclamationEqualsEqualsToken: return "!=="
    case ts.SyntaxKind.AmpersandToken: return "&"
    case ts.SyntaxKind.BarToken: return "|"
    case ts.SyntaxKind.CaretToken: return "^"
    case ts.SyntaxKind.LessThanLessThanToken: return "<<"
    case ts.SyntaxKind.GreaterThanGreaterThanToken: return ">>"
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: return ">>>"
    case ts.SyntaxKind.AmpersandAmpersandToken: return "&&"
    case ts.SyntaxKind.BarBarToken: return "||"
    case ts.SyntaxKind.QuestionQuestionToken: return "??"
    default: return undefined
  }
}

export function lowerMunKernelExpression(
  expression: ts.Expression,
  itemName: string,
  indexName?: string,
): MunKernelExpression | undefined {
  const value = unwrapCompilerExpression(expression)
  if (ts.isNumericLiteral(value)) return Object.freeze({ op: "const", value: Number(value.text) })
  if (value.kind === ts.SyntaxKind.TrueKeyword) return Object.freeze({ op: "const", value: true })
  if (value.kind === ts.SyntaxKind.FalseKeyword) return Object.freeze({ op: "const", value: false })
  if (ts.isIdentifier(value)) {
    if (indexName && value.text === indexName) return Object.freeze({ op: "index" })
    if (value.text !== itemName && value.text !== "undefined") return Object.freeze({ op: "capture", name: value.text })
    return undefined
  }
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    const path = propertyPath(value, itemName)
    return path && path.length > 0 ? Object.freeze({ op: "load", path }) : undefined
  }
  if (ts.isPrefixUnaryExpression(value)) {
    const operator = unaryOperator(value.operator)
    const operand = lowerMunKernelExpression(value.operand, itemName, indexName)
    return operator && operand ? Object.freeze({ op: "unary", operator, value: operand }) : undefined
  }
  if (ts.isBinaryExpression(value)) {
    const operator = binaryOperator(value.operatorToken.kind)
    const left = lowerMunKernelExpression(value.left, itemName, indexName)
    const right = lowerMunKernelExpression(value.right, itemName, indexName)
    return operator && left && right ? Object.freeze({ op: "binary", operator, left, right }) : undefined
  }
  if (ts.isConditionalExpression(value)) {
    const condition = lowerMunKernelExpression(value.condition, itemName, indexName)
    const whenTrue = lowerMunKernelExpression(value.whenTrue, itemName, indexName)
    const whenFalse = lowerMunKernelExpression(value.whenFalse, itemName, indexName)
    return condition && whenTrue && whenFalse
      ? Object.freeze({ op: "select", condition, whenTrue, whenFalse })
      : undefined
  }
  return undefined
}

export function lowerMunMapKernel(expression: ts.Expression): MunKernelMapIR | undefined {
  const value = unwrapCompilerExpression(expression)
  if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return undefined
  if (value.asteriskToken || value.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return undefined
  if (value.parameters.length < 1 || value.parameters.length > 2) return undefined
  const item = value.parameters[0]
  const index = value.parameters[1]
  if (!ts.isIdentifier(item.name) || item.dotDotDotToken || item.initializer) return undefined
  if (index && (!ts.isIdentifier(index.name) || index.dotDotDotToken || index.initializer)) return undefined
  const result = compilerFunctionResultExpression(value)
  if (!result || !ts.isObjectLiteralExpression(result)) return undefined
  const itemName = item.name.text
  const indexName = index && ts.isIdentifier(index.name) ? index.name.text : undefined
  let preserveInput = false
  const outputs: MunKernelMapOutput[] = []
  const captures = new Set<string>()
  for (const property of result.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = unwrapCompilerExpression(property.expression)
      if (!ts.isIdentifier(spread) || spread.text !== itemName || preserveInput) return undefined
      preserveInput = true
      continue
    }
    if (!ts.isPropertyAssignment(property)) return undefined
    const name = propertyName(property.name)
    if (name === undefined || name === "__proto__") return undefined
    const lowered = lowerMunKernelExpression(property.initializer, itemName, indexName)
    if (!lowered) return undefined
    const collect = (node: MunKernelExpression): void => {
      if (node.op === "capture") captures.add(node.name)
      else if (node.op === "unary") collect(node.value)
      else if (node.op === "binary") {
        collect(node.left)
        collect(node.right)
      } else if (node.op === "select") {
        collect(node.condition)
        collect(node.whenTrue)
        collect(node.whenFalse)
      }
    }
    collect(lowered)
    outputs.push(Object.freeze({ name, value: lowered }))
  }
  if (outputs.length === 0) return undefined
  return Object.freeze({
    kind: "map",
    itemName,
    ...(indexName ? { indexName } : {}),
    preserveInput,
    outputs: Object.freeze(outputs),
    captures: Object.freeze([...captures].sort()),
    requiresTypeProof: true,
  })
}

export function lowerMunScalarKernel(expression: ts.Expression): MunKernelScalarIR | undefined {
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
  const lowered = lowerMunKernelExpression(result, itemName, indexName)
  if (!lowered) return undefined
  const captures = new Set<string>()
  const collect = (node: MunKernelExpression): void => {
    if (node.op === "capture") captures.add(node.name)
    else if (node.op === "unary") collect(node.value)
    else if (node.op === "binary") {
      collect(node.left)
      collect(node.right)
    } else if (node.op === "select") {
      collect(node.condition)
      collect(node.whenTrue)
      collect(node.whenFalse)
    }
  }
  collect(lowered)
  return Object.freeze({
    kind: "scalar",
    itemName,
    ...(indexName ? { indexName } : {}),
    value: lowered,
    captures: Object.freeze([...captures].sort()),
    requiresTypeProof: true,
  })
}
