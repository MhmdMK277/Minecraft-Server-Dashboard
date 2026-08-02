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
}

/** A java process that is running and could not be tied to any directory. */
export type UnattributedJvm = {
  pid: number
  sessionId: number | null
  startedBy: StartedBy
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
