/**
 * PROOF: process identity. The three signals, the cost of measuring them, and
 * the rule that doubt is never reported as absence.
 *
 * This exists because identity failed completely for a day while the whole suite
 * stayed green. The suite had only ever run against servers started from an
 * interactive session; the servers in production are started by boot-triggered
 * S4U scheduled tasks in session 0, and those have no readable command line.
 * Every assertion was true of a configuration that does not occur. See
 * docs/proof-coverage.md.
 *
 * So this proof states which world it is testing, out loud, every run, and
 * fails if that world is not the production one, rather than passing quietly
 * against the easy case.
 *
 * Three groups:
 *
 *   A. WORLD.  Are the servers under test actually session-0, task-started?
 *   B. DOUBT.  "Cannot tell" must render UNKNOWN, never DOWN.
 *   C. COST.   The scan spawns a subprocess on a loop that runs every 10 s.
 *              Spec §11 says the observer must not bill its own delay to a
 *              server. Measured, with a negative control proving the instrument
 *              would notice if it did.
 *
 * Run:  npx tsx scripts/prove-identity.ts
 */
import { join } from 'node:path'
import { scanJvms, jvmForDir } from '../server/platform'
import { setPsForProof } from '../server/platform/windows'
import { loadConfig, dataDir } from '../server/config'
import { listDirectories, levelDatPath, gamePortOf } from '../server/properties'
import { assessHealth } from '../server/health'
import {
  startObserverMonitor,
  stopObserverMonitor,
  observerBlockedMs,
  MIN_FLOOR_SAMPLES,
} from '../server/loopguard'
import type { DirHint } from '../server/platform'
import { describeWorld, printWorld } from './world'

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])

/**
 * The same normalisation jvmForDir uses. Comparing raw strings here was itself a
 * bug: a servers root configured as `C:/Users/...` makes join() produce mixed
 * separators, so a directory never matched the backslash path a task reports.
 */
const nkey = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()

// The sampler must be running or every observerBlockedMs() answer is 0 and the
// cost checks below would pass vacuously. This is the same mistake in miniature
// as the one the whole proof is about.
startObserverMonitor()

const cfg = loadConfig(dataDir())
const names = listDirectories(cfg.serversRoot).filter((n) => levelDatPath(join(cfg.serversRoot, n)))
const hints: DirHint[] = names.map((n) => ({
  dir: join(cfg.serversRoot, n),
  gamePort: gamePortOf(join(cfg.serversRoot, n)),
}))

// Give the loop-lag floor time to calibrate before anything is measured.
await new Promise((r) => setTimeout(r, MIN_FLOOR_SAMPLES * 25))

const scan = await scanJvms(hints)
const isOccupied = (dir: string) => scan.occupiedDirs.some((o) => nkey(o) === nkey(dir))

console.log(`servers root : ${cfg.serversRoot}`)
console.log(`candidates   : ${names.length}`)
console.log(`attributed   : ${scan.jvms.length}   unattributed: ${scan.unattributed.length}`)
console.log(`scan         : ok=${scan.ok} ${scan.tookMs} ms, loop blocked ${scan.loopBlockedMs} ms`)
console.log(`phases       : ${Object.entries(scan.phases).map(([k, v]) => `${k} ${v}ms`).join('  ')}`)
console.log(`ports needed : ${scan.portsEnumerated}`)
for (const j of scan.jvms) {
  console.log(
    `  pid ${String(j.pid).padStart(6)}  session ${j.sessionId}  by ${j.attributedBy.padEnd(18)} started ${j.startedBy.padEnd(15)} ${j.dir}`,
  )
}

// ======================================================== A. which world

console.log('\n--- A. which world is this testing')

check('the identity scan succeeded', scan.ok, scan.failure ?? '')
check('at least one server is running to test against', scan.jvms.length > 0)

const world = describeWorld(scan.jvms)
printWorld(world)
const taskStarted = scan.jvms.filter((j) => j.startedBy === 'scheduled-task')

// The load-bearing assertion. A green run must mean "the production
// configuration works", not "some configuration works".
check(
  'every server under test was started by a scheduled task, not a desktop',
  world.isProduction,
  `${world.summary} ${world.remedy}`,
)
check(
  'and runs in session 0, where the command line is unreadable',
  world.total > 0 && world.session0 === world.total,
  `${world.session0} of ${world.total}`,
)

// Signal accounting. Not an assertion that a particular signal wins, that
// depends on how the operator starts things, but an assertion that we KNOW
// which one did, since not knowing is precisely what hid the failure.
const bySignal = {
  'scheduled-task': scan.jvms.filter((j) => j.attributedBy === 'scheduled-task').length,
  'command-line': scan.jvms.filter((j) => j.attributedBy === 'command-line').length,
  'open-log-and-port': scan.jvms.filter((j) => j.attributedBy === 'open-log-and-port').length,
}
console.log(`  by signal: ${JSON.stringify(bySignal)}`)
check('every attributed JVM records which signal resolved it', scan.jvms.every((j) => !!j.attributedBy))
// task-LAUNCHED, not task-started: a server the dashboard starts while itself
// running from its boot task is a task DESCENDANT without being the task's
// payload, and it is correctly resolved by the command-line signal. Group D
// below pins that distinction; here the live fleet asserts both directions
// of the strong form.
check(
  'a task-launched server is resolved by the task signal, not left to a fallback',
  scan.jvms.every((j) => !j.taskLaunched || j.attributedBy === 'scheduled-task'),
  JSON.stringify(bySignal),
)
check(
  'and the task signal never claims a server its task did not launch',
  scan.jvms.every((j) => j.attributedBy !== 'scheduled-task' || j.taskLaunched),
  'a task-signal attribution must point at the task directory itself',
)
// This is the state that existed for a day and looked fine.
if (bySignal['command-line'] === 0 && scan.jvms.length > 0) {
  console.log(
    '  NOTE: the command-line signal resolved nothing. Expected in session 0, and it is exactly why it cannot be the only signal.',
  )
}

check(
  'every candidate directory that is running was found',
  hints.every((h) => !isOccupied(h.dir) || jvmForDir(scan.jvms, h.dir) !== null),
  'a directory holding its log open must resolve to a PID',
)
check(
  'a directory that is not running is not attributed a JVM',
  hints.every((h) => isOccupied(h.dir) || jvmForDir(scan.jvms, h.dir) === null),
)

// These three caught a real bug that the scheduled-task signal was masking
// entirely. PowerShell 5.1's ConvertFrom-Json emits a JSON array as ONE object,
// so `@($raw | ConvertFrom-Json)` nested it and the per-directory loop ran once
// with every hint merged together: `dir` came back as six paths joined by commas
// and signal 3 could never attribute anything. Nothing else noticed, because
// signal 1 had already answered for all four servers.
console.log(`  occupied: ${scan.occupiedDirs.length} of ${hints.length} candidates`)
check(
  'occupancy is reported per directory, not once for all of them',
  scan.occupiedDirs.every((o) => hints.some((h) => nkey(h.dir) === nkey(o))),
  `got ${JSON.stringify(scan.occupiedDirs)}`,
)
check(
  'and not more answers than there are candidates',
  scan.occupiedDirs.length <= hints.length,
)
check(
  'a directory whose server is stopped is not reported occupied',
  scan.occupiedDirs.length < hints.length,
  'at least one candidate here is stopped; if all read occupied the probe is stuck on true',
)

// Two directories here declare the same port. Port must never decide identity.
const byPort = new Map<number, string[]>()
for (const h of hints) {
  if (h.gamePort === null) continue
  byPort.set(h.gamePort, [...(byPort.get(h.gamePort) ?? []), h.dir])
}
const shared = [...byPort.values()].filter((v) => v.length > 1)
console.log(`  port-sharing groups: ${shared.length}`)
check(
  'of two directories sharing a port, at most one is credited with a JVM',
  shared.every((group) => group.filter((d) => jvmForDir(scan.jvms, d) !== null).length <= 1),
)
check('no JVM is credited to two directories', new Set(scan.jvms.map((j) => j.pid)).size === scan.jvms.length)

// ======================================================== B. doubt vs absence

console.log('\n--- B. doubt is never reported as absence')

const base = {
  kind: 'paper',
  uptimeSeconds: null,
  slp: null,
  rcon: null,
  rconConfigured: true,
} as const

const confident = assessHealth({ ...base, hasProcess: false, identityDoubt: null })
check('no process and no doubt is DOWN', confident.health === 'DOWN', confident.health)

const doubted = assessHealth({
  ...base,
  hasProcess: false,
  identityDoubt: '3 java processes are running that could not be matched to any server directory.',
})
console.log(`  ${doubted.health}: ${doubted.detail}`)
check('no process WITH doubt is UNKNOWN, not DOWN', doubted.health === 'UNKNOWN', doubted.health)
check('and the reason is carried into the text the user reads', /could not be matched/.test(doubted.detail))
check('and it says plainly that DOWN would be a guess', /would be a guess/.test(doubted.detail))

// Enumeration failing is the worst case: it looks exactly like an empty fleet.
const failed = assessHealth({
  ...base,
  hasProcess: false,
  identityDoubt: 'Process enumeration itself failed: powershell timed out.',
})
check('a failed enumeration is UNKNOWN for every server, not a fleet-wide outage', failed.health === 'UNKNOWN')

// And the doubt must not leak into servers that DO have a process.
const running = assessHealth({
  ...base,
  hasProcess: true,
  uptimeSeconds: 10,
  identityDoubt: 'something unrelated',
})
check('doubt does not affect a server whose process was found', running.health !== 'UNKNOWN', running.health)

// The provider must report what it could not place, rather than dropping it.
check('the scan reports unattributed JVMs as a list, not by omission', Array.isArray(scan.unattributed))
check(
  'and a failed scan is ok:false rather than an empty result',
  scan.ok || (scan.jvms.length === 0 && scan.failure !== null),
)

// ======================================================== C. cost

console.log('\n--- C. cost, and the observer not billing a server')

const RUNS = 5
const took: number[] = []
const blocked: number[] = []
for (let i = 0; i < RUNS; i++) {
  const s = await scanJvms(hints)
  took.push(s.tookMs)
  blocked.push(s.loopBlockedMs)
}
const sorted = [...took].sort((a, b) => a - b)
const p50 = sorted[Math.floor(sorted.length / 2)]!
const worst = sorted[sorted.length - 1]!
const worstBlocked = Math.max(...blocked)
console.log(`  ${RUNS} scans: p50 ${p50} ms, worst ${worst} ms`)
console.log(`  loop blocked during those scans: ${blocked.join(', ')} ms`)

check('the scan completes in under 3 s even at its worst', worst < 3000, `${worst} ms`)

/**
 * The one that matters. `observerBlockedMs(from, to)` is exactly the quantity
 * subtracted from a server's RCON latency before judging it. If the identity
 * scan's own window shows no blockage, there is no blockage for it to bill to
 * anybody, regardless of how long the subprocess took in wall clock, because
 * the work happened in another process.
 */
check(
  'the subprocess does not block our event loop',
  worstBlocked < 100,
  `worst ${worstBlocked} ms. A subprocess should cost us almost nothing on-loop`,
)

// Negative control: prove the instrument would notice. Without this, "0 ms
// blocked" is indistinguishable from a broken measurement, which is the same
// class of error as the whole rest of this file.
const spinFrom = Date.now()
const spinUntil = spinFrom + 300
while (Date.now() < spinUntil) {
  /* deliberately blocking the loop */
}
await new Promise((r) => setTimeout(r, 60))
const detected = observerBlockedMs(spinFrom, Date.now())
console.log(`  negative control: blocked the loop for 300 ms, measured ${detected} ms`)
check(
  'the instrument detects real loop blockage, so 0 ms means 0 ms',
  detected >= 200,
  `measured only ${detected} ms of a deliberate 300 ms block`,
)

// Ordering: the identity scan must be finished before any server probe starts,
// or its cost lands inside a server's measurement window. Asserted structurally,
// because it is a property of discovery.scan()'s shape.
const discoverySrc = await import('node:fs').then((fs) =>
  fs.readFileSync(join(import.meta.dirname, '..', 'server', 'discovery.ts'), 'utf8'),
)
// Matched on `scanJvms(` rather than `await scanJvms(`, because the call is now
// inside an `await Promise.all([...])` alongside launcher detection. Pinning the
// assertion to one spelling made it fail on a refactor that preserved the very
// property it was checking, which is a test asserting its own phrasing.
const scanAt = discoverySrc.indexOf('scanJvms(hints)')
const probesAt = discoverySrc.indexOf('candidates.map((c) =>')
const awaited = /await Promise\.all\(\[\s*scanJvms\(hints\)|await scanJvms\(hints\)/.test(discoverySrc)
check(
  'discovery awaits identity BEFORE it starts probing servers',
  scanAt > 0 && probesAt > 0 && scanAt < probesAt && awaited,
  `scanJvms at ${scanAt}, probes at ${probesAt}, awaited=${awaited}`,
)

// The expensive listener enumeration should be skipped when a stronger signal
// already answered. Not a correctness property, but a regression guard: it is
// 590 ms of the budget when Get-NetTCPConnection is used, 70 ms via netstat, and
// 0 when it is not needed at all.
console.log(`  listening sockets enumerated: ${scan.portsEnumerated}`)
if (bySignal['scheduled-task'] === scan.jvms.length && scan.jvms.length === hints.filter((h) => isOccupied(h.dir)).length) {
  check('when every server is task-resolved, the port scan is skipped', !scan.portsEnumerated)
}

// ================================= D. a task in the ancestry is not the launcher

/**
 * 2026-08-02, live: a server started by the Create page read UNKNOWN while its
 * JVM ran, its log held open. The dashboard itself runs from a boot-triggered
 * scheduled task, so the new JVM's ancestry passed through THAT task's engine
 * and signal 1 attributed it to the dashboard's own directory; the wrongly
 * claimed pid then blocked signals 2 and 3. The tables below replay that
 * topology through the REAL interpretation path -- only the PowerShell
 * invocation is substituted (setPsForProof) -- and pin the rule: a task in the
 * ancestry wins only when it names the directory the evidence points at;
 * otherwise the nearest launcher command line does. This is the misreporting
 * category: a healthy server the dashboard itself started, reported UNKNOWN.
 */
console.log('\n--- D. a task in the ancestry is not always the launcher')

const CREATED = 'C:\\srv\\MC Created'
const PAPER = 'C:\\srv\\MC Paper'
const SAME = 'C:\\srv\\MC Same'
const MCDASH = 'C:\\ops\\mcdash'

// Topology: dashboard task engine 40 -> node 41 -> cmd 42 -> java 43 (the
// created server; readable parent command line naming CREATED). Paper task
// engine 60 -> cmd 61 -> java 62 (S4U: command lines unreadable, the
// production shape). Task engine 70 -> cmd 71 -> java 72 with a READABLE
// parent command line naming the task's own directory.
const syntheticWorld = (dashboardUnderTask: boolean) => ({
  jvms: [
    {
      pid: 43, ppid: 42, sessionId: 0,
      parentCmd: `cmd.exe /d /s /c ""${CREATED}\\start.bat""`,
      ownCmd: 'java  -Xms2048M -Xmx2048M -jar "server.jar" nogui',
      ws: 9437184, priv: 2446983168, basePri: 6, cpu100ns: 120000000,
      start: '2026-08-02T21:51:39.000Z',
    },
    {
      pid: 62, ppid: 61, sessionId: 0, parentCmd: null, ownCmd: null,
      ws: 626524160, priv: 3711959040, basePri: 8, cpu100ns: 9000000000,
      start: '2026-08-02T20:03:42.000Z',
    },
    {
      pid: 72, ppid: 71, sessionId: 0,
      parentCmd: `cmd.exe /c "${SAME}\\start.bat"`,
      ownCmd: 'java -Xmx1024M -jar "server.jar" nogui',
      ws: 314572800, priv: 1073741824, basePri: 8, cpu100ns: 4000000000,
      start: '2026-08-02T20:05:00.000Z',
    },
  ],
  tasks: [
    ...(dashboardUnderTask
      ? [{ name: 'Minecraft Server Dashboard', enginePid: 40, dir: MCDASH, args: '' }]
      : []),
    { name: 'Minecraft Paper', enginePid: 60, dir: PAPER, args: '' },
    { name: 'Minecraft Same', enginePid: 70, dir: SAME, args: '' },
  ],
  parents: [[40, 4], [41, 40], [42, 41], [43, 42], [60, 4], [61, 60], [62, 61], [70, 4], [71, 70], [72, 71]],
  dirs: [
    { dir: CREATED, logHeld: true, port: 25599, listenerPid: 43 },
    { dir: PAPER, logHeld: true, port: 25565, listenerPid: 62 },
    { dir: SAME, logHeld: true, port: 25570, listenerPid: 72 },
  ],
  phases: {},
  portsEnumerated: false,
})

const dHints: DirHint[] = [
  { dir: CREATED, gamePort: 25599 },
  { dir: PAPER, gamePort: 25565 },
  { dir: SAME, gamePort: 25570 },
]

const forDir = (s: Awaited<ReturnType<typeof scanJvms>>, dir: string) =>
  s.jvms.find((j) => nkey(j.dir) === nkey(dir)) ?? null

// The world that failed live: the dashboard runs from its boot task.
setPsForProof(async () => JSON.stringify(syntheticWorld(true)))
const d1 = await scanJvms(dHints)
setPsForProof(null)

check('D: the synthetic scan succeeded', d1.ok, d1.failure ?? '')
const created = forDir(d1, CREATED)
check(
  'a server the dashboard started is attributed to ITS directory, not the dashboard task directory',
  created !== null && created.pid === 43,
  JSON.stringify(d1.jvms.map((j) => [j.pid, j.dir])),
)
check(
  'and by the command-line signal, its nearest launcher evidence',
  created?.attributedBy === 'command-line',
  created?.attributedBy,
)
check(
  'and it is task-descended without being task-launched',
  created !== null && created.startedBy === 'scheduled-task' && !created.taskLaunched,
  created ? `startedBy=${created.startedBy} taskLaunched=${created.taskLaunched}` : 'not attributed',
)
check(
  'nothing is attributed to the dashboard directory',
  d1.jvms.every((j) => nkey(j.dir) !== nkey(MCDASH)),
)
const dPaper = forDir(d1, PAPER)
check(
  'the S4U production shape still resolves by its task',
  dPaper !== null && dPaper.pid === 62 && dPaper.attributedBy === 'scheduled-task' && dPaper.taskLaunched,
  dPaper ? `${dPaper.attributedBy} taskLaunched=${dPaper.taskLaunched}` : 'not attributed',
)
const dSame = forDir(d1, SAME)
check(
  'a readable command line agreeing with its task stays with the task signal',
  dSame !== null && dSame.pid === 72 && dSame.attributedBy === 'scheduled-task' && dSame.taskLaunched,
  dSame ? `${dSame.attributedBy} taskLaunched=${dSame.taskLaunched}` : 'not attributed',
)
check('no JVM is left unattributed in this topology', d1.unattributed.length === 0,
  JSON.stringify(d1.unattributed))

// The same fleet with the dashboard NOT under any task -- the world in which
// creation was originally proven green, kept green.
setPsForProof(async () => JSON.stringify(syntheticWorld(false)))
const d2 = await scanJvms(dHints)
setPsForProof(null)
const created2 = forDir(d2, CREATED)
check(
  'with the dashboard outside any task, the created server still resolves by command line',
  created2 !== null && created2.pid === 43 && created2.attributedBy === 'command-line',
  created2 ? created2.attributedBy : 'not attributed',
)
check(
  'and is then plain unknown provenance, not claimed task-descended',
  created2 !== null && created2.startedBy === 'unknown' && !created2.taskLaunched,
  created2 ? `startedBy=${created2.startedBy}` : 'not attributed',
)

stopObserverMonitor()

console.log('')
let failed_ = 0
for (const [l, ok, d] of checks) {
  if (!ok) failed_++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d ? `  (${d})` : ''}`)
}
console.log(failed_ === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed_} FAILED`)
process.exit(failed_ === 0 ? 0 : 1)
