import { existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { GcSummary, GcSeverity } from '@shared/api'

/**
 * Reads `logs/gc.log`, if the server was started with `-Xlog:gc*,safepoint`.
 *
 * Why this exists. The dashboard measured whole-process stop-the-world pauses
 * on this host -- SLP and RCON stopping and resuming within milliseconds of each
 * other, worst 1,649 ms -- but it samples once every ten seconds, so it sees a
 * pause only if a probe happens to land inside one. A server that freezes for
 * 1.6 s several times a minute was being reported green between the freezes,
 * which is the same class of error as trusting a cached TPS number: the reading
 * is true and the picture is wrong.
 *
 * The JVM already writes every one of those pauses down. Reading its log turns
 * a 1-in-N sampling problem into a complete record, for free, without adding a
 * probe or touching the server.
 *
 * It also answers the question the probes could not. `safepoint` lines name the
 * operation that stopped the world:
 *
 *   G1CollectForAllocation, G1CollectFull, ...  garbage collection
 *   anything else                               a stop-the-world that is NOT GC
 *
 * That distinction is the whole reason `safepoint` is logged alongside `gc*`.
 * "The pauses are GC" was a hypothesis; this is what can refute it.
 */

/**
 * One Minecraft tick is 50 ms. These thresholds are in ticks, not round
 * numbers, because that is the unit the damage is measured in.
 *
 * 200 ms is four ticks, and is also exactly the `MaxGCPauseMillis` target these
 * servers are configured with -- a pause past it means the collector missed its
 * own goal, which is the server's own definition of "too long".
 */
export const PAUSE_NOTICEABLE_MS = 200
/** One second: twenty ticks. A player sees this as the world freezing. */
export const PAUSE_SEVERE_MS = 1000

/** How much history a summary covers. */
export const GC_WINDOW_MINUTES = 60

/**
 * How many bytes a cold read may consume across the whole rotation set.
 *
 * The first version read the last 512 KB of `logs/gc.log` and labelled the
 * result "the last 60 minutes". On an idle server 512 KB really is more than an
 * hour. On the two Paper servers here it was **26 seconds**, because Paper's
 * bundled spark had `backgroundProfiler` enabled and was writing 100 safepoint
 * lines per second -- 10 MB every 8m35s. The dashboard was under-reporting pause
 * counts by roughly two orders of magnitude while stating a window it had never
 * read. That is the same class of error as trusting a cached TPS number: every
 * figure was true of the bytes examined and the picture was wrong.
 *
 * So two changes. Read enough -- walking back through the rotated files until
 * the window is actually covered -- and when the budget runs out first, say so
 * and label the summary with the span really examined instead of the span
 * wanted. `coveredMinutes` and `truncated` exist so this can never silently
 * happen again.
 */
const MAX_READ_BYTES = 4 * 1024 * 1024

/** Rotated siblings to consider. `filecount=20` is what these servers use. */
const MAX_ROTATED_FILES = 32

/**
 * Bytes fingerprinted at the head of the current log to detect rotation.
 *
 * Steady-state cost matters: the scan runs every ten seconds against four
 * servers, and this is synchronous I/O on the event loop (spec §11), so a full
 * re-read each time would make this file a cause of the delays it reports. Only
 * the bytes appended since the last scan are read; the fingerprint is how we
 * know the file is still the same file and not a fresh one after a rotation.
 */
const HEAD_BYTES = 256

export type GcPause = {
  at: number
  kind: string
  ms: number
  isGc: boolean
}

/** `[2026-07-29T15:29:54.851+0200][0.042s][info][gc  ] GC(0) Pause Full (System.gc()) 2M->0M(512M) 3.259ms` */
const PAUSE_RE =
  /^\[([\d\-T:.+]+)\]\[[^\]]*\]\[info\s*\]\[gc\s*\]\s+GC\(\d+\)\s+(Pause [^)]*\)[^0-9]*?)\s+\d+[MKG]->\d+[MKG]\(\d+[MKG]\)\s+([\d.]+)ms\s*$/

/** `...[safepoint ] Safepoint "G1CollectForAllocation", ... At safepoint: 7270500 ns, Total: 7274300 ns` */
const SAFEPOINT_RE =
  /^\[([\d\-T:.+]+)\]\[[^\]]*\]\[info\s*\]\[safepoint\s*\]\s+Safepoint "([^"]+)".*?At safepoint:\s*(\d+)\s*ns/

/**
 * Is this safepoint a garbage collection?
 *
 * Deliberately a denylist-free positive test: anything that does not look like
 * a collector operation is treated as NOT GC, so a stop-the-world from some
 * mechanism nobody thought of shows up as the interesting case rather than
 * being quietly filed under "GC".
 */
function safepointIsGc(name: string): boolean {
  return /^(G1|Z|Shenandoah|Parallel|GenCollect|CGC_|CMS)/.test(name) || /Collect|GC/.test(name)
}

function readRange(path: string, start: number, len: number): string {
  if (len <= 0) return ''
  const buf = Buffer.alloc(len)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, len, start)
  } finally {
    closeSync(fd)
  }
  return buf.toString('utf8')
}

/**
 * Read the last `budget` bytes of a file, dropping the partial first line.
 *
 * A fragment is inevitable when starting at a byte offset, and half a timestamp
 * must never become a pause of unknown length.
 */
function readTail(path: string, budget: number): { text: string; whole: boolean } {
  const size = statSync(path).size
  const start = Math.max(0, size - budget)
  const text = readRange(path, start, size - start)
  if (start === 0) return { text, whole: true }
  const nl = text.indexOf('\n')
  return { text: nl < 0 ? '' : text.slice(nl + 1), whole: false }
}

function headOf(path: string): string {
  try {
    return readRange(path, 0, Math.min(HEAD_BYTES, statSync(path).size))
  } catch {
    return ''
  }
}

/** Rotated siblings, newest first. `gc.log.N` cycles, so order by mtime. */
function rotatedFiles(dir: string): string[] {
  const logs = join(dir, 'logs')
  let names: string[]
  try {
    names = readdirSync(logs)
  } catch {
    return []
  }
  return names
    .filter((n) => /^gc\.log\.\d+$/.test(n))
    .map((n) => join(logs, n))
    .map((p) => {
      try {
        return { p, at: statSync(p).mtimeMs }
      } catch {
        return { p, at: 0 }
      }
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ROTATED_FILES)
    .map((x) => x.p)
}

type Window = {
  pauses: GcPause[]
  /** Earliest timestamp actually read, or null when nothing was. */
  earliest: number | null
  /** True when the byte budget ran out before the window was covered. */
  truncated: boolean
}

/**
 * Cold read: the current log plus as many rotated files as the window needs.
 *
 * Files are parsed individually rather than concatenated, so a fragment at the
 * head of one file cannot merge with the tail of another.
 */
function readWindow(dir: string, path: string, cutoff: number): Window {
  const pauses: GcPause[] = []
  let earliest: number | null = null
  let budget = MAX_READ_BYTES
  let truncated = false

  for (const p of [path, ...rotatedFiles(dir)]) {
    if (budget <= 0) {
      truncated = true
      break
    }
    let r: { text: string; whole: boolean }
    try {
      r = readTail(p, budget)
    } catch {
      continue // a file rotated out from under us is not an error
    }
    budget -= Buffer.byteLength(r.text, 'utf8')
    if (!r.whole) truncated = true
    // Parse with a cutoff of -Infinity so `earliest` reflects what was read,
    // not what survived the window; pruning happens once, at the end.
    const got = parseGcLog(r.text, Number.MAX_SAFE_INTEGER, -Infinity)
    for (const g of got) {
      if (earliest === null || g.at < earliest) earliest = g.at
      if (g.at >= cutoff) pauses.push(g)
    }
    // Covered the window: stop, and it does not matter that this file was cut.
    if (earliest !== null && earliest <= cutoff) {
      truncated = false
      break
    }
  }

  pauses.sort((a, b) => a.at - b.at)
  return { pauses, earliest, truncated }
}

type Cached = {
  /** Head of the current log. A different head means a different file. */
  head: string
  /** Bytes of the current log already consumed. Always ends on a newline. */
  offset: number
  pauses: GcPause[]
  earliest: number | null
  truncated: boolean
}

const cache = new Map<string, Cached>()

/** Test seam: the cache is process-wide, so proofs must be able to clear it. */
export function resetGcCache(): void {
  cache.clear()
}

/**
 * When both tags are logged, every collection is written twice -- once as a
 * `gc` line and once as its `safepoint` line -- so the two streams are parsed
 * separately and only one is used.
 *
 * The safepoint stream wins whenever it exists, because it is a strict superset:
 * every GC stops the world at a safepoint, and so does every stop-the-world that
 * is NOT a GC, which is the case worth catching. The gc stream is the fallback
 * for a server started with `-Xlog:gc` alone.
 *
 * The first attempt merged the two streams and de-duplicated on a 10 ms
 * timestamp bucket. That silently dropped real pauses: under allocation churn
 * two collections land 2 ms apart and were counted as one. Preferring a whole
 * stream needs no heuristic and cannot under-count.
 */
export function parseGcLog(
  text: string,
  now = Date.now(),
  cutoff = now - GC_WINDOW_MINUTES * 60_000,
): GcPause[] {
  const safepoints: GcPause[] = []
  const gcLines: GcPause[] = []

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue

    const sp = SAFEPOINT_RE.exec(line)
    if (sp) {
      const at = Date.parse(sp[1]!)
      if (Number.isNaN(at) || at < cutoff) continue
      // `At safepoint` is the time the world was actually stopped. `Reaching
      // safepoint` sits on the same line, is three orders of magnitude smaller,
      // and is not a pause of the same kind.
      safepoints.push({ at, kind: sp[2]!, ms: Number(sp[3]) / 1e6, isGc: safepointIsGc(sp[2]!) })
      continue
    }

    const p = PAUSE_RE.exec(line)
    if (p) {
      const at = Date.parse(p[1]!)
      if (Number.isNaN(at) || at < cutoff) continue
      gcLines.push({ at, kind: p[2]!.trim(), ms: Number(p[3]), isGc: true })
    }
  }

  const chosen = safepoints.length > 0 ? safepoints : gcLines
  return chosen.sort((a, b) => a.at - b.at)
}

export function gcLogPath(dir: string): string | null {
  const p = join(dir, 'logs', 'gc.log')
  return existsSync(p) ? p : null
}

/**
 * Slack around the process boundary. Uptime is read in whole seconds and the
 * two clocks (log timestamps, process creation) are not the same clock, so a
 * pause within this margin of the start is credited to the CURRENT process:
 * mis-crediting a fresh JVM's first young pause to the dead one understates
 * the living process, which is the safer direction, and a fresh JVM cannot
 * have produced a multi-second pause in its first two seconds anyway.
 */
export const PROCESS_BOUNDARY_SLACK_MS = 2_000

/**
 * Summarise a server's recent pauses. Returns null when the server was not
 * started with GC logging -- which is a normal state, not a fault, and must not
 * render as a problem.
 *
 * `processStartMs` is when the CURRENT process began, when the caller knows
 * it. With it, pauses older than the process are split into
 * `previousProcess` and every headline figure (count, worst, severity)
 * describes only the process that is actually running. Without it (server
 * down, uptime unreadable) the window is summarised whole, as before --
 * there is no current process to misattribute to.
 */
export function gcSummary(
  dir: string,
  now = Date.now(),
  processStartMs: number | null = null,
): GcSummary | null {
  const path = gcLogPath(dir)
  if (!path) return null
  const cutoff = now - GC_WINDOW_MINUTES * 60_000

  let w: Window
  try {
    const size = statSync(path).size
    const head = headOf(path)
    const c = cache.get(path)
    if (c && c.head === head && head !== '' && size >= c.offset) {
      // Same file, only longer: read the appended bytes and nothing else. The
      // previous offset ended on a newline, so the first line here is whole.
      const chunk = readRange(path, c.offset, size - c.offset)
      const cut = chunk.lastIndexOf('\n')
      if (cut >= 0) {
        for (const g of parseGcLog(chunk.slice(0, cut + 1), now, -Infinity)) {
          if (c.earliest === null || g.at < c.earliest) c.earliest = g.at
          c.pauses.push(g)
        }
        c.offset += Buffer.byteLength(chunk.slice(0, cut + 1), 'utf8')
      }
      // Drop what has aged out, so the array stays bounded by the window.
      c.pauses = c.pauses.filter((p) => p.at >= cutoff)
      w = { pauses: c.pauses, earliest: c.earliest, truncated: c.truncated }
    } else {
      w = readWindow(dir, path, cutoff)
      cache.set(path, {
        head,
        offset: size,
        pauses: w.pauses,
        earliest: w.earliest,
        truncated: w.truncated,
      })
    }
  } catch {
    return null
  }

  // Coverage is what was read, not what was asked for. Once the log has been
  // running longer than the window, `earliest` falls behind the cutoff and
  // coverage is complete.
  const from = w.earliest === null ? cutoff : Math.max(cutoff, Math.min(w.earliest, now))
  const coveredMinutes = w.truncated
    ? Math.max(0, Math.round(((now - from) / 60_000) * 10) / 10)
    : GC_WINDOW_MINUTES

  // Split at the process boundary, when we know where it is.
  let current = w.pauses
  let previous: PreviousProcess | null = null
  if (processStartMs !== null) {
    const boundary = processStartMs - PROCESS_BOUNDARY_SLACK_MS
    const before = w.pauses.filter((p) => p.at < boundary)
    if (before.length > 0) {
      current = w.pauses.filter((p) => p.at >= boundary)
      const worst = before.reduce((a, b) => (b.ms > a.ms ? b : a))
      previous = {
        count: before.length,
        maxMs: Math.round(worst.ms),
        worstKind: worst.kind,
        replacedAt: new Date(processStartMs).toISOString(),
      }
    }
  }

  return summarise(current, now, { coveredMinutes, truncated: w.truncated }, previous, processStartMs)
}

export type Coverage = { coveredMinutes: number; truncated: boolean }
export type PreviousProcess = NonNullable<GcSummary['previousProcess']>

export function summarise(
  pauses: GcPause[],
  now = Date.now(),
  coverage: Coverage = { coveredMinutes: GC_WINDOW_MINUTES, truncated: false },
  previous: PreviousProcess | null = null,
  processStartMs: number | null = null,
): GcSummary {
  const ms = pauses.map((p) => p.ms).sort((a, b) => a - b)
  const worstPause = pauses.reduce<GcPause | null>((w, p) => (!w || p.ms > w.ms ? p : w), null)
  const nonGc = pauses.filter((p) => !p.isGc)
  const nonGcWorst = nonGc.reduce<GcPause | null>((w, p) => (!w || p.ms > w.ms ? p : w), null)
  const maxMs = ms.length ? ms[ms.length - 1]! : 0
  const p99 = ms.length ? ms[Math.min(ms.length - 1, Math.ceil(0.99 * ms.length) - 1)]! : 0
  const total = ms.reduce((a, b) => a + b, 0)

  const severity: GcSeverity =
    maxMs >= PAUSE_SEVERE_MS ? 'severe' : maxMs >= PAUSE_NOTICEABLE_MS ? 'noticeable' : 'ok'

  const ticks = (v: number) => Math.round(v / 50)
  // Never name a window that was not read. `span` is the honest phrase; the
  // 512 KB bug was entirely a matter of saying "60 minutes" over 26 seconds of
  // bytes, and every number below was correct about the wrong interval.
  const span = coverage.truncated
    ? `${coverage.coveredMinutes} minutes of log (all that fits in the read budget)`
    : `${GC_WINDOW_MINUTES} minutes`
  let detail: string
  if (!pauses.length) {
    detail = `No stop-the-world pause has been recorded in the last ${span}.`
  } else if (severity === 'ok') {
    detail = `${pauses.length} pauses in the last ${span}, worst ${maxMs.toFixed(0)} ms, under one tick's worth of a wobble, and under this server's own ${PAUSE_NOTICEABLE_MS} ms target.`
  } else {
    detail =
      `${pauses.length} stop-the-world pauses in the last ${span}. The worst froze the whole server for ${fmt(maxMs)}, about ${ticks(maxMs)} ticks the world did not advance` +
      `${worstPause ? `, during ${worstPause.kind}` : ''}. ` +
      (severity === 'severe'
        ? 'A pause this long is visible to players as the world stopping, and a health probe that lands inside one reads as STALLED. This server is not healthy between the readings that say it is.'
        : `Past the ${PAUSE_NOTICEABLE_MS} ms target this server is configured with, so the collector is missing its own goal.`)
  }

  if (nonGcWorst && nonGcWorst.ms >= PAUSE_NOTICEABLE_MS) {
    detail += ` Note: the worst NON-garbage-collection pause was ${fmt(nonGcWorst.ms)} (${nonGcWorst.kind}), not every stop here is the collector.`
  }

  if (coverage.truncated) {
    detail += ` The log is being written faster than ${Math.round(MAX_READ_BYTES / 1024 / 1024)} MB per ${GC_WINDOW_MINUTES} minutes, so this counts only the most recent ${coverage.coveredMinutes} minutes. The real ${GC_WINDOW_MINUTES}-minute figures are higher.`
  }

  if (previous) {
    // The window spans a restart. Say so plainly, name the moment, and keep
    // the dead process's record separate from the living one's.
    detail += ` This window spans a restart: the process serving this server was replaced at ${new Date(previous.replacedAt).toLocaleTimeString('en-GB')}. ${previous.count} earlier pause${previous.count === 1 ? '' : 's'} (worst ${fmt(previous.maxMs)}${previous.worstKind ? `, ${previous.worstKind}` : ''}) belong to the replaced process and are not counted above.`
  }

  // The denominator for "percent stopped" is the time the CURRENT process has
  // actually existed inside the window, when that is shorter than the window:
  // dividing a 30-minute-old process's pauses by a full hour would understate
  // exactly the number this summary exists to state.
  let spanMs = Math.max(1, coverage.coveredMinutes * 60_000)
  if (processStartMs !== null) spanMs = Math.max(1, Math.min(spanMs, now - processStartMs))

  return {
    windowMinutes: GC_WINDOW_MINUTES,
    coveredMinutes: coverage.coveredMinutes,
    truncated: coverage.truncated,
    count: pauses.length,
    maxMs: Math.round(maxMs),
    p99Ms: Math.round(p99),
    totalMs: Math.round(total),
    worstKind: worstPause?.kind ?? null,
    worstAt: worstPause ? new Date(worstPause.at).toISOString() : null,
    nonGcCount: nonGc.length,
    nonGcMaxMs: Math.round(nonGcWorst?.ms ?? 0),
    /** Share of wall clock the world was stopped, over the span actually read. */
    stoppedPercent: Math.round((total / spanMs) * 10000) / 100,
    severity,
    detail,
    previousProcess: previous,
  }
}

function fmt(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(0)} ms`
}
