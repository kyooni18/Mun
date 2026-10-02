import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { MunLoweringCache, compileMunDevProgram, compileMunDevProgramFromStructs, compileMunUiProgram, munStructParseStats, parseMunStructs, shiftMunStruct } from '@mun/compiler'

const fields = new Set(['manifest_version', 'name', 'entry', 'identifier', 'version', 'minimum_mun_version', 'platforms', 'resources', 'fonts', 'icon', 'window_title'])
const platforms = { darwin: 'macos', win32: 'windows', linux: 'linux' }

// Version 1 deliberately uses a strict, flat TOML subset: quoted strings,
// integer manifest_version and single-line string arrays. Reject unknown input.
export function parseManifest(source, path = 'mun.toml') {
  const manifest = {}
  for (const [index, raw] of source.split(/\r?\n/u).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([a-z_]+)\s*=\s*(.*)$/u.exec(line)
    if (!match || !fields.has(match[1])) throw new Error(`${path}:${index + 1}: Unsupported manifest field or malformed TOML.`)
    const [, key, value] = match
    if (Object.hasOwn(manifest, key)) throw new Error(`${path}:${index + 1}: Duplicate ${key} definition.`)
    try { manifest[key] = JSON.parse(value) } catch { throw new Error(`${path}:${index + 1}: Expected a quoted string, integer, or string array.`) }
  }
  if (manifest.manifest_version !== 1) throw new Error(`${path}: Unsupported manifest version ${manifest.manifest_version}; expected 1.`)
  for (const key of ['name', 'entry', 'identifier', 'version']) {
    if (typeof manifest[key] !== 'string' || !manifest[key].trim()) throw new Error(`${path}: ${key} must be a nonempty string.`)
  }
  for (const key of ['minimum_mun_version', 'icon', 'window_title']) {
    if (manifest[key] !== undefined && typeof manifest[key] !== 'string') throw new Error(`${path}: ${key} must be a string.`)
  }
  for (const key of ['platforms', 'resources', 'fonts']) {
    if (manifest[key] !== undefined && (!Array.isArray(manifest[key]) || manifest[key].some(value => typeof value !== 'string'))) throw new Error(`${path}: ${key} must be a string array.`)
  }
  if (manifest.platforms?.some(value => !Object.values(platforms).includes(value))) throw new Error(`${path}: Unsupported platform configuration; use macos, windows, linux.`)
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/u.test(manifest.identifier)) throw new Error(`${path}: Invalid application identifier.`)
  if (!/^\d+\.\d+\.\d+$/u.test(manifest.version)) throw new Error(`${path}: version must be major.minor.patch.`)
  if (manifest.minimum_mun_version !== undefined && !/^\d+\.\d+\.\d+$/u.test(manifest.minimum_mun_version)) throw new Error(`${path}: minimum_mun_version must be major.minor.patch.`)
  return manifest
}

export function projectPath(root, path) {
  const resolved = resolve(root, path)
  const local = relative(root, resolved)
  if (!local || local === '..' || local.startsWith(`..${sep}`) || resolve(path) === path) throw new Error(`Project path must be relative and inside the project: ${path}`)
  if (existsSync(resolved)) {
    const actual = relative(realpathSync(root), realpathSync(resolved))
    if (actual === '..' || actual.startsWith(`..${sep}`)) throw new Error(`Project path escapes through a symlink: ${path}`)
  }
  return resolved
}

export function discoverProject(start = process.cwd()) {
  let root = resolve(start)
  while (!existsSync(resolve(root, 'mun.toml'))) {
    const parent = dirname(root)
    if (parent === root) throw new Error(`No Mün project found from ${start}. Run mun new <name> or mun init to create mun.toml.`)
    root = parent
  }
  const path = resolve(root, 'mun.toml')
  const manifest = parseManifest(readFileSync(path, 'utf8'), path)
  const entry = projectPath(root, manifest.entry)
  if (!entry.endsWith('.mun') || !existsSync(entry) || !statSync(entry).isFile()) throw new Error(`${path}: Missing canonical entry source: ${manifest.entry}`)
  return { root, manifest, entry }
}

export function sourceFiles(project) {
  const files = []
  function walk(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith('.') || ['node_modules', 'Assets', 'build', 'dist'].includes(item.name) || item.isSymbolicLink()) continue
      const path = resolve(directory, item.name)
      if (item.isDirectory()) walk(path)
      else if (item.isFile() && item.name.endsWith('.mun')) files.push(path)
    }
  }
  walk(project.root)
  if (!files.includes(project.entry)) files.push(project.entry)
  return files.sort()
}

export function validateAssets(project) {
  for (const path of [...(project.manifest.resources ?? []), ...(project.manifest.fonts ?? []), ...(project.manifest.icon ? [project.manifest.icon] : [])]) {
    const full = projectPath(project.root, path)
    const local = relative(project.root, full)
    if (local === '.mun' || local.startsWith(`.mun${sep}`)) throw new Error('Build output cannot be bundled as a project resource.')
    if (!existsSync(full)) throw new Error(`Missing project resource: ${path}`)
    // Reject nested symlinks rather than copying arbitrary machine files.
    function validate(file) {
      if (statSync(file).isDirectory()) for (const item of readdirSync(file, { withFileTypes: true })) {
        if (item.isSymbolicLink()) throw new Error(`Resource symlinks are unsupported: ${file}/${item.name}`)
        validate(resolve(file, item.name))
      }
    }
    validate(full)
  }
}

export function compileProject(project) {
  return compileSources(project, sourceFiles(project).map(path => ({ path, source: readFileSync(path, 'utf8') }))).program
}

/** Qualified View name -> declaration source for a file's struct forest. */
function declarationSources(declarations, prefix = '', result = new Map()) {
  for (const declaration of declarations) {
    const name = prefix ? `${prefix}.${declaration.name}` : declaration.name
    result.set(name, declaration.source)
    declarationSources(declaration.nested ?? [], name, result)
  }
  return result
}

/** Declarations added, removed or edited between two struct forests of one file. */
function changedDeclarations(before, after) {
  const previous = declarationSources(before)
  const next = declarationSources(after)
  const changed = []
  for (const [name, source] of next) if (previous.get(name) !== source) changed.push(name)
  for (const name of previous.keys()) if (!next.has(name)) changed.push(name)
  return changed
}

function sourceError(path, source, error) {
  const offset = Math.max(0, Math.min(source.length, typeof error.offset === 'number' ? error.offset : 0))
  const before = source.slice(0, offset)
  return new Error(`${path}:${before.split('\n').length}:${before.length - before.lastIndexOf('\n')}: ${error.message}`)
}

/** Offsets at which each line of `source` starts; built once per file version. */
const lineIndexes = new Map()
function lineStarts(source) {
  let starts = lineIndexes.get(source)
  if (starts) return starts
  starts = [0]
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) starts.push(index + 1)
  if (lineIndexes.size > 256) lineIndexes.clear()
  lineIndexes.set(source, starts)
  return starts
}

function sourcePoint(source, offset) {
  const bounded = Math.max(0, Math.min(source.length, offset))
  const starts = lineStarts(source)
  let low = 0, high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle] <= bounded) low = middle
    else high = middle - 1
  }
  return { line: low + 1, column: bounded - starts[low] + 1 }
}

function mapDevMetadata(project, sources, metadata) {
  const ranges = []
  let base = 0
  for (const item of sources) {
    ranges.push({ ...item, base, end: base + item.source.length, file: relative(project.root, item.path).split(sep).join('/') })
    base += item.source.length + 1
  }
  const locate = offset => {
    let low = 0, high = ranges.length - 1
    while (low < high) {
      const middle = (low + high) >> 1
      if (offset <= ranges[middle].end) high = middle
      else low = middle + 1
    }
    const owner = ranges[low]
    if (!owner) return undefined
    const local = Math.max(0, Math.min(owner.source.length, offset - owner.base))
    return { owner, local, ...sourcePoint(owner.source, local) }
  }
  return {
    ...metadata,
    nodes: (metadata.nodes ?? []).map(span => {
      const start = locate(span.start)
      const end = locate(span.end)
      if (!start) return span
      const sameFileEnd = end?.owner.path === start.owner.path ? end : start
      return {
        ...span,
        file: start.owner.file,
        line: start.line,
        column: start.column,
        endLine: sameFileEnd.line,
        endColumn: sameFileEnd.column,
      }
    }),
  }
}

function compileSources(project, sources, development = false, preparedStructs, loweringCache) {
  const timings = {}
  const started = performance.now()
  sources = [...sources].sort((a, b) => a.path === project.entry ? -1 : b.path === project.entry ? 1 : a.path.localeCompare(b.path))
  const combined = sources.map(item => item.source).join('\n')
  try {
    if (!development) return { program: compileMunUiProgram(combined, project.entry), timings }
    const result = preparedStructs
      ? compileMunDevProgramFromStructs(combined, preparedStructs, project.entry, { loweringCache })
      : compileMunDevProgram(combined, project.entry, { loweringCache })
    timings.lower = performance.now() - started
    return { ...result, metadata: mapDevMetadata(project, sources, result.metadata), timings }
  } catch (error) {
    let offset = typeof error.offset === 'number' ? error.offset : 0
    let owner = sources[0]
    for (const item of sources) {
      owner = item
      if (offset <= item.source.length) break
      offset -= item.source.length + 1
    }
    const before = owner.source.slice(0, offset)
    throw new Error(`${owner.path}:${before.split('\n').length}:${before.length - before.lastIndexOf('\n')}: ${error.message}`)
  }
}

/**
 * Development project compiler with per-file snapshots. Unchanged files (same
 * mtime and size) are not re-read; an edit that leaves every source byte-equal
 * (editors often save twice) reuses the previous compilation outright.
 *
 * Changed files are reparsed per file. Lowering reuses every custom View
 * instance whose declaration, transitive View dependencies and call-site
 * inputs are unchanged (`MunLoweringCache`); stats report what was actually
 * relowered versus reused, and which Views the previous dependency graph
 * marks as affected by the changed declarations.
 */
export function createProjectCompiler(project, { fs = { readFileSync, statSync }, incremental = true } = {}) {
  const snapshots = new Map()
  const loweringCache = incremental ? new MunLoweringCache() : undefined
  let last
  return {
    compile() {
      const started = performance.now()
      const paths = sourceFiles(project)
      let filesRead = 0
      let filesReparsed = 0
      let declarationsReparsed = 0
      const changedFiles = []
      const changed = []
      for (const path of [...snapshots.keys()]) {
        if (paths.includes(path)) continue
        changed.push(...declarationSources(snapshots.get(path).structs).keys())
        snapshots.delete(path); changedFiles.push(path)
      }
      for (const path of paths) {
        const { mtimeMs, size } = fs.statSync(path)
        const previous = snapshots.get(path)
        if (previous && previous.mtimeMs === mtimeMs && previous.size === size) continue
        const source = fs.readFileSync(path, 'utf8'); filesRead++
        let structs = previous?.structs ?? []
        if (previous?.source !== source) {
          changedFiles.push(path)
          const before = munStructParseStats().parsed
          try { structs = parseMunStructs(source) }
          catch (error) { throw sourceError(path, source, error) }
          filesReparsed++
          // Declarations whose text is unchanged are reused, not reparsed.
          declarationsReparsed += munStructParseStats().parsed - before
          changed.push(...changedDeclarations(previous?.structs ?? [], structs))
        }
        snapshots.set(path, { mtimeMs, size, source, structs })
      }
      const read = performance.now() - started
      if (last && changedFiles.length === 0) {
        return {
          ...last,
          timings: { read },
          stats: {
            ...last.stats,
            filesRead,
            filesReparsed: 0,
            declarationsReparsed: 0,
            declarationsRechecked: 0,
            viewDeclarationsRelowered: 0,
            changedFiles,
            reused: true,
          },
        }
      }
      last = undefined // a failed compile must never fall back to an older result
      const sources = paths
        .map(path => ({ path, source: snapshots.get(path).source }))
        .sort((a, b) => a.path === project.entry ? -1 : b.path === project.entry ? 1 : a.path.localeCompare(b.path))
      const preparedStructs = []
      let offset = 0
      for (const item of sources) {
        for (const declaration of snapshots.get(item.path).structs) preparedStructs.push(shiftMunStruct(declaration, offset))
        offset += item.source.length + 1
      }
      // Affected Views per the dependency graph of the last successful compile.
      const affectedViews = loweringCache ? [...loweringCache.affectedBy(changed)].sort() : undefined
      const result = compileSources(project, sources, true, preparedStructs, loweringCache)
      const lowering = result.stats?.lowering
      last = {
        ...result,
        timings: { read, ...result.timings },
        stats: {
          filesRead,
          filesReparsed,
          declarationsReparsed,
          declarationsRechecked: result.stats?.declarationsChecked ?? 0,
          viewDeclarationsRelowered: lowering ? lowering.declarationsLowered.length : result.stats?.viewDeclarationsLowered ?? 0,
          ...(lowering ? {
            viewInstancesLowered: lowering.instancesLowered,
            viewInstancesReused: lowering.instancesReused,
            relowered: lowering.declarationsLowered,
            changedDeclarations: [...new Set(changed)].sort(),
            affectedViews,
          } : {}),
          changedFiles,
          reused: false,
        },
      }
      return last
    },
    /** Forget the last successful result (e.g. after the manifest changed). */
    invalidate() { last = undefined; snapshots.clear(); loweringCache?.clear() },
    /** View -> custom Views it uses, from the last successful compile. */
    dependencyGraph() { return loweringCache?.dependencyGraph() ?? new Map() },
  }
}

export function requirePlatform(project) {
  const platform = platforms[process.platform]
  if (!platform || (project.manifest.platforms && !project.manifest.platforms.includes(platform))) throw new Error(`Unsupported platform configuration for ${process.platform}.`)
}
