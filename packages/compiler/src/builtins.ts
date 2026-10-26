// The authoritative registry of identifiers a `.mun` file may use without an
// import. The compiler (lowering, import injection, diagnostics) and the
// language server read this one table, so what resolves, what completes and
// what hovers can never disagree.
//
// Everything here is derived from what the web runtime actually exports.
// A manifest entry with no runtime implementation is reported as native-only
// rather than silently imported.
import * as ts from "typescript"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import * as Core from "@mun/core/compat"
import { swiftUIApiManifest, type SemanticInitializerSymbol } from "@mun/core/compat"
import { canonicalViewSymbols } from "./semantic.js"

export type MunBuiltinKind = "view" | "value" | "function" | "type"

export interface MunBuiltinSymbol {
  readonly name: string
  readonly kind: MunBuiltinKind
  /** Runtime module the compiler imports the binding from; absent for erased, type-level names. */
  readonly module?: string
  readonly initializers?: readonly SemanticInitializerSymbol[]
}

export interface MunOptInFeature {
  /** Public import path, e.g. `@mun/ui/progressive-blur`. */
  readonly module: string
  readonly exports: readonly string[]
}

/** Every implicitly imported runtime built-in comes from this one entry point. */
export const munBuiltinRuntimeModule = "@mun/core/compat"
const internalRuntimeModule = "@mun/core/internal/runtime"

/** Value types with static members (`Color.red`, `Animation.spring()`). */
const builtinValues = ["Color", "LinearGradient", "Animation", "Transition", "ContentTransition", "SymbolEffect", "Transaction", "VectorSymbol"] as const
/** Language-level functions: property-wrapper storage, builders and transactions. */
const builtinFunctions = ["State", "Binding", "Observable", "Element", "withAnimation", "withTransaction", "environmentValue"] as const
/** Type names erased by lowering; known to editors, never imported. */
const builtinTypes = ["View", "String", "Bool", "Int", "Double", "Float", "Character", "Void", "Never"] as const
/** Runtime helpers the lowering emits. Users never write them, but they resolve the same way. */
const compilerHelpers = ["defineView", "initializer", "resolveBuilderInput", "namedArguments", "overloadClosure", "viewFragment", "modifiedContent", "modifiedContentCompiled", "compiledTemplate", "defineCompiledTemplate"] as const
const internalHelpers = ["compiledCollectionContent", "mapStateArrayData"] as const

/**
 * Opt-in features ship inside `@mun/ui` but are never imported implicitly.
 * Naming one without an import yields a diagnostic that names its module.
 */
export const munOptInFeatures: readonly MunOptInFeature[] = Object.freeze([
  Object.freeze({ module: "@mun/ui/progressive-blur", exports: Object.freeze(["ProgressiveBlur", "progressiveBlur", "BlurProfile", "blurFocus", "focus", "planBlur"]) }),
])

function buildRegistry(): ReadonlyMap<string, MunBuiltinSymbol> {
  const registry = new Map<string, MunBuiltinSymbol>()
  const runtime = Core as Record<string, unknown>
  const canonical = canonicalViewSymbols()
  for (const [name, value] of Object.entries(runtime)) {
    if (typeof value !== "function") continue
    const viewType = (value as { readonly viewType?: { readonly name?: string; readonly semanticSymbol?: { readonly initializers: readonly SemanticInitializerSymbol[] } } }).viewType
    if (!viewType?.name || !viewType.semanticSymbol) continue
    // The SDK-audited manifest contract replaces runtime-only overloads.
    registry.set(name, { name, kind: "view", module: munBuiltinRuntimeModule, initializers: canonical.get(name)?.initializers ?? viewType.semanticSymbol.initializers })
  }
  for (const name of builtinValues) if (name in runtime) registry.set(name, { name, kind: "value", module: munBuiltinRuntimeModule })
  for (const name of builtinFunctions) if (name in runtime) registry.set(name, { name, kind: "function", module: munBuiltinRuntimeModule })
  for (const name of builtinTypes) registry.set(name, { name, kind: "type" })
  return registry
}

let registryCache: ReadonlyMap<string, MunBuiltinSymbol> | undefined
/** Built-ins that resolve in `.mun` files without an import, keyed by identifier. */
export function munBuiltinSymbols(): ReadonlyMap<string, MunBuiltinSymbol> {
  return registryCache ??= buildRegistry()
}

/** Canonical SwiftUI names the native target lowers but the web runtime does not implement. */
export function munNativeOnlyViews(): readonly string[] {
  const runtime = Core as Record<string, unknown>
  return Object.keys(swiftUIApiManifest.views).filter(name => !(name in runtime))
}

const helperModules = new Map<string, string>([
  ...compilerHelpers.map(name => [name, munBuiltinRuntimeModule] as const),
  ...internalHelpers.map(name => [name, internalRuntimeModule] as const),
])

function runtimeModuleFor(name: string): string | undefined {
  return munBuiltinSymbols().get(name)?.module ?? helperModules.get(name)
}

function optInModuleFor(name: string): string | undefined {
  return munOptInFeatures.find(feature => feature.exports.includes(name))?.module
}

// ---------------------------------------------------------------------------
// Lexical scope analysis over the lowered TypeScript module.

type ScopeNode = ts.SourceFile | ts.Block | ts.ModuleBlock | ts.CaseBlock | ts.CatchClause | ts.ForStatement | ts.ForInStatement | ts.ForOfStatement | ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration

function isFunctionScope(node: ts.Node): boolean {
  return ts.isSourceFile(node) || ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)
}

function isBlockScope(node: ts.Node): node is ScopeNode {
  return isFunctionScope(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node) || ts.isCatchClause(node)
    || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isClassLike(node)
}

function nearest(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  let current = node.parent
  while (current && !predicate(current)) current = current.parent
  return current ?? node.getSourceFile()
}

function bindingNames(name: ts.BindingName, into: string[] = []): string[] {
  if (ts.isIdentifier(name)) into.push(name.text)
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, into)
  return into
}

function collectDeclarations(file: ts.SourceFile): Map<ts.Node, Set<string>> {
  const scopes = new Map<ts.Node, Set<string>>()
  const declare = (scope: ts.Node, names: readonly string[]) => {
    let set = scopes.get(scope)
    if (!set) scopes.set(scope, set = new Set())
    for (const name of names) set.add(name)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const list = node.parent
      const blockScoped = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.BlockScoped) !== 0
      // `var` hoists to its function; `let`/`const` belong to the block (a
      // for-loop head or catch clause is its own block).
      declare(blockScoped || ts.isCatchClause(list) ? nearest(node, isBlockScope) : nearest(node, isFunctionScope), bindingNames(node.name))
    } else if (ts.isParameter(node)) {
      declare(node.parent, bindingNames(node.name))
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      declare(nearest(node, isBlockScope), [node.name.text])
    } else if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
      declare(node, [node.name.text])
    } else if ((ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
      declare(nearest(node, isBlockScope), [node.name.text])
    } else if (ts.isImportClause(node) && node.name) {
      declare(file, [node.name.text])
    } else if (ts.isNamespaceImport(node) || ts.isImportSpecifier(node) || ts.isImportEqualsDeclaration(node)) {
      declare(file, [node.name.text])
    } else if (ts.isTypeParameterDeclaration(node)) {
      declare(node.parent, [node.name.text])
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return scopes
}

/** Is this identifier read as a value (not a property name, label, declaration or type)? */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent
  if (!parent) return false
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
  if (ts.isQualifiedName(parent)) return false
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isEnumMember(parent)) && parent.name === node) return false
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassLike(parent) || ts.isEnumDeclaration(parent) || ts.isTypeParameterDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isModuleDeclaration(parent)) && (parent as { name?: ts.Node }).name === node) return false
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent) && parent.propertyName === node) return false
  if (ts.isJsxAttribute(parent) || ts.isMetaProperty(parent)) return false
  // Inside a type annotation or `typeof X === "undefined"` guard nothing is read eagerly.
  for (let current: ts.Node | undefined = parent; current; current = current.parent) {
    if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current)) return false
    if (ts.isTypeOfExpression(current)) return false
    if (ts.isStatement(current) || ts.isSourceFile(current)) break
  }
  return true
}

/** Identifiers the module reads without any enclosing lexical declaration. */
export function freeIdentifiers(file: ts.SourceFile): Map<string, ts.Identifier[]> {
  const scopes = collectDeclarations(file)
  const free = new Map<string, ts.Identifier[]>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isValueReference(node)) {
      let bound = false
      for (let scope: ts.Node | undefined = node.parent; scope && !bound; scope = scope.parent) bound = scopes.get(scope)?.has(node.text) ?? false
      if (!bound && node.text !== "undefined" && node.text !== "arguments") {
        const uses = free.get(node.text)
        if (uses) uses.push(node)
        else free.set(node.text, [node])
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return free
}

let hostGlobalsCache: ReadonlySet<string> | undefined
/** Browser globals declared by TypeScript's DOM library; read only when an unknown name needs ruling out. */
function hostGlobals(): ReadonlySet<string> {
  if (hostGlobalsCache) return hostGlobalsCache
  const names = new Set<string>()
  const library = join(dirname(ts.getDefaultLibFilePath({})), "lib.dom.d.ts")
  if (existsSync(library)) {
    for (const match of readFileSync(library, "utf8").matchAll(/^declare (?:var|function|const|let|class) ([A-Za-z_$][\w$]*)/gmu)) names.add(match[1])
  }
  return hostGlobalsCache = names
}

export interface MunBuiltinResolution {
  /** Runtime bindings to import, grouped by module, in first-use order. */
  readonly imports: ReadonlyMap<string, readonly string[]>
  /** Free names that are neither declared, imported, built in nor JavaScript/host globals. */
  readonly unresolved: readonly { readonly name: string; readonly offset: number; readonly message: string }[]
}

/**
 * Resolve every free identifier of a lowered `.mun` module. User declarations
 * and explicit imports shadow built-ins lexically; only built-ins actually read
 * are imported, so each module keeps exactly the runtime bindings it uses.
 */
export function resolveMunBuiltins(file: ts.SourceFile): MunBuiltinResolution {
  const imports = new Map<string, string[]>()
  const unresolved: { name: string; offset: number; message: string }[] = []
  const runtime = Core as Record<string, unknown>
  const nativeOnly = new Set(munNativeOnlyViews())
  for (const [name, uses] of freeIdentifiers(file)) {
    const module = runtimeModuleFor(name)
    if (module) {
      const names = imports.get(module)
      if (names) names.push(name)
      else imports.set(module, [name])
      continue
    }
    // JavaScript globals and browser host APIs (`console`, `fetch`, `window`,
    // `ResizeObserver`) stay ordinary ES scope; everything else must resolve.
    if (name in globalThis || name in runtime || hostGlobals().has(name)) continue
    const optIn = optInModuleFor(name)
    const message = optIn
      ? `'${name}' is an opt-in Mün feature. Import it explicitly: import { ${name} } from "${optIn}"`
      : nativeOnly.has(name)
        ? `'${name}' is available only to the native target; the web runtime has no ${name}.`
        : `Cannot find '${name}' in scope. It is not declared in this file, imported, or a Mün built-in.`
    unresolved.push({ name, offset: uses[0].getStart(file), message })
  }
  return { imports, unresolved }
}

/** Append missing bindings to an existing named import from `module`, or prepend a new one. */
export function addNamedImports(source: string, module: string, names: readonly string[]): string {
  if (names.length === 0) return source
  const escaped = module.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")
  const existing = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*(["'])${escaped}\\2[\\t ]*;?`, "u").exec(source)
  if (!existing) return `import { ${names.join(", ")} } from "${module}"\n${source}`
  const merged = existing[1].split(",").map(value => value.trim()).filter(Boolean)
  for (const name of names) if (!merged.includes(name)) merged.push(name)
  const replacement = `import { ${merged.join(", ")} } from ${existing[2]}${module}${existing[2]}`
  return source.slice(0, existing.index) + replacement + source.slice(existing.index + existing[0].length)
}
