/**
 * Renders the servers view to a standalone HTML file, for states that are hard
 * to produce on demand.
 *
 * The reason this exists: the interesting states are the ones you cannot ask
 * for. A host-wide stall with four degraded servers happened on 2026-07-28 and
 * has not been reproducible since, so the only way to check that the UI says
 * "the machine, not the servers" -- rather than lighting up four red badges --
 * is to feed it that snapshot deliberately. It also renders offline: a file://
 * page works even when the browser cannot reach the service at all.
 *
 * These snapshots are synthetic and say so on the page. Nothing here is
 * evidence about the real servers.
 *
 * Run:  npx tsx scripts/preview-states.tsx  [outfile.html]
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus, IdentityScan, LoopLag, ServerStatus, Snapshot } from '@shared/api'
import { observeFleet, resetFleetMemory } from '../server/hostwatch'
import Host from '../web/Host'
import { ServerRow } from '../web/ServerRow'

const HERE = import.meta.dirname
const OUT = process.argv[2] ?? join(HERE, '..', 'preview-states.html')

function lag(o: Partial<LoopLag>): LoopLag {
  const base: LoopLag = {
    sampleMs: 20,
    windowSeconds: 60,
    samples: 3000,
    timerFloorMs: 11,
    p50Ms: 0,
    p95Ms: 1,
    maxMs: 12,
    blockedMs: 0,
    starvedMs: 0,
    history: [],
    ...o,
  }
  // A plausible 15 minutes of history for the sparkline: quiet, then whatever
  // the scenario's peak is, ramping over the last third.
  const start = Date.parse('2026-07-28T03:00:00.000Z')
  base.history = Array.from({ length: 90 }, (_, i) => {
    const ramp = i < 58 ? 0 : (i - 57) / 32
    const peak = base.maxMs * ramp * (0.55 + ((i * 37) % 45) / 100)
    return {
      at: new Date(start + i * 10_000).toISOString(),
      maxMs: Math.round(Math.max(i % 7 === 0 ? 14 : 3, peak)),
      meanMs: Math.round(Math.max(0.4, peak / 12) * 10) / 10,
      starvedMs: Math.round(peak * (base.starvedMs > base.blockedMs / 2 ? 0.9 : 0.05)),
    }
  })
  return base
}

/** A clean identity scan, so it stays silent in scenarios that are not about it. */
const HEALTHY_IDENTITY: IdentityScan = {
  ok: true,
  failure: null,
  unattributed: 0,
  tookMs: 700,
  loopBlockedMs: 0,
  bySignal: { 'scheduled-task': 4, 'command-line': 0, 'open-log-and-port': 0 },
  startedBy: { 'scheduled-task': 4, interactive: 0, unknown: 0 },
  unwatched: [],
}

function srv(o: Partial<ServerStatus> & { name: string }): ServerStatus {
  return {
    id: o.name,
    dir: `C:/servers/${o.name}`,
    kind: 'paper',
    classification: 'live',
    gamePort: 25565,
    levelName: 'world',
    worldDirs: ['world'],
    rconConfigured: true,
    settings: { onlineMode: true, whitelist: true, motd: 'A Minecraft Server', fileModifiedAt: null, changedSinceStart: false },
    health: 'HEALTHY',
    healthDetail: 'Port answering and the main game thread acknowledged RCON in 1 ms.',
    healthSince: new Date().toISOString(),
    healthScans: 1,
    attribution: null,
    attributionDetail: null,
    proc: { pid: 1234, workingSetMb: 512, privateMb: 3600, heapMaxMb: null, uptimeSeconds: 26000 },
    slp: {
      versionName: 'Paper 1.21.4',
      protocol: 769,
      playersOnline: 0,
      playersMax: 20,
      motd: 'A Minecraft Server',
      ready: true,
      latencyMs: 8,
    },
    rcon: { ok: true, latencyMs: 1, note: '' },
    gc: null,
    memory: null,
    boot: {
      graceSeconds: 180,
      source: 'default',
      samples: 0,
      maxSeconds: null,
      lastSeconds: null,
      lastPortSeconds: null,
      detail: 'No boot has been measured for this server yet, so the 180s window for its platform applies.',
    },
    backupEnabled: true,
    launchStrategy: 'windows-task',
    launchDetail: 'Started by a scheduled task.',
    controlBusy: false,
    players: null,
    tps: { command: 'tps', overall: 20, windows: [20, 20, 20], dimensions: null, raw: '' },
    portConflictWith: [],
    dynmap: null,
    checkedAt: new Date().toISOString(),
    ...o,
  }
}

const STALLED = {
  health: 'STALLED' as const,
  healthDetail:
    'Answering pings normally, but RCON did not reply within 5s. Pings come from the network thread; RCON has to reach the main game thread. The main thread is not processing commands.',
  rcon: { ok: false, latencyMs: 5010, note: 'timeout' },
  tps: null,
}
const UNREADABLE = {
  health: 'UNKNOWN' as const,
  healthDetail:
    "RCON did not reply in time, but this dashboard's own event loop was blocked for 4100 ms of that window, so the reading says nothing about the server. Retrying on the next scan.",
  rcon: { ok: false, latencyMs: 5010, note: 'timeout' },
  tps: null,
}

/**
 * What a server looks like when identity failed rather than when it stopped.
 * The distinction is the whole point: these two states were indistinguishable
 * until 2026-07-30, and the wrong one is an alarm about nothing.
 */
const UNIDENTIFIED = {
  health: 'UNKNOWN' as const,
  healthDetail:
    'Cannot tell whether this server is running. 4 java processes are running that could not be matched to any server directory, so one of them may well be this one. Reporting DOWN here would be a guess, and this exact failure once presented as four simultaneous outages on a healthy machine.',
  proc: null,
  slp: null,
  rcon: null,
  tps: null,
}

type Scenario = {
  title: string
  note: string
  servers: ServerStatus[]
  lag: LoopLag
  scans: number
  identity?: IdentityScan
}

const SCENARIOS: Scenario[] = [
  {
    title: 'A host-wide event. The 2026-07-28 shape',
    note: 'All four degraded in one scan while the observer was starved of CPU. This is the case that produced 177 stalls in a day and three days of per-server hypotheses. One banner, and the cards step down from red.',
    servers: [
      srv({ name: 'MC 1.21.4', ...STALLED }),
      srv({ name: 'MC 1.21.11', ...STALLED }),
      srv({ name: 'MC GTNH', ...STALLED }),
      srv({ name: 'MC Skyblock', ...STALLED }),
    ],
    lag: lag({ p50Ms: 340, p95Ms: 2900, maxMs: 6400, blockedMs: 41_000, starvedMs: 39_500 }),
    scans: 7,
  },
  {
    title: 'One server, healthy host',
    note: 'The contrast case. Same STALLED verdict on one card, flat loop lag, so the card keeps its red border and the banner says the host is fine.',
    servers: [
      srv({ name: 'MC 1.21.4', ...STALLED }),
      srv({ name: 'MC 1.21.11' }),
      srv({ name: 'MC GTNH' }),
      srv({ name: 'MC Skyblock' }),
    ],
    lag: lag({}),
    scans: 4,
  },
  {
    title: 'A persistent UNKNOWN',
    note: 'The question this was built to answer: a grey badge that has been grey for twelve minutes now says why, for how long, and whose problem it is.',
    servers: [
      srv({ name: 'MC 1.21.4', ...UNREADABLE }),
      srv({ name: 'MC 1.21.11', ...UNREADABLE }),
      srv({ name: 'MC GTNH', ...UNREADABLE }),
      srv({
        name: 'MC Skyblock',
        rconConfigured: false,
        health: 'UNKNOWN',
        healthDetail:
          'Answering pings, but RCON is not configured, so the main game thread cannot be probed. A stalled server looks identical to a healthy one from the port alone.',
        rcon: null,
        tps: null,
      }),
    ],
    lag: lag({ p50Ms: 210, p95Ms: 2400, maxMs: 5200, blockedMs: 36_000, starvedMs: 34_000 }),
    scans: 72,
  },
  {
    title: 'Identity cannot be resolved. The 2026-07-29 shape',
    note: 'Four java processes are running and none could be matched to a directory. This rendered as four DOWN cards on a completely healthy machine. "I cannot tell" is not "it is not running", so the cards read unknown and the reason is stated once, at the top.',
    servers: [
      srv({ name: 'MC 1.21.4', ...UNIDENTIFIED }),
      srv({ name: 'MC 1.21.11', ...UNIDENTIFIED }),
      srv({ name: 'MC GTNH', ...UNIDENTIFIED }),
      srv({ name: 'MC Skyblock', ...UNIDENTIFIED }),
    ],
    lag: lag({}),
    scans: 12,
    identity: {
      ok: true,
      failure: null,
      unattributed: 4,
      tookMs: 690,
      loopBlockedMs: 0,
      bySignal: { 'scheduled-task': 0, 'command-line': 0, 'open-log-and-port': 0 },
      startedBy: { 'scheduled-task': 0, interactive: 0, unknown: 4 },
      unwatched: [],
    },
  },
  {
    title: 'Everything fine',
    note: 'What a quiet machine looks like, so the states above are recognisable as different.',
    servers: [
      srv({ name: 'MC 1.21.4' }),
      srv({ name: 'MC 1.21.11' }),
      srv({ name: 'MC GTNH' }),
      srv({ name: 'MC Skyblock' }),
    ],
    lag: lag({}),
    scans: 51,
  },
]

function render(s: Scenario): { host: HostStatus; servers: ServerStatus[] } {
  resetFleetMemory()
  const now = Date.parse('2026-07-28T03:15:00.000Z')
  let host!: HostStatus
  // Replay the scan history so the "held N scans" figures are produced by the
  // real code path rather than written into the fixture by hand. Paging is
  // null here as it is on any machine before the first sample lands.
  for (let i = 0; i < s.scans; i++) {
    host = { ...observeFleet(s.servers, s.lag, now + i * 10_000), paging: null }
  }
  return { host, servers: s.servers }
}

const css = (() => {
  const assets = join(HERE, '..', 'dist', 'assets')
  const file = readdirSync(assets).find((f) => f.endsWith('.css'))
  if (!file) throw new Error('No built CSS found, run `npm run build` first.')
  return readFileSync(join(assets, file), 'utf8')
})()

const body = renderToStaticMarkup(
  <div className="p-6">
    <p className="mb-6 rounded border border-[var(--color-warn)] px-3 py-2 text-xs text-[var(--color-warn)]">
      Synthetic states, rendered from the real components by
      <code className="mx-1 font-mono">scripts/preview-states.tsx</code>. Nothing on this page is a
      reading about a real server.
    </p>
    {SCENARIOS.map((s) => {
      const { host, servers } = render(s)
      return (
        <section key={s.title} className="mb-10">
          <h2 className="text-base font-semibold">{s.title}</h2>
          <p className="mb-3 mt-1 max-w-3xl text-xs text-[var(--color-muted)]">{s.note}</p>
          <Host host={host} identity={s.identity ?? HEALTHY_IDENTITY} />
          <div className="border-t border-[var(--color-edge)]/60">
            {servers.map((x) => (
              <ServerRow key={x.id} s={x} />
            ))}
          </div>
        </section>
      )
    })}
  </div>,
)

writeFileSync(
  OUT,
  `<!doctype html><html><head><meta charset="utf-8"><title>Dashboard states</title><style>${css}</style></head><body>${body}</body></html>`,
  'utf8',
)
console.log(`wrote ${OUT}`)

// Report what the inference actually said, so a run of this script is also a
// readable check rather than only a file on disk.
for (const s of SCENARIOS) {
  const { host } = render(s)
  console.log(`\n${s.title}\n  fault=${host.fleet.fault} state=${host.state}\n  ${host.fleet.headline}`)
}
