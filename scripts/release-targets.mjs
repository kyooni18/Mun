import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function packageDirectories(root) {
  const directories = ['.']
  const packagesRoot = resolve(root, 'packages')
  if (!existsSync(packagesRoot)) return directories

  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const relativeDir = `packages/${entry.name}`
    if (existsSync(resolve(root, relativeDir, 'package.json'))) directories.push(relativeDir)
  }
  return directories
}

function internalDependencies(manifest, packageNames) {
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  }
  return Object.keys(dependencies).filter(name => packageNames.has(name))
}

export function discoverReleaseTargets(root) {
  const targets = packageDirectories(root)
    .map(relativeDir => {
      const dir = resolve(root, relativeDir)
      const manifestPath = resolve(dir, 'package.json')
      const manifest = readJSON(manifestPath)
      return { relativeDir, dir, manifestPath, manifest }
    })
    .filter(target => target.manifest.private !== true)

  const byName = new Map()
  for (const target of targets) {
    const { name } = target.manifest
    if (!name) throw new Error(`Publishable package has no name: ${target.relativeDir}/package.json`)
    if (byName.has(name)) throw new Error(`Duplicate publishable package name: ${name}`)
    byName.set(name, target)
  }

  const names = new Set(byName.keys())
  const dependencies = new Map(
    targets.map(target => [target.manifest.name, new Set(internalDependencies(target.manifest, names))]),
  )
  const dependents = new Map(targets.map(target => [target.manifest.name, new Set()]))
  for (const [name, packageDependencies] of dependencies) {
    for (const dependency of packageDependencies) dependents.get(dependency).add(name)
  }

  const ready = targets
    .filter(target => dependencies.get(target.manifest.name).size === 0)
    .sort((left, right) => left.relativeDir.localeCompare(right.relativeDir))
  const ordered = []

  while (ready.length > 0) {
    const target = ready.shift()
    ordered.push(target)
    for (const dependentName of dependents.get(target.manifest.name)) {
      const dependentDependencies = dependencies.get(dependentName)
      dependentDependencies.delete(target.manifest.name)
      if (dependentDependencies.size !== 0) continue
      ready.push(byName.get(dependentName))
      ready.sort((left, right) => left.relativeDir.localeCompare(right.relativeDir))
    }
  }

  if (ordered.length !== targets.length) {
    const blocked = targets
      .filter(target => !ordered.includes(target))
      .map(target => `${target.manifest.name} -> ${[...dependencies.get(target.manifest.name)].join(', ')}`)
      .join('; ')
    throw new Error(`Publishable Mün packages contain an internal dependency cycle: ${blocked}`)
  }

  return ordered
}
