import * as ts from "typescript"
import { createMunSourceMap } from "./source-map.js"
import { hasMunSyntax, transformMunSource } from "./pipeline.js"
import { staticModifierNames } from "./specialization.js"
import { createMunExecutionPlan } from "./execution-plan.js"
import { generateVueHostModule } from "./vue-host.js"
import { assertCanonicalMunSource } from "./analysis.js"
import type { MunSourceMap, MunTransformResult, MunVitePluginOptions } from "./types.js"

const MUN_SOURCE_RE = /\.mun(?:\.tsx?)?$/i
const HOST_SCRIPT_RE = /\.[cm]?[jt]sx?$/i
const DEFAULT_RESOLVE_EXTENSIONS = [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"]
const MUN_BINDING_HINT_RE = /\$[A-Za-z_$]/
const MUN_STRUCT_HINT_RE = /\bstruct\s+[A-Z][A-Za-z0-9_$]*(?:\s*<[^>{}]*>)?\s*:\s*View\b/
const MUN_BUILDER_HINT_RE = /\b[A-Z][A-Za-z0-9_$]*(?:\.[A-Z][A-Za-z0-9_$]*)?\s*\([^{}\n]*\)\s*\{/
const MUN_LABELED_CALL_HINT_RE = /\b[A-Z][A-Za-z0-9_$]*(?:\.[A-Z][A-Za-z0-9_$]*)?\s*\([^()\n]*:[^()\n]*\)/
const MUN_MODIFIER_HINT_RE = new RegExp(`\\.(?:${[...staticModifierNames].join("|")})\\s*\\(`)

function hasCheapMunHint(source: string, fileName: string, allowRawHtml: boolean): boolean {
  if (MUN_SOURCE_RE.test(fileName)) return true
  if (MUN_BINDING_HINT_RE.test(source) || MUN_STRUCT_HINT_RE.test(source)
    || MUN_BUILDER_HINT_RE.test(source) || MUN_LABELED_CALL_HINT_RE.test(source)
    || MUN_MODIFIER_HINT_RE.test(source)) return true
  return allowRawHtml && /<[A-Za-z][^>]*>/.test(source)
}

function isMunVueScript(attributes: string): boolean {
  const language = /\blang\s*=\s*(["'])([^"']+)\1/i.exec(attributes)?.[2]
  return !language || /^(?:mun|js|jsx|ts|tsx|mts|cts)$/i.test(language)
}

function isGeneratedVueScript(source: string): boolean {
  return /\b_defineComponent\(\{/.test(source)
    && /\bsetup\(__props(?:\s*,|\s*\))/.test(source)
    && /\b(?:_openBlock|_createBlock|_createElementBlock)\b/.test(source)
}

function transformVueSfcSource(source: string, fileName: string): string {
  const script = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  let output = source
  let changed = false
  let match: RegExpExecArray | null
  while ((match = script.exec(source))) {
    if (!isMunVueScript(match[1])) continue
    const language = /\blang\s*=\s*(["'])([^"']+)\1/i.exec(match[1])?.[2] ?? "ts"
    if (!hasMunSyntax(match[2], !/^(?:tsx|jsx)$/i.test(language))) continue
    const transformed = transformMunSource(match[2], `${fileName}#script`)
    if (transformed === match[2]) continue
    const bodyStart = match.index + match[0].indexOf(match[2])
    const outputStart = bodyStart + (output.length - source.length)
    output = output.slice(0, outputStart) + transformed + output.slice(outputStart + match[2].length)
    changed = true
  }
  return changed ? output : source
}

function emptySourceMap(id: string): MunSourceMap {
  return {
    version: 3,
    file: id,
    sources: [id],
    sourcesContent: [],
    names: [],
    mappings: "",
    x_mun: { lineMappings: [], segments: [] },
  }
}


function emitCanonicalMunJavaScript(code: string, fileName: string): string {
  return ts.transpileModule(code, {
    fileName: fileName + ".ts",
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText
}

export function createMunVitePlugin(options: MunVitePluginOptions = {}) {
  const cache = new Map<string, { source: string; result: MunTransformResult | null }>()
  const maximumCacheEntries = 128
  const remember = (key: string, value: { source: string; result: MunTransformResult | null }): void => {
    cache.delete(key)
    cache.set(key, value)
    while (cache.size > maximumCacheEntries) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }
  let sourceMapEnabled = options.sourceMap !== false
  const transform = (source: string, id: string): MunTransformResult | null => {
    const fileName = id.split("?", 1)[0]
    const query = id.slice(fileName.length + (id.includes("?") ? 1 : 0))
    // Compiled workspace packages are already TypeScript output. Re-running
    // Mun lowering over their JavaScript can mistake ordinary method calls
    // for authoring syntax and corrupt otherwise valid module code.
    if (/[\\/]node_modules[\\/]/.test(fileName) || /[\\/]dist[\\/]/.test(fileName)) return null
    const isVue = /\.vue$/i.test(fileName)
    const isVueHostModule = MUN_SOURCE_RE.test(fileName) && /(?:^|&)vue-host(?:=1)?(?:&|$)/.test(query)
    if (isVueHostModule) {
      if (!options.vueHost?.factoryImport) {
        throw new TypeError(`Mun Vue host import requires vite option vueHost.factoryImport (${id})`)
      }
      if (options.include) {
        options.include.lastIndex = 0
        if (!options.include.test(fileName)) return null
      }
      const generated = generateVueHostModule(source, fileName, {
        viewImport: fileName,
        hostFactoryImport: options.vueHost.factoryImport,
        // Vite sees this module under a custom .mun id. Emit executable JS
        // rather than relying on a later TypeScript loader to strip host-only
        // interfaces/assertions from that custom extension.
        emitTypes: false,
      })
      return {
        code: generated.code,
        map: sourceMapEnabled ? createMunSourceMap(source, generated.code, id) : emptySourceMap(id),
      }
    }
    const isVueTemplate = isVue && /(?:^|&)type=template(?:&|$)/.test(query)
    const isVueStyle = isVue && /(?:^|&)type=style(?:&|$)/.test(query)
    const isVueScript = isVue && (
      /(?:^|&)type=script(?:&|$)/.test(query)
      || (!isVueTemplate && !isVueStyle && !/<(?:script|template)\b/i.test(source))
    )
    if (!isVue && !MUN_SOURCE_RE.test(fileName) && !HOST_SCRIPT_RE.test(fileName)) return null
    if (options.include) {
      options.include.lastIndex = 0
      if (!options.include.test(fileName)) return null
    }
    if (isVue && (isVueTemplate || isVueStyle)) return null
    const cacheKey = isVue ? id : fileName
    // Check the exact-source cache before any parser-backed syntax probe. This
    // is especially important for Vite's dependency scan, which can invoke
    // the same transform hook again for unchanged plain TS/JS modules.
    const cached = cache.get(cacheKey)
    if (cached?.source === source) {
      remember(cacheKey, cached)
      return cached.result
    }
    if (isVueScript && isGeneratedVueScript(source)) {
      remember(cacheKey, { source, result: null })
      return null
    }
    const vueSource = isVue && !isVueScript
      ? transformVueSfcSource(source, fileName)
      : source
    const allowRawHtml = isVueScript
      ? !/(?:^|&)lang\.(?:tsx|jsx)(?:&|$)/.test(query)
      : false
    if (!isVue && !hasCheapMunHint(source, fileName, false)) {
      remember(cacheKey, { source, result: null })
      return null
    }
    if (!isVue && !MUN_SOURCE_RE.test(fileName) && !hasMunSyntax(source, false)) {
      remember(cacheKey, { source, result: null })
      return null
    }
    if (isVue && vueSource === source && !isVueScript) {
      remember(cacheKey, { source, result: null })
      return null
    }
    if (isVueScript && !hasCheapMunHint(source, fileName, allowRawHtml)) {
      remember(cacheKey, { source, result: null })
      return null
    }
    if (isVueScript && !hasMunSyntax(source, allowRawHtml)) {
      remember(cacheKey, { source, result: null })
      return null
    }
    if (!isVue && /\.mun$/i.test(fileName)) assertCanonicalMunSource(source, fileName)
    const lowered = isVue && !isVueScript ? vueSource : transformMunSource(source, fileName)
    const code = !isVue && /\.mun$/i.test(fileName)
      ? emitCanonicalMunJavaScript(lowered, fileName)
      : lowered
    const transformed = code === source ? null : {
      code,
      map: sourceMapEnabled ? createMunSourceMap(source, code, fileName) : emptySourceMap(fileName),
    }
    if (transformed && options.onExecutionPlan) {
      options.onExecutionPlan(createMunExecutionPlan(code, fileName), id)
    }
    remember(cacheKey, { source, result: transformed })
    return transformed
  }
  const dependencyScanPlugin = {
    name: "mun-compiler:dependency-scan",
    transform,
  }
  return {
    name: "mun-compiler",
    enforce: "pre" as const,
    configResolved(resolvedConfig: { build?: { sourcemap?: boolean | "inline" | "hidden" } }) {
      // Direct unit tests and non-Vite callers have no resolved config, so the
      // option defaults to the historical detailed-map behavior. In a real
      // Vite build, honor build.sourcemap unless explicitly overridden.
      if (options.sourceMap === undefined) sourceMapEnabled = Boolean(resolvedConfig.build?.sourcemap)
    },
    config(userConfig: { resolve?: { extensions?: readonly string[] } } = {}) {
      const hostExtensions = userConfig.resolve?.extensions ?? DEFAULT_RESOLVE_EXTENSIONS
      return {
        resolve: {
          extensions: [...new Set([".mun", ".mun.ts", ".mun.tsx", ...hostExtensions])],
        },
        optimizeDeps: {
          rolldownOptions: {
            plugins: [dependencyScanPlugin],
          },
        },
      }
    },
    handleHotUpdate(context: { file: string; modules?: unknown[] }) {
      // Invalidate only modules derived from the changed authoring file. Vite
      // keeps the live module graph and renderer state while the compiler drops
      // stale source/codegen entries for the next transform. Query modules such
      // as .mun?vue-host are invalidated together with the source module.
      const normalized = context.file.replace(/\\/g, "/")
      for (const key of [...cache.keys()]) {
        const candidate = key.split("?", 1)[0].replace(/\\/g, "/")
        if (candidate === normalized) cache.delete(key)
      }
      return context.modules
    },
    transform,
  }
}
