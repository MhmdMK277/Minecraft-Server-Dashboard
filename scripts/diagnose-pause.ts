/**
 * Is a latency spike a whole-JVM pause, or one thread?
 *
 * Written 2026-07-29, chasing MC 1.21.11's SLP spikes. `jstat` cannot answer it
 * here: these servers run with `-XX:+PerfDisableSharedMem` (an Aikar flag), which
 * removes the perf file jstat reads, and attaching a JFR recording changes the
 * state of a live server, which is not something to do uninvited.
 *
 * The network can answer it instead, using the same asymmetry the whole health
 * model rests on (liveness-spec §8):
 *
 *   SLP  -> answered by a NETTY thread from a cached status object
 *   RCON -> queued onto the MAIN server thread
 *
 * Fire both at the same instant, repeatedly, and the pattern names the cause:
 *
 *   both spike together   a stop-the-world pause -- GC, or the OS descheduling
 *                         the whole process. Nothing to do with the game loop.
 *   only RCON spikes      the main thread is busy or wedged. This is STALLED.
 *   only SLP spikes       something on the status path specifically: a plugin
 *                         listener, or the netty group starved on its own.
 *
 * Observer blockage is recorded across every pair, because a spike measured by
 * a blocked observer is the observer's (liveness-spec §11).
 *
 * Run:  npx tsx scripts/diagnose-pause.ts "<server name>" [rounds]
 */
import { Socket } from 'node:net'
import { loadConfig, dataDir } from '../server/config'
import { scan } from '../server/discovery'
import { rconConfig } from '../server/properties'
import { Rcon } from '../server/rcon'
import {
  startObserverMonitor,
  stopObserverMonitor,
  observerBlockedMs,
  loopLag,
} from '../server/loopguard'

function varint(n: number): Buffer {
  const bytes: number[] = []
  let v = n
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v) b |= 0x80
    bytes.push(b)
  } while (v)
  return Buffer.from(bytes)
}

function slpOnce(port: number, host = '127.0.0.1'): Promise<number | null> {
  return new Promise((resolve) => {
    const sock = new Socket()
    const t0 = process.hrtime.bigint()
    const chunks: Buffer[] = []
    let settled = false
    const done = (v: number | null) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(5000)
    sock.on('timeout', () => done(null))
    sock.on('error', () => done(null))
    sock.connect(port, host, () => {
      const hostBuf = Buffer.from(host, 'utf8')
      const payload = Buffer.concat([
        Buffer.from([0x00]),
        varint(767),
        varint(hostBuf.length),
        hostBuf,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        varint(1),
      ])
      sock.write(Buffer.concat([varint(payload.length), payload, varint(1), Buffer.from([0x00])]))
    })
    sock.on('data', (d) => {
      chunks.push(Buffer.from(d))
      const buf = Buffer.concat(chunks)
      let pos = 0
      const rv = (): number => {
        let num = 0
        let shift = 0
        for (;;) {
          if (pos >= buf.length) throw new Error('short')
          const b = buf[pos++]!
          num |= (b & 0x7f) << shift
          if (!(b & 0x80)) return num
          shift += 7
        }
      }
      try {
        rv()
        if (rv() !== 0) return done(null)
        const len = rv()
        if (buf.length - pos < len) return
        done(Number(process.hrtime.bigint() - t0) / 1e6)
      } catch {
        /* wait */
      }
    })
    sock.on('close', () => done(null))
  })
}

const NAME = process.argv[2]
const ROUNDS = Number(process.argv[3] ?? 200)
const SPIKE_MS = 20

if (!NAME) {
  console.error('usage: diagnose-pause.ts "<server name>" [rounds]')
  process.exit(1)
}

const cfg = loadConfig(dataDir())
const snap = await scan(cfg.serversRoot, cfg.classificationOverrides)
const target = snap.servers.find((s) => s.name === NAME)
if (!target?.gamePort || !target.proc) {
  console.error(`No live server called ${NAME}. Live: ${snap.servers.filter((s) => s.proc).map((s) => s.name).join(', ')}`)
  process.exit(1)
}
const rc = rconConfig(target.dir)
if (!rc) {
  console.error(`${NAME} has no RCON configured; this test needs both probes.`)
  process.exit(1)
}

console.log(`${NAME}. ${ROUNDS} paired probes, SLP and RCON fired together.\n`)

startObserverMonitor()
await new Promise((r) => setTimeout(r, 2000))

// One long-lived RCON connection: reconnecting each round would measure the
// handshake instead of the main thread.
const conn = await Rcon.connect(rc.port, rc.password, '127.0.0.1', 5000)
type Row = { at: number; slp: number; rcon: number; blocked: number }
const rows: Row[] = []

try {
  for (let i = 0; i < ROUNDS; i++) {
    const at = Date.now()
    const rt0 = process.hrtime.bigint()
    const [slp, rcon] = await Promise.all([
      slpOnce(target.gamePort),
      conn.run('list', 5000).then(
        () => Number(process.hrtime.bigint() - rt0) / 1e6,
        () => null,
      ),
    ])
    if (slp !== null && rcon !== null) {
      rows.push({ at, slp, rcon, blocked: observerBlockedMs(at, Date.now()) })
    }
    await new Promise((r) => setTimeout(r, 100))
  }
} finally {
  conn.close()
}
const lag = loopLag()
stopObserverMonitor()

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] ?? 0
}
const f = (n: number) => n.toFixed(1).padStart(8)

for (const [label, xs] of [
  ['SLP  (netty thread)', rows.map((r) => r.slp)],
  ['RCON (main thread) ', rows.map((r) => r.rcon)],
] as Array<[string, number[]]>) {
  console.log(
    `${label}  n=${xs.length}  p50 ${f(pct(xs, 0.5))}  p90 ${f(pct(xs, 0.9))}  p99 ${f(pct(xs, 0.99))}  max ${f(Math.max(...xs))}`,
  )
}
console.log(
  `\nobserver over the run: p95 ${lag.p95Ms} ms, worst ${lag.maxMs} ms, starved ${lag.starvedMs} ms`,
)

const both = rows.filter((r) => r.slp > SPIKE_MS && r.rcon > SPIKE_MS).length
const slpOnly = rows.filter((r) => r.slp > SPIKE_MS && r.rcon <= SPIKE_MS).length
const rconOnly = rows.filter((r) => r.rcon > SPIKE_MS && r.slp <= SPIKE_MS).length

console.log(`\nrounds where a probe exceeded ${SPIKE_MS} ms:`)
console.log(`  both together   ${both}   -> whole-process pause (GC or descheduling)`)
console.log(`  SLP only        ${slpOnly}   -> the status path specifically`)
console.log(`  RCON only       ${rconOnly}   -> the main game thread (this is STALLED)`)

console.log('\nevery spike:')
for (const r of rows.filter((x) => x.slp > SPIKE_MS || x.rcon > SPIKE_MS)) {
  console.log(
    `  ${new Date(r.at).toISOString().slice(11, 23)}  slp ${r.slp.toFixed(1).padStart(7)}  rcon ${r.rcon.toFixed(1).padStart(7)}  observer-blocked ${r.blocked}`,
  )
}
