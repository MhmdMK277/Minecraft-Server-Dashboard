import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { ServerStatus, LogLine, Snapshot } from '@shared/api'
import { verdict, verdictSentence, Indicator, Meter, Metric, TONE_TEXT, ramFigures } from './status'
import type { BackupDetection, ColdBackupEntry, DimensionInfo, WorldsReading } from '@shared/api'
import { WorldIcon } from './WorldIcon'
import { HistoryPanel } from './History'
import { API } from '@shared/api'
import { ControlPanel, BackupToggle, CommandBox, Btn, age } from './controls'
import { formatMc } from './mcformat'
import { dashboard } from './client'
import { Input } from '@/components/ui/input'
import ServerSettingsPanel from './ServerSettings'
import GameRulesPanel from './GameRules'
import ProfilingPanel from './Profiling'
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
export function Section({
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
  prefs,
  lines,
  ensureBacklog,
}: {
  s: ServerStatus
  page: ServerPage
  canEdit: boolean
  prefs: Snapshot['prefs']
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
        {page === 'players' && <Players s={s} canEdit={canEdit} prefs={prefs} />}
        {page === 'worlds' && <Worlds s={s} />}
        {page === 'gamerules' && <GameRulesPanel s={s} canEdit={canEdit} />}
        {page === 'profiling' && <ProfilingPanel s={s} />}
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
          {(() => {
            const ram = ramFigures(ws, priv, s.proc?.heapMaxMb ?? null)
            return (
              <Metric
                label="RAM"
                value={ram.value}
                tier="lead"
                title={
                  ws == null
                    ? 'Working set could not be read.'
                    : `${ws} MB resident of ${priv ?? '?'} MB committed by this process (${residency ?? '?'}% resident). Resident memory is the whole process, not the heap: the ${s.proc?.heapMaxMb != null ? `${s.proc.heapMaxMb} MB -Xmx heap` : 'heap'} is one part of it, alongside metaspace, thread stacks and the JIT, which is why resident can exceed the heap ceiling. Residency, not heap usage.`
                }
              >
                <Meter value={ws} max={ram.meterMax} tone="muted" />
                {ws != null && (
                  <div className="mt-0.5 text-[10px] text-faint">
                    {residency ?? '?'}% resident, {ram.ceilingLabel}
                  </div>
                )}
              </Metric>
            )
          })()}
          <Metric label="Uptime" value={age(s.proc?.uptimeSeconds ?? null)} tier="lead" />
        </div>
      )}

      {/*
        The rolling hour, directly under the figures it is the history of.
        Full width rather than in a column, because three sparklines side by
        side are read across and a narrow column would stack them.
      */}
      <Section
        label="Last hour"
        note="Sampled on the same scan that produces the figures above. A gap in a line is a scan where that reading could not be taken, never a zero."
      >
        <HistoryPanel id={s.id} />
      </Section>

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

          {s.memory && (
            <Section
              label="Memory eviction exposure"
              note="Two facts read, never inferred (server/residency.ts): the scheduled task's priority, and how much of the process is resident in RAM right now. Their combination is what turns someone else's bulk file I/O into this server's multi-second pause."
            >
              <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
                <Metric
                  label="Resident"
                  value={`${s.memory.residencyPercent}%`}
                  tone={s.memory.vulnerable ? 'warn' : undefined}
                />
                <Metric label="Working set" value={`${s.memory.workingSetMb} MB`} />
                <Metric label="Committed" value={`${s.memory.privateMb} MB`} />
                <Metric
                  label="Priority"
                  value={
                    s.memory.processPriority != null
                      ? `base ${s.memory.processPriority}`
                      : s.memory.taskPriority != null
                        ? `task ${s.memory.taskPriority}`
                        : '–'
                  }
                  tone={s.memory.lowPriority ? 'warn' : undefined}
                  title="The LIVE process's base scheduling priority (6 = BelowNormal, 8 = Normal). The launching task's Settings.Priority is beneath; a task changed after the process started applies at its next launch, and this reading follows the process, not the setting."
                >
                  {s.memory.taskPriority != null && (
                    <div className="mt-0.5 text-[10px] text-faint">
                      task Priority={s.memory.taskPriority}
                    </div>
                  )}
                </Metric>
              </div>
              <p
                className={`prose-line mt-2.5 text-[12px] leading-relaxed ${s.memory.vulnerable ? 'text-warn' : 'text-muted-foreground'}`}
              >
                {s.memory.detail}
              </p>
            </Section>
          )}

          <Section
            label="Start window"
            note="The window that decides STARTING from HUNG, measured from this server's own boots where possible."
          >
            {/* An unmeasured default is DOUBT, not danger: it rides the same
                `?` treatment as the row meta, never amber. Amber on a calm
                page would mark a non-event (finish review, fix 6). */}
            <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
              <Metric
                label="Window"
                value={s.boot.source === 'measured' ? `${s.boot.graceSeconds}s` : `${s.boot.graceSeconds}s?`}
              />
              <Metric
                label="Source"
                value={s.boot.source === 'measured' ? 'measured' : 'default'}
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
              {/* Which signal named the pid (2026-08-06): a long UNKNOWN is
                  only explicable by knowing which signal did NOT fire. */}
              <Metric label="Attributed by" value={s.proc ? s.proc.attributedBy : '–'} tier="meta" />
              <Metric label="Started" value={s.proc ? s.proc.startedBy : '–'} tier="meta" />
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

/**
 * A player's face, if and only if the operator asked for it.
 *
 * The image is fetched by the BROWSER, not by the service, and that is the
 * point of the disclosure next to the switch: the third party learns the
 * names on this server and the IP of whoever is looking. We do not proxy it,
 * because proxying would hide exactly the fact the operator is agreeing to.
 *
 * The placeholder is ours. The avatar host answers 404 for a name that does
 * not resolve to a Mojang account (measured, not assumed), which is the
 * right behaviour for an offline-mode server full of invented names: rather
 * than a stranger's face standing in for a player, the row says plainly that
 * the account did not resolve.
 */
function Avatar({ name, origin, on }: { name: string; origin: string; on: boolean }) {
  const [failed, setFailed] = useState(false)
  if (!on) return null
  const size = 16
  if (failed) {
    return (
      <span
        title={`No Minecraft account resolved for "${name}". On an offline-mode server that is normal and says nothing about the player.`}
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-[2px] border border-border text-[8px] text-faint"
        aria-hidden="true"
      >
        ?
      </span>
    )
  }
  return (
    <img
      src={`${origin}/avatar/${encodeURIComponent(name)}/${size * 2}.png`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className="size-4 shrink-0 rounded-[2px]"
    />
  )
}

/**
 * The switch, with what it costs written next to it rather than in a doc.
 *
 * Off is the default and stays the default. While it is off the service does
 * not name the avatar host in its Content-Security-Policy at all, so the
 * browser refuses the request even if some future bug in this file tries to
 * make it; the switch removes a permission rather than hiding a feature.
 */
function AvatarSwitch({ prefs, canEdit }: { prefs: Snapshot['prefs']; canEdit: boolean }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const host = prefs.avatarOrigin.replace(/^https?:\/\//, '')

  if (!canEdit) return null

  const set = (on: boolean) => {
    setBusy(true)
    setErr(null)
    dashboard
      .setPlayerAvatars(on)
      .then(() => void dashboard.refresh())
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not change that'))
      .finally(() => setBusy(false))
  }

  return (
    <div className="mt-3 border-t border-border/60 pt-2.5">
      <label className="flex cursor-pointer items-start gap-2 text-[12px] text-muted-foreground">
        <input
          type="checkbox"
          checked={prefs.playerAvatars}
          disabled={busy}
          onChange={(e) => set(e.target.checked)}
          className="mt-0.5 size-3.5 accent-primary"
        />
        <span className="prose-line">
          Show player faces. Your browser fetches each one from{' '}
          <code className="font-mono text-ink">{host}</code>, which means that service is told
          the names on this server and sees the address of whoever has the dashboard open. It is
          off until you turn it on, and while it is off the dashboard does not permit the request
          at all, rather than merely not making it.
        </span>
      </label>
      <p className="prose-line mt-1.5 pl-6 text-[11px] leading-relaxed text-faint">
        Names that do not resolve to a Minecraft account get a plain placeholder, not a stand-in
        face. On an offline-mode server most of them will not resolve, and that says nothing
        about the player.
      </p>
      {err && <p className="prose-line mt-1.5 pl-6 text-[12px] text-bad">{err}</p>}
    </div>
  )
}

function Players({
  s,
  canEdit,
  prefs,
}: {
  s: ServerStatus
  canEdit: boolean
  prefs: Snapshot['prefs']
}) {
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
                className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-0.5 font-mono text-[11px] text-ink"
              >
                <Avatar name={p} origin={prefs.avatarOrigin} on={prefs.playerAvatars} />
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
        <AvatarSwitch prefs={prefs} canEdit={canEdit} />
      </Section>

      {canEdit && (
        <Section
          label="Whitelist"
          note="Read from and written to the running server over the audited RCON route. This is what is enforced right now; the white-list switch in Settings edits the file, which waits for a restart. Names match exactly, and capitalization matters on an offline-mode server."
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
                      <li key={n} className="flex items-center gap-1.5">
                        <Avatar name={n} origin={prefs.avatarOrigin} on={prefs.playerAvatars} />
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setArmed(n)}
                          title={`Remove ${n} from the whitelist (asks to confirm)`}
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-2 py-0.5 font-mono text-[11px] text-ink transition-colors duration-150 hover:border-bad/60 hover:text-bad"
                        >
                          {n}
                          <X className="size-3" aria-hidden="true" />
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
                  placeholder="Exact player name"
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

function fmtBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb < 1000) return `${Math.round(mb)} MB`
  const v = (mb / 1024).toFixed(1)
  return `${v.endsWith('.0') ? v.slice(0, -2) : v} GB`
}

const DIM_LABEL: Record<DimensionInfo['kind'], string> = {
  overworld: 'overworld',
  nether: 'nether',
  end: 'the end',
  custom: 'custom',
}

/**
 * Read-only worlds enumeration (Phase B). Everything here is a statement
 * about what is on disk; there is no action on this page, and no write path
 * behind it. The walk cost is shown because honesty includes what a number
 * cost to produce.
 */
/** One dimension, as a board row. Aligned columns, no card. */
function DimensionRow({ d }: { d: DimensionInfo }) {
  const empty = d.regionFiles === 0 && d.sizeBytes < 1024 * 1024
  return (
    <li
      className={`grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-5 border-t border-border/40 py-1 ${
        empty ? 'opacity-55' : ''
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <WorldIcon kind={d.kind} size={13} className="text-muted-foreground" />
        <code className="truncate font-mono text-[12px] text-ink">{d.path}</code>
      </span>
      <span className="tnum font-mono text-[11px] text-muted-foreground">{fmtBytes(d.sizeBytes)}</span>
      <span className="tnum w-20 text-right font-mono text-[11px] text-faint">
        {d.regionFiles} {d.regionFiles === 1 ? 'region' : 'regions'}
      </span>
    </li>
  )
}

/**
 * Dimensions, at the scale a modded server actually has them.
 *
 * Measured on the real fleet before designing this: GTNH has FIFTY-FOUR
 * dimensions in one world, all in Forge's flat `DIM<n>` form, and most hold
 * no data at all. Two consequences:
 *
 *   - Grouping by namespace only works for the modern
 *     `dimensions/<namespace>/<name>` layout. `DIM112` has no namespace, and
 *     inventing a mod-name lookup would be exactly the kind of guess this
 *     project refuses to make. So the known ids are named, and the rest are
 *     one group ordered by size.
 *   - Rendering 38 identical empty rows is noise, so they collapse to a
 *     count. The disclosure is the house pattern: an underlined text button,
 *     never a chevron, and the collapsed state says what it is hiding.
 */
function Dimensions({ dims }: { dims: DimensionInfo[] }) {
  const [showAll, setShowAll] = useState(false)
  if (dims.length === 0) return null

  const named = dims.filter((d) => d.kind !== 'custom')
  const rest = dims.filter((d) => d.kind === 'custom')
  const withData = rest.filter((d) => d.regionFiles > 0 || d.sizeBytes >= 1024 * 1024)
  const empty = rest.filter((d) => !(d.regionFiles > 0 || d.sizeBytes >= 1024 * 1024))
  const bySize = (a: DimensionInfo, b: DimensionInfo) => b.sizeBytes - a.sizeBytes

  return (
    <div className="mt-4 border-t border-border/60 pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
          Dimensions inside this world
        </span>
        <span className="tnum font-mono text-[10px] text-faint">
          {dims.length} total · {withData.length + named.length} with data
        </span>
      </div>

      <ul className="mt-1.5">
        {named.sort(bySize).map((d) => (
          <DimensionRow key={d.path} d={d} />
        ))}
        {withData.sort(bySize).map((d) => (
          <DimensionRow key={d.path} d={d} />
        ))}
        {showAll && empty.sort(bySize).map((d) => <DimensionRow key={d.path} d={d} />)}
      </ul>

      {empty.length > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 text-[11px] text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-ink"
        >
          {showAll
            ? `Hide the ${empty.length} dimensions with no data yet`
            : `Show ${empty.length} more dimensions, generated but holding no data yet`}
        </button>
      )}
    </div>
  )
}

function Worlds({ s }: { s: ServerStatus }) {
  const [reading, setReading] = useState<WorldsReading | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    (fresh: boolean) => {
      setBusy(true)
      setErr(null)
      dashboard
        .getWorlds(s.id, fresh)
        .then(setReading)
        .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not read worlds'))
        .finally(() => setBusy(false))
    },
    [s.id],
  )

  useEffect(() => {
    setReading(null)
    load(false)
  }, [s.id, load])

  if (err) return <p className="prose-line text-[12px] text-bad">{err}</p>
  if (reading === null) {
    return (
      <p className="prose-line text-[12px] text-faint">
        Walking the world directories. A large modpack world holds tens of thousands of region
        files, so this can take a moment.
      </p>
    )
  }
  if (reading.worlds.length === 0) {
    return (
      <p className="prose-line text-[12px] text-faint">
        No world directories were found under this server. A world is a directory holding a{' '}
        <code className="font-mono">level.dat</code>.
      </p>
    )
  }

  const totalBytes = reading.worlds.reduce((n, w) => n + w.sizeBytes, 0)
  const totalDims = reading.worlds.reduce((n, w) => n + w.dimensions.length, 0)

  return (
    <>
      {/*
        The summary first, with the provenance of the reading attached to it
        rather than repeated per world. A cached reading says so: showing a
        previous walk as though it were live is the same failure as a panel
        showing the last numbers it collected before a server froze.
      */}
      <Section label="Worlds">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Metric label="Worlds" value={String(reading.worlds.length)} tier="body" />
          <Metric label="Dimensions" value={String(totalDims)} tier="body" />
          <Metric label="On disk" value={fmtBytes(totalBytes)} tier="body" />
          <Metric
            label="Reading taken"
            value={new Date(reading.readAt).toLocaleTimeString()}
            tier="meta"
            title={`Walked in ${reading.walkMs} ms. Sizes are what was on disk at that moment; a live server writes constantly.`}
          />
        </div>
        <p className="prose-line mt-2.5 text-[11px] leading-relaxed text-faint">
          {reading.cached
            ? 'This is the reading already taken, shown as it was. '
            : `Read from disk in ${reading.walkMs} ms. `}
          <button
            type="button"
            onClick={() => load(true)}
            disabled={busy}
            className="text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-ink disabled:opacity-50"
          >
            {busy ? 'Reading…' : 'Read the folders again'}
          </button>
        </p>
      </Section>

      {reading.worlds.map((w) => (
        <Section key={w.dir} label={w.dir}>
          <div className="flex items-start gap-4">
            {w.hasIcon && (
              <img
                src={API.worldIcon(s.id, w.dir)}
                alt=""
                width={44}
                height={44}
                className="mt-1 shrink-0 rounded-md border border-border"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
                <div>
                  <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
                    Kind
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <WorldIcon kind={w.kind} size={15} className="text-muted-foreground" />
                    <span className="font-mono text-[13px] text-ink">{DIM_LABEL[w.kind]}</span>
                  </div>
                </div>
                <Metric label="Size" value={fmtBytes(w.sizeBytes)} tier="body" />
                <Metric label="Region files" value={String(w.regionFiles)} tier="body" />
                <Metric
                  label="Last written"
                  value={w.lastWrittenAt ? new Date(w.lastWrittenAt).toLocaleString() : '–'}
                  tier="meta"
                  title="The newest file modification time anywhere in the world directory."
                />
              </div>
              <Dimensions dims={w.dimensions} />
            </div>
          </div>
        </Section>
      ))}

      <p className="prose-line text-[11px] leading-relaxed text-faint">
        This page reads; it never writes. Deleting or modifying a world will never be offered
        here.
      </p>
    </>
  )
}

const DETECT_STATUS_LABEL: Record<BackupDetection['systems'][number]['status'], string> = {
  active: 'active',
  configured: 'configured, not observed running',
  stale: 'stale',
}

// No '~' here: every call site already says "roughly every", and
// "roughly every ~0.5 h" hedged the same number twice (seen live on GTNH).
function fmtCadence(hours: number): string {
  if (hours >= 36) return `${Math.round((hours / 24) * 10) / 10} days`
  return `${Math.round(hours * 10) / 10} h`
}

/**
 * The detection reading (decision 0001, server/backupdetect.ts). Every
 * sentence here reports what that module read from disk; the statuses and
 * their thresholds are its exported constants, not this page's opinion.
 * State lives in Backups, because the cold-backup offer below is gated on
 * this same reading (decision 0005).
 */
function BackupDetectionPanel({
  reading,
  err,
  busy,
  load,
}: {
  reading: BackupDetection | null
  err: string | null
  busy: boolean
  load: (fresh: boolean) => void
}) {
  if (err) return <p className="prose-line text-[12px] text-bad">{err}</p>
  if (reading === null) {
    return (
      <p className="prose-line text-[12px] text-faint">
        Reading the backup signals from disk. The archive directories are statted at their top
        level only, so this stays quick even over years of archives.
      </p>
    )
  }

  const active = reading.systems.filter((x) => x.status === 'active')

  return (
    <>
      {reading.systems.length === 0 && (
        <p className="prose-line text-[12px] leading-relaxed text-faint">
          No backup system was detected for this server: no archive directory, no ServerUtilities
          config enabling backups, no backup-named plugin or mod jar
          {reading.externalPathsConfigured
            ? ', and nothing for this server under the configured external path.'
            : ', and no external path is configured for the dashboard to look at.'}{' '}
          An external backup script leaves no trace inside the server folder, so if one exists the
          dashboard genuinely cannot see it; name where it writes in{' '}
          <code className="font-mono">externalBackupPaths</code> in{' '}
          <code className="font-mono">config.json</code> (the dashboard&apos;s data folder) and it
          will be read here.
        </p>
      )}

      {reading.activeCount >= 2 && (
        <p className="prose-line mb-3 text-[12px] leading-relaxed text-warn">
          {reading.activeCount} backup systems are active for this server at once:{' '}
          {active.map((x) => `${x.name} (writing to ${x.writesTo ?? 'an unknown place'})`).join(' and ')}
          . Two systems copying the same world means duplicated disk and duplicated I/O on every
          run. Which one to keep is a judgement about which you trust, so nothing here will offer
          to disable either.
        </p>
      )}

      {reading.systems.map((sys) => (
        <div key={`${sys.signal}:${sys.name}`} className="mb-3 border-l-2 border-border pl-3">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-medium text-ink">{sys.name}</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              {DETECT_STATUS_LABEL[sys.status]}
            </span>
            {sys.confidence === 'guess' && (
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
                a guess
              </span>
            )}
          </div>
          <p className="prose-line mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {sys.evidence}
          </p>
          {sys.archives && (
            <p className="prose-line mt-0.5 font-mono text-[11px] text-faint">
              {sys.archives.count} archives, at least {fmtBytes(sys.archives.totalBytes)}
              {sys.archives.newestAt
                ? `, newest ${new Date(sys.archives.newestAt).toLocaleString()}`
                : ''}
              {sys.archives.approxCadenceHours !== null
                ? `, roughly every ${fmtCadence(sys.archives.approxCadenceHours)}`
                : ''}
            </p>
          )}
          {sys.lastLogLine && (
            <p
              className="mt-0.5 overflow-x-auto whitespace-nowrap font-mono text-[11px] text-faint"
              title="The newest line mentioning this server in a log found at the external path."
            >
              {sys.lastLogLine}
            </p>
          )}
        </div>
      ))}

      <p className="prose-line mt-2 text-[11px] leading-relaxed text-faint">
        {reading.cached
          ? 'This is the reading already taken, shown as it was. '
          : `Read from disk in ${reading.readMs} ms. `}
        <button
          type="button"
          onClick={() => load(true)}
          disabled={busy}
          className="text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-ink disabled:opacity-50"
        >
          {busy ? 'Reading…' : 'Read the signals again'}
        </button>
      </p>
    </>
  )
}

/**
 * Decision 0005: the dashboard's own cold backup, offered only where the
 * detection reading found nothing active. The gate is enforced again
 * server-side on a FRESH reading (server/coldbackup.ts), so this panel
 * withholding the form is presentation, not the protection.
 */
function ColdBackupPanel({ s, detection }: { s: ServerStatus; detection: BackupDetection | null }) {
  const [entries, setEntries] = useState<ColdBackupEntry[] | null>(null)
  const [destDir, setDestDir] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [armedRun, setArmedRun] = useState(false)
  const [armedRestore, setArmedRestore] = useState<string | null>(null)

  const loadEntries = useCallback(() => {
    dashboard
      .getColdBackups(s.id)
      .then((r) => {
        setEntries(r.entries)
        // The newest journaled destination is the likely next one; a blank
        // field stays blank until the operator names a place.
        setDestDir((cur) => {
          if (cur) return cur
          const last = r.entries[r.entries.length - 1]
          if (!last) return cur
          const cut = Math.max(last.archivePath.lastIndexOf('\\'), last.archivePath.lastIndexOf('/'))
          return cut > 0 ? last.archivePath.slice(0, cut) : cur
        })
      })
      .catch(() => setEntries([]))
  }, [s.id])

  useEffect(() => {
    setEntries(null)
    setMessage(null)
    setArmedRun(false)
    setArmedRestore(null)
    loadEntries()
  }, [s.id, loadEntries])

  const run = () => {
    setBusy(true)
    setMessage(null)
    dashboard
      .runColdBackup(s.id, destDir.trim())
      .then((r) =>
        setMessage({
          tone: 'ok',
          text: `Archive written: ${r.entry.archivePath} (${fmtBytes(r.entry.bytes)}, sha256 ${r.entry.sha256.slice(0, 12)}…), journaled in the manifest.`,
        }),
      )
      .catch((e: unknown) =>
        setMessage({ tone: 'bad', text: e instanceof Error ? e.message : 'the backup failed' }),
      )
      .finally(() => {
        setBusy(false)
        setArmedRun(false)
        loadEntries()
      })
  }

  const restore = (id: string) => {
    setBusy(true)
    setMessage(null)
    dashboard
      .restoreColdBackup(s.id, id)
      .then((r) =>
        setMessage({
          tone: 'ok',
          text: `Restored into ${r.restoredDir}. The original folder was not touched; swapping the two is your move, made outside this dashboard.`,
        }),
      )
      .catch((e: unknown) =>
        setMessage({ tone: 'bad', text: e instanceof Error ? e.message : 'the restore failed' }),
      )
      .finally(() => {
        setBusy(false)
        setArmedRestore(null)
      })
  }

  const offerWithheld = detection !== null && detection.activeCount > 0

  return (
    <>
      {detection === null && (
        <p className="prose-line text-[12px] text-faint">
          Waiting for the detection reading above; the offer depends on it.
        </p>
      )}

      {offerWithheld && (
        <p className="prose-line text-[12px] leading-relaxed text-faint">
          Not offered for this server: a backup system is already active (see above), and a second
          system copying the same world would double disk and I/O. The dashboard backs up only
          servers that have nothing (decision 0005); the same rule is enforced when the request
          arrives, on a fresh reading, not just here.
        </p>
      )}

      {detection !== null && !offerWithheld && (
        <div className="max-w-xl">
          <label className="font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
            Destination folder, outside the server directory
          </label>
          <div className="mt-1 flex items-center gap-2">
            <Input
              value={destDir}
              onChange={(e) => setDestDir(e.target.value)}
              placeholder="D:\my-backups"
              disabled={busy}
              className="font-mono text-[12px]"
            />
            {!armedRun ? (
              <Btn label="Back up now" onClick={() => setArmedRun(true)} disabled={busy || !destDir.trim()} />
            ) : (
              <>
                <Btn label="Write the archive" tone="primary" onClick={run} disabled={busy} />
                <Btn label="Cancel" onClick={() => setArmedRun(false)} disabled={busy} />
              </>
            )}
          </div>
          {armedRun && (
            <p className="prose-line mt-2 text-[11px] leading-relaxed text-muted-foreground">
              One zip of the whole server folder will be written there, now, once. It is refused
              out loud if the server is running or its state cannot be established; nothing stops
              a server for a backup, and nothing is scheduled.
            </p>
          )}
        </div>
      )}

      {message && (
        <p
          className={`prose-line mt-3 text-[12px] leading-relaxed ${message.tone === 'ok' ? 'text-muted-foreground' : 'text-bad'}`}
        >
          {message.text}
        </p>
      )}

      {entries !== null && entries.length > 0 && (
        <div className="mt-4">
          <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
            Journaled archives
          </div>
          {entries.map((e) => (
            <div key={e.id} className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-[12px] text-ink">
                {new Date(e.createdAt).toLocaleString()}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">{fmtBytes(e.bytes)}</span>
              <span
                className="max-w-[24rem] overflow-x-auto whitespace-nowrap font-mono text-[11px] text-faint"
                title={`sha256 ${e.sha256}`}
              >
                {e.archivePath}
              </span>
              {armedRestore !== e.id ? (
                <Btn label="Restore…" onClick={() => setArmedRestore(e.id)} disabled={busy} />
              ) : (
                <>
                  <Btn label="Extract to a new folder" tone="primary" onClick={() => restore(e.id)} disabled={busy} />
                  <Btn label="Cancel" onClick={() => setArmedRestore(null)} disabled={busy} />
                </>
              )}
            </div>
          ))}
          <p className="prose-line mt-3 text-[11px] leading-relaxed text-faint">
            Restore verifies the archive against the sha256 recorded at write, refuses if the
            server is running, and extracts into a new sibling folder. It never extracts over
            anything, so swapping folders afterwards is yours to do, deliberately.
          </p>
        </div>
      )}
    </>
  )
}

/**
 * Management surface: detection first (decision 0001, backupdetect.ts reads
 * the four signals), then the 0005 cold-backup offer gated on that reading,
 * then the policy-file opt-in. The page claims exactly what the reading
 * supports: "active" needs archives inside the module's recency window, a
 * config flag alone reads as configured. The pre-detection copy here once
 * said "detected" with no detection code behind it; that was audit finding
 * F6, and the detection panel is what finally makes the word honest.
 */
function Backups({ s, canEdit }: { s: ServerStatus; canEdit: boolean }) {
  const [reading, setReading] = useState<BackupDetection | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    (fresh: boolean) => {
      setBusy(true)
      setErr(null)
      dashboard
        .getBackupDetection(s.id, fresh)
        .then(setReading)
        .catch((e: unknown) =>
          setErr(e instanceof Error ? e.message : 'could not read backup signals'),
        )
        .finally(() => setBusy(false))
    },
    [s.id],
  )

  useEffect(() => {
    setReading(null)
    load(false)
  }, [s.id, load])

  return (
    <>
      <Section
        label="Detected backup systems"
        note="Four read-only signals (decision 0001): archive directories in the server folder, a ServerUtilities config, backup-named plugin and mod jars, and any external path named in the dashboard's config.json. The dashboard reads these; it never writes them."
      >
        <BackupDetectionPanel reading={reading} err={err} busy={busy} load={load} />
      </Section>
      {canEdit && (
        <Section
          label="A cold backup, by hand"
          note="For servers where nothing was detected: one archive per click, written cold (only while no process owns the directory), sha256 journaled in coldbackup-manifest.jsonl in the dashboard's data folder. Manual only; this dashboard will never schedule a backup."
        >
          <ColdBackupPanel s={s} detection={reading} />
        </Section>
      )}
      <Section
        label="External rotation opt-in"
        note="The dashboard owns no backups beyond the cold archives it journals explicitly. This switch records intent in a policy file (backup-policy.json in the dashboard's data folder) that an external backup script can read. If your backup system does not read that file, or you have none, this switch changes nothing, and nothing on this page means your worlds are backed up."
      >
        <BackupToggle s={s} canEdit={canEdit} />
        <p className="prose-line mt-3 text-[12px] leading-relaxed text-faint">
          A script that honours the policy file skips excluded directories before its rotation
          runs, so archives already written are never touched, whichever way the switch points.
        </p>
      </Section>
    </>
  )
}
