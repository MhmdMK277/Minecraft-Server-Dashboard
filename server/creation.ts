import { randomBytes, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer as netServer } from 'node:net'
import { basename, join, resolve, normalize } from 'node:path'
import { spawn } from 'node:child_process'
import { audit } from './audit'
import { attachDir } from './attach'
import { fetchVerified } from './fetchverify'
import { gamePortOf, rconConfig } from './properties'
import {
  resolveVanilla,
  resolvePaper,
  resolveForge,
  resolveNeoForge,
  flavorCatalog,
  requiredJavaMajor,
  requiredJavaMajorLive,
  adoptiumLink,
  type Flavor,
  type ResolvedDownload,
  type Fetchers,
} from './mcsources'

/**
 * Creating a server from nothing: the one time a folder is OURS.
 *
 * The attach model's rule is that the dashboard never owns a server
 * directory. Creation is the single, bounded exception, and it ends the
 * moment creation completes: the folder is then handed to the same discovery
 * and attach machinery every other server goes through. There is no
 * "created by us" class, no second registry, and nothing that treats a
 * created server differently afterwards.
 *
 * The rules, each of which maps to a way this feature could destroy
 * something:
 *
 *   - **No EULA, no creation.** Nothing is written, not even the folder,
 *     until the operator has accepted Mojang's EULA, and the acceptance is
 *     recorded in the audit log with who and when.
 *   - **The folder must not exist.** Creation never adopts, merges into, or
 *     overwrites a directory. If the name is taken, the answer is no.
 *   - **Ports are chosen against everything the fleet declares.** A new
 *     server that binds a live server's port does not fail cleanly: whichever
 *     starts second sits in a crash loop. Both game and RCON ports are
 *     checked against every known directory's declared ports and against
 *     what is actually listening right now.
 *   - **RCON is on with a generated password, never blank.** A server this
 *     dashboard cannot probe is a server whose STALLED state is invisible.
 *     The password is written into server.properties and returned to no one:
 *     the dashboard reads it back from the file the same way it does for
 *     every other server.
 *   - **Everything written is journaled.** `.mcdash-creation.json` in the
 *     folder lists every file this operation created. A failed creation
 *     leaves the folder marked, and removal deletes exactly the journal's
 *     list: a file the journal does not name survives and is reported.
 *   - **An installer is a program, and running it is a separate decision.**
 *     Forge and NeoForge creations stop at 'awaiting-installer' after the
 *     verified download; a distinct call, carrying an explicit confirmation
 *     field, runs it. The API cannot run what the operator did not
 *     explicitly confirm.
 */

export type JavaChoice = { mode: 'existing' } | { mode: 'adoptium' }

export type CreateRequest = {
  name: string
  flavor: Flavor
  mcVersion: string
  /** Forge/NeoForge build; null means their recommended/latest. */
  loaderVersion: string | null
  gamePort: number
  rconPort: number
  eulaAccepted: boolean
  memoryMb: number | null
  java: JavaChoice
  /** Absolute target parent; the servers root unless the operator chose. */
  parentDir: string
}

export type CreationState =
  | 'resolving'
  | 'downloading'
  | 'provisioning-java'
  | 'writing-config'
  | 'awaiting-installer'
  | 'running-installer'
  | 'complete'
  | 'failed'

export type CreationJob = {
  opId: string
  name: string
  dir: string
  flavor: Flavor
  mcVersion: string
  state: CreationState
  /** One human sentence about where it is or why it stopped. */
  detail: string
  startedAt: string
  /** Set when state is failed. */
  error: string | null
  /** What downloading is doing, for a progress line. */
  bytes: number | null
}

const JOURNAL = '.mcdash-creation.json'

type Journal = {
  version: 1
  opId: string
  name: string
  flavor: Flavor
  mcVersion: string
  startedAt: string
  state: CreationState
  error: string | null
  /** Relative paths of files this operation wrote, in creation order. */
  files: string[]
  /** Relative paths of directories this operation (or its installer) made. */
  dirs: string[]
  /** Absolute home of a provisioned Java, when the operator chose that. */
  javaHome?: string | null
}

const jobs = new Map<string, CreationJob>()

/** Live jobs for the UI; the journal on disk is the durable record. */
export function listJobs(): CreationJob[] {
  return [...jobs.values()]
}
export function jobFor(opId: string): CreationJob | null {
  return jobs.get(opId) ?? null
}

function readJournal(dir: string): Journal | null {
  try {
    const j = JSON.parse(readFileSync(join(dir, JOURNAL), 'utf8')) as Journal
    return j && j.version === 1 && typeof j.opId === 'string' ? j : null
  } catch {
    return null
  }
}

function writeJournal(dir: string, j: Journal): void {
  const p = join(dir, JOURNAL)
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8')
  renameSync(tmp, p)
}

// ------------------------------------------------------------------- names

/**
 * A name becomes a directory under the parent, so it is validated as a leaf
 * and nothing else: no separators, no traversal, no Windows reserved device
 * names, no trailing dot or space (which NTFS strips, silently renaming the
 * folder relative to what the journal records).
 */
export function validateName(name: string): { ok: true } | { ok: false; reason: string } {
  const n = name ?? ''
  if (n.length === 0) return { ok: false, reason: 'A name is required.' }
  if (n.length > 64) return { ok: false, reason: 'Keep the name under 64 characters.' }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(n)) {
    return {
      ok: false,
      reason: 'Letters, digits, spaces, dots, hyphens and underscores only, starting with a letter or digit.',
    }
  }
  if (/[. ]$/.test(n)) return { ok: false, reason: 'Windows silently strips a trailing dot or space; end with a letter or digit.' }
  if (n.includes('..')) return { ok: false, reason: 'Consecutive dots are not allowed.' }
  const stem = n.split('.')[0]!.trim().toUpperCase()
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    return { ok: false, reason: `${stem} is a reserved device name on Windows.` }
  }
  return { ok: true }
}

// ------------------------------------------------------------------- ports

/**
 * Every port any known directory declares, live or not. A retired server's
 * port is deliberately included: retired means "not running", not "gone",
 * and the operator can start it again tomorrow.
 */
export function collectTakenPorts(dirs: string[]): Map<number, string> {
  const taken = new Map<number, string>()
  for (const dir of dirs) {
    const g = gamePortOf(dir)
    if (g && !taken.has(g)) taken.set(g, `${basename(dir)} declares game port ${g}`)
    const r = rconConfig(dir)
    if (r?.port && !taken.has(r.port)) taken.set(r.port, `${basename(dir)} declares RCON port ${r.port}`)
  }
  return taken
}

/** Is anything on this host listening on the port right now? */
export function portListening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = netServer()
    s.once('error', () => done(true))
    s.once('listening', () => s.close(() => done(false)))
    s.listen(port, '0.0.0.0')
  })
}

/** First free port at or above `from`, avoiding everything declared. */
export async function suggestPort(from: number, taken: Map<number, string>): Promise<number> {
  for (let p = from; p < from + 200; p++) {
    if (taken.has(p)) continue
    if (!(await portListening(p))) return p
  }
  return from + 200
}

// ---------------------------------------------------------------- password

/**
 * URL-and-properties-safe alphabet, 24 characters, ~143 bits. Never blank,
 * and never returned to a caller: it goes into server.properties and is read
 * back from there like any other server's.
 */
export function generateRconPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = randomBytes(24)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

// ---------------------------------------------------------------- creation

export type CreateRefusal = { ok: false; reason: string }
export type CreateAccepted = { ok: true; opId: string; dir: string }

export type CreateDeps = {
  /** Directories whose declared ports count as taken. */
  knownDirs: string[]
  fetchers?: Fetchers
  /** Test seam: replaces the real download with a local fixture. */
  download?: (r: ResolvedDownload, dest: string) => Promise<{ bytes: number }>
  /** Provisions a Java runtime; wired to javaprovision.provisionJava. */
  provision?: (major: number) => Promise<{ javaHome: string; reused: boolean }>
  /**
   * Both REQUIRED and explicit (decision 0010): creation must never resolve
   * these itself, because a proof world that forgot to set an env var would
   * silently attach into the operator's real data directory. The route
   * passes the freshly loaded config; proofs pass their throwaway world.
   */
  dataDir: string
  serversRoot: string
  actor: string | null
  role: string | null
  ip: string
}

function normPath(p: string): string {
  return resolve(normalize(p)).replace(/[\\/]+$/, '').toLowerCase()
}

/** True when child is parent or lies anywhere under it. */
function isUnder(child: string, parent: string): boolean {
  const c = normPath(child)
  const p = normPath(parent)
  return c === p || c.startsWith(p + '\\')
}

/**
 * The hostile-parent refusal matrix (decision 0010). The operator picks the
 * parent folder, so the parent is now a request field, and every way a bad
 * pick could end in an invisible, nested, or self-hosted server is refused
 * here, before anything touches disk.
 */
function refuseHostileParent(parentDir: string, deps: CreateDeps): CreateRefusal | null {
  if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) {
    return { ok: false, reason: 'The target parent folder does not exist. Creation only targets a folder that is already there.' }
  }

  // The configured servers root is the default target and worked before this
  // matrix existed; it is never refused here, wherever it lives. (Proof
  // worlds routinely put it INSIDE their throwaway data dir.)
  if (normPath(parentDir) === normPath(deps.serversRoot)) return null

  // The dashboard's own data directory holds sessions, the audit log and the
  // attach registry. A server in there is a server inside the observer.
  // One direction only: a parent that merely CONTAINS the data dir (a home
  // folder contains %APPDATA%) is harmless, because the created folder is a
  // new direct child and an existing folder is refused below.
  if (isUnder(parentDir, deps.dataDir)) {
    return { ok: false, reason: "That folder is inside the dashboard's own data directory. Servers cannot be created there." }
  }

  // Inside the servers root but deeper than its direct children: discovery
  // lists only the root's direct children, and attach refuses anything
  // inside the root, so a server created there would be invisible to both.
  if (isUnder(parentDir, deps.serversRoot)) {
    return {
      ok: false,
      reason:
        'That folder is inside the servers root, where servers live directly under the root itself. Pick the servers root, or a folder outside it.',
    }
  }

  // The parent, or any folder above it, already being a server means the new
  // server would sit inside a server directory, exactly where a world walk,
  // a backup or a folder removal would sweep it up.
  let probe = resolve(normalize(parentDir))
  for (;;) {
    if (existsSync(join(probe, 'server.properties'))) {
      return {
        ok: false,
        reason: `That folder is a server folder, or sits inside one (${probe} holds a server.properties). A server cannot be created inside a server.`,
      }
    }
    const up = resolve(probe, '..')
    if (up === probe) break
    probe = up
  }

  return null
}

export async function startCreation(req: CreateRequest, deps: CreateDeps): Promise<CreateRefusal | CreateAccepted> {
  // Every refusal below happens BEFORE anything touches disk.
  const name = validateName(req.name)
  if (!name.ok) return { ok: false, reason: name.reason }

  const cat = flavorCatalog().find((c) => c.flavor === req.flavor)
  if (!cat) return { ok: false, reason: 'Unknown server flavor.' }
  if (!cat.available) return { ok: false, reason: cat.reason }

  if (!req.eulaAccepted) {
    return {
      ok: false,
      reason:
        'Minecraft servers require accepting the Minecraft EULA (https://aka.ms/MinecraftEULA). Nothing was created.',
    }
  }

  const parentRefusal = refuseHostileParent(req.parentDir, deps)
  if (parentRefusal) return parentRefusal
  const dir = resolve(normalize(join(req.parentDir, req.name)))
  if (basename(dir) !== req.name) return { ok: false, reason: 'That name does not survive as a folder name.' }
  if (existsSync(dir)) {
    return { ok: false, reason: `A folder named "${req.name}" already exists there. Creation never touches an existing folder.` }
  }

  if (req.gamePort === req.rconPort) return { ok: false, reason: 'Game and RCON ports must differ.' }
  const taken = collectTakenPorts(deps.knownDirs)
  for (const [port, label] of [
    [req.gamePort, 'game port'],
    [req.rconPort, 'RCON port'],
  ] as const) {
    const holder = taken.get(port)
    if (holder) return { ok: false, reason: `Port ${port} is not free: ${holder}. Pick another ${label}.` }
    if (await portListening(port)) {
      return { ok: false, reason: `Something on this machine is already listening on port ${port}. Pick another ${label}.` }
    }
  }

  // The acceptance that legally matters, recorded before the work begins.
  audit({
    actor: deps.actor,
    role: deps.role,
    action: 'create.eula-accepted',
    target: req.name,
    outcome: 'ok',
    ip: deps.ip,
    detail: `flavor=${req.flavor} version=${req.mcVersion}`,
  })

  const opId = randomUUID()
  const job: CreationJob = {
    opId,
    name: req.name,
    dir,
    flavor: req.flavor,
    mcVersion: req.mcVersion,
    state: 'resolving',
    detail: 'Asking the publisher for the download and its checksum.',
    startedAt: new Date().toISOString(),
    error: null,
    bytes: null,
  }
  jobs.set(opId, job)

  // The folder is born with its journal, so there is no moment where an
  // unmarked half-created folder exists.
  mkdirSync(dir)
  const journal: Journal = {
    version: 1,
    opId,
    name: req.name,
    flavor: req.flavor,
    mcVersion: req.mcVersion,
    startedAt: job.startedAt,
    state: 'resolving',
    error: null,
    files: [JOURNAL],
    dirs: [],
  }
  writeJournal(dir, journal)

  void runCreation(req, deps, job, journal).catch((e) => {
    fail(job, journal, e instanceof Error ? e.message : String(e), deps)
  })
  return { ok: true, opId, dir }
}

function fail(job: CreationJob, journal: Journal, message: string, deps: CreateDeps): void {
  job.state = 'failed'
  job.error = message
  job.detail = `Failed: ${message} The folder was kept, marked, and can be removed from the creation panel.`
  journal.state = 'failed'
  journal.error = message
  try {
    writeJournal(job.dir, journal)
  } catch {
    /* the journal may be unwritable if the disk is the problem */
  }
  audit({
    actor: deps.actor,
    role: deps.role,
    action: 'create.failed',
    target: job.name,
    outcome: 'failed',
    ip: deps.ip,
    detail: message,
  })
}

async function runCreation(req: CreateRequest, deps: CreateDeps, job: CreationJob, journal: Journal): Promise<void> {
  const f = deps.fetchers
  const resolved =
    req.flavor === 'vanilla'
      ? await resolveVanilla(req.mcVersion, f)
      : req.flavor === 'paper'
        ? await resolvePaper(req.mcVersion, f)
        : req.flavor === 'forge'
          ? await resolveForge(req.mcVersion, req.loaderVersion, f)
          : await resolveNeoForge(req.mcVersion, req.loaderVersion, f)

  job.state = 'downloading'
  job.detail = `Downloading ${resolved.artifactName} and verifying it against the publisher's ${resolved.algo}.`
  journal.state = 'downloading'
  writeJournal(job.dir, journal)

  const dest = join(job.dir, resolved.artifactName)
  const dl = deps.download ? await deps.download(resolved, dest) : await fetchVerified({ ...resolved, dest })
  job.bytes = dl.bytes
  journal.files.push(resolved.artifactName)

  // Provisioned Java, when chosen: exactly the major this version needs,
  // fetched now because the operator asked, never in the background.
  if (req.java.mode === 'adoptium') {
    if (!deps.provision) throw new Error('Java provisioning is not wired up.')
    // The declared requirement for the exact version, not the table's guess:
    // provisioning the wrong major is a server that will not start.
    const major = await requiredJavaMajorLive(req.mcVersion, deps.fetchers)
    job.state = 'provisioning-java'
    job.detail = `Downloading a Temurin ${major} runtime from Adoptium and verifying its checksum.`
    journal.state = 'provisioning-java'
    writeJournal(job.dir, journal)
    const jp = await deps.provision(major)
    journal.javaHome = jp.javaHome
  }

  job.state = 'writing-config'
  job.detail = 'Verified. Writing eula.txt, server.properties and the start script.'
  journal.state = 'writing-config'
  writeJournal(job.dir, journal)

  writeCreatedFile(
    job.dir,
    journal,
    'eula.txt',
    [
      '# Accepted through the Minecraft Server Dashboard at creation time.',
      '# The EULA itself: https://aka.ms/MinecraftEULA',
      'eula=true',
      '',
    ].join('\r\n'),
  )

  writeCreatedFile(
    job.dir,
    journal,
    'server.properties',
    [
      `# Written by Minecraft Server Dashboard on ${new Date().toISOString()}`,
      `server-port=${req.gamePort}`,
      `motd=${req.name}`,
      'enable-rcon=true',
      `rcon.port=${req.rconPort}`,
      `rcon.password=${generateRconPassword()}`,
      'broadcast-rcon-to-ops=false',
      'enable-query=false',
      '',
    ].join('\r\n'),
  )

  if (resolved.kind === 'server-jar') {
    writeStartScript(job.dir, journal, resolved.artifactName, req.memoryMb)
    complete(job, journal, deps)
    return
  }

  // Installer flavors stop here. Running a downloaded program is its own
  // decision and its own audited call; see runInstaller.
  job.state = 'awaiting-installer'
  job.detail = `${resolved.artifactName} is verified and staged. Running it is a separate step that needs your explicit confirmation, because it executes a downloaded program on this machine.`
  journal.state = 'awaiting-installer'
  writeJournal(job.dir, journal)
}

function complete(job: CreationJob, journal: Journal, deps: CreateDeps): void {
  job.state = 'complete'
  job.detail =
    'Created. The folder is now just another server: discovery picks it up on the next scan as a never-started row with the normal Start button, and its first start generates the world. ' +
    'What remains before anyone can join from outside (the firewall rule, the router forward) is measured on the Addresses page.'
  journal.state = 'complete'
  writeJournal(job.dir, journal)

  // Outside the servers root, discovery cannot find the folder on its own,
  // so creation ends by attaching it (decision 0010): the same registry and
  // the same per-entry state as any folder the operator attaches by hand,
  // with the journaled start.bat as the confirmed launcher. Detaching it
  // later removes it from watch like any attachment.
  if (!isUnder(job.dir, deps.serversRoot)) {
    const attached = attachDir(
      deps.dataDir,
      { dir: job.dir, confirmedLaunch: { strategy: 'script', script: 'start.bat' } },
      { serversRoot: deps.serversRoot },
    )
    if (attached.ok) {
      job.detail =
        'Created outside the servers root, so the folder was attached: discovery watches it because you attached it, starting with the next scan, and detaching it later stops the watching. Its first start generates the world. ' +
        'What remains before anyone can join from outside (the firewall rule, the router forward) is measured on the Addresses page.'
    } else {
      job.detail = `Created, but the folder is outside the servers root and could not be attached (${attached.reason}) It is NOT watched until you attach it from the Attach page.`
    }
    audit({
      actor: deps.actor,
      role: deps.role,
      action: 'create.attach',
      target: job.name,
      outcome: attached.ok ? 'ok' : 'failed',
      ip: deps.ip,
      detail: attached.ok ? `attached ${job.dir}` : attached.reason,
    })
  }
  audit({
    actor: deps.actor,
    role: deps.role,
    action: 'create.complete',
    target: job.name,
    outcome: 'ok',
    ip: deps.ip,
    detail: `flavor=${job.flavor} version=${job.mcVersion} dir=${job.dir}`,
  })
}

function writeCreatedFile(dir: string, journal: Journal, rel: string, content: string): void {
  writeFileSync(join(dir, rel), content, 'utf8')
  if (!journal.files.includes(rel)) journal.files.push(rel)
  writeJournal(dir, journal)
}

/**
 * The start script. For a provisioned Java the path is ABSOLUTE and points
 * into this user's profile; the consequence (move the folder or remove the
 * dashboard's data directory and this script breaks) is stated in the script
 * itself and in the UI before the choice is made.
 */
function writeStartScript(dir: string, journal: Journal, jarName: string | null, memoryMb: number | null): void {
  const mem = memoryMb ?? 2048
  const lines = ['@echo off', 'cd /d "%~dp0"']
  if (journal.javaHome) {
    lines.push(
      `REM Java below was provisioned by the dashboard (Adoptium Temurin).`,
      `REM The path is absolute: moving that folder or uninstalling the`,
      `REM dashboard breaks this script. Edit the line to use your own Java.`,
      `set "PATH=${join(journal.javaHome, 'bin')};%PATH%"`,
    )
  }
  if (jarName) {
    lines.push(`java -Xms${mem}M -Xmx${mem}M -jar "${jarName}" nogui`)
  } else {
    // Forge/NeoForge: their installer generated run.bat and user_jvm_args.txt.
    lines.push('call run.bat nogui')
  }
  lines.push('')
  writeCreatedFile(dir, journal, 'start.bat', lines.join('\r\n'))
}

// --------------------------------------------------------------- installer

export type InstallerResult = { ok: true } | { ok: false; reason: string }

/**
 * Run a verified Forge/NeoForge installer. Only callable for a job that is
 * 'awaiting-installer', and only with `confirmRunDownloadedProgram: true`,
 * which is the wire-level shape of the operator saying "I understand I am
 * executing a program that was just downloaded."
 */
export async function runInstaller(
  opId: string,
  confirmRunDownloadedProgram: boolean,
  deps: CreateDeps,
): Promise<InstallerResult> {
  const job = jobs.get(opId)
  if (!job) return { ok: false, reason: 'No such creation.' }
  if (job.state !== 'awaiting-installer') {
    return { ok: false, reason: `This creation is ${job.state}, not awaiting an installer run.` }
  }
  if (confirmRunDownloadedProgram !== true) {
    audit({
      actor: deps.actor, role: deps.role, action: 'create.run-installer',
      target: job.name, outcome: 'denied', ip: deps.ip,
      detail: 'confirmation field missing',
    })
    return {
      ok: false,
      reason:
        'Running the installer executes a downloaded program on this machine. It was verified against the publisher checksum, but it only runs after you explicitly confirm that.',
    }
  }

  const journal = readJournal(job.dir)
  if (!journal || journal.opId !== opId) return { ok: false, reason: 'The creation journal is missing or not this operation.' }

  const installerJar = journal.files.find((n) => n.endsWith('-installer.jar'))
  if (!installerJar) return { ok: false, reason: 'No staged installer is recorded in the journal.' }

  audit({
    actor: deps.actor, role: deps.role, action: 'create.run-installer',
    target: job.name, outcome: 'ok', ip: deps.ip, detail: installerJar,
  })

  job.state = 'running-installer'
  job.detail = `Running ${installerJar} --installServer. Its output is in installer.log inside the folder.`
  journal.state = 'running-installer'
  writeJournal(job.dir, journal)

  const before = new Set(readdirSync(job.dir))
  // A provisioned runtime is used for the installer too: the operator who
  // chose "download Java for me" has no other java on PATH.
  const javaBin = journal.javaHome ? join(journal.javaHome, 'bin', 'java.exe') : 'java'
  const code = await new Promise<number>((done) => {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- args array (no shell); javaBin is a provisioned path or 'java', installerJar is a journal-recorded '-installer.jar' name, neither from a request. Runs only past the confirm gate.
    const child = spawn(javaBin, ['-jar', installerJar, '--installServer'], {
      cwd: job.dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const log: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => log.push(d))
    child.stderr.on('data', (d: Buffer) => log.push(d))
    child.on('error', () => {
      log.push(Buffer.from('\n(the java command itself could not be started; is Java installed and on PATH?)\n'))
      finish(-1)
    })
    child.on('close', (c) => finish(c ?? -1))
    function finish(c: number) {
      try {
        writeFileSync(join(job!.dir, 'installer.log'), Buffer.concat(log))
      } catch {
        /* the log is best effort */
      }
      done(c)
    }
  })

  // Whatever the installer created inside the folder belongs to this
  // operation and is journaled, so a failed creation can be removed cleanly.
  if (!journal.files.includes('installer.log')) journal.files.push('installer.log')
  for (const entry of readdirSync(job.dir)) {
    if (before.has(entry)) continue
    const p = join(job.dir, entry)
    if (statSync(p).isDirectory()) {
      if (!journal.dirs.includes(entry)) journal.dirs.push(entry)
    } else if (!journal.files.includes(entry)) {
      journal.files.push(entry)
    }
  }
  writeJournal(job.dir, journal)

  if (code !== 0) {
    fail(job, journal, `The installer exited with code ${code}. See installer.log in the folder.`, deps)
    return { ok: false, reason: `The installer exited with code ${code}. See installer.log in the folder.` }
  }

  // The installer's run.bat is the real launcher; our start.bat wraps it.
  writeStartScript(job.dir, journal, null, null)
  complete(job, journal, deps)
  return { ok: true }
}

// ----------------------------------------------------------------- removal

export type RemoveResult =
  | { ok: true; removed: string[]; kept: string[] }
  | { ok: false; reason: string }

/**
 * Remove a FAILED creation, and only that.
 *
 * The caller names the folder; the folder must carry this dashboard's
 * creation journal in a non-complete state. Deletion walks the journal's own
 * list, never the directory: a file the journal does not name is kept and
 * reported. Journaled directories (installer output like libraries/) are
 * removed recursively because the journal says this operation made them.
 * A complete creation is a server, and servers are never deleted here.
 */
export function removeFailedCreation(dir: string, deps: Pick<CreateDeps, 'actor' | 'role' | 'ip'>): RemoveResult {
  const target = resolve(normalize(dir))
  const journal = readJournal(target)
  if (!journal) {
    return { ok: false, reason: 'That folder carries no creation journal, so this dashboard did not create it and will not remove it.' }
  }
  if (journal.state === 'complete') {
    return { ok: false, reason: 'That creation completed, so the folder is a server now. Removing a server is not this button.' }
  }

  const removed: string[] = []
  // The journal itself goes last, or a crash mid-removal would orphan the
  // remaining files with no marker saying whose they were.
  const files = journal.files.filter((n) => n !== JOURNAL)
  for (const rel of files) {
    const p = join(target, rel)
    if (resolve(p).toLowerCase() === target.toLowerCase() || !resolve(p).toLowerCase().startsWith(target.toLowerCase())) continue
    try {
      if (existsSync(p)) {
        unlinkSync(p)
        removed.push(rel)
      }
      if (existsSync(`${p}.part`)) {
        unlinkSync(`${p}.part`)
        removed.push(`${rel}.part`)
      }
    } catch {
      /* reported below as kept */
    }
  }
  for (const rel of journal.dirs) {
    const p = join(target, rel)
    if (!resolve(p).toLowerCase().startsWith(target.toLowerCase() + '\\')) continue
    try {
      rmTree(p)
      removed.push(`${rel}\\`)
    } catch {
      /* reported below as kept */
    }
  }

  const left = readdirSync(target).filter((n) => n !== JOURNAL)
  if (left.length > 0) {
    audit({
      actor: deps.actor, role: deps.role, action: 'create.remove-failed',
      target, outcome: 'failed', ip: deps.ip,
      detail: `kept: ${left.join(', ')}`,
    })
    return {
      ok: true,
      removed,
      kept: left,
    }
  }

  unlinkSync(join(target, JOURNAL))
  rmdirSync(target)
  for (const [id, j] of jobs) if (j.dir.toLowerCase() === target.toLowerCase()) jobs.delete(id)
  audit({
    actor: deps.actor, role: deps.role, action: 'create.remove-failed',
    target, outcome: 'ok', ip: deps.ip,
    detail: `removed ${removed.length} journaled item(s) and the folder`,
  })
  return { ok: true, removed: [...removed, basename(target)], kept: [] }
}

/** Recursive removal, used ONLY for directories the journal attributes to us. */
function rmTree(p: string): void {
  if (!existsSync(p)) return
  for (const entry of readdirSync(p)) {
    const child = join(p, entry)
    if (statSync(child).isDirectory()) rmTree(child)
    else unlinkSync(child)
  }
  rmdirSync(p)
}

// ------------------------------------------------------------ catalog info

/** Everything the creation UI needs to state before the operator clicks. */
export function creationInfo(mcVersion: string | null): {
  flavors: ReturnType<typeof flavorCatalog>
  javaMajor: number | null
  javaLink: string | null
} {
  const major = mcVersion ? requiredJavaMajor(mcVersion) : null
  return {
    flavors: flavorCatalog(),
    javaMajor: major,
    javaLink: major ? adoptiumLink(major) : null,
  }
}

/** Test seam. */
export function resetJobs(): void {
  jobs.clear()
}
