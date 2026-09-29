import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, extname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const markdownFiles = [resolve(root, "README.md")]

function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) collect(path)
    else if (extname(entry.name) === ".md") markdownFiles.push(path)
  }
}
collect(resolve(root, "docs"))

const staleCanonicalNames = [
  /canonical compiler[^\n]*createMunTypeScriptLanguageService/i,
  /try adding a task, completing it/i,
]

for (const file of markdownFiles) {
  const source = readFileSync(file, "utf8")
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g
  for (const match of source.matchAll(linkPattern)) {
    const target = match[1].trim().replace(/^<|>$/g, "")
    if (!target || target.startsWith("#") || /^[a-z]+:/i.test(target)) continue
    const filePart = target.split("#", 1)[0]
    if (!filePart) continue
    const absolute = resolve(dirname(file), decodeURIComponent(filePart))
    assert.ok(existsSync(absolute), `${file.slice(root.length + 1)} has a broken local link: ${target}`)
  }
  for (const pattern of staleCanonicalNames) assert.doesNotMatch(source, pattern, `${file.slice(root.length + 1)} contains stale canonical guidance`)
}

console.log(`Documentation verification passed (${markdownFiles.length} Markdown files)`)
