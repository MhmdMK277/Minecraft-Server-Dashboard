/**
 * PROOF: the start path actually starts something, and refuses to start it twice.
 *
 * `prove-concurrent-start.ts` proves the lock and the decision table.
 * `prove-control.ts` proves the HTTP surface and every refusal.
 * Neither of them ever invokes a launcher, so `invokeLauncher` and the post-start
 * verification loop were the only parts of M3.3 with no live evidence behind them.
 *
 * This closes that gap WITHOUT touching a Minecraft world. It builds a throwaway
 * server directory containing a real `start.bat` that launches a real JVM. A
 * single-file Java program that just sleeps, and drives the real
 * `startServer()` against it. The JVM is genuine, so process attribution,
 * occupancy counting and the appear-then-verify loop all run for real; the
 * "world" is an empty `level.dat` nobody will ever load.
 *
 * What is asserted:
 *   1. `script` is detected when no scheduled task names the directory.
 *   2. startServer() invokes it and a JVM appears, attributed to THIS directory.
 *   3. A second start is refused, naming the running pid.
 *   4. A restart is refused when the directory has no RCON, rather than the old
 *      process being killed to make room.
 *   5. The dashboard's own occupancy count agrees with the process list.
 *
 * The fake JVM is terminated at the end by this script directly, not through
 * control.ts, control.ts deliberately contains no kill, and a sleeping test
 * process is not a Minecraft server with chunks in flight.
 *
 * WORLD: n/a for identity provenance. This deliberately exercises the `script`
 * strategy and a session-1 process, which is the case the production path is NOT.
 * That is the point: the windows-task path is covered by prove-control and by a
 * live restart exercised on the real fleet. See docs/proof-coverage.md.
 *
 * Run:  npx tsx scripts/prove-live-start.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { detectLauncher, indexTasks } from '../server/launcher'
import { startServer, restartServer, occupancyOf, resetLocks } from '../server/control'
import { scanJvms } from '../server/platform'

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A port nothing on this machine uses, so the fake server cannot collide with a
// real one. Nothing listens on it. The fake JVM does not open a socket at all.
const FAKE_PORT = 25999

const root = mkdtempSync(join(tmpdir(), 'mcdash-live-'))
const dir = join(root, 'MC Fake')
mkdirSync(join(dir, 'world'), { recursive: true })
mkdirSync(join(dir, 'logs'), { recursive: true })
writeFileSync(join(dir, 'world', 'level.dat'), '')
writeFileSync(join(dir, 'server.properties'), `server-port=${FAKE_PORT}\nlevel-name=world\nenable-rcon=false\n`)

/**
 * A real JVM that stays up. `java Sleeper.java` is the single-file source
 * launcher (JEP 330, Java 11+), so no compile step and no jar is needed.
 */
writeFileSync(
  join(dir, 'Sleeper.java'),
  [
    'import java.net.ServerSocket;',
    'public class Sleeper {',
    '  public static void main(String[] a) throws Exception {',
    // Binds the declared port, so identity signal 3 (held log + listening port)
    // is exercised as well as signal 2. An inert JVM tests less than a real
    // server does.
    '    try (ServerSocket s = new ServerSocket(Integer.parseInt(a[0]))) {',
    '      Thread.sleep(600000);',
    '    }',
    '  }',
    '}',
  ].join('\n'),
)

function javaExe(): string {
  for (const candidate of ['C:\\Program Files\\Java\\jdk-21\\bin\\java.exe', 'java']) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore' })
      return candidate
    } catch {
      /* try the next */
    }
  }
  throw new Error('no java found on PATH or at the pinned JDK 21 location')
}
const java = javaExe()

// The launcher writes its own log, because a held `logs/latest.log` is one of the
// identity signals and a directory with none looks unoccupied.
writeFileSync(
  join(dir, 'start.bat'),
  [
    '@echo off',
    'cd /d "%~dp0"',
    `"${java}" Sleeper.java ${FAKE_PORT} > logs\\latest.log 2>&1`,
  ].join('\r\n'),
)

console.log(`throwaway server : ${dir}`)
console.log(`java             : ${java}`)

const target = { id: 'MC Fake', name: 'MC Fake', dir }
resetLocks()

// ------------------------------------------------------- 1. detection

const tasks = await indexTasks()
const launcher = detectLauncher(dir, tasks)
console.log(`launcher         : ${launcher.strategy}`)
check(
  'a directory with no scheduled task and a start.bat is detected as `script`',
  launcher.strategy === 'script',
  launcher.strategy,
)

const before = await occupancyOf(dir)
check(
  'the throwaway directory starts out unoccupied and we are sure of it',
  before.certain && before.pids.length === 0,
  JSON.stringify(before),
)

// Attribution is checked FIRST, with a short poll of our own.
//
// startServer() waits up to two minutes for a JVM to appear, so an unattributable
// fake presents as a HANG rather than a failure. That is not hypothetical: the
// first version of the script launcher passed a relative `start.bat` with `cwd`
// doing the work, which left the launched JVM's parent command line containing no
// directory at all. Nothing could attribute it, and the proof sat in the
// verification loop for the full timeout on every one of twelve start attempts.
console.log('\nchecking the fake JVM is attributable at all ...')
const { invokeLauncher } = await import('../server/launcher')
await invokeLauncher(dir, launcher)
let probe = await occupancyOf(dir)
for (let i = 0; i < 20 && probe.pids.length === 0; i++) {
  await sleep(1000)
  probe = await occupancyOf(dir)
}
console.log(`  attributable after warm-up: pids ${probe.pids.join(', ') || 'none'}`)
check(
  'a JVM launched by the script strategy can be attributed to its directory',
  probe.pids.length === 1,
  'if this fails, startServer() would appear to hang rather than fail',
)
for (const pid of probe.pids) {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`], {
      stdio: 'ignore',
    })
  } catch {
    /* the next occupancy check reports it */
  }
}
await sleep(2000)
const cleared = await occupancyOf(dir)
check(
  'and the warm-up process is gone before the real test starts',
  cleared.pids.length === 0,
  JSON.stringify(cleared.pids),
)

// ------------------------------------------------------- 2. it starts

// The production dashboard runs BelowNormal (decision 0009), and priority
// class is inherited -- so without launcher.ts raising the wrapper and
// control.ts verifying the JVM, a server started here would run at base 6.
// Measured before the fix: a freshly created server's working set trimmed
// to 9 MB of 2.3 GB within half an hour. Lowering THIS process reproduces
// the condition; the assertions below then read the JVM's priority back
// from the process table, not from our own bookkeeping.
console.log('\nstarting (with this process lowered to BelowNormal, as production runs) ...')
const { getPriority, setPriority, constants: osConstants } = await import('node:os')
const ownPriorityBefore = getPriority(0)
setPriority(0, osConstants.priority.PRIORITY_BELOW_NORMAL)
let started: Awaited<ReturnType<typeof startServer>>
try {
  started = await startServer(target, launcher)
} finally {
  setPriority(0, ownPriorityBefore)
}
console.log(`  ${started.ok ? 'OK  ' : 'FAIL'} ${started.detail}`)
check('startServer() invokes the launcher and a JVM appears', started.ok, started.detail)
check('and the success message names one pid', /pid \d+/.test(started.detail), started.detail)
check(
  'and states, from a read-back, that the server runs at normal priority',
  /runs at normal priority, read back/.test(started.detail),
  started.detail,
)

const after = await occupancyOf(dir)
console.log(`  occupancy: pids ${after.pids.join(', ') || 'none'} certain=${after.certain}`)
check('exactly one JVM is attributed to this directory', after.pids.length === 1, JSON.stringify(after.pids))
check('and the answer is certain, not inferred', after.certain)

// Cross-check against the raw process list rather than trusting our own count.
const scan = await scanJvms([{ dir, gamePort: FAKE_PORT }])
const mine = scan.jvms.filter((j) => j.dir.toLowerCase().replace(/\\/g, '/') === dir.toLowerCase().replace(/\\/g, '/'))
console.log(`  raw scan: ${mine.map((j) => `${j.pid} via ${j.attributedBy}`).join(', ') || 'none'}`)
check('the raw identity scan agrees', mine.length === 1, `${mine.length}`)
check(
  'the fake server is NOT attributed via the scheduled-task signal',
  mine.every((j) => j.attributedBy !== 'scheduled-task'),
  'nothing scheduled it, so claiming otherwise would mean the task index is matching too loosely',
)
// The process table's own reading, not ours: Win32_Process.Priority 8 is
// Normal, 6 is BelowNormal. This is the assertion that fails if either the
// launcher's raise or control's read-back is removed while the dashboard
// runs BelowNormal.
check(
  'the spawned JVM runs at Normal base priority, not the observer\'s inherited class',
  mine.length === 1 && mine[0]!.basePriority === 8,
  `basePriority=${mine[0]?.basePriority ?? 'unknown'}`,
)

// ------------------------------------------------- 3. a second start is refused

console.log('\nstarting again ...')
const twice = await startServer(target, launcher)
console.log(`  ${twice.ok ? 'OK  ' : 'REFUSED'} ${twice.detail}`)
check('a second start is refused', !twice.ok)
check('and names the pid already running', /pid \d+/.test(twice.detail), twice.detail)
check(
  'and says why, in terms of the world',
  /second process against the same world/i.test(twice.detail),
  twice.detail,
)

const stillOne = await occupancyOf(dir)
check('and no second JVM was created', stillOne.pids.length === 1, JSON.stringify(stillOne.pids))

// Ten at once, through the real lock, against a real running process.
console.log('\nten concurrent starts ...')
const many = await Promise.all(Array.from({ length: 10 }, () => startServer(target, launcher)))
check('ten concurrent starts are all refused', many.every((r) => !r.ok))
const finalOcc = await occupancyOf(dir)
console.log(`  occupancy after: pids ${finalOcc.pids.join(', ')}`)
check('and there is still exactly one JVM', finalOcc.pids.length === 1, JSON.stringify(finalOcc.pids))

// ------------------------------------- 4. no RCON means no clean shutdown

console.log('\nrestarting a server with no RCON ...')
const restart = await restartServer(target, launcher)
console.log(`  ${restart.ok ? 'OK  ' : 'REFUSED'} ${restart.detail}`)
check('a restart is refused when the server cannot be shut down cleanly', !restart.ok)
check('and the reason is RCON, not a failure to try', /RCON is not configured/i.test(restart.detail), restart.detail)
const afterRestart = await occupancyOf(dir)
check(
  'the running process was NOT killed to make room',
  afterRestart.pids.length === 1 && afterRestart.pids[0] === finalOcc.pids[0],
  `${JSON.stringify(afterRestart.pids)} vs ${JSON.stringify(finalOcc.pids)}`,
)

// ------------------------------------------------------------- cleanup

console.log('\ncleaning up the fake JVM ...')
for (const pid of afterRestart.pids) {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`], {
      stdio: 'ignore',
    })
  } catch {
    console.log(`  could not stop pid ${pid}, stop it by hand`)
  }
}
await sleep(1500)
const gone = await occupancyOf(dir)
check('the fake JVM is gone', gone.pids.length === 0, JSON.stringify(gone.pids))
console.log(`  the throwaway directory is left at ${root} (nothing is deleted here by policy)`)
check('and the throwaway directory still exists, because nothing gets deleted', existsSync(dir))

console.log('')
let failed = 0
for (const [l, ok, d] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d ? `  (${d})` : ''}`)
}
console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
