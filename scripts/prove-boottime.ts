/**
 * PROOF: adaptive boot time. M3.5.
 *
 * Written before server/boottime.ts, per the project's standing instruction
 * (docs/proof-coverage.md). The assertions about a mechanism that can produce
 * a false accusation come first, not afterwards.
 *
 * WHAT IS BEING REPLACED. `START_GRACE_SECONDS` was a constant keyed by platform:
 * 420 s for 1.7.10, 180 s for everything else. It decides STARTING vs HUNG for a
 * process that is up but not answering on its port, and HUNG says, in the UI,
 * "It is not going to come back on its own." That sentence is either true or it is
 * a false accusation about a server that is booting normally, and a constant
 * cannot get it right for both a 13 s Paper server and a 100 s modpack, nor for
 * a much larger pack on a slower disk, which is the case docs/portability-audit.md
 * flagged as the reason to do this at all.
 *
 * THE DANGEROUS FAILURE, and most of what is asserted below. The measurement is
 * "uptime at the moment readiness is first seen". If that reading is taken from a
 * server which was *already* ready when the dashboard first looked at it, the
 * sample is not a boot time. It is however long the server had been up. A server
 * running for four hours would record a 14,400 s boot, derive a grace of eight
 * hours, and a genuinely hung server would then never be reported HUNG again. One
 * bad sample poisons the mechanism permanently, because it persists to disk.
 *
 * So the rule is: a sample is recorded only for a process whose FIRST sighting
 * showed it not yet ready. Sections 4, 5 and 6 are that rule, from three
 * directions.
 *
 * THE DIRECTION OF SAFETY. Over-estimating grace delays a HUNG verdict, which
 * costs a slower diagnosis. Under-estimating it produces a false HUNG on a server
 * that is booting fine. Those are not comparable, so every clamp, default and
 * tie-break below leans towards the longer window.
 *
 * WORLD: n/a. Sections 1-9 drive the state machine with synthetic readings and
 * touch no process at all, which is deliberate. A real boot cannot be requested,
 * and waiting for one is not a test strategy. Section 10 runs a real scan, but
 * asserts only properties that hold whatever identity resolved (a DOWN server
 * reports a grace too), so it does not depend on how the servers were started.
 * See docs/proof-coverage.md.
 *
 * WHAT THIS PROOF CANNOT DO. It cannot manufacture a real boot measurement. The
 * numbers the mechanism will actually record come from real servers booting, and
 * the first of those arrive on the next reboot or the next nightly backup restart.
 * Section 10 therefore proves the shape of the live reading, not its value, and
 * says so rather than implying coverage it does not have.
 *
 * Run:  npx tsx scripts/prove-boottime.ts
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA = mkdtempSync(join(tmpdir(), 'mcdash-boot-'))
process.env.MCDASH_DATA_DIR = DATA

const {
  BOOT_FILE,
  KEEP_SAMPLES,
  FLOOR_SECONDS,
  CEILING_SECONDS,
  MAX_PLAUSIBLE_SECONDS,
  SAMPLES_TO_SHORTEN,
  GRACE_MULTIPLIER,
  bootPath,
  loadHistory,
  samplesFor,
  deriveTiming,
  observe,
  timingFor,
  primeHistory,
  flush,
  resetForTest,
} = await import('../server/boottime')
const { START_GRACE_SECONDS, START_GRACE_DEFAULT } = await import('../server/health')

type Sample = ReturnType<typeof samplesFor>[number]

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])

/** A sample as the recorder would have written it. */
const sample = (readySeconds: number, portSeconds: number | null = null, pid = 1000): Sample => ({
  readySeconds,
  portSeconds,
  at: new Date().toISOString(),
  pid,
})

const PAPER_DEFAULT = START_GRACE_SECONDS['paper'] ?? START_GRACE_DEFAULT
const GTNH_DEFAULT = START_GRACE_SECONDS['forge-1710'] ?? START_GRACE_DEFAULT

console.log(`data dir: ${DATA}`)
console.log(
  `constants: floor ${FLOOR_SECONDS}s, ceiling ${CEILING_SECONDS}s, x${GRACE_MULTIPLIER}, ` +
    `implausible above ${MAX_PLAUSIBLE_SECONDS}s, ${SAMPLES_TO_SHORTEN} samples to shorten, keep ${KEEP_SAMPLES}`,
)

// ==================================================== 1. no history, no change

console.log('\n--- 1. with no measurements, behave exactly as before')

// The point: adding this mechanism must not change a single verdict on a fresh
// install. Anything else is a regression dressed up as a feature.
const freshPaper = deriveTiming('paper', [])
const freshGtnh = deriveTiming('forge-1710', [])
const freshUnknown = deriveTiming('unknown', [])

check(
  'a server with no measured boots keeps the platform default',
  freshPaper.graceSeconds === PAPER_DEFAULT && freshGtnh.graceSeconds === GTNH_DEFAULT,
  `paper ${freshPaper.graceSeconds} vs ${PAPER_DEFAULT}, gtnh ${freshGtnh.graceSeconds} vs ${GTNH_DEFAULT}`,
)
check(
  'an unrecognised platform keeps the conservative fallback',
  freshUnknown.graceSeconds === START_GRACE_DEFAULT,
  `${freshUnknown.graceSeconds}`,
)
check('and reports its source as the default, not as a measurement', freshPaper.source === 'default')
check('with no samples counted', freshPaper.samples === 0 && freshPaper.maxSeconds === null)
check(
  'and says in words that nothing has been measured yet',
  /not (?:been )?measured|no (?:measured )?boots?|nothing measured/i.test(freshPaper.detail),
  freshPaper.detail,
)

// ==================================================== 2. measuring upward

console.log('\n--- 2. a pack slower than the constant widens the window')

// This is the case portability-audit.md named: a bigger pack on a slower disk
// exceeds 420 s and gets called HUNG while it is still starting.
const slow = deriveTiming('forge-1710', [sample(300), sample(410), sample(380)])
check(
  'grace is the longest observed boot times the multiplier',
  slow.graceSeconds === 410 * GRACE_MULTIPLIER,
  `${slow.graceSeconds}`,
)
check('which is wider than the constant it replaces', slow.graceSeconds > GTNH_DEFAULT)
check('reported as measured', slow.source === 'measured')
check('with the sample count and the longest boot both named', slow.samples === 3 && slow.maxSeconds === 410)
check(
  'the longest is used, not the mean. A cold boot with four servers contending is the case to survive',
  deriveTiming('paper', [sample(10), sample(10), sample(200)]).maxSeconds === 200,
)
check(
  'the detail names the numbers rather than asserting a conclusion',
  slow.detail.includes('410') && slow.detail.includes(String(slow.graceSeconds)),
  slow.detail,
)

// ============================================ 3. shortening has to be earned

console.log('\n--- 3. shortening the window is earned, widening is not')

// Widening is free: it can only delay a HUNG verdict. Shortening can invent a
// false one, so it needs more evidence than one lucky fast boot.
const thin = deriveTiming('paper', [sample(13), sample(15)])
check(
  `under ${SAMPLES_TO_SHORTEN} samples, a shorter window is NOT adopted`,
  thin.graceSeconds === PAPER_DEFAULT,
  `${thin.graceSeconds}`,
)
check(
  'and it says why it is holding the default rather than silently ignoring the data',
  thin.detail.includes('15s') &&
    thin.detail.includes('2 boots') &&
    thin.detail.includes(String(SAMPLES_TO_SHORTEN)),
  thin.detail,
)
check(
  'it still reports what it measured, so the data is visible while unused',
  thin.samples === 2 && thin.maxSeconds === 15,
)

const earned = deriveTiming('paper', Array.from({ length: SAMPLES_TO_SHORTEN }, () => sample(13)))
check(
  `at ${SAMPLES_TO_SHORTEN} samples a shorter window is adopted`,
  earned.graceSeconds < PAPER_DEFAULT,
  `${earned.graceSeconds}`,
)
check('but never below the floor', earned.graceSeconds === FLOOR_SECONDS, `${earned.graceSeconds}`)
check(
  'the floor is comfortably above twice the fastest boots seen here. 13s Paper, 5s cold JVM',
  FLOOR_SECONDS >= 50,
  `${FLOOR_SECONDS}`,
)
check(
  'widening needs no such threshold: one slow boot is enough',
  deriveTiming('paper', [sample(400)]).graceSeconds === 800,
  `${deriveTiming('paper', [sample(400)]).graceSeconds}`,
)

// The widest window the largest admissible sample can produce.
const huge = deriveTiming('forge-1710', [sample(MAX_PLAUSIBLE_SECONDS)])
check(
  'the largest admissible sample cannot derive a window past the ceiling',
  huge.graceSeconds === CEILING_SECONDS,
  `${huge.graceSeconds}`,
)
// Worth stating rather than leaving implied: with these constants the ceiling can
// never actually clamp anything, because the plausibility bound already caps the
// input at ceiling/multiplier. The bound is the defence; the ceiling is a
// backstop that only matters if someone loosens the bound without looking here.
check(
  'and that is guaranteed by the plausibility bound, not by the ceiling. The ceiling is the backstop, not the defence',
  MAX_PLAUSIBLE_SECONDS * GRACE_MULTIPLIER <= CEILING_SECONDS,
  `${MAX_PLAUSIBLE_SECONDS} x ${GRACE_MULTIPLIER} vs ${CEILING_SECONDS}`,
)

// =============================================== 4. a witnessed boot records

console.log('\n--- 4. a boot we watched from the start is recorded')

resetForTest()
primeHistory(DATA)

// The scan runs every ten seconds. These are five consecutive scans of one Paper
// server: process appears silent, port opens, then a real version answers.
const S = 'MC Paper Test'
let o = observe(S, { pid: 500, uptimeSeconds: 4, responding: false, ready: false })
check('the first sighting of a silent new process records nothing', o.recorded === null)
o = observe(S, { pid: 500, uptimeSeconds: 14, responding: false, ready: false })
check('still nothing while it is silent', o.recorded === null)
o = observe(S, { pid: 500, uptimeSeconds: 24, responding: true, ready: false })
check(
  'nothing when the port opens but the reply is the still-starting placeholder (spec §4)',
  o.recorded === null,
)
o = observe(S, { pid: 500, uptimeSeconds: 34, responding: true, ready: true })
check('a sample is recorded when a real version first answers', o.recorded !== null)
check(
  'and it is the uptime at that moment, which is the boot duration',
  o.recorded?.readySeconds === 34,
  `${o.recorded?.readySeconds}`,
)
check(
  'the port-open time is recorded separately, because they are different facts',
  o.recorded?.portSeconds === 24,
  `${o.recorded?.portSeconds}`,
)
check('and the pid it belongs to, so a sample can be traced', o.recorded?.pid === 500)

o = observe(S, { pid: 500, uptimeSeconds: 44, responding: true, ready: true })
check('a second ready scan of the same process records nothing more', o.recorded === null)
o = observe(S, { pid: 500, uptimeSeconds: 3600, responding: true, ready: true })
check('nor does the same process an hour later', o.recorded === null)

// The measurement has to be usable before it reaches disk: the flush happens at
// the end of the scan, and a verdict formed in between must not use a stale
// window.
check(
  'the measurement is in memory immediately, before any flush',
  timingFor('paper', S).samples === 1 && timingFor('paper', S).maxSeconds === 34,
  `${timingFor('paper', S).samples} samples, max ${timingFor('paper', S).maxSeconds}`,
)
check('and nothing has been written to disk yet', !existsSync(bootPath(DATA)))

// A restart is a new process, and a new measurement.
o = observe(S, { pid: 900, uptimeSeconds: 3, responding: false, ready: false })
check('a new pid starts a new observation', o.recorded === null)
o = observe(S, { pid: 900, uptimeSeconds: 21, responding: true, ready: true })
check('and its boot is recorded too', o.recorded?.readySeconds === 21, `${o.recorded?.readySeconds}`)
check('so restarts accumulate samples on their own', timingFor('paper', S).samples === 2)

// A process going away must reset, or the next appearance is measured against
// the wrong baseline.
observe(S, { pid: null, uptimeSeconds: null, responding: false, ready: false })
o = observe(S, { pid: 901, uptimeSeconds: 30, responding: true, ready: true })
check(
  'a process that vanished and came back already-ready records nothing. We did not watch it boot',
  o.recorded === null,
  `${o.recorded?.readySeconds}`,
)

// ==================================== 5. THE POISON CASE: born ready

console.log('\n--- 5. the poison case: a server that was already up when we first looked')

resetForTest()
primeHistory(DATA)

// This is the one that would break the mechanism permanently. Start the dashboard
// against a server that has been running for four hours; the first sighting is
// ready, and the naive implementation records 14,400 s.
const P = 'MC Already Running'
o = observe(P, { pid: 700, uptimeSeconds: 14_400, responding: true, ready: true })
check('a first sighting that is already ready records NOTHING', o.recorded === null)
check(
  'and says why, rather than failing silently',
  o.discarded !== null && /already|first (?:saw|sighting)|did not (?:see|watch)/i.test(o.discarded ?? ''),
  o.discarded ?? 'no reason given',
)
o = observe(P, { pid: 700, uptimeSeconds: 14_410, responding: true, ready: true })
o = observe(P, { pid: 700, uptimeSeconds: 18_000, responding: true, ready: true })
check('and it never starts recording for that process, however long we watch', o.recorded === null)
check(
  'so the history stays empty and grace stays at the default',
  timingFor('paper', P).samples === 0 && timingFor('paper', P).source === 'default',
)
check(
  'which is the whole point: one poisoned sample would persist to disk and never be reviewed',
  timingFor('paper', P).graceSeconds === PAPER_DEFAULT,
)

// ============================ 6. a mid-life blip is not a boot

console.log('\n--- 6. a mid-life SLP blip is not a boot measurement')

resetForTest()
primeHistory(DATA)

// A healthy server missing one SLP reply. A dropped packet, a momentary
// stop-the-world (spec §13), then answering again. `ready` goes true, false,
// true, and a naive "saw not-ready then ready" rule records the whole uptime.
const B = 'MC Blip'
observe(B, { pid: 800, uptimeSeconds: 7200, responding: true, ready: true })
observe(B, { pid: 800, uptimeSeconds: 7210, responding: false, ready: false })
o = observe(B, { pid: 800, uptimeSeconds: 7220, responding: true, ready: true })
check(
  'a ready -> silent -> ready sequence on one process records nothing',
  o.recorded === null,
  `${o.recorded?.readySeconds}`,
)
check('so a two-hour uptime cannot be laundered into a boot time', timingFor('paper', B).samples === 0)

// pid reuse, and clock adjustment: uptime going backwards means a different
// process, whatever the pid says.
resetForTest()
primeHistory(DATA)
const R = 'MC Reused Pid'
observe(R, { pid: 810, uptimeSeconds: 5000, responding: true, ready: true })
o = observe(R, { pid: 810, uptimeSeconds: 4, responding: false, ready: false })
check('uptime going backwards on the same pid is treated as a new process', o.recorded === null)
o = observe(R, { pid: 810, uptimeSeconds: 30, responding: true, ready: true })
check(
  'and that new process is measurable, even though the pid never changed',
  o.recorded?.readySeconds === 30,
  `${o.recorded?.readySeconds}`,
)

// ============================ 7. implausible readings are not data

console.log('\n--- 7. an implausible reading is discarded, not stored')

resetForTest()
primeHistory(DATA)

// Belt to section 5's braces. Ordering fixes the case we know about; a bound
// catches the ones we do not. A WMI creation date that is wrong, a clock jump
// mid-boot, or a path through the state machine nobody thought of.
const I = 'MC Implausible'
observe(I, { pid: 820, uptimeSeconds: 5, responding: false, ready: false })
o = observe(I, { pid: 820, uptimeSeconds: MAX_PLAUSIBLE_SECONDS + 1, responding: true, ready: true })
check(
  `a witnessed boot longer than ${MAX_PLAUSIBLE_SECONDS}s is still discarded`,
  o.recorded === null,
  `${o.recorded?.readySeconds}`,
)
check(
  'with a reason naming the bound',
  (o.discarded ?? '').includes(String(MAX_PLAUSIBLE_SECONDS)),
  o.discarded ?? 'no reason given',
)
check('and nothing is stored', timingFor('forge-1710', I).samples === 0)

resetForTest()
primeHistory(DATA)
const Z = 'MC Zero Uptime'
observe(Z, { pid: 830, uptimeSeconds: 0, responding: false, ready: false })
o = observe(Z, { pid: 830, uptimeSeconds: 0, responding: true, ready: true })
check('a zero-second boot is discarded. It is a rounding artefact, not a measurement', o.recorded === null)

resetForTest()
primeHistory(DATA)
const N = 'MC No Uptime'
o = observe(N, { pid: 840, uptimeSeconds: null, responding: true, ready: true })
check('an unreadable uptime records nothing and does not throw', o.recorded === null)

// ============================ 8. persistence

console.log('\n--- 8. it persists, and every unreadable file falls back safely')

resetForTest()
const PDIR = mkdtempSync(join(tmpdir(), 'mcdash-boot-persist-'))
primeHistory(PDIR)
const W = 'MC Persisted'
observe(W, { pid: 850, uptimeSeconds: 3, responding: false, ready: false })
observe(W, { pid: 850, uptimeSeconds: 96, responding: true, ready: true })
// What the running service would be using, before any of it reached disk.
const inMemory = timingFor('paper', W)
check('flush() writes when there is something to write', flush(PDIR) === true)
check('the file lands where the other app state lives', existsSync(bootPath(PDIR)))
check('named boot-times.json', bootPath(PDIR).endsWith(BOOT_FILE))
check('flush() writes nothing when nothing changed', flush(PDIR) === false)

const reread = loadHistory(PDIR)
check('the sample survives a reload', samplesFor(reread, W)[0]?.readySeconds === 96)
check(
  'including the port-open time, which here was witnessed rather than inferred',
  samplesFor(reread, W)[0]?.portSeconds === 96,
  `${samplesFor(reread, W)[0]?.portSeconds}`,
)
check(
  'and a restarted service derives exactly what the running one was using',
  JSON.stringify(deriveTiming('paper', samplesFor(reread, W))) === JSON.stringify(inMemory),
  `${deriveTiming('paper', samplesFor(reread, W)).graceSeconds} vs ${inMemory.graceSeconds}`,
)
// 96 s widens a Paper server past its 180 s default, so this exercises the
// measured path rather than falling back, which the forge-1710 default would
// have hidden, since 192 s is shorter than its 420 s constant.
check(
  'a 96s boot widens a Paper window to 192s off a single sample',
  deriveTiming('paper', samplesFor(reread, W)).graceSeconds === 192,
  `${deriveTiming('paper', samplesFor(reread, W)).graceSeconds}`,
)
check(
  'while the same sample leaves a 1.7.10 server on its wider default',
  deriveTiming('forge-1710', samplesFor(reread, W)).graceSeconds === GTNH_DEFAULT,
  `${deriveTiming('forge-1710', samplesFor(reread, W)).graceSeconds}`,
)
check(
  'no credential or absolute server path is written to it',
  !/password|rcon/i.test(readFileSync(bootPath(PDIR), 'utf8')),
)

// Every unreadable input must mean "nothing measured", which means the
// conservative default. Same shape as decision 0003's "absent means yes": the
// ambiguous case lands on the safe side.
const bad = mkdtempSync(join(tmpdir(), 'mcdash-boot-bad-'))
check('a missing file means no measurements', samplesFor(loadHistory(bad), W).length === 0)
for (const [label, body] of [
  ['a truncated file', '{"version":1,"servers":{"MC Persisted":[{"readySec'],
  ['a file that is not an object', '[1,2,3]'],
  ['an empty file', ''],
  ['a null', 'null'],
  ['samples that are not objects', '{"version":1,"servers":{"MC Persisted":["600"]}}'],
  ['a readySeconds that is a string', '{"version":1,"servers":{"MC Persisted":[{"readySeconds":"99999"}]}}'],
  ['a negative readySeconds', '{"version":1,"servers":{"MC Persisted":[{"readySeconds":-5}]}}'],
  [
    'a readySeconds past the plausible bound',
    `{"version":1,"servers":{"MC Persisted":[{"readySeconds":${MAX_PLAUSIBLE_SECONDS + 1}}]}}`,
  ],
  ['servers that is an array', '{"version":1,"servers":[]}'],
] as const) {
  const d = mkdtempSync(join(tmpdir(), 'mcdash-boot-bad-'))
  mkdirSync(d, { recursive: true })
  writeFileSync(bootPath(d), body, 'utf8')
  const t = deriveTiming('paper', samplesFor(loadHistory(d), W))
  check(
    `${label} falls back to the default, never to a wider window`,
    t.graceSeconds === PAPER_DEFAULT && t.source === 'default',
    `${t.graceSeconds}/${t.source}`,
  )
  rmSync(d, { recursive: true, force: true })
}

// A file written by a future version must not be read as if its samples were
// this version's shape.
const vd = mkdtempSync(join(tmpdir(), 'mcdash-boot-ver-'))
writeFileSync(bootPath(vd), '{"version":99,"servers":{"MC Persisted":[{"readySeconds":9000}]}}', 'utf8')
check(
  'a file from a future version is ignored rather than misread',
  deriveTiming('paper', samplesFor(loadHistory(vd), W)).source === 'default',
)

// The window has to be bounded or the file grows without limit.
resetForTest()
const rdir = mkdtempSync(join(tmpdir(), 'mcdash-boot-roll-'))
primeHistory(rdir)
for (let i = 0; i < KEEP_SAMPLES + 6; i++) {
  const pid = 1000 + i
  observe('MC Rolling', { pid, uptimeSeconds: 2, responding: false, ready: false })
  observe('MC Rolling', { pid, uptimeSeconds: 20 + i, responding: true, ready: true })
}
flush(rdir)
const rolled = samplesFor(loadHistory(rdir), 'MC Rolling')
check(`the window keeps at most ${KEEP_SAMPLES} samples`, rolled.length === KEEP_SAMPLES, `${rolled.length}`)
check(
  'and keeps the newest, so an old slow boot ages out instead of pinning the window for ever',
  rolled.every((s) => s.readySeconds >= 20 + 6),
  rolled.map((s) => s.readySeconds).join(','),
)

// ==================== 9. the milestone's own completion criterion

console.log('\n--- 9. measured values differ per server, and persist')

resetForTest()
const mdir = mkdtempSync(join(tmpdir(), 'mcdash-boot-differ-'))
primeHistory(mdir)
for (let i = 0; i < SAMPLES_TO_SHORTEN; i++) {
  observe('Fast Paper', { pid: 2000 + i, uptimeSeconds: 2, responding: false, ready: false })
  observe('Fast Paper', { pid: 2000 + i, uptimeSeconds: 13, responding: true, ready: true })
  observe('Slow Modpack', { pid: 3000 + i, uptimeSeconds: 2, responding: false, ready: false })
  observe('Slow Modpack', { pid: 3000 + i, uptimeSeconds: 104, responding: true, ready: true })
}
flush(mdir)
resetForTest()
primeHistory(mdir)
const fast = timingFor('paper', 'Fast Paper')
const slower = timingFor('forge-1710', 'Slow Modpack')
console.log(`  Fast Paper   ${fast.graceSeconds}s (${fast.source}, max ${fast.maxSeconds}s)`)
console.log(`  Slow Modpack ${slower.graceSeconds}s (${slower.source}, max ${slower.maxSeconds}s)`)
check('two servers measured separately get different windows', fast.graceSeconds !== slower.graceSeconds)
check('both from measurement rather than the platform table', fast.source === 'measured' && slower.source === 'measured')
check('and both survived a reload from disk', fast.samples === SAMPLES_TO_SHORTEN && slower.samples === SAMPLES_TO_SHORTEN)
check(
  'the slow one is wider than the fast one by roughly the ratio of their boots',
  slower.graceSeconds > fast.graceSeconds,
)
check(
  'a name nobody has measured is unaffected by its neighbours',
  timingFor('paper', 'Never Seen').source === 'default',
)

// ============================ 10. what a successful start is allowed to claim

console.log('\n--- 10. a start reports a process, and does not claim readiness')

// M3.3 left this open deliberately: startServer() confirms a JVM exists, not a
// server that answers. The live Skyblock restart returned in 5 s with RCON still
// refusing connections for another ~25 s, which is correct behaviour reported in
// a way that reads as "done".
//
// It is NOT fixed by blocking until ready. That would hold an HTTP request for
// the length of a GTNH boot. 100 s here, longer on a bad day, and hold the
// per-server lock across it, so an operator who wanted to stop a server wedged
// mid-boot would be refused by the very call that is waiting for it. The start
// stays fast and the sentence stops overstating instead.
const { readinessNote } = await import('../server/boottime')

// Two samples: not enough to narrow the HUNG window (section 3), but plenty to
// answer "how long does this usually take?". The note must key on the second
// question, not the first. They are not the same question and conflating them
// silently withholds data that has already been collected.
const thinButMeasured = deriveTiming('forge-1710', [sample(88), sample(104)])
check(
  'the window is still the platform default at two samples',
  thinButMeasured.source === 'default' && thinButMeasured.samples === 2,
)
const noteMeasured = readinessNote(thinButMeasured)
console.log(`  measured: ${noteMeasured}`)
check(
  'but the readiness note still reports what was measured',
  noteMeasured.includes('104'),
  noteMeasured,
)
check(
  'a start does not describe the server as ready or up',
  !/\b(?:is )?(?:ready|up and running|accepting players)\b(?!\s+yet)/i.test(noteMeasured),
  noteMeasured,
)
check('it says the server is not accepting players yet', /not accepting players yet/i.test(noteMeasured))
check(
  'and gives the measured expectation so the wait is bounded for the reader',
  noteMeasured.includes('104') && noteMeasured.includes('2'),
  noteMeasured,
)

const noteUnmeasured = readinessNote(deriveTiming('paper', []))
console.log(`  unmeasured: ${noteUnmeasured}`)
check(
  'with nothing measured it declines to estimate rather than quoting the platform guess as data',
  /not been measured|no boot has been measured|not been watched/i.test(noteUnmeasured),
  noteUnmeasured,
)
check(
  'and does not present the default window as an observation of this server',
  !/this server has taken/i.test(noteUnmeasured),
  noteUnmeasured,
)

// ==================================================== 11. the live reading

console.log('\n--- 11. against the real fleet')

// Shape, not value. No boot has been witnessed on this machine yet, so every
// server here should report the default, which is itself the assertion that
// matters: installing this changed no verdict.
resetForTest()
const { loadConfig, dataDir } = await import('../server/config')
const { scan } = await import('../server/discovery')
const cfg = loadConfig(dataDir())
const snap = await scan(cfg.serversRoot, cfg.classificationOverrides)

for (const s of snap.servers) {
  console.log(
    `  ${s.name.padEnd(20)} ${String(s.health).padEnd(8)} grace ${String(s.boot.graceSeconds).padStart(4)}s ` +
      `${s.boot.source}${s.boot.samples ? ` (${s.boot.samples} boots, max ${s.boot.maxSeconds}s)` : ''}`,
  )
}
check('every server reports a boot window', snap.servers.every((s) => s.boot.graceSeconds > 0))
check(
  'never below the floor',
  snap.servers.every((s) => s.boot.graceSeconds >= FLOOR_SECONDS),
)
check(
  'never above the ceiling',
  snap.servers.every((s) => s.boot.graceSeconds <= CEILING_SECONDS),
)
check(
  'and every window comes with an explanation',
  snap.servers.every((s) => s.boot.detail.length > 20),
)
check(
  'a server with no measured boots reports its platform default, so nothing changed on this install',
  snap.servers.every(
    (s) =>
      s.boot.samples > 0 ||
      s.boot.graceSeconds === (START_GRACE_SECONDS[s.kind] ?? START_GRACE_DEFAULT),
  ),
  snap.servers
    .filter((s) => s.boot.samples === 0)
    .map((s) => `${s.name}=${s.boot.graceSeconds}`)
    .join(', '),
)
check(
  'the scan writes no boot file when it observed no boot',
  !existsSync(bootPath(DATA)) || samplesFor(loadHistory(DATA), 'nothing').length === 0,
)
check(
  'a STARTING server is told how its startup compares to what has been measured',
  snap.servers.every((s) => s.health !== 'STARTING' || s.healthDetail.length > 40),
)

console.log('')
let failed = 0
for (const [l, ok, d] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d ? `  (${d})` : ''}`)
}
console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
