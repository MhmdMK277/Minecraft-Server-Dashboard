import { useState } from 'react'
import type { ServerStatus, ServerSettingKey } from '@shared/api'
import { dashboard } from './client'
import { Btn } from './ServerCard'

/**
 * The two editable server.properties values.
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

function useSetter(s: ServerStatus) {
  const [pending, setPending] = useState<ServerSettingKey | null>(null)
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null)

  const apply = (key: ServerSettingKey, value: boolean) => {
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
            <ul className="mt-2 space-y-1 text-[12px] leading-relaxed text-muted">
              <li>· Inventories, enderchests, advancements and statistics detach from their owners</li>
              <li>· Operator status stops matching, because ops.json is keyed on UUID</li>
              <li>· LuckPerms grants, land claims and any plugin keyed on UUID detach too</li>
              <li>· Flipping it back does not reattach anything for players who logged in meanwhile</li>
            </ul>
            <p className="prose-line mt-2 text-[12px] leading-relaxed text-muted">
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
                className="text-[11px] text-muted underline underline-offset-2 hover:text-ink"
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
