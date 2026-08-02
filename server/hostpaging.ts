import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PagingReading } from '@shared/api'

const execFileP = promisify(execFile)

/**
 * Host hard-fault sampling (stall investigation, 2026-08-02).
 *
 * `\Memory\Pages Input/sec` is the number the investigation had to fetch
 * from an external monitor's CSV at five in the morning: how fast the
 * machine is reading memory back from disk. Sampled here so the dashboard
 * can put it NEXT TO loop lag and the per-server residency reading, which
 * together are the whole causal chain: bulk file I/O -> low-priority
 * processes' pages evicted -> a full-heap GC hard-faults for seconds.
 *
 * Sampling is on its own timer, never inside the scan: it spawns a
 * PowerShell, and spec §11 forbids the scan path from carrying that cost.
 * One sample every SAMPLE_MS, a bounded ring for the baseline, and the
 * reading always ships the baseline it was judged against, so "elevated"
 * is checkable arithmetic rather than an assertion.
 *
 * This reads a counter and nothing else. No mitigation lives here.
 */

export const SAMPLE_MS = 30_000
/** Ring size: 60 samples at 30 s = a 30-minute baseline window. */
const RING = 60

/**
 * Elevated = at least MIN_ELEVATED_PPS AND at least ELEVATED_FACTOR times
 * the baseline. Both legs are needed: the measured idle baseline here is
 * 16-40 pages/s, where a 10x spike is still only a few hundred kilobytes a
 * second and not worth a sentence; and a busy machine with an already-high
 * baseline should not read as elevated for being itself.
 */
export const MIN_ELEVATED_PPS = 500
export const ELEVATED_FACTOR = 10

type Sample = { at: number; pps: number }

let ring: Sample[] = []
let timer: NodeJS.Timeout | null = null

/** Test seam. */
export function resetPaging(): void {
  ring = []
}

/** Test seam: proofs feed synthetic samples instead of spawning PowerShell. */
export function pushPagingSample(pps: number, at = Date.now()): void {
  ring.push({ at, pps })
  if (ring.length > RING) ring = ring.slice(-RING)
}

async function sampleOnce(): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    const { stdout } = await execFileP(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory).PagesInputPersec',
      ],
      { timeout: 20_000, windowsHide: true },
    )
    const pps = Number(stdout.trim())
    if (Number.isFinite(pps) && pps >= 0) pushPagingSample(pps)
  } catch {
    // A failed sample is a gap, not a zero: pushing 0 would drag the
    // baseline down and make the next real sample read as a spike.
  }
}

export function startPagingSampler(): void {
  if (timer || process.platform !== 'win32') return
  void sampleOnce()
  timer = setInterval(() => void sampleOnce(), SAMPLE_MS)
  timer.unref()
}

export function stopPagingSampler(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export function pagingReading(now = Date.now()): PagingReading | null {
  if (ring.length === 0) return null
  const latest = ring[ring.length - 1]!
  const sorted = ring.map((s) => s.pps).sort((a, b) => a - b)
  const baseline = sorted[Math.floor(sorted.length / 2)]!
  const worst = sorted[sorted.length - 1]!
  const windowMinutes = Math.max(1, Math.round((now - ring[0]!.at) / 60_000))
  const elevated =
    latest.pps >= MIN_ELEVATED_PPS && latest.pps >= ELEVATED_FACTOR * Math.max(1, baseline)

  const detail = elevated
    ? `The machine is reading memory back from disk at ${Math.round(latest.pps)} pages/s against a ` +
      `baseline of ~${Math.round(baseline)}/s over the last ${windowMinutes} min. Something is doing ` +
      `bulk file I/O, and evicted memory is being faulted back in; a server at low memory priority ` +
      `whose heap is caught in this can stall for seconds at its next full-heap collection.`
    : `Hard faults ${Math.round(latest.pps)} pages/s (baseline ~${Math.round(baseline)}/s, worst ` +
      `${Math.round(worst)}/s over the last ${windowMinutes} min).`

  return {
    pagesInputPerSec: Math.round(latest.pps * 10) / 10,
    sampledAt: new Date(latest.at).toISOString(),
    baselinePerSec: Math.round(baseline * 10) / 10,
    worstRecentPerSec: Math.round(worst * 10) / 10,
    windowMinutes,
    elevated,
    detail,
  }
}
