import { useEffect, useRef, useState } from 'react'
import type { ServerStatus } from '@shared/api'
import {
  verdict,
  verdictSentence,
  Indicator,
  Meter,
  Metric,
  TONE_TEXT,
  TONE_RAIL,
  fmtMemPair,
} from './status'
import { age, Note } from './controls'
import { href } from './router'

/**
 * One line of the departure board.
 *
 * The whole row is a monitoring surface (DESIGN.md): the lamp column, the
 * verdict, the figures in tabular columns, and the prose that explains them.
 * No controls live here; the row's only action is entering the server.
 *
 * Layout law 1: the figure grid drops from six columns to three before any
 * label may truncate, and the meta line wraps as a flex row rather than
 * squeezing.
 */

function pauseText(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`
}

/** Flash once when the health state actually CHANGES. Motion is news only. */
function useStateChangeFlash(key: string): boolean {
  const previous = useRef<string | null>(null)
  const [flashing, setFlashing] = useState(false)

  useEffect(() => {
    // First sighting is not a change: otherwise every row flashes on load,
    // which is precisely the meaningless motion this exists to avoid.
    if (previous.current !== null && previous.current !== key) {
      setFlashing(true)
      const t = setTimeout(() => setFlashing(false), 1600)
      previous.current = key
      return () => clearTimeout(t)
    }
    previous.current = key
  }, [key])

  return flashing
}

/** A label:value pair on the meta line. Mono, quiet, never truncated. */
function MetaPair({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="tnum whitespace-nowrap font-mono text-[10px] text-faint" title={title}>
      <span className="uppercase tracking-[0.08em]">{label}</span>{' '}
      <span className="text-muted-foreground">{value}</span>
    </span>
  )
}

export function ServerRow({ s, onOpen }: { s: ServerStatus; onOpen?: (id: string) => void }) {
  const v = verdict(s)
  const dim = s.classification !== 'live'
  const flashing = useStateChangeFlash(`${s.health}:${s.attribution ?? ''}`)

  const tps = s.tps?.overall ?? null
  const players = s.slp?.playersOnline ?? null
  const maxPlayers = s.slp?.playersMax ?? null

  // Working set against private bytes: residency, not "of heap". The heap
  // ceiling is not on the wire, and inventing a denominator is the failure
  // mode this whole project argues against.
  const ws = s.proc?.workingSetMb ?? null
  const priv = s.proc?.privateMb ?? null
  const residency = ws != null && priv != null && priv > 0 ? Math.round((ws / priv) * 100) : null

  // Undefined, not 'ok', when the tick rate is fine: a healthy server always
  // reads 20.0, and colouring it green would put the brightest thing on the
  // board on every healthy row.
  const tpsTone = tps == null || tps >= 19.5 ? undefined : tps >= 15 ? 'warn' : 'bad'

  return (
    <article
      className={`rail relative border-b border-border/60 py-4 pl-5 pr-4 transition-[background-color] duration-150 ${
        TONE_RAIL[v.tone]
      } ${v.confidence === 'unmeasured' ? 'rail-dashed' : ''} ${dim ? 'opacity-60' : ''} ${
        flashing ? `state-changed ${TONE_TEXT[v.tone]}` : ''
      } ${onOpen ? 'cursor-pointer hover:bg-secondary/40' : ''}`}
      onClick={onOpen ? () => onOpen(s.id) : undefined}
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <Indicator tone={v.tone} confidence={v.confidence} large={v.attention} className="self-center" />
        {/* The keyboard path onto the board's primary action (layout law 5):
            the name is a real link; the whole-row onClick is the mouse-sized
            target on top of it. */}
        <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
          {onOpen ? (
            <a
              href={href({ name: 'server', id: s.id, page: 'overview' })}
              className="rounded-sm text-inherit no-underline"
              onClick={(e) => e.stopPropagation()}
            >
              {s.name}
            </a>
          ) : (
            s.name
          )}
        </h3>
        {/* Healthy renders colourless: on a calm board any colour is news. */}
        <span
          className={`text-[12px] ${
            v.attention ? `font-semibold ${TONE_TEXT[v.tone]}` : 'font-medium text-muted-foreground'
          }`}
          title={verdictSentence(v)}
        >
          {v.label}
        </span>
        {v.note && <span className={`text-[11px] ${TONE_TEXT[v.tone]}`}>{v.note}</span>}
        <span className="ml-auto font-mono text-[11px] text-faint">
          {s.slp?.versionName ?? s.kind}
          {s.gamePort ? ` :${s.gamePort}` : ''}
        </span>
      </div>

      <p className="prose-line mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
        {s.healthDetail}
      </p>

      {/* Above the figures, not below: the GC note contradicts the TPS number
          beneath it, and the attribution note answers "whose fault", which
          never goes below the fold. */}
      {(s.attributionDetail || (s.gc && s.gc.severity !== 'ok') || s.portConflictWith.length > 0) && (
        <div className="mt-2.5 space-y-2">
          {s.attributionDetail && (
            <Note tone={s.attribution === 'server' ? 'bad' : s.attribution === 'configuration' ? 'muted' : 'warn'}>
              {s.attributionDetail}
            </Note>
          )}
          {s.gc && s.gc.severity !== 'ok' && <Note tone="warn">{s.gc.detail}</Note>}
          {s.portConflictWith.length > 0 && (
            <Note tone="warn">
              Port {s.gamePort} is also declared by {s.portConflictWith.join(', ')}. Liveness here
              is resolved by process, not by port.
            </Note>
          )}
        </div>
      )}

      {s.classification === 'live' && (
        <>
          <div className="mt-3.5 grid grid-cols-3 gap-x-6 gap-y-3 lg:grid-cols-6">
            <Metric
              label="Players"
              value={players != null ? `${players}${maxPlayers != null ? `/${maxPlayers}` : ''}` : '–'}
              tier="lead"
            >
              <Meter value={players} max={maxPlayers} tone="muted" />
            </Metric>
            <Metric
              label="TPS"
              value={tps != null ? tps.toFixed(1) : '–'}
              tier="lead"
              tone={tpsTone}
              title={s.tps ? `via \`${s.tps.command}\`. 20 is the ceiling` : 'not available'}
            >
              <Meter value={tps} max={20} tone={tpsTone ?? 'muted'} />
            </Metric>
            <Metric
              label="RCON"
              value={s.rcon?.ok ? `${s.rcon.latencyMs} ms` : s.rcon ? 'no reply' : '–'}
              tier="lead"
              tone={s.rcon && !s.rcon.ok ? 'bad' : undefined}
              title="Round trip to the main game thread. The only probe that can tell a stalled server from a healthy one."
            />
            <Metric
              label="Worst pause"
              value={s.gc ? pauseText(s.gc.maxMs) : '–'}
              tier="lead"
              tone={s.gc?.severity === 'severe' ? 'bad' : s.gc?.severity === 'noticeable' ? 'warn' : undefined}
              title={
                s.gc
                  ? `${s.gc.count} stop-the-world pauses in the last ${s.gc.coveredMinutes} min, totalling ${s.gc.totalMs} ms. ${s.gc.nonGcCount} were not garbage collection.` +
                    (s.gc.truncated
                      ? ` Only ${s.gc.coveredMinutes} of the intended ${s.gc.windowMinutes} min could be read, so the true counts are higher.`
                      : '')
                  : 'This server was not started with -Xlog:gc, so its pauses are invisible to the dashboard.'
              }
            >
              {s.gc && <div className="mt-0.5 text-[10px] text-faint">{s.gc.stoppedPercent}% stopped</div>}
            </Metric>
            <Metric
              label="RAM"
              value={fmtMemPair(ws, s.proc?.heapMaxMb ?? priv)}
              tier="lead"
              title={
                ws == null
                  ? 'Working set could not be read.'
                  : s.proc?.heapMaxMb != null
                    ? `${ws} MB resident of the ${s.proc.heapMaxMb} MB heap ceiling (-Xmx from the command line). The process has committed ${priv ?? '?'} MB; ${residency ?? '?'}% of that is resident. Residency, not heap usage.`
                    : `${ws} MB resident of ${priv} MB committed by this process. The java command line is not readable for a boot-started process, so -Xmx is unknown and committed memory stands in for allocated. Residency, not heap usage.`
              }
            >
              <Meter value={ws} max={s.proc?.heapMaxMb ?? priv} tone="muted" />
              {ws != null && (
                <div className="mt-0.5 text-[10px] text-faint">
                  {s.proc?.heapMaxMb != null
                    ? `${residency ?? '?'}% of committed resident`
                    : 'committed stands in for -Xmx'}
                </div>
              )}
            </Metric>
            <Metric label="Uptime" value={age(s.proc?.uptimeSeconds ?? null)} tier="lead" />
          </div>

          <div className="mt-2.5 flex flex-wrap items-baseline gap-x-5 gap-y-1">
            <MetaPair label="pid" value={s.proc ? String(s.proc.pid) : '–'} />
            <MetaPair label="ping" value={s.slp ? `${s.slp.latencyMs} ms` : '–'} />
            <MetaPair label="world" value={s.levelName ?? '–'} />
            <MetaPair
              label="window"
              value={s.boot.source === 'measured' ? `${s.boot.graceSeconds}s` : `${s.boot.graceSeconds}s?`}
              title={s.boot.detail}
            />
            <MetaPair
              label="boot"
              value={s.boot.lastSeconds != null ? `${s.boot.lastSeconds}s` : '–'}
              title={
                s.boot.lastSeconds == null
                  ? 'This server has not been watched starting yet. A measurement is taken the next time it boots from cold.'
                  : `Process start to answering with a real version: ${s.boot.lastSeconds}s. ${s.boot.samples} boot${s.boot.samples === 1 ? '' : 's'} measured, longest ${s.boot.maxSeconds}s.`
              }
            />
          </div>

          {s.players && s.players.length > 0 && (
            <p className="prose-line mt-2 text-[12px] text-muted-foreground">
              <span className="text-faint">Online: </span>
              <span className="text-ink">{s.players.join(', ')}</span>
            </p>
          )}
        </>
      )}
    </article>
  )
}
