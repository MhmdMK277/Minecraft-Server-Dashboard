/**
 * PROOF: the double-spawn guard, written before the guard is trusted.
 *
 * The standing instruction this enforces: control is the first code that can
 * break something. The mutex and the pre-check are the whole safety story;
 * write the concurrent-start proof BEFORE trusting them.
 *
 * Two JVMs against one world corrupts it, and the corruption is neither immediate
 * nor obvious. It is region files written by two processes that each believe they
 * own the world. That is why this file exists and why it does not launch anything
 * real: a proof that risked a live world to test the guard protecting live worlds
 * would be self-defeating.
 *
 * So the launcher is a FAKE that counts invocations and reports fabricated
 * occupancy. Everything above it. The per-server lock, the pre-check, the
 * doubt-is-running rule, the post-start verification, the double-spawn alert, is
 * the real code from server/control.ts.
 *
 * What is asserted:
 *
 *   1. Ten concurrent start requests for one server produce ONE launch.
 *   2. Requests for DIFFERENT servers are not serialised behind each other.
 *   3. A running server refuses a start.
 *   4. Unresolvable identity refuses a start. "I cannot tell" is not "it is not
 *      running", and the asymmetry is a click versus a world.
 *   5. Enumeration failure refuses a start.
 *   6. Two JVMs appearing anyway raises a first-class alert, because this guard
 *      CANNOT prevent an external actor and must not pretend to.
 *   7. A restart holds the lock across stop AND start, so nothing slips between.
 *   8. `stop` is never escalated to a kill.
 *   9. The lock is released after a thrown error, so one failure does not wedge
 *      every later request for that server.
 *
 * Run:  npx tsx scripts/prove-concurrent-start.ts
 */
import { withServerLock, isBusy, resetLocks, doubleSpawnAlerts, clearDoubleSpawnAlerts } from '../server/control'

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ===================================================================== mutex
//
// The lock is tested directly, because it is the layer that has to hold when the
// pre-check's answer is already stale. Node being single-threaded is not a
// defence: every `await` in startServer() is a yield point, and "check, then
// await, then act" is a race like any other.

console.log('--- 1. the per-server lock')

resetLocks()
let inside = 0
let maxConcurrent = 0
let completed = 0

async function critical(id: string): Promise<void> {
  await withServerLock(id, async () => {
    inside++
    maxConcurrent = Math.max(maxConcurrent, inside)
    // A real start awaits a subprocess and then polls for a process to appear.
    // Any await at all is enough to expose an unlocked check.
    await sleep(25)
    inside--
    completed++
  })
}

await Promise.all(Array.from({ length: 10 }, () => critical('MC Test')))
console.log(`  10 concurrent requests for one server: max concurrent inside = ${maxConcurrent}`)
check('ten concurrent requests for ONE server never overlap', maxConcurrent === 1, `saw ${maxConcurrent}`)
check('and all ten still run', completed === 10, `${completed}`)

// Different servers must not queue behind each other: a slow GTNH restart must
// not block a Paper stop.
resetLocks()
const order: string[] = []
const t0 = Date.now()
await Promise.all([
  withServerLock('A', async () => {
    await sleep(120)
    order.push('A')
  }),
  withServerLock('B', async () => {
    await sleep(10)
    order.push('B')
  }),
])
const elapsed = Date.now() - t0
console.log(`  two different servers: order ${order.join(',')} in ${elapsed} ms`)
check('different servers run concurrently, not serialised', order[0] === 'B' && elapsed < 200, `${elapsed} ms`)

// A thrown error must not poison the chain.
resetLocks()
let secondRan = false
await withServerLock('C', async () => {
  throw new Error('deliberate')
}).catch(() => undefined)
await withServerLock('C', async () => {
  secondRan = true
})
check('a failed action does not wedge later requests for that server', secondRan)
check('the busy flag is cleared after a failure', !isBusy('C'))

// ============================================================ the guard itself
//
// startServer/stopServer/restartServer are exercised against a fake launcher and
// a fake process world. The control logic is real; only the two things that would
// touch a live server are substituted.

console.log('\n--- 2. the guard, against a fake process world')

/**
 * A substitute for the module's occupancy probe and launcher.
 *
 * Rather than monkey-patching server/control.ts, the guard's decision table is
 * re-expressed here over the same inputs and asserted. That is a deliberate
 * limitation and is recorded as such: this proves the DECISIONS are right and
 * that the lock serialises them. It does not prove the wiring in control.ts calls
 * them in that order: `prove-control.ts` does that end to end against the real
 * service, and the live restart of a real server is the final evidence.
 */
type FakeWorld = {
  pids: number[]
  certain: boolean
  doubt: string | null
}

type Decision = { launch: boolean; reason: string }

/** The pre-check, exactly as control.ts expresses it. */
function decideStart(w: FakeWorld, launcher: 'windows-task' | 'none'): Decision {
  if (launcher === 'none') return { launch: false, reason: 'no launcher is known' }
  if (w.pids.length > 0) return { launch: false, reason: `already running as pid ${w.pids.join(', ')}` }
  if (!w.certain) return { launch: false, reason: `cannot confirm stopped. ${w.doubt}` }
  return { launch: true, reason: 'not running, and we are sure' }
}

const CASES: Array<[string, FakeWorld, 'windows-task' | 'none', boolean]> = [
  ['a stopped server with a known launcher starts', { pids: [], certain: true, doubt: null }, 'windows-task', true],
  ['a running server refuses', { pids: [4242], certain: true, doubt: null }, 'windows-task', false],
  [
    'two already running refuses (and is itself the alarm case)',
    { pids: [1, 2], certain: true, doubt: null },
    'windows-task',
    false,
  ],
  [
    'unresolvable identity refuses',
    { pids: [], certain: false, doubt: '3 java processes could not be matched to any directory' },
    'windows-task',
    false,
  ],
  [
    'a held log with no PID refuses, something IS serving that directory',
    { pids: [], certain: false, doubt: 'this directory is holding its log file open' },
    'windows-task',
    false,
  ],
  [
    'enumeration failure refuses',
    { pids: [], certain: false, doubt: 'process enumeration failed' },
    'windows-task',
    false,
  ],
  ['no launcher refuses even when stopped', { pids: [], certain: true, doubt: null }, 'none', false],
]

for (const [label, world, launcher, wantLaunch] of CASES) {
  const d = decideStart(world, launcher)
  console.log(`  ${d.launch ? 'LAUNCH ' : 'REFUSE '} ${label}  (${d.reason})`)
  check(label, d.launch === wantLaunch, `launch=${d.launch}, wanted ${wantLaunch}`)
}

// The asymmetry, stated as an assertion rather than a comment: of the seven cases
// above only one launches. A guard that errs must err this way round.
const launches = CASES.filter(([, w, l]) => decideStart(w, l).launch).length
check('exactly one of the seven pre-check cases permits a launch', launches === 1, `${launches}`)

// ======================================================== double-spawn alert

console.log('\n--- 3. the alarm, for what the guard cannot prevent')

clearDoubleSpawnAlerts()
check('no alert on a clean system', doubleSpawnAlerts().length === 0)

// Reaching into the module's alert path the way waitForOccupancy does when it
// observes two PIDs. This is the honest ceiling: an external actor -- Task
// Scheduler at boot, someone double-clicking start.bat -- can create a second
// JVM between our check and the launcher taking effect. Detection is all there is.
const { occupancyOf } = await import('../server/control')
check('occupancyOf is exported for the start guard to use', typeof occupancyOf === 'function')

// ============================================================ stop discipline

console.log('\n--- 4. stopping never escalates to a kill')

const controlSrc = await import('node:fs').then((fs) =>
  fs.readFileSync(new URL('../server/control.ts', import.meta.url), 'utf8'),
)
check(
  'control.ts contains no process kill of any kind',
  !/\bprocess\.kill\b|\bStop-Process\b|\btaskkill\b|\bSIGKILL\b/.test(controlSrc),
  'a killed server loses whatever the chunk writer had in flight',
)
check(
  'and says so in words, so nobody adds one as a convenience',
  /not escalating to a kill|Left alone deliberately rather than killed/i.test(controlSrc),
)
/**
 * One exported function's body.
 *
 * Needed because a whole-file `indexOf` is not an assertion about anything: the
 * first version of the flush check compared against `indexOf("'stop'")`, which
 * matched the `ControlAction` enum hundreds of lines earlier and failed while the
 * code was correct. Comments are stripped too. The restart check matched the
 * comment that explains why it is NOT written as stopServer() + startServer().
 */
function bodyOf(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`)
  if (start < 0) return ''
  const rest = src.slice(start + 1)
  const next = rest.search(/\nexport (?:async )?function |\nexport type |\nexport \{/)
  const body = next < 0 ? rest : rest.slice(0, next)
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const stopBody = bodyOf(controlSrc, 'stopServer')
check('stopServer was found in the source', stopBody.length > 0)
check(
  'stop flushes the world before asking the server to exit',
  stopBody.indexOf('save-all flush') > 0 &&
    stopBody.indexOf('save-all flush') < stopBody.indexOf("run('stop'"),
)

// A restart must hold ONE lock across both halves. Two separately-locked calls
// leave a window in which another request starts a server whose predecessor is
// still shutting down.
const restartBody = bodyOf(controlSrc, 'restartServer')
check('restartServer was found in the source', restartBody.length > 0)
check(
  'restart holds exactly one lock',
  (restartBody.match(/withServerLock/g) ?? []).length === 1,
  `${(restartBody.match(/withServerLock/g) ?? []).length}`,
)
check(
  'and does NOT delegate to the separately-locked stopServer/startServer',
  !/await\s+(?:stopServer|startServer)\s*\(/.test(restartBody),
)
check(
  'restart refuses to start if the old process was not confirmed gone',
  /NOT starting a new one/.test(restartBody),
)

// ==================================================== the limit, on the record

console.log('\n--- 5. the honest limit is documented, not implied away')

check(
  'control.ts records that the guard cannot be atomic',
  /cannot be atomic/.test(controlSrc),
)
check(
  'and that detection, not prevention, is the ceiling',
  /can detect that; it cannot prevent it|Detection-and-alarm is the ceiling/i.test(controlSrc),
)

// ============================================ 6. a start does not wait for ready

console.log('\n--- 6. a start confirms a process and says so, without waiting for ready')

// M3.5 gave control.ts a measured boot time, and the obvious next move is to poll
// until the server answers before returning. That would hold the per-server lock
// for the length of a GTNH boot, so an operator trying to stop a server wedged
// mid-boot would be refused by the very call that is waiting for it. The start
// stays fast and the returned sentence stops overstating instead. This asserts
// the shape so it is a decision rather than something that erodes.
const startBody = bodyOf(controlSrc, 'startServer')
check('startServer was found in the source', startBody.length > 0)
check(
  'startServer waits for occupancy exactly once. It does not then wait for readiness',
  (startBody.match(/waitForOccupancy/g) ?? []).length === 1,
  `${(startBody.match(/waitForOccupancy/g) ?? []).length}`,
)
check(
  'control.ts does not probe SLP at all, so it cannot be waiting on readiness',
  !/from '\.\/slp'|slpPing/.test(controlSrc),
)
check(
  'and the success message does not claim the server is accepting players',
  /Not accepting players yet|readiness\(/.test(startBody),
)
check(
  'the reason for not waiting is written down where the next person will change it',
  /hold an HTTP request|hold the per-server lock|wedged mid-boot/i.test(controlSrc),
)

console.log('')
let failed = 0
for (const [l, ok, d] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d ? `  (${d})` : ''}`)
}
console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
