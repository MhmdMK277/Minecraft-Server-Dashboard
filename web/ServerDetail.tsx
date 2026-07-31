import { useEffect, useRef } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  Archive,
  Fingerprint,
  Settings2,
  SlidersHorizontal,
  Terminal,
  Timer,
  Users,
} from 'lucide-react'
import type { ServerStatus, LogLine } from '@shared/api'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { verdict, verdictSentence, Indicator, Meter, Metric, TONE_TEXT } from './status'
import { ControlPanel, BackupToggle, CommandBox, age } from './ServerCard'
import ServerSettingsPanel from './ServerSettings'
import { href } from './router'

/**
 * One server, in full.
 *
 * The fleet overview answers "is anything wrong, and can I trust that answer" by
 * showing every server at once -- which is the thing wrapper panels cannot do,
 * and is why the overview stays view-centric rather than growing a server
 * sidebar. But it left nowhere to navigate TO. This is that place.
 *
 * What belongs here rather than on a card: anything that only makes sense for
 * one server at a time. The RCON box above all -- typing `stop` into a box whose
 * target is implied by which card it happens to sit in is a real way to take
 * down the wrong server, so here it is scoped to one server and names it.
 */

function pauseText(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`
}

function Panel({
  title,
  note,
  icon: Icon,
  children,
}: {
  title: string
  note?: string
  icon?: LucideIcon
  children: React.ReactNode
}) {
  return (
    <Card size="sm" className="surface">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[13px] font-semibold tracking-[-0.01em] text-ink">
          {/* A tinted glyph chip, the VoxelDash card-header pattern. The tint
              is the interactive accent, never a state colour: these chips are
              furniture, and green/amber/red stay reserved for verdicts. */}
          {Icon && (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/15 text-sidebar-primary">
              <Icon className="size-3.5" />
            </span>
          )}
          {title}
        </CardTitle>
        {note && (
          <CardDescription className="prose-line text-[11px] leading-relaxed text-faint">
            {note}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

/** Last lines from this server's own console, without leaving the page. */
function LogTail({ lines }: { lines: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null)
  // Same rule as the console view, and not optional here: this panel shows 300
  // lines, and on an idle server all 300 of them were our own poll.
  const tail = lines.filter((l) => l.origin !== 'rcon-probe').slice(-300)

  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  const colour: Record<LogLine['level'], string> = {
    error: 'text-bad',
    warn: 'text-warn',
    info: 'text-ink',
    other: 'text-faint',
  }

  if (tail.length === 0) {
    const suppressed = lines.length - tail.length
    return (
      <p className="prose-line text-[12px] leading-relaxed text-faint">
        {suppressed > 0
          ? `Quiet. The last ${suppressed} lines were all this dashboard's own RCON polling, which the full console can show you.`
          : 'Nothing tailed yet.'}
      </p>
    )
  }

  return (
    <div ref={ref} className="max-h-72 overflow-auto rounded-md border border-border bg-sidebar p-2">
      {tail.map((l) => (
        <div key={l.seq} className={`whitespace-pre font-mono text-[11px] leading-[17px] ${colour[l.level]}`}>
          {l.text}
        </div>
      ))}
    </div>
  )
}

export default function ServerDetail({
  s,
  canEdit,
  lines,
  ensureBacklog,
}: {
  s: ServerStatus
  canEdit: boolean
  lines: LogLine[]
  ensureBacklog: (id: string) => void
}) {
  const v = verdict(s)

  useEffect(() => {
    ensureBacklog(s.id)
  }, [s.id, ensureBacklog])

  const tps = s.tps?.overall ?? null
  const players = s.slp?.playersOnline ?? null
  const maxPlayers = s.slp?.playersMax ?? null
  const ws = s.proc?.workingSetMb ?? null
  const priv = s.proc?.privateMb ?? null
  const residency = ws != null && priv != null && priv > 0 ? Math.round((ws / priv) * 100) : null
  // Colour only when it stops being fine -- see the note in ServerCard.
  const tpsTone = tps == null || tps >= 19.5 ? undefined : tps >= 15 ? 'warn' : 'bad'

  return (
    <div className="mx-auto max-w-6xl">
      {/* No local breadcrumb: the shell's header already reads Servers / name. */}
      <header className="surface rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center gap-3">
          <Indicator tone={v.tone} confidence={v.confidence} large />
          <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">{s.name}</h1>
          <span
            className={`text-[13px] ${
              v.attention ? `font-semibold ${TONE_TEXT[v.tone]}` : 'font-medium text-muted'
            }`}
            title={verdictSentence(v)}
          >
            {v.label}
          </span>
          {v.note && <span className={`text-[12px] ${TONE_TEXT[v.tone]}`}>{v.note}</span>}
          <span className="ml-auto font-mono text-[12px] text-faint">
            {s.slp?.versionName ?? s.kind}
            {s.gamePort ? ` :${s.gamePort}` : ''}
          </span>
        </div>

        <p className="prose-line mt-2.5 text-[13px] leading-relaxed text-muted">{s.healthDetail}</p>

        {s.attributionDetail && (
          <p
            className={`prose-line mt-2.5 rounded-md border px-2.5 py-1.5 text-[12px] leading-relaxed ${
              s.attribution === 'server'
                ? 'border-bad/40 bg-bad/10 text-ink'
                : s.attribution === 'configuration'
                  ? 'border-border bg-secondary text-muted'
                  : 'border-warn/40 bg-warn/10 text-warn'
            }`}
          >
            {s.attributionDetail}
          </p>
        )}

        {s.portConflictWith.length > 0 && (
          <p className="prose-line mt-2 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-warn">
            Port {s.gamePort} is also declared by {s.portConflictWith.join(', ')}. Liveness here is
            resolved by process, not by port.
          </p>
        )}

        {s.classification === 'live' && (
          <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4 lg:grid-cols-6">
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
            >
              {s.gc && <div className="mt-0.5 text-[10px] text-faint">{s.gc.stoppedPercent}% stopped</div>}
            </Metric>
            <Metric label="Resident" value={ws != null ? `${ws} MB` : '–'} tier="lead">
              <Meter value={ws} max={priv} tone="muted" />
              {residency != null && (
                <div className="mt-0.5 text-[10px] text-faint">{residency}% of committed</div>
              )}
            </Metric>
            <Metric label="Uptime" value={age(s.proc?.uptimeSeconds ?? null)} tier="lead" />
          </div>
        )}
      </header>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <div className="space-y-4">
          {canEdit && (
            <Panel title="Controls" icon={SlidersHorizontal}>
              <div className="space-y-3">
                <ControlPanel s={s} canEdit={canEdit} />
                {s.rconConfigured && (s.health !== 'DOWN' || !!s.proc) && (
                  <div className="border-t border-border pt-3">
                    <CommandBox s={s} />
                  </div>
                )}
                {!s.rconConfigured && (
                  <p className="prose-line border-t border-border pt-3 text-[12px] leading-relaxed text-faint">
                    RCON is not enabled in this server's <code className="font-mono">server.properties</code>,
                    so there is no way to reach its main thread. No commands, and no way to tell a
                    stalled server from a healthy one from the port alone.
                  </p>
                )}
              </div>
            </Panel>
          )}

          {s.gc && (
            <Panel
              title="Stop-the-world pauses"
              icon={Activity}
              note="Read from the JVM's own -Xlog:gc log, which is a complete record where the ten-second scan is only a sample."
            >
              <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
                <Metric label="Worst" value={pauseText(s.gc.maxMs)} />
                <Metric label="p99" value={pauseText(s.gc.p99Ms)} />
                <Metric label="Pauses" value={String(s.gc.count)} />
                <Metric label="Not GC" value={String(s.gc.nonGcCount)} />
                <Metric label="Stopped" value={`${s.gc.stoppedPercent}%`} />
                <Metric label="Window read" value={`${s.gc.coveredMinutes} min`} />
                <Metric label="Worst kind" value={s.gc.worstKind ?? '–'} tier="meta" />
                <Metric
                  label="Worst at"
                  value={s.gc.worstAt ? new Date(s.gc.worstAt).toLocaleTimeString() : '–'}
                  tier="meta"
                />
              </div>
              <p className="prose-line mt-2.5 text-[12px] leading-relaxed text-muted">{s.gc.detail}</p>
              {s.gc.truncated && (
                <p className="prose-line mt-2 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-warn">
                  Only {s.gc.coveredMinutes} of the intended {s.gc.windowMinutes} minutes could be read.
                  This server writes its GC log faster than the dashboard reads it, so the real counts
                  are higher than the ones above.
                </p>
              )}
            </Panel>
          )}

          <Panel
            title="Start window"
            icon={Timer}
            note="The window that decides STARTING from HUNG. Measured from this server's own boots where possible, because a platform constant cannot serve both a 16-second Paper server and a 79-second modpack."
          >
            <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
              <Metric
                label="Window"
                value={`${s.boot.graceSeconds}s`}
                tone={s.boot.source === 'measured' ? undefined : 'warn'}
              />
              {/* "platform default" truncates to "platform defa…" in this
                  column. The distinction that matters is measured-or-not, and
                  the sentence below carries the rest. */}
              <Metric
                label="Source"
                value={s.boot.source === 'measured' ? 'measured' : 'default'}
                tone={s.boot.source === 'measured' ? undefined : 'warn'}
              />
              <Metric label="Boots seen" value={String(s.boot.samples)} />
              <Metric label="Longest" value={s.boot.maxSeconds != null ? `${s.boot.maxSeconds}s` : '–'} />
            </div>
            <div className="mt-3">
              <Metric label="Most recent boot" value={s.boot.lastSeconds != null ? `${s.boot.lastSeconds}s` : '–'}>
                <Meter value={s.boot.lastSeconds} max={s.boot.graceSeconds} tone="muted" />
              </Metric>
            </div>
            <p className="prose-line mt-2.5 text-[12px] leading-relaxed text-muted">{s.boot.detail}</p>
            {s.boot.lastPortSeconds != null && s.boot.lastSeconds != null && (
              <p className="prose-line mt-2 text-[12px] leading-relaxed text-faint">
                Its port opened after {s.boot.lastPortSeconds}s, so it spent{' '}
                {s.boot.lastSeconds - s.boot.lastPortSeconds}s listening but still loading. A server
                answering the port is not a server that is ready.
              </p>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Console" icon={Terminal} note="Live tail of this server's latest.log.">
            <LogTail lines={lines} />
            <a
              href={href({ name: 'console' })}
              className="mt-2 inline-block text-[12px] text-muted underline underline-offset-2 transition-colors duration-150 hover:text-ink"
            >
              Open the full console
            </a>
          </Panel>

          <Panel title="Identity" icon={Fingerprint}>
            <div className="grid grid-cols-2 gap-x-5 gap-y-3">
              <Metric label="PID" value={s.proc ? String(s.proc.pid) : '–'} tier="meta" />
              <Metric label="Ping" value={s.slp ? `${s.slp.latencyMs} ms` : '–'} tier="meta" />
              <Metric label="World" value={s.levelName ?? '–'} tier="meta" />
              <Metric label="Platform" value={s.kind} tier="meta" />
              <Metric label="Launcher" value={s.launchStrategy} tier="meta" />
              <Metric label="Classification" value={s.classification} tier="meta" />
            </div>
            <p className="prose-line mt-2.5 break-all font-mono text-[11px] leading-relaxed text-faint">
              {s.dir}
            </p>
            {s.launchStrategy === 'none' && (
              <p className="prose-line mt-2 text-[12px] leading-relaxed text-faint">{s.launchDetail}</p>
            )}
          </Panel>

          {s.players && s.players.length > 0 && (
            <Panel title="Online now" icon={Users}>
              <ul className="flex flex-wrap gap-1.5">
                {s.players.map((p) => (
                  <li key={p}>
                    <Badge variant="secondary" className="font-mono text-[11px]">
                      {p}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {canEdit && (
            <Panel
              title="Settings"
              icon={Settings2}
              note="Written into this server's server.properties. The previous file is kept beside it, dated."
            >
              <ServerSettingsPanel s={s} />
            </Panel>
          )}

          {canEdit && (
            <Panel title="Backup" icon={Archive}>
              <BackupToggle s={s} canEdit={canEdit} />
            </Panel>
          )}
        </div>
      </div>
    </div>
  )
}
