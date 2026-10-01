import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
const directory = mkdtempSync(resolve(tmpdir(), 'mun-smoke-'))
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 60_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} smoke exited ${result.status}`)
}
try {
  const ir = resolve(directory, 'app.json')
  run(process.execPath, ['bin/mun.mjs', 'compile', 'examples/NativeProductionSmoke.mun', ir])
  run(resolve('native/target/debug', process.platform === 'win32' ? 'mun-native.exe' : 'mun-native'), ['--smoke', ir])
} finally { rmSync(directory, { recursive: true, force: true }) }
