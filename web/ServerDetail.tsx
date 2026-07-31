import { useCallback, useEffect, useRef, useState } from 'react'
import type { ServerStatus, LogLine } from '@shared/api'
import { verdict, verdictSentence, Indicator, Meter, Metric, TONE_TEXT } from './status'
import { ControlPanel, BackupToggle, CommandBox, Btn, age } from './controls'
import { formatMc } from './mcformat'
import { dashboard } from './client'
import { Input } from '@/components/ui/input'
import ServerSettingsPanel from './ServerSettings'
import { href, type ServerPage } from './router'

/**
 * The per-server surfaces: Overview, Players, Console, Backups, Settings.
 *
 * Overview is a monitoring surface and keeps the board grammar: sections
 * separated by hairline rules, mono uppercase labels, no cards, no icon
 * chips. Players, Backups and Settings are management surfaces: ordinary
 * forms inside the same visual language (DESIGN.md, operator amendment).
 *
 * Layout law 6 is enforced here: every two-column grid uses minmax(0, fr)
 * tracks with a guaranteed minimum on the left column, and the log pane
 * scrolls horizontally inside its column rather than resizing it. One long
 * GTNH log line must never starve the controls into a six-word column.
 */

function pauseText(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`
}

/** A board section: hairline rule, mono label, the reason, the content. */
function Section({
  label,
  note,
  children,
}: {
  label: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className="border-t border-border/60 pt-3 pb-6">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{label}</h2>
      {note && <p className="prose-line mt-1 text-[11px] leading-relaxed text-faint">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

/** Last lines from this server's own console. Law 6: the pane never grows. */
function LogTail({ lines, maxHeight = 'max-h-80' }: { lines: LogLine[]; maxHeight?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  // Same rule as the console view, and not optional here: on an idle server
  // every line was our own poll.
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
          ? `Quiet. The last ${suppressed} lines were all this dashboard's own RCON polling, which the console page can show you.`
          : 'Nothing tailed yet.'}
      </p>
    )
  }

  return (
    <div
      ref={ref}
      className={`min-w-0 ${maxHeight} overflow-auto rounded-md border border-border bg-sidebar p-2`}
    >
      {tail.map((l) => (
        <div
          key={l.seq}
          className={`whitespace-pre font-mono text-[11px] leading-[17px] ${colour[l.level]}`}
        >
          {formatMc(l.text)}
        </div>
      ))}
    </div>
  )
}

/** The shared masthead: who this is and what is true of it right now. */
function Masthead({ s, full }: { s: ServerStatus; full: boolean }) {
  const v = verdict(s)
  return (
    <header
      className={`rail border-b border-border pb-4 pl-5 ${TONE_TEXT[v.tone]} ${
        v.confidence === 'unmeasured' ? 'rail-dashed' : ''
      }`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Indicator tone={v.tone} confidence={v.confidence} large />
        <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">{s.name}</h1>
        <span
          className={`text-[13px] ${
            v.attention ? `font-semibold ${TONE_TEXT[v.tone]}` : 'font-medium text-muted-foreground'
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
      {full && (
        <p className="prose-line mt-2 text-[13px] leading-relaxed text-muted-foreground">
          {s.healthDetail}
        </p>
      )}
    </header>
  )
}

export default function ServerPages({
  s,
  page,
  canEdit,
  lines,
  ensureBacklog,
}: {
  s: ServerStatus
  page: ServerPage
  canEdit: boolean
  lines: LogLine[]
  ensureBacklog: (id: string) => void
}) {
  useEffect(() => {
    ensureBacklog(s.id)
  }, [s.id, ensureBacklog])

  return (
    <div className="mx-auto max-w-6xl">
      <Masthead s={s} full={page === 'overview'} />
      <div className="mt-4">
        {page === 'overview' && <Overview s={s} canEdit={canEdit} />}
        {page === 'players' && <Players s={s} canEdit={canEdit} />}
        {page === 'console' && <ConsolePage s={s} canEdit={canEdit} lines={lines} />}
        {page === 'backups' && <Backups s={s} canEdit={canEdit} />}
        {page === 'settings' &&
          (canEdit ? (
            <Section
              label="Settings"
              note="Written into this server's server.properties. The previous file is kept beside it, dated."
            >
              <ServerSettingsPanel s={s} />
            </Section>
          ) : (
            <p className="prose-line text-[12px] text-faint">Only an admin can change settings.</p>
          ))}
      </div>
    </div>
  )
}

function Overview({ s, canEdit }: { s: ServerStatus; canEdit: boolean }) {
  const tps = s.tps?.overall ?? null
  const players = s.slp?.playersOnline ?? null
  const maxPlayers = s.slp?.playersMax ?? null
  const ws = s.proc?.workingSetMb ?? null
  const priv = s.proc?.privateMb ?? null
  const residency = ws != null && priv != null && priv > 0 ? Math.round((ws / priv) * 100) : null
  const tpsTone = tps == null || tps >= 19.5 ? undefined : tps >= 15 ? 'warn' : 'bad'

  return (
    <>
      {s.attributionDetail && (
        <p
          className={`prose-line mb-3 rounded-md border px-2.5 py-1.5 text-[12px] leading-relaxed ${
            s.attribution === 'server'
              ? 'border-bad/40 bg-bad/10 text-ink'
              : s.attribution === 'configuration'
                ? 'border-border bg-secondary text-muted-foreground'
                : 'border-warn/40 bg-warn/10 text-warn'
          }`}
        >
          {s.attributionDetail}
        </p>
      )}
      {s.portConflictWith.length > 0 && (
        <p className="prose-line mb-3 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-warn">
          Port {s.gamePort} is also declared by {s.portConflictWith.join(', ')}. Liveness here is
          resolved by process, not by port.
        </p>
      )}

      {s.classification === 'live' && (
        <div className="mb-5 grid grid-cols-3 gap-x-6 gap-y-3 lg:grid-cols-6">
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

      {/* Law 6: minmax(0, fr) tracks; the left column keeps a real minimum. */}
      <div className="grid gap-x-8 lg:grid-cols-[minmax(300px,1.15fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          {canEdit && (
            <Section label="Controls">
              <ControlPanel s={s} canEdit={canEdit} />
            </Section>
          )}

          {s.gc && (
            <Section
              label="Stop-the-world pauses"
              note="Read from the JVM's own -Xlog:gc log, a complete record where the ten-second scan is only a sample."
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
              <p className="prose-line mt-2.5 text-[12px] leading-relaxed text-muted-foreground">
                {s.gc.detail}
              </p>
              {s.gc.truncated && (
                <p className="prose-line mt-2 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-warn">
                  Only {s.gc.coveredMinutes} of the intended {s.gc.windowMinutes} minutes could be
                  read. This server writes its GC log faster than the dashboard reads it, so the
                  real counts are higher than the ones above.
                </p>
              )}
            </Section>
          )}

          <Section
            label="Start window"
            note="The window that decides STARTING from HUNG, measured from this server's own boots where possible."
          >
            <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
              <Metric
                label="Window"
                value={`${s.boot.graceSeconds}s`}
                tone={s.boot.source === 'measured' ? undefined : 'warn'}
              />
              <Metric
                label="Source"
                value={s.boot.source === 'measured' ? 'measured' : 'default'}
                tone={s.boot.source === 'measured' ? undefined : 'warn'}
              />
              <Metric label="Boots seen" value={String(s.boot.samples)} />
              <Metric label="Longest" value={s.boot.maxSeconds != null ? `${s.boot.maxSeconds}s` : '–'} />
            </div>
            <div className="mt-3">
              <Metric
                label="Most recent boot"
                value={s.boot.lastSeconds != null ? `${s.boot.lastSeconds}s` : '–'}
              >
                <Meter value={s.boot.lastSeconds} max={s.boot.graceSeconds} tone="muted" />
              </Metric>
            </div>
            <p className="prose-line mt-2.5 text-[12px] leading-relaxed text-muted-foreground">
              {s.boot.detail}
            </p>
            {s.boot.lastPortSeconds != null && s.boot.lastSeconds != null && (
              <p className="prose-line mt-2 text-[12px] leading-relaxed text-faint">
                Its port opened after {s.boot.lastPortSeconds}s, so it spent{' '}
                {s.boot.lastSeconds - s.boot.lastPortSeconds}s listening but still loading. A
                server answering the port is not a server that is ready.
              </p>
            )}
          </Section>
        </div>

        <div className="min-w-0">
          <Section label="Identity">
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
          </Section>
        </div>
      </div>
    </>
  )
}

/**
 * The live whitelist arrives over the same audited RCON route as any other
 * command: `whitelist list`, parsed. The reply is the server's own record of
 * what is enforced RIGHT NOW, which the file cannot promise (a file edit
 * waits for a restart; the command does not).
 */
function parseWhitelist(raw: string): string[] {
  const stripped = raw.replace(/§[0-9a-fk-orA-FK-OR]?/g, '')
  const idx = stripped.lastIndexOf(':')
  if (idx < 0) return []
  return stripped
    .slice(idx + 1)
    .split(/,|\band\b/)
    .map((t) => t.trim())
    .filter((t) => /^[A-Za-z0-9_]{1,16}$/.test(t))
}

const NAME_RE = /^[A-Za-z0-9_]{1,16}$/

/** Management surface: who is on, and who is allowed on. */
function Players({ s, canEdit }: { s: ServerStatus; canEdit: boolean }) {
  const online = s.players ?? []
  const slpCount = s.slp?.playersOnline ?? null
  const runnable = s.health !== 'DOWN' || !!s.proc
  const manageable = canEdit && s.rconConfigured && runnable

  const [names, setNames] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [armed, setArmed] = useState<string | null>(null)
  const [addName, setAddName] = useState('')

  const load = useCallback(() => {
    setErr(null)
    dashboard
      .runCommand(s.id, 'whitelist list')
      .then((r) => {
        if (r.ok) setNames(parseWhitelist(r.raw))
        else setErr(r.detail ?? 'whitelist list failed')
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'whitelist list failed'))
  }, [s.id])

  useEffect(() => {
    if (manageable) load()
  }, [manageable, load])

  const run = (command: string) => {
    setBusy(true)
    setErr(null)
    dashboard
      .runCommand(s.id, command)
      .then((r) => {
        if (!r.ok) setErr(r.detail ?? `${command} failed`)
        load()
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : `${command} failed`))
      .finally(() => setBusy(false))
  }

  const add = () => {
    const name = addName.trim()
    if (!NAME_RE.test(name)) {
      setErr(`"${name}" is not a valid Minecraft name (letters, digits, underscore, up to 16).`)
      return
    }
    setAddName('')
    run(`whitelist add ${name}`)
  }

  return (
    <>
      <Section
        label="Online now"
        note={
          s.rconConfigured
            ? 'Names come from the main game thread over RCON.'
            : 'Without RCON only the count from the status ping is available, and it can lag.'
        }
      >
        {online.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {online.map((p) => (
              <li
                key={p}
                className="rounded-md border border-border bg-secondary px-2 py-0.5 font-mono text-[11px] text-ink"
              >
                {p}
              </li>
            ))}
          </ul>
        ) : (
          <p className="prose-line text-[12px] text-faint">
            No one is online
            {slpCount != null && slpCount > 0 ? `, though the ping reports ${slpCount}` : ''}.
          </p>
        )}
      </Section>

      {canEdit && (
        <Section
          label="Whitelist"
          note="Read from and written to the running server over the audited RCON route. This is what is enforced right now; the white-list switch in Settings edits the file, which waits for a restart."
        >
          {!s.rconConfigured ? (
            <p className="prose-line text-[12px] text-faint">
              RCON is not enabled, so the live whitelist cannot be read or changed from here.
            </p>
          ) : !runnable ? (
            <p className="prose-line text-[12px] text-faint">
              The server is not running, so there is no live whitelist to manage. The file can
              still be toggled in Settings.
            </p>
          ) : (
            <>
              {s.settings && !s.settings.whitelist && (
                <p className="prose-line mb-2.5 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-warn">
                  server.properties currently says white-list=false, so after the next restart
                  this list stops being enforced. The switch in Settings changes the file.
                </p>
              )}
              {names === null && !err && (
                <p className="text-[12px] text-faint">Reading the whitelist…</p>
              )}
              {names !== null && (
                <ul className="flex flex-wrap items-center gap-1.5">
                  {names.length === 0 && (
                    <li className="text-[12px] text-faint">The whitelist is empty.</li>
                  )}
                  {names.map((n) =>
                    armed === n ? (
                      <li key={n} className="flex items-center gap-1.5">
                        <Btn
                          tone="danger"
                          disabled={busy}
                          onClick={() => {
                            setArmed(null)
                            run(`whitelist remove ${n}`)
                          }}
                          label={`Remove ${n}`}
                        />
                        <button
                          type="button"
                          onClick={() => setArmed(null)}
                          className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-ink"
                        >
                          cancel
                        </button>
                      </li>
                    ) : (
                      <li key={n}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setArmed(n)}
                          title={`Remove ${n} from the whitelist (asks to confirm)`}
                          className="rounded-md border border-border bg-secondary px-2 py-0.5 font-mono text-[11px] text-ink transition-colors duration-150 hover:border-bad/60 hover:text-bad"
                        >
                          {n} <span aria-hidden="true">×</span>
                        </button>
                      </li>
                    ),
                  )}
                </ul>
              )}
              <div className="mt-3 flex max-w-sm gap-2">
                <Input
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') add()
                  }}
                  placeholder="Exact name, capitalization matters offline"
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono text-[12px]"
                />
                <Btn onClick={add} disabled={busy || !addName.trim()} tone="primary" label="Add" />
              </div>
              {err && <p className="prose-line mt-2 text-[12px] text-bad">{err}</p>}
            </>
          )}
        </Section>
      )}
    </>
  )
}

/** Monitoring surface: this server's own tail, and the command bar. */
function ConsolePage({ s, canEdit, lines }: { s: ServerStatus; canEdit: boolean; lines: LogLine[] }) {
  const runnable = s.health !== 'DOWN' || !!s.proc
  return (
    <>
      <Section label="Console" note="Live tail of this server's latest.log, RCON polling filtered.">
        <LogTail lines={lines} maxHeight="max-h-[55dvh]" />
        <a
          href={href({ name: 'console' })}
          className="mt-2 inline-block text-[12px] text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-ink"
        >
          Open the fleet console
        </a>
      </Section>
      {canEdit && s.rconConfigured && runnable && (
        <Section label="Command">
          <CommandBox s={s} />
        </Section>
      )}
      {canEdit && !s.rconConfigured && (
        <Section label="Command">
          <p className="prose-line text-[12px] leading-relaxed text-faint">
            RCON is not enabled in this server's <code className="font-mono">server.properties</code>,
            so there is no way to reach its main thread. No commands, and no way to tell a stalled
            server from a healthy one from the port alone.
          </p>
        </Section>
      )}
    </>
  )
}

/** Management surface: the schedule opt-in. The dashboard owns no backups. */
function Backups({ s, canEdit }: { s: ServerStatus; canEdit: boolean }) {
  return (
    <Section
      label="Backups"
      note="Backups are made by the external backup system this dashboard detected, on its own schedule. The dashboard schedules, runs and deletes nothing."
    >
      <BackupToggle s={s} canEdit={canEdit} />
      <p className="prose-line mt-3 text-[12px] leading-relaxed text-faint">
        The switch decides whether the next nightly run includes this directory. Archives already
        written are never touched, whichever way it points.
      </p>
    </Section>
  )
}
