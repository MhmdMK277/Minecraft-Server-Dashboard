import { useEffect, useState } from 'react'
import type { ServerStatus, ControlAction, ControlResult, CommandResponse } from '@shared/api'
import { dashboard } from './client'
import { formatMc } from './mcformat'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

/**
 * Shared control widgets, used by the per-server surfaces. Nothing here
 * renders on the fleet board: the board is a monitoring surface, and
 * destructive controls live inside a server's own pages (DESIGN.md).
 */

export function age(sec: number | null): string {
  if (sec === null) return '–'
  if (sec < 90) return `${sec}s`
  if (sec < 5400) return `${Math.round(sec / 60)}m`
  if (sec < 172800) return `${(sec / 3600).toFixed(1)}h`
  return `${Math.round(sec / 86400)}d`
}

/** A board section label: mono, uppercase, tracked, with its reason beneath. */
export function SectionHead({ title, note }: { title: string; note: string }) {
  return (
    <header className="mb-2 border-b border-border/60 pb-2">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{title}</h2>
      <p className="prose-line mt-1 text-[12px] leading-relaxed text-faint">{note}</p>
    </header>
  )
}

/** A bordered explanation. The prose is the product, so it gets room. */
export function Note({ tone, children }: { tone: 'bad' | 'warn' | 'muted'; children: React.ReactNode }) {
  const cls =
    tone === 'bad'
      ? 'border-bad/40 bg-bad/10 text-ink'
      : tone === 'warn'
        ? 'border-warn/40 bg-warn/10 text-warn'
        : 'border-border bg-secondary text-muted-foreground'
  return (
    <p className={`prose-line rounded-md border px-2.5 py-1.5 text-[12px] leading-relaxed ${cls}`}>
      {children}
    </p>
  )
}

/**
 * The one button wrapper every screen uses, a thin skin over the shadcn
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
 * The backup tick.
 *
 * Worded as what it IS: intent recorded in a policy file that an external
 * script may read. Not as a schedule ("nightly" was an assumption imported
 * from one machine's Task Scheduler job) and never as a state of the files
 * ("backed up" would claim something no code here verifies). The reassurance
 * underneath is there because the obvious fear on unticking a server is that
 * something is about to be thrown away, and the answer is that nothing is.
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
            ? 'Whether backup-policy.json lists this directory as included. Only a backup script that reads that file acts on it; archives already written are left exactly where they are.'
            : 'Only an admin can change the backup policy file.'
        }
      >
        <Switch size="sm" checked={on} disabled={!canEdit} onCheckedChange={toggle} />
        <span className={on ? 'text-muted-foreground' : 'text-faint'}>
          {on ? 'Included in the policy file' : 'Excluded in the policy file'}
        </span>
      </label>
      {!on && (
        <p className="prose-line mt-1 pl-8 text-[11px] leading-relaxed text-faint">
          Existing archives are kept. This only records intent; a script that honours the file
          stops making new ones.
        </p>
      )}
      {error && <p className="mt-1 pl-8 text-[11px] text-bad">{error}</p>}
    </div>
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
 *    are using it, and a misclick should not be able to do it.
 *
 * 2. **No start button when the launcher is unknown**, with the reason shown
 *    instead. Offering a button that cannot work is worse than offering none,
 *    and guessing a command line is how a second JVM lands on a live world.
 */
export function ControlPanel({ s, canEdit }: { s: ServerStatus; canEdit: boolean }) {
  const [armed, setArmed] = useState<'stop' | 'restart' | null>(null)
  const [pending, setPending] = useState<ControlAction | null>(null)
  const [result, setResult] = useState<ControlResult | null>(null)

  const busy = pending !== null || s.controlBusy
  const players = s.players?.length ?? s.slp?.playersOnline ?? 0
  const runnable = s.health !== 'DOWN' || !!s.proc
  const canStart = s.launchStrategy !== 'none'
  /**
   * Start is offered whenever NO process is attributed to this directory,
   * including UNKNOWN. It used to hide behind `!runnable`, which made UNKNOWN
   * a dead end: a stopped server under fleet-wide identity doubt showed only
   * Stop/Restart, and the defect-6 acknowledgment path (which lives behind a
   * start ATTEMPT) was unreachable exactly when it was needed. The safety is
   * not this button's visibility: startServer re-checks identity inside its
   * lock and refuses under doubt, naming what it cannot account for.
   */
  const startable = !s.proc && canStart
  const uncertain = s.health === 'UNKNOWN' && !s.proc

  const run = (action: ControlAction, acknowledged?: Array<{ pid: number; startedAt: string }>) => {
    if (action === 'command') return
    setArmed(null)
    setPending(action)
    setResult(null)
    dashboard
      .control(s.id, action, acknowledged)
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

  /**
   * The defect-6 path: a start refusal that names the processes the guard
   * could not account for offers an explicit acknowledgment. Only entries
   * with a readable start time are sendable: the acknowledgment is pinned
   * to (pid, start time) because Windows recycles pids, and the server
   * re-verifies both against a fresh scan before acting.
   */
  const ackable =
    result && !result.ok && result.action === 'start' && result.unaccounted
      ? result.unaccounted.filter((u) => u.startedAt !== null)
      : []
  const confirmUnaccounted = () => {
    run(
      'start',
      ackable.map((u) => ({ pid: u.pid, startedAt: u.startedAt! })),
    )
  }

  if (!canEdit) return null

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {startable && (
          <Btn
            onClick={() => run('start')}
            disabled={busy}
            tone="primary"
            label={pending === 'start' ? 'Starting…' : 'Start'}
          />
        )}
        {!s.proc && !canStart && (
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
                className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-ink"
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

      {/* UNKNOWN is a state, not a dead end. Both directions stay offered and
          each is guarded by the code it names, so the sentence is checkable. */}
      {uncertain && (
        <p className="prose-line mt-1.5 text-[11px] leading-relaxed text-faint">
          Whether this server is running could not be determined, so both actions stay available.
          Start re-checks identity inside its own lock and refuses under doubt, naming any process
          it cannot account for. Stop only asks the server to shut down over RCON and never kills a
          process.
        </p>
      )}

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

      {/* The guard stays conservative; this is the explicit, audited way
          through it. Each process is listed by pid, path and start time, so
          the admin confirms THESE, not a vibe. A process that appeared after
          this list was shown refuses again server-side. */}
      {ackable.length > 0 && (
        <div className="mt-2 rounded-md border border-warn/40 bg-warn/10 px-2 py-1.5">
          <ul className="space-y-0.5">
            {ackable.map((u) => (
              <li key={`${u.pid}-${u.startedAt}`} className="break-all font-mono text-[11px] text-ink">
                pid {u.pid} · {u.exe ?? 'path unreadable'} · started{' '}
                {u.startedAt ? new Date(u.startedAt).toLocaleString() : '?'} · session {u.sessionId ?? '?'}
              </li>
            ))}
          </ul>
          <div className="mt-1.5 flex items-center gap-2">
            <Btn
              onClick={confirmUnaccounted}
              disabled={busy}
              tone="danger"
              label={`These are not this server. Start anyway (${ackable.length})`}
            />
            <span className="prose-line text-[11px] leading-relaxed text-faint">
              Confirms exactly the processes above, pinned to their start times. Audited.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

/** The RCON command box. One server, named beside the input. */
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
        The target is named on screen, not implied by where the box sits. A
        global command box makes "stop" ambiguous, and the cost of aiming it at
        the wrong server is that server going down with players on it.
      */}
      <label className="mb-1.5 flex items-baseline gap-1.5 text-[11px] text-faint" htmlFor={`cmd-${s.id}`}>
        Send an RCON command to
        <span className="font-medium text-ink">{s.name}</span>
      </label>
      <div className="flex gap-2">
        <span
          aria-hidden="true"
          className="flex select-none items-center rounded-md border border-border bg-secondary px-2 font-mono text-[11px] text-muted-foreground"
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
            reply.ok ? 'border-border bg-sidebar text-ink' : 'border-warn/40 bg-warn/10 text-warn'
          }`}
        >
          {reply.ok ? (reply.raw ? formatMc(reply.raw) : '(no output)') : reply.detail}
        </pre>
      )}
    </div>
  )
}
