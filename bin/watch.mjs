import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { DEV_PROTOCOL_VERSION, createFrameDecoder, encodeFrame, listenForHost } from './dev-protocol.mjs'
import { analyzeCompatibility } from './hot-reload.mjs'
import { createProgramUpdate } from './program-patch.mjs'
import { createProjectCompiler, discoverProject, requirePlatform } from './project.mjs'
import { hostBinary } from './workflow.mjs'

// Injectable scheduler and effects make races testable without wall-clock sleeps.
//
// `update(running, compiled, analysis)` applies a compatible change to the
// live process and resolves to the host's report, or throws `HotUpdateRejected`
// (the previous program and state stay live). Without `update`, or when the
// analysis demands it, the process is relaunched — and reported as such.
export class HotUpdateRejected extends Error {}

export function createDevLoop({ compile, launch, stop, update, analyze, report = () => {}, schedule = callback => setTimeout(callback, 80), cancel = clearTimeout, verbose = false }) {
  let timer, running, current, busy = false, pending = false, closed = false
  const idleWaiters = []
  const ms = value => `${value.toFixed(value < 10 ? 1 : 0)} ms`
  async function relaunch(compiled, reason) {
    const started = performance.now()
    if (running) { await stop(running); running = undefined }
    if (closed) return
    running = await launch(compiled)
    current = compiled
    if (reason) report(`${reason}\nRelaunched in ${ms(performance.now() - started)}`)
    else report(`Launched in ${ms(performance.now() - started)}`)
  }
  async function rebuild() {
    if (closed) return
    if (busy) { pending = true; return }
    busy = true
    let compiled
    try {
      const started = performance.now()
      try { compiled = await compile() }
      catch (error) {
        report(running ? `Compile failed\n${error.message}\nRunning previous valid build` : `Compile failed\n${error.message}`)
        return
      }
      if (closed) return
      if (compiled?.stats?.reused) return
      report(`Compiled in ${ms(performance.now() - started)}`)
      if (running && running.exited) { running = undefined; current = undefined }
      if (!running) { await relaunch(compiled); return }
      if (!update || !analyze) { await relaunch(compiled, 'Relaunched native app (state reset).'); return }
      const analysisStarted = performance.now()
      const analysis = analyze(current, compiled)
      if (verbose) report(`Compatibility analysis: ${ms(performance.now() - analysisStarted)}`)
      if (analysis.mode === 'restart') { await relaunch(compiled, `Structural change requires process restart: ${analysis.reason}`); return }
      const updateStarted = performance.now()
      let result
      try { result = await update(running, compiled, analysis) }
      catch (error) {
        if (error instanceof HotUpdateRejected) { report(`Hot update rejected: ${error.message}\nRunning previous valid build`); return }
        await relaunch(compiled, `Hot update unavailable (${error.message}); restarting`)
        return
      }
      current = compiled
      const lines = [`Hot reload applied in ${ms(performance.now() - updateStarted)}`]
      if (result.preservedStates) lines.push(`Preserved ${result.preservedStates} state scope${result.preservedStates === 1 ? '' : 's'}`)
      const reset = analysis.reset.length
      if (reset) lines.push(`Reset ${reset} incompatible state scope${reset === 1 ? '' : 's'}${verbose ? `: ${analysis.reset.map(item => `${item.name} (${item.reason})`).join(', ')}` : ''}`)
      if (verbose) lines.push(`Host apply ${(result.applyMicros / 1000).toFixed(2)} ms; nodes +${result.insertedNodes}/-${result.removedNodes}; added states ${analysis.added.length}, released ${analysis.removed.length}`)
      report(lines.join('\n'))
    } catch (error) { report(error.message) }
    finally {
      busy = false
      for (const resolve of idleWaiters.splice(0)) resolve()
      if (pending && !closed) { pending = false; changed() }
    }
  }
  function changed() {
    if (closed) return
    if (timer !== undefined) cancel(timer)
    timer = schedule(() => { timer = undefined; void rebuild() })
  }
  async function close() {
    closed = true
    if (timer !== undefined) cancel(timer)
    // Wait until an in-flight launch settles, then stop its process.
    if (busy) await new Promise(resolve => idleWaiters.push(resolve))
    if (running) { await stop(running); running = undefined }
  }
  return { changed, rebuild, close, get running() { return running } }
}

export function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
    child.once('close', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
}

/** Launch the native host in explicit development mode, connected to a fresh loopback channel. */
async function launchDevHost(project, compiled, env, onEvent) {
  const listener = await listenForHost({ irVersion: compiled.program.version, onEvent })
  const directory = mkdtempSync(resolve(tmpdir(), 'mun-dev-'))
  const path = resolve(directory, 'program.mun.ir.json')
  writeFileSync(path, JSON.stringify(compiled.program))
  let child
  try {
    child = spawn(hostBinary(project, compiled.program, env), ['--dev', path], {
      cwd: project.root,
      env: { ...env, MUN_DEV_ENDPOINT: listener.endpoint, MUN_DEV_TOKEN: listener.token },
      stdio: 'inherit',
    })
  } catch (error) { listener.close(); rmSync(directory, { recursive: true, force: true }); throw error }
  const running = { child, exited: false, program: compiled.program, metadata: compiled.metadata, revision: 0 }
  child.once('close', () => { running.exited = true; listener.close(); rmSync(directory, { recursive: true, force: true }) })
  const failed = new Promise((_, reject) => {
    child.once('error', reject)
    child.once('close', code => reject(new Error(`Native app exited (${code}) before connecting`)))
  })
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Native app did not connect within 60 s')), 60000).unref())
  try { running.channel = await Promise.race([listener.connection, failed, timeout]) }
  catch (error) { await stopChild(child); throw error }
  return running
}

function sourceForNode(metadata, id) {
  if (!id) return undefined
  return metadata?.nodes?.find(node => node.id === id && node.file && node.line && node.column)
}

export function formatRuntimeDiagnostic(message, metadata) {
  const source = sourceForNode(metadata, message.node)
  const location = source ? `${source.file}:${source.line}:${source.column}: ` : ''
  const node = message.node && !source ? ` (at ${message.node})` : ''
  return `${location}Runtime ${message.severity}: ${message.message}${node}`
}

export function enrichInspectorSnapshot(snapshot, metadata, devRevision) {
  const sources = new Map((metadata?.nodes ?? []).filter(node => node.file).map(node => [node.id, node]))
  return {
    ...snapshot,
    devRevision,
    nodes: snapshot.nodes.map(node => {
      const span = sources.get(node.id)
      if (!span) return node
      return {
        ...node,
        source: {
          file: span.file,
          line: span.line,
          column: span.column,
          endLine: span.endLine,
          endColumn: span.endColumn,
        },
      }
    }),
  }
}

export async function develop(project, { env, verbose = false }) {
  requirePlatform(project)
  const compiler = createProjectCompiler(project)
  const log = message => console.log(message)
  let loop
  const onEvent = message => {
    if (message.type === 'diagnostic') console.error(formatRuntimeDiagnostic(message, loop?.running?.metadata))
    else if (message.type === 'protocol-error') console.error(`Dev protocol error: ${message.message}`)
  }
  loop = createDevLoop({
    verbose,
    compile: () => {
      const manifest = discoverProject(project.root).manifest
      if (JSON.stringify(manifest) !== JSON.stringify(project.manifest)) { project = { ...project, manifest }; compiler.invalidate() }
      requirePlatform(project)
      const result = compiler.compile()
      if (verbose && !result.stats.reused) {
        for (const path of result.stats.changedFiles) log(`Changed: ${path}`)
        log(`Read ${result.stats.filesRead} file(s) in ${result.timings.read.toFixed(1)} ms; parse+semantic ${result.timings.analyze.toFixed(1)} ms; lowering ${result.timings.lower.toFixed(1)} ms`)
      }
      return result
    },
    launch: compiled => launchDevHost(project, compiled, env, onEvent),
    analyze: analyzeCompatibility,
    update: async (running, compiled, analysis) => {
      const started = performance.now()
      const baseRevision = running.revision
      const revision = baseRevision + 1
      let update = createProgramUpdate(running.program, compiled.program, {
        baseRevision,
        revision,
        preserve: analysis.preserve,
      })
      let reply = await running.channel.request(update.type, update.payload)
      // A malformed/stale patch is safe to recover from: the host has not
      // advanced its revision, so resend the exact same semantic update in full.
      if (reply.type === 'update-rejected' && update.type === 'patch' && ['patch-invalid', 'patch-unavailable'].includes(reply.code) && reply.currentRevision === baseRevision) {
        update = createProgramUpdate(running.program, compiled.program, {
          baseRevision,
          revision,
          preserve: analysis.preserve,
          patchRatio: 0,
        })
        reply = await running.channel.request('update', update.payload)
      }
      if (reply.type === 'update-rejected') throw new HotUpdateRejected(reply.message)
      if (reply.type !== 'update-applied' || reply.revision !== revision) throw new Error(`Native host returned invalid dev revision ${reply.revision ?? '<missing>'}; expected ${revision}`)
      running.program = compiled.program
      running.metadata = compiled.metadata
      running.revision = revision
      if (verbose) {
        const reduction = update.fullBytes > 0 ? (100 * (1 - update.bytes / update.fullBytes)).toFixed(1) : '0.0'
        log(`Runtime round trip ${(performance.now() - started).toFixed(1)} ms; ${update.type} ${(update.bytes / 1024).toFixed(1)} KiB vs full ${(update.fullBytes / 1024).toFixed(1)} KiB (${reduction}% smaller); ${update.operationCount} patch op(s); revision ${revision}`)
      }
      return reply
    },
    stop: async running => { running.channel?.close(); await stopChild(running.child) },
    report: log,
  })
  const session = await openInspectorEndpoint(project, () => loop.running)
  console.log('Mün dev: state-preserving hot reload for compatible edits; structural changes relaunch. Ctrl-C to stop.')
  const watcher = watch(project.root, { recursive: true }, (_, path) => {
    if (!path || path.split(/[\\/]/u).some(part => part.startsWith('.') || ['node_modules', 'build', 'dist'].includes(part))) return
    if (path.endsWith('.mun') || path === 'mun.toml' || path === 'mun.local.json') loop.changed()
  })
  watcher.on('error', error => console.error(`Watch error: ${error.message}`))
  return new Promise(resolve => {
    let closing = false
    const close = async () => {
      if (closing) return
      closing = true
      watcher.close()
      session.close()
      process.removeListener('SIGINT', close); process.removeListener('SIGTERM', close)
      await loop.close()
      resolve(0)
    }
    process.once('SIGINT', close); process.once('SIGTERM', close)
    void loop.rebuild()
  })
}

/**
 * Local inspector endpoint for `mun inspect` and editor tooling: loopback only,
 * token in `.mun/dev/session.json` (owner-readable), same framing as the host link.
 */
async function openInspectorEndpoint(project, current) {
  const token = randomBytes(24).toString('hex')
  const server = createServer(socket => {
    let authenticated = false
    const decode = createFrameDecoder(async message => {
      if (!authenticated) {
        if (message.type !== 'hello' || message.token !== token) { socket.destroy(); return }
        authenticated = true
        return
      }
      const running = current()
      let reply
      if (message.type !== 'inspect') reply = { type: 'error', id: message.id, message: `Unsupported request ${message.type}` }
      else if (!running?.channel || running.exited) reply = { type: 'error', id: message.id, message: 'No native app is running' }
      else {
        try {
          const nativeReply = await running.channel.request('inspect', { includeValues: message.includeValues === true })
          reply = {
            ...nativeReply,
            ...(nativeReply.snapshot ? { snapshot: enrichInspectorSnapshot(nativeReply.snapshot, running.metadata, running.revision) } : {}),
            id: message.id,
          }
        } catch (error) { reply = { type: 'error', id: message.id, message: error.message } }
      }
      socket.write(encodeFrame(reply))
    })
    socket.on('data', chunk => { try { decode(chunk) } catch { socket.destroy() } })
    socket.on('error', () => {})
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const file = resolve(project.root, '.mun', 'dev', 'session.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ protocol: DEV_PROTOCOL_VERSION, endpoint: `127.0.0.1:${server.address().port}`, token, pid: process.pid }), { mode: 0o600 })
  return { close() { server.close(); rmSync(file, { force: true }) } }
}
