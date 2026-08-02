import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import type { ProfilingReading, SafepointPause } from '@shared/api'
import { PROCESS_BOUNDARY_SLACK_MS } from './gclog'

/**
 * Profiling: every stop-the-world pause the JVM wrote down, and WHERE THE
 * STOPPED TIME WENT. This is the reading the stall investigation performed by
 * hand for a week (scripts/gc-report.py) turned into a per-server surface.
 *
 * The one number nothing else has: each safepoint line splits the pause into
 * "Reaching safepoint" (the OS could not get threads to the rendezvous:
 * paging, CPU starvation, a stalled disk -- a HOST fault) and "At safepoint"
 * (the JVM did the work -- GC tuning). A 900 ms pause means two entirely
 * different repairs depending on which side owns it, and the whole 2026-08
 * eviction investigation turned on that split.
 *
 * Two rules ported from gc-report.py because each produced a confident wrong
 * answer when violated:
 *
 * 1. **Fields are parsed BY NAME.** JDK 21 writes "Reaching safepoint /
 *    Cleanup / At safepoint / Total"; JDK 25 replaced Cleanup with "Leaving
 *    safepoint" and appended "Threads". A layout-shaped regex matches zero
 *    lines on the other layout and the report still renders clean -- a file
 *    that parses to nothing looks exactly like a server that behaved. So
 *    candidates (lines that LOOK like safepoints) and parsed lines are both
 *    counted, and a gap between them is reported as `parser-mismatch`, its
 *    own state, never an empty healthy table.
 *
 * 2. **One gc.log file is not one JVM.** Rotated files outlive the process
 *    that wrote them; reading one as current once invented a 46-second
 *    regression that did not exist. Only the LIVE file is read here, and
 *    pauses older than the running process's start are labelled `previous`
 *    and kept out of the headline figures (the F9 lesson, same as gclog.ts).
 */

/** Read at most this much of the live file, from the end. */
const MAX_READ_BYTES = 8 * 1024 * 1024

/** Over-threshold pauses returned to the UI, worst first. */
const MAX_PAUSES_RETURNED = 200

const SAFEPOINT_RE = /^\[([^\]]+)\].*\[safepoint\s*\]\s*Safepoint "([^"]+)",\s*(.*)$/
const FIELD_RE = /([A-Za-z ]+):\s*(\d+)\s*ns/g

export type ParsedSafepoint = {
  atMs: number
  op: string
  totalMs: number
  reachMs: number
  atSpMs: number
}

/** One line. Null when it is not a parseable safepoint line. */
export function parseSafepointLine(line: string): ParsedSafepoint | null {
  const m = SAFEPOINT_RE.exec(line)
  if (!m) return null
  const atMs = Date.parse(m[1]!)
  if (Number.isNaN(atMs)) return null
  const fields: Record<string, number> = {}
  for (const f of m[3]!.matchAll(FIELD_RE)) {
    fields[f[1]!.trim()] = Number(f[2]) / 1e6
  }
  if (!('Total' in fields)) return null
  return {
    atMs,
    op: m[2]!,
    totalMs: fields['Total']!,
    // Host-side: time spent waiting for threads to arrive.
    reachMs: fields['Reaching safepoint'] ?? 0,
    // JVM-side: the operation itself, under either field layout.
    atSpMs: (fields['At safepoint'] ?? 0) + (fields['Cleanup'] ?? 0) + (fields['Leaving safepoint'] ?? 0),
  }
}

export function parseSafepoints(text: string): { rows: ParsedSafepoint[]; candidates: number } {
  const rows: ParsedSafepoint[] = []
  let candidates = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('[safepoint')) continue
    candidates++
    const p = parseSafepointLine(line)
    if (p) rows.push(p)
  }
  return { rows, candidates }
}

function pctl(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const k = ((sorted.length - 1) * p) / 100
  const lo = Math.floor(k)
  const hi = Math.min(lo + 1, sorted.length - 1)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (k - lo)
}

function readTail(path: string, budget: number): { text: string; readBytes: number; fileBytes: number } {
  const size = statSync(path).size
  const start = Math.max(0, size - budget)
  const len = size - start
  const buf = Buffer.alloc(len)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, len, start)
  } finally {
    closeSync(fd)
  }
  let text = buf.toString('utf8')
  if (start > 0) {
    // Drop the partial first line: half a timestamp must not become a pause.
    const nl = text.indexOf('\n')
    text = nl < 0 ? '' : text.slice(nl + 1)
  }
  return { text, readBytes: len, fileBytes: size }
}

const round2 = (v: number) => Math.round(v * 100) / 100

/**
 * The whole reading. `processStartMs` is when the CURRENT process began, when
 * the caller knows it; pauses from before that boundary are labelled
 * `previous` and excluded from every headline figure.
 */
export function profileSafepoints(
  dir: string,
  opts: { thresholdMs?: number; processStartMs?: number | null } = {},
): ProfilingReading {
  const thresholdMs = opts.thresholdMs ?? 200
  const processStartMs = opts.processStartMs ?? null
  const path = join(dir, 'logs', 'gc.log')

  const empty = {
    thresholdMs,
    candidates: 0,
    parsed: 0,
    window: { from: null, to: null, hours: null, readBytes: 0, fileBytes: 0, wholeFile: true },
    n: 0,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    maxMs: 0,
    overCount: 0,
    hostAttributedCount: 0,
    pauses: [],
    previousProcessNote: null,
  }

  if (!existsSync(path)) {
    return {
      ...empty,
      state: 'no-gclog',
      detail:
        'This server was not started with GC logging, so there is no pause record to read. A JVM flag like -Xlog:gc*,safepoint:file=logs/gc.log:time,uptime,level,tags:filecount=20,filesize=10M in the start script makes the JVM write one; without it there is simply no logs/gc.log, which is a normal state, not a fault.',
    }
  }

  let tail: { text: string; readBytes: number; fileBytes: number }
  try {
    tail = readTail(path, MAX_READ_BYTES)
  } catch (e) {
    return {
      ...empty,
      state: 'unreadable',
      detail: `logs/gc.log exists but could not be read (${e instanceof Error ? e.message : 'read failed'}). Nothing is claimed about pauses.`,
    }
  }

  const { rows, candidates } = parseSafepoints(tail.text)

  if (candidates > 0 && rows.length === 0) {
    return {
      ...empty,
      state: 'parser-mismatch',
      candidates,
      detail:
        `${candidates} lines in this log look like safepoints and none of them parsed. That is a parser gap on this JVM's field layout, not a quiet server -- the JDK has changed this format before (21 and 25 differ). Report it rather than trusting the empty table.`,
    }
  }

  // The process boundary: pauses from before the running process belong to a
  // dead JVM and must not read as the live server's crisis (F9).
  const boundary = processStartMs !== null ? processStartMs - PROCESS_BOUNDARY_SLACK_MS : null
  const current = boundary === null ? rows : rows.filter((r) => r.atMs >= boundary)
  const previousCount = rows.length - current.length

  const totals = current.map((r) => r.totalMs).sort((a, b) => a - b)
  const over = current.filter((r) => r.totalMs > thresholdMs)
  over.sort((a, b) => b.totalMs - a.totalMs)

  const pauses: SafepointPause[] = over.slice(0, MAX_PAUSES_RETURNED).map((r) => ({
    at: new Date(r.atMs).toISOString(),
    op: r.op,
    totalMs: round2(r.totalMs),
    reachMs: round2(r.reachMs),
    atSpMs: round2(r.atSpMs),
    // The discriminator, verbatim from gc-report.py: whichever side got more
    // of the stopped time owns the pause.
    attribution: r.reachMs > r.atSpMs ? 'host' : 'jvm',
  }))

  const hostAttributedCount = over.filter((r) => r.reachMs > r.atSpMs).length
  const from = current.length ? new Date(Math.min(...current.map((r) => r.atMs))) : null
  const to = current.length ? new Date(Math.max(...current.map((r) => r.atMs))) : null
  const hours = from && to ? Math.round(((to.getTime() - from.getTime()) / 3_600_000) * 10) / 10 : null

  const spanPhrase = hours !== null ? `${hours} h of the live log` : 'the live log'
  const detail =
    current.length === 0
      ? `No safepoint has been recorded by the current process${previousCount > 0 ? ' (the file holds only pauses from a replaced process)' : ''}.`
      : over.length === 0
        ? `${current.length} safepoints over ${spanPhrase}, none over ${thresholdMs} ms. The world is not being stopped for long enough to matter.`
        : `${over.length} of ${current.length} safepoints over ${spanPhrase} stopped the world for more than ${thresholdMs} ms; the worst took ${round2(totals[totals.length - 1]!)} ms. ${hostAttributedCount > 0 ? `${hostAttributedCount} of them spent most of that time REACHING the safepoint, which is the host not running threads (paging, CPU starvation, a stalled disk), not the collector.` : 'Every one of them spent the time doing work at the safepoint, which is the JVM itself, so tuning, heap size and what the server is doing are the levers -- the host is not implicated.'}`

  return {
    state: 'read',
    detail,
    thresholdMs,
    candidates,
    parsed: rows.length,
    window: {
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
      hours,
      readBytes: tail.readBytes,
      fileBytes: tail.fileBytes,
      wholeFile: tail.readBytes === tail.fileBytes,
    },
    n: current.length,
    p50Ms: round2(pctl(totals, 50)),
    p95Ms: round2(pctl(totals, 95)),
    p99Ms: round2(pctl(totals, 99)),
    maxMs: totals.length ? round2(totals[totals.length - 1]!) : 0,
    overCount: over.length,
    hostAttributedCount,
    pauses,
    previousProcessNote:
      previousCount > 0
        ? `${previousCount} safepoint${previousCount === 1 ? '' : 's'} in this file predate the running process and are excluded from every figure above. Rotated files are not read at all: a gc.log outlives the JVM that wrote it, and a dead process's pauses once invented a 46-second regression here.`
        : null,
  }
}
