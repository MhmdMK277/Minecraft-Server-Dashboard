import { useState } from 'react'
import type { AttachCandidate, ConfirmedLaunch, IdentityScan, ScanCandidate, ScanResult } from '@shared/api'
import { dashboard } from './client'
import { Btn } from './controls'
import { Indicator } from './status'
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

/**
 * One folder the scan found, offered to the operator.
 *
 * The offer is the whole point of the scan. Before this existed, a server
 * started the canonical way (`java -jar server.jar nogui`) produced one
 * anonymous java process and an honest banner saying so, and nothing the
 * operator could act on. Now the folder is named and one click away.
 */
function Candidate({ c, onDone }: { c: ScanCandidate; onDone: () => void }) {
  const [candidate, setCandidate] = useState<AttachCandidate | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const inspect = () => {
    setErr(null)
    dashboard
      .validateAttach(c.dir)
      .then(setCandidate)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not read that folder'))
  }

  const attach = (launch: ConfirmedLaunch | null) => {
    setBusy(true)
    setErr(null)
    dashboard
      .attach(c.dir, launch)
      .then(() => onDone())
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not attach'))
      .finally(() => setBusy(false))
  }

  return (
    <li className="border-t border-border/60 py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={`flex size-4 items-center justify-center ${c.running ? 'text-ok' : 'text-faint'}`}
          title={c.running ? 'A java process is holding this folder open' : 'Nothing is running here'}
        >
          <Indicator tone={c.running ? 'ok' : 'muted'} confidence="measured" large={false} />
        </span>
        <span className="text-[13px] font-medium text-ink">{c.name}</span>
        {c.running && (
          <span className="tnum font-mono text-[11px] text-ok">running, pid {c.pid}</span>
        )}
        {!c.looksLikeServer && (
          <span className="text-[11px] text-faint">no world generated yet</span>
        )}
        <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-faint">{c.dir}</span>
        {!candidate && <Btn onClick={inspect} label="Check this folder" />}
      </div>
      {candidate && !candidate.ok && (
        <p className="prose-line mt-2 text-[12px] text-bad">{candidate.reason}</p>
      )}
      {candidate && candidate.ok && <Preview c={candidate} onAttach={attach} busy={busy} />}
      {err && <p className="prose-line mt-2 text-[12px] text-bad">{err}</p>}
    </li>
  )
}

/**
 * Searching the machine. Deliberately operator-initiated: it walks the
 * filesystem, and a dashboard that does that on its own ten-second loop
 * would be the observer becoming the load.
 */
export function ScanPanel({ onChanged, dense }: { onChanged: () => void; dense?: boolean }) {
  const [result, setResult] = useState<ScanResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const run = (fresh: boolean) => {
    setBusy(true)
    setErr(null)
    dashboard
      .discover(fresh)
      .then(setResult)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not search'))
      .finally(() => setBusy(false))
  }

  const fresh = result?.candidates.filter((c) => c.known === 'new') ?? []
  const running = fresh.filter((c) => c.running)
  const idle = fresh.filter((c) => !c.running)
  const alreadyKnown = result?.candidates.filter((c) => c.known !== 'new').length ?? 0

  return (
    <div className={dense ? '' : 'mt-3'}>
      {!result && (
        <Btn
          onClick={() => run(false)}
          disabled={busy}
          tone={dense ? 'primary' : undefined}
          label={busy ? 'Searching…' : 'Look for servers on this machine'}
        />
      )}
      {err && <p className="prose-line mt-2 text-[12px] text-bad">{err}</p>}

      {result && (
        <>
          <p className="prose-line text-[11px] leading-relaxed text-faint">
            Searched {result.roots.length} location{result.roots.length === 1 ? '' : 's'} in{' '}
            {result.ms} ms{result.cached ? ', showing the search already done' : ''}. Found{' '}
            {result.candidates.length} folder{result.candidates.length === 1 ? '' : 's'} holding a{' '}
            <code className="font-mono">server.properties</code>
            {alreadyKnown > 0 ? `, ${alreadyKnown} of which this dashboard already watches` : ''}.{' '}
            <button
              type="button"
              onClick={() => run(true)}
              disabled={busy}
              className="text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-ink disabled:opacity-50"
            >
              {busy ? 'Searching…' : 'Search again'}
            </button>
          </p>

          {running.length > 0 && (
            <>
              <div className="mt-3 font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
                Running now, and not watched
              </div>
              <ul className="mt-1">
                {running.map((c) => (
                  <Candidate key={c.dir} c={c} onDone={onChanged} />
                ))}
              </ul>
            </>
          )}

          {idle.length > 0 && (
            <>
              <div className="mt-4 font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
                Server folders that are not running
              </div>
              <p className="prose-line mt-1 text-[11px] leading-relaxed text-faint">
                Nothing is running in these. Some will be servers you keep for later; some will be
                backups or copies, which is why none of them is added for you.
              </p>
              <ul className="mt-1">
                {idle.map((c) => (
                  <Candidate key={c.dir} c={c} onDone={onChanged} />
                ))}
              </ul>
            </>
          )}

          {fresh.length === 0 && (
            <p className="prose-line mt-2 text-[12px] leading-relaxed text-faint">
              Nothing new found. If your server lives somewhere the search does not reach, the
              default places are your profile, Documents and Desktop, plus two levels down each
              drive, you can still add its folder by path below.
            </p>
          )}
        </>
      )}
    </div>
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

      {/*
        The canonical-start case. A server run as `java -jar server.jar nogui`
        has no directory anywhere in its command line, so it arrives here as
        an anonymous java process with nothing to click. Searching the
        machine for the folder is what turns that honest banner into an
        offer. See docs/liveness-spec.md section 17.
      */}
      {identity.unattributed > 0 && (
        <div className={unwatched.length > 0 ? 'mt-4 border-t border-border/60 pt-3' : ''}>
          <h3 className="text-[13px] font-semibold text-warn">
            {identity.unattributed} running java process
            {identity.unattributed === 1 ? '' : 'es'} could not be matched to a folder
          </h3>
          <p className="prose-line mt-1 text-[12px] leading-relaxed text-muted-foreground">
            That is what a server started with <code className="font-mono">java -jar server.jar</code>{' '}
            looks like from outside: the command line names no directory. Searching this machine
            for server folders finds it, by looking for which folder a running process is holding
            open.
          </p>
          <ScanPanel onChanged={onChanged} />
        </div>
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
