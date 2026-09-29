export { transformMunBuilderSyntax } from './builder-transform.js'
export { transformMunStructSyntax } from './struct-transform.js'
export { lowerMunBuilderAst, parseMunBuilder, parseMunStructs } from './ast.js'
export type {
  MunArgument,
  MunAstLowering,
  MunBuilderNode,
  MunBuilderProgram,
  MunCallExpression,
  MunClosureExpression,
  MunConditionalExpression,
  MunRawExpression,
  MunSourceRange,
  MunStructDeclaration,
  MunStructField,
  MunStructInitializer,
} from './ast.js'
export { diagnoseMunSource, formatMunSource } from './language-tools.js'
export type { MunDiagnostic } from './language-tools.js'
export { createMunLanguageService } from './language-service.js'
export type {
  MunLanguageService,
  MunLanguageTransform,
  MunSourcePosition,
} from './language-service.js'
export { createMunTypeScriptLanguageService } from './typescript-language-service.js'
export type { MunTypeScriptLanguageServiceOptions } from './typescript-language-service.js'
export {
  createMunSourceMap,
  mapGeneratedPosition,
  mapOriginalPosition,
} from './source-map.js'
export type { MunSourceMap } from './source-map.js'
export { createMunVitePlugin } from './vite-builder.js'

export * from './swc-transform.js'
