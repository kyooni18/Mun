export interface MunSyntaxError extends SyntaxError {
  readonly offset?: number
}

export function munSyntaxError(message: string, offset?: number): MunSyntaxError {
  const error = new SyntaxError(message) as MunSyntaxError
  if (offset !== undefined) Object.defineProperty(error, 'offset', { configurable: false, value: offset })
  return error
}
