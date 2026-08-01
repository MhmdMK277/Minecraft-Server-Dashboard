/**
 * PROOF: the Overview sparklines cannot draw a reading nobody took.
 *
 * A graph is the most confident thing on a page. A flat line at 0% reads as
 * "this server is idle" whether that is what was measured or whether nothing
 * was measured at all, and those are opposite facts about a server. This
 * suite exists because that confusion is a misreport, which puts these graphs
 * under the proof rule rather than the cosmetic one.
 *
 * The rules under test, each mapped to the way it goes wrong in the field:
 *
 *   1. CPU is a DIFFERENCE of a cumulative counter over measured wall clock,
 *      not the counter itself and not a division by an assumed interval.
 *   2. A pid change voids the sample. A restarted server resets its counter,
 *      and differencing across that yields a negative that would otherwise be
 *      absolved into a plausible-looking number.
 *   3. Elapsed time is measured. The scan loop is delayed by exactly the host
 *      contention this dashboard detects, so dividing by a nominal ten
 *      seconds would inflate CPU precisely when someone is looking at it.
 *   4. Not measured is null and null is a gap. Never zero, which is a
 *      measurement, and never the previous value carried forward.
 *   5. Time is not compressed. A down server still gets a sample, so an
 *      outage is a gap in the line rather than an invisible seam.
 *   6. The ring is bounded, by age and by a hard cap.
 *   7. History does not survive a restart, and the reading says when it
 *      started collecting so a short graph cannot be mistaken for a quiet
 *      server.
 *
 * WORLD: no Minecraft server and no process table. Every sample here is
 * synthetic and the clock is passed in, which is the point: this proves the
 * arithmetic and the honesty rules, not the platform layer. What the platform
 * actually reports is prove-identity's job.
 *
 * Run:  npx tsx scripts/prove-history.ts
 */
import {
  observe,
  historyFor,
  resetHistory,
  forgetAllExcept,
  coreCount,
  WINDOW_MINUTES,
} from '../server/history'

const checks: Array<[string, boolean, string?]> = []
const check = (label: string, ok: boolean, detail?: string) => checks.push([label, ok, detail])

const DIR = 'C:\\Servers\\Proof Server'
const OTHER = 'C:\\Servers\\Other Server'
const T0 = Date.parse('2026-08-01T04:00:00.000Z')
const SEC = 1000

const read = () => historyFor(DIR, 10)
const samples = () => read().samples

// ===========================================================================
console.log('\n=== 1. CPU is a rate derived from a counter ===\n')
// ===========================================================================
{
  resetHistory()

  // First reading of a process: nothing to difference against yet.
  observe({ dir: DIR, pid: 100, cpuMs: 5_000, ramMb: 900, tps: 20, at: T0 })
  check(
    'the first sample of a process has no CPU figure, because a rate needs two readings',
    samples()[0]?.cpuPercentOfCore === null,
    String(samples()[0]?.cpuPercentOfCore),
  )
  check('but its other readings are recorded', samples()[0]?.ramMb === 900 && samples()[0]?.tps === 20)

  // 1000 ms of CPU over 10 000 ms of wall clock is 10% of one core.
  observe({ dir: DIR, pid: 100, cpuMs: 6_000, ramMb: 910, tps: 19.8, at: T0 + 10 * SEC })
  check(
    '1000 ms of CPU in 10 s reads as 10% of one core',
    samples()[1]?.cpuPercentOfCore === 10,
    String(samples()[1]?.cpuPercentOfCore),
  )

  // A multi-threaded server can exceed one core, and that must not be clamped
  // to 100: "pegged" and "using three cores" are different problems.
  observe({ dir: DIR, pid: 100, cpuMs: 6_000 + 25_000, ramMb: 920, tps: 19, at: T0 + 20 * SEC })
  check(
    'a multi-threaded server reads above 100% rather than being clamped',
    samples()[2]?.cpuPercentOfCore === 250,
    String(samples()[2]?.cpuPercentOfCore),
  )

  // The counter is cumulative: a scan where it does not move is 0% CPU, and
  // that IS a measurement, unlike a null.
  observe({ dir: DIR, pid: 100, cpuMs: 31_000, ramMb: 920, tps: 20, at: T0 + 30 * SEC })
  check('an unchanged counter is a measured 0%, not a gap', samples()[3]?.cpuPercentOfCore === 0)
}

// ===========================================================================
console.log('=== 2. a restarted server does not get a line drawn across it ===\n')
// ===========================================================================
{
  resetHistory()
  observe({ dir: DIR, pid: 100, cpuMs: 900_000, ramMb: 900, tps: 20, at: T0 })
  observe({ dir: DIR, pid: 100, cpuMs: 901_000, ramMb: 900, tps: 20, at: T0 + 10 * SEC })
  check('a running server is reporting CPU before the restart', samples()[1]?.cpuPercentOfCore === 10)

  // The server dies. Nothing owns the directory for a scan.
  observe({ dir: DIR, pid: null, cpuMs: null, ramMb: null, tps: null, at: T0 + 20 * SEC })
  const down = samples()[2]!
  check('the scan with nothing running is still recorded', samples().length === 3)
  check(
    'and every one of its readings is null, not zero',
    down.cpuPercentOfCore === null && down.ramMb === null && down.tps === null,
    JSON.stringify(down),
  )

  // It comes back as a new pid with a counter that restarted near zero.
  observe({ dir: DIR, pid: 777, cpuMs: 400, ramMb: 300, tps: null, at: T0 + 30 * SEC })
  check(
    'THE ONE THAT MATTERS: the first sample of the new pid has no CPU figure',
    samples()[3]?.cpuPercentOfCore === null,
    String(samples()[3]?.cpuPercentOfCore),
  )
  check(
    'and it is not a negative number dressed up as a positive one',
    samples()[3]?.cpuPercentOfCore === null || samples()[3]!.cpuPercentOfCore! >= 0,
  )

  observe({ dir: DIR, pid: 777, cpuMs: 1_400, ramMb: 320, tps: 5, at: T0 + 40 * SEC })
  check('the new process starts reporting normally on its second reading', samples()[4]?.cpuPercentOfCore === 10)
}

// A pid change with NO down scan between them, which is what a fast restart
// looks like to a ten-second loop.
{
  resetHistory()
  observe({ dir: DIR, pid: 100, cpuMs: 900_000, ramMb: 900, tps: 20, at: T0 })
  observe({ dir: DIR, pid: 250, cpuMs: 800, ramMb: 100, tps: null, at: T0 + 10 * SEC })
  check(
    'a pid change with no gap between scans still voids the CPU sample',
    samples()[1]?.cpuPercentOfCore === null,
    String(samples()[1]?.cpuPercentOfCore),
  )
}

// ===========================================================================
console.log('=== 3. elapsed time is measured, not assumed ===\n')
// ===========================================================================
{
  resetHistory()
  observe({ dir: DIR, pid: 100, cpuMs: 0, ramMb: 900, tps: 20, at: T0 })
  // The loop was blocked and this scan landed 40 s later, not 10 s later.
  // Dividing 4000 ms of CPU by a nominal 10 s would report 40%; the honest
  // figure over the real 40 s is 10%.
  observe({ dir: DIR, pid: 100, cpuMs: 4_000, ramMb: 900, tps: 20, at: T0 + 40 * SEC })
  check(
    'a late scan reports CPU over the time that actually passed',
    samples()[1]?.cpuPercentOfCore === 10,
    `${samples()[1]?.cpuPercentOfCore}, would be 40 if the interval were assumed`,
  )

  // Two samples at the same instant cannot produce a rate.
  observe({ dir: DIR, pid: 100, cpuMs: 4_500, ramMb: 900, tps: 20, at: T0 + 40 * SEC })
  check('two readings at the same instant produce no rate', samples()[2]?.cpuPercentOfCore === null)

  // A clock that went backwards must not produce a number either.
  observe({ dir: DIR, pid: 100, cpuMs: 5_000, ramMb: 900, tps: 20, at: T0 + 30 * SEC })
  check('a clock that moved backwards produces no rate', samples()[3]?.cpuPercentOfCore === null)
}

// A counter that goes backwards without the pid changing is a broken reading,
// not a negative CPU.
{
  resetHistory()
  observe({ dir: DIR, pid: 100, cpuMs: 50_000, ramMb: 900, tps: 20, at: T0 })
  observe({ dir: DIR, pid: 100, cpuMs: 10_000, ramMb: 900, tps: 20, at: T0 + 10 * SEC })
  check('a counter that went backwards produces no figure', samples()[1]?.cpuPercentOfCore === null)
}

// An impossible reading is refused rather than drawn as a spike.
{
  resetHistory()
  observe({ dir: DIR, pid: 100, cpuMs: 0, ramMb: 900, tps: 20, at: T0 })
  observe({
    dir: DIR,
    pid: 100,
    cpuMs: (coreCount() * 100 + 5_000) * 10 * SEC / 100,
    ramMb: 900,
    tps: 20,
    at: T0 + 10 * SEC,
  })
  check(
    'a reading above every core at once is refused, not drawn as a spike',
    samples()[1]?.cpuPercentOfCore === null,
    String(samples()[1]?.cpuPercentOfCore),
  )
}

// ===========================================================================
console.log('=== 4. a missing reading is a gap, never a carried-forward value ===\n')
// ===========================================================================
{
  resetHistory()
  observe({ dir: DIR, pid: 100, cpuMs: 0, ramMb: 900, tps: 20, at: T0 })
  observe({ dir: DIR, pid: 100, cpuMs: 1_000, ramMb: 950, tps: 19.5, at: T0 + 10 * SEC })
  // A server with no RCON: memory readable, TPS not.
  observe({ dir: DIR, pid: 100, cpuMs: 2_000, ramMb: 960, tps: null, at: T0 + 20 * SEC })
  const s = samples()
  check('a server without a TPS reading has a null there', s[2]?.tps === null)
  check('and the previous TPS is NOT carried forward', s[2]?.tps !== 19.5)
  check('while the readings that were taken are unaffected', s[2]?.ramMb === 960 && s[2]?.cpuPercentOfCore === 10)

  // Memory unreadable but the process is alive.
  observe({ dir: DIR, pid: 100, cpuMs: 3_000, ramMb: null, tps: 20, at: T0 + 30 * SEC })
  check('an unreadable memory figure is null, not the last known value', samples()[3]?.ramMb === null)
}

// ===========================================================================
console.log('=== 5. time is not compressed ===\n')
// ===========================================================================
{
  resetHistory()
  // Ten scans, of which the middle four are a total outage.
  for (let i = 0; i < 10; i++) {
    const down = i >= 3 && i < 7
    observe({
      dir: DIR,
      pid: down ? null : 100,
      cpuMs: down ? null : 1_000 * i,
      ramMb: down ? null : 900,
      tps: down ? null : 20,
      at: T0 + i * 10 * SEC,
    })
  }
  const s = samples()
  check('every scan produced a sample, including the outage', s.length === 10, String(s.length))
  check('the outage is four consecutive gaps', s.slice(3, 7).every((x) => x.ramMb === null))
  check(
    'the timestamps stay one scan interval apart across the outage',
    Date.parse(s[7]!.at) - Date.parse(s[2]!.at) === 50 * SEC,
  )
  check(
    'the sample after the outage has no CPU figure, because the counter was lost',
    s[7]?.cpuPercentOfCore === null,
    String(s[7]?.cpuPercentOfCore),
  )
}

// ===========================================================================
console.log('=== 6. the ring is bounded ===\n')
// ===========================================================================
{
  resetHistory()
  // Two hours of samples at the nominal interval, into a one-hour window.
  const n = (WINDOW_MINUTES * 60 * 2) / 10
  for (let i = 0; i < n; i++) {
    observe({ dir: DIR, pid: 100, cpuMs: 1_000 * i, ramMb: 900, tps: 20, at: T0 + i * 10 * SEC })
  }
  const s = samples()
  const spanMs = Date.parse(s[s.length - 1]!.at) - Date.parse(s[0]!.at)
  check('two hours of samples do not accumulate', s.length < n, `${s.length} of ${n}`)
  check(
    `what is kept spans no more than the ${WINDOW_MINUTES} minute window`,
    spanMs <= WINDOW_MINUTES * 60_000,
    `${Math.round(spanMs / 60_000)} min`,
  )
  check('and the newest sample is still the last one written', s[s.length - 1]!.ramMb === 900)

  // A pathologically fast loop must not grow it without bound either.
  resetHistory()
  for (let i = 0; i < 5_000; i++) {
    observe({ dir: DIR, pid: 100, cpuMs: i, ramMb: 1, tps: 1, at: T0 + i })
  }
  check('a fast loop is capped as well as aged out', samples().length <= 1_000, String(samples().length))
}

// Directories that go away stop consuming memory.
{
  resetHistory()
  observe({ dir: DIR, pid: 100, cpuMs: 0, ramMb: 900, tps: 20, at: T0 })
  observe({ dir: OTHER, pid: 200, cpuMs: 0, ramMb: 500, tps: 20, at: T0 })
  check('both servers are held', samples().length === 1 && historyFor(OTHER, 10).samples.length === 1)
  forgetAllExcept([DIR])
  check('a directory that is gone is dropped', historyFor(OTHER, 10).samples.length === 0)
  check('and the one still there is untouched', samples().length === 1)
}

// The key is the directory, normalised the same way everywhere else does it.
{
  resetHistory()
  observe({ dir: 'C:\\Servers\\Proof Server', pid: 100, cpuMs: 0, ramMb: 900, tps: 20, at: T0 })
  observe({ dir: 'c:\\servers\\proof server\\', pid: 100, cpuMs: 1_000, ramMb: 900, tps: 20, at: T0 + 10 * SEC })
  check(
    'the same directory spelled differently is one series, not two',
    samples().length === 2 && samples()[1]?.cpuPercentOfCore === 10,
    String(samples().length),
  )
}

// ===========================================================================
console.log('=== 7. the reading says what it is ===\n')
// ===========================================================================
{
  resetHistory()
  observe({ dir: DIR, pid: 100, cpuMs: 0, ramMb: 900, tps: 20, at: T0 })
  const h = read()
  check('the window is stated', h.windowMinutes === WINDOW_MINUTES)
  check('the sampling interval is stated', h.intervalSeconds === 10)
  check('the core count is stated, so a CPU percentage has a denominator', h.cores === coreCount() && h.cores >= 1)
  check('and when collecting started is stated', typeof h.collectingSince === 'string' && !Number.isNaN(Date.parse(h.collectingSince)))

  // The ring is memory only. A restart is a fresh start and must present as
  // one, or a two-minute graph reads as a server that has been quiet.
  // Asserted as "the mark is when collecting started", not as "the string
  // changed". Two resets inside one millisecond produce the same ISO string,
  // which is a fact about the test's clock and not about the code; comparing
  // strings would make this pass or fail on how fast the machine is.
  const resetAt = Date.now()
  resetHistory()
  const after = historyFor(DIR, 10)
  check('a restart empties the ring', after.samples.length === 0)
  check(
    'and the collecting-since mark is the moment collecting restarted, so the UI can say why the graph is short',
    Date.parse(after.collectingSince) >= resetAt && Date.parse(after.collectingSince) <= Date.now(),
    `${after.collectingSince} vs ${new Date(resetAt).toISOString()}`,
  )

  // A server nobody has ever sampled reads as empty, not as an error.
  check('an unknown directory reads as an empty series', historyFor('C:\\nope', 10).samples.length === 0)
}

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${'='.repeat(64)}`)
for (const [label, ok, detail] of failed) console.log(`FAIL  ${label}${detail ? `  [${detail}]` : ''}`)
console.log(failed.length === 0 ? `ALL PASS. ${checks.length} checks` : `\n${failed.length} FAILED of ${checks.length}`)
process.exit(failed.length === 0 ? 0 : 1)
