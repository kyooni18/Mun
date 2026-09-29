import type { MunSemanticModel } from "./semantic.js"
import type { MunExecutionPlan } from "./execution-plan.js"
import type { ResidentComputeExperimentalOptions } from "@mun/execution"

export interface MunSourceMap {
  readonly version: 3
  readonly file?: string
  readonly sources: readonly string[]
  readonly sourcesContent: readonly string[]
  readonly names: readonly string[]
  readonly mappings: string
  readonly x_mun?: {
    readonly lineMappings: readonly { readonly line: number; readonly column: number; readonly generatedColumn: number }[]
    readonly segments: readonly (readonly { readonly line: number; readonly column: number; readonly generatedColumn: number }[])[]
  }
}

export interface MunTransformResult {
  readonly code: string
  readonly map: MunSourceMap
}

export interface MunDiagnostic {
  readonly severity: "error" | "warning"
  readonly code: "MUN_SYNTAX" | "MUN_INITIALIZER" | "MUN_TYPESCRIPT" | "MUN_HTML_ATTRIBUTE" | "MUN_HTML_VALUE" | "MUN_STATE_SCOPE"
  readonly message: string
  readonly line: number
  readonly column: number
}

export interface MunLanguageService {
  readonly format: (source: string) => string
  readonly diagnose: (source: string) => readonly MunDiagnostic[]
  readonly transform: (source: string, id?: string) => MunTransformResult
  readonly positionAt: (source: string, offset: number) => { line: number; column: number }
  readonly offsetAt: (source: string, position: { line: number; column: number }) => number
  readonly semantic: (source: string, fileName?: string) => MunSemanticModel
}

export interface MunVitePluginOptions {
  /** Opt in to experimental Resident Compute native/GPU planning (default: false). */
  readonly experimentalResidentCompute?: boolean | ResidentComputeExperimentalOptions
  readonly include?: RegExp
  /** Generate detailed compiler maps for transformed modules (default: true). */
  readonly sourceMap?: boolean
  /**
   * Optional transitional Vue-host codegen. When configured, importing a
   * `.mun` source with `?vue-host` emits a thin runtime placement component
   * from the selected Mun initializer plan. Use generateVueHostModule for a
   * physical TypeScript host when consumer-visible `$props` typing is needed.
   */
  readonly vueHost?: {
    readonly factoryImport: string
  }
  /**
   * Optional compiler execution-plan tap for DevTools/profiling integrations.
   * Planning is completely skipped when this callback is absent.
   */
  readonly onExecutionPlan?: (plan: MunExecutionPlan, id: string) => void
}
