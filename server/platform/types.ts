/**
 * Platform abstraction for process inspection.
 *
 * Deliberately a REGISTRY of N providers rather than a Windows/other branch.
 * macOS is its own path, not a Linux variant: no /proc, and process ancestry
 * comes from sysctl/libproc instead. Writing this as an if/else would push a
 * third implementation into an awkward corner later.
 *
 * Everything above this interface is platform-agnostic. Discovery, health,
 * classification and the double-spawn guard all depend only on the ability to
 * answer one question:
 *
 *     which JVM, if any, owns this server directory?
 *
 * That question is the foundation of the whole tool -- see docs/liveness-spec.md
 * §1, "port is not identity". Getting it wrong on a new platform is a data-loss
 * bug, not a cosmetic one, which is why unimplemented providers report
 * `available: false` loudly rather than returning an empty list that would look
 * indistinguishable from "no servers are running".
 */

/**
 * Which signal attributed a JVM to its directory.
 *
 * Recorded because "attributed" and "attributed by the route we believed" are
 * different facts, and the difference is what hid a total failure of the primary
 * signal for a day. Displayed in diagnostics and asserted in proofs.
 */
export type Attribution =
  /** The scheduled task that launched it names the directory. Strongest. */
  | 'scheduled-task'
  /** Parent launcher command line contains the directory. Unreadable in session 0. */
  | 'command-line'
  /** Its log file is held open and it is listening on the declared port. */
  | 'open-log-and-port'

/**
 * How the process came to exist. Independent of how it was attributed.
 *
 * This exists so a proof can state which world it is testing. The entire suite
 * was green for weeks while only ever exercising interactively started servers,
 * which is not the configuration that runs in production. See
 * docs/proof-coverage.md.
 */
export type StartedBy =
  /** A descendant of a running scheduled task's engine process. */
  | 'scheduled-task'
  /** Session other than 0: someone's desktop launched it. */
  | 'interactive'
  | 'unknown'

export type JvmProcess = {
  pid: number
  /** Absolute path of the server directory this JVM is serving. */
  dir: string
  workingSetMb: number | null
  privateMb: number | null
  /**
   * Base scheduling priority of the LIVE process (Win32_Process.Priority:
   * 6 = BelowNormal, 8 = Normal). Read separately from the task's
   * Settings.Priority, because a task fixed to normal priority does not
   * change a process started before the fix, and the reading must not say
   * it did.
   */
  basePriority: number | null
  /** -Xmx parsed from the command line; null when unreadable (session 0). */
  heapMaxMb: number | null
  uptimeSeconds: number | null
  /**
   * Cumulative CPU consumed since this process started, in milliseconds.
   * A COUNTER and never a rate: it only becomes a percentage after being
   * differenced against a previous sample of the SAME pid, which is
   * server/history.ts's job.
   */
  cpuMs: number | null
  attributedBy: Attribution
  /** Windows session. 0 means a service or a scheduled task, never a desktop. */
  sessionId: number | null
  startedBy: StartedBy
  /**
   * True when the scheduled task in this process's ancestry names the SAME
   * directory this JVM was attributed to -- the task launched this server.
   * `startedBy: 'scheduled-task'` is weaker: it only says a task engine is an
   * ancestor. A server the dashboard starts while itself running from its
   * boot task is task-DESCENDED but not task-LAUNCHED, and conflating the two
   * is how such a server was once attributed to the dashboard's own
   * directory (2026-08-02).
   */
  taskLaunched: boolean
}

/**
 * A java process that is running and could not be tied to any directory.
 *
 * `start` and `exe` were added 2026-08-06 (defect 6): the double-spawn
 * guard's refusal must NAME what it cannot account for, and an admin's
 * explicit acknowledgment is pinned to (pid, start time), because Windows
 * recycles pids and an acknowledgment that silently transferred to a
 * different process later would be the recycled-pid bug the instance lock
 * already solves the same way. `exe` is the executable path ONLY, never the
 * arguments: a foreign process's command line is not ours to display, and
 * the path is what lets an operator recognise "VS Code's Java" at a glance.
 */
export type UnattributedJvm = {
  pid: number
  sessionId: number | null
  startedBy: StartedBy
  /** ISO process start time, when the process table carried one. */
  start: string | null
  /** The executable path, first token of the command line, no arguments. */
  exe: string | null
}

/**
 * A java process that is provably NOT any candidate server, with the evidence.
 *
 * Added 2026-08-07. VS Code's Java language server ran on this host and its
 * mere existence put four genuinely stopped servers into a permanent UNKNOWN
 * with no Start button: it was unattributed, and unattributed meant doubt for
 * every directory. But that process's own command line named an absolute -jar
 * inside the .vscode extensions tree -- positive, readable evidence that the
 * program it runs lives outside every directory we track. Such a process is
 * excluded from doubt as RULED OUT, never silently dropped: it stays visible
 * here, with the sentence that justified the ruling, so the Identity panel
 * and the service log can show their work.
 */
export type RuledOutJvm = {
  pid: number
  sessionId: number | null
  startedBy: StartedBy
  /** ISO process start time, when the process table carried one. */
  start: string | null
  /** The executable path, first token of the command line, no arguments. */
  exe: string | null
  /**
   * The evidence sentence: which path the command line locates the program
   * at, and that it is outside every candidate directory. Carried so the UI
   * claim ("ruled out") is backed by something a reader can check.
   */
  evidence: string
}

/**
 * The result of one identity scan.
 *
 * `enumerateJvms()` returning a bare array could not express the two states that
 * matter most, and both of them look exactly like "nothing is running":
 *
 *   - the scan itself failed (`ok: false`)
 *   - java processes exist that could not be attributed (`unattributed`)
 *
 * Treating either as "no process here" is how four healthy servers were reported
 * DOWN. Anything deciding a server is absent must consult these first.
 */
export type JvmScan = {
  jvms: JvmProcess[]
  unattributed: UnattributedJvm[]
  /**
   * Unclaimed java processes whose own command line proves they are not any
   * candidate server (see RuledOutJvm). Disjoint from `unattributed`: a
   * process is doubted OR ruled out, never both. Only `unattributed` feeds
   * fleet-level doubt; this list exists so the exclusion is inspectable.
   */
  ruledOut: RuledOutJvm[]
  /** False when enumeration failed. NOT the same as "no JVMs are running". */
  ok: boolean
  failure: string | null
  /**
   * Directories whose log file is held open. Evidence that something is serving
   * the directory even when no PID could be named.
   */
  occupiedDirs: string[]
  /** Wall-clock cost of the scan, so its price is visible rather than assumed. */
  tookMs: number
  /** Of that, how long our own event loop was blocked. Rule 11 applied to this. */
  loopBlockedMs: number
  /**
   * Where the time went inside the provider, so the cost stays legible.
   * Keys are provider-defined; on Windows: processes, index, tasks, handles, ports.
   */
  phases: Record<string, number>
  /**
   * True when the expensive listening-socket enumeration was needed. False means
   * every candidate was resolved by a stronger signal and it was skipped.
   */
  portsEnumerated: boolean
  /**
   * Signal 3's raw per-directory view: was the log held, and which pid (if
   * any) did the listening-port table name. A directory occupied with no
   * nameable pid is the state that renders as a persistent UNKNOWN, and the
   * WHY has to be inspectable: a server ran 10 hours in that state
   * (2026-08-06) because the port table was IPv4-only, and nothing recorded
   * what signal 3 had actually seen. Empty when no hints were passed or the
   * scan failed.
   */
  signal3: Array<{ dir: string; logHeld: boolean; listenerPid: number | null }>
}

/**
 * A directory that might have a JVM, handed to the provider so it can attribute
 * processes it cannot otherwise identify.
 *
 * This exists because of a failure found the hard way. On Windows, a server
 * started by a boot-triggered scheduled task runs in session 0, and WMI returns
 * an EMPTY command line for such a process to an unelevated query. Command-line
 * attribution -- the primary signal -- therefore went blank for all four servers
 * the moment they were started the way they are meant to be started, and the
 * dashboard reported a fully healthy box as four DOWN servers.
 *
 * Providers may use these hints for a second, independent route to the same
 * answer. They must never use them to *guess*: a directory in this list is a
 * candidate, not a claim that anything is running in it.
 */
export type DirHint = {
  dir: string
  /** Declared game port, which is a lookup key and never an identity. Spec §1. */
  gamePort: number | null
}

export type ProviderUnavailable = {
  platform: string
  reason: string
  /** What the user should do about it. */
  guidance: string
}

export interface ProcessProvider {
  /** NodeJS.Platform value this provider serves. */
  readonly platform: NodeJS.Platform
  /** Human-readable name for logs and the UI. */
  readonly name: string
  /** False when this platform is registered but not implemented. */
  readonly available: boolean
  /** Only meaningful when `available` is false. */
  readonly unavailable?: ProviderUnavailable
  /**
   * One identity scan. A JVM that cannot be attributed to a directory is
   * reported as unattributed rather than guessed at OR silently dropped.
   *
   * `hints` is optional and additive: with it a provider may attribute processes
   * whose command line is unreadable. Without it, behaviour is unchanged.
   */
  scanJvms(hints?: DirHint[]): Promise<JvmScan>
}

export class UnsupportedPlatformError extends Error {
  readonly details: ProviderUnavailable
  constructor(details: ProviderUnavailable) {
    super(`${details.reason} ${details.guidance}`)
    this.name = 'UnsupportedPlatformError'
    this.details = details
  }
}
