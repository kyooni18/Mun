import { createMunSourceMap } from "./source-map.js"
import { createSemanticModel, type MunSemanticModel } from "./semantic.js"
import { transformMunSource } from "./pipeline.js"
import { diagnoseMunSource } from "./diagnostics.js"
import { analyzeMunSource, assertCanonicalMunSource } from "./analysis.js"
import type { MunLanguageService, MunSourceMap, MunTransformResult } from "./types.js"

export { transformMunSource } from "./pipeline.js"
export { diagnoseMunSource } from "./diagnostics.js"
export { createMunVitePlugin } from "./vite.js"
export { generateVueHostModule } from "./vue-host.js"
export { analyzeMunSource, assertCanonicalMunSource } from "./analysis.js"
export type { MunSourceAnalysis } from "./analysis.js"
export type { MunVueHostGenerationOptions, MunVueHostGenerationResult } from "./vue-host.js"
export type { MunDiagnostic, MunLanguageService, MunSourceMap, MunTransformResult, MunVitePluginOptions } from "./types.js"

export { lowerMunBuilderAst, parseMunBuilder, parseMunStructs } from "./ast.js"
export { compileMunUiProgram, nativeLoweringMetadata } from "./ui-ir.js"
export type { MunUiCompileOptions } from "./ui-ir.js"
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
} from "./ast.js"
export type {
  MunSemanticCall,
  MunSemanticField,
  MunSemanticForeignComponent,
  MunSemanticImport,
  MunSemanticInitializer,
  MunSemanticModel,
  MunSemanticView,
} from "./semantic.js"
export type {
  SemanticArgument,
  SemanticArgumentKind,
  SemanticCallResolution,
  SemanticClosureRole,
  SemanticBindingSymbol,
  SemanticBuilderTypeSymbol,
  SemanticFieldSymbol,
  SemanticForeignComponentTypeSymbol,
  SemanticInitializerParameter,
  SemanticInitializerParameterKind,
  SemanticInitializerResolution,
  SemanticInitializerResolutionFailure,
  SemanticInitializerResolutionResult,
  SemanticInitializerSymbol,
  SemanticResolutionDiagnostic,
  SemanticStateSymbol,
  SemanticStructSymbol,
  SemanticSymbol,
  SemanticViewTypeSymbol,
} from "@mun/core"
export { resolveSemanticCall, resolveSemanticInitializer, SemanticModel } from "@mun/core"
export { createMunSourceMap, mapGeneratedPosition, mapOriginalPosition } from "./source-map.js"
export type { MunSourceMapAnchor, MunSourcePosition } from "./source-map.js"

export function compileMunFile(source: string, fileName = "mun-source.mun"): MunTransformResult {
  assertCanonicalMunSource(source, fileName)
  const code = transformMunSource(source, fileName)
  return { code, map: createMunSourceMap(source, code, fileName) }
}

/** Build the shared Mun + TypeScript semantic model used by compiler clients and IDE tooling. */
export function createMunSemanticModel(source: string, fileName = "mun-source.mun"): MunSemanticModel {
  assertCanonicalMunSource(source, fileName)
  return createSemanticModel(source, fileName, transformMunSource(source, fileName))
}

export function formatMunSource(source: string): string {
  assertCanonicalMunSource(source, "mun-source.mun")
  return transformMunSource(source, "mun-source.mun")
}

function boundedOffset(source: string, offset: number): number {
  const numeric = Number.isFinite(offset) ? Math.trunc(offset) : 0
  return Math.max(0, Math.min(source.length, numeric))
}

export function createMunLanguageService(): MunLanguageService {
  return {
    format: formatMunSource,
    diagnose: diagnoseMunSource,
    transform: compileMunFile,
    positionAt(source, offset) {
      const bounded = boundedOffset(source, offset)
      const before = source.slice(0, bounded)
      return { line: before.split("\n").length, column: bounded - before.lastIndexOf("\n") }
    },
    offsetAt(source, position) {
      const lines = source.split("\n")
      const requestedLine = Number.isFinite(position.line) ? Math.trunc(position.line) : 1
      const line = Math.max(1, Math.min(lines.length, requestedLine))
      const requestedColumn = Number.isFinite(position.column) ? Math.trunc(position.column) : 1
      const lineOffset = lines.slice(0, line - 1).reduce((offset, item) => offset + item.length + 1, 0)
      return boundedOffset(source, lineOffset + Math.max(0, requestedColumn - 1))
    },
    semantic: createMunSemanticModel,
  }
}

export { nativeLanguageCatalog } from "./language-catalog.js"
