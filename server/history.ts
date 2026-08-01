import { cpus } from 'node:os'
import { resolve, normalize } from 'node:path'
import type { HistorySample, ServerHistory } from '@shared/api'

/**
 * A rolling hour of CPU, memory and TPS per server.
 *
 * This is a measurement surface, not a decoration, which is why it is proved.
 * A graph is the most confident-looking thing on a page: a flat line at 0%
 * reads as "this server is idle" whether it means that or means "we did not
 * measure", and those are opposite facts. Every rule below exists to stop the
 * second one being drawn as the first.
 *
 *   1. **CPU is differenced, never read.** The platform layer reports
 *      cumulative CPU milliseconds since process start. Dividing that by
 *      uptime would give a lifetime average that barely moves; the useful
 *      number is the delta over the delta in wall clock.
 *
 *   2. **A pid change voids the sample.** When a server restarts, the counter
 *      restarts at zero, so differencing across the restart yields a large
 *      negative. Taking the absolute value, or clamping to zero, would draw a
 *      plausible line across the moment the server died. The sample is dropped
 *      instead, and the gap is the truth.
 *
 *   3. **Elapsed time is measured, not assumed.** The scan interval is
 *      nominally ten seconds and is not ten seconds: the loop can be delayed
 *      by the very host contention this dashboard exists to detect. Dividing
 *      by a constant would inflate CPU exactly when the host is struggling,
 *      which is when someone is looking.
 *
 *   4. **A missing reading is null, never zero.** A stopped server, an
 *      unreadable process, a server without RCON: all produce a null in that
 *      series and a gap in the line. Zero is a measurement.
 *
 *   5. **Time is never compressed.** One sample per scan goes in whether or
 *      not anything could be read, so the horizontal axis stays wall clock
 *      and an outage is a visible gap rather than a seam.
 *
 * The percentage is **of one core**, deliberately. A server pegging a single
 * core is the interesting case, and on this machine expressing that as a
 * share of the whole machine would render it as single digits. The UI states
 * the basis and the core count, because a percentage whose denominator is not
 * given is not information.
 *
 * The ring is in memory only and dies with the process. That is a real
 * limitation and the panel says so, because a short graph after a restart
 * otherwise reads as a quiet server.
 */

export const WINDOW_MINUTES = 60

/** Wall-clock span the ring covers, independent of how often samples land. */
const WINDOW_MS = WINDOW_MINUTES * 60_000

/**
 * Hard cap on samples per server, so a pathologically fast scan loop cannot
 * grow this without bound. At the ten-second nominal interval one hour is 360
 * samples; the cap is generous enough not to bite in normal operation and
 * still bounded.
 */
const MAX_SAMPLES = 1_000

/** When this process started collecting. History does not survive a restart. */
let collectingSince = new Date().toISOString()

type Series = {
  samples: HistorySample[]
  /** The previous CPU counter reading, for differencing. */
  last: { pid: number; cpuMs: number; at: number } | null
}

const rings = new Map<string, Series>()

const key = (dir: string): string => resolve(normalize(dir)).replace(/[\\/]+$/, '').toLowerCase()

/** Physical or logical cores. The denominator the UI must state. */
export function coreCount(): number {
  const n = cpus().length
  return n > 0 ? n : 1
}

export type Observation = {
  dir: string
  /** Null when no process owns this directory right now. */
  pid: number | null
  /** Cumulative CPU milliseconds for that pid, from the platform layer. */
  cpuMs: number | null
  ramMb: number | null
  tps: number | null
  /** Milliseconds since the epoch. Passed in so a proof can drive the clock. */
  at: number
}

/**
 * Record one scan's reading for one server.
 *
 * Called once per server per scan, including for servers that are down: rule
 * 5 above depends on it.
 */
export function observe(o: Observation): void {
  const k = key(o.dir)
  let series = rings.get(k)
  if (!series) {
    series = { samples: [], last: null }
    rings.set(k, series)
  }

  let cpuPercentOfCore: number | null = null

  if (o.pid !== null && o.cpuMs !== null) {
    const prev = series.last
    // Rule 2: only difference against the SAME process. A pid change means
    // the counter restarted and there is nothing to compare against.
    if (prev && prev.pid === o.pid) {
      const elapsedMs = o.at - prev.at // rule 3: measured, not assumed
      const cpuDeltaMs = o.cpuMs - prev.cpuMs
      if (elapsedMs > 0 && cpuDeltaMs >= 0) {
        const pct = (cpuDeltaMs / elapsedMs) * 100
        // A reading above every core at once is not a busy server, it is a
        // broken counter or a clock that moved. Refuse it rather than drawing
        // a spike someone will go looking for.
        cpuPercentOfCore = pct <= coreCount() * 100 + 50 ? Math.round(pct * 10) / 10 : null
      }
    }
    series.last = { pid: o.pid, cpuMs: o.cpuMs, at: o.at }
  } else {
    // Nothing is running here. Forget the counter so that when a process
    // appears again it is treated as new rather than differenced against a
    // reading from before the gap.
    series.last = null
  }

  series.samples.push({
    at: new Date(o.at).toISOString(),
    cpuPercentOfCore,
    ramMb: o.ramMb,
    tps: o.tps,
  })

  // Evict by age first, then by the hard cap.
  const cutoff = o.at - WINDOW_MS
  let drop = 0
  while (drop < series.samples.length && Date.parse(series.samples[drop]!.at) < cutoff) drop++
  if (drop > 0) series.samples.splice(0, drop)
  if (series.samples.length > MAX_SAMPLES) {
    series.samples.splice(0, series.samples.length - MAX_SAMPLES)
  }
}

/** Directories that no longer exist stop consuming memory. */
export function forgetAllExcept(dirs: string[]): void {
  const keep = new Set(dirs.map(key))
  for (const k of [...rings.keys()]) if (!keep.has(k)) rings.delete(k)
}

export function historyFor(dir: string, intervalSeconds: number): ServerHistory {
  const series = rings.get(key(dir))
  return {
    windowMinutes: WINDOW_MINUTES,
    intervalSeconds,
    collectingSince,
    cores: coreCount(),
    samples: series ? [...series.samples] : [],
  }
}

/** Test seam. Also resets the "collecting since" mark. */
export function resetHistory(): void {
  rings.clear()
  collectingSince = new Date().toISOString()
}
