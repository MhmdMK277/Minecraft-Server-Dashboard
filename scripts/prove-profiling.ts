/**
 * PROOF: the profiling reading reports what the JVM wrote, agrees with the
 * independent Python implementation, and never renders an empty table as a
 * healthy server.
 *
 * The harm is misreporting: a pause attributed to the JVM when the host
 * withheld the threads sends the operator tuning a collector while the
 * machine pages, which is the exact week the stall investigation spent. So:
 *
 *   1. Both JDK field layouts parse (21: Cleanup; 25: Leaving safepoint +
 *      Threads), asserted on verbatim-shaped lines, and the attribution rule
 *      matches gc-report.py's: whichever side got more of the stopped time
 *      owns the pause.
 *   2. The TS port is CROSS-VALIDATED against scripts/gc-report.py over the
 *      same bytes (fixtures/gc-sample.log through a temp root): same n, same
 *      over-threshold count, same worst, same host/jvm split.
 *   3. Safepoint-looking lines that parse to nothing are `parser-mismatch`,
 *      never an empty healthy table.
 *   4. Pauses older than the running process are excluded from the headline
 *      figures and said out loud (the F9 lesson).
 *
 * Run:  npx tsx scripts/prove-profiling.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSafepointLine, parseSafepoints, profileSafepoints } from '../server/profiling'

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])

// --------------------------------------------------- 1. both field layouts

console.log('--- 1. both JDK field layouts, one attribution rule')

const JDK21 =
  '[2026-08-02T10:00:00.123+0200][123.456s][info][safepoint      ] Safepoint "G1CollectForAllocation", Time since last: 1000000 ns, Reaching safepoint: 500000 ns, Cleanup: 100000 ns, At safepoint: 300000000 ns, Total: 300600000 ns'
const JDK25 =
  '[2026-08-02T10:00:01.123+0200][124.456s][info][safepoint      ] Safepoint "ThreadDump", Time since last: 1000000 ns, Reaching safepoint: 400000000 ns, Leaving safepoint: 200000 ns, At safepoint: 1000000 ns, Threads: 53, Total: 401200000 ns'

const a = parseSafepointLine(JDK21)
check('the JDK 21 layout (Cleanup) parses', a !== null, JSON.stringify(a))
check('with Total as the pause', a !== null && Math.abs(a.totalMs - 300.6) < 0.001)
check(
  'and Cleanup counted on the JVM side',
  a !== null && Math.abs(a.atSpMs - 300.1) < 0.001,
  String(a?.atSpMs),
)
const b = parseSafepointLine(JDK25)
check('the JDK 25 layout (Leaving safepoint, Threads) parses', b !== null, JSON.stringify(b))
check('the ns-free Threads field does not corrupt the numbers', b !== null && Math.abs(b.totalMs - 401.2) < 0.001)
check('reaching is carried separately', b !== null && Math.abs(b.reachMs - 400) < 0.001)

// The attribution rule, on the two sides of the same line length.
check('a pause that mostly WORKED is attributed to the JVM', a !== null && !(a.reachMs > a.atSpMs))
check('a pause that mostly WAITED is attributed to the host', b !== null && b.reachMs > b.atSpMs)

check('a non-safepoint line parses to null, not to zeroes', parseSafepointLine('[2026-08-02T10:00:00.123+0200][info][gc] GC(1) Pause Young 1M->1M(2M) 1.0ms') === null)
check(
  'a safepoint line with no Total is refused rather than invented',
  parseSafepointLine('[2026-08-02T10:00:00.123+0200][info][safepoint ] Safepoint "Cleanup", Reaching safepoint: 100 ns') === null,
)

// ------------------------------------- 2. cross-validation with gc-report.py

console.log('--- 2. the TS port and gc-report.py agree over the same bytes')

const ROOT = mkdtempSync(join(tmpdir(), 'mcdash-profiling-'))
const SDIR = join(ROOT, 'S1')
mkdirSync(join(SDIR, 'logs'), { recursive: true })
copyFileSync(join(import.meta.dirname, '..', 'fixtures', 'gc-sample.log'), join(SDIR, 'logs', 'gc.log'))

const THRESH = 3 // ms: low, so the small fixture yields a real over-list

const ts = profileSafepoints(SDIR, { thresholdMs: THRESH })
check('the fixture reads as state read', ts.state === 'read', ts.detail)
check('every candidate line parsed', ts.candidates === ts.parsed && ts.candidates > 0, `${ts.parsed}/${ts.candidates}`)

let py = ''
try {
  py = execFileSync(
    'python',
    [join(import.meta.dirname, 'gc-report.py'), '--root', ROOT, '--threshold', String(THRESH)],
    { encoding: 'utf8' },
  )
} catch (e) {
  py = e instanceof Error && 'stdout' in e ? String((e as { stdout: unknown }).stdout ?? '') : ''
}

const nMatch = /\(\s*[\d.]+h\)\s+(\d+)\s/.exec(py)
const fleetMatch = /FLEET worst ([\d.]+) ms \| over \d+ ms: (\d+)/.exec(py)
const pyHost = (py.match(/HOST \(could not reach safepoint\)/g) ?? []).length
const pyJvm = (py.match(/JVM \(work at safepoint\)/g) ?? []).length

check('gc-report.py ran over the same temp root', py.includes('PARSE COVERAGE'), py.slice(0, 200))
check(
  'both implementations count the same safepoints',
  nMatch !== null && Number(nMatch[1]) === ts.n,
  `python ${nMatch?.[1]}, ts ${ts.n}`,
)
check(
  'both find the same worst pause',
  fleetMatch !== null && Math.abs(Number(fleetMatch[1]) - ts.maxMs) < 0.01,
  `python ${fleetMatch?.[1]}, ts ${ts.maxMs}`,
)
check(
  'both count the same pauses over the threshold',
  fleetMatch !== null && Number(fleetMatch[2]) === ts.overCount,
  `python ${fleetMatch?.[2]}, ts ${ts.overCount}`,
)
check(
  'both attribute the same pauses to the host',
  pyHost === ts.hostAttributedCount,
  `python ${pyHost}, ts ${ts.hostAttributedCount}`,
)
check(
  'and the same to the JVM',
  pyJvm === ts.overCount - ts.hostAttributedCount,
  `python ${pyJvm}, ts ${ts.overCount - ts.hostAttributedCount}`,
)
check('the over-list is worst first', ts.pauses.every((p, i) => i === 0 || p.totalMs <= ts.pauses[i - 1]!.totalMs))

// ------------------------------------------------- 3. the honest non-answers

console.log('--- 3. the honest non-answers')

{
  const dir = mkdtempSync(join(tmpdir(), 'mcdash-profiling-'))
  const r = profileSafepoints(dir)
  check('no gc.log is its own state with the flag named', r.state === 'no-gclog' && /-Xlog:gc\*,safepoint/.test(r.detail))
}

{
  const dir = mkdtempSync(join(tmpdir(), 'mcdash-profiling-'))
  mkdirSync(join(dir, 'logs'), { recursive: true })
  // Lines that LOOK like safepoints (a future field layout) and parse to nothing.
  writeFileSync(
    join(dir, 'logs', 'gc.log'),
    '[2099-01-01T00:00:00.000+0000][info][safepoint] Safepoint "Whatever", Halting: 5 quops, Sum: 9 quops\n'.repeat(4),
  )
  const r = profileSafepoints(dir)
  check(
    'safepoint-looking lines that parse to nothing are parser-mismatch, not a clean table',
    r.state === 'parser-mismatch' && r.candidates === 4,
    `${r.state} ${r.candidates}`,
  )
  check('and the sentence says report it', /parser gap/.test(r.detail))
}

{
  // The F9 boundary: two pauses before a restart, one after.
  const dir = mkdtempSync(join(tmpdir(), 'mcdash-profiling-'))
  mkdirSync(join(dir, 'logs'), { recursive: true })
  const line = (iso: string, totalNs: number) =>
    `[${iso}][info][safepoint      ] Safepoint "G1CollectForAllocation", Time since last: 1 ns, Reaching safepoint: 1000 ns, Cleanup: 0 ns, At safepoint: ${totalNs - 1000} ns, Total: ${totalNs} ns`
  writeFileSync(
    join(dir, 'logs', 'gc.log'),
    [
      line('2026-08-02T04:00:00.000+0200', 900_000_000),
      line('2026-08-02T04:30:00.000+0200', 800_000_000),
      line('2026-08-02T06:00:00.000+0200', 50_000_000),
      '',
    ].join('\n'),
  )
  const processStartMs = Date.parse('2026-08-02T05:00:00.000+0200')
  const r = profileSafepoints(dir, { thresholdMs: 40, processStartMs })
  check('pauses from the replaced process are excluded from the figures', r.n === 1 && r.maxMs === 50)
  check('and the exclusion is said out loud', r.previousProcessNote !== null && /2 safepoints/.test(r.previousProcessNote ?? ''))
  check('the over-list holds only the current process', r.pauses.length === 1 && r.pauses[0]!.totalMs === 50)

  const whole = profileSafepoints(dir, { thresholdMs: 40 })
  check('without a known process start the file is summarised whole, silently excluding nothing', whole.n === 3 && whole.previousProcessNote === null)
}

{
  // The threshold changes the list, not the record.
  const strict = profileSafepoints(SDIR, { thresholdMs: 1 })
  const loose = profileSafepoints(SDIR, { thresholdMs: 10_000 })
  check('a lower threshold grows the over-list from the same record', strict.overCount >= ts.overCount && strict.n === ts.n)
  check('an unreachable threshold empties the list but not the figures', loose.overCount === 0 && loose.n === ts.n && loose.maxMs === ts.maxMs)
}

console.log(`\n(throwaway fixtures left under ${ROOT} and siblings; nothing is deleted)`)
console.log('')
let failed = 0
for (const [l, ok, d] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d ? `  (${d})` : ''}`)
}
console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
