/**
 * PROOF: the observer can corrupt its own measurement.
 *
 * The whole argument for this tool being outside the server (README, and
 * docs/liveness-spec.md §8) is that a component cannot measure the thing it
 * lives inside. RCON round-trip latency is our probe of the main game thread --
 * but it is measured with two timestamps taken in OUR event loop. If our loop is
 * blocked when the reply arrives, the reply sits unread in the socket buffer and
 * we bill the wait to the server.
 *
 * That is not hypothetical. The first snapshot after the web service started
 * reported MC 1.21.4 STALLED at 3,120 ms and MC Skyblock STALLED at a 5,010 ms
 * timeout, while every scan a minute later reported 0-2 ms. discovery.scan()
 * inspects every server concurrently with Promise.all, and inspect() calls
 * worldDirs() -- readdirSync + statSync per candidate world directory -- AFTER
 * awaiting RCON. With a cold file cache that blocks the loop for seconds.
 *
 * This script reproduces the failure deterministically: probe a healthy server,
 * block the loop while its reply is in flight, and watch a healthy server be
 * reported as STALLED.
 *
 * Run:  npx tsx scripts/prove-observer-lag.ts
 */
import { Rcon } from '../server/rcon'
import { rconConfig } from '../server/properties'
import { scan } from '../server/discovery'
import { loadConfig, dataDir } from '../server/config'
import { assessHealth, RCON_SLOW_MS } from '../server/health'
import { observerBlockedMs, startObserverMonitor, stopObserverMonitor } from '../server/loopguard'

function blockLoop(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* deliberately synchronous: this is the failure being reproduced */
  }
}

const cfg = loadConfig(dataDir())
const snap = await scan(cfg.serversRoot, cfg.classificationOverrides)
const target = snap.servers.find(
  (s) => s.classification === 'live' && s.health === 'HEALTHY' && s.rconConfigured,
)
if (!target) {
  console.error('No healthy RCON-enabled server to test against. Start one and retry.')
  process.exit(1)
}
const rc = rconConfig(target.dir)
if (!rc) {
  console.error(`No RCON config for ${target.name}.`)
  process.exit(1)
}

console.log(`target: ${target.name} (currently ${target.health})\n`)

startObserverMonitor()

// --- 1. baseline: unobstructed round trip -----------------------------------
const conn = await Rcon.connect(rc.port, rc.password, '127.0.0.1', 5000)
const baseline = await conn.run('list', 5000)
console.log(`1. unobstructed RCON round trip      ${baseline.latencyMs} ms`)

// --- 2. the same server, with our loop blocked ------------------------------
const BLOCK_MS = 3000
const t0 = Date.now()
const pending = conn.run('list', 5000)
// The command is on the wire. Block before the reply can be read.
blockLoop(BLOCK_MS)
const obstructed = await pending
const blocked = observerBlockedMs(t0, Date.now())
conn.close()
stopObserverMonitor()

console.log(`2. same server, observer blocked ${BLOCK_MS} ms  ${obstructed.latencyMs} ms`)
console.log(`   observer block detected             ${blocked} ms`)

// --- 3. what each verdict would be ------------------------------------------
const base = {
  kind: target.kind,
  hasProcess: true,
  uptimeSeconds: target.proc?.uptimeSeconds ?? 1000,
  slp: target.slp,
  rconConfigured: true,
}
const naive = assessHealth({
  ...base,
  rcon: { ok: true, latencyMs: obstructed.latencyMs, note: '' },
})
const guarded = assessHealth({
  ...base,
  rcon: { ok: true, latencyMs: obstructed.latencyMs, note: '' },
  observerBlockedMs: blocked,
})

console.log('')
console.log(`3. verdict without the guard         ${naive.health}`)
console.log(`   verdict with the guard            ${guarded.health}`)
console.log(`      ${guarded.detail}`)

const checks: Array<[string, boolean]> = [
  ['baseline round trip is fast', baseline.latencyMs < RCON_SLOW_MS],
  ['blocking the observer inflates the measured latency', obstructed.latencyMs >= BLOCK_MS * 0.9],
  ['the block is detected', blocked >= BLOCK_MS * 0.9],
  ['an unguarded reading calls a healthy server STALLED', naive.health === 'STALLED'],
  ['the guarded reading does not', guarded.health !== 'STALLED'],
]

console.log('')
let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
