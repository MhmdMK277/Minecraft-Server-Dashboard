import { useCallback, useEffect, useState } from 'react'
import type { ServerHistory, HistorySample } from '@shared/api'
import { dashboard } from './client'

/**
 * The rolling hour, as three sparklines on a server's Overview.
 *
 * The honesty rules that govern this file, all of which exist because a graph
 * looks more certain than a number:
 *
 *   - **A gap is drawn as a gap.** A null is not measured, so the line stops
 *     and starts again. Bridging it would draw a straight, calm segment
 *     across an outage, which is the single most misleading thing this
 *     component could do.
 *   - **Every panel states its window and cadence**, the same way the Worlds
 *     walk states when it was taken.
 *   - **The CPU percentage states its denominator.** A percentage without one
 *     is not information, and "of one core" versus "of the machine" differ by
 *     the core count.
 *   - **A short graph says why it is short.** The ring is in memory and dies
 *     with the service, so two minutes of data after a restart would
 *     otherwise read as a server that has been quiet for an hour.
 *
 * No axes, no gridlines, no fill, no gradient. A sparkline is a shape, and
 * the numbers that matter are already stated above it as figures.
 */

const H = 28
const W = 240

type Series = {
  label: string
  unit: string
  values: Array<number | null>
  /** Fixed floor so a calm line sits low rather than filling the box. */
  min: number
  /** Null means scale to the data. */
  max: number | null
  note: string
}

/**
 * Points to polyline segments, splitting on every null.
 *
 * The split IS the feature. `points` on a single polyline would silently
 * connect the sample before an outage to the one after it.
 */
function segments(values: Array<number | null>, min: number, max: number): string[] {
  const span = Math.max(max - min, 0.0001)
  const out: string[] = []
  let run: string[] = []
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length > 1) out.push(run.join(' '))
      run = []
      return
    }
    const x = values.length === 1 ? W : (i / (values.length - 1)) * W
    const y = H - ((Math.min(Math.max(v, min), max) - min) / span) * H
    run.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  })
  if (run.length > 1) out.push(run.join(' '))
  return out
}

function Spark({ s }: { s: Series }) {
  const present = s.values.filter((v): v is number => v !== null)
  const measured = present.length
  const max = s.max ?? Math.max(...present, s.min + 1)
  const latest = [...s.values].reverse().find((v) => v !== null) ?? null
  const peak = measured > 0 ? Math.max(...present) : null

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-faint">{s.label}</span>
        <span className="tnum font-mono text-[10px] text-faint">
          {peak === null ? 'no readings' : `peak ${peak}${s.unit}`}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2.5">
        {measured === 0 ? (
          <div className="flex h-[28px] flex-1 items-center">
            <span className="text-[11px] text-faint">Nothing was measured in this window.</span>
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="h-[28px] min-w-0 flex-1 text-muted-foreground"
            aria-hidden="true"
          >
            {segments(s.values, s.min, max).map((pts, i) => (
              <polyline
                key={i}
                points={pts}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.25"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            ))}
          </svg>
        )}
        <span className="tnum w-16 shrink-0 text-right font-mono text-[13px] text-ink">
          {latest === null ? '–' : `${latest}${s.unit}`}
        </span>
      </div>
      <p className="prose-line mt-0.5 text-[10px] leading-relaxed text-faint">{s.note}</p>
    </div>
  )
}

export function HistoryPanel({ id }: { id: string }) {
  const [h, setH] = useState<ServerHistory | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    dashboard
      .getHistory(id)
      .then(setH)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not read history'))
  }, [id])

  useEffect(() => {
    setH(null)
    setErr(null)
    load()
    // Refreshed on its own timer rather than off the snapshot, so the graph
    // is not a reason for the board to push more data than it needs to.
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [load])

  if (err) return <p className="prose-line text-[12px] text-bad">{err}</p>
  if (!h) return <p className="text-[12px] text-faint">Reading the last hour…</p>

  const at = (f: (s: HistorySample) => number | null) => h.samples.map(f)
  const measuredSpanMin =
    h.samples.length > 1
      ? Math.round(
          (Date.parse(h.samples[h.samples.length - 1]!.at) - Date.parse(h.samples[0]!.at)) / 60_000,
        )
      : 0
  const sinceRestart = Date.now() - Date.parse(h.collectingSince)
  const shortBecauseRestart = sinceRestart < h.windowMinutes * 60_000

  const series: Series[] = [
    {
      label: 'CPU',
      unit: '%',
      values: at((s) => s.cpuPercentOfCore),
      min: 0,
      max: null,
      note: `Percent of ONE core, so a server using a whole core reads 100. This machine has ${h.cores} core${h.cores === 1 ? '' : 's'}, so the ceiling is ${h.cores * 100}%. Gaps are scans where the process could not be measured or had just restarted.`,
    },
    {
      label: 'RAM',
      unit: ' MB',
      values: at((s) => s.ramMb),
      min: 0,
      max: null,
      note: 'Resident working set, the same figure as the RAM stat above. Gaps are scans where the server was not running.',
    },
    {
      label: 'TPS',
      unit: '',
      values: at((s) => s.tps),
      min: 0,
      max: 20,
      note: 'Ticks per second, from the main game thread over RCON. A server without RCON has no readings here at all, which is not the same as a slow one.',
    },
  ]

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {series.map((s) => (
        <Spark key={s.label} s={s} />
      ))}
      <p className="prose-line text-[11px] leading-relaxed text-faint sm:col-span-2 lg:col-span-3">
        {h.windowMinutes} minute window, one sample every {h.intervalSeconds} seconds,{' '}
        {h.samples.length} held{measuredSpanMin > 0 ? ` covering ${measuredSpanMin} minutes` : ''}.{' '}
        {shortBecauseRestart
          ? `This history is kept in memory and does not survive a restart of the dashboard, which last happened ${Math.max(1, Math.round(sinceRestart / 60_000))} minute${Math.round(sinceRestart / 60_000) === 1 ? '' : 's'} ago. A short graph here means a recent restart, not a quiet server.`
          : 'This history is kept in memory and does not survive a restart of the dashboard.'}
      </p>
    </div>
  )
}
