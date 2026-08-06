import { useState } from 'react'
import type { ServerStatus, ServerSettingKey } from '@shared/api'
import { MOTD_MAX_LINES, MOTD_MAX_LINE_LENGTH } from '@shared/api'
import { dashboard } from './client'
import { Btn } from './controls'
import { formatMc } from './mcformat'

/**
 * The editable server.properties values: the MOTD and two booleans.
 *
 * `white-list` is a toggle. `online-mode` is not, and that asymmetry is the
 * whole point of this component.
 *
 * Flipping online-mode changes how every player's UUID is derived -- offline
 * UUIDs are computed from the username instead of issued by Mojang -- so every
 * player becomes a different person to the server. Inventories, advancements, op
 * status, LuckPerms grants and land claims are all keyed on UUID, and all of
 * them detach at once. It is silent, it looks like data loss, and it is not
 * undone by flipping the switch back if anyone has logged in meanwhile.
 *
 * A dashboard whose whole argument is that it explains what it cannot measure
 * should also explain what a setting will cost before you pay it. So: the
 * consequence in plain language, an explicit confirmation, and a statement that
 * a restart is required -- shown BEFORE the change, not as a toast afterwards.
 */

type EditableKey = ServerSettingKey | 'motd'

function useSetter(s: ServerStatus) {
  const [pending, setPending] = useState<EditableKey | null>(null)
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null)

  const apply = (key: EditableKey, value: boolean | string) => {
    setPending(key)
    setResult(null)
    dashboard
      .setServerSetting(s.id, key, value)
      .then((r) => setResult({ ok: true, detail: r.detail }))
      .catch((e: unknown) =>
        setResult({ ok: false, detail: e instanceof Error ? e.message : 'could not save' }),
      )
      .finally(() => setPending(null))
  }

  return { pending, result, apply }
}

/**
 * The MOTD: the one free-text value the settings allowlist carries.
 *
 * The value shown is decoded from server.properties by the service
 * (server/serversettings.ts readSettings); the write goes through writeMotd,
 * which validates and re-encodes it, so a newline typed here becomes the \n
 * escape in the file and can never become a second property line. The
 * preview renders the § formatting codes with the same renderer the console
 * uses (web/mcformat.tsx); the in-game font and per-line truncation differ,
 * and the caption says so rather than promising pixel fidelity.
 */
function MotdEditor({
  motd,
  pending,
  apply,
}: {
  motd: string | null
  pending: EditableKey | null
  apply: (key: EditableKey, value: boolean | string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const editing = draft !== null
  const value = draft ?? motd ?? ''
  const lines = value.split('\n')
  const tooManyLines = lines.length > MOTD_MAX_LINES
  const tooLong = lines.some((l) => l.length > MOTD_MAX_LINE_LENGTH)

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink">MOTD</div>
          <p className="prose-line mt-0.5 text-[11px] leading-relaxed text-faint">
            The line players see under this server in their multiplayer list. Read from{' '}
            <code className="font-mono">server.properties</code>; the running server keeps showing
            the value it started with until it restarts.
          </p>
        </div>
        {!editing && (
          <Btn
            onClick={() => setDraft(motd ?? '')}
            disabled={pending !== null}
            label={motd === null ? 'Set…' : 'Edit…'}
          />
        )}
      </div>

      {!editing && (
        <div className="mt-2 rounded-md border border-border bg-panel2 px-2.5 py-1.5">
          {motd === null ? (
            <p className="text-[12px] leading-relaxed text-faint">
              Not set. The server shows Minecraft's default, "A Minecraft Server".
            </p>
          ) : (
            motd.split('\n').map((l, i) => (
              <div key={i} className="font-mono text-[12px] leading-relaxed text-ink">
                {formatMc(l)}
              </div>
            ))
          )}
        </div>
      )}

      {editing && (
        <div className="mt-2 space-y-2">
          <textarea
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            spellCheck={false}
            className="w-full resize-none rounded-md border border-border bg-panel2 px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-ring"
            aria-label="MOTD"
          />
          <p className="prose-line text-[11px] leading-relaxed text-faint">
            Up to {MOTD_MAX_LINES} lines of {MOTD_MAX_LINE_LENGTH} characters (the game client
            truncates long lines on its own). Formatting codes work: §6 gold, §l bold, §o italic,
            §r reset.
          </p>
          <div className="rounded-md border border-border bg-panel2 px-2.5 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-faint">
              Preview (formatting codes only; the in-game font and truncation differ)
            </div>
            {lines.map((l, i) => (
              <div key={i} className="font-mono text-[12px] leading-relaxed text-ink">
                {formatMc(l)}
              </div>
            ))}
          </div>
          {(tooManyLines || tooLong) && (
            <p className="prose-line text-[11px] leading-relaxed text-warn">
              {tooManyLines
                ? `An MOTD is at most ${MOTD_MAX_LINES} lines.`
                : `A line is capped at ${MOTD_MAX_LINE_LENGTH} characters here.`}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Btn
              onClick={() => {
                apply('motd', value)
                setDraft(null)
              }}
              disabled={pending !== null || tooManyLines || tooLong || value === (motd ?? '')}
              label={pending === 'motd' ? 'Saving…' : 'Save MOTD'}
            />
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-ink"
            >
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The heap, edited in the start script CREATION wrote and only there
 * (defect 5, 2026-08-06). The editable/why split comes from the service
 * (server/heapedit.ts readHeap, riding the snapshot), the write goes through
 * writeHeap with the same discipline as any properties write, and the
 * restart honesty in the response sentence is composed from the running
 * JVM's actual -Xmx as identity read it, not assumed.
 */
function HeapEditor({ s }: { s: ServerStatus }) {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; detail: string } | null>(null)
  const h = s.heapScript
  const runningMb = s.proc?.heapMaxMb ?? null

  if (!h.editable) {
    return (
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-ink">Memory</div>
        <p className="prose-line mt-0.5 text-[11px] leading-relaxed text-faint">{h.why}</p>
        {runningMb !== null && (
          <p className="prose-line mt-1 text-[11px] leading-relaxed text-faint">
            The running server was started with {runningMb} MB (read from its command line).
          </p>
        )}
      </div>
    )
  }

  const save = () => {
    const mb = Number(value)
    setSaving(true)
    setNote(null)
    dashboard
      .setHeap(s.id, mb)
      .then((r) => setNote({ ok: true, detail: r.detail }))
      .catch((e: unknown) =>
        setNote({ ok: false, detail: e instanceof Error ? e.message : 'could not save' }),
      )
      .finally(() => setSaving(false))
  }

  return (
    <div className="min-w-0">
      <div className="text-[13px] font-medium text-ink">Memory</div>
      <p className="prose-line mt-0.5 text-[11px] leading-relaxed text-faint">
        start.bat gives the server {h.scriptMb} MB (-Xms and -Xmx, equal, as creation wrote them).
        {runningMb !== null && runningMb !== h.scriptMb
          ? ` The running server was started with ${runningMb} MB and keeps it until it restarts.`
          : ''}{' '}
        Edits here rewrite that one line; the previous script is kept dated beside it.
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={String(h.scriptMb)}
          inputMode="numeric"
          spellCheck={false}
          autoComplete="off"
          className="h-8 w-28 rounded-md border border-border bg-transparent px-2 font-mono text-[12px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <span className="text-[11px] text-faint">MB</span>
        <Btn
          onClick={save}
          disabled={saving || !/^\d+$/.test(value.trim()) || Number(value) === h.scriptMb}
          label={saving ? 'Saving…' : 'Save'}
        />
      </div>
      {note && (
        <p
          className={`prose-line mt-1.5 text-[12px] leading-relaxed ${note.ok ? 'text-faint' : 'text-bad'}`}
        >
          {note.detail}
        </p>
      )}
    </div>
  )
}

export default function ServerSettingsPanel({ s }: { s: ServerStatus }) {
  const settings = s.settings
  const { pending, result, apply } = useSetter(s)
  const [armed, setArmed] = useState(false)

  if (!settings) {
    return (
      <p className="prose-line text-[12px] leading-relaxed text-faint">
        This directory has no <code className="font-mono">server.properties</code>, so there is
        nothing to configure.
      </p>
    )
  }

  const running = s.health !== 'DOWN' || !!s.proc
  const nextOnline = !settings.onlineMode

  return (
    <div className="space-y-3">
      {/*
        Measured, not remembered: server.properties has an mtime later than this
        process's start, so the running server is demonstrably not using what is
        on disk. A flag in memory would be lost when THIS service restarts; the
        filesystem remembers on its own.
      */}
      {settings.changedSinceStart && (
        <p className="prose-line rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-warn">
          <code className="font-mono">server.properties</code> has been edited since this server
          started, so the values below are not the ones it is running on. They take effect at the
          next restart.
        </p>
      )}

      {/* ----------------------------------------------------------------- motd */}
      <MotdEditor motd={settings.motd} pending={pending} apply={apply} />

      <div className="border-t border-border pt-3" />

      {/* ------------------------------------------------------------- memory */}
      <HeapEditor s={s} />

      <div className="border-t border-border pt-3" />

      {/* ------------------------------------------------------------ whitelist */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink">Whitelist</div>
          <p className="prose-line mt-0.5 text-[11px] leading-relaxed text-faint">
            {settings.whitelist
              ? 'Only listed players can connect.'
              : 'Anyone who can reach the port can connect.'}
          </p>
        </div>
        <Btn
          onClick={() => apply('white-list', !settings.whitelist)}
          disabled={pending !== null}
          label={
            pending === 'white-list' ? 'Saving…' : settings.whitelist ? 'Turn off' : 'Turn on'
          }
        />
      </div>

      <div className="border-t border-border pt-3">
        {/* ------------------------------------------------------ online-mode */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-ink">Online mode</div>
            <p className="prose-line mt-0.5 text-[11px] leading-relaxed text-faint">
              {settings.onlineMode
                ? 'Players are authenticated with Mojang. UUIDs are issued by Mojang.'
                : 'Players are not authenticated. UUIDs are derived from the username.'}
            </p>
          </div>
          {!armed && (
            <Btn
              onClick={() => setArmed(true)}
              disabled={pending !== null}
              label={settings.onlineMode ? 'Turn off…' : 'Turn on…'}
            />
          )}
        </div>

        {/*
          One factual note about the security implication, stated once, with no
          repetition anywhere else in the UI. Running offline deliberately is a
          legitimate decision -- it is how a friend without a premium account
          joins -- and a dashboard that nags about a choice the operator has
          already made is a dashboard whose warnings get tuned out, which is the
          same failure as animating on every snapshot.
        */}
        {!settings.onlineMode && !armed && (
          <p className="prose-line mt-2 text-[11px] leading-relaxed text-faint">
            While this is off the server cannot verify who anyone is, so a username alone is enough
            to connect as that player. {settings.whitelist
              ? 'The whitelist matches on name only in this mode.'
              : 'With the whitelist also off, any username can connect.'}
          </p>
        )}

        {armed && (
          <div className="mt-2.5 rounded-md border border-warn/50 bg-warn/10 p-2.5">
            <p className="prose-line text-[12px] font-semibold leading-relaxed text-warn">
              Turning online mode {nextOnline ? 'on' : 'off'} changes every player's identity.
            </p>
            <p className="prose-line mt-1.5 text-[12px] leading-relaxed text-ink">
              {nextOnline
                ? 'UUIDs will go back to being issued by Mojang rather than derived from usernames. Anyone who has played while it was off will return to their original identity, and anything they built, earned or was granted under the offline identity will no longer be theirs.'
                : 'UUIDs will be derived from usernames instead of issued by Mojang. Every player becomes a different person to this server.'}
            </p>
            <ul className="mt-2 space-y-1 text-[12px] leading-relaxed text-muted-foreground">
              <li>· Inventories, enderchests, advancements and statistics detach from their owners</li>
              <li>· Operator status stops matching, because ops.json is keyed on UUID</li>
              <li>· LuckPerms grants, land claims and any plugin keyed on UUID detach too</li>
              <li>· Flipping it back does not reattach anything for players who logged in meanwhile</li>
            </ul>
            <p className="prose-line mt-2 text-[12px] leading-relaxed text-muted-foreground">
              Nothing is deleted, and the previous <code className="font-mono">server.properties</code>{' '}
              is kept beside the original as a dated <code className="font-mono">.bak</code> file.{' '}
              <span className="font-medium text-ink">
                This takes effect only after a restart
                {running ? ', which this does not perform' : ''}.
              </span>
            </p>
            <div className="mt-2.5 flex items-center gap-2">
              <Btn
                onClick={() => {
                  apply('online-mode', nextOnline)
                  setArmed(false)
                }}
                disabled={pending !== null}
                tone="danger"
                label={
                  pending === 'online-mode'
                    ? 'Saving…'
                    : `Set online-mode=${nextOnline ? 'true' : 'false'}`
                }
              />
              <button
                type="button"
                onClick={() => setArmed(false)}
                className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-ink"
              >
                cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {result && (
        <p
          className={`prose-line rounded-md border px-2.5 py-1.5 text-[12px] leading-relaxed ${
            result.ok ? 'border-ok/40 bg-ok/10 text-ink' : 'border-bad/40 bg-bad/10 text-bad'
          }`}
        >
          {result.detail}
          {result.ok && ' The running server keeps its current setting until it restarts.'}
        </p>
      )}
    </div>
  )
}
