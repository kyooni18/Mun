import { readdirSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

// Runtime/DX suites have separate gates. Browser suites require installed
// Playwright browsers and are covered by the release/browser CI jobs.
const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const separate = new Set(["test:runtime", "test:dx", ...Object.keys(scripts).filter(key => key.startsWith("test:browser"))]
  .flatMap(key => scripts[key].match(/tests\/[\w-]+\.test\.mjs/g) ?? []))
const tests = readdirSync(new URL("../tests/", import.meta.url))
  .filter(name => name.endsWith(".test.mjs"))
  .map(name => `tests/${name}`)
  .filter(path => !separate.has(path))
  .sort()
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=4", ...tests], { stdio: "inherit" })
if (result.error) throw result.error
if (result.signal) throw new Error(`Test runner terminated by ${result.signal}`)
process.exitCode = result.status ?? 1
