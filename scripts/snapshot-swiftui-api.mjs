#!/usr/bin/env node
// Capture the SwiftUI reference contract from an installed Xcode SDK.
//
//   pnpm snapshot:swiftui [--sdk macosx] [--target <triple>] [--modules SwiftUI,SwiftUICore]
//                         [--output api/swiftui-symbols.snapshot.json] [--full-output <path>]
//
// The checked-in snapshot is the project's SwiftUI reference SDK. Regenerating
// it is an intentional operation (see docs/SWIFTUI_PARITY.md); ordinary builds
// and checks only read it.
//
// The full public symbol graph is several hundred megabytes, so the snapshot
// keeps the families the parity contract is checked against — nominal types,
// type initializers, View/Shape/Text/Image members, and static value members —
// and records the digest and count of the complete extraction so the exact SDK
// stays identifiable. Output is sorted and one entry per line, so the same SDK
// always produces the same file.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 }).trim()
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

if (process.platform !== "darwin") {
  console.error("SwiftUI API snapshot generation requires macOS with Xcode.")
  process.exit(2)
}

const sdkName = argument("--sdk", "macosx")
const outputPath = resolve(argument("--output", "api/swiftui-symbols.snapshot.json"))
const fullOutputPath = argument("--full-output")
const requestedModules = argument("--modules", "SwiftUI,SwiftUICore").split(",").map(value => value.trim()).filter(Boolean)
const sdkPath = run("xcrun", ["--sdk", sdkName, "--show-sdk-path"])
const sdkVersion = run("xcrun", ["--sdk", sdkName, "--show-sdk-version"])
const sdkBuild = run("xcrun", ["--sdk", sdkName, "--show-sdk-build-version"])
const [xcodeLine, buildLine] = run("xcodebuild", ["-version"]).split("\n")
const xcodeVersion = xcodeLine.replace(/^Xcode\s+/, "")
const xcodeBuild = buildLine?.replace(/^Build version\s+/, "") ?? "unknown"
const arch = process.arch === "arm64" ? "arm64" : "x86_64"
// Pin the target to the SDK version rather than the host OS so the snapshot
// does not change with the machine's patch release.
const target = argument("--target", `${arch}-apple-macos${sdkVersion}`)

const memberOwners = new Set(["View", "Shape", "InsettableShape", "Text", "Image", "Color", "Animation", "AnyTransition"])
const staticKinds = new Set(["swift.type.property", "swift.type.method", "swift.enum.case"])

function macOSAvailability(availability) {
  const entries = availability.filter(item => item.domain === "macOS" || item.domain === "*")
  if (entries.length === 0) return undefined
  const result = {}
  for (const item of entries) {
    const version = value => value && [value.major, value.minor ?? 0, value.patch].filter(part => part !== undefined).join(".")
    if (item.introduced) result.introduced = version(item.introduced)
    if (item.deprecated) result.deprecated = version(item.deprecated)
    if (item.obsoleted) result.obsoleted = version(item.obsoleted)
    if (item.isUnconditionallyDeprecated) result.deprecated = "*"
    if (item.isUnconditionallyUnavailable) result.unavailable = true
    if (item.renamed) result.renamed = item.renamed
  }
  return result
}

function referenced(symbol) {
  const path = symbol.pathComponents ?? []
  if (path.length === 1) return ["swift.struct", "swift.enum", "swift.class", "swift.protocol", "swift.typealias"].includes(symbol.kind?.identifier)
  if (path.length !== 2) return false
  const kind = symbol.kind?.identifier
  return kind === "swift.init" || staticKinds.has(kind) || memberOwners.has(path[0])
}

const temporary = mkdtempSync(`${tmpdir()}/mun-swiftui-symbols-`)
try {
  for (const moduleName of requestedModules) {
    run("xcrun", [
      "swift-symbolgraph-extract",
      "-module-name", moduleName,
      "-target", target,
      "-sdk", sdkPath,
      "-minimum-access-level", "public",
      "-output-dir", temporary,
    ])
  }
  const files = readdirSync(temporary).filter(name => name.endsWith(".symbols.json")).sort()
  if (files.length === 0) throw new Error("swift-symbolgraph-extract produced no symbol graph files.")

  const all = new Map()
  for (const file of files) {
    const graph = JSON.parse(readFileSync(resolve(temporary, file), "utf8"))
    const graphModule = graph.module?.name ?? file.split(/[.@]/)[0]
    if (!requestedModules.includes(graphModule)) continue
    for (const symbol of graph.symbols ?? []) {
      const precise = symbol.identifier?.precise
      if (symbol.accessLevel !== "public" || !precise || symbol.spi) continue
      all.set(precise, { module: graphModule, symbol })
    }
  }

  const fullDigest = createHash("sha256")
  const ordered = [...all.keys()].sort()
  for (const precise of ordered) {
    const { symbol } = all.get(precise)
    fullDigest.update(`${precise}\t${symbol.kind?.identifier}\t${(symbol.declarationFragments ?? []).map(fragment => fragment.spelling).join("")}\n`)
  }

  const entries = []
  for (const precise of ordered) {
    const { module, symbol } = all.get(precise)
    if (!referenced(symbol)) continue
    const availability = macOSAvailability(symbol.availability ?? [])
    entries.push({
      path: symbol.pathComponents.join("."),
      kind: symbol.kind.identifier.replace(/^swift\./, ""),
      module,
      declaration: (symbol.declarationFragments ?? []).map(fragment => fragment.spelling ?? "").join("").replace(/\s+/g, " ").trim(),
      ...(availability ? { macOS: availability } : {}),
    })
  }
  entries.sort((left, right) =>
    left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind) || left.declaration.localeCompare(right.declaration))
  const lines = entries.map(entry => JSON.stringify(entry))
  const digest = createHash("sha256").update(lines.join("\n")).digest("hex")

  const header = {
    schemaVersion: 3,
    xcodeVersion,
    xcodeBuild,
    sdk: sdkName,
    sdkVersion,
    sdkBuild,
    target,
    modules: requestedModules,
    extractedSymbolCount: all.size,
    extractedSha256: fullDigest.digest("hex"),
    symbolCount: entries.length,
    sha256: digest,
  }
  const body = Object.entries(header).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `{\n${body.join("\n")}\n  "symbols": [\n${lines.map(line => `    ${line}`).join(",\n")}\n  ]\n}\n`)
  if (fullOutputPath) {
    writeFileSync(resolve(fullOutputPath), JSON.stringify(ordered.map(precise => ({ module: all.get(precise).module, ...all.get(precise).symbol }))))
  }
  console.log(`Wrote ${entries.length} reference symbols (of ${all.size} public ${requestedModules.join(" + ")} symbols) from Xcode ${xcodeVersion} (${xcodeBuild}), ${sdkName} ${sdkVersion} (${sdkBuild}), ${target} to ${outputPath}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
