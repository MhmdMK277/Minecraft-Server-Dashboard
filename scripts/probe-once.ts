/**
 * One scan through the dashboard's real code path, printed as text.
 * Used by the stall proof so the reported state comes from the same code the
 * UI renders, not a reimplementation.
 *
 * Run: npx tsx scripts/probe-once.ts
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { scan } from '../server/discovery'
import { loadConfig } from '../server/config'
import { startObserverMonitor, stopObserverMonitor } from '../server/loopguard'

// Without this the sampler never runs, every observerBlockedMs() answer is 0,
// and the identity scan's "loop blocked 0 ms" below would be vacuous rather
// than measured. The service starts it in http.ts; a one-shot must too.
startObserverMonitor()

// Same resolution the app uses: env, then user config, then the default.
const cfg = loadConfig(join(homedir(), 'AppData', 'Roaming', 'minecraft-server-dashboard'))
const snap = await scan(cfg.serversRoot, cfg.classificationOverrides)

console.log(`scan took ${snap.scanMs} ms\n`)
const w = (s: string, n: number) => s.padEnd(n)
console.log(
  w('SERVER', 18) + w('CLASS', 9) + w('HEALTH', 10) + w('SLP', 12) + w('RCON', 11) + 'TPS',
)
console.log('-'.repeat(96))
for (const s of snap.servers) {
  const slp = s.slp ? `${s.slp.latencyMs}ms${s.slp.ready ? '' : ' (loading)'}` : 'no reply'
  const rcon = s.rcon ? (s.rcon.ok ? `${s.rcon.latencyMs}ms` : 'NO REPLY') : '–'
  const tps = s.tps?.overall != null ? s.tps.overall.toFixed(2) : '–'
  console.log(
    w(s.name, 18) + w(s.classification, 9) + w(s.health, 10) + w(slp, 12) + w(rcon, 11) + tps,
  )
}
// Identity is the foundation everything else rests on, and it failed silently
// once. Printed every run so "which signal actually answered" is never something
// anyone has to go looking for.
const id = snap.identity
console.log()
console.log(
  `identity: ${id.ok ? 'ok' : `FAILED. ${id.failure}`}, ${id.tookMs} ms (loop blocked ${id.loopBlockedMs} ms), ${id.unattributed} unattributed`,
)
console.log(
  `  attributed by  scheduled-task ${id.bySignal['scheduled-task']}` +
    `  command-line ${id.bySignal['command-line']}` +
    `  open-log-and-port ${id.bySignal['open-log-and-port']}`,
)
console.log(
  `  started by     scheduled-task ${id.startedBy['scheduled-task']}` +
    `  interactive ${id.startedBy.interactive}` +
    `  unknown ${id.startedBy.unknown}`,
)

console.log()
for (const s of snap.servers) {
  if (s.health === 'STALLED' || s.health === 'HUNG') {
    console.log(`!! ${s.name}: ${s.healthDetail}`)
  }
  if (s.health === 'UNKNOWN') console.log(`?? ${s.name}: ${s.healthDetail}`)
}
for (const d of snap.ignored) console.log(`(ignored) ${d.name}. ${d.reason}`)

stopObserverMonitor()
