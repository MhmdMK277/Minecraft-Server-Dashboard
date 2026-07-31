/**
 * Observer self-measurement, and the host metric that falls out of it.
 *
 * The premise of this tool is that you cannot trust a component to measure the
 * thing it lives inside (README; docs/liveness-spec.md §8). RCON round-trip
 * latency is our probe of the server's main thread -- but both timestamps are
 * taken in OUR event loop. If our loop is blocked when the reply lands, the
 * reply waits unread in the socket buffer and we bill our own delay to the
 * server, reporting a healthy server as STALLED.
 *
 * Observed for real: the first snapshot after startup called MC 1.21.4 STALLED
 * at 3,120 ms and MC Skyblock STALLED at a 5,010 ms timeout; every scan a minute
 * later measured 0-2 ms. Cold-cache readdirSync/statSync in one server's inspect
 * blocked the loop while another's reply was in flight.
 *
 * So the observer measures itself, and health refuses to blame the server for
 * time the observer was demonstrably not listening. Proven by
 * scripts/prove-observer-lag.ts.
 *
 * ---------------------------------------------------------------------------
 * Second use, added 2026-07-29. See docs/liveness-spec.md §12.
 *
 * That correction throws the measurement away. It should not: event-loop delay
 * in a process doing almost nothing is a reading about the MACHINE. This host
 * has an unresolved stall problem (2026-07-28) in which every server degrades at
 * once, and the observer's own lag is a fifth witness that is not a Minecraft
 * server -- so it can tell "the host" apart from "the servers".
 *
 * The distinction that makes the reading usable is WHY the loop was late:
 *
 *   self-inflicted  we were on-CPU, running our own synchronous code. Says
 *                   nothing about the host. This is the §11 bug's signature.
 *   starved         wall-clock passed and we consumed no CPU: we were not
 *                   scheduled, or an I/O completion did not come back. Nobody
 *                   in this process caused it, so it is evidence about the host.
 *
 * `process.cpuUsage()` separates them for the cost of one call per sample.
 * Caveat, on record: it counts every thread (GC, the libuv pool), so our own CPU
 * is over-counted rather than under-counted, and the split is biased AWAY from
 * blaming the host. That is the direction to be wrong in -- "the machine is
 * fine, we were busy" is the accusation we are entitled to make about ourselves.
 */

import type { LoopLag as ApiLoopLag } from '@shared/api'

/**
 * Sampling interval. Fine enough to attribute a block to the probe that
 * overlapped it, coarse enough to be free: one timer callback every 20 ms.
 */
const SAMPLE_MS = 20
/** Ignore ordinary timer jitter; only real blocking is interesting. */
const NOISE_FLOOR_MS = 15
/** ~30 s of history at one entry per detected block. Bounded, never grows. */
const MAX_EVENTS = 512

/** Raw samples kept for the live figure: 60 s at 20 ms. Fixed allocation. */
const WINDOW_SAMPLES = 3000
const WINDOW_MS = WINDOW_SAMPLES * SAMPLE_MS

/**
 * History for the correlation the user actually needs: "was the host already
 * lagging before the servers went bad, or did it start with them?" 10 s per
 * bucket matches the scan interval, so one bucket is one snapshot's worth of
 * host behaviour. 90 buckets is 15 minutes.
 */
const BUCKET_MS = 10_000
const MAX_BUCKETS = 90

type Block = { start: number; end: number }

/** Internal bucket. `at` is epoch ms here and an ISO string on the wire. */
type Bucket = {
  at: number
  maxMs: number
  meanMs: number
  /** Of the delay in this bucket, how much we were not on-CPU for. */
  starvedMs: number
}

let timer: NodeJS.Timeout | null = null
let last = 0
let lastCpuUs = 0
const blocks: Block[] = []

/**
 * The platform's timer granularity, subtracted from every reading.
 *
 * Measured on this host: a 20 ms setInterval fires every ~31 ms, because the
 * Windows timer tick is 15.6 ms and a 20 ms request rounds up to two ticks. The
 * first version of this metric reported that as p50 lag 11 ms and, worse, 47 ms
 * of "starvation" per minute on a completely idle machine -- inventing exactly
 * the host evidence this file exists to supply honestly. A baseline that is
 * never zero is a baseline nobody reads.
 *
 * So it is measured, not assumed: it is not a constant, because any process on
 * the machine can raise the system timer resolution and move it.
 *
 * It is the MEDIAN of recent samples, not the minimum. The minimum was tried
 * first and is wrong: after a block, setInterval fires its catch-up ticks with
 * zero delay, one such tick pins the floor at 0 for good, and the granularity
 * comes straight back into the figures. Observed within a minute of running it
 * against the real service. The median is unmoved by catch-up ticks and by
 * blocks alike, because both are a minority of samples -- and when they are not
 * a minority, the cap below stops the floor from swallowing the evidence.
 */
let floorEstimateMs = 0

/**
 * Hard ceiling on what may be written off as timer granularity.
 *
 * A host late by 200 ms in EVERY sample would otherwise set a 200 ms floor and
 * then report itself perfectly healthy, because from inside the process a
 * permanently late timer and a coarse timer are the same observation. One
 * sample interval is above any real granularity (Windows' worst is 15.6 ms), so
 * anything past it is treated as lag rather than as the clock.
 */
const MAX_TIMER_FLOOR_MS = SAMPLE_MS

/**
 * Samples required before the granularity floor -- and therefore every figure
 * derived from it -- is believed at all. ~1.6 s here, since each 20 ms tick
 * really takes ~31 ms. Exported because a caller must be able to tell
 * "calibrating" from "measured and fine": before this many samples the first
 * snapshot reports p50 12 ms, which is the platform's clock and not the host.
 */
export const MIN_FLOOR_SAMPLES = 50

/** Counting histogram, 1 ms bins, last bin is "over the cap". */
const floorHist = new Int32Array(MAX_TIMER_FLOOR_MS + 2)
let floorTotal = 0

// Parallel arrays rather than objects: the sampler runs 50 times a second for
// the life of the process, and it must not be a source of the garbage it is
// trying to measure.
const sAt = new Float64Array(WINDOW_SAMPLES)
/** Raw, floor NOT subtracted -- the floor is a moving estimate and is applied
 *  at read time, so a revised estimate corrects the whole window at once. */
const sRaw = new Float64Array(WINDOW_SAMPLES)
/** Our own CPU consumed in that sample interval, for the starvation split. */
const sCpu = new Float64Array(WINDOW_SAMPLES)
let sWrite = 0
let sCount = 0

let buckets: Bucket[] = []
let openBucket: { at: number; max: number; sum: number; n: number; starved: number } | null = null

function cpuUs(): number {
  const c = process.cpuUsage()
  return c.user + c.system
}

/** 0 until enough samples exist to believe a granularity figure. */
function floorMs(): number {
  return floorEstimateMs
}

function floorBin(raw: number): number {
  const b = Math.round(raw)
  return b >= MAX_TIMER_FLOOR_MS ? floorHist.length - 1 : b
}

/**
 * Median of the window, read straight off the histogram: O(22), so it can run
 * on every sample. A metric about blocking must not itself be a thing that
 * blocks -- sorting three thousand numbers fifty times a second would make this
 * file a source of the delay it reports.
 */
function recomputeFloor(): void {
  if (floorTotal < MIN_FLOOR_SAMPLES) {
    floorEstimateMs = 0
    return
  }
  const half = floorTotal / 2
  let seen = 0
  for (let i = 0; i < floorHist.length; i++) {
    seen += floorHist[i]!
    if (seen >= half) {
      floorEstimateMs = Math.min(i, MAX_TIMER_FLOOR_MS)
      return
    }
  }
  floorEstimateMs = MAX_TIMER_FLOOR_MS
}

function record(at: number, rawMs: number, cpuMs: number): void {
  // Evict the sample about to be overwritten from the floor histogram, so the
  // granularity estimate describes the same 60 s the percentiles do.
  if (sCount === WINDOW_SAMPLES) {
    floorHist[floorBin(sRaw[sWrite]!)]!--
    floorTotal--
  }
  sAt[sWrite] = at
  sRaw[sWrite] = rawMs
  sCpu[sWrite] = cpuMs
  floorHist[floorBin(rawMs)]!++
  floorTotal++
  sWrite = (sWrite + 1) % WINDOW_SAMPLES
  if (sCount < WINDOW_SAMPLES) sCount++
  recomputeFloor()

  const delayMs = Math.max(0, rawMs - floorEstimateMs)
  const starvedMs = Math.max(0, delayMs - cpuMs)

  const bucketAt = at - (at % BUCKET_MS)
  if (!openBucket || openBucket.at !== bucketAt) {
    if (openBucket) {
      buckets.push({
        at: openBucket.at,
        maxMs: Math.round(openBucket.max),
        meanMs: Math.round((openBucket.sum / Math.max(1, openBucket.n)) * 10) / 10,
        starvedMs: Math.round(openBucket.starved),
      })
      if (buckets.length > MAX_BUCKETS) buckets = buckets.slice(-MAX_BUCKETS)
    }
    openBucket = { at: bucketAt, max: 0, sum: 0, n: 0, starved: 0 }
  }
  openBucket.max = Math.max(openBucket.max, delayMs)
  openBucket.sum += delayMs
  openBucket.n++
  if (delayMs > NOISE_FLOOR_MS) openBucket.starved += starvedMs
}

function tick(): void {
  const now = Date.now()
  const cpu = cpuUs()
  const raw = Math.max(0, now - last - SAMPLE_MS)
  // Wall-clock we lost, and the part of it our own CPU burn explains.
  const ourCpuMs = (cpu - lastCpuUs) / 1000

  record(now, raw, ourCpuMs)

  const delay = raw - floorMs()
  if (delay > NOISE_FLOOR_MS) {
    // The loop was unavailable for `delay` ms ending now. The start excludes the
    // granularity floor, so a probe is never charged for the platform's timer.
    blocks.push({ start: now - delay, end: now })
    if (blocks.length > MAX_EVENTS) blocks.shift()
  }

  last = now
  lastCpuUs = cpu
}

export function startObserverMonitor(): void {
  if (timer) return
  last = Date.now()
  lastCpuUs = cpuUs()
  timer = setInterval(tick, SAMPLE_MS)
  // Must not hold the process open on its own.
  timer.unref?.()
}

export function stopObserverMonitor(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  blocks.length = 0
  sWrite = 0
  sCount = 0
  buckets = []
  openBucket = null
  floorHist.fill(0)
  floorTotal = 0
  floorEstimateMs = 0
}

export function observerMonitorRunning(): boolean {
  return timer !== null
}

/**
 * How long the observer was blocked during [from, to] -- the sum of the
 * overlaps, so a probe spanning several blocks is credited for all of them.
 *
 * The recorded history is not enough on its own. A caller that asks immediately
 * after a block sees nothing, because the sampler needs an event-loop turn to
 * notice, and it has not had one yet -- that is what being blocked means.
 * Measured: after a 1,500 ms block this returned 0, and 1,496 ms one macrotask
 * later. So the gap still open at query time is computed here rather than
 * waited for.
 */
export function observerBlockedMs(from: number, to: number): number {
  const overlap = (start: number, end: number): number =>
    Math.max(0, Math.min(end, to) - Math.max(start, from))

  let total = 0
  for (const b of blocks) total += overlap(b.start, b.end)

  const open = openGap()
  if (open) total += overlap(open.start, open.end)

  return Math.round(total)
}

/** The block that is still in progress at query time, if any. See above. */
function openGap(): { start: number; end: number; delay: number; starved: number } | null {
  if (timer === null) return null
  const now = Date.now()
  const delay = now - last - SAMPLE_MS - floorMs()
  if (delay <= NOISE_FLOOR_MS) return null
  const ourCpuMs = (cpuUs() - lastCpuUs) / 1000
  return {
    start: now - delay,
    end: now,
    delay,
    starved: Math.max(0, delay - ourCpuMs),
  }
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[i]!
}

/**
 * The host-facing summary. Read once per scan; a sort of a few thousand numbers
 * every ten seconds is not worth optimising.
 *
 * The §11 subtlety applies here too and is easy to lose: a caller that asks
 * during a block would otherwise see a calm window, because the sampler has not
 * had a turn in which to record the very thing being asked about. The still-open
 * gap is folded in as a synthetic sample.
 */
export function loopLag(now: number = Date.now()): ApiLoopLag {
  const from = now - WINDOW_MS
  const delays: number[] = []
  let blocked = 0
  let starved = 0

  const floor = floorMs()
  for (let n = 0; n < sCount; n++) {
    const i = (sWrite - 1 - n + WINDOW_SAMPLES * 2) % WINDOW_SAMPLES
    if (sAt[i]! < from) break // samples are walked newest first
    const d = Math.max(0, sRaw[i]! - floor)
    delays.push(d)
    if (d > NOISE_FLOOR_MS) {
      blocked += d
      starved += Math.max(0, d - sCpu[i]!)
    }
  }

  const open = openGap()
  if (open) {
    delays.push(open.delay)
    blocked += open.delay
    starved += open.starved
  }

  delays.sort((a, b) => a - b)

  const cutoff = now - MAX_BUCKETS * BUCKET_MS
  const history = buckets.filter((b) => b.at >= cutoff)
  if (openBucket && openBucket.n > 0) {
    history.push({
      at: openBucket.at,
      maxMs: Math.round(Math.max(openBucket.max, open?.delay ?? 0)),
      meanMs: Math.round((openBucket.sum / openBucket.n) * 10) / 10,
      starvedMs: Math.round(openBucket.starved + (open?.starved ?? 0)),
    })
  }
  const wire = history.map((b) => ({ ...b, at: new Date(b.at).toISOString() }))

  return {
    sampleMs: SAMPLE_MS,
    windowSeconds: WINDOW_MS / 1000,
    samples: delays.length,
    timerFloorMs: Math.round(floorMs() * 10) / 10,
    p50Ms: Math.round(percentile(delays, 0.5)),
    p95Ms: Math.round(percentile(delays, 0.95)),
    maxMs: Math.round(delays.length ? delays[delays.length - 1]! : 0),
    blockedMs: Math.round(blocked),
    starvedMs: Math.round(starved),
    history: wire,
  }
}
