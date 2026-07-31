import { useState } from 'react'
import type { AttachCandidate, ConfirmedLaunch, IdentityScan } from '@shared/api'
import { dashboard } from './client'
import { Btn } from './controls'
import { Input } from '@/components/ui/input'

/**
 * Attaching a server folder the dashboard did not discover.
 *
 * The product argument for this surface: the dashboard's most honest moment
 * is admitting it can see a running Minecraft server it is not watching. The
 * useful version of that admission is an action.
 *
 * Two paths, one confirmation. The automatic one starts from a JVM whose
 * directory identity already resolved, so nothing is guessed. The manual one
 * takes a path the operator types. Both run the same validation and show the
 * same preview, and NOTHING is written until the operator confirms what they
 * are looking at.
 */

function Preview({
  c,
  onAttach,
  busy,
}: {
  c: Extract<AttachCandidate, { ok: true }>
  onAttach: (launch: ConfirmedLaunch | null) => void
  busy: boolean
}) {
  const [useScript, setUseScript] = useState(false)

  return (
    <div className="mt-3 rounded-md border border-border bg-secondary/40 p-3">
      <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-faint">What was found</div>
      <p className="prose-line mt-1.5 break-all font-mono text-[11px] text-ink">{c.dir}</p>

      <dl className="mt-2.5 grid grid-cols-2 gap-x-5 gap-y-1.5 text-[12px] sm:grid-cols-4">
        <div>
          <dt className="font-mono text-[9px] uppercase tracking-[0.1em] text-faint">Port</dt>
          <dd className="tnum font-mono text-ink">{c.gamePort ?? 'not set'}</dd>
        </div>
        <div>
          <dt className="font-mono text-[9px] uppercase tracking-[0.1em] text-faint">World</dt>
          <dd className="font-mono text-ink">{c.levelName ?? '–'}</dd>
        </div>
        <div>
          <dt className="font-mono text-[9px] uppercase tracking-[0.1em] text-faint">Worlds found</dt>
          <dd className="tnum font-mono text-ink">{c.worldDirs.length}</dd>
        </div>
        <div>
          <dt className="font-mono text-[9px] uppercase tracking-[0.1em] text-faint">RCON</dt>
          <dd className="font-mono text-ink">{c.rconConfigured ? 'enabled' : 'not enabled'}</dd>
        </div>
      </dl>

      {!c.rconConfigured && (
        <p className="prose-line mt-2 text-[11px] leading-relaxed text-faint">
          Without RCON the main game thread cannot be probed, so this server's health will read
          UNKNOWN rather than being guessed at, and it cannot be stopped from here.
        </p>
      )}

      {/*
        The launch method is CONFIRMED here or it does not exist. A start.bat
        found in the folder is reported, never assumed: the dashboard has
        never run it and does not know whether it starts one server or four.
      */}
      <div className="mt-3 border-t border-border/60 pt-2.5">
        <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
          How it starts
        </div>
        {c.launchCandidate?.strategy === 'script' ? (
          <>
            <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-[12px] text-muted-foreground">
              <input
                type="checkbox"
                checked={useScript}
                onChange={(e) => setUseScript(e.target.checked)}
                className="mt-0.5 size-3.5 accent-primary"
              />
              <span className="prose-line">
                Let the dashboard start this server by running{' '}
                <code className="font-mono text-ink">{c.launchCandidate.script}</code>, which is in
                that folder. Tick this only if that script is how you start it yourself.
              </span>
            </label>
            <p className="prose-line mt-1.5 pl-6 text-[11px] leading-relaxed text-faint">
              Leave it unticked and the server is still watched, still stoppable over RCON, and the
              Start button simply stays unavailable.
            </p>
          </>
        ) : (
          <p className="prose-line mt-1.5 text-[12px] leading-relaxed text-faint">
            No start script was found in that folder, so the Start button will be unavailable. The
            dashboard will not guess a java command line; that is how a second copy of a server ends
            up running on one world.
          </p>
        )}
      </div>

      <p className="prose-line mt-3 text-[11px] leading-relaxed text-faint">
        Attaching writes nothing into the server's folder. It adds the path to this dashboard's own
        list so the folder is scanned like any other server.
      </p>

      <div className="mt-2.5">
        <Btn
          onClick={() =>
            onAttach(useScript && c.launchCandidate ? c.launchCandidate : null)
          }
          disabled={busy}
          tone="primary"
          label={busy ? 'Attaching…' : 'Attach this folder'}
        />
      </div>
    </div>
  )
}

/** One unwatched server, with the auto path: its directory is already known. */
function Unwatched({
  entry,
  onDone,
}: {
  entry: IdentityScan['unwatched'][number]
  onDone: () => void
}) {
  const [candidate, setCandidate] = useState<AttachCandidate | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const inspect = () => {
    setErr(null)
    dashboard
      .validateAttach(entry.dir)
      .then(setCandidate)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not read that folder'))
  }

  const attach = (launch: ConfirmedLaunch | null) => {
    setBusy(true)
    setErr(null)
    dashboard
      .attach(entry.dir, launch)
      .then(() => onDone())
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not attach'))
      .finally(() => setBusy(false))
  }

  return (
    <li className="border-t border-border/60 py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="tnum font-mono text-[11px] text-faint">pid {entry.pid}</span>
        <span className="min-w-0 flex-1 break-all font-mono text-[12px] text-ink">{entry.dir}</span>
        {!candidate && (
          <Btn onClick={inspect} label="Identify this server" />
        )}
      </div>
      {!entry.looksLikeServer && (
        <p className="prose-line mt-1 text-[11px] leading-relaxed text-warn">
          That folder does not have a world with a level.dat in it right now, so it may have been
          moved, or this java process may not be a Minecraft server at all.
        </p>
      )}
      {candidate && !candidate.ok && (
        <p className="prose-line mt-2 text-[12px] text-bad">{candidate.reason}</p>
      )}
      {candidate && candidate.ok && <Preview c={candidate} onAttach={attach} busy={busy} />}
      {err && <p className="prose-line mt-2 text-[12px] text-bad">{err}</p>}
    </li>
  )
}

export function AttachPanel({
  identity,
  onChanged,
}: {
  identity: IdentityScan
  onChanged: () => void
}) {
  const [path, setPath] = useState('')
  const [candidate, setCandidate] = useState<AttachCandidate | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const unwatched = identity.unwatched ?? []

  const check = () => {
    setErr(null)
    setCandidate(null)
    dashboard
      .validateAttach(path.trim())
      .then(setCandidate)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not read that folder'))
  }

  const attach = (launch: ConfirmedLaunch | null) => {
    if (!candidate?.ok) return
    setBusy(true)
    dashboard
      .attach(candidate.dir, launch)
      .then(() => {
        setPath('')
        setCandidate(null)
        setOpen(false)
        onChanged()
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not attach'))
      .finally(() => setBusy(false))
  }

  if (unwatched.length === 0 && !open) {
    return (
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[12px] text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-ink"
        >
          Add a server folder
        </button>
      </div>
    )
  }

  return (
    <section className="mt-4 rounded-lg border border-warn/40 bg-warn/5 p-3.5">
      {unwatched.length > 0 && (
        <>
          <h3 className="text-[13px] font-semibold text-warn">
            {unwatched.length} running server{unwatched.length === 1 ? '' : 's'} on this machine
            {unwatched.length === 1 ? ' is' : ' are'} not being watched
          </h3>
          <p className="prose-line mt-1 text-[12px] leading-relaxed text-muted-foreground">
            These java processes were matched to a folder, but the folder is not under the servers
            root and has not been attached, so nothing above says anything about them. Attaching one
            makes it a server like any other: health, console, controls and settings.
          </p>
          <ul className="mt-2.5">
            {unwatched.map((u) => (
              <Unwatched key={u.pid} entry={u} onDone={onChanged} />
            ))}
          </ul>
        </>
      )}

      <div className={unwatched.length > 0 ? 'mt-4 border-t border-border/60 pt-3' : ''}>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') check()
            }}
            placeholder="C:\Servers\My Server"
            spellCheck={false}
            autoComplete="off"
            className="max-w-md flex-1 font-mono text-[12px]"
          />
          <Btn onClick={check} disabled={!path.trim()} label="Check this folder" />
        </div>
        <p className="prose-line mt-1.5 text-[11px] leading-relaxed text-faint">
          The folder holding <code className="font-mono">server.properties</code>, not a jar.
        </p>
        {candidate && !candidate.ok && (
          <p className="prose-line mt-2 text-[12px] text-bad">{candidate.reason}</p>
        )}
        {candidate && candidate.ok && <Preview c={candidate} onAttach={attach} busy={busy} />}
        {err && <p className="prose-line mt-2 text-[12px] text-bad">{err}</p>}
      </div>
    </section>
  )
}
