import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, relative, sep, dirname } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const canonicalPackages = ["execution", "animation", "core", "compiler", "astro", "react", "vue", "web", "vite"]
const compatibilityPackages = ["legacy-react"]
const releaseTargets = [
  { dir: root, canonical: false, publishPrefix: "dist/", requireExports: true },
  ...canonicalPackages.map(packageName => ({ dir: resolve(root, "packages", packageName), canonical: true, publishPrefix: "dist/", requireExports: true })),
  ...compatibilityPackages.map(packageName => ({ dir: resolve(root, "packages", packageName), canonical: false, publishPrefix: "dist/", requireExports: true })),
  { dir: resolve(root, "packages", "create-mun"), canonical: false, publishPrefix: "bin/", requireExports: false },
]
const packDir = mkdtempSync(resolve(tmpdir(), "mun-release-pack-"))
const packedTarballs = new Map()

function pnpmCommand(args, cwd) {
  const cli = process.env.MUN_PNPM_CLI || process.env.npm_execpath
  const cliIsJavaScript = Boolean(cli && /\.(?:cjs|mjs|js)$/u.test(cli))
  const command = cli ? (cliIsJavaScript ? process.execPath : cli) : "pnpm"
  const commandArgs = cliIsJavaScript ? [cli, ...args] : args
  return spawnSync(command, commandArgs, { cwd, encoding: "utf8", env: process.env })
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function localPackagePath(name) {
  const direct = resolve(root, "node_modules", name)
  if (existsSync(resolve(direct, "package.json"))) return direct
  const pnpmStore = resolve(root, "node_modules", ".pnpm")
  const entry = readdirSync(pnpmStore).find(candidate => candidate.startsWith(`${name}@`))
  const nested = entry ? resolve(pnpmStore, entry, "node_modules", name) : undefined
  assert.ok(nested && existsSync(resolve(nested, "package.json")), `local dependency ${name} is unavailable for offline release verification`)
  return nested
}

const localDependency = name => `file:${localPackagePath(name)}`

const releaseVersion = readJSON(resolve(root, "package.json")).version

const semanticUiIrSchema = readJSON(resolve(root, "schemas", "semantic-ui-ir-v1.schema.json"))
assert.equal(semanticUiIrSchema.$schema, "https://json-schema.org/draft/2020-12/schema")
assert.equal(semanticUiIrSchema.$id, "urn:mun:semantic-ui-ir:v1")
assert.equal(semanticUiIrSchema.properties?.version?.const, 1)
assert.equal(semanticUiIrSchema.properties?.sourceLanguage?.const, "mun")
assert.equal(semanticUiIrSchema.properties?.root?.$ref, "#/$defs/window")
assert.equal(semanticUiIrSchema.$defs?.window?.properties?.child?.$ref, "#/$defs/node")
assert.equal(
  semanticUiIrSchema.$defs?.node?.oneOf?.some(entry => entry?.$ref === "#/$defs/window"),
  false,
  "Semantic UI IR v1 Window must remain root-only",
)

function exportTargets(exportsValue, output = []) {
  if (typeof exportsValue === "string") output.push(exportsValue)
  else if (exportsValue && typeof exportsValue === "object") {
    for (const value of Object.values(exportsValue)) exportTargets(value, output)
  }
  return output
}

function walk(dir, output = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", ".pi", "node_modules", "local-packages"].includes(entry.name)) continue
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) walk(path, output)
    else output.push(path)
  }
  return output
}

for (const path of walk(root)) {
  assert.equal(path.split(sep).some(part => part.startsWith("._")), false, `AppleDouble metadata must not ship: ${relative(root, path)}`)
}

for (const target of releaseTargets) {
  const dir = target.dir
  const manifestPath = resolve(dir, "package.json")
  const manifest = readJSON(manifestPath)
  assert.equal(manifest.type, "module", `${manifest.name} must publish ESM`)
  assert.ok(Array.isArray(manifest.files), `${manifest.name} must declare published files`)
  assert.ok(manifest.files.some(value => target.publishPrefix.startsWith(`${value.replace(/\/$/u, "")}/`) || `${value.replace(/\/$/u, "")}/`.startsWith(target.publishPrefix)), `${manifest.name} must publish ${target.publishPrefix}`)
  if (target.requireExports) assert.ok(manifest.exports?.["."], `${manifest.name} must expose its root through exports`)

  if (target.canonical) {
    assert.equal(manifest.sideEffects, false, `${manifest.name} must be declared tree-shakeable`)
  }

  const targets = new Set(exportTargets(manifest.exports))
  if (manifest.main) targets.add(manifest.main)
  if (manifest.types) targets.add(manifest.types)
  for (const exportTarget of targets) {
    if (!exportTarget.startsWith("./")) continue
    assert.ok(existsSync(resolve(dir, exportTarget.slice(2))), `${manifest.name} export target is missing: ${exportTarget}`)
  }

  const packed = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json", dir], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" },
  })
  assert.equal(packed.status, 0, `${manifest.name} npm pack --dry-run failed:\n${packed.stderr}`)
  const report = JSON.parse(packed.stdout)[0]
  assert.equal(report.name, manifest.name)
  assert.equal(report.version, manifest.version)
  const files = new Set(report.files.map(file => file.path))
  assert.ok(files.has("package.json"), `${manifest.name} pack must contain package.json`)
  assert.ok([...files].some(file => file.startsWith(target.publishPrefix)), `${manifest.name} pack must contain ${target.publishPrefix}`)
  assert.equal([...files].some(file => file.startsWith("src/") || file.startsWith("tests/") || file.includes("._") || file.startsWith(".pi/")), false, `${manifest.name} pack leaked source/test/metadata files`)
  for (const exportTarget of targets) {
    if (!exportTarget.startsWith("./")) continue
    assert.ok(files.has(exportTarget.slice(2)), `${manifest.name} packed archive is missing exported file ${exportTarget}`)
  }

  const before = new Set(readdirSync(packDir))
  const pnpmPack = pnpmCommand(["pack", "--pack-destination", packDir], dir)
  assert.equal(pnpmPack.status, 0, `${manifest.name} pnpm pack failed:\n${pnpmPack.stdout}\n${pnpmPack.stderr}`)
  const packedName = readdirSync(packDir).find(name => name.endsWith(".tgz") && !before.has(name))
  assert.ok(packedName, `${manifest.name} pnpm pack did not create a tarball`)
  const tarball = resolve(packDir, packedName)
  packedTarballs.set(manifest.name, tarball)
  const packedManifestResult = spawnSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" })
  assert.equal(packedManifestResult.status, 0, `${manifest.name} packed package.json could not be read`)
  const packedManifest = JSON.parse(packedManifestResult.stdout)
  assert.equal(packedManifest.name, manifest.name)
  assert.equal(packedManifest.version, manifest.version)
  assert.doesNotMatch(JSON.stringify(packedManifest), /workspace:/, `${manifest.name} published manifest leaked a workspace: dependency`)
  if (manifest.name === '@mun/ui') {
    for (const name of [
      '@mun/animation',
      '@mun/astro',
      '@mun/compiler',
      '@mun/core',
      '@mun/execution',
      '@mun/react',
      '@mun/vite',
      '@mun/vue',
      '@mun/web',
    ]) assert.equal(packedManifest.dependencies?.[name], manifest.version, `canonical @mun/ui must install ${name}`)
    assert.equal(packedManifest.peerDependencies, undefined, 'canonical @mun/ui should not keep optional renderer peers')

    assert.ok(files.has("schemas/semantic-ui-ir-v1.schema.json"), "canonical @mun/ui pack must contain the Semantic UI IR v1 schema")
    assert.ok(files.has("schemas/README.md"), "canonical @mun/ui pack must contain Semantic UI IR compatibility guidance")
    for (const path of [
      "bin/native.mjs",
      "native/Cargo.toml",
      "native/Cargo.lock",
      "native/mun-runtime/Cargo.toml",
      "native/mun-runtime/src/lib.rs",
      "native/mun-native/Cargo.toml",
      "native/mun-native/src/main.rs",
    ]) assert.ok(files.has(path), `canonical @mun/ui pack must contain native runtime fallback file ${path}`)
  }

  console.log(`${manifest.name}@${manifest.version}: ${files.size} files, ${(report.unpackedSize / 1024).toFixed(1)} KiB unpacked`)
}

const canonicalOnlyDir = mkdtempSync(resolve(tmpdir(), "mun-canonical-only-"))
try {
  // npm cannot resolve the semver dependencies declared by the packed
  // `mun` tarball in offline mode unless the matching packed dependency
  // tarballs are supplied as install candidates. Keep the project manifest
  // intentionally minimal (only the canonical package and core), while
  // making the release check independent of the machine's npm cache.
  const canonicalDependencyTarballs = canonicalPackages
    .filter(packageName => packageName !== "core")
    .map(packageName => packedTarballs.get(`@mun/${packageName}`))
  writeFileSync(resolve(canonicalOnlyDir, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@mun/ui": `file:${packedTarballs.get("@mun/ui")}`,
      "@mun/core": `file:${packedTarballs.get("@mun/core")}`,
      "@mun/execution": `file:${packedTarballs.get("@mun/execution")}`,
      // Satisfy external dependencies/peers from this workspace so the
      // canonical packed-install smoke test is genuinely cache-independent.
      react: localDependency("react"),
      "react-dom": localDependency("react-dom"),
      vue: localDependency("vue"),
      typescript: localDependency("typescript"),
    },
  }, null, 2))
  const install = spawnSync("npm", [
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--no-save",
    ...canonicalDependencyTarballs,
  ], { cwd: canonicalOnlyDir, encoding: "utf8" })
  assert.equal(install.status, 0, `canonical-only packed install failed:\n${install.stdout}\n${install.stderr}`)
  for (const packageName of ["animation", "astro", "compiler", "core", "react", "vite", "vue", "web"]) {
    assert.equal(existsSync(resolve(canonicalOnlyDir, `node_modules/@mun/${packageName}`)), true, `canonical @mun/ui did not install @mun/${packageName}`)
  }
  const smoke = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { Animation } from "@mun/ui";
    if (typeof Animation !== "function") throw new Error("canonical semantic import failed");
  `], { cwd: canonicalOnlyDir, encoding: "utf8" })
  assert.equal(smoke.status, 0, `canonical-only smoke test failed:\n${smoke.stdout}\n${smoke.stderr}`)
  console.log("Canonical @mun/ui installs the Mün compiler, secondary adapters, and Vite integration")
} finally {
  rmSync(canonicalOnlyDir, { recursive: true, force: true })
}

const installDir = mkdtempSync(resolve(tmpdir(), "mun-clean-install-"))
try {
  const dependency = name => `file:${packedTarballs.get(name)}`
  const installManifest = {
    private: true,
    type: "module",
    dependencies: {
      "@mun/ui": dependency("@mun/ui"),
      "create-mun": dependency("create-mun"),
      "@mun/animation": dependency("@mun/animation"),
      "@mun/astro": dependency("@mun/astro"),
      "@mun/core": dependency("@mun/core"),
      "@mun/compiler": dependency("@mun/compiler"),
      "@mun/execution": dependency("@mun/execution"),
      "@mun/legacy-react": dependency("@mun/legacy-react"),
      "@mun/react": dependency("@mun/react"),
      "@mun/vue": dependency("@mun/vue"),
      "@mun/web": dependency("@mun/web"),
      "@mun/vite": dependency("@mun/vite"),
      react: localDependency("react"),
      "react-dom": localDependency("react-dom"),
      vue: localDependency("vue"),
      typescript: localDependency("typescript"),
    },
  }
  writeFileSync(resolve(installDir, "package.json"), JSON.stringify(installManifest, null, 2))
  const install = spawnSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], { cwd: installDir, encoding: "utf8" })
  assert.equal(install.status, 0, `clean packed install failed:\n${install.stdout}\n${install.stderr}`)
  const smoke = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import * as canonical from "@mun/ui";
    import { spring } from "@mun/animation";
    import { FrameBudgetSignal } from "@mun/execution";
    import { Text } from "@mun/core/compat";
    import { renderToStaticMarkup } from "react-dom/server";
    import { render as renderReact } from "@mun/react";
    import { render as renderVue } from "@mun/vue";
    import { renderToHTML } from "@mun/web";
    import { compileMunFile } from "@mun/compiler";
    import { munPlugin } from "@mun/vite";
    if (typeof canonical.Animation !== "function" || "Text" in canonical) throw new Error("packed canonical entry boundary failed");
    if (spring().kind !== "spring") throw new Error("packed animation runtime failed");
    if (new FrameBudgetSignal().snapshot().level !== "idle") throw new Error("packed execution runtime failed");
    if (renderToStaticMarkup(renderReact(Text("react"))) !== "<span>react</span>") throw new Error("packed React render failed");
    if (!renderVue(Text("vue"))) throw new Error("packed Vue render failed");
    if (renderToHTML(Text("packed")) !== "<span>packed</span>") throw new Error("packed Web render failed");
    const compiled = compileMunFile('import { Text } from "@mun/core/compat"\\nexport const value = Text("ok")', "packed.mun.ts");
    if (!compiled.code.includes('export const value')) throw new Error("packed compiler failed");
    if (munPlugin().name !== "mun-compiler") throw new Error("packed Vite plugin failed");
  `], { cwd: installDir, encoding: "utf8" })
  assert.equal(smoke.status, 0, `clean packed smoke test failed:\n${smoke.stdout}\n${smoke.stderr}`)

  const generated = resolve(installDir, "generated-app")
  const initializer = resolve(installDir, "node_modules/create-mun/bin/create-mun.mjs")
  const scaffold = spawnSync(process.execPath, [initializer, generated, "--no-install"], { cwd: installDir, encoding: "utf8" })
  assert.equal(scaffold.status, 0, `packed create-mun smoke test failed:\n${scaffold.stdout}\n${scaffold.stderr}`)
  assert.equal(existsSync(resolve(generated, 'package.json')), false, 'default scaffold is not a Web package')
  assert.equal(existsSync(resolve(generated, 'mun.toml')), true)
  const generatedSource = readFileSync(resolve(generated, 'Sources/App.mun'), 'utf8')
  assert.match(generatedSource, /@main/u)
  assert.doesNotMatch(generatedSource, /State\(|\.value|\$\{|export default|import /u)
  const cli = resolve(installDir, 'node_modules/@mun/ui/bin/mun.mjs')
  for (const args of [['check'], ['fmt', '--check'], ['compile', 'Sources/App.mun', 'app.json']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: generated, encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.stderr)
  }
  assert.equal(readJSON(resolve(generated, 'app.json')).sourceLanguage, 'mun')
  const webGenerated = resolve(installDir, 'generated-web')
  const webScaffold = spawnSync(process.execPath, [initializer, webGenerated, '--target', 'web', '--no-install'], { cwd: installDir, encoding: 'utf8' })
  assert.equal(webScaffold.status, 0, webScaffold.stderr)
  const generatedManifest = readJSON(resolve(webGenerated, 'package.json'))
  assert.equal(generatedManifest.dependencies['@mun/core'], `^${releaseVersion}`)
  assert.equal(generatedManifest.dependencies['@mun/web'], `^${releaseVersion}`)
  assert.equal(generatedManifest.devDependencies['@mun/vite'], `^${releaseVersion}`)
  assert.equal(generatedManifest.dependencies.react, undefined)
  assert.equal(generatedManifest.dependencies.vue, undefined)
  console.log("Clean offline install and create-mun smoke tests passed")
} finally {
  rmSync(installDir, { recursive: true, force: true })
  rmSync(packDir, { recursive: true, force: true })
}
console.log("Release package verification passed")
