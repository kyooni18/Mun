#!/usr/bin/env node
// SwiftUI parity manifest ⇄ installed-SDK snapshot.
//
// `api/swiftui-symbols.snapshot.json` is generated from the Xcode SDK by
// `pnpm snapshot:swiftui` (see docs/SWIFTUI_PARITY.md). This check never
// regenerates it; it proves every SDK-shaped claim in the manifest against it:
//
// - every View / value type is a public nominal SwiftUI type;
// - every claimed initializer, modifier (View or Shape member) and value
//   member exists with that exact title;
// - its declaration agrees with the manifest's labels and order, defaults,
//   Binding parameters and closure roles;
// - it is available on macOS, and SDK deprecation is acknowledged;
// - every "unsupported" entry names real SDK API (no invented gaps);
// - legacy compatibility signatures that claim SwiftUI spelling exist.
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import * as Manifest from "../packages/core/dist/api-manifest.js"

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

const snapshotPath = resolve(argument("--snapshot", "api/swiftui-symbols.snapshot.json"))
if (!existsSync(snapshotPath)) {
  console.error(`SwiftUI SDK snapshot not found: ${snapshotPath}`)
  console.error("Run `pnpm snapshot:swiftui` on macOS with Xcode first.")
  process.exit(2)
}

const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"))
const failures = []
if (snapshot.schemaVersion !== 3 || !snapshot.modules?.includes("SwiftUI") || !Array.isArray(snapshot.symbols)) {
  console.error(`Unsupported SwiftUI symbol snapshot (expected schema 3 with SwiftUI): ${snapshotPath}`)
  process.exit(2)
}
// The digest covers the reference entries exactly as written; a hand edit fails here.
const digest = createHash("sha256").update(snapshot.symbols.map(entry => JSON.stringify(entry)).join("\n")).digest("hex")
if (digest !== snapshot.sha256 || snapshot.symbols.length !== snapshot.symbolCount) {
  failures.push("Snapshot entries do not match the recorded digest; regenerate it with `pnpm snapshot:swiftui` instead of editing it.")
}

const manifest = Manifest.swiftUIApiManifest
const byPath = new Map()
for (const entry of snapshot.symbols) {
  const list = byPath.get(entry.path) ?? []
  list.push(entry)
  byPath.set(entry.path, list)
}
const nominalKinds = new Set(["struct", "class", "enum", "protocol"])
const memberKinds = new Set(["init", "method", "func", "type.method", "property", "type.property"])

function nominal(name) {
  return (byPath.get(name) ?? []).find(entry => nominalKinds.has(entry.kind))
}

function members(path) {
  return (byPath.get(path) ?? []).filter(entry => memberKinds.has(entry.kind))
}

/** Top-level parameters of a declaration: `{ label, binding, closure, defaulted }`. */
function declarationParameters(declaration) {
  const open = declaration.indexOf("(")
  if (open < 0) return []
  const parts = []
  let depth = 0
  let start = open + 1
  for (let index = open; index < declaration.length; index += 1) {
    const character = declaration[index]
    if ("([{<".includes(character)) depth += 1
    else if (")]}>".includes(character) && !(character === ">" && declaration[index - 1] === "-")) {
      depth -= 1
      if (depth === 0) {
        if (declaration.slice(start, index).trim()) parts.push(declaration.slice(start, index).trim())
        break
      }
    } else if (character === "," && depth === 1) {
      parts.push(declaration.slice(start, index).trim())
      start = index + 1
    }
  }
  return parts.map(part => {
    const colon = part.indexOf(":")
    const names = part.slice(0, colon).replace(/@\w+(\([^)]*\))?\s*/g, "").trim().split(/\s+/)
    const type = part.slice(colon + 1)
    return {
      label: names[0] === "_" ? undefined : names[0],
      binding: /\bBinding</.test(type),
      closure: /->/.test(type) || /@ViewBuilder/.test(part),
      defaulted: /\s=\s/.test(type),
    }
  })
}

/** Why `declaration` disagrees with `parameters`, or undefined when it agrees. */
function contractMismatch(declaration, parameters, contract) {
  const sdk = declarationParameters(declaration)
  if (sdk.length !== parameters.length) return `${sdk.length} parameters in the SDK, ${parameters.length} in the manifest`
  for (const [index, parameter] of parameters.entries()) {
    const actual = sdk[index]
    const name = parameter.label ?? parameter.name ?? `#${index + 1}`
    if ((parameter.label ?? undefined) !== actual.label) return `parameter ${index + 1} is '${actual.label ?? "_"}:' in the SDK, '${parameter.label ?? "_"}:' in the manifest`
    if ((parameter.kind === "binding") !== actual.binding) return `'${name}' is ${actual.binding ? "" : "not "}a Binding in the SDK`
    const closure = parameter.kind === "viewBuilder" || parameter.kind === "action"
    if (closure !== actual.closure) return `'${name}' is ${actual.closure ? "" : "not "}a closure in the SDK`
    if (parameter.required === false && !actual.defaulted) return `'${name}' is optional in the manifest but has no SDK default`
    if (parameter.required !== false && actual.defaulted && contract === "exact") return `'${name}' has an SDK default but the exact contract requires it`
  }
  return undefined
}

let checked = 0
function checkMember(owner, signature, spec, what) {
  const candidates = members(`${owner}.${signature}`)
  if (candidates.length === 0) {
    failures.push(`${what} ${owner}.${signature} is not public SwiftUI API in this SDK.`)
    return
  }
  checked += 1
  const available = candidates.filter(entry => !entry.macOS?.unavailable)
  if (available.length === 0) failures.push(`${what} ${owner}.${signature} is unavailable on macOS.`)
  if (spec?.parameters && signature.includes("(")) {
    const reasons = available.map(entry => contractMismatch(entry.declaration, spec.parameters, spec.contract))
    if (!reasons.includes(undefined)) {
      failures.push(`${what} ${owner}.${signature} does not match any SDK overload: ${[...new Set(reasons)].join("; ")}.`)
    }
  }
  if (spec && available.length > 0 && available.every(entry => entry.macOS?.deprecated)) {
    const notes = `${spec.subset ?? ""} ${spec.divergence ?? ""}`
    if (!/deprecated/i.test(notes)) failures.push(`${what} ${owner}.${signature} is deprecated in the SDK; the manifest must say so.`)
  }
}

for (const [name, spec] of Object.entries(manifest.views)) {
  if (!nominal(name)) failures.push(`View ${name} is not a public SwiftUI type in this SDK.`)
  for (const initializer of spec.initializers) checkMember(name, initializer.signature, initializer, "View initializer")
  for (const initializer of spec.compat?.initializers ?? []) checkMember(name, initializer.signature, undefined, "Compatibility initializer")
}

for (const modifier of manifest.modifiers) {
  const owner = modifier.owner ?? "View"
  for (const signature of modifier.signatures) checkMember(owner, signature.signature, signature, "Modifier")
}

for (const value of manifest.values) {
  if (!nominal(value.name)) failures.push(`Value type ${value.name} is not a public SwiftUI type in this SDK.`)
  for (const member of value.members) checkMember(value.name, member.signature, member, "Value member")
}

// Unsupported entries must be real SwiftUI API, so the list documents actual gaps.
for (const view of manifest.unsupported.views) {
  if (!nominal(view.name)) failures.push(`Unsupported View ${view.name} is not a public SwiftUI type in this SDK.`)
}
for (const modifier of manifest.unsupported.modifiers) {
  if (members(`View.${modifier.name}`).length === 0 && ![...byPath.keys()].some(path => path.startsWith(`View.${modifier.name}(`))) {
    failures.push(`Unsupported modifier .${modifier.name} is not a public View member in this SDK.`)
  }
}
for (const [owner, signatures] of Object.entries(manifest.unsupported.overloads)) {
  const path = manifest.views[owner] ? owner : "View"
  for (const signature of signatures) {
    if (members(`${path}.${signature}`).length === 0) failures.push(`Unsupported overload ${path}.${signature} is not public SwiftUI API in this SDK.`)
  }
}

if (failures.length > 0) {
  console.error(`SwiftUI SDK parity check failed against ${snapshot.sdk} ${snapshot.sdkVersion} (Xcode ${snapshot.xcodeVersion} ${snapshot.xcodeBuild}):\n`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`SwiftUI SDK snapshot OK: ${checked} manifest titles verified against ${snapshot.modules.join(" + ")} (${snapshot.sdk} ${snapshot.sdkVersion} ${snapshot.sdkBuild}, Xcode ${snapshot.xcodeVersion} ${snapshot.xcodeBuild}, ${snapshot.target}).`)
}
