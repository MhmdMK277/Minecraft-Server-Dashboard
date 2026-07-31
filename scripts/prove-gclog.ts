/**
 * PROOF: the GC log parser reads what a real JVM actually writes.
 *
 * `fixtures/gc-sample.log` was produced by a real JDK 21 HotSpot run with the
 * exact flag now on all four servers -- `-Xlog:gc*,safepoint:file=logs/gc.log:
 * time,uptime,level,tags:filecount=5,filesize=10M` -- driven by an allocation
 * loop so that it contains genuine pauses, including a forced Full GC. It is
 * not a hand-written approximation of the format, because a hand-written format
 * proves only that the author and the parser agree.
 *
 * What this has to get right, and why each one bites:
 *
 *   - A GC appears TWICE when both gc* and safepoint are logged, once per tag.
 *     Counting both doubles every pause figure on the dashboard.
 *   - `Reaching safepoint` is not the pause. Only `At safepoint` is the time
 *     the world was actually stopped.
 *   - A safepoint whose operation is not a collector operation is a
 *     stop-the-world that is NOT garbage collection. That is the one line of
 *     evidence that can refute the GC hypothesis, so it must not be quietly
 *     folded in with the rest.
 *   - Reading starts mid-file, at a byte offset, so the first line is usually a
 *     fragment and must be discarded rather than half-parsed.
 *
 * Run:  npx tsx scripts/prove-gclog.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseGcLog,
  summarise,
  gcSummary,
  PAUSE_SEVERE_MS,
  PAUSE_NOTICEABLE_MS,
  GC_WINDOW_MINUTES,
  resetGcCache,
} from '../server/gclog'

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])

const SAMPLE = join(import.meta.dirname, '..', 'fixtures', 'gc-sample.log')
const text = readFileSync(SAMPLE, 'utf8')

// The sample is from 2026-07-29; parse relative to its own timestamps rather
// than to now, or the window would discard all of it.
const stamps = [...text.matchAll(/^\[([\d\-T:.+]+)\]/gm)].map((m) => Date.parse(m[1]!))
const logEnd = Math.max(...stamps)
const pauses = parseGcLog(text, logEnd)

console.log(`sample: ${stamps.length} timestamped lines, ${pauses.length} pauses parsed\n`)
for (const p of pauses.slice(0, 6)) {
  console.log(
    `  ${new Date(p.at).toISOString().slice(11, 23)}  ${p.ms.toFixed(2).padStart(8)} ms  ${p.isGc ? 'gc ' : 'NOT-GC'}  ${p.kind}`,
  )
}

check('pauses are found in a real JVM log', pauses.length > 0, `got ${pauses.length}`)
check('every pause has a parseable timestamp', pauses.every((p) => Number.isFinite(p.at)))
check('every pause has a positive duration', pauses.every((p) => p.ms > 0))
check('durations are plausible, not nanoseconds mistaken for ms', pauses.every((p) => p.ms < 60_000))

// Deduplication: the sample logs both a `gc` line and a `safepoint` line for
// each collection. The raw line counts prove the parser is not just summing.
const gcLines = (text.match(/\]\s+GC\(\d+\) Pause .*ms\s*$/gm) ?? []).length
const spLines = (text.match(/Safepoint "/g) ?? []).length
console.log(`\n  raw gc pause lines ${gcLines}, raw safepoint lines ${spLines}, deduplicated ${pauses.length}`)
check(
  'a collection logged under both tags is counted once, not twice',
  pauses.length < gcLines + spLines,
  `${pauses.length} vs ${gcLines}+${spLines}`,
)
// The first version merged both streams and de-duplicated on a 10 ms timestamp
// bucket, which silently dropped collections landing 2 ms apart under churn --
// it reported 9 of 11. Preferring the safepoint stream whole cannot under-count.
check(
  'and no pause is dropped: every recorded safepoint survives',
  pauses.length === spLines,
  `${pauses.length} vs ${spLines} safepoint lines`,
)
check(
  'the safepoint stream is preferred over the gc stream',
  pauses.every((p) => /^[A-Z]/.test(p.kind) && !p.kind.startsWith('Pause ')),
)

// `Reaching safepoint` is a small number on the same line as a big one. If the
// parser grabbed it, every pause would be microseconds.
const reaching = [...text.matchAll(/Reaching safepoint:\s*(\d+)\s*ns/g)].map((m) => Number(m[1]) / 1e6)
const atSafepoint = [...text.matchAll(/At safepoint:\s*(\d+)\s*ns/g)].map((m) => Number(m[1]) / 1e6)
console.log(`  worst 'reaching safepoint' ${Math.max(...reaching).toFixed(3)} ms, worst 'at safepoint' ${Math.max(...atSafepoint).toFixed(2)} ms`)
check(
  'the pause is taken from "At safepoint", not "Reaching safepoint"',
  Math.max(...pauses.map((p) => p.ms)) > Math.max(...reaching) * 10,
)

// ---------------------------------------------------------------- severity

const summary = summarise(pauses, logEnd)
console.log(`\n  summary: ${summary.count} pauses, worst ${summary.maxMs} ms, stopped ${summary.stoppedPercent}% of the window`)
console.log(`  ${summary.detail}`)

check('the summary counts what the parser found', summary.count === pauses.length)
check('the worst pause is the maximum, not the last', summary.maxMs === Math.round(Math.max(...pauses.map((p) => p.ms))))
check('a window with no long pause is not called severe', summary.severity !== 'severe' || summary.maxMs >= PAUSE_SEVERE_MS)

// Severity thresholds, asserted directly rather than hoped for.
const at = (ms: number) => summarise([{ at: Date.now(), kind: 'G1CollectForAllocation', ms, isGc: true }])
check('a 50 ms pause is ok', at(50).severity === 'ok')
check(`a ${PAUSE_NOTICEABLE_MS} ms pause is noticeable`, at(PAUSE_NOTICEABLE_MS).severity === 'noticeable')
check('a 999 ms pause is still only noticeable', at(999).severity === 'noticeable')
check(`a ${PAUSE_SEVERE_MS} ms pause is severe`, at(PAUSE_SEVERE_MS).severity === 'severe')
check('the 1,649 ms pause measured on this host is severe', at(1649).severity === 'severe')
check(
  'a severe pause is described in ticks the world did not advance',
  /ticks the world did not advance/.test(at(1649).detail),
)
check(
  'and says plainly that the server is not healthy between readings',
  /not healthy between the readings/.test(at(1649).detail),
)

// -------------------------------------------------- the refutation path

const mixed = summarise([
  { at: Date.now(), kind: 'G1CollectForAllocation', ms: 120, isGc: true },
  { at: Date.now() + 1, kind: 'ThreadDump', ms: 850, isGc: false },
])
console.log(`\n  mixed case: nonGcCount=${mixed.nonGcCount} nonGcMaxMs=${mixed.nonGcMaxMs}`)
check('a non-GC stop-the-world is counted separately', mixed.nonGcCount === 1 && mixed.nonGcMaxMs === 850)
check(
  'and is called out in words, because it refutes "the pauses are GC"',
  /NON-garbage-collection/.test(mixed.detail),
)
check('a collector operation is classified as GC', parseGcLog(
  '[2026-07-29T15:29:54.851+0200][0.042s][info][safepoint      ] Safepoint "G1CollectForAllocation", Time since last: 1 ns, Reaching safepoint: 1 ns, At safepoint: 5000000 ns, Total: 5000001 ns',
  Date.parse('2026-07-29T15:29:55+0200'),
)[0]?.isGc === true)
check('an unknown operation is NOT assumed to be GC', parseGcLog(
  '[2026-07-29T15:29:54.851+0200][0.042s][info][safepoint      ] Safepoint "SomethingNobodyAnticipated", Time since last: 1 ns, Reaching safepoint: 1 ns, At safepoint: 5000000 ns, Total: 5000001 ns',
  Date.parse('2026-07-29T15:29:55+0200'),
)[0]?.isGc === false)

// ------------------------------------------------------------- robustness

check('a truncated first line is discarded, not half-parsed', parseGcLog(
  'fo:04.851+0200][0.042s][info][gc  ] GC(0) Pause Full (System.gc()) 2M->0M(512M) 3.259ms\n',
  Date.now(),
).length === 0)
check('an empty log is not an error', summarise(parseGcLog('', Date.now())).count === 0)
check('an empty log does not read as a problem', summarise(parseGcLog('', Date.now())).severity === 'ok')
check(
  'pauses older than the window are excluded',
  parseGcLog(text, logEnd + (GC_WINDOW_MINUTES + 5) * 60_000).length === 0,
)
check('a garbage line does not throw', parseGcLog('not a log line at all\n\n[[[]]]\n', Date.now()).length === 0)

// ----------------------------------------------- a server without gc logging

const noLog = gcSummary(join(import.meta.dirname, '..', 'fixtures'))
check('a directory with no logs/gc.log returns null, which is not a fault', noLog === null)

// ------------------------------------------------ the window it claims to read
//
// The original reader took the last 512 KB and labelled it "the last 60
// minutes". On the Paper servers here that was 26 seconds, because spark's
// background profiler was writing 100 safepoint lines a second, so pause counts
// were wrong by roughly two orders of magnitude while the wording gave no hint
// that anything had been left unread. Every number was true of the bytes
// examined; the picture was wrong. These checks exist so it cannot recur
// silently: if the budget is exceeded, the summary has to say so and label
// itself with the span it really covered.

const full = summarise(pauses, logEnd)
check('an untruncated summary covers the whole window', full.coveredMinutes === GC_WINDOW_MINUTES)
check('and does not claim to be truncated', full.truncated === false)
check('and says "60 minutes" in words', new RegExp(`${GC_WINDOW_MINUTES} minutes`).test(full.detail))

const cut = summarise(pauses, logEnd, { coveredMinutes: 0.4, truncated: true })
console.log(`\n  truncated: ${cut.detail}`)
check('a truncated summary reports the span it actually read', cut.coveredMinutes === 0.4)
check('and flags itself as truncated', cut.truncated === true)
check('and never says "60 minutes"', !new RegExp(`last ${GC_WINDOW_MINUTES} minutes`).test(cut.detail))
check('and says plainly that the real figures are higher', /figures are higher/.test(cut.detail))
check(
  'stoppedPercent is computed over the span read, not the span wanted',
  cut.stoppedPercent > full.stoppedPercent,
  `${cut.stoppedPercent}% vs ${full.stoppedPercent}%`,
)
check(
  'the counts themselves are unchanged by the labelling',
  cut.count === full.count && cut.maxMs === full.maxMs,
)

// A live read of the real thing, if this machine has one. The fixture cannot
// prove the rotation walk, because the fixture is a single file.
const liveDir = process.env.MCDASH_GCLOG_DIR?.trim()
if (liveDir) {
  resetGcCache()
  const first = gcSummary(liveDir)
  if (!first) {
    console.log(`\n  MCDASH_GCLOG_DIR has no logs/gc.log: ${liveDir}`)
  } else {
    console.log(
      `\n  live ${liveDir}: ${first.count} pauses, covered ${first.coveredMinutes} min, truncated=${first.truncated}, worst ${first.maxMs} ms`,
    )
    check('a real log is read without throwing', first.count >= 0)
    check(
      'a real log covers the full window or admits it did not',
      first.coveredMinutes === GC_WINDOW_MINUTES || first.truncated,
    )
    // Second call goes down the incremental path; it must not lose history.
    const second = gcSummary(liveDir)
    check(
      'a second read reuses the cache without dropping pauses',
      !!second && second.count >= first.count - 2,
      `${first.count} then ${second?.count}`,
    )
  }
}

console.log('')
let failed = 0
for (const [l, ok, d] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d ? `  (${d})` : ''}`)
}
console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
