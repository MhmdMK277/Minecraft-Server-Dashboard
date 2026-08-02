import { useCallback, useEffect, useState } from 'react'
import type { ServerStatus, TunnelClaimStatus, TunnelStatus } from '@shared/api'
import { dashboard } from './client'
import { Btn, Note, SectionHead } from './controls'
import { Input } from '@/components/ui/input'

/**
 * Public access, the surface. The rules it renders are all enforced
 * server-side (server/tunnel.ts, proven in prove-tunnel); what this page is
 * responsible for is making the three decisions legible and separate:
 *
 *   1. Installing the agent (a download, verified twice, executed never).
 *   2. Getting a credential (approved in the OPERATOR'S browser at
 *      playit.gg; the secret goes straight to disk and is shown nowhere,
 *      including here).
 *   3. Running the downloaded binary, its own unticked consent, every time.
 *
 * Exposing a server is a fourth decision, per server, armed by typing the
 * server's exact name. The address column renders whatever the status route
 * answers, which is null unless the agent reports connected; this page never
 * caches or invents an address.
 */

function Copyable({ value }: { value: string }) {
  const [done, setDone] = useState(false)
  return (
    <span className="inline-flex items-center gap-1.5">
      <code className="break-all font-mono text-[12px] text-ink">{value}</code>
      <button
        type="button"
        className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-ink"
        onClick={() => {
          void navigator.clipboard.writeText(value)
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        }}
      >
        {done ? 'copied' : 'copy'}
      </button>
    </span>
  )
}

/** The claim flow: URL shown, state polled, secret never present. */
function ClaimPanel({ onClaimed }: { onClaimed: () => void }) {
  const [claim, setClaim] = useState<TunnelClaimStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const active =
    claim && (claim.state === 'waiting-visit' || claim.state === 'waiting-approval' || claim.state === 'accepted')

  useEffect(() => {
    if (!active) return
    const t = setInterval(() => {
      dashboard
        .getTunnelClaimStatus()
        .then((st) => {
          setClaim(st)
          if (st.state === 'claimed') onClaimed()
        })
        .catch(() => undefined)
    }, 3000)
    return () => clearInterval(t)
  }, [active, onClaimed])

  const start = () => {
    setErr(null)
    dashboard
      .tunnelClaimStart()
      .then(setClaim)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not start the claim'))
  }

  return (
    <div>
      <p className="prose-line text-[12px] leading-relaxed text-muted-foreground">
        The agent needs a credential from your own playit.gg account. The dashboard generates a
        claim code locally and you approve it in your browser; playit then issues the credential
        straight to this machine. It is stored in the dashboard's data folder and never shown,
        here or anywhere.
      </p>
      {!claim && (
        <div className="mt-2.5">
          <Btn onClick={start} tone="primary" label="Get a credential" />
        </div>
      )}
      {claim && claim.url && (
        <div className="mt-2.5 rounded-md border border-border bg-secondary/40 p-3">
          <p className="text-[12px] text-muted-foreground">Open this link and approve the agent:</p>
          <p className="mt-1">
            <Copyable value={claim.url} />
          </p>
          <p className="prose-line mt-2 text-[12px] leading-relaxed text-muted-foreground">{claim.detail}</p>
        </div>
      )}
      {claim && !claim.url && (
        <p className="prose-line mt-2 text-[12px] leading-relaxed text-muted-foreground">{claim.detail}</p>
      )}
      {claim && (claim.state === 'rejected' || claim.state === 'timed-out' || claim.state === 'error') && (
        <div className="mt-2">
          <Btn onClick={start} label="Start a new claim" />
        </div>
      )}
      {err && <p className="prose-line mt-2 text-[12px] text-bad">{err}</p>}
    </div>
  )
}

/** Consent number three: running the downloaded binary, unticked every time. */
function RunAgentPanel({ onChanged }: { onChanged: () => void }) {
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const run = () => {
    setBusy(true)
    setErr(null)
    dashboard
      .tunnelRunAgent(confirmed)
      .then(() => onChanged())
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'the agent was not started'))
      .finally(() => setBusy(false))
  }

  return (
    <div className="mt-2.5 rounded-md border border-warn/40 bg-warn/5 p-3">
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 size-3.5 accent-primary"
        />
        <span className="prose-line text-[12px] leading-relaxed text-ink">
          I understand this runs a program that was downloaded from the internet, the playit
          agent, on this machine. Its digest and its publisher's signature were verified, which
          says the file is what playit published, not that running it is harmless.
        </span>
      </label>
      <div className="mt-2.5 flex items-center gap-3 pl-6">
        <Btn onClick={run} disabled={!confirmed || busy} tone="primary" label={busy ? 'Starting…' : 'Start the agent'} />
        {!confirmed && <span className="text-[11px] text-faint">Tick the box to enable this.</span>}
      </div>
      {err && <p className="prose-line mt-2 pl-6 text-[12px] text-bad">{err}</p>}
    </div>
  )
}

/** One server's exposure row, with the typed-name arming for the expose step. */
function ServerRow({
  s,
  status,
  onChanged,
}: {
  s: ServerStatus
  status: TunnelStatus
  onChanged: () => void
}) {
  const entry = status.tunnels.find((t) => t.serverId === s.id)
  const [arming, setArming] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const expose = () => {
    setBusy(true)
    setErr(null)
    dashboard
      .tunnelEnable(s.id, typed)
      .then(() => {
        setArming(false)
        setTyped('')
        onChanged()
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'nothing was exposed'))
      .finally(() => setBusy(false))
  }

  const withdraw = () => {
    setBusy(true)
    setErr(null)
    dashboard
      .tunnelDisable(s.id)
      .then(() => onChanged())
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not withdraw'))
      .finally(() => setBusy(false))
  }

  return (
    <li className="border-t border-border/60 py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[13px] font-medium text-ink">{s.name}</span>
        <span className="tnum font-mono text-[11px] text-faint">port {s.gamePort ?? 'not set'}</span>
        {entry?.address && (
          <span className="ml-auto">
            <Copyable value={entry.address} />
          </span>
        )}
        {!entry && s.gamePort !== null && !arming && (
          <span className="ml-auto">
            <Btn onClick={() => setArming(true)} disabled={busy} label="Expose to the internet…" />
          </span>
        )}
        {entry && (
          <span className={entry.address ? '' : 'ml-auto'}>
            <Btn onClick={withdraw} disabled={busy} tone="danger" label={busy ? 'Withdrawing…' : 'Withdraw'} />
          </span>
        )}
      </div>
      {entry && (
        <p className="prose-line mt-1 text-[12px] leading-relaxed text-muted-foreground">{entry.detail}</p>
      )}
      {arming && !entry && (
        <div className="mt-2.5 rounded-md border border-bad/40 bg-bad/5 p-3">
          <p className="prose-line text-[12px] leading-relaxed text-ink">
            This makes <span className="font-semibold">{s.name}</span>'s game port {s.gamePort}{' '}
            reachable by anyone on the internet, at an address playit assigns. Whitelist and
            online-mode are whatever this server's own settings say; nothing here changes them.
            Type the server's exact name to arm the button.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={s.name}
              spellCheck={false}
              autoComplete="off"
              className="h-8 max-w-60 font-mono text-[12px]"
            />
            <Btn onClick={expose} disabled={busy || typed !== s.name} tone="danger" label={busy ? 'Exposing…' : 'Expose'} />
            <button
              type="button"
              onClick={() => {
                setArming(false)
                setTyped('')
              }}
              className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-ink"
            >
              cancel
            </button>
          </div>
        </div>
      )}
      {err && <p className="prose-line mt-2 text-[12px] text-bad">{err}</p>}
    </li>
  )
}

export function PublicPage({ servers }: { servers: ServerStatus[] }) {
  const [status, setStatus] = useState<TunnelStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    dashboard
      .getTunnelStatus()
      .then(setStatus)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not read tunnel status'))
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  const install = () => {
    setBusy(true)
    setErr(null)
    dashboard
      .tunnelInstall()
      .then(() => refresh())
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'the install was refused'))
      .finally(() => setBusy(false))
  }

  const stop = () => {
    setBusy(true)
    dashboard
      .tunnelStopAgent()
      .then(() => refresh())
      .finally(() => setBusy(false))
  }

  const exposable = servers.filter(
    (s) => s.classification === 'live' || s.classification === 'never-started',
  )
  const agent = status?.agent

  return (
    <div className="mx-auto max-w-3xl">
      <section className="pb-7">
        <SectionHead
          title="Public access"
          note="Reaches your servers from outside through a playit.gg tunnel, without touching the router. Off by default, per server, never a side effect of starting a server, and nothing on this page runs on a timer: the agent runs when you start it and stops when you stop it or the dashboard exits."
        />
        {err && <Note tone="bad">{err}</Note>}
      </section>

      <section className="pb-7">
        <SectionHead title="The agent" note="playit's own program carries the tunnel traffic. Each step below is separate and none happens on its own." />
        {!agent && !err && <p className="text-[12px] text-faint">Reading…</p>}
        {agent && (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span
                className={`font-mono text-[10px] uppercase tracking-[0.1em] ${
                  agent.state === 'connected' ? 'text-ok' : agent.state === 'error' ? 'text-bad' : 'text-muted-foreground'
                }`}
              >
                {agent.state.replace(/-/g, ' ')}
              </span>
              {agent.version && <span className="font-mono text-[11px] text-faint">{agent.version}</span>}
            </div>
            {/* The server's sentence about the state; written for a person. */}
            <p className="prose-line mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{agent.detail}</p>

            {agent.state === 'not-installed' && (
              <div className="mt-2.5">
                <Btn
                  onClick={install}
                  disabled={busy}
                  tone="primary"
                  label={busy ? 'Downloading and verifying…' : 'Install the agent'}
                />
                <p className="prose-line mt-1.5 text-[11px] leading-relaxed text-faint">
                  Downloads playit's signed build and verifies it twice: against the sha256 digest
                  the release declares, and against its publisher signature. Nothing is executed
                  by installing.
                </p>
              </div>
            )}
            {agent.state === 'installed' && <div className="mt-2.5"><ClaimPanel onClaimed={refresh} /></div>}
            {agent.state === 'claimed' && <RunAgentPanel onChanged={refresh} />}
            {(agent.state === 'connected' || agent.state === 'starting' || agent.state === 'disconnected') && (
              <div className="mt-2.5">
                <Btn onClick={stop} disabled={busy} label="Stop the agent" />
                <p className="prose-line mt-1.5 text-[11px] leading-relaxed text-faint">
                  Stopping hides every tunnel address and ends public reachability. The servers
                  themselves keep running and stay reachable on the LAN.
                </p>
              </div>
            )}
          </>
        )}
      </section>

      <section className="pb-7">
        <SectionHead
          title="Servers"
          note="Exposing a server is its own decision, armed by typing its exact name. An address appears only while the agent above reports connected; at every other moment the column is empty because nothing is serving the tunnel."
        />
        {status && exposable.length === 0 && (
          <p className="text-[12px] text-faint">No servers are available to expose.</p>
        )}
        {status && (
          <ul>
            {exposable.map((s) => (
              <ServerRow key={s.id} s={s} status={status} onChanged={refresh} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
