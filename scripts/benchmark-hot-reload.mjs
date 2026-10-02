// Hot-reload latency benchmark.
//
//   node scripts/benchmark-hot-reload.mjs [--host <mun-native>] [--edits N] [--compile-only]
//
// For each case a throwaway project is generated, compiled with the same
// incremental project compiler `mun dev` uses, and (unless --compile-only) a
// real native host is launched over the dev link so every edit is applied by
// `Runtime::hot_update`. Reported per case: compile time (file read + analysis
// + lowering) and the host round trip, as p50/p95/max over N edits. Opening a
// window needs a display and GPU; use --compile-only where there is none.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeCompatibility } from '../bin/hot-reload.mjs'
import { listenForHost } from '../bin/dev-protocol.mjs'
import { createProjectCompiler, discoverProject } from '../bin/project.mjs'
import { stopChild } from '../bin/watch.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const edits = Number(option('--edits') ?? 30)
if (!Number.isSafeInteger(edits) || edits < 1 || edits > 10000) throw new Error('--edits must be an integer between 1 and 10000')
const compileOnly = args.includes('--compile-only')
const executable = process.platform === 'win32' ? 'mun-native.exe' : 'mun-native'
const host = option('--host') ?? ['release', 'debug'].map(profile => resolve(root, 'native/target', profile, executable)).find(existsSync)
if (!compileOnly && !host) throw new Error('No native host found: build one or pass --host <path> (or use --compile-only).')

const manifest = name => `manifest_version = 1\nname = "${name}"\nentry = "Sources/App.mun"\nidentifier = "app.mun.bench"\nversion = "1.0.0"\nminimum_mun_version = "0.0.0"\nplatforms = ["macos", "windows", "linux"]\n`
// Each case returns files plus an `edit(i)` that rewrites one file with a
// compatible change (a text literal), so every iteration exercises hot_update.
const cases = {
  'small app': () => ({
    files: i => ({ 'Sources/App.mun': `@main\nstruct Small: View {\n  @State var count: Int = 0\n  var body: some View {\n    VStack(spacing: 12) {\n      Text("Hello \\(${i})")\n      Text("Count: \\(count)")\n      Button("Increase") { count += 1 }\n    }\n  }\n}\n` }),
  }),
  'medium custom-View app': () => ({
    files: i => ({
      'Sources/App.mun': `@main\nstruct Medium: View {\n  var body: some View {\n    VStack(spacing: 8) {\n      Text("Revision ${i}")\n${Array.from({ length: 25 }, (_, n) => `      Card${n}()`).join('\n')}\n    }\n  }\n}\n`,
      'Sources/Cards.mun': Array.from({ length: 25 }, (_, n) => `struct Card${n}: View {\n  @State var on: Bool = false\n  var body: some View {\n    HStack(spacing: 6) {\n      Button("Toggle ${n}") { on.toggle() }\n      Text(on ? "on" : "off")\n    }\n  }\n}\n`).join('\n'),
    }),
  }),
  '1,000-row keyed list': () => ({
    files: i => ({
      'Sources/App.mun': `@main\nstruct Big: View {\n  @State var rows: [Task] = [\n${Array.from({ length: 1000 }, (_, n) => `    { id: "r${n}", title: "Row ${n}" }`).join(',\n')}\n  ]\n  var body: some View {\n    ScrollView() {\n      VStack(spacing: 2) {\n        Text("Revision ${i}")\n        ForEach(rows, id: \\.id) { item in\n          RowView(item: item)\n        }\n      }\n    }\n  }\n}\n\nstruct RowView: View {\n  var item: Task\n  @State var on: Bool = false\n  var body: some View {\n    HStack(spacing: 6) {\n      Button("Toggle") { on.toggle() }\n      Text(item.title)\n    }\n  }\n}\n`,
    }),
  }),
  'cross-file edit': () => ({
    files: i => ({
      'Sources/App.mun': `@main\nstruct Cross: View {\n  var body: some View {\n    VStack {\n      Header()\n      Footer()\n    }\n  }\n}\n`,
      'Sources/Header.mun': `struct Header: View {\n  var body: some View { Text("Header ${i}") }\n}\n`,
      'Sources/Footer.mun': `struct Footer: View {\n  @State var count: Int = 0\n  var body: some View {\n    VStack {\n      Text("Footer \\(count)")\n      Button("Increase") { count += 1 }\n    }\n  }\n}\n`,
    }),
  }),
}

const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]
const summary = values => values.length ? `p50 ${percentile(values, 0.5).toFixed(1)} / p95 ${percentile(values, 0.95).toFixed(1)} / max ${Math.max(...values).toFixed(1)} ms` : 'n/a'
const written = new Map()
const write = (directory, files) => { for (const [path, source] of Object.entries(files)) { const full = resolve(directory, path); if (written.get(full) === source) continue; mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, source); written.set(full, source) } }

async function runCase(name, build) {
  const directory = mkdtempSync(resolve(tmpdir(), 'mun-bench-'))
  let child, listener
  try {
    const spec = build()
    writeFileSync(resolve(directory, 'mun.toml'), manifest('Bench'))
    write(directory, spec.files(0))
    const project = discoverProject(directory)
    const compiler = createProjectCompiler(project)
    const initial = compiler.compile()
    let channel, running = initial
    if (!compileOnly) {
      listener = await listenForHost({ irVersion: initial.program.version })
      const ir = resolve(directory, 'program.mun.ir.json')
      writeFileSync(ir, JSON.stringify(initial.program))
      child = spawn(host, ['--dev', ir], { cwd: directory, env: { ...process.env, MUN_DEV_ENDPOINT: listener.endpoint, MUN_DEV_TOKEN: listener.token }, stdio: 'ignore' })
      let timer
      try {
        channel = await Promise.race([listener.connection, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('host did not connect in 30 s')), 30000)
        })])
      } finally { clearTimeout(timer) }
    }
    const compile = [], roundTrip = [], payload = [], read = [], lower = [], compatibility = [], serialization = [], filesRead = []
    const filesReparsed = [], declarationsReparsed = [], declarationsRechecked = [], viewsRelowered = []
    for (let i = 1; i <= edits; i++) {
      write(directory, spec.files(i))
      const started = performance.now()
      const next = compiler.compile()
      compile.push(performance.now() - started)
      read.push(next.timings?.read ?? 0)
      lower.push(next.timings?.lower ?? 0)
      filesRead.push(next.stats?.filesRead ?? next.filesRead ?? 0)
      filesReparsed.push(next.stats?.filesReparsed ?? 0)
      declarationsReparsed.push(next.stats?.declarationsReparsed ?? 0)
      declarationsRechecked.push(next.stats?.declarationsRechecked ?? 0)
      viewsRelowered.push(next.stats?.viewDeclarationsRelowered ?? 0)
      const compatibilityStart = performance.now()
      const analysis = analyzeCompatibility(running, next)
      compatibility.push(performance.now() - compatibilityStart)
      const serializeStart = performance.now()
      const bytes = Buffer.byteLength(JSON.stringify(next.program), 'utf8')
      serialization.push(performance.now() - serializeStart)
      if (analysis.mode !== 'hot') throw new Error(`${name}: edit ${i} unexpectedly needs a restart: ${analysis.reason}`)
      if (channel) {
        const sent = performance.now()
        const reply = await channel.request('update', { program: next.program, preserve: analysis.preserve })
        if (reply.type !== 'update-applied') throw new Error(`${name}: edit ${i} rejected: ${reply.message}`)
        roundTrip.push(performance.now() - sent)
      }
      payload.push(bytes / 1024)
      running = next
    }
    console.log(`${name}`)
    console.log(`  compile     ${summary(compile)}`)
    console.log(`  host apply  ${compileOnly ? 'skipped (--compile-only)' : summary(roundTrip)}`)
    console.log(`  IR payload  ${payload.at(-1).toFixed(1)} KiB`)
    console.log(`  file read   ${summary(read)}`)
    console.log(`  native compile (parse + semantics + lowering) ${summary(lower)}`)
    console.log(`  compatibility ${summary(compatibility)}`)
    console.log(`  serialization ${summary(serialization)}`)
    console.log(`  files read per edit ${filesRead.join(', ')}`)
    console.log(`  files reparsed per edit ${filesReparsed.join(', ')}`)
    console.log(`  declarations reparsed/rechecked per edit ${declarationsReparsed.map((value, index) => `${value}/${declarationsRechecked[index]}`).join(', ')}`)
    console.log(`  View declarations relowered per edit ${viewsRelowered.join(', ')}`)
    console.log('  watcher/debounce, transfer, runtime, layout, presentation: not separately instrumented; host apply is request/ack round trip, not edit-to-screen')
    console.log('  patch comparison: unavailable (full-program updates only)')
  } finally {
    listener?.close()
    if (child) await stopChild(child)
    rmSync(directory, { recursive: true, force: true })
    for (const path of written.keys()) if (path.startsWith(directory)) written.delete(path)
  }
}

console.log(`Hot-reload benchmark: ${edits} edits per case, ${compileOnly ? 'compile only' : `host ${host}`}, ${process.platform}-${process.arch}`)
for (const [name, build] of Object.entries(cases)) await runCase(name, build)
