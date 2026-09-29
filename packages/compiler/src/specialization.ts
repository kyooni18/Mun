import * as ts from "typescript"
import * as Core from "@mun/core/compat"
import { initializersOf, swiftUIStaticModifierNames, type InitializerParameter } from "@mun/core/compat"
import { motionPropertyBit, motionPropertyMask } from "@mun/core/internal/motion-abi"
import { lowerImplicitMemberShorthand, lowerShorthand } from "./shorthand.js"

function compilerRootFileName(fileName: string): string {
  const resolvePath = (ts.sys as typeof ts.sys & { resolvePath?: (value: string) => string }).resolvePath
  if (resolvePath) return resolvePath(fileName)
  return /^(?:[A-Za-z]:[\\/]|\/)/.test(fileName)
    ? fileName
    : `${ts.sys.getCurrentDirectory().replace(/[\\/]$/, "")}/${fileName}`
}
interface MunTypeScriptProgram {
  readonly sourceFile: ts.SourceFile
  readonly checker: ts.TypeChecker
}

interface CachedSourceFile {
  readonly text: string
  readonly languageVersionKey: string
  readonly sourceFile: ts.SourceFile
}

const externalSourceFiles = new Map<string, CachedSourceFile>()
const previousPrograms = new Map<string, ts.Program>()
const maximumProgramCacheSize = 32
const maximumExternalSourceFileCacheSize = 4096
const staticSyntaxSourceFiles = new Map<string, ts.SourceFile>()
const maximumStaticSyntaxSourceFileCacheSize = 32

function staticSyntaxSourceFile(source: string): ts.SourceFile {
  const cached = staticSyntaxSourceFiles.get(source)
  if (cached) {
    staticSyntaxSourceFiles.delete(source)
    staticSyntaxSourceFiles.set(source, cached)
    return cached
  }
  const file = ts.createSourceFile("mun-static-plan.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  staticSyntaxSourceFiles.set(source, file)
  while (staticSyntaxSourceFiles.size > maximumStaticSyntaxSourceFileCacheSize) {
    const oldest = staticSyntaxSourceFiles.keys().next().value as string | undefined
    if (oldest === undefined) break
    staticSyntaxSourceFiles.delete(oldest)
  }
  return file
}

function rememberProgram(root: string, program: ts.Program): void {
  previousPrograms.delete(root)
  previousPrograms.set(root, program)
  while (previousPrograms.size > maximumProgramCacheSize) {
    const oldest = previousPrograms.keys().next().value as string | undefined
    if (!oldest) break
    previousPrograms.delete(oldest)
  }
}

function rememberExternalSourceFile(key: string, cached: CachedSourceFile): void {
  // TypeScript can touch a very large dependency graph in a long-lived Vite
  // process. Keep hot SourceFiles reusable without letting the compiler cache
  // grow forever as projects, generated declarations, or package versions
  // change underneath the dev server.
  externalSourceFiles.delete(key)
  externalSourceFiles.set(key, cached)
  while (externalSourceFiles.size > maximumExternalSourceFileCacheSize) {
    const oldest = externalSourceFiles.keys().next().value as string | undefined
    if (!oldest) break
    externalSourceFiles.delete(oldest)
  }
}

function createMunTypeScriptProgram(source: string, fileName: string): MunTypeScriptProgram | undefined {
  const rootFileName = compilerRootFileName(fileName)
  const currentDirectory = ts.sys.getCurrentDirectory()
  let workspaceSelfReference = false
  try {
    const packageSource = ts.sys.readFile(`${currentDirectory.replace(/[\\/]$/, "")}/package.json`)
    workspaceSelfReference = packageSource ? JSON.parse(packageSource).name === "@mun/ui" : false
  } catch {
    workspaceSelfReference = false
  }
  const options: ts.CompilerOptions = {
    allowJs: false,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    ...(workspaceSelfReference ? {
      baseUrl: currentDirectory,
      paths: { "@mun/ui": ["./src/index.ts"] },
    } : {}),
  }
  const host = ts.createCompilerHost(options, true)
  const normalize = (value: string): string => value.replaceAll("\\", "/")
  const root = normalize(rootFileName)
  const originalReadFile = host.readFile.bind(host)
  const originalFileExists = host.fileExists.bind(host)
  host.fileExists = requested => normalize(requested) === root || originalFileExists(requested)
  host.readFile = requested => normalize(requested) === root ? source : originalReadFile(requested)
  host.getSourceFile = (requested, languageVersion, onError) => {
    if (normalize(requested) === root) return ts.createSourceFile(requested, source, languageVersion, true, ts.ScriptKind.TS)
    const text = originalReadFile(requested)
    if (text === undefined) {
      onError?.(`Unable to read ${requested}`)
      return undefined
    }
    const cacheKey = normalize(requested)
    const languageVersionKey = typeof languageVersion === "number" ? String(languageVersion) : JSON.stringify(languageVersion)
    const cached = externalSourceFiles.get(cacheKey)
    if (cached && cached.text === text && cached.languageVersionKey === languageVersionKey) {
      // Touch on hit so eviction is LRU rather than insertion-order FIFO.
      rememberExternalSourceFile(cacheKey, cached)
      return cached.sourceFile
    }
    const extension = requested.toLowerCase().split(".").pop()
    const scriptKind = extension === "tsx" ? ts.ScriptKind.TSX
      : extension === "jsx" ? ts.ScriptKind.JSX
        : extension === "js" || extension === "mjs" || extension === "cjs" ? ts.ScriptKind.JS
          : extension === "json" ? ts.ScriptKind.JSON
            : ts.ScriptKind.TS
    const sourceFile = ts.createSourceFile(requested, text, languageVersion, true, scriptKind)
    rememberExternalSourceFile(cacheKey, { text, languageVersionKey, sourceFile })
    return sourceFile
  }

  let program: ts.Program
  try {
    program = ts.createProgram([rootFileName], options, host, previousPrograms.get(root))
    rememberProgram(root, program)
  } catch {
    previousPrograms.delete(root)
    return undefined
  }
  const sourceFile = program.getSourceFile(rootFileName)
  return sourceFile ? { sourceFile, checker: program.getTypeChecker() } : undefined
}

export const staticModifierNames = new Set(swiftUIStaticModifierNames)

const compilerMotionProperties = new Map<string, readonly string[]>([
  ["padding", ["padding"]],
  ["margin", ["margin"]],
  ["gap", ["gap"]],
  ["font", ["font"]],
  ["fontSize", ["font-size"]],
  ["bold", ["font-weight"]],
  ["foreground", ["color"]],
  ["foregroundStyle", ["color"]],
  ["background", ["background"]],
  ["opacity", ["opacity"]],
  ["scaleEffect", ["scale"]],
  ["rotationEffect", ["rotate"]],
  ["offset", ["translate"]],
  ["position", ["left", "top", "transform"]],
  ["zIndex", ["z-index"]],
  ["kerning", ["letter-spacing"]],
  ["tracking", ["letter-spacing"]],
  ["baselineOffset", ["top"]],
  ["shadow", ["box-shadow"]],
  ["blur", ["filter"]],
  ["brightness", ["filter"]],
  ["contrast", ["filter"]],
  ["saturation", ["filter"]],
  ["grayscale", ["filter"]],
  ["hueRotation", ["filter"]],
  ["contentTransition", ["--mun-content"]],
])

function cssPropertyFromCompilerKey(value: string): string {
  if (value.startsWith("--") || value.includes("-")) return value
  return value.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`)
}

const frameMotionProperties = Object.freeze(["width", "height", "min-width", "max-width", "min-height", "max-height"] as const)

function objectLiteralMotionProperties(value: ts.Expression | undefined): readonly string[] | undefined {
  if (!value || !ts.isObjectLiteralExpression(value)) return undefined
  const properties: string[] = []
  for (const item of value.properties) {
    if (!ts.isPropertyAssignment(item) && !ts.isShorthandPropertyAssignment(item)) continue
    const key = item.name && (ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name) || ts.isNumericLiteral(item.name))
      ? item.name.text : undefined
    if (key) properties.push(cssPropertyFromCompilerKey(key))
  }
  return properties
}

function inferredMotionProperties(name: string, call: ts.CallExpression): readonly string[] {
  const known = compilerMotionProperties.get(name)
  if (known) return known
  if (name === "frame") {
    const exact = objectLiteralMotionProperties(call.arguments[0])
    return exact?.filter(property => frameMotionProperties.includes(property as typeof frameMotionProperties[number])) ?? frameMotionProperties
  }
  if (name === "style") return objectLiteralMotionProperties(call.arguments[0]) ?? []
  return []
}

function compiledAutoMotionArgumentsSource(properties: Iterable<string>): string {
  const unique = [...new Set(properties)]
  const mask = motionPropertyMask(unique)
  const extras = unique.filter(property => motionPropertyBit(property) === 0)
  return extras.length > 0 ? `${mask}, ${JSON.stringify(extras)}` : String(mask)
}

function lowerSymbolEffectArgument(source: string): string {
  const value = source.trim()
  if (value === ".automatic") return "SymbolEffect.automatic"
  if (value === ".byLayer") return "SymbolEffect.byLayer"
  if (value === ".wholeSymbol") return "SymbolEffect.wholeSymbol"
  if (value === ".magicReplace") return "SymbolEffect.magicReplace()"
  const magic = value.match(/^\.magicReplace\s*\(([\s\S]*)\)$/)
  if (magic) {
    const argument = magic[1].trim()
    if (!argument) return "SymbolEffect.magicReplace()"
    const fallback = argument.replace(/^fallback\s*:\s*/, "").trim()
    const implicit = fallback.match(/^\.([A-Za-z_$][A-Za-z0-9_$]*)$/)
    return `SymbolEffect.magicReplace(${implicit ? JSON.stringify(implicit[1]) : lowerImplicitMemberShorthand(lowerShorthand(fallback))})`
  }
  return lowerImplicitMemberShorthand(lowerShorthand(value))
}

export function lowerContentTransitionArgument(source: string): string {
  const value = source.trim()
  if (value === ".identity") return "ContentTransition.identity"
  if (value === ".opacity") return "ContentTransition.opacity"
  if (value === ".interpolate") return "ContentTransition.interpolate"
  const blur = value.match(/^\.blurReplace\s*\(([\s\S]*)\)$/)
  if (blur) {
    const argument = blur[1].trim().replace(/^radius\s*:\s*/, "")
    return argument ? `ContentTransition.blurReplace(${lowerImplicitMemberShorthand(lowerShorthand(argument))})` : "ContentTransition.blurReplace()"
  }
  const push = value.match(/^\.push\s*\(([\s\S]*)\)$/)
  if (push) {
    const argument = push[1].trim().replace(/^(?:from|direction)\s*:\s*/, "")
    if (!argument) return "ContentTransition.push()"
    const implicit = argument.match(/^\.([A-Za-z_$][A-Za-z0-9_$]*)$/)
    return `ContentTransition.push(${implicit ? JSON.stringify(implicit[1]) : lowerImplicitMemberShorthand(lowerShorthand(argument))})`
  }
  const scale = value.match(/^\.scale\s*\(([\s\S]*)\)$/)
  if (scale) {
    const argument = scale[1].trim().replace(/^scale\s*:\s*/, "")
    return argument ? `ContentTransition.scale(${lowerImplicitMemberShorthand(lowerShorthand(argument))})` : "ContentTransition.scale()"
  }
  const numeric = value.match(/^\.numericText\s*\(([\s\S]*)\)$/)
  if (numeric) {
    const argument = numeric[1].trim().replace(/^value\s*:\s*/, "")
    return argument
      ? `ContentTransition.numericText(${lowerImplicitMemberShorthand(lowerShorthand(argument))})`
      : "ContentTransition.numericText()"
  }
  const symbol = value.match(/^\.symbolEffect\s*\(([\s\S]*)\)$/)
  if (symbol) {
    const argument = symbol[1].trim()
    return argument ? `ContentTransition.symbolEffect(${lowerSymbolEffectArgument(argument)})` : "ContentTransition.symbolEffect()"
  }
  return lowerImplicitMemberShorthand(lowerShorthand(value))
}

function isMunViewType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false
  const alias = type.aliasSymbol?.escapedName
  if (alias === "View" || alias === "ModifiableViewNode") return true
  if (type.isUnion()) return type.types.length > 0 && type.types.every(item => isMunViewType(checker, item))
  const rendered = checker.typeToString(type)
  return rendered === "View" || rendered === "ModifiableViewNode"
}

interface StaticModifierCall {
  readonly name: string
  readonly node: ts.CallExpression
}

function staticModifierChain(node: ts.CallExpression): { readonly base: ts.Expression; readonly calls: readonly StaticModifierCall[] } | undefined {
  const calls: StaticModifierCall[] = []
  let current: ts.Expression = node
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const name = current.expression.name.text
    if (!staticModifierNames.has(name) || current.expression.questionDotToken) break
    calls.unshift({ name, node: current })
    current = current.expression.expression
  }
  return calls.length > 0 ? { base: current, calls } : undefined
}

export function lowerStaticModifierChains(source: string, fileName: string): string {
  if (!Array.from(staticModifierNames).some(name => new RegExp(`\\.${name}\\s*\\(`).test(source))) return source

  // A maximal modifier chain is lowered in one edit, so reparsing the complete
  // module up to eight times only repeated TypeScript program construction.
  // One semantic pass is sufficient: every disjoint maximal chain is collected
  // before any source edit is applied.
  const program = createMunTypeScriptProgram(source, fileName)
  if (!program) return source
  const candidates: Array<{ node: ts.CallExpression; chain: { readonly base: ts.Expression; readonly calls: readonly StaticModifierCall[] } }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const chain = staticModifierChain(node)
      const parent = node.parent
      const isNestedChain = ts.isCallExpression(parent)
        && ts.isPropertyAccessExpression(parent.expression)
        && parent.expression.expression === node
        && staticModifierNames.has(parent.expression.name.text)
      if (chain && !isNestedChain && isMunViewType(program.checker, program.checker.getTypeAtLocation(chain.base))) {
        candidates.push({ node, chain })
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(program.sourceFile)
  if (candidates.length === 0) return source

  const edits = candidates.map(({ node, chain }) => {
    const base = source.slice(chain.base.getStart(program.sourceFile), chain.base.end)
    // Argument expressions keep Mun authoring syntax (`$binding`, `.member`),
    // so they must pass through the same lowering as labeled modifier
    // arguments before being emitted into generated code.
    const pendingMotionProperties = new Set<string>()
    const modifiers = chain.calls.map(({ name, node: call }) => {
      if (name === "animation" && call.arguments.length === 0) {
        const motionArguments = compiledAutoMotionArgumentsSource(pendingMotionProperties)
        pendingMotionProperties.clear()
        return `["animationAuto", [${motionArguments}]]`
      }
      const argumentsSource = call.arguments.length === 0 && (name === "padding" || name === "margin")
        ? name === "padding" ? "16" : "0"
        : call.arguments.map(argument => {
          // An implicit member argument (`.red`) is not valid TypeScript, so
          // the parser recovers with a zero-width base and the node's start
          // lands after the dot. Re-attach a directly-preceding dot (unless
          // it belongs to a real member access like `theme.red`) so the
          // shorthand lowering sees the authored form.
          let start = argument.getStart(program.sourceFile)
          let cursor = start - 1
          while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1
          // The dot must not belong to a real member access (`theme.red`,
          // `arr[0].red`, `"str".red`) or to spread punctuation (`...values`).
          if (source[cursor] === "." && !(cursor > 0 && /[A-Za-z0-9_$.)"'\]]/.test(source[cursor - 1]))) start = cursor
          const raw = source.slice(start, argument.end)
          return name === "contentTransition" ? lowerContentTransitionArgument(raw) : lowerImplicitMemberShorthand(lowerShorthand(raw))
        }).join(", ")
      if (name === "animation") pendingMotionProperties.clear()
      else for (const property of inferredMotionProperties(name, call)) pendingMotionProperties.add(property)
      return `[${JSON.stringify(name)}, [${argumentsSource}]]`
    }).join(", ")
    return {
      start: node.getStart(program.sourceFile),
      end: node.end,
      replacement: `modifiedContentCompiled(${base}, [${modifiers}])`,
    }
  }).sort((left, right) => right.start - left.start)

  let result = source
  for (const edit of edits) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
  return result
}

function isNamedArgumentsCarrier(node: ts.Expression): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "namedArguments"
}

function containsUnsafeCompiledType(type: ts.Type, checker: ts.TypeChecker, seen = new Set<ts.Type>()): boolean {
  if (seen.has(type)) return false
  seen.add(type)
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return true
  if (type.isUnionOrIntersection()) return type.types.some(item => containsUnsafeCompiledType(item, checker, seen))

  // A callable value can look safe at the outer object level while returning
  // `any`/`unknown`. That is particularly dangerous for @ViewBuilder inputs:
  // the trusted compiled path deliberately skips the runtime generic-builder
  // validation performed by createNodeSpecialized(). Keep those calls on the
  // guarded path unless the callable's input/output types are also known.
  for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
    if (containsUnsafeCompiledType(checker.getReturnTypeOfSignature(signature), checker, seen)) return true
    for (const parameter of signature.parameters) {
      const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0]
      if (!declaration) continue
      try {
        if (containsUnsafeCompiledType(checker.getTypeOfSymbolAtLocation(parameter, declaration), checker, seen)) return true
      } catch {
        return true
      }
    }
  }

  if (type.flags & ts.TypeFlags.Object) {
    const object = type as ts.ObjectType
    if (object.objectFlags & ts.ObjectFlags.Reference) {
      try {
        if (checker.getTypeArguments(object as ts.TypeReference).some(item => containsUnsafeCompiledType(item, checker, seen))) return true
      } catch {
        return true
      }
    }
  }
  return false
}

function parameterType(checker: ts.TypeChecker, signature: ts.Signature, index: number, location: ts.Node): ts.Type | undefined {
  const parameter = signature.parameters[index]
  if (!parameter) return undefined
  const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? location
  try {
    return checker.getTypeOfSymbolAtLocation(parameter, declaration)
  } catch {
    return undefined
  }
}

function isViewBuilderParameter(checker: ts.TypeChecker, signature: ts.Signature, index: number, location: ts.Node): boolean {
  const type = parameterType(checker, signature, index, location)
  if (!type) return false
  const rendered = checker.typeToString(type)
  return /\bViewBuilder(?:Closure|Content)\b/.test(rendered)
}

function stripSimpleViewBuilder(rendered: string): string | undefined {
  const expression = /^\s*\(\s*\)\s*=>\s*(\[[\s\S]*\])\s*$/.exec(rendered)
  if (expression) return expression[1]
  const block = /^\s*\(\s*\)\s*=>\s*\{\s*return\s+(\[[\s\S]*\])\s*;?\s*\}\s*$/.exec(rendered)
  return block?.[1]
}

interface ImportedCallCandidate {
  readonly initializerIndex: number
  readonly signature: ts.Signature
  readonly compiled: boolean
  readonly runtimeParameters?: readonly InitializerParameter[]
}

const canonicalRuntimeModules = new Set(["@mun/core/compat", "@mun/react"])

function runtimeViewImports(sourceFile: ts.SourceFile): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!canonicalRuntimeModules.has(statement.moduleSpecifier.text)) continue
    const named = statement.importClause.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    for (const element of named.elements) {
      const exported = element.propertyName?.text ?? element.name.text
      const value = (Core as Record<string, unknown>)[exported]
      if (typeof value === "function" && initializersOf(value).length > 0) result.set(element.name.text, exported)
    }
  }
  return result
}

interface NamedCarrierProperty {
  readonly key: string
  readonly value: ts.Expression
}

function namedCarrierProperties(node: ts.Expression): readonly NamedCarrierProperty[] | undefined {
  if (!isNamedArgumentsCarrier(node) || node.arguments.length !== 1 || !ts.isObjectLiteralExpression(node.arguments[0])) return undefined
  const result: NamedCarrierProperty[] = []
  for (const property of node.arguments[0].properties) {
    if (ts.isPropertyAssignment(property)) {
      const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name)
        ? property.name.text
        : undefined
      if (key === undefined) return undefined
      result.push({ key, value: property.initializer })
      continue
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      result.push({ key: property.name.text, value: property.name })
      continue
    }
    return undefined
  }
  return result
}

function canNormalizeCompiledArguments(
  args: readonly ts.Expression[],
  parameters: readonly InitializerParameter[] | undefined,
  checker: ts.TypeChecker,
): boolean {
  const carriers = args.flatMap((argument, index) => isNamedArgumentsCarrier(argument) ? [{ argument, index }] : [])
  if (carriers.length === 0) return true
  if (carriers.length !== 1 || !parameters || parameters.some(parameter => parameter.variadic)) return false
  const properties = namedCarrierProperties(carriers[0].argument)
  if (!properties || properties.length === 0) return false
  if (properties.some(property => containsUnsafeCompiledType(checker.getTypeAtLocation(property.value), checker))) return false

  const keys = new Set(properties.map(property => property.key))
  const filled = new Set<number>()
  const optionIndex = parameters.findIndex(parameter => {
    const allowed = parameter.properties
    return !!allowed && keys.size > 0 && [...keys].every(key => allowed.includes(key))
  })
  if (optionIndex >= 0) {
    filled.add(optionIndex)
  } else {
    for (const property of properties) {
      const index = parameters.findIndex(parameter => parameter.label === property.key)
      if (index < 0 || filled.has(index)) return false
      filled.add(index)
    }
  }

  let positional = args.length - 1
  for (let index = 0; index < parameters.length && positional > 0; index += 1) {
    if (filled.has(index)) continue
    filled.add(index)
    positional -= 1
  }
  if (positional !== 0) return false
  return parameters.every((parameter, index) => filled.has(index) || parameter.required === false)
}

/**
 * Resolve imported Mun constructor overloads with the TypeChecker. Calls with
 * fully-known positional types use the trusted AOT initializer path; calls
 * involving named carriers, any/unknown values, or variadics keep the guarded
 * specialization path. Simple zero-argument ViewBuilder closures are lowered
 * to their produced child arrays so runtime closure allocation/execution is
 * avoided entirely.
 */
export function lowerStaticImportedCalls(source: string, fileName: string): string {
  const syntax = ts.createSourceFile("mun-imports.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const importedNames = new Set<string>()
  const runtimeImports = runtimeViewImports(syntax)
  for (const statement of syntax.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
    if (statement.importClause.name) importedNames.add(statement.importClause.name.text)
    const bindings = statement.importClause.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) importedNames.add(element.name.text)
    }
  }
  if (!Array.from(importedNames).some(name => new RegExp(`\\b${name}\\s*\\(`).test(source))) return source

  const program = createMunTypeScriptProgram(source, fileName)
  if (!program) return source
  const { sourceFile, checker } = program
  const hasRestParameter = (signature: ts.Signature): boolean => signature.parameters.some(parameter => (
    parameter.declarations?.some(declaration => ts.isParameter(declaration) && declaration.dotDotDotToken) ?? false
  ))
  const candidates = new Map<ts.CallExpression, ImportedCallCandidate>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const type = checker.getTypeAtLocation(node.expression)
      const viewType = checker.getPropertyOfType(type, "viewType")
      const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call)
      const resolved = checker.getResolvedSignature(node)
      const initializerIndex = resolved
        ? signatures.findIndex(signature => signature === resolved || signature.declaration === resolved.declaration)
        : -1
      const selected = initializerIndex < 0 ? undefined : signatures[initializerIndex]
      if (viewType && selected && !hasRestParameter(selected)) {
        const runtimeName = runtimeImports.get(node.expression.text)
        const runtimeInitializers = runtimeName ? initializersOf((Core as Record<string, unknown>)[runtimeName]) : []
        let runtimeIndex = initializerIndex
        let runtimeParameters = runtimeInitializers[runtimeIndex]?.parameters
        if (node.arguments.some(isNamedArgumentsCarrier) && runtimeInitializers.length > 0) {
          const matches = runtimeInitializers.flatMap((initializer, index) => initializer.parameters
            && canNormalizeCompiledArguments(node.arguments, initializer.parameters, checker)
            ? [{ index, parameters: initializer.parameters }]
            : [])
          if (matches.length === 1) {
            runtimeIndex = matches[0].index
            runtimeParameters = matches[0].parameters
          }
        }
        const normalized = canNormalizeCompiledArguments(node.arguments, runtimeParameters, checker)
        // `namedArguments(...)` is a compiler carrier and can resolve to `any`
        // in partially-built workspaces. Its individual property expressions
        // were already checked by canNormalizeCompiledArguments(), so do not
        // let the synthetic wrapper alone disable an otherwise trusted call.
        const safeTypes = node.arguments.every((argument, argumentIndex) => {
          if (isNamedArgumentsCarrier(argument)) return normalized
          // A compiler-lowered ViewBuilder is a structural array factory. Once
          // its simple closure shape is recognized, the closure's broad TS
          // return type (often `any` in generated/custom View boundaries) does
          // not make the initializer unsafe: the builder contents remain graph
          // values and are validated/materialized independently. This is what
          // lets an intrinsic container become a compiled template even when a
          // custom View child must stay as a dynamic slot.
          if (isViewBuilderParameter(checker, selected, argumentIndex, argument)) {
            const text = source.slice(argument.getStart(sourceFile), argument.end)
            if (stripSimpleViewBuilder(text) !== undefined) return true
          }
          return !containsUnsafeCompiledType(checker.getTypeAtLocation(argument), checker)
        })
        candidates.set(node, { initializerIndex: runtimeIndex, signature: selected, compiled: normalized && safeTypes, runtimeParameters })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (candidates.size === 0) return source

  const ordered = [...candidates.keys()].sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile) || right.end - left.end)
  const children = new Map<ts.CallExpression | undefined, ts.CallExpression[]>()
  const stack: ts.CallExpression[] = []
  for (const candidate of ordered) {
    while (stack.length > 0 && candidate.getStart(sourceFile) >= stack[stack.length - 1].end) stack.pop()
    const parent = stack[stack.length - 1]
    const siblings = children.get(parent) ?? []
    siblings.push(candidate)
    children.set(parent, siblings)
    stack.push(candidate)
  }

  const replacements = new Map<ts.CallExpression, string>()
  const renderCandidate = (candidate: ts.CallExpression): string => {
    const cached = replacements.get(candidate)
    if (cached) return cached
    const plan = candidates.get(candidate)!
    const renderNode = (argument: ts.Expression): string => {
      let rendered = source.slice(argument.getStart(sourceFile), argument.end)
      const nested = (children.get(candidate) ?? [])
        .filter(child => child.getStart(sourceFile) >= argument.getStart(sourceFile) && child.end <= argument.end)
        .sort((left, right) => right.getStart(sourceFile) - left.getStart(sourceFile))
      for (const child of nested) {
        const replacement = renderCandidate(child)
        const start = child.getStart(sourceFile) - argument.getStart(sourceFile)
        const end = child.end - argument.getStart(sourceFile)
        rendered = rendered.slice(0, start) + replacement + rendered.slice(end)
      }
      return rendered
    }

    const renderedArguments = candidate.arguments.map(renderNode)
    let compiledArguments: string[] | undefined
    if (plan.compiled && plan.runtimeParameters) {
      const carrierIndex = candidate.arguments.findIndex(isNamedArgumentsCarrier)
      if (carrierIndex >= 0) {
        const carrierProperties = namedCarrierProperties(candidate.arguments[carrierIndex])
        if (carrierProperties) {
          const values = Array<string | undefined>(plan.runtimeParameters.length).fill(undefined)
          const keys = new Set(carrierProperties.map(property => property.key))
          const optionIndex = plan.runtimeParameters.findIndex(parameter => {
            const allowed = parameter.properties
            return !!allowed && keys.size > 0 && [...keys].every(key => allowed.includes(key))
          })
          if (optionIndex >= 0) {
            values[optionIndex] = `{ ${carrierProperties.map(property => `${JSON.stringify(property.key)}: ${renderNode(property.value)}`).join(", ")} }`
          } else {
            for (const property of carrierProperties) {
              const parameterIndex = plan.runtimeParameters.findIndex(parameter => parameter.label === property.key)
              if (parameterIndex >= 0) values[parameterIndex] = renderNode(property.value)
            }
          }

          let positionalIndex = 0
          for (let index = 0; index < plan.runtimeParameters.length; index += 1) {
            if (values[index] !== undefined) continue
            while (positionalIndex < candidate.arguments.length && positionalIndex === carrierIndex) positionalIndex += 1
            if (positionalIndex < candidate.arguments.length) {
              values[index] = renderedArguments[positionalIndex]
              positionalIndex += 1
              while (positionalIndex < candidate.arguments.length && positionalIndex === carrierIndex) positionalIndex += 1
            } else if (plan.runtimeParameters[index].required === false) {
              values[index] = "undefined"
            }
          }
          // Structural validity was proven by canNormalizeCompiledArguments().
          // At this stage we only need to ensure every runtime slot received a
          // concrete source expression (including explicit `undefined` for an
          // omitted optional parameter).
          if (values.every(value => value !== undefined)) compiledArguments = values as string[]
        }
      }
    }

    if (!compiledArguments) {
      compiledArguments = renderedArguments.map((rendered, argumentIndex) => {
        const argument = candidate.arguments[argumentIndex]
        if (plan.compiled && isViewBuilderParameter(checker, plan.signature, argumentIndex, argument)) {
          return stripSimpleViewBuilder(rendered) ?? rendered
        }
        return rendered
      })
    } else {
      compiledArguments = compiledArguments.map((rendered, argumentIndex) => {
        const parameter = plan.runtimeParameters?.[argumentIndex]
        return parameter?.kind === "viewBuilder" ? stripSimpleViewBuilder(rendered) ?? rendered : rendered
      })
    }

    const argumentsSource = compiledArguments.join(", ")
    const method = plan.compiled ? "createNodeCompiled" : "createNodeSpecialized"
    const replacement = `${candidate.expression.getText(sourceFile)}.viewType.${method}(${plan.initializerIndex}, [${argumentsSource}])`
    replacements.set(candidate, replacement)
    return replacement
  }

  let result = source
  for (const candidate of (children.get(undefined) ?? []).sort((left, right) => right.getStart(sourceFile) - left.getStart(sourceFile))) {
    const start = candidate.getStart(sourceFile)
    result = result.slice(0, start) + renderCandidate(candidate) + result.slice(candidate.end)
  }
  return result
}


interface SemanticSpecializationSnapshot {
  readonly sourceFile: ts.SourceFile
  readonly checker: ts.TypeChecker
  readonly runtimeImports: ReadonlyMap<string, string>
}

type StaticSemanticCandidate =
  | { readonly kind: "modifier"; readonly node: ts.CallExpression; readonly chain: { readonly base: ts.Expression; readonly calls: readonly StaticModifierCall[] } }
  | { readonly kind: "imported"; readonly node: ts.CallExpression; readonly plan: ImportedCallCandidate }

function createSemanticSpecializationSnapshot(source: string, fileName: string): SemanticSpecializationSnapshot | undefined {
  const program = createMunTypeScriptProgram(source, fileName)
  if (!program) return undefined
  return {
    sourceFile: program.sourceFile,
    checker: program.checker,
    runtimeImports: runtimeViewImports(program.sourceFile),
  }
}

function collectSemanticImportedCandidates(
  source: string,
  snapshot: SemanticSpecializationSnapshot,
): readonly StaticSemanticCandidate[] {
  const { sourceFile, checker, runtimeImports } = snapshot
  const hasRestParameter = (signature: ts.Signature): boolean => signature.parameters.some(parameter => (
    parameter.declarations?.some(declaration => ts.isParameter(declaration) && declaration.dotDotDotToken) ?? false
  ))
  const result: StaticSemanticCandidate[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const type = checker.getTypeAtLocation(node.expression)
      const viewType = checker.getPropertyOfType(type, "viewType")
      const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call)
      const resolved = checker.getResolvedSignature(node)
      const initializerIndex = resolved
        ? signatures.findIndex(signature => signature === resolved || signature.declaration === resolved.declaration)
        : -1
      const selected = initializerIndex < 0 ? undefined : signatures[initializerIndex]
      if (viewType && selected && !hasRestParameter(selected)) {
        const runtimeName = runtimeImports.get(node.expression.text)
        const runtimeInitializers = runtimeName ? initializersOf((Core as Record<string, unknown>)[runtimeName]) : []
        let runtimeIndex = initializerIndex
        let runtimeParameters = runtimeInitializers[runtimeIndex]?.parameters
        if (node.arguments.some(isNamedArgumentsCarrier) && runtimeInitializers.length > 0) {
          const matches = runtimeInitializers.flatMap((initializer, index) => initializer.parameters
            && canNormalizeCompiledArguments(node.arguments, initializer.parameters, checker)
            ? [{ index, parameters: initializer.parameters }]
            : [])
          if (matches.length === 1) {
            runtimeIndex = matches[0].index
            runtimeParameters = matches[0].parameters
          }
        }
        const normalized = canNormalizeCompiledArguments(node.arguments, runtimeParameters, checker)
        const safeTypes = node.arguments.every((argument, argumentIndex) => {
          if (isNamedArgumentsCarrier(argument)) return normalized
          if (isViewBuilderParameter(checker, selected, argumentIndex, argument)) {
            const rendered = source.slice(argument.getStart(sourceFile), argument.end)
            if (stripSimpleViewBuilder(rendered) !== undefined) return true
          }
          return !containsUnsafeCompiledType(checker.getTypeAtLocation(argument), checker)
        })
        result.push({
          kind: "imported",
          node,
          plan: { initializerIndex: runtimeIndex, signature: selected, compiled: normalized && safeTypes, runtimeParameters },
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return result
}

function collectSemanticModifierCandidates(snapshot: SemanticSpecializationSnapshot): readonly StaticSemanticCandidate[] {
  const { sourceFile, checker } = snapshot
  const result: StaticSemanticCandidate[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const chain = staticModifierChain(node)
      const parent = node.parent
      const isNestedChain = ts.isCallExpression(parent)
        && ts.isPropertyAccessExpression(parent.expression)
        && parent.expression.expression === node
        && staticModifierNames.has(parent.expression.name.text)
      if (chain && !isNestedChain && isMunViewType(checker, checker.getTypeAtLocation(chain.base))) {
        result.push({ kind: "modifier", node, chain })
        // Only maximal chains are semantic candidates. Imported constructor
        // candidates are collected by the independent traversal above, so
        // descending into this chain would create overlapping modifier roots.
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return result
}

function semanticCandidateStart(candidate: StaticSemanticCandidate, sourceFile: ts.SourceFile): number {
  return candidate.node.getStart(sourceFile)
}

function semanticCandidateEnd(candidate: StaticSemanticCandidate): number {
  return candidate.node.end
}

/**
 * Run every TypeChecker-dependent specialization from one immutable semantic
 * snapshot. Candidates are arranged by source containment before emission, so
 * imported constructor lowering and modifier lowering can freely nest without
 * reparsing the rewritten source or dropping an overlapping child rewrite.
 */
export function lowerStaticSemanticSpecializations(source: string, fileName: string): string {
  const hasModifierHint = Array.from(staticModifierNames).some(name => new RegExp(`\\.${name}\\s*\\(`).test(source))
  // Imported constructor specialization only recognizes the canonical runtime
  // modules below. Avoid constructing a TypeScript Program for ordinary helper
  // modules merely because they contain function calls; modifier chains remain
  // eligible because their View type can arrive through a local/transitive import.
  const hintFile = ts.createSourceFile("mun-semantic-hint.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const runtimeImports = runtimeViewImports(hintFile)
  const hasNamedRuntimeCall = [...runtimeImports.keys()].some(name => new RegExp(`\\b${name}\\s*\\(`).test(source))
  const namespaceImports = hintFile.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !canonicalRuntimeModules.has(statement.moduleSpecifier.text)) return []
    const bindings = statement.importClause?.namedBindings
    return bindings && ts.isNamespaceImport(bindings) ? [bindings.name.text] : []
  })
  const hasNamespaceRuntimeCall = namespaceImports.some(namespace => new RegExp(`\\b${namespace}\\s*\\.\\s*[A-Z][A-Za-z0-9_$]*\\s*\\(`).test(source))
  if (!hasModifierHint && !hasNamedRuntimeCall && !hasNamespaceRuntimeCall) return source

  const snapshot = createSemanticSpecializationSnapshot(source, fileName)
  if (!snapshot) return source
  const imported = collectSemanticImportedCandidates(source, snapshot)
  const modifiers = hasModifierHint ? collectSemanticModifierCandidates(snapshot) : []
  const candidates = [...imported, ...modifiers]
  if (candidates.length === 0) return source

  const { sourceFile, checker } = snapshot
  const ordered = [...candidates].sort((left, right) => {
    const startDelta = semanticCandidateStart(left, sourceFile) - semanticCandidateStart(right, sourceFile)
    return startDelta || semanticCandidateEnd(right) - semanticCandidateEnd(left)
  })
  const children = new Map<StaticSemanticCandidate | undefined, StaticSemanticCandidate[]>()
  const stack: StaticSemanticCandidate[] = []
  for (const candidate of ordered) {
    const start = semanticCandidateStart(candidate, sourceFile)
    const end = semanticCandidateEnd(candidate)
    while (stack.length > 0) {
      const parent = stack[stack.length - 1]
      if (start >= semanticCandidateStart(parent, sourceFile) && end <= semanticCandidateEnd(parent)) break
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    const siblings = children.get(parent) ?? []
    siblings.push(candidate)
    children.set(parent, siblings)
    stack.push(candidate)
  }

  const replacements = new Map<StaticSemanticCandidate, string>()
  let renderCandidate!: (candidate: StaticSemanticCandidate) => string
  const renderRange = (start: number, end: number, owner: StaticSemanticCandidate | undefined): string => {
    let rendered = source.slice(start, end)
    const nested = (children.get(owner) ?? [])
      .filter(candidate => semanticCandidateStart(candidate, sourceFile) >= start && semanticCandidateEnd(candidate) <= end)
      .sort((left, right) => semanticCandidateStart(right, sourceFile) - semanticCandidateStart(left, sourceFile))
    for (const child of nested) {
      const childStart = semanticCandidateStart(child, sourceFile)
      const childEnd = semanticCandidateEnd(child)
      rendered = rendered.slice(0, childStart - start) + renderCandidate(child) + rendered.slice(childEnd - start)
    }
    return rendered
  }

  renderCandidate = (candidate): string => {
    const cached = replacements.get(candidate)
    if (cached !== undefined) return cached

    if (candidate.kind === "modifier") {
      const { node, chain } = candidate
      const base = renderRange(chain.base.getStart(sourceFile), chain.base.end, candidate)
      const pendingMotionProperties = new Set<string>()
      const modifiersSource = chain.calls.map(({ name, node: call }) => {
        if (name === "animation" && call.arguments.length === 0) {
          const motionArguments = compiledAutoMotionArgumentsSource(pendingMotionProperties)
          pendingMotionProperties.clear()
          return `["animationAuto", [${motionArguments}]]`
        }
        const argumentsSource = call.arguments.length === 0 && (name === "padding" || name === "margin")
          ? name === "padding" ? "16" : "0"
          : call.arguments.map(argument => {
            let start = argument.getStart(sourceFile)
            let cursor = start - 1
            while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1
            if (source[cursor] === "." && !(cursor > 0 && /[A-Za-z0-9_$.)"'\]]/.test(source[cursor - 1]))) start = cursor
            const raw = renderRange(start, argument.end, candidate)
            return name === "contentTransition" ? lowerContentTransitionArgument(raw) : lowerImplicitMemberShorthand(lowerShorthand(raw))
          }).join(", ")
        if (name === "animation") pendingMotionProperties.clear()
        else for (const property of inferredMotionProperties(name, call)) pendingMotionProperties.add(property)
        return `[${JSON.stringify(name)}, [${argumentsSource}]]`
      }).join(", ")
      const replacement = `modifiedContentCompiled(${base}, [${modifiersSource}])`
      replacements.set(candidate, replacement)
      return replacement
    }

    const { node, plan } = candidate
    const renderNode = (argument: ts.Expression): string => renderRange(argument.getStart(sourceFile), argument.end, candidate)
    const renderedArguments = node.arguments.map(renderNode)
    let compiledArguments: string[] | undefined
    if (plan.compiled && plan.runtimeParameters) {
      const carrierIndex = node.arguments.findIndex(isNamedArgumentsCarrier)
      if (carrierIndex >= 0) {
        const carrierProperties = namedCarrierProperties(node.arguments[carrierIndex])
        if (carrierProperties) {
          const values = Array<string | undefined>(plan.runtimeParameters.length).fill(undefined)
          const keys = new Set(carrierProperties.map(property => property.key))
          const optionIndex = plan.runtimeParameters.findIndex(parameter => {
            const allowed = parameter.properties
            return !!allowed && keys.size > 0 && [...keys].every(key => allowed.includes(key))
          })
          if (optionIndex >= 0) {
            values[optionIndex] = `{ ${carrierProperties.map(property => `${JSON.stringify(property.key)}: ${renderNode(property.value)}`).join(", ")} }`
          } else {
            for (const property of carrierProperties) {
              const parameterIndex = plan.runtimeParameters.findIndex(parameter => parameter.label === property.key)
              if (parameterIndex >= 0) values[parameterIndex] = renderNode(property.value)
            }
          }
          let positionalIndex = 0
          for (let index = 0; index < plan.runtimeParameters.length; index += 1) {
            if (values[index] !== undefined) continue
            while (positionalIndex < node.arguments.length && positionalIndex === carrierIndex) positionalIndex += 1
            if (positionalIndex < node.arguments.length) {
              values[index] = renderedArguments[positionalIndex]
              positionalIndex += 1
              while (positionalIndex < node.arguments.length && positionalIndex === carrierIndex) positionalIndex += 1
            } else if (plan.runtimeParameters[index].required === false) {
              values[index] = "undefined"
            }
          }
          if (values.every(value => value !== undefined)) compiledArguments = values as string[]
        }
      }
    }

    if (!compiledArguments) {
      compiledArguments = renderedArguments.map((rendered, argumentIndex) => {
        const argument = node.arguments[argumentIndex]
        return plan.compiled && isViewBuilderParameter(checker, plan.signature, argumentIndex, argument)
          ? stripSimpleViewBuilder(rendered) ?? rendered
          : rendered
      })
    } else {
      compiledArguments = compiledArguments.map((rendered, argumentIndex) => (
        plan.runtimeParameters?.[argumentIndex]?.kind === "viewBuilder" ? stripSimpleViewBuilder(rendered) ?? rendered : rendered
      ))
    }

    const method = plan.compiled ? "createNodeCompiled" : "createNodeSpecialized"
    const replacement = `${node.expression.getText(sourceFile)}.viewType.${method}(${plan.initializerIndex}, [${compiledArguments.join(", ")}])`
    replacements.set(candidate, replacement)
    return replacement
  }

  let result = source
  for (const candidate of (children.get(undefined) ?? []).sort((left, right) => semanticCandidateStart(right, sourceFile) - semanticCandidateStart(left, sourceFile))) {
    const start = semanticCandidateStart(candidate, sourceFile)
    result = result.slice(0, start) + renderCandidate(candidate) + result.slice(semanticCandidateEnd(candidate))
  }
  return result
}

function importedBindingsOf(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const bindings = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
    if (statement.importClause.name) bindings.add(statement.importClause.name.text)
    const named = statement.importClause.namedBindings
    if (named && ts.isNamedImports(named)) for (const element of named.elements) bindings.add(element.name.text)
    if (named && ts.isNamespaceImport(named)) bindings.add(named.name.text)
  }
  return bindings
}

interface AnimationBindings {
  readonly named: ReadonlySet<string>
  readonly namespaces: ReadonlySet<string>
}

function animationBindingsOf(sourceFile: ts.SourceFile): AnimationBindings {
  const named = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const moduleName = statement.moduleSpecifier.text
    if (!moduleName.startsWith("@mun/")) continue
    const bindings = statement.importClause.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === "Animation") named.add(element.name.text)
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text)
    }
  }
  return { named, namespaces }
}

const staticAnimationFactories = new Set([
  "linear", "easeIn", "easeOut", "easeInOut", "spring", "interactiveSpring", "smooth", "snappy", "bouncy",
])
const staticAnimationTransforms = new Set(["delay", "speed", "repeatCount", "repeatForever"])

function isAnimationTypeExpression(node: ts.Expression, bindings: AnimationBindings): boolean {
  if (ts.isIdentifier(node)) return bindings.named.has(node.text)
  return ts.isPropertyAccessExpression(node)
    && node.name.text === "Animation"
    && ts.isIdentifier(node.expression)
    && bindings.namespaces.has(node.expression.text)
}

function hasOnlyStaticArguments(node: ts.CallExpression): boolean {
  return node.arguments.every(argument => !ts.isSpreadElement(argument) && staticExpressionValue(argument).ok)
}

/** True only for immutable Animation values whose entire descriptor is known at compile time. */
function isStaticAnimationExpression(node: ts.Expression, bindings: AnimationBindings): boolean {
  let expression = node
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) {
    expression = expression.expression
  }
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === "default") {
    return isAnimationTypeExpression(expression.expression, bindings)
  }
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression) || !hasOnlyStaticArguments(expression)) return false
  const access = expression.expression
  if (staticAnimationFactories.has(access.name.text)) return isAnimationTypeExpression(access.expression, bindings)
  return staticAnimationTransforms.has(access.name.text) && isStaticAnimationExpression(access.expression, bindings)
}

function isStaticLiteralExpression(node: ts.Expression, imported: ReadonlySet<string>): boolean {
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true
  if (ts.isIdentifier(node)) return node.text === "undefined"
  if (ts.isParenthesizedExpression(node)) return isStaticLiteralExpression(node.expression, imported)
  if (ts.isPrefixUnaryExpression(node)) return (node.operator === ts.SyntaxKind.PlusToken || node.operator === ts.SyntaxKind.MinusToken) && isStaticLiteralExpression(node.operand, imported)
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(element => ts.isExpression(element) && isStaticLiteralExpression(element, imported))
  if (ts.isObjectLiteralExpression(node)) return node.properties.every(property => {
    if (!ts.isPropertyAssignment(property)) return false
    if (property.name && ts.isComputedPropertyName(property.name)) return false
    return isStaticLiteralExpression(property.initializer, imported)
  })
  return isStaticGraphExpression(node, imported)
}

function compiledViewReceiver(node: ts.Expression, imported: ReadonlySet<string>): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "createNodeCompiled") return false
  const viewType = node.expression
  return ts.isPropertyAccessExpression(viewType)
    && viewType.name.text === "viewType"
    && ts.isIdentifier(viewType.expression)
    && imported.has(viewType.expression.text)
}

function isStaticGraphExpression(node: ts.Expression, imported: ReadonlySet<string>): boolean {
  if (!ts.isCallExpression(node)) return false
  if (compiledViewReceiver(node.expression, imported)) {
    return node.arguments.length === 2
      && ts.isNumericLiteral(node.arguments[0])
      && ts.isArrayLiteralExpression(node.arguments[1])
      && isStaticLiteralExpression(node.arguments[1], imported)
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === "modifiedContentCompiled" && imported.has(node.expression.text)) {
    return node.arguments.length === 2
      && isStaticGraphExpression(node.arguments[0], imported)
      && isStaticLiteralExpression(node.arguments[1], imported)
  }
  return false
}

function isTopLevelInitializer(node: ts.Expression): boolean {
  let current: ts.Expression = node
  while (
    ts.isParenthesizedExpression(current.parent)
    || ts.isAsExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent)
    || ts.isSatisfiesExpression(current.parent)
    || ts.isNonNullExpression(current.parent)
  ) current = current.parent

  const declaration = current.parent
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== current) return false
  const declarationList = declaration.parent
  const statement = declarationList.parent
  return ts.isVariableDeclarationList(declarationList)
    && ts.isVariableStatement(statement)
    && ts.isSourceFile(statement.parent)
}

/**
 * Hoist immutable, import-only compiled graph subtrees out of render functions.
 * The analysis is deliberately conservative: local variables, functions,
 * getters, refs, State reads, property accesses, and opaque calls all block a
 * hoist. Dynamic parents can still reuse any fully-static child subtrees.
 */

interface CompiledViewCallShape {
  readonly node: ts.CallExpression
  readonly localName: string
  readonly runtimeName: string
  readonly initializerIndex: number
  readonly args: readonly ts.Expression[]
}

type CompilerTemplateIR =
  | string | number | bigint | boolean | null | undefined
  | { readonly kind: "slot"; readonly index: number; readonly identity: readonly (string | number)[] }
  | { readonly kind: "element"; readonly type: string; readonly props: Record<string, unknown> | null; readonly children: readonly CompilerTemplateIR[] }
  | { readonly kind: "fragment"; readonly children: readonly CompilerTemplateIR[] }

interface CompilerTemplateSlotPlan {
  readonly source: string
  readonly kind: "view" | "text"
}

interface CompilerTemplatePlan {
  readonly root: CompilerTemplateIR
  readonly slots: readonly CompilerTemplateSlotPlan[]
}

interface StaticExpressionResult {
  readonly ok: boolean
  readonly value?: unknown
}

function staticPrimitiveSource(value: unknown): string | undefined {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "bigint") return `${value}n`
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined
    if (Object.is(value, -0)) return "-0"
    return String(value)
  }
  return undefined
}

function staticExpressionValue(node: ts.Expression): StaticExpressionResult {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
    return staticExpressionValue(node.expression)
  }
  if (ts.isStringLiteralLike(node)) return { ok: true, value: node.text }
  if (ts.isNumericLiteral(node)) return { ok: true, value: Number(node.text) }
  if (ts.isBigIntLiteral(node)) return { ok: true, value: BigInt(node.text.slice(0, -1).replaceAll("_", "")) }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true }
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false }
  if (node.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null }
  if (ts.isIdentifier(node) && node.text === "undefined") return { ok: true, value: undefined }
  if (ts.isPrefixUnaryExpression(node)) {
    const operand = staticExpressionValue(node.operand)
    if (!operand.ok) return { ok: false }
    if (node.operator === ts.SyntaxKind.ExclamationToken) return { ok: true, value: !operand.value }
    if (node.operator === ts.SyntaxKind.TildeToken && (typeof operand.value === "number" || typeof operand.value === "bigint")) return { ok: true, value: ~operand.value as number }
    if (node.operator === ts.SyntaxKind.MinusToken && (typeof operand.value === "number" || typeof operand.value === "bigint")) return { ok: true, value: -operand.value as number }
    if (node.operator === ts.SyntaxKind.PlusToken && typeof operand.value === "number") return { ok: true, value: operand.value }
    return { ok: false }
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text
    for (const span of node.templateSpans) {
      const expression = staticExpressionValue(span.expression)
      if (!expression.ok || (typeof expression.value === "symbol")) return { ok: false }
      value += String(expression.value) + span.literal.text
    }
    return { ok: true, value }
  }
  if (ts.isConditionalExpression(node)) {
    const condition = staticExpressionValue(node.condition)
    return condition.ok ? staticExpressionValue(condition.value ? node.whenTrue : node.whenFalse) : { ok: false }
  }
  if (ts.isBinaryExpression(node)) {
    const left = staticExpressionValue(node.left)
    if (!left.ok) return { ok: false }
    const operator = node.operatorToken.kind
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return left.value ? staticExpressionValue(node.right) : left
    if (operator === ts.SyntaxKind.BarBarToken) return left.value ? left : staticExpressionValue(node.right)
    if (operator === ts.SyntaxKind.QuestionQuestionToken) return left.value !== null && left.value !== undefined ? left : staticExpressionValue(node.right)
    const right = staticExpressionValue(node.right)
    if (!right.ok) return { ok: false }
    try {
      switch (operator) {
        case ts.SyntaxKind.PlusToken: return { ok: true, value: (left.value as any) + (right.value as any) }
        case ts.SyntaxKind.MinusToken: return { ok: true, value: (left.value as any) - (right.value as any) }
        case ts.SyntaxKind.AsteriskToken: return { ok: true, value: (left.value as any) * (right.value as any) }
        case ts.SyntaxKind.SlashToken: return { ok: true, value: (left.value as any) / (right.value as any) }
        case ts.SyntaxKind.PercentToken: return { ok: true, value: (left.value as any) % (right.value as any) }
        case ts.SyntaxKind.AsteriskAsteriskToken: return { ok: true, value: (left.value as any) ** (right.value as any) }
        case ts.SyntaxKind.LessThanLessThanToken: return { ok: true, value: (left.value as any) << (right.value as any) }
        case ts.SyntaxKind.GreaterThanGreaterThanToken: return { ok: true, value: (left.value as any) >> (right.value as any) }
        case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: return { ok: true, value: (left.value as any) >>> (right.value as any) }
        case ts.SyntaxKind.AmpersandToken: return { ok: true, value: (left.value as any) & (right.value as any) }
        case ts.SyntaxKind.BarToken: return { ok: true, value: (left.value as any) | (right.value as any) }
        case ts.SyntaxKind.CaretToken: return { ok: true, value: (left.value as any) ^ (right.value as any) }
        case ts.SyntaxKind.LessThanToken: return { ok: true, value: (left.value as any) < (right.value as any) }
        case ts.SyntaxKind.LessThanEqualsToken: return { ok: true, value: (left.value as any) <= (right.value as any) }
        case ts.SyntaxKind.GreaterThanToken: return { ok: true, value: (left.value as any) > (right.value as any) }
        case ts.SyntaxKind.GreaterThanEqualsToken: return { ok: true, value: (left.value as any) >= (right.value as any) }
        case ts.SyntaxKind.EqualsEqualsToken: return { ok: true, value: (left.value as any) == (right.value as any) }
        case ts.SyntaxKind.ExclamationEqualsToken: return { ok: true, value: (left.value as any) != (right.value as any) }
        case ts.SyntaxKind.EqualsEqualsEqualsToken: return { ok: true, value: left.value === right.value }
        case ts.SyntaxKind.ExclamationEqualsEqualsToken: return { ok: true, value: left.value !== right.value }
        default: return { ok: false }
      }
    } catch {
      return { ok: false }
    }
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values: unknown[] = []
    for (const element of node.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return { ok: false }
      const item = staticExpressionValue(element)
      if (!item.ok) return { ok: false }
      values.push(item.value)
    }
    return { ok: true, value: values }
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, unknown> = {}
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return { ok: false }
      const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name)
        ? property.name.text
        : undefined
      if (key === undefined) return { ok: false }
      const item = staticExpressionValue(property.initializer)
      if (!item.ok) return { ok: false }
      value[key] = item.value
    }
    return { ok: true, value }
  }
  return { ok: false }
}

/** Fold side-effect-free expressions whose actual primitive result is known. */
export function foldStaticResults(source: string): string {
  const sourceFile = staticSyntaxSourceFile(source)
  const edits: Array<{ readonly start: number; readonly end: number; readonly replacement: string }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node)) {
      const composite = ts.isPrefixUnaryExpression(node) || ts.isBinaryExpression(node) || ts.isConditionalExpression(node) || ts.isTemplateExpression(node)
      if (composite) {
        const result = staticExpressionValue(node)
        const replacement = result.ok ? staticPrimitiveSource(result.value) : undefined
        if (replacement !== undefined) {
          edits.push({ start: node.getStart(sourceFile), end: node.end, replacement })
          return
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  let result = source
  for (const edit of edits.sort((left, right) => right.start - left.start)) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
  return result
}

function compiledViewCallShape(
  node: ts.Node,
  runtimeImports: ReadonlyMap<string, string>,
): CompiledViewCallShape | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "createNodeCompiled") return undefined
  const viewType = node.expression.expression
  if (!ts.isPropertyAccessExpression(viewType) || viewType.name.text !== "viewType" || !ts.isIdentifier(viewType.expression)) return undefined
  if (node.arguments.length !== 2 || !ts.isNumericLiteral(node.arguments[0]) || !ts.isArrayLiteralExpression(node.arguments[1])) return undefined
  const runtimeName = runtimeImports.get(viewType.expression.text)
  if (!runtimeName) return undefined
  return {
    node,
    localName: viewType.expression.text,
    runtimeName,
    initializerIndex: Number(node.arguments[0].text),
    args: [...node.arguments[1].elements].filter(ts.isExpression),
  }
}

function staticTemplateDataSource(value: unknown, seen = new Set<object>()): string | undefined {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined
  if (typeof value === "bigint") return `${String(value)}n`
  if (typeof value !== "object") return undefined
  if (seen.has(value)) return undefined
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const items = value.map(item => staticTemplateDataSource(item, seen))
      return items.some(item => item === undefined) ? undefined : `[${items.join(", ")}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const entries: string[] = []
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) return undefined
      const item = staticTemplateDataSource(descriptor.value, seen)
      if (item === undefined) return undefined
      entries.push(`${JSON.stringify(key)}: ${item}`)
    }
    return `{ ${entries.join(", ")} }`
  } catch {
    return undefined
  } finally {
    seen.delete(value)
  }
}

function offsetTemplateSlots(value: CompilerTemplateIR, offset: number): CompilerTemplateIR {
  if (value !== null && typeof value === "object") {
    if (value.kind === "slot") return { kind: "slot", index: value.index + offset, identity: value.identity }
    if (value.kind === "fragment") return { kind: "fragment", children: value.children.map(child => offsetTemplateSlots(child, offset)) }
    return { ...value, children: value.children.map(child => offsetTemplateSlots(child, offset)) }
  }
  return value
}

function prefixTemplateIdentity(value: CompilerTemplateIR, prefix: readonly (string | number)[]): CompilerTemplateIR {
  if (value !== null && typeof value === "object") {
    if (value.kind === "slot") return { ...value, identity: [...prefix, ...value.identity] }
    if (value.kind === "fragment") return { kind: "fragment", children: value.children.map(child => prefixTemplateIdentity(child, prefix)) }
    return { ...value, children: value.children.map(child => prefixTemplateIdentity(child, prefix)) }
  }
  return value
}

function compilerTemplateSource(value: CompilerTemplateIR): string | undefined {
  if (value !== null && typeof value === "object") {
    if (value.kind === "slot") return `{ kind: "slot", index: ${value.index}, identity: [${value.identity.map(item => typeof item === "number" ? String(item) : JSON.stringify(item)).join(", ")}] }`
    if (value.kind === "fragment") {
      const children = value.children.map(compilerTemplateSource)
      return children.some(item => item === undefined) ? undefined : `{ kind: "fragment", children: [${children.join(", ")}] }`
    }
    const props = value.props === null ? "null" : staticTemplateDataSource(value.props)
    if (props === undefined) return undefined
    const children = value.children.map(compilerTemplateSource)
    return children.some(item => item === undefined) ? undefined : `{ kind: "element", type: ${JSON.stringify(value.type)}, props: ${props}, children: [${children.join(", ")}] }`
  }
  return staticTemplateDataSource(value)
}

/**
 * Assign compiler text slots to the renderer's stable pre-order host-node
 * table. A generic View slot may expand to an arbitrary node range, so no
 * positional Patch IR is emitted when one is present.
 */
function compilerTemplateTextPatchLocations(plan: CompilerTemplatePlan): readonly { readonly node: number; readonly kind: "text" }[] {
  if (plan.slots.length === 0 || plan.slots.some(slot => slot.kind !== "text")) return []
  const locations: Array<{ readonly node: number; readonly kind: "text" } | undefined> = Array(plan.slots.length)
  let nodeIndex = 0
  const visit = (value: CompilerTemplateIR): void => {
    if (value !== null && typeof value === "object") {
      if (value.kind === "fragment") {
        for (const child of value.children) visit(child)
        return
      }
      if (value.kind === "slot") {
        locations[value.index] = { node: nodeIndex, kind: "text" }
        nodeIndex += 1
        return
      }
      nodeIndex += 1
      for (const child of value.children) visit(child)
      return
    }
    nodeIndex += 1
  }
  visit(plan.root)
  return locations.every(location => location !== undefined)
    ? locations as readonly { readonly node: number; readonly kind: "text" }[]
    : []
}


interface CompilerTemplateCost {
  readonly staticNodes: number
  readonly staticProps: number
  readonly primitiveLeaves: number
}

function compilerTemplateCost(value: CompilerTemplateIR): CompilerTemplateCost {
  if (value !== null && typeof value === "object") {
    if (value.kind === "slot") return { staticNodes: 0, staticProps: 0, primitiveLeaves: 0 }
    if (value.kind === "fragment") {
      return value.children.reduce<CompilerTemplateCost>((total, child) => {
        const cost = compilerTemplateCost(child)
        return {
          staticNodes: total.staticNodes + cost.staticNodes,
          staticProps: total.staticProps + cost.staticProps,
          primitiveLeaves: total.primitiveLeaves + cost.primitiveLeaves,
        }
      }, { staticNodes: 0, staticProps: 0, primitiveLeaves: 0 })
    }
    const childCost = value.children.reduce<CompilerTemplateCost>((total, child) => {
      const cost = compilerTemplateCost(child)
      return {
        staticNodes: total.staticNodes + cost.staticNodes,
        staticProps: total.staticProps + cost.staticProps,
        primitiveLeaves: total.primitiveLeaves + cost.primitiveLeaves,
      }
    }, { staticNodes: 0, staticProps: 0, primitiveLeaves: 0 })
    return {
      staticNodes: childCost.staticNodes + 1,
      staticProps: childCost.staticProps + Object.keys(value.props ?? {}).length,
      primitiveLeaves: childCost.primitiveLeaves,
    }
  }
  return { staticNodes: 0, staticProps: 0, primitiveLeaves: 1 }
}

/**
 * Tiny cost model used as the compiler's path selector. Runtime allocation and
 * reconciliation work intentionally outweigh a modest code-size increase in
 * the default production-oriented profile. A rejected outer template is still
 * traversed so profitable nested templates can be selected independently.
 */
function shouldCompileTemplatePlan(plan: CompilerTemplatePlan, node: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  const rootSource = compilerTemplateSource(plan.root)
  if (rootSource === undefined) return false
  const cost = compilerTemplateCost(plan.root)
  const textSlots = plan.slots.filter(slot => slot.kind === "text").length
  // Zero-slot templates are still valuable: the DOM renderer can carry their
  // live roots through later dynamic modifier updates without recreating the
  // immutable host subtree. This is especially common for static Text/Image
  // content wrapped by a dynamic opacity/frame/style chain.
  const reusableStaticRoot = plan.slots.length === 0 && cost.staticNodes > 0
  const runtimeSavings = cost.staticNodes * 14
    + cost.staticProps * 3
    + cost.primitiveLeaves * 2
    + textSlots * 4
    + (reusableStaticRoot ? 8 : 0)
  const slotOverhead = plan.slots.length * 2
  const originalBytes = Math.max(1, node.end - node.getStart(sourceFile))
  const emittedGrowth = Math.max(0, rootSource.length - originalBytes) / 48
  return runtimeSavings - slotOverhead - emittedGrowth > 0
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

function exactReturnedExpression(expression: ts.Expression): ts.Expression | undefined {
  let current = expression
  while (true) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)
      || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression
      continue
    }
    if (ts.isCallExpression(current) && current.arguments.length === 0) {
      let callee: ts.Expression = current.expression
      while (ts.isParenthesizedExpression(callee)) callee = callee.expression
      if (ts.isArrowFunction(callee) && callee.parameters.length === 0) {
        const returned = exactFunctionReturn(callee)
        if (!returned) return undefined
        current = returned
        continue
      }
    }
    return current
  }
}

function exactFunctionReturn(fn: ts.ArrowFunction): ts.Expression | undefined {
  if (!ts.isBlock(fn.body)) return exactReturnedExpression(fn.body)
  if (fn.body.statements.length === 0) return undefined
  const statements = [...fn.body.statements]
  const last = statements.pop()
  if (!last || !ts.isReturnStatement(last) || !last.expression) return undefined
  // The slot evaluator is produced by replacing only the final compiled View
  // expression in the original body source. Restrict the prelude to linear
  // statements so no alternate return/control-flow path can be skipped.
  if (statements.some(statement => !ts.isVariableStatement(statement) && !ts.isExpressionStatement(statement))) return undefined
  return exactReturnedExpression(last.expression)
}

const directCompiledBodyModifierNames = new Set([
  "padding", "margin", "gap", "font", "fontSize", "bold",
  "foreground", "foregroundStyle", "opacity",
  "fontWeight", "fontDesign", "fontWidth", "italic", "underline", "strikethrough", "monospaced", "monospacedDigit",
  "kerning", "tracking", "baselineOffset", "lineSpacing", "lineLimit", "minimumScaleFactor", "multilineTextAlignment", "truncationMode", "textCase", "allowsTightening",
  "scaleEffect", "rotationEffect", "offset", "aspectRatio", "scaledToFit", "scaledToFill", "fixedSize", "layoutPriority", "position", "zIndex",
  "clipShape", "clipped", "border", "shadow", "blur", "brightness", "contrast", "saturation", "grayscale", "hueRotation", "colorInvert", "colorMultiply", "blendMode", "compositingGroup", "drawingGroup", "luminanceToAlpha", "tint",
  "hidden", "allowsHitTesting", "preferredColorScheme", "controlSize", "scrollDisabled", "scrollIndicators", "scrollBounceBehavior", "scrollClipDisabled", "scrollDismissesKeyboard",
  "accessibilityLabel", "accessibilityHint", "accessibilityValue", "accessibilityHidden", "accessibilityIdentifier", "accessibilityHeading", "accessibilitySortPriority",
  "style", "className", "animation", "animationAuto", "contentTransition",
])

function directCompiledModifierSpecs(node: ts.Expression): node is ts.ArrayLiteralExpression {
  if (!ts.isArrayLiteralExpression(node)) return false
  return node.elements.every(element => {
    if (!ts.isArrayLiteralExpression(element) || element.elements.length !== 2) return false
    const [name, arguments_] = element.elements
    return ts.isStringLiteral(name)
      && directCompiledBodyModifierNames.has(name.text)
      && ts.isArrayLiteralExpression(arguments_)
      && arguments_.elements.every(argument => !ts.isSpreadElement(argument))
  })
}

function compilerGeneratedViewDefinition(node: ts.ObjectLiteralExpression): boolean {
  if (!ts.isCallExpression(node.parent)) return false
  const call = node.parent
  if (!ts.isIdentifier(call.expression)) return false
  if (call.expression.text === "view") return call.arguments[0] === node
  if (call.expression.text === "defineView" || call.expression.text === "structView") return call.arguments[1] === node
  return false
}

function compilerDependencyNames(property: ts.ObjectLiteralElementLike | undefined): readonly string[] | undefined {
  if (!property || !ts.isPropertyAssignment(property)) return undefined
  const initializer = exactReturnedExpression(property.initializer)
  if (!initializer || !ts.isArrowFunction(initializer) || initializer.parameters.length !== 1) return undefined
  const parameter = initializer.parameters[0]
  if (!ts.isIdentifier(parameter.name)) return undefined
  const returned = exactFunctionReturn(initializer)
  if (!returned || !ts.isArrayLiteralExpression(returned)) return undefined
  const names: string[] = []
  for (const element of returned.elements) {
    if (!ts.isPropertyAccessExpression(element)
      || !ts.isIdentifier(element.expression)
      || element.expression.text !== parameter.name.text) return undefined
    names.push(element.name.text)
  }
  return names.length > 0 ? Object.freeze(names) : undefined
}

function compilerBodyHasOnlyPropsPrelude(fn: ts.ArrowFunction): boolean {
  if (!ts.isBlock(fn.body)) return true
  if (fn.parameters.length !== 1 || !ts.isIdentifier(fn.parameters[0].name)) return false
  const parameter = fn.parameters[0].name.text
  const statements = fn.body.statements.slice(0, -1)
  return statements.every(statement => {
    if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return false
    const declaration = statement.declarationList.declarations[0]!
    return ts.isObjectBindingPattern(declaration.name)
      && declaration.initializer !== undefined
      && ts.isIdentifier(declaration.initializer)
      && declaration.initializer.text === parameter
  })
}

function directSlotDependencyNames(source: string, dependencyNames: readonly string[]): readonly string[] {
  const sourceFile = staticSyntaxSourceFile(source)
  const available = new Set(dependencyNames)
  const found = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && available.has(node.text)) found.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return Object.freeze([...found])
}

/**
 * Turn compiled intrinsic View construction into an immutable host template plus
 * runtime graph/value slots. The pass evaluates only the already-proven builtin
 * initializer with static non-builder arguments, so host props/styles come from
 * core's real View body instead of a second compiler-side semantic table.
 *
 * Dynamic Text content and builder children become slots. Any opaque argument,
 * function-valued prop, non-host graph node, spread builder, or unsupported
 * builtin simply keeps the existing createNodeCompiled graph path.
 */
export function lowerCompiledViewTemplates(source: string): string {
  if (!source.includes("createNodeCompiled")) return source
  const sourceFile = staticSyntaxSourceFile(source)
  const runtimeImports = runtimeViewImports(sourceFile)
  if (runtimeImports.size === 0) return source

  type Marker = { readonly token: object; readonly slot?: CompilerTemplateSlotPlan; readonly nested?: CompilerTemplatePlan }
  const memo = new Map<ts.CallExpression, CompilerTemplatePlan | null>()
  const building = new Set<ts.CallExpression>()

  const build = (node: ts.CallExpression): CompilerTemplatePlan | undefined => {
    if (memo.has(node)) return memo.get(node) ?? undefined
    if (building.has(node)) return undefined
    const shape = compiledViewCallShape(node, runtimeImports)
    if (!shape) { memo.set(node, null); return undefined }
    const target = (Core as Record<string, any>)[shape.runtimeName]
    const runtimeInitializers = initializersOf(target)
    const initializer = runtimeInitializers[shape.initializerIndex]
    const parameters = initializer?.parameters
    if (typeof target !== "function" || !initializer || !parameters || parameters.length !== shape.args.length) {
      memo.set(node, null)
      return undefined
    }
    building.add(node)
    try {
      const markers = new Map<object, Marker>()
      const runtimeArgs: unknown[] = []
      const slotMarker = (slot: CompilerTemplateSlotPlan): object => {
        const token = Object.freeze({ __munCompilerTemplateSlot: markers.size })
        markers.set(token, { token, slot })
        return token
      }
      const viewMarker = (marker: Omit<Marker, "token">): object => {
        // A real fragment-shaped node safely passes through ViewBuilder content
        // and is retained by reference by intrinsic host bodies.
        const token = Core.viewFragment([]) as object
        markers.set(token, { token, ...marker })
        return token
      }

      for (let index = 0; index < shape.args.length; index += 1) {
        const argument = shape.args[index]
        const parameter = parameters[index]
        if (parameter.kind === "viewBuilder") {
          if (!ts.isArrayLiteralExpression(argument)) { memo.set(node, null); return undefined }
          const children: unknown[] = []
          for (const child of argument.elements) {
            if (!ts.isExpression(child) || ts.isSpreadElement(child)) { memo.set(node, null); return undefined }
            if (ts.isCallExpression(child)) {
              const nested = build(child)
              if (nested) {
                children.push(viewMarker({ nested }))
                continue
              }
            }
            const literal = staticExpressionValue(child)
            if (literal.ok && (literal.value === null || literal.value === undefined || ["string", "number", "bigint", "boolean"].includes(typeof literal.value))) {
              children.push(literal.value)
              continue
            }
            children.push(viewMarker({ slot: { source: source.slice(child.getStart(sourceFile), child.end), kind: "view" } }))
          }
          runtimeArgs.push(children)
          continue
        }
        if (shape.runtimeName === "Text" && shape.initializerIndex === 0 && index === 0) {
          const literal = staticExpressionValue(argument)
          if (literal.ok && (typeof literal.value === "string" || typeof literal.value === "number")) runtimeArgs.push(literal.value)
          else runtimeArgs.push(slotMarker({ source: source.slice(argument.getStart(sourceFile), argument.end), kind: "text" }))
          continue
        }
        const literal = staticExpressionValue(argument)
        if (!literal.ok) { memo.set(node, null); return undefined }
        runtimeArgs.push(literal.value)
      }

      let graph: any
      try {
        graph = target.viewType.createNodeCompiled(shape.initializerIndex, runtimeArgs)
      } catch {
        memo.set(node, null)
        return undefined
      }
      const slots: CompilerTemplateSlotPlan[] = []
      const serialize = (value: unknown, identity: readonly (string | number)[] = []): CompilerTemplateIR | undefined => {
        if (typeof value === "object" && value !== null) {
          const marker = markers.get(value)
          if (marker) {
            if (marker.nested) {
              const offset = slots.length
              slots.push(...marker.nested.slots)
              return prefixTemplateIdentity(offsetTemplateSlots(marker.nested.root, offset), identity)
            }
            if (marker.slot !== undefined) {
              const index = slots.length
              slots.push(marker.slot)
              return { kind: "slot", index, identity }
            }
          }
        }
        if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return value
        if (typeof value !== "object") return undefined
        const item = value as { readonly kind?: unknown; readonly type?: unknown; readonly props?: unknown; readonly children?: unknown }
        if (item.kind === "fragment" && Array.isArray(item.children)) {
          const children = item.children.map((child, index) => serialize(child, [...identity, "fragment", index]))
          return children.some(child => child === undefined) ? undefined : { kind: "fragment", children: children as CompilerTemplateIR[] }
        }
        if (item.kind === "element" && typeof item.type === "string" && Array.isArray(item.children)) {
          if (item.props !== null && item.props !== undefined && staticTemplateDataSource(item.props) === undefined) return undefined
          const children = item.children.map((child, index) => serialize(child, [...identity, "element", index]))
          return children.some(child => child === undefined) ? undefined : {
            kind: "element",
            type: item.type,
            props: item.props === null || item.props === undefined ? null : item.props as Record<string, unknown>,
            children: children as CompilerTemplateIR[],
          }
        }
        return undefined
      }
      const root = serialize(graph)
      if (root === undefined) { memo.set(node, null); return undefined }
      const plan = { root, slots } satisfies CompilerTemplatePlan
      memo.set(node, plan)
      return plan
    } finally {
      building.delete(node)
    }
  }

  const roots: Array<{ readonly node: ts.CallExpression; readonly plan: CompilerTemplatePlan }> = []
  const visit = (node: ts.Node, templatedAncestor = false): void => {
    if (ts.isCallExpression(node)) {
      const plan = build(node)
      if (plan && !templatedAncestor && shouldCompileTemplatePlan(plan, node, sourceFile)) {
        roots.push({ node, plan })
        return
      }
    }
    ts.forEachChild(node, child => visit(child, templatedAncestor))
  }
  visit(sourceFile)
  if (roots.length === 0) return source

  const names = new Set<string>()
  const collectNames = (node: ts.Node): void => { if (ts.isIdentifier(node)) names.add(node.text); ts.forEachChild(node, collectNames) }
  collectNames(sourceFile)
  let counter = 0
  const nextName = (): string => {
    let name = `__munTemplate${counter++}`
    while (names.has(name)) name = `__munTemplate${counter++}`
    names.add(name)
    return name
  }

  const compiledRoots = roots.map(({ node, plan }) => {
    const rootSource = compilerTemplateSource(plan.root)
    if (rootSource === undefined) return undefined
    return { node, plan, rootSource, name: nextName() }
  }).filter((value): value is {
    node: ts.CallExpression
    plan: CompilerTemplatePlan
    rootSource: string
    name: string
  } => value !== undefined)
  if (compiledRoots.length === 0) return source

  const declarations = compiledRoots.map(({ name, rootSource, plan }) => {
    const locations = compilerTemplateTextPatchLocations(plan)
    const patchSource = locations.length > 0
      ? `, [${locations.map(location => `{ node: ${location.node}, kind: "text" }`).join(", ")}]`
      : ""
    return `const ${name} = defineCompiledTemplate(${rootSource}, ${plan.slots.length}, [${plan.slots.map(slot => JSON.stringify(slot.kind)).join(", ")}]${patchSource})`
  })
  const edits: Array<{ start: number; end: number; replacement: string }> = compiledRoots.map(({ node, plan, name }) => ({
    start: node.getStart(sourceFile),
    end: node.end,
    replacement: `compiledTemplate(${name}, [${plan.slots.map(slot => slot.source).join(", ")}])`,
  }))

  // A View whose dependency set is compiler-proven exhaustive and whose body
  // returns one compiled template can skip the body/reconciliation path on
  // State-only updates. Reuse the exact original body as the slot evaluator,
  // replacing only the final View constructor with its slot array. This keeps
  // generated aliases/IIFEs and any linear prelude semantically identical.
  const rootsByNode = new Map<ts.CallExpression, typeof compiledRoots[number]>()
  for (const root of compiledRoots) rootsByNode.set(root.node, root)
  const visitDefinitions = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && compilerGeneratedViewDefinition(node)) {
      const properties = new Map<string, ts.ObjectLiteralElementLike>()
      for (const property of node.properties) {
        if (!property.name) continue
        const name = propertyNameText(property.name)
        if (name) properties.set(name, property)
      }
      const complete = properties.get("dependenciesComplete")
      const body = properties.get("body")
      if (!properties.has("compiledBody")
        && complete && ts.isPropertyAssignment(complete) && complete.initializer.kind === ts.SyntaxKind.TrueKeyword
        && body && ts.isPropertyAssignment(body) && ts.isArrowFunction(body.initializer)) {
        const returned = exactFunctionReturn(body.initializer)
        let root = returned && ts.isCallExpression(returned) ? rootsByNode.get(returned) : undefined
        let replaceExpression: ts.Expression | undefined = root?.node
        let modifiersSource: string | undefined
        if (!root && returned && ts.isCallExpression(returned)) {
          const callee = exactReturnedExpression(returned.expression)
          const content = returned.arguments[0]
          const modifierSpecs = returned.arguments[1]
          if (callee && ts.isIdentifier(callee) && callee.text === "modifiedContentCompiled"
            && content && ts.isCallExpression(content)
            && modifierSpecs && directCompiledModifierSpecs(modifierSpecs)) {
            root = rootsByNode.get(content)
            if (root) {
              replaceExpression = returned
              modifiersSource = source.slice(modifierSpecs.getStart(sourceFile), modifierSpecs.end)
            }
          }
        }
        if (root && replaceExpression && root.plan.slots.every(slot => slot.kind === "text")) {
          const functionStart = body.initializer.getStart(sourceFile)
          const functionEnd = body.initializer.end
          const replacementStart = replaceExpression.getStart(sourceFile)
          const bodySource = source.slice(functionStart, functionEnd)
          const slotArray = `[${root.plan.slots.map(slot => slot.source).join(", ")}]`
          // Patch IR already declares every stable text sink. Do not allocate a
          // fresh all-dirty bitset in generated code on every State update;
          // direct Web keeps one immutable full-candidate mask per Patch IR and
          // then filters it against the last committed values.
          const evaluation = `({ slots: ${slotArray}${modifiersSource ? `, modifiers: ${modifiersSource}` : ""} })`
          const evaluator = bodySource.slice(0, replacementStart - functionStart)
            + evaluation
            + bodySource.slice(replaceExpression.end - functionStart)
          const patchLocations = compilerTemplateTextPatchLocations(root.plan)
          const dependencyNames = compilerDependencyNames(properties.get("dependencies"))
          let sparsePatchSource = ""
          if (!modifiersSource && patchLocations.length === root.plan.slots.length
            && dependencyNames && compilerBodyHasOnlyPropsPrelude(body.initializer)) {
            const dependenciesBySlot = root.plan.slots.map(slot => directSlotDependencyNames(slot.source, dependencyNames))
            const referencedDependencies = new Set(dependenciesBySlot.flatMap(names => [...names]))
            if (dependenciesBySlot.every(names => names.length > 0)
              && dependencyNames.every(name => referencedDependencies.has(name))) {
              const indicesByDependency = new Map(dependencyNames.map(name => [name, [] as number[]]))
              dependenciesBySlot.forEach((names, index) => names.forEach(name => indicesByDependency.get(name)!.push(index)))
              const dirtyName = nextName()
              const valuesName = nextName()
              const propsName = nextName()
              const patchBody = `(() => { ${root.plan.slots.map((slot, index) => {
                const word = index >>> 5
                const bit = 1 << (index & 31)
                return `if ((${dirtyName}[${word}] & ${bit >>> 0}) !== 0) ${valuesName}[${index}] = ${slot.source};`
              }).join(" ")} })()`
              const sparseBody = bodySource.slice(0, replacementStart - functionStart)
                + patchBody
                + bodySource.slice(replaceExpression.end - functionStart)
              const dependencyObject = `{ ${[...indicesByDependency].map(([name, indices]) => `${JSON.stringify(name)}: [${indices.join(", ")}]`).join(", ")} }`
              sparsePatchSource = `, patchDependencyIndices: ${dependencyObject}, evaluatePatch: (${propsName}: any, ${dirtyName}: Uint32Array, ${valuesName}: unknown[]) => ((${sparseBody})(${propsName}))`
            }
          }
          edits.push({
            start: body.getStart(sourceFile),
            end: body.getStart(sourceFile),
            replacement: `compiledBody: { template: ${root.name}${modifiersSource ? ", patchesModifiers: true" : ""}${sparsePatchSource}, evaluate: ${evaluator} }, `,
          })
        }
      }
    }
    ts.forEachChild(node, visitDefinitions)
  }
  visitDefinitions(sourceFile)

  let result = source
  for (const edit of edits.sort((left, right) => right.start - left.start)) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
  const importEnd = sourceFile.statements.filter(ts.isImportDeclaration).at(-1)?.end ?? 0
  const prefix = `${importEnd > 0 ? "\n" : ""}${declarations.join("\n")}\n`
  return result.slice(0, importEnd) + prefix + result.slice(importEnd)
}

export function hoistStaticViewSubtrees(source: string): string {
  // No graph constructor or Animation binding means neither hoist class can
  // possibly match. Avoid allocating a full AST for ordinary helper modules.
  if (!source.includes("createNodeCompiled")
    && !source.includes("modifiedContentCompiled")
    && !/\bAnimation\b/.test(source)) return source

  const sourceFile = staticSyntaxSourceFile(source)
  const imported = importedBindingsOf(sourceFile)
  const animationBindings = animationBindingsOf(sourceFile)
  if (imported.size === 0 && animationBindings.named.size === 0 && animationBindings.namespaces.size === 0) return source

  type HoistCandidate = { readonly node: ts.Expression; readonly kind: "view" | "motion" }
  const candidates: HoistCandidate[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node)) {
      if (imported.size > 0 && isStaticGraphExpression(node, imported)) {
        if (!isTopLevelInitializer(node)) candidates.push({ node, kind: "view" })
        return
      }
      if ((animationBindings.named.size > 0 || animationBindings.namespaces.size > 0)
        && isStaticAnimationExpression(node, animationBindings)) {
        if (!isTopLevelInitializer(node)) candidates.push({ node, kind: "motion" })
        // A maximal immutable Animation chain subsumes its factory/base call.
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (candidates.length === 0) return source

  const names = new Set<string>()
  const collectNames = (node: ts.Node): void => { if (ts.isIdentifier(node)) names.add(node.text); ts.forEachChild(node, collectNames) }
  collectNames(sourceFile)
  let staticSuffix = 0
  let motionSuffix = 0
  const nextName = (kind: HoistCandidate["kind"]): string => {
    const prefix = kind === "motion" ? "__munMotion" : "__munStatic"
    let name: string
    do name = `${prefix}${kind === "motion" ? motionSuffix++ : staticSuffix++}`
    while (names.has(name))
    names.add(name)
    return name
  }

  // Immutable Animation values may be shared safely. Deduplicating identical
  // descriptors is particularly valuable because the Web motion planner caches
  // its compiled execution plan by Animation object identity.
  const motionNames = new Map<string, string>()
  const hoists = candidates.map(candidate => {
    const expression = source.slice(candidate.node.getStart(sourceFile), candidate.node.end)
    if (candidate.kind === "motion") {
      const existing = motionNames.get(expression)
      if (existing) return { ...candidate, name: existing, expression, declaration: false }
      const name = nextName(candidate.kind)
      motionNames.set(expression, name)
      return { ...candidate, name, expression, declaration: true }
    }
    return { ...candidate, name: nextName(candidate.kind), expression, declaration: true }
  })

  let result = source
  for (const { node, name } of [...hoists].sort((left, right) => right.node.getStart(sourceFile) - left.node.getStart(sourceFile))) {
    result = result.slice(0, node.getStart(sourceFile)) + name + result.slice(node.end)
  }

  let insertion = 0
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) break
    insertion = statement.end
  }
  const declarations = hoists
    .filter(candidate => candidate.declaration)
    .map(({ name, expression }) => `\nconst ${name} = ${expression}`)
    .join("") + "\n"
  return result.slice(0, insertion) + declarations + result.slice(insertion)
}
