/**
 * PROOF: observer lag is a host measurement, and the fleet reading tells a host
 * event apart from a server event.
 *
 * Two claims, neither of which is allowed to be asserted:
 *
 * 1. The lag sampler can tell WHY the loop was late. "We were on-CPU running our
 *    own code" and "wall clock passed while we were not scheduled at all" are
 *    different events with different owners, and only the second is evidence
 *    about the machine. This is the difference between the §11 bug (ours) and a
 *    host stall (not ours), and if the sampler cannot separate them then the
 *    whole inference below rests on nothing.
 *
 *    Both are producible on demand. A busy-wait blocks the loop while burning
 *    CPU. Atomics.wait blocks the same loop for the same wall-clock time while
 *    burning none -- which is exactly what being descheduled looks like from
 *    inside the process, and is the closest honest simulation of it available
 *    without a sick machine to hand.
 *
 * 2. Given per-server verdicts plus that lag figure, the fleet inference names
 *    the right culprit. Asserted over synthetic fleets, because the real event
 *    being modelled -- 177 stalls across four servers in one day, 2026-07-28 --
 *    is not reproducible on demand, and waiting for it is not a test strategy.
 *
 * WORLD: n/a. The fleets here are synthetic, because the events being modelled
 * cannot be produced on demand. No real process is inspected, so this proof does
 * not exercise process identity at all. See docs/proof-coverage.md.
 *
 * Run:  npx tsx scripts/prove-host-lag.ts
 */
import type { LoopLag, ServerStatus } from '@shared/api'
import {
  loopLag,
  startObserverMonitor,
  stopObserverMonitor,
  observerBlockedMs,
} from '../server/loopguard'
import { assessHost, inferFault, observeFleet, resetFleetMemory } from '../server/hostwatch'

const checks: Array<[string, boolean]> = []
const check = (label: string, ok: boolean) => checks.push([label, ok])

function spin(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* on-CPU: this is what OUR OWN blocking looks like */
  }
}

/** Blocks the event loop without consuming CPU: descheduling, simulated. */
function sleepBlocking(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Long enough for the granularity floor to calibrate (50 samples at ~31 ms each
 * on this host), because a host verdict taken before that is deliberately
 * UNMEASURED -- the figures still carry the platform's clock.
 */
const settle = () => new Promise((r) => setTimeout(r, 2000))

// ===========================================================================
// 0. An idle host must read as idle
// ===========================================================================
// The first version of this metric reported p50 11 ms and 47 ms of "starvation"
// per minute on a machine doing nothing, because a 20 ms setInterval fires on
// the next 15.6 ms Windows tick. A host metric whose floor is the platform's
// clock would have made every reading below look like mild starvation.
// 3 s, not 1.5: on Windows each 20 ms tick actually takes ~31 ms, so 1.5 s is
// 48 samples and the floor needs 50 before it is believed. Getting this wrong
// is how the check first "failed" -- the metric was right and the test was
// asking it to be sure of something it had not yet seen.
startObserverMonitor()
await new Promise((r) => setTimeout(r, 300))
const early = assessHost(loopLag())
await new Promise((r) => setTimeout(r, 2700))
const idle = loopLag()
const idleHost = assessHost(idle)
stopObserverMonitor()

console.log('0. idle host, 3 s of samples')
console.log(`   after 300 ms                ${early.state} (baseline not calibrated yet)`)
check('a sampler too young to have a baseline says so, rather than OK', early.state === 'UNMEASURED')

console.log(`   timer granularity measured  ${idle.timerFloorMs} ms (subtracted from every figure)`)
console.log(`   p50 / p95 / worst           ${idle.p50Ms} / ${idle.p95Ms} / ${idle.maxMs} ms`)
console.log(`   attributed to starvation    ${idle.starvedMs} ms`)
console.log(`   host state                  ${idleHost.state}`)

check('an idle host does not report its own timer granularity as lag', idle.p50Ms <= 2)
check('an idle host is not accused of starving this process', idle.starvedMs <= 25)
check('an idle host reads OK', idleHost.state === 'OK')

// ===========================================================================
// 1. The sampler separates our own CPU from being starved of it
// ===========================================================================
const BLOCK_MS = 1500

startObserverMonitor()
await settle()

const floorBefore = loopLag().timerFloorMs
const t0 = Date.now()
spin(BLOCK_MS)
await settle()
const selfLag = loopLag()
const selfCredited = observerBlockedMs(t0, Date.now())
stopObserverMonitor()

console.log('1. loop blocked ON-CPU (busy-wait, our own synchronous work)')
console.log(`   worst block detected        ${selfLag.maxMs} ms`)
console.log(`   attributed to starvation    ${selfLag.starvedMs} ms`)
console.log(`   share not our own CPU       ${(assessHost(selfLag).starvedShare * 100).toFixed(0)}%`)
console.log(`   host state                  ${assessHost(selfLag).state}`)

check('a busy-wait is detected as a block', selfLag.maxMs >= BLOCK_MS * 0.9)
// setInterval fires its catch-up ticks at zero delay once a block ends. Taking
// the granularity floor as the MINIMUM sample let one of those pin it at 0 for
// the rest of the run, and the platform's timer came straight back into every
// figure. The median is unmoved by them.
check(
  'a block does not move the measured timer granularity',
  selfLag.timerFloorMs === floorBefore,
)
check('a busy-wait is NOT attributed to the host', !assessHost(selfLag).starved)
check('a busy-wait still counts against a probe (§11 unchanged)', selfCredited >= BLOCK_MS * 0.9)

startObserverMonitor()
await settle()

const t1 = Date.now()
sleepBlocking(BLOCK_MS)
await settle()
const starvedLag = loopLag()
const starvedCredited = observerBlockedMs(t1, Date.now())
stopObserverMonitor()

console.log('\n2. loop blocked OFF-CPU (no CPU consumed: descheduling, simulated)')
console.log(`   worst block detected        ${starvedLag.maxMs} ms`)
console.log(`   attributed to starvation    ${starvedLag.starvedMs} ms`)
console.log(
  `   share not our own CPU       ${(assessHost(starvedLag).starvedShare * 100).toFixed(0)}%`,
)
console.log(`   host state                  ${assessHost(starvedLag).state}`)

check('an off-CPU block is detected as a block', starvedLag.maxMs >= BLOCK_MS * 0.9)
check('an off-CPU block IS attributed to the host', assessHost(starvedLag).starved)
check('an off-CPU block still counts against a probe', starvedCredited >= BLOCK_MS * 0.9)
check(
  'the two blocks are the same size in wall clock',
  Math.abs(selfLag.maxMs - starvedLag.maxMs) < BLOCK_MS * 0.25,
)
check(
  'and are told apart anyway',
  assessHost(selfLag).starvedShare < 0.5 && assessHost(starvedLag).starvedShare > 0.5,
)

// ===========================================================================
// 2. The lag figure is not blind to a block that is still open
// ===========================================================================
// The §11 subtlety, applied to the host metric: a caller asking DURING a block
// has given the sampler no turn in which to record it. The naive version of
// this reports a calm machine at the exact moment the machine is worst.
startObserverMonitor()
await settle()
const midBlockLag: LoopLag = await new Promise((resolve) => {
  setTimeout(() => {
    sleepBlocking(1200)
    resolve(loopLag()) // queried before the sampler can possibly have ticked
  }, 50)
})
stopObserverMonitor()

console.log('\n3. queried DURING a 1,200 ms block, before the sampler could tick')
console.log(`   reported worst block        ${midBlockLag.maxMs} ms`)
check('a block still in progress is already visible', midBlockLag.maxMs >= 1000)

// ===========================================================================
// 3. The inference: host event vs server event
// ===========================================================================
function lag(o: Partial<LoopLag>): LoopLag {
  return {
    sampleMs: 20,
    windowSeconds: 60,
    samples: 3000,
    timerFloorMs: 11,
    p50Ms: 0,
    p95Ms: 0,
    maxMs: 0,
    blockedMs: 0,
    starvedMs: 0,
    history: [],
    ...o,
  }
}

const FLAT = lag({})
/** The machine stopped scheduling us: big block, none of it our CPU. */
const STARVED = lag({ p95Ms: 900, maxMs: 4200, blockedMs: 9000, starvedMs: 8600 })
/** We blocked ourselves: same size block, all of it our own CPU. §11's bug. */
const SELF = lag({ p95Ms: 900, maxMs: 4200, blockedMs: 9000, starvedMs: 200 })

function srv(name: string, health: ServerStatus['health']): ServerStatus {
  return {
    id: name,
    name,
    dir: `/fake/${name}`,
    kind: 'paper',
    classification: 'live',
    gamePort: 25565,
    levelName: 'world',
    worldDirs: [],
    settings: { onlineMode: true, whitelist: true, fileModifiedAt: null, changedSinceStart: null },
    rconConfigured: true,
    health,
    healthDetail: '',
    healthSince: new Date().toISOString(),
    healthScans: 1,
    attribution: null,
    attributionDetail: null,
    proc: { pid: 1, workingSetMb: null, privateMb: null, heapMaxMb: null, uptimeSeconds: 9000 },
    slp: null,
    rcon: null,
    gc: null,
    memory: null,
    boot: {
      graceSeconds: 180,
      source: 'default',
      samples: 0,
      maxSeconds: null,
      lastSeconds: null,
      lastPortSeconds: null,
      detail: 'no boots measured',
    },
    backupEnabled: true,
    launchStrategy: 'windows-task',
    launchDetail: 'Started by a scheduled task.',
    controlBusy: false,
    players: null,
    tps: null,
    portConflictWith: [],
    dynmap: null,
    checkedAt: new Date().toISOString(),
  }
}

const fleet = (healths: Array<ServerStatus['health']>) =>
  healths.map((h, i) => srv(`server-${i + 1}`, h))

const cases: Array<{ label: string; servers: ServerStatus[]; lag: LoopLag; want: string }> = [
  {
    label: 'all four stalled, observer starved      -> the machine',
    servers: fleet(['STALLED', 'STALLED', 'STALLED', 'STALLED']),
    lag: STARVED,
    want: 'host',
  },
  {
    label: 'all four stalled, observer flat         -> a shared cause',
    servers: fleet(['STALLED', 'STALLED', 'STALLED', 'STALLED']),
    lag: FLAT,
    want: 'shared',
  },
  {
    label: 'all four stalled, observer self-blocked -> our own bug',
    servers: fleet(['STALLED', 'STALLED', 'STALLED', 'STALLED']),
    lag: SELF,
    want: 'observer',
  },
  {
    label: 'one stalled, observer flat              -> that server',
    servers: fleet(['STALLED', 'HEALTHY', 'HEALTHY', 'HEALTHY']),
    lag: FLAT,
    want: 'server',
  },
  {
    label: 'one stalled, observer starved           -> not trustworthy yet',
    servers: fleet(['STALLED', 'HEALTHY', 'HEALTHY', 'HEALTHY']),
    lag: STARVED,
    want: 'observer',
  },
  {
    label: 'all healthy, observer starved           -> nothing wrong (yet)',
    servers: fleet(['HEALTHY', 'HEALTHY', 'HEALTHY', 'HEALTHY']),
    lag: STARVED,
    want: 'none',
  },
  {
    label: 'all UNKNOWN, observer starved           -> the machine',
    servers: fleet(['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']),
    lag: STARVED,
    want: 'host',
  },
  {
    label: 'half stalled, observer starved          -> the machine',
    servers: fleet(['STALLED', 'STALLED', 'HEALTHY', 'HEALTHY']),
    lag: STARVED,
    want: 'host',
  },
]

console.log('\n4. where is the fault?\n')
for (const c of cases) {
  const got = inferFault(c.servers, assessHost(c.lag), c.lag)
  console.log(`   ${got.fault === c.want ? 'PASS' : 'FAIL'}  ${c.label}  [${got.fault}]`)
  check(c.label.trim(), got.fault === c.want)
}

// A server with no RCON is UNKNOWN in every scan for ever. If that counted as
// degradation it would drag every reading towards "fleet-wide" permanently --
// a constant cannot correlate with anything.
const withBlind = fleet(['STALLED', 'HEALTHY', 'HEALTHY'])
withBlind.push({ ...srv('no-rcon', 'UNKNOWN'), rconConfigured: false })
const blindCase = inferFault(withBlind, assessHost(FLAT), FLAT)
console.log(`\n   RCON-less server excluded from correlation  [${blindCase.fault}]`)
check(
  'a permanently-UNKNOWN server does not count as degradation',
  blindCase.fault === 'server' && blindCase.probed === 3,
)

// An empty machine must not be reported as a healthy fleet. "All 0 probed
// servers are answering normally. Nothing is wrong" is a lie by this
// product's own standard: nothing was measured, so nothing may be reassured
// about. Written before the fix, per the standing instruction.
const emptyCase = inferFault([], assessHost(FLAT), FLAT)
console.log(`\n   zero discovered servers  [${emptyCase.headline}]`)
check(
  'zero discovered servers is never reported as nothing-is-wrong',
  !emptyCase.headline.includes('Nothing is wrong') && !emptyCase.detail.includes('answering normally'),
)
check(
  'the empty fleet names its own state in plain language',
  /no servers|discovered/i.test(emptyCase.headline + ' ' + emptyCase.detail),
)
check('and accuses no one', emptyCase.fault === 'none' && emptyCase.probed === 0)

// Discovered but unprobable is a different sentence: directories exist, but
// no reading can be taken, and that must not be dressed as health either.
const unprobable = [{ ...srv('no-rcon-1', 'UNKNOWN'), rconConfigured: false }]
const unprobableCase = inferFault(unprobable, assessHost(FLAT), FLAT)
console.log(`   discovered but unprobable  [${unprobableCase.headline}]`)
check(
  'a fleet that cannot be probed is not reported as answering normally',
  !unprobableCase.detail.includes('answering normally'),
)

// ===========================================================================
// 4. Persistence: the same fault held across scans, and a persistent UNKNOWN
//    that explains itself
// ===========================================================================
resetFleetMemory()
const persistent = fleet(['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'])
let host = observeFleet(persistent, STARVED, Date.now())
const firstDetail = persistent[0]!.attributionDetail ?? ''
for (let i = 1; i <= 5; i++) host = observeFleet(persistent, STARVED, Date.now() + i * 10_000)
const settledDetail = persistent[0]!.attributionDetail ?? ''

console.log('\n5. a persistent UNKNOWN, six scans in')
console.log(`   fleet verdict held for      ${host.fleet.scans} scans`)
console.log(`   server attribution          ${persistent[0]!.attribution}`)
console.log(`   scan 1 says:  ${firstDetail.slice(0, 96)}…`)
console.log(`   scan 6 says:  ${settledDetail.slice(0, 96)}…`)

check('the fleet verdict accumulates scans', host.fleet.scans === 6)
check('a persistent UNKNOWN is attributed to the host', persistent[0]!.attribution === 'host')
check('and its explanation changes once it is not a blip', settledDetail !== firstDetail)
check('the explanation states how long it has held', /consecutive scans/.test(settledDetail))
check('the server is explicitly not accused', /has not been accused/.test(settledDetail))

// The other UNKNOWN: no RCON. Same badge, completely different remedy.
resetFleetMemory()
const blind = [{ ...srv('blind', 'UNKNOWN'), rconConfigured: false }]
observeFleet(blind, FLAT, Date.now())
console.log(`\n   RCON-less server attribution  ${blind[0]!.attribution}`)
check('an UNKNOWN with no RCON is a configuration problem, not a host one', blind[0]!.attribution === 'configuration')
check(
  'and does not promise a retry that will never help',
  !/Retrying on the next scan/.test(blind[0]!.attributionDetail ?? ''),
)

// ===========================================================================
// The paging reading (stall investigation, 2026-08-02): the number that had
// to come from an external monitor's CSV now rides in the snapshot. What
// must not happen: a quiet machine reading as elevated (10x a tiny idle
// baseline is still tiny) or a null-before-first-sample reading as a zero.
{
  const { pushPagingSample, pagingReading, resetPaging, MIN_ELEVATED_PPS, ELEVATED_FACTOR } =
    await import('../server/hostpaging')

  resetPaging()
  check('before any sample the paging reading is null, not zero', pagingReading() === null)

  const now = Date.now()
  for (let i = 0; i < 20; i++) pushPagingSample(16, now - (20 - i) * 30_000)
  pushPagingSample(150, now)
  let r = pagingReading(now)
  check(
    'ten times a tiny idle baseline is still not elevated',
    r !== null && !r.elevated && r.baselinePerSec === 16,
  )

  pushPagingSample(7800, now)
  r = pagingReading(now)
  check(
    `a fault storm (${7800}/s on a ~16/s baseline) is elevated`,
    r !== null && r.elevated === true,
  )
  check(
    'the elevated sentence carries both numbers, so it is checkable',
    r !== null && r.detail.includes('7800') && r.detail.includes('16'),
  )

  resetPaging()
  const busy = 3 * MIN_ELEVATED_PPS
  for (let i = 0; i < 20; i++) pushPagingSample(busy, now - (20 - i) * 30_000)
  pushPagingSample(busy * 2, now)
  r = pagingReading(now)
  check(
    'a machine with an already-high baseline is not elevated for being itself',
    r !== null && !r.elevated && busy * 2 < ELEVATED_FACTOR * busy,
  )
}

console.log('')
let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
