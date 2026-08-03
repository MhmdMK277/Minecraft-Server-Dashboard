import { useCallback, useEffect, useRef, useState } from 'react'
import type { CreateFlavor, CreationInfo, CreationJobStatus, RemoveFailedResult } from '@shared/api'
import { dashboard } from './client'
import { Btn, Note, SectionHead } from './controls'
import { Input } from '@/components/ui/input'

/**
 * Creating a server, which is the surface where consent actually happens.
 *
 * The backend refuses everything refusable (EULA, taken ports, bad names,
 * unverifiable downloads), so nothing here is load-bearing for safety. What
 * this page is responsible for is LEGIBILITY: the three consents are three
 * visibly separate decisions, none pre-ticked, each stating its consequence
 * before the click:
 *
 *   1. The Minecraft EULA, with the real link, unticked by default.
 *   2. Running a downloaded installer (Forge/NeoForge), its own step with
 *      its own wording, after the download has already been verified.
 *   3. Provisioned Java, whose absolute-path consequence is printed next to
 *      the option, not revealed after choosing it.
 *
 * The generated RCON password is deliberately absent from this page. It is
 * written into the new server.properties and exists nowhere else: not in any
 * API response, not in the audit log, not here.
 */

const EULA_URL = 'https://aka.ms/MinecraftEULA'

/** Sort "1.21.4" style versions newest first. Anything unparsable sinks. */
function compareMcDesc(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map((n) => Number(n))
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (Number.isNaN(d)) return 0
    if (d !== 0) return d
  }
  return 0
}

/**
 * NeoForge starts at 1.20.2 and follows Mojang's date-based versions (26.1
 * onward) verbatim; offering anything older would only earn a refusal.
 */
function neoForgeCovers(v: string): boolean {
  if (/^\d{2,}\.\d+/.test(v)) return true
  const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(v)
  if (!m) return false
  const minor = Number(m[1])
  const patch = Number(m[2] ?? 0)
  return minor > 20 || (minor === 20 && patch >= 2)
}

/** What each source is and how its download is verified, next to the choice. */
const FLAVOR_NOTES: Record<Exclude<CreateFlavor, 'fabric'>, string> = {
  vanilla: "Mojang's own server jar, verified against the sha1 Mojang publishes for it.",
  paper: "Paper's server jar, verified against the sha256 PaperMC publishes for it.",
  forge:
    "Forge's installer jar, verified against the sha512 Forge publishes beside it. Running the installer is a separate step with its own confirmation, because it executes a downloaded program.",
  neoforge:
    "NeoForge's installer jar, verified against the sha512 NeoForge publishes beside it. Running the installer is a separate step with its own confirmation, because it executes a downloaded program.",
}

const ACTIVE_STATES: ReadonlyArray<CreationJobStatus['state']> = [
  'resolving',
  'downloading',
  'provisioning-java',
  'writing-config',
  'running-installer',
]

function radioClass(selected: boolean): string {
  return `flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 transition-colors duration-150 ${
    selected ? 'border-edge-strong bg-secondary/60' : 'border-border hover:bg-secondary/40'
  }`
}

// ------------------------------------------------------------------ the form

export function CreatePage() {
  const [info, setInfo] = useState<CreationInfo | null>(null)
  const [infoErr, setInfoErr] = useState<string | null>(null)

  const [flavor, setFlavor] = useState<CreateFlavor>('vanilla')
  const [versions, setVersions] = useState<string[] | null>(null)
  const [versionsErr, setVersionsErr] = useState<string | null>(null)
  const [forgePromos, setForgePromos] = useState<Record<string, string> | null>(null)
  const [mcVersion, setMcVersion] = useState('')
  const [loaderPin, setLoaderPin] = useState('')

  const [name, setName] = useState('')
  const [gamePort, setGamePort] = useState('')
  const [rconPort, setRconPort] = useState('')
  const [memory, setMemory] = useState('')
  const [javaMode, setJavaMode] = useState<'existing' | 'adoptium'>('existing')
  const [eula, setEula] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [submitErr, setSubmitErr] = useState<string | null>(null)
  const [makingRoot, setMakingRoot] = useState(false)
  const [rootErr, setRootErr] = useState<string | null>(null)

  const [jobs, setJobs] = useState<CreationJobStatus[]>([])
  const [startedOp, setStartedOp] = useState<string | null>(null)

  // The port suggestions arrive once and prefill; edits after that are the
  // operator's. Both ports are re-checked at creation time either way.
  useEffect(() => {
    dashboard
      .getCreateInfo()
      .then((i) => {
        setInfo(i)
        setGamePort((p) => p || String(i.suggestedGamePort))
        setRconPort((p) => p || String(i.suggestedRconPort))
      })
      .catch((e: unknown) => setInfoErr(e instanceof Error ? e.message : 'could not load'))
    dashboard.getCreateJobs().then((r) => setJobs(r.jobs)).catch(() => undefined)
  }, [])

  // The Java statement ("this version needs Java N") depends on the version,
  // so it refreshes when the version does.
  useEffect(() => {
    if (!mcVersion) return
    const t = setTimeout(() => {
      dashboard
        .getCreateInfo(mcVersion)
        .then((i) =>
          setInfo((prev) =>
            prev
              ? { ...prev, javaMajor: i.javaMajor, javaLink: i.javaLink }
              : i,
          ),
        )
        .catch(() => undefined)
    }, 300)
    return () => clearTimeout(t)
  }, [mcVersion])

  // Versions for the chosen flavor. Forge's list is its promotions map;
  // NeoForge tracks Mojang's versions from 1.20.2 up, so it reuses the
  // vanilla list rather than inventing one.
  useEffect(() => {
    setVersions(null)
    setVersionsErr(null)
    setForgePromos(null)
    setMcVersion('')
    setLoaderPin('')
    if (flavor === 'fabric') return
    if (flavor === 'forge') {
      dashboard
        .getForgePromos()
        .then((r) => {
          setForgePromos(r.promos)
          const mcs = [...new Set(Object.keys(r.promos).map((k) => k.replace(/-(recommended|latest)$/, '')))]
            .sort(compareMcDesc)
          setVersions(mcs)
          setMcVersion(mcs[0] ?? '')
        })
        .catch((e: unknown) => setVersionsErr(e instanceof Error ? e.message : 'could not load versions'))
      return
    }
    dashboard
      .getCreateVersions(flavor === 'neoforge' ? 'vanilla' : flavor)
      .then((r) => {
        const list = flavor === 'neoforge' ? r.versions.filter(neoForgeCovers) : r.versions
        setVersions(list)
        setMcVersion(list[0] ?? '')
      })
      .catch((e: unknown) => setVersionsErr(e instanceof Error ? e.message : 'could not load versions'))
  }, [flavor])

  const refreshJobs = useCallback(() => {
    dashboard.getCreateJobs().then((r) => setJobs(r.jobs)).catch(() => undefined)
  }, [])

  // Poll only while something is actually moving.
  const anyActive = jobs.some((j) => ACTIVE_STATES.includes(j.state))
  useEffect(() => {
    if (!anyActive) return
    const t = setInterval(refreshJobs, 1000)
    return () => clearInterval(t)
  }, [anyActive, refreshJobs])

  const create = () => {
    setSubmitting(true)
    setSubmitErr(null)
    dashboard
      .createServer({
        name: name.trim(),
        flavor,
        mcVersion,
        loaderVersion: loaderPin.trim() || null,
        gamePort: Number(gamePort),
        rconPort: Number(rconPort),
        eulaAccepted: eula,
        memoryMb: memory.trim() ? Number(memory) : null,
        javaMode,
      })
      .then((r) => {
        setStartedOp(r.opId)
        refreshJobs()
      })
      .catch((e: unknown) => setSubmitErr(e instanceof Error ? e.message : 'creation was refused'))
      .finally(() => setSubmitting(false))
  }

  // Create the missing servers root without leaving the page, so nothing typed
  // into the form is lost. The refusal used to force a manual mkdir + reload.
  const makeServersRoot = () => {
    setMakingRoot(true)
    setRootErr(null)
    dashboard
      .createServersRoot()
      .then((r) => setInfo((prev) => (prev ? { ...prev, parentDir: r.parentDir, parentDirExists: r.parentDirExists } : prev)))
      .catch((e: unknown) => setRootErr(e instanceof Error ? e.message : 'could not create the folder'))
      .finally(() => setMakingRoot(false))
  }

  const fabric = info?.flavors.find((f) => f.flavor === 'fabric')
  const isInstaller = flavor === 'forge' || flavor === 'neoforge'
  const forgePick =
    flavor === 'forge' && forgePromos && mcVersion
      ? forgePromos[`${mcVersion}-recommended`]
        ? { v: forgePromos[`${mcVersion}-recommended`], kind: 'recommended build' }
        : forgePromos[`${mcVersion}-latest`]
          ? { v: forgePromos[`${mcVersion}-latest`], kind: 'latest build, no recommended one exists' }
          : null
      : null

  const ready = eula && name.trim().length > 0 && mcVersion.length > 0 && !submitting
  const shownJobs = [...jobs].sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1))

  return (
    <div className="mx-auto max-w-3xl">
      <section className="pb-7">
        <SectionHead
          title="Create a server"
          note="Downloads the server software from its publisher, verifies it against the checksum the publisher states, and writes a normal server folder. A download that fails verification is deleted and the creation fails; there is no unverified fallback."
        />
        {infoErr && <Note tone="bad">{infoErr}</Note>}
      </section>

      {/* ------------------------------------------------------ 1. flavor */}
      <section className="pb-7">
        <SectionHead title="Software" note="Each source states how its download is verified. What cannot be verified is not offered." />
        <div className="grid gap-2">
          {(info?.flavors ?? []).map((f) =>
            f.available ? (
              <label key={f.flavor} className={radioClass(flavor === f.flavor)}>
                <input
                  type="radio"
                  name="flavor"
                  checked={flavor === f.flavor}
                  onChange={() => setFlavor(f.flavor)}
                  className="mt-0.5 size-3.5 accent-primary"
                />
                <span>
                  <span className="text-[13px] font-medium text-ink">{f.label}</span>
                  <span className="prose-line mt-0.5 block text-[11px] leading-relaxed text-faint">
                    {FLAVOR_NOTES[f.flavor]}
                  </span>
                </span>
              </label>
            ) : (
              // Fabric: present, disabled, with the reason in full. Hiding it
              // would look like an oversight; showing it refused is a statement.
              <div key={f.flavor} className="flex items-start gap-2.5 rounded-md border border-border/60 p-2.5 opacity-80">
                <input type="radio" name="flavor" disabled className="mt-0.5 size-3.5" />
                <span>
                  <span className="text-[13px] font-medium text-muted-foreground">
                    {f.label}
                    <span className="ml-2 font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
                      not offered
                    </span>
                  </span>
                  <span className="prose-line mt-0.5 block text-[11px] leading-relaxed text-faint">
                    {f.reason}
                  </span>
                </span>
              </div>
            ),
          )}
        </div>
      </section>

      {/* ----------------------------------------------------- 2. version */}
      <section className="pb-7">
        <SectionHead title="Version" note="Release versions, newest first, as the publisher lists them." />
        {versionsErr && <Note tone="warn">{versionsErr}</Note>}
        {!versions && !versionsErr && (
          <p className="text-[12px] text-faint">Asking the publisher…</p>
        )}
        {versions && (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={mcVersion}
              onChange={(e) => setMcVersion(e.target.value)}
              className="h-8 rounded-md border border-border bg-transparent px-2 font-mono text-[12px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {versions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            {forgePick && (
              <span className="prose-line text-[11px] text-faint">
                Forge {forgePick.v}, their {forgePick.kind}.
              </span>
            )}
            {flavor === 'neoforge' && (
              <span className="prose-line text-[11px] text-faint">
                The newest NeoForge build published for {mcVersion || 'that version'} will be used.
              </span>
            )}
          </div>
        )}
        {isInstaller && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Input
              value={loaderPin}
              onChange={(e) => setLoaderPin(e.target.value)}
              placeholder={flavor === 'forge' ? 'e.g. 47.3.0' : 'e.g. 21.4.147'}
              spellCheck={false}
              autoComplete="off"
              className="h-8 max-w-40 font-mono text-[12px]"
            />
            <span className="prose-line text-[11px] text-faint">
              Optional: pin an exact {flavor === 'forge' ? 'Forge' : 'NeoForge'} build. Left empty,
              the one named above is used.
            </span>
          </div>
        )}
      </section>

      {/* -------------------------------------------------------- 3. name */}
      <section className="pb-7">
        <SectionHead
          title="Name and folder"
          note="The name becomes a folder in the place discovery already watches, so the new server is found the same way every other server is. No separate registry, no special status."
        />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Server"
          spellCheck={false}
          autoComplete="off"
          className="max-w-md text-[13px]"
        />
        {info && (
          <p className="prose-line mt-1.5 break-all font-mono text-[11px] text-faint">
            {info.parentDir}
            {'\\'}
            {name.trim() || '…'}
          </p>
        )}
        {info && !info.parentDirExists && (
          <div className="mt-2 space-y-2">
            <Note tone="warn">
              The servers root <span className="font-mono">{info.parentDir}</span> does not exist
              yet, so creation would be refused. Create it here, or set a different servers root
              (see below) and it becomes where new servers and discovery both look.
            </Note>
            <div className="flex flex-wrap items-center gap-2">
              <Btn
                onClick={makeServersRoot}
                disabled={makingRoot}
                label={makingRoot ? 'Creating…' : 'Create this folder'}
              />
              <span className="prose-line text-[11px] text-faint">
                Keep your servers on another drive? The servers root is set in{' '}
                <code className="font-mono">%APPDATA%\minecraft-server-dashboard\config.json</code>{' '}
                (<code className="font-mono">{'{ "serversRoot": "E:\\\\your\\\\folder" }'}</code>);
                an in-app setting for it is coming in v0.2.0.
              </span>
            </div>
            {rootErr && <Note tone="bad">{rootErr}</Note>}
          </div>
        )}
        {info && info.parentDirExists && (
          <p className="prose-line mt-1.5 text-[11px] text-faint">
            New servers are created in the servers root, where discovery already looks. To keep them
            elsewhere, point the servers root at that drive (config.json for now; an in-app setting
            is coming in v0.2.0).
          </p>
        )}
      </section>

      {/* ------------------------------------------------------- 4. ports */}
      <section className="pb-7">
        <SectionHead
          title="Ports"
          note="Suggested from the fleet's own port map: the first ports that no watched server declares, for game or for RCON, and that nothing on the machine was listening on when this page loaded. Both are checked again at the moment of creation."
        />
        <div className="flex flex-wrap gap-5">
          <label className="grid gap-1 text-[11px] text-faint">
            Game port
            <Input
              value={gamePort}
              onChange={(e) => setGamePort(e.target.value)}
              inputMode="numeric"
              spellCheck={false}
              autoComplete="off"
              className="h-8 w-28 font-mono text-[12px]"
            />
          </label>
          <label className="grid gap-1 text-[11px] text-faint">
            RCON port
            <Input
              value={rconPort}
              onChange={(e) => setRconPort(e.target.value)}
              inputMode="numeric"
              spellCheck={false}
              autoComplete="off"
              className="h-8 w-28 font-mono text-[12px]"
            />
          </label>
          <label className="grid gap-1 text-[11px] text-faint">
            Memory, MB (optional)
            <Input
              value={memory}
              onChange={(e) => setMemory(e.target.value)}
              inputMode="numeric"
              placeholder="2048"
              spellCheck={false}
              autoComplete="off"
              className="h-8 w-28 font-mono text-[12px]"
            />
          </label>
        </div>
        {info && <MemoryGuidance requestedMb={memory.trim() ? Number(memory) : null} installedMb={info.installedRamMb} />}
        <p className="prose-line mt-2.5 text-[11px] leading-relaxed text-faint">
          RCON is enabled from the start, with a password generated at creation. It is written into
          the new server.properties and shown nowhere else: not on this page, not in the logs, not
          in the audit trail. If you ever need it yourself, read it from that file. It is what lets
          the dashboard probe this server's health and stop it cleanly.
        </p>
      </section>

      {/* -------------------------------------------------------- 5. java */}
      <section className="pb-7">
        <SectionHead title="Java" note="Which Java the start script will use." />
        <div className="grid gap-2">
          <label className={radioClass(javaMode === 'existing')}>
            <input
              type="radio"
              name="java"
              checked={javaMode === 'existing'}
              onChange={() => setJavaMode('existing')}
              className="mt-0.5 size-3.5 accent-primary"
            />
            <span>
              <span className="text-[13px] font-medium text-ink">Use the Java already on this machine</span>
              <span className="prose-line mt-0.5 block text-[11px] leading-relaxed text-faint">
                The default. The start script calls plain <code className="font-mono">java</code>,
                whatever is on PATH.{' '}
                {info?.javaMajor
                  ? `This version needs Java ${info.javaMajor} or newer; if you do not have it, `
                  : 'Pick a version above and the exact Java it needs is stated here; if you do not have it, '}
                <a
                  href={info?.javaLink ?? 'https://adoptium.net/temurin/releases/'}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground underline underline-offset-2 hover:text-ink"
                >
                  Adoptium has it
                </a>
                .
              </span>
            </span>
          </label>
          <label className={radioClass(javaMode === 'adoptium')}>
            <input
              type="radio"
              name="java"
              checked={javaMode === 'adoptium'}
              onChange={() => setJavaMode('adoptium')}
              className="mt-0.5 size-3.5 accent-primary"
            />
            <span>
              <span className="text-[13px] font-medium text-ink">
                Let the dashboard download a Java for this server
              </span>
              <span className="prose-line mt-0.5 block text-[11px] leading-relaxed text-faint">
                {info?.javaMajor
                  ? `A Temurin ${info.javaMajor} runtime from Adoptium, downloaded when you click Create, verified against Adoptium's checksum, and only for this one version. `
                  : "A Temurin runtime from Adoptium, downloaded when you click Create, verified against Adoptium's checksum, and only for the version this server needs. "}
                {/* The consequence, stated BEFORE the choice, in the server's own words. */}
                {info?.adoptiumConsequence}
              </span>
            </span>
          </label>
        </div>
      </section>

      {/* -------------------------------------------------------- 6. EULA */}
      <section className="pb-7">
        <SectionHead
          title="The Minecraft EULA"
          note="Running a Minecraft server means accepting Mojang's EULA. That is your decision, so the box starts unticked, and creation is refused without it."
        />
        <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-2.5">
          <input
            type="checkbox"
            checked={eula}
            onChange={(e) => setEula(e.target.checked)}
            className="mt-0.5 size-3.5 accent-primary"
          />
          <span className="prose-line text-[12px] leading-relaxed text-muted-foreground">
            I have read and accept the{' '}
            <a
              href={EULA_URL}
              target="_blank"
              rel="noreferrer"
              className="text-ink underline underline-offset-2"
            >
              Minecraft End User License Agreement
            </a>
            . Accepting writes <code className="font-mono">eula=true</code> into the new folder, and
            the acceptance is recorded in this dashboard's audit log under your username.
          </span>
        </label>
      </section>

      {/* ------------------------------------------------------ 7. create */}
      <section className="pb-7">
        <div className="flex flex-wrap items-center gap-3">
          <Btn
            onClick={create}
            disabled={!ready}
            tone="primary"
            label={submitting ? 'Creating…' : 'Create this server'}
          />
          {!eula && (
            <span className="text-[11px] text-faint">
              The EULA box above is unticked, so this button stays off.
            </span>
          )}
        </div>
        {submitErr && (
          <div className="mt-2.5">
            <Note tone="bad">{submitErr}</Note>
          </div>
        )}
      </section>

      {/* -------------------------------------------------------- 8. jobs */}
      {shownJobs.length > 0 && (
        <section className="pb-7">
          <SectionHead
            title="Creation operations"
            note="Every operation this service has run since it last started. A failed one stays listed until its folder is dealt with."
          />
          <ul>
            {shownJobs.map((j) => (
              <JobRow key={j.opId} job={j} highlight={j.opId === startedOp} onChanged={refreshJobs} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/**
 * Memory guidance, so a non-technical user does not hand a single server most
 * of the machine and leave nothing for the OS or the server's own off-heap
 * needs. States the installed RAM and warns on a dangerous fraction.
 *
 * The thresholds are a conservative first cut, deliberately flagged as such:
 * the operator asked to study how PocketMC and Crafty present this before we
 * settle ours, so this errs toward warning rather than toward a number we are
 * pretending is authoritative. A JVM's resident footprint exceeds its -Xmx
 * (metaspace, threads, direct buffers), so "leave headroom" is the honest
 * message, not a precise cap.
 */
function MemoryGuidance({ requestedMb, installedMb }: { requestedMb: number | null; installedMb: number }) {
  const gb = (mb: number) => {
    const v = (mb / 1024).toFixed(1)
    return v.endsWith('.0') ? v.slice(0, -2) : v
  }
  const base = (
    <>This machine has {gb(installedMb)} GB installed. Leave room for Windows and the server's own
    off-heap memory: a single server's heap much above half of installed RAM, or within ~2 GB of it,
    risks the machine swapping.</>
  )
  if (requestedMb == null || !Number.isFinite(requestedMb) || requestedMb <= 0) {
    return <p className="prose-line mt-2 text-[11px] leading-relaxed text-faint">{base} Left blank, the start script uses a modest default.</p>
  }
  const fractionHalf = requestedMb > installedMb * 0.5
  const withinTwoGb = requestedMb > installedMb - 2048
  const overInstalled = requestedMb >= installedMb
  const danger = overInstalled || withinTwoGb
  return (
    <div className="mt-2">
      {danger ? (
        <Note tone={overInstalled ? 'bad' : 'warn'}>
          {overInstalled
            ? `${gb(requestedMb)} GB is at or above this machine's ${gb(installedMb)} GB of installed RAM. The server cannot get that, and Windows will thrash. Pick a heap well below the installed total.`
            : `${gb(requestedMb)} GB leaves under 2 GB for Windows and the server's off-heap memory on a ${gb(installedMb)} GB machine, which risks swapping. Consider a smaller heap.`}
        </Note>
      ) : fractionHalf ? (
        <p className="prose-line text-[11px] leading-relaxed text-warn">
          {gb(requestedMb)} GB is more than half of this machine's {gb(installedMb)} GB. That can be
          fine for a dedicated host, but leaves less for anything else running.
        </p>
      ) : (
        <p className="prose-line text-[11px] leading-relaxed text-faint">{base}</p>
      )}
    </div>
  )
}

// -------------------------------------------------------------- one job row

function JobRow({
  job,
  highlight,
  onChanged,
}: {
  job: CreationJobStatus
  highlight: boolean
  onChanged: () => void
}) {
  const running = ACTIVE_STATES.includes(job.state)
  const toneText =
    job.state === 'failed'
      ? 'text-bad'
      : job.state === 'complete'
        ? 'text-ok'
        : job.state === 'awaiting-installer'
          ? 'text-warn'
          : 'text-muted-foreground'

  return (
    <li
      className={`border-t border-border/60 py-3 first:border-t-0 ${
        highlight ? 'rounded-md bg-secondary/30 px-3' : ''
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[13px] font-medium text-ink">{job.name}</span>
        <span className="font-mono text-[11px] text-faint">
          {job.flavor} {job.mcVersion}
        </span>
        <span className={`font-mono text-[10px] uppercase tracking-[0.1em] ${toneText}`}>
          {job.state.replace(/-/g, ' ')}
          {running ? '…' : ''}
        </span>
        {job.bytes !== null && job.state === 'downloading' && (
          <span className="tnum font-mono text-[11px] text-faint">
            {(job.bytes / 1024 / 1024).toFixed(1)} MB
          </span>
        )}
      </div>
      <p className="prose-line mt-1 break-all font-mono text-[11px] text-faint">{job.dir}</p>
      {/* The backend's sentence is the status. It was written for a person. */}
      <p className="prose-line mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{job.detail}</p>

      {job.state === 'awaiting-installer' && <InstallerConsent job={job} onChanged={onChanged} />}
      {job.state === 'failed' && <RemovePanel job={job} onChanged={onChanged} />}
    </li>
  )
}

/**
 * Consent number two. The download is already verified at this point; what
 * has NOT happened is running it, and that is a different thing to agree to.
 * The box starts unticked every time this renders.
 */
function InstallerConsent({ job, onChanged }: { job: CreationJobStatus; onChanged: () => void }) {
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const run = () => {
    setBusy(true)
    setErr(null)
    dashboard
      .runInstaller(job.opId, confirmed)
      .then(() => onChanged())
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'the installer was not run'))
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
          I understand this runs a program that was downloaded from the internet, the{' '}
          {job.flavor === 'forge' ? 'Forge' : 'NeoForge'} installer, on this machine. Its checksum
          matched the publisher's, which says the file is what they published, not that running it
          is harmless.
        </span>
      </label>
      <div className="mt-2.5 flex items-center gap-3 pl-6">
        <Btn
          onClick={run}
          disabled={!confirmed || busy}
          tone="primary"
          label={busy ? 'Running the installer…' : 'Run the installer'}
        />
        {!confirmed && (
          <span className="text-[11px] text-faint">Tick the box to enable this.</span>
        )}
      </div>
      {err && <p className="prose-line mt-2 pl-6 text-[12px] text-bad">{err}</p>}
    </div>
  )
}

/**
 * The failure path. The folder is already marked on disk by its journal;
 * removal deletes exactly what that journal lists and nothing else, and the
 * confirmation is TYPED, the folder's name, not a yes button.
 */
function RemovePanel({ job, onChanged }: { job: CreationJobStatus; onChanged: () => void }) {
  const folderName = job.dir.split('\\').pop() ?? job.name
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<RemoveFailedResult | null>(null)

  const remove = () => {
    setBusy(true)
    setErr(null)
    dashboard
      .removeFailedCreation(job.dir, typed)
      .then((r) => {
        setResult(r)
        onChanged()
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'nothing was removed'))
      .finally(() => setBusy(false))
  }

  if (result) {
    return (
      <div className="mt-2.5 rounded-md border border-border bg-secondary/40 p-3">
        <p className="prose-line text-[12px] leading-relaxed text-muted-foreground">
          Removed: {result.removed.length > 0 ? result.removed.join(', ') : 'nothing'}.
          {result.kept.length > 0 && (
            <>
              {' '}
              Kept, because the creation journal did not put them there and this dashboard does not
              delete what it did not create: <span className="font-mono">{result.kept.join(', ')}</span>.
              The folder stays until they are dealt with by hand.
            </>
          )}
        </p>
      </div>
    )
  }

  return (
    <div className="mt-2.5 rounded-md border border-bad/40 bg-bad/5 p-3">
      <p className="prose-line text-[12px] leading-relaxed text-ink">
        The folder was kept and marked. Removing it deletes only what this operation's journal
        recorded writing, the downloaded file and the config it generated; anything else found in
        the folder is kept and named. Nothing outside this one folder is ever touched.
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={folderName}
          spellCheck={false}
          autoComplete="off"
          className="h-8 max-w-60 font-mono text-[12px]"
        />
        <Btn
          onClick={remove}
          disabled={busy || typed !== folderName}
          tone="danger"
          label={busy ? 'Removing…' : 'Remove this folder'}
        />
      </div>
      <p className="prose-line mt-1.5 text-[11px] leading-relaxed text-faint">
        Type the folder's exact name, <span className="font-mono text-ink">{folderName}</span>, to
        arm the button. A different name is refused.
      </p>
      {err && <p className="prose-line mt-2 text-[12px] text-bad">{err}</p>}
    </div>
  )
}
