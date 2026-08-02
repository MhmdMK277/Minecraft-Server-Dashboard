import { useEffect, useState } from 'react'
import type { ProfilingReading, ServerStatus } from '@shared/api'
import { dashboard } from './client'
import { Btn } from './controls'
import { Section } from './ServerDetail'

/**
 * Profiling: the safepoint record, and where each pause's stopped time went.
 *
 * Everything here is read from the server's own logs/gc.log on demand
 * (server/profiling.ts). The split each row carries is the reading no scan
 * can take: "reaching" is time the OS spent not running the threads, which
 * is the HOST's fault (paging, CPU starvation, a stalled disk); "at
 * safepoint" is the operation itself, which is the JVM's. The same pause
 * length means two entirely different repairs, and the 2026-08 eviction
 * investigation was decided by exactly this split.
 */
export default function ProfilingPanel({ s }: { s: ServerStatus }) {
  const [reading, setReading] = useState<ProfilingReading | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [threshold, setThreshold] = useState(200)

  const load = (t: number) => {
    setBusy(true)
    setError(null)
    dashboard
      .getProfiling(s.id, t)
      .then(setReading)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'could not read the pause record'))
      .finally(() => setBusy(false))
  }

  useEffect(() => load(threshold), [s.id, threshold]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Section
      label="Profiling"
      note="Read from this server's own logs/gc.log: the JVM writes every stop-the-world pause down, so this is a complete record, not a sampling."
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-faint">Show pauses over</span>
            {[50, 200, 1000].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setThreshold(t)}
                className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${
                  threshold === t
                    ? 'border-ring text-ink'
                    : 'border-border text-muted-foreground hover:text-ink'
                }`}
              >
                {t >= 1000 ? `${t / 1000} s` : `${t} ms`}
              </button>
            ))}
            <span className="text-[11px] text-faint">(50 ms is one game tick; 200 ms is a common MaxGCPauseMillis target)</span>
          </div>
          <Btn onClick={() => load(threshold)} disabled={busy} label={busy ? 'Reading…' : 'Re-read'} />
        </div>

        {error && (
          <p className="prose-line rounded-md border border-bad/40 bg-bad/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-bad">
            {error}
          </p>
        )}

        {reading && reading.state !== 'read' && (
          <p className="prose-line rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-warn">
            {reading.detail}
          </p>
        )}

        {reading?.state === 'read' && (
          <>
            <p className="prose-line text-[12px] leading-relaxed text-muted-foreground">{reading.detail}</p>

            <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-5">
              <Stat label="safepoints" value={String(reading.n)} />
              <Stat label="p50" value={`${reading.p50Ms} ms`} />
              <Stat label="p95" value={`${reading.p95Ms} ms`} />
              <Stat label="p99" value={`${reading.p99Ms} ms`} />
              <Stat label="worst" value={`${reading.maxMs} ms`} />
            </div>

            <p className="prose-line text-[11px] leading-relaxed text-faint">
              {reading.window.from && reading.window.to
                ? `Covering ${new Date(reading.window.from).toLocaleString()} to ${new Date(reading.window.to).toLocaleString()}${reading.window.hours !== null ? ` (${reading.window.hours} h)` : ''}, `
                : ''}
              {reading.window.wholeFile
                ? 'the whole live file was read. '
                : 'only the tail of the live file fit the read budget, so older pauses in this file are not counted. '}
              {reading.parsed} of {reading.candidates} safepoint lines parsed.
            </p>

            {reading.previousProcessNote && (
              <p className="prose-line rounded-md border border-border bg-panel2 px-2.5 py-1.5 text-[11px] leading-relaxed text-faint">
                {reading.previousProcessNote}
              </p>
            )}

            {reading.pauses.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left font-mono text-[11px]">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-faint">
                      <th className="py-1 pr-3 font-normal">total</th>
                      <th className="py-1 pr-3 font-normal">when</th>
                      <th className="py-1 pr-3 font-normal">operation</th>
                      <th className="py-1 pr-3 text-right font-normal">reaching</th>
                      <th className="py-1 pr-3 text-right font-normal">at safepoint</th>
                      <th className="py-1 font-normal">whose time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {reading.pauses.map((p, i) => (
                      <tr key={i} className="text-ink">
                        <td className="py-1 pr-3">{p.totalMs >= 1000 ? `${(p.totalMs / 1000).toFixed(2)} s` : `${p.totalMs} ms`}</td>
                        <td className="py-1 pr-3 whitespace-nowrap">{new Date(p.at).toLocaleString()}</td>
                        <td className="py-1 pr-3">{p.op}</td>
                        <td className="py-1 pr-3 text-right">{p.reachMs} ms</td>
                        <td className="py-1 pr-3 text-right">{p.atSpMs} ms</td>
                        <td className={`py-1 ${p.attribution === 'host' ? 'text-warn' : 'text-muted-foreground'}`}>
                          {p.attribution === 'host' ? 'host: threads could not reach the safepoint' : 'JVM: work at the safepoint'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="prose-line text-[11px] leading-relaxed text-faint">
              Reaching much larger than at-safepoint means the OS was not running the threads: paging,
              CPU starvation, a stalled disk. That is a host fault, and restarting or tuning this
              server will not fix it. At-safepoint much larger than reaching means the JVM did the
              work; heap size, collector tuning and what the server was doing are the levers.
            </p>
          </>
        )}
      </div>
    </Section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-faint">{label}</div>
      <div className="font-mono text-[13px] text-ink">{value}</div>
    </div>
  )
}
