import { useEffect, useRef, useState } from 'react'
import type { ServerStatus, ControlAction, ControlResult, CommandResponse } from '@shared/api'
import { dashboard } from './client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  verdict,
  verdictSentence,
  Indicator,
  Meter,
  Metric,
  TONE_TEXT,
  TONE_BORDER,
  TONE_RAIL,
} from './status'

export function age(sec: number | null): string {
  if (sec === null) return '–'
  if (sec < 90) return `${sec}s`
  if (sec < 5400) return `${Math.round(sec / 60)}m`
  if (sec < 172800) return `${(sec / 3600).toFixed(1)}h`
  return `${Math.round(sec / 86400)}d`
}

function pauseText(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`
}

/**
 * Flash once when the health state actually CHANGES.
 *
 * This is the only animation in the dashboard that is not a response to a click,
 * and it exists because of the standing rule that motion must be reserved for
 * genuine state change. A snapshot arrives every ten seconds; if arrival itself
 * animated, the operator would learn within an hour that movement means nothing,
 * and would then miss the movement that did mean something.
 *
 * So: nothing animates on a snapshot that says the same thing as the last one.
 */
function useStateChangeFlash(key: string): boolean {
  const previous = useRef<string | null>(null)
  const [flashing, setFlashing] = useState(false)

  useEffect(() => {
    // First sighting is not a change -- otherwise every card flashes on load,
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

/**
 * The backup tick.
 *
 * Deliberately worded as a schedule, not as a state of the files. "Backed up"
 * would read as a claim about what is on disk; the checkbox only decides whether
 * the next run includes this directory. The reassurance underneath is there
 * because the obvious fear on unticking a server is that something is about to
 * be thrown away, and the answer is that nothing is.
 */
export function BackupToggle({ s, canEdit }: { s: ServerStatus; canEdit: boolean }) {
  // Optimistic, because the round trip includes a full rescan and a tick that
  // lags a second reads as a tick that did not register.
  const [pending, setPending] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const on = pending ?? s.backupEnabled

  // A snapshot arriving with a different answer wins: the server is the record.
  useEffect(() => {
    setPending((p) => (p === null || p === s.backupEnabled ? null : p))
  }, [s.backupEnabled])

  const toggle = () => {
    const next = !on
    setPending(next)
    setError(null)
    dashboard.setBackupEnabled(s.id, next).catch((e: unknown) => {
      setPending(null)
      setError(e instanceof Error ? e.message : 'could not save')
    })
  }

  return (
    <div>
      <label
        className={`flex items-center gap-2 text-[12px] ${
          canEdit ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
        }`}
        title={
          canEdit
            ? 'Whether the nightly backup includes this directory. Unticking changes the schedule only, archives already written are left exactly where they are.'
            : 'Only an admin can change the backup schedule.'
        }
      >
        <Switch size="sm" checked={on} disabled={!canEdit} onCheckedChange={toggle} />
        <span className={on ? 'text-muted' : 'text-faint'}>
          {on ? 'In the nightly backup' : 'Excluded from the nightly backup'}
        </span>
      </label>
      {!on && (
        <p className="prose-line mt-1 pl-8 text-[11px] leading-relaxed text-faint">
          Existing archives are kept. This only stops new ones being made.
        </p>
      )}
      {error && <p className="mt-1 pl-8 text-[11px] text-bad">{error}</p>}
    </div>
  )
}

/**
 * The one button wrapper every screen uses, now a thin skin over the shadcn
 * Button so hover, focus ring and disabled states are identical everywhere.
 * `danger` maps to destructive: the armed state of a stop/restart SHOULD be
 * the loudest interactive element on the page. `primary` is for the one
 * affirmative action in a group (Start, Send); everything else stays quiet.
 */
export function Btn({
  onClick,
  label,
  disabled,
  tone,
  title,
}: {
  onClick: () => void
  label: string
  disabled?: boolean
  tone?: 'danger' | 'primary'
  title?: string
}) {
  return (
    <Button
      variant={tone === 'danger' ? 'destructive' : tone === 'primary' ? 'default' : 'outline'}
      size="sm"
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {label}
    </Button>
  )
}

/**
 * Start / stop / restart.
 *
 * Two deliberate choices kept from the original:
 *
 * 1. **Stop and restart need a second click.** Not a modal. An inline
 *    arm/confirm on the button itself, which names the consequence including how
 *    many players are online. These actions take a server away from people who
 *    are using it, and a misclick next to "Refresh" should not be able to do it.
 *
 * 2. **No start button when the launcher is unknown**, with the reason shown
 *    instead. Offering a button that cannot work is worse than offering none,
 *    and guessing a command line is how a second JVM lands on a live world.
 *
 * The RCON command box is NOT here. It lives in the per-server detail view,
 * where exactly one server is on screen and named beside the input.
 */
export function ControlPanel({ s, canEdit }: { s: ServerStatus; canEdit: boolean }) {
  const [armed, setArmed] = useState<'stop' | 'restart' | null>(null)
  const [pending, setPending] = useState<ControlAction | null>(null)
  const [result, setResult] = useState<ControlResult | null>(null)

  const busy = pending !== null || s.controlBusy
  const players = s.players?.length ?? s.slp?.playersOnline ?? 0
  const runnable = s.health !== 'DOWN' || !!s.proc
  const canStart = s.launchStrategy !== 'none'

  const run = (action: ControlAction) => {
    if (action === 'command') return
    setArmed(null)
    setPending(action)
    setResult(null)
    dashboard
      .control(s.id, action)
      .then(setResult)
      .catch((e: unknown) =>
        setResult({
          server: s.name,
          action,
          ok: false,
          detail: e instanceof Error ? e.message : 'request failed',
          at: new Date().toISOString(),
        }),
      )
      .finally(() => setPending(null))
  }

  if (!canEdit) return null

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {!runnable && canStart && (
          <Btn
            onClick={() => run('start')}
            disabled={busy}
            tone="primary"
            label={pending === 'start' ? 'Starting…' : 'Start'}
          />
        )}
        {!runnable && !canStart && (
          <span className="prose-line text-[11px] leading-relaxed text-faint">
            Start not available: {s.launchDetail}
          </span>
        )}
        {runnable && (
          <>
            <Btn
              onClick={() => (armed === 'stop' ? run('stop') : setArmed('stop'))}
              disabled={busy}
              tone={armed === 'stop' ? 'danger' : undefined}
              label={
                pending === 'stop'
                  ? 'Stopping…'
                  : armed === 'stop'
                    ? players > 0
                      ? `Confirm. ${players} online`
                      : 'Confirm stop'
                    : 'Stop'
              }
            />
            <Btn
              onClick={() => (armed === 'restart' ? run('restart') : setArmed('restart'))}
              disabled={busy || !canStart}
              tone={armed === 'restart' ? 'danger' : undefined}
              label={
                pending === 'restart'
                  ? 'Restarting…'
                  : armed === 'restart'
                    ? players > 0
                      ? `Confirm. ${players} online`
                      : 'Confirm restart'
                    : 'Restart'
              }
              title={canStart ? undefined : `Cannot restart: ${s.launchDetail}`}
            />
            {armed && (
              <button
                type="button"
                onClick={() => setArmed(null)}
                className="text-[11px] text-muted underline underline-offset-2 hover:text-ink"
              >
                cancel
              </button>
            )}
          </>
        )}
        <span className="ml-auto font-mono text-[10px] text-faint">
          {s.launchStrategy === 'none' ? 'no launcher' : s.launchStrategy}
        </span>
      </div>

      {/* The server's own sentence is the result. A refusal from the guard reads
          "already running as pid 9876…" and that is what gets shown, verbatim.
          Replacing it with "Failed" would discard the only useful part. */}
      {result && (
        <p
          className={`prose-line mt-2 rounded-md border px-2 py-1.5 text-[12px] leading-relaxed ${
            result.ok ? 'border-ok/40 bg-ok/10 text-ink' : 'border-warn/40 bg-warn/10 text-warn'
          }`}
        >
          {result.detail}
        </p>
      )}
    </div>
  )
}

/** The RCON command box. One server, named beside the input. See detail view. */
export function CommandBox({ s }: { s: ServerStatus }) {
  const [command, setCommand] = useState('')
  const [reply, setReply] = useState<CommandResponse | null>(null)

  const send = () => {
    const c = command.trim()
    if (!c) return
    setReply(null)
    dashboard
      .runCommand(s.id, c)
      .then((r) => {
        setReply(r)
        if (r.ok) setCommand('')
      })
      .catch((e: unknown) =>
        setReply({ ok: false, raw: '', latencyMs: 0, detail: e instanceof Error ? e.message : 'failed' }),
      )
  }

  return (
    <div>
      {/*
        The target is named on screen, not implied by which card the box sits in.
        A global command box makes "stop" ambiguous, and the cost of aiming it at
        the wrong server is that server going down with players on it.
      */}
      <label className="mb-1.5 flex items-baseline gap-1.5 text-[11px] text-faint" htmlFor={`cmd-${s.id}`}>
        Send an RCON command to
        <span className="font-medium text-ink">{s.name}</span>
      </label>
      <div className="flex gap-2">
        <span
          aria-hidden="true"
          className="flex select-none items-center rounded-md border border-border bg-secondary px-2 font-mono text-[11px] text-muted"
        >
          {s.name}
        </span>
        <Input
          id={`cmd-${s.id}`}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
          placeholder="e.g. list"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 font-mono text-[12px]"
        />
        <Btn onClick={send} disabled={!command.trim()} tone="primary" label="Send" />
      </div>
      {reply && (
        <pre
          className={`mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border px-2 py-1.5 font-mono text-[11px] leading-relaxed ${
            reply.ok ? 'border-edge bg-bg text-ink' : 'border-warn/40 bg-warn/10 text-warn'
          }`}
        >
          {reply.ok ? reply.raw || '(no output)' : reply.detail}
        </pre>
      )}
    </div>
  )
}

/** A bordered explanation. The prose is the product, so it gets room. */
function Note({ tone, children }: { tone: 'bad' | 'warn' | 'muted'; children: React.ReactNode }) {
  const cls =
    tone === 'bad'
      ? 'border-bad/40 bg-bad/10 text-ink'
      : tone === 'warn'
        ? 'border-warn/40 bg-warn/10 text-warn'
        : 'border-edge bg-panel2 text-muted'
  return (
    <p className={`prose-line rounded-md border px-2.5 py-1.5 text-[12px] leading-relaxed ${cls}`}>
      {children}
    </p>
  )
}

export function ServerCard({
  s,
  canEdit = false,
  onOpen,
}: {
  s: ServerStatus
  canEdit?: boolean
  onOpen?: (id: string) => void
}) {
  const v = verdict(s)
  const dim = s.classification !== 'live'
  const flashing = useStateChangeFlash(`${s.health}:${s.attribution ?? ''}`)

  const tps = s.tps?.overall ?? null
  const players = s.slp?.playersOnline ?? null
  const maxPlayers = s.slp?.playersMax ?? null

  // Working set against private bytes -- how much of what this JVM has committed
  // is actually resident. NOT "of heap": the heap ceiling is not on the wire, and
  // inventing a denominator is the failure mode this whole project argues against.
  const ws = s.proc?.workingSetMb ?? null
  const priv = s.proc?.privateMb ?? null
  const residency = ws != null && priv != null && priv > 0 ? Math.round((ws / priv) * 100) : null

  // Undefined, not 'ok', when the tick rate is fine. A healthy server always
  // reads 20.0, so colouring it green would put the brightest thing on the page
  // on every healthy card -- and then colour means "nothing to report" again,
  // which is exactly the failure the palette was rebuilt to fix. Colour arrives
  // only when the number stops being fine.
  const tpsTone = tps == null || tps >= 19.5 ? undefined : tps >= 15 ? 'warn' : 'bad'

  return (
    <article
      className={`surface rail overflow-hidden rounded-xl border bg-card transition-[transform,border-color,box-shadow] duration-150 ${
        TONE_RAIL[v.tone]
      } ${v.confidence === 'unmeasured' ? 'rail-dashed' : ''} ${TONE_BORDER[v.tone]} ${
        dim ? 'opacity-60' : ''
      } ${flashing ? `state-changed ${TONE_TEXT[v.tone]}` : ''} ${
        onOpen ? 'cursor-pointer hover:-translate-y-px hover:border-edge-strong' : ''
      }`}
      onClick={onOpen ? () => onOpen(s.id) : undefined}
    >
      {/*
        A header band on its own surface, so a card has anatomy: who this is,
        then what is true of it. Previously the name, the verdict, the prose and
        eleven figures ran together in one undifferentiated block, which is most
        of why the card had no shape to read at a glance.
      */}
      <header className="flex items-center gap-2.5 border-b border-border/70 bg-secondary/60 px-4 py-3">
        <Indicator tone={v.tone} confidence={v.confidence} large={v.attention} />
        <h3 className="truncate text-[15px] font-semibold tracking-[-0.02em] text-ink">{s.name}</h3>
        {/*
          Healthy renders colourless. If green appeared on four healthy cards,
          colour would mean "nothing to report", so any colour on the page would
          stop meaning attention. This is the half-second read.
        */}
        <span
          className={`text-[12px] ${
            v.attention ? `font-semibold ${TONE_TEXT[v.tone]}` : 'font-medium text-muted'
          }`}
          title={verdictSentence(v)}
        >
          {v.label}
        </span>
        {v.note && <span className={`truncate text-[11px] ${TONE_TEXT[v.tone]}`}>{v.note}</span>}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">
          {s.slp?.versionName ?? s.kind}
          {s.gamePort ? ` :${s.gamePort}` : ''}
        </span>
      </header>

      <div className="px-4 py-4">
        <p className="prose-line text-[12px] leading-relaxed text-muted">{s.healthDetail}</p>

        {/*
          These two sit ABOVE the figures, and that is not a layout preference.

          The GC note contradicts the numbers below it -- TPS reads 20.0 straight
          through a freeze, because a ten-second scan samples and the JVM's pause
          log is complete. Putting the contradiction after the thing it
          contradicts means the reader has already believed the wrong number.

          The attribution note is the answer to "whose fault is this", which is
          the question the whole product exists to answer. It does not go below
          the fold of a card.
        */}
        {(s.attributionDetail || (s.gc && s.gc.severity !== 'ok')) && (
          <div className="mt-3 space-y-2">
            {s.attributionDetail && (
              <Note tone={s.attribution === 'server' ? 'bad' : s.attribution === 'configuration' ? 'muted' : 'warn'}>
                {s.attributionDetail}
              </Note>
            )}
            {s.gc && s.gc.severity !== 'ok' && <Note tone="warn">{s.gc.detail}</Note>}
          </div>
        )}

        {s.classification === 'live' && (
          <>
            {/* Lead: does it serve players, and is the main thread alive. */}
            <div className="mt-3 grid grid-cols-3 gap-x-4">
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
                {/* 20 is the tick ceiling by definition, so this ratio is real. */}
                <Meter value={tps} max={20} tone={tpsTone ?? 'muted'} />
              </Metric>
              <Metric
                label="RCON"
                value={s.rcon?.ok ? `${s.rcon.latencyMs} ms` : s.rcon ? 'no reply' : '–'}
                tier="lead"
                tone={s.rcon && !s.rcon.ok ? 'bad' : undefined}
                title="Round trip to the main game thread. The only probe that can tell a stalled server from a healthy one."
              />
            </div>

            {/* Body: is it degrading. */}
            <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-2.5 border-t border-edge pt-2.5">
              <Metric
                label="Worst pause"
                value={s.gc ? pauseText(s.gc.maxMs) : '–'}
                tone={s.gc?.severity === 'severe' ? 'bad' : s.gc?.severity === 'noticeable' ? 'warn' : undefined}
                title={
                  s.gc
                    ? `${s.gc.count} stop-the-world pauses in the last ${s.gc.coveredMinutes} min, totalling ${s.gc.totalMs} ms. ${s.gc.nonGcCount} were not garbage collection.` +
                      (s.gc.truncated
                        ? ` Only ${s.gc.coveredMinutes} of the intended ${s.gc.windowMinutes} min could be read. This server writes its GC log faster than the dashboard reads it, so the true counts are higher.`
                        : '')
                    : 'This server was not started with -Xlog:gc, so its pauses are invisible to the dashboard.'
                }
              >
                {/* stoppedPercent is computed server-side and is a true ratio. */}
                {s.gc && (
                  <div className="mt-0.5 text-[10px] text-faint">{s.gc.stoppedPercent}% stopped</div>
                )}
              </Metric>
              <Metric
                label="Resident"
                value={ws != null ? `${ws} MB` : '–'}
                title={
                  priv != null
                    ? `${ws} MB resident of ${priv} MB committed by this process. This is residency, not heap usage. The heap ceiling is not something the dashboard can see.`
                    : 'Working set could not be read.'
                }
              >
                <Meter value={ws} max={priv} tone="muted" />
                {residency != null && (
                  <div className="mt-0.5 text-[10px] text-faint">{residency}% of committed</div>
                )}
              </Metric>
              <Metric label="Uptime" value={age(s.proc?.uptimeSeconds ?? null)} />
            </div>

            {/* Meta: identity and provenance. Present, quiet, never competing.
                An inline bordered strip (the VoxelDash pattern): one hairline
                container instead of five floating figures. */}
            <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-2 rounded-lg border border-border/70 bg-background/40 px-3 py-2 sm:grid-cols-5">
              <Metric label="PID" value={s.proc ? String(s.proc.pid) : '–'} tier="meta" />
              <Metric label="Ping" value={s.slp ? `${s.slp.latencyMs} ms` : '–'} tier="meta" />
              <Metric label="World" value={s.levelName ?? '–'} tier="meta" />
              {/*
                The window that decides STARTING vs HUNG, shown with its
                provenance. A number from this server's own boots and one guessed
                from its platform are worth different amounts, and this card is
                where someone reads a HUNG verdict and decides whether to believe
                it. The `?` is the tell that it has not been measured yet.
              */}
              <Metric
                label="Start window"
                value={s.boot.source === 'measured' ? `${s.boot.graceSeconds}s` : `${s.boot.graceSeconds}s?`}
                tier="meta"
                title={s.boot.detail}
              />
              <Metric
                label="Last boot"
                value={s.boot.lastSeconds != null ? `${s.boot.lastSeconds}s` : '–'}
                tier="meta"
                title={
                  s.boot.lastSeconds == null
                    ? 'This server has not been watched starting yet. A measurement is taken the next time it boots from cold. The nightly backup restart produces one for free.'
                    : `Process start to answering with a real version: ${s.boot.lastSeconds}s.` +
                      (s.boot.lastPortSeconds != null
                        ? ` Its port opened after ${s.boot.lastPortSeconds}s, so it spent ${s.boot.lastSeconds - s.boot.lastPortSeconds}s listening but still loading.`
                        : '') +
                      ` ${s.boot.samples} boot${s.boot.samples === 1 ? '' : 's'} measured, longest ${s.boot.maxSeconds}s.`
                }
              >
                {/* Last boot against the window is the STARTING-vs-HUNG decision
                    made visible: a bar near full means the next slow boot is
                    going to be called HUNG. */}
                <Meter
                  value={s.boot.lastSeconds}
                  max={s.boot.graceSeconds}
                  tone="muted"
                  title="Most recent boot as a fraction of the window that decides STARTING vs HUNG."
                />
              </Metric>
            </div>
          </>
        )}

        {/* Context rather than verdict, so these sit below the figures. */}
        {(s.portConflictWith.length > 0 || (s.players && s.players.length > 0)) && (
          <div className="mt-3 space-y-2">
            {s.portConflictWith.length > 0 && (
              <Note tone="warn">
                Port {s.gamePort} is also declared by {s.portConflictWith.join(', ')}. Liveness here is
                resolved by process, not by port.
              </Note>
            )}
            {s.players && s.players.length > 0 && (
              <p className="prose-line text-[12px] text-muted">
                <span className="text-faint">Online: </span>
                <span className="text-ink">{s.players.join(', ')}</span>
              </p>
            )}
          </div>
        )}
      </div>

      {canEdit && (
        <div
          className="space-y-2.5 border-t border-border bg-secondary/40 px-4 py-3.5"
          // Controls are not a navigation target: clicking Stop should not also
          // open the detail view underneath the confirmation.
          onClick={(e) => e.stopPropagation()}
        >
          <ControlPanel s={s} canEdit={canEdit} />
          <BackupToggle s={s} canEdit={canEdit} />
        </div>
      )}
    </article>
  )
}
