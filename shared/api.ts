import { z } from 'zod'

/**
 * The wire contract.
 *
 * Everything the browser receives is validated against these schemas on the
 * server. The client is never trusted to shape a filesystem path or a server
 * command.
 *
 * Note what is deliberately ABSENT from ServerStatus: there is no rconPassword
 * field, and there never will be. Credentials are read from server.properties
 * server-side and do not cross this boundary. That mattered under Electron,
 * where the boundary was an IPC bridge on one machine; it matters more now that
 * it is an HTTP response on a LAN.
 */

/** Platform, which decides which TPS command is valid. See docs/liveness-spec.md §7. */
export const ServerKind = z.enum(['paper', 'forge-modern', 'forge-1710', 'unknown'])
export type ServerKind = z.infer<typeof ServerKind>

export const Classification = z.enum([
  'live', // has a world and a process, or is expected to run
  'never-started', // server.properties but no world yet; the first start creates it
  'retired', // a real server directory that is not meant to start again
  'stale', // duplicate of another server directory
  'not-a-server', // no level.dat and no server.properties
])
export type Classification = z.infer<typeof Classification>

/**
 * Health is a STATE, not a boolean.
 *
 * SLP is answered by the network thread from a cached status object; RCON is
 * queued onto the main server thread. During the 2026-07-28 incident all four
 * servers answered pings normally while single ticks took 128 seconds -- the
 * network thread was fine and the main thread was dead. Only RCON round-trip
 * latency probes the main thread, so only it can distinguish these:
 */
export const Health = z.enum([
  'HEALTHY', // SLP responds, RCON round-trips promptly
  'STALLED', // SLP responds, RCON slow or timing out -> main thread wedged
  'STARTING', // process up, SLP absent or returning the still-starting placeholder
  'HUNG', // process up, no SLP, past any plausible start window
  'DOWN', // no process owns this directory
  'UNKNOWN', // not enough information (e.g. RCON not configured)
])
export type Health = z.infer<typeof Health>

export const SlpInfo = z.object({
  versionName: z.string().nullable(),
  protocol: z.number().nullable(),
  playersOnline: z.number().nullable(),
  playersMax: z.number().nullable(),
  motd: z.string().nullable(),
  ready: z.boolean(),
  latencyMs: z.number(),
})
export type SlpInfo = z.infer<typeof SlpInfo>

export const RconProbe = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nullable(),
  note: z.string(),
})
export type RconProbe = z.infer<typeof RconProbe>

export const TpsInfo = z.object({
  command: z.string(),
  overall: z.number().nullable(),
  /** Paper only: 1m/5m/15m. Forge has no rolling window -- see spec §7. */
  windows: z.array(z.number()).nullable(),
  dimensions: z.number().nullable(),
  raw: z.string(),
})
export type TpsInfo = z.infer<typeof TpsInfo>

export const ProcInfo = z.object({
  pid: z.number(),
  workingSetMb: z.number().nullable(),
  privateMb: z.number().nullable(),
  /**
   * -Xmx parsed from the java command line, in MB. Null when the command
   * line is unreadable (boot-started, session 0), in which case the UI
   * falls back to committed memory and SAYS SO in the label.
   */
  heapMaxMb: z.number().nullable(),
  uptimeSeconds: z.number().nullable(),
})
export type ProcInfo = z.infer<typeof ProcInfo>

/** Dynmap web endpoint. Configured and alive are different things. */
export const DynmapInfo = z.object({
  port: z.number(),
  /** false when the port is configured but nothing is listening (MC 1.21.11). */
  responding: z.boolean(),
})
export type DynmapInfo = z.infer<typeof DynmapInfo>

/**
 * What this server's current state is attributable to.
 *
 * Health says WHAT is wrong; this says WHOSE it is, and they are not the same
 * question. A server can be genuinely STALLED because the host stopped
 * scheduling it -- four red badges then describe one event four times, and send
 * you looking in four wrong places. See docs/liveness-spec.md §12.
 */
export const Attribution = z.enum([
  'server', // isolated to this server: nothing else degraded, observer fine
  'host', // part of a host-wide event; the machine, not this server
  'observer', // the reading is ours, not the server's -- this dashboard was late
  'configuration', // nothing is wrong; we simply cannot see (RCON not enabled)
])
export type Attribution = z.infer<typeof Attribution>

/**
 * Stop-the-world pauses, read from the JVM's own `-Xlog:gc*,safepoint` output.
 *
 * A ten-second scan sees a pause only if a probe lands inside one. The JVM has
 * already written every pause down, so reading its log turns a sampling problem
 * into a complete record, which is how a server that freezes for 1.6 s several
 * times a minute stops being reported green in between.
 */
export const GcSeverity = z.enum([
  'ok', // nothing past the server's own pause target
  'noticeable', // past the target: the collector is missing its own goal
  'severe', // a second or more, players see the world stop
])
export type GcSeverity = z.infer<typeof GcSeverity>

export const GcSummary = z.object({
  /** The window the summary aims at. */
  windowMinutes: z.number(),
  /**
   * The window it actually read. Equal to `windowMinutes` normally; smaller when
   * the log is written faster than the read budget allows, which is exactly the
   * case that used to be reported as a full hour. See server/gclog.ts.
   */
  coveredMinutes: z.number(),
  truncated: z.boolean(),
  count: z.number(),
  maxMs: z.number(),
  p99Ms: z.number(),
  totalMs: z.number(),
  worstKind: z.string().nullable(),
  worstAt: z.string().nullable(),
  /** Pauses that were NOT garbage collection. The hypothesis's refutation path. */
  nonGcCount: z.number(),
  nonGcMaxMs: z.number(),
  /** Percentage of wall clock the world was stopped. */
  stoppedPercent: z.number(),
  severity: GcSeverity,
  detail: z.string(),
  /**
   * Pauses inside the window that belong to a PROCESS THAT NO LONGER EXISTS,
   * split out so a restart cannot make a healthy server look like a dying
   * one. On 2026-08-02 a 946 ms pause from a JVM replaced at 05:00 was
   * presented in the same figures as the fresh process's warmup churn, and
   * the combination read as a live crisis (audit finding F9). Every number
   * above this field describes the CURRENT process only whenever the
   * process's start time is known; what the replaced process did is here,
   * named as such, or null when the window spans no restart.
   */
  previousProcess: z
    .object({
      count: z.number(),
      maxMs: z.number(),
      worstKind: z.string().nullable(),
      /** When the current process started, i.e. when the old one was gone. */
      replacedAt: z.string(),
    })
    .nullable(),
})
export type GcSummary = z.infer<typeof GcSummary>

/**
 * How exposed a running server's memory is to eviction (server/residency.ts).
 *
 * Two facts, read not inferred: the scheduled task's Priority (Task
 * Scheduler's default 7 runs the process BelowNormal with LOW memory
 * priority, so Windows trims its pages first under any bulk file I/O) and
 * how much of the process's private memory is actually resident right now.
 * The combination is what makes multi-second GC pauses possible on a machine
 * with free RAM: a collection walking a mostly-nonresident heap reads it
 * back from disk. The dashboard reports the condition; changing a task's
 * priority is the operator's act, never the dashboard's.
 */
export const MemoryReading = z.object({
  workingSetMb: z.number(),
  privateMb: z.number(),
  /** workingSet / private. Low is normal for an idle JVM; low PLUS low priority is the trap. */
  residencyPercent: z.number(),
  /** The launching task's Settings.Priority; null when no task or unreadable. */
  taskPriority: z.number().nullable(),
  /**
   * Base priority of the LIVE process (6 = BelowNormal, 8 = Normal). The
   * authoritative signal: a task fixed after the process started does not
   * change the process, and this field is what keeps the reading honest
   * through that window.
   */
  processPriority: z.number().nullable(),
  /** True when the RUNNING process is BelowNormal or lower. */
  lowPriority: z.boolean(),
  vulnerable: z.boolean(),
  detail: z.string(),
})
export type MemoryReading = z.infer<typeof MemoryReading>

/**
 * How a server can be started, if the dashboard could work it out.
 *
 * `none` is a first-class answer, not a failure. Guessing a command line and
 * spawning it is how a second JVM ends up on a live world, so a server whose
 * launcher is unknown gets no start button and a sentence explaining why.
 */
export const LaunchStrategy = z.enum(['windows-task', 'script', 'none'])
export type LaunchStrategy = z.infer<typeof LaunchStrategy>

export const ControlAction = z.enum(['start', 'stop', 'restart', 'command'])
export type ControlAction = z.infer<typeof ControlAction>

export const ControlResult = z.object({
  server: z.string(),
  action: ControlAction,
  ok: z.boolean(),
  detail: z.string(),
  at: z.string(),
})
export type ControlResult = z.infer<typeof ControlResult>

/**
 * Two JVMs on one world. A first-class alert, not a log line.
 *
 * The dashboard cannot prevent this, starting is delegated to Task Scheduler or
 * a script, so anything outside the app can create a second process between our
 * check and the launcher taking effect. Detection and a loud alarm is the honest
 * ceiling. See server/control.ts.
 */
export const DoubleSpawnAlert = z.object({
  server: z.string(),
  dir: z.string(),
  pids: z.array(z.number()),
  at: z.string(),
  detail: z.string(),
})
export type DoubleSpawnAlert = z.infer<typeof DoubleSpawnAlert>

export const RunCommandRequest = z.object({
  /** Length-capped: an RCON packet has a hard limit and a huge body is a mistake. */
  command: z.string().min(1).max(1000),
})
export type RunCommandRequest = z.infer<typeof RunCommandRequest>

export const CommandResponse = z.object({
  ok: z.boolean(),
  raw: z.string(),
  latencyMs: z.number(),
  detail: z.string(),
})
export type CommandResponse = z.infer<typeof CommandResponse>

/**
 * How long this server takes to start, measured rather than assumed.
 *
 * The window decides STARTING vs HUNG for a process that is up but silent, and
 * HUNG tells the reader the server "is not going to come back on its own", so a
 * window that is too narrow is a false accusation, not a tuning nuisance. A
 * platform constant cannot serve a 13 s Paper server and a 100 s modpack.
 *
 * `source` is on the wire because a window derived from five of this server's own
 * boots and one guessed from its platform deserve different confidence, and a
 * number with no provenance invites exactly the misplaced trust this project's
 * identity bug was made of. See server/boottime.ts.
 */
export const BootTiming = z.object({
  graceSeconds: z.number(),
  source: z.enum(['measured', 'default']),
  samples: z.number(),
  /** The longest boot measured, which is what the window is derived from. */
  maxSeconds: z.number().nullable(),
  lastSeconds: z.number().nullable(),
  /**
   * Process start -> the port answering at all on the most recent boot, as
   * against `lastSeconds`, which is when it answered with a real version. GTNH
   * opens its port some 85 s before it is ready; the gap is the placeholder
   * phase spec §4 exists for.
   */
  lastPortSeconds: z.number().nullable(),
  detail: z.string(),
})
export type BootTiming = z.infer<typeof BootTiming>

/**
 * The settings the dashboard can write into server.properties.
 *
 * An allowlist of three, not a property editor: two booleans and the MOTD.
 * A general editor would be a way to set `rcon.password` from a browser,
 * which is the exact boundary this contract exists to hold. The MOTD is the
 * one free-text value, and it gets its own shape below so "free text" never
 * loosens the boolean pair.
 */
export const ServerSettingKey = z.enum(['white-list', 'online-mode'])
export type ServerSettingKey = z.infer<typeof ServerSettingKey>

/**
 * MOTD limits, shared so the wire, the writer and the UI agree. Two lines is
 * what the client renders; the length cap bounds the request, not the client
 * (which truncates on its own).
 */
export const MOTD_MAX_LINES = 2
export const MOTD_MAX_LINE_LENGTH = 128

export const ServerSettings = z.object({
  onlineMode: z.boolean(),
  whitelist: z.boolean(),
  /**
   * The MOTD as a player would read it (decoded from the file's Java escapes;
   * a real newline separates the two lines). Null when server.properties has
   * no motd line; the server then shows Minecraft's default.
   */
  motd: z.string().nullable(),
  fileModifiedAt: z.string().nullable(),
  /**
   * server.properties has been edited since the running process started, so the
   * live server is not using the values above. This is the honest form of "a
   * restart is needed" -- measured from the file's mtime against the process's
   * own uptime rather than remembered in a flag that a restart of THIS service
   * would lose.
   *
   * Null when nothing is running: a stopped server has no stale running config.
   */
  changedSinceStart: z.boolean().nullable(),
})
export type ServerSettings = z.infer<typeof ServerSettings>

/**
 * Game rules: the runtime surface. Read through the running server's RCON on
 * demand (never in the scan), set only from this catalog of names -- the
 * command sent is built from a catalog constant plus a validated value, so
 * this route can never become a raw RCON pipe. The catalog in
 * server/gamerules.ts carries types, bounds and descriptions; prove-gamerules
 * asserts it and this enum cannot drift apart.
 */
export const GAME_RULE_NAMES = [
  'keepInventory',
  'mobGriefing',
  'doFireTick',
  'doDaylightCycle',
  'doWeatherCycle',
  'doMobSpawning',
  'doMobLoot',
  'doTileDrops',
  'naturalRegeneration',
  'commandBlockOutput',
  'announceAdvancements',
  'showDeathMessages',
  'doImmediateRespawn',
  'randomTickSpeed',
  'playersSleepingPercentage',
  'spawnRadius',
] as const
export const GameRuleName = z.enum(GAME_RULE_NAMES)
export type GameRuleName = z.infer<typeof GameRuleName>

export const GameRuleReading = z.object({
  name: GameRuleName,
  type: z.enum(['boolean', 'integer']),
  description: z.string(),
  /** Integer rules only; null for booleans. */
  min: z.number().nullable(),
  max: z.number().nullable(),
  /**
   * 'value': parsed from a measured reply shape. 'absent': this server's
   * version does not have the rule (never rendered as a default). 'unparsed':
   * the reply matched no measured shape; `raw` carries what it said.
   */
  status: z.enum(['value', 'absent', 'unparsed']),
  boolValue: z.boolean().nullable(),
  intValue: z.number().nullable(),
  /** The server's own reply, verbatim. The honesty escape hatch. */
  raw: z.string(),
})
export type GameRuleReading = z.infer<typeof GameRuleReading>

export const GameRulesReading = z.object({
  /**
   * 'read' is the only state with rules in it. The rest are the honest
   * refusals: not-running (rules live in level.dat, which is not parsed
   * here), uncertain (doubt is not a reading), no-rcon, rcon-failed, and
   * queries-unsupported (measured on Paper 1.21.11, which rejects the
   * gamerule query form over RCON).
   */
  state: z.enum(['read', 'not-running', 'uncertain', 'no-rcon', 'rcon-failed', 'queries-unsupported']),
  detail: z.string(),
  rules: z.array(GameRuleReading),
  queriedAt: z.string().nullable(),
})
export type GameRulesReading = z.infer<typeof GameRulesReading>

/**
 * Profiling: every stop-the-world pause the JVM wrote down, split into the
 * two sides of a safepoint. `reachMs` is time the OS spent NOT running the
 * threads (paging, CPU starvation, a stalled disk -- a host fault); `atSpMs`
 * is the operation itself (GC tuning). Ported from scripts/gc-report.py,
 * which is what the 2026-08 stall investigation was conducted with.
 */
export const SafepointPause = z.object({
  at: z.string(),
  op: z.string(),
  totalMs: z.number(),
  reachMs: z.number(),
  atSpMs: z.number(),
  /** Whichever side got more of the stopped time owns the pause. */
  attribution: z.enum(['host', 'jvm']),
})
export type SafepointPause = z.infer<typeof SafepointPause>

export const ProfilingReading = z.object({
  /**
   * 'read' is the only state with figures. 'no-gclog' is a server started
   * without the logging flag (normal, not a fault); 'parser-mismatch' means
   * safepoint-looking lines exist and none parsed, which is a parser gap to
   * report, never an empty healthy table; 'unreadable' is an I/O failure.
   */
  state: z.enum(['read', 'no-gclog', 'parser-mismatch', 'unreadable']),
  detail: z.string(),
  thresholdMs: z.number(),
  /** Lines that LOOK like safepoints vs lines that parsed. A gap is a bug. */
  candidates: z.number(),
  parsed: z.number(),
  window: z.object({
    from: z.string().nullable(),
    to: z.string().nullable(),
    hours: z.number().nullable(),
    readBytes: z.number(),
    fileBytes: z.number(),
    /** False when the read budget covered only the tail of the live file. */
    wholeFile: z.boolean(),
  }),
  /** Figures describe the CURRENT process only; see previousProcessNote. */
  n: z.number(),
  p50Ms: z.number(),
  p95Ms: z.number(),
  p99Ms: z.number(),
  maxMs: z.number(),
  overCount: z.number(),
  hostAttributedCount: z.number(),
  /** Over-threshold pauses, worst first, capped server-side. */
  pauses: z.array(SafepointPause),
  previousProcessNote: z.string().nullable(),
})
export type ProfilingReading = z.infer<typeof ProfilingReading>

export const SetGameRuleRequest = z.object({
  name: GameRuleName,
  /** Booleans for boolean rules, bounded integers for integer rules; the server-side catalog re-checks both. */
  value: z.union([z.boolean(), z.number().int().min(0).max(100000)]),
})
export type SetGameRuleRequest = z.infer<typeof SetGameRuleRequest>

export const SetServerSettingRequest = z.union([
  z.object({
    key: ServerSettingKey,
    value: z.boolean(),
  }),
  z.object({
    key: z.literal('motd'),
    // Bounded on the wire; the writer re-validates and ENCODES (newlines
    // become the \n escape), so a raw newline can never reach the file as a
    // second property line. Control characters other than \n are refused
    // here so a bad request fails at the contract, not halfway into a write.
    value: z
      .string()
      .max(MOTD_MAX_LINES * (MOTD_MAX_LINE_LENGTH + 1))
      .refine((v) => !/[\u0000-\u0009\u000B-\u001F\u007F]/.test(v), {
        message: 'control characters cannot appear in an MOTD',
      }),
  }),
])
export type SetServerSettingRequest = z.infer<typeof SetServerSettingRequest>

export const ServerStatus = z.object({
  id: z.string(),
  name: z.string(),
  dir: z.string(),
  kind: ServerKind,
  classification: Classification,
  gamePort: z.number().nullable(),
  levelName: z.string().nullable(),
  worldDirs: z.array(z.string()),
  /** Whether RCON is configured. Never the password itself. */
  rconConfigured: z.boolean(),
  /** The two editable server.properties values. Null for a non-server directory. */
  settings: ServerSettings.nullable(),
  health: Health,
  healthDetail: z.string(),
  /** When this health state began, and how many consecutive scans it has held. */
  healthSince: z.string(),
  healthScans: z.number(),
  /** Null while HEALTHY or STARTING: there is nothing to attribute. */
  attribution: Attribution.nullable(),
  attributionDetail: z.string().nullable(),
  proc: ProcInfo.nullable(),
  slp: SlpInfo.nullable(),
  rcon: RconProbe.nullable(),
  /** Null when this server was not started with GC logging. Normal, not a fault. */
  gc: GcSummary.nullable(),
  /** Null when the server is not running or its memory counters were unreadable. */
  memory: MemoryReading.nullable(),
  /** The start window and what it was derived from. Never null: there is always a window. */
  boot: BootTiming,
  /**
   * Whether the external backup script should back this directory up. An
   * operator decision, persisted outside the dashboard so the backup script
   * reads the same answer when the dashboard is not running.
   */
  backupEnabled: z.boolean(),
  /**
   * How this server can be started, and whether an action is in flight.
   * `launchDetail` is shown to the user: when the strategy is `none` it is the
   * explanation of why there is no start button.
   */
  launchStrategy: LaunchStrategy,
  launchDetail: z.string(),
  /** True while a start/stop/restart holds this server's lock. */
  controlBusy: z.boolean(),
  players: z.array(z.string()).nullable(),
  tps: TpsInfo.nullable(),
  /** Populated when this directory shares a port with another. Spec §1. */
  portConflictWith: z.array(z.string()),
  dynmap: DynmapInfo.nullable(),
  checkedAt: z.string(),
})
export type ServerStatus = z.infer<typeof ServerStatus>

export const PublicIpState = z.object({
  address: z.string().nullable(),
  previous: z.string().nullable(),
  changed: z.boolean(),
  fetchedAt: z.string().nullable(),
  stale: z.boolean(),
  error: z.string().nullable(),
  /** Replaces the raw IP in the UI once DDNS exists. */
  hostname: z.string().nullable(),
  /**
   * WHO owned the internet route when the address was measured. A public IP
   * without this is not information: measured through a VPN or tunnel
   * adapter it is the VPN's exit, not this house (audit finding F7). Null
   * means the route could not be read, which the UI states as such.
   */
  route: z
    .object({
      adapter: z.string(),
      description: z.string(),
      /** True when the default route is owned by a virtual (non-hardware) adapter. */
      virtual: z.boolean(),
    })
    .nullable(),
})
export type PublicIpState = z.infer<typeof PublicIpState>

export const NetworkInfo = z.object({
  lanAddress: z.string().nullable(),
  lanInterface: z.string().nullable(),
  publicIp: PublicIpState,
})
export type NetworkInfo = z.infer<typeof NetworkInfo>

/**
 * Host health, measured by the one probe here that is not a Minecraft server:
 * this process's own event loop.
 *
 * §11 established that observer lag must be subtracted from a server's reading.
 * It must also be REPORTED, because a correction thrown away is a measurement
 * thrown away. Event-loop delay in a service that spends its life asleep is a
 * reading about the machine's ability to schedule work at all -- which is
 * exactly what is in question during a host-wide stall.
 */
export const LagBucket = z.object({
  at: z.string(),
  maxMs: z.number(),
  meanMs: z.number(),
  starvedMs: z.number(),
})
export type LagBucket = z.infer<typeof LagBucket>

export const LoopLag = z.object({
  sampleMs: z.number(),
  windowSeconds: z.number(),
  samples: z.number(),
  /**
   * Platform timer granularity, subtracted from every figure below and reported
   * so the subtraction is auditable rather than hidden. Measured 11 ms on this
   * Windows host, where a 20 ms interval fires on the next 15.6 ms tick.
   */
  timerFloorMs: z.number(),
  p50Ms: z.number(),
  p95Ms: z.number(),
  maxMs: z.number(),
  /** Total time in the window the loop was late beyond ordinary timer jitter. */
  blockedMs: z.number(),
  /**
   * The part of blockedMs that our own CPU time cannot explain -- wall clock
   * passed while this process was not running. Nothing in here caused it, so
   * this is the number that is evidence about the host rather than about us.
   */
  starvedMs: z.number(),
  /** 10 s buckets, oldest first, up to 15 minutes. */
  history: z.array(LagBucket),
})
export type LoopLag = z.infer<typeof LoopLag>

export const HostState = z.enum([
  'OK', // the loop is being scheduled promptly; readings are trustworthy
  'BUSY', // late enough to distort an RCON reading, not enough to invent one
  'STALLING', // late enough that a STALLED verdict could be manufactured here
  // No samples. Distinct from OK on purpose: "we did not measure" and "we
  // measured and the machine is fine" are the same badge in most tools, and
  // that is how an unearned reassurance gets shipped.
  'UNMEASURED',
])
export type HostState = z.infer<typeof HostState>

/**
 * Where the fault is, once the whole fleet is read together.
 *
 * One server degrading while the observer's loop stays flat is a server fault.
 * Every server degrading at once while the loop lag climbs is one host event,
 * not N server events -- the observer is not a Minecraft server, so a Minecraft
 * server's fault cannot explain it being starved too. The 2026-07-28 incident
 * (177 stalls across four servers in one day, three days spent on per-server
 * hypotheses) is the case this exists to name in one line.
 */
export const Fault = z.enum([
  'none',
  'host', // fleet-wide degradation + this process starved of CPU
  'shared', // fleet-wide degradation, observer scheduled normally
  'server', // one server, observer fine
  'observer', // this dashboard was late; the readings are ours, not theirs
])
export type Fault = z.infer<typeof Fault>

export const FleetInference = z.object({
  fault: Fault,
  /** One line, written to be the only thing that has to be read. */
  headline: z.string(),
  /** The reasoning, including what would have to be true for it to be wrong. */
  detail: z.string(),
  /** Server ids currently degraded (STALLED, HUNG or UNKNOWN). */
  degraded: z.array(z.string()),
  /** Live servers actually probed this scan -- the denominator. */
  probed: z.number(),
  since: z.string(),
  scans: z.number(),
})
export type FleetInference = z.infer<typeof FleetInference>

/**
 * The host's hard-fault rate (server/hostpaging.ts), sampled alongside loop
 * lag so the dashboard can make the correlation the stall investigation had
 * to make by hand: bulk file I/O -> resident memory evicted -> the next
 * full-heap GC on a low-priority JVM stalls for seconds. `baselinePerSec`
 * is the median of the retained recent samples, shipped next to the current
 * number so "elevated" is checkable, not asserted.
 */
export const PagingReading = z.object({
  pagesInputPerSec: z.number(),
  sampledAt: z.string(),
  baselinePerSec: z.number(),
  worstRecentPerSec: z.number(),
  /** How much history the baseline and worst were computed over. */
  windowMinutes: z.number(),
  elevated: z.boolean(),
  detail: z.string(),
})
export type PagingReading = z.infer<typeof PagingReading>

export const HostStatus = z.object({
  state: HostState,
  detail: z.string(),
  lag: LoopLag,
  fleet: FleetInference,
  /** Null until the first sample lands, and always null off Windows. */
  paging: PagingReading.nullable(),
})
export type HostStatus = z.infer<typeof HostStatus>

export const IgnoredDirectory = z.object({
  name: z.string(),
  dir: z.string(),
  reason: z.string(),
})
export type IgnoredDirectory = z.infer<typeof IgnoredDirectory>

/**
 * How the identity scan went, surfaced rather than assumed.
 *
 * `bySignal` is here because of what it revealed: for a full day every server on
 * this host resolved through the *fallback* signal and none through the primary,
 * which meant the primary was dead in production while the suite stayed green.
 * A count nobody can see is a count nobody checks.
 *
 * `tookMs` and `loopBlockedMs` are here because the scan spawns a subprocess on
 * a loop that runs every ten seconds, and spec §11 is the rule that the observer
 * must not bill its own delay to a server. The cost is measured, not asserted.
 */
export const IdentityScan = z.object({
  /** False when enumeration FAILED. Not the same as "nothing is running". */
  ok: z.boolean(),
  failure: z.string().nullable(),
  /** Running java processes that could not be matched to any directory. */
  unattributed: z.number(),
  tookMs: z.number(),
  loopBlockedMs: z.number(),
  bySignal: z.object({
    'scheduled-task': z.number(),
    'command-line': z.number(),
    'open-log-and-port': z.number(),
  }),
  startedBy: z.object({
    'scheduled-task': z.number(),
    interactive: z.number(),
    unknown: z.number(),
  }),
  /**
   * Running servers this dashboard is NOT watching.
   *
   * A JVM whose directory was resolved from its command line is attributed
   * successfully, so it never counted as unattributed; but if that directory
   * is not under the servers root and has not been attached, no server entry
   * exists for it either. It was therefore invisible in both directions: a
   * real, running Minecraft server that the dashboard could see and said
   * nothing about. Found while wiring the attach flow, 2026-07-31.
   *
   * This is also the strongest case for attaching, because the directory is
   * already known rather than guessed.
   */
  unwatched: z.array(
    z.object({
      pid: z.number(),
      dir: z.string(),
      startedBy: z.enum(['scheduled-task', 'interactive', 'unknown']),
      /** True when the folder still looks like a server right now. */
      looksLikeServer: z.boolean(),
    }),
  ),
})
export type IdentityScan = z.infer<typeof IdentityScan>

/** The launch method an operator confirms while looking at a folder. */
export const ConfirmedLaunch = z.union([
  z.object({ strategy: z.literal('script'), script: z.string().min(1).max(120) }),
  z.object({ strategy: z.literal('windows-task'), task: z.string().min(1).max(260) }),
])
export type ConfirmedLaunch = z.infer<typeof ConfirmedLaunch>

/**
 * A folder the operator attached, and whether it is still there.
 *
 * `missing` is a first-class state rather than an absence. An attachment
 * pointing at a folder that has been deleted, renamed, or is on a drive that
 * is not plugged in would otherwise sit in the fleet reporting UNKNOWN for
 * ever, which is the dashboard being unable to say the one thing it actually
 * knows: the folder is not there. Detaching is offered as the obvious next
 * action, and detaching sets aside; it never deletes anything.
 */
export const AttachmentState = z.enum([
  'ok', // the folder is there and looks like a server
  'missing', // the folder is not on disk at all
  'no-world', // the folder is there, but has no world with a level.dat
])
export type AttachmentState = z.infer<typeof AttachmentState>

export const AttachmentStatus = z.object({
  dir: z.string(),
  name: z.string(),
  attachedAt: z.string(),
  state: AttachmentState,
  detail: z.string(),
  /** Null means no launch method was confirmed, so Start stays unavailable. */
  confirmedLaunch: ConfirmedLaunch.nullable(),
})
export type AttachmentStatus = z.infer<typeof AttachmentStatus>

export const Snapshot = z.object({
  servers: z.array(ServerStatus),
  ignored: z.array(IgnoredDirectory),
  /** Folders the operator attached, and whether each is still on disk. */
  attachments: z.array(AttachmentStatus),
  /**
   * Dashboard-wide preferences. Only what the UI must know to render
   * honestly; the server remains the authority on what is permitted.
   */
  prefs: z.object({
    /**
     * Off by default. When on, the BROWSER fetches player avatars from a
     * third party, which learns your player names and the viewer's IP. The
     * Content-Security Policy only names that host while this is on, so the
     * switch removes the permission rather than merely hiding the feature.
     */
    playerAvatars: z.boolean(),
    /** The one avatar host, so the UI can name it before you agree to it. */
    avatarOrigin: z.string(),
  }),
  /** Host health, alongside per-server health rather than folded into it. */
  host: HostStatus,
  network: NetworkInfo,
  serversRoot: z.string(),
  scannedAt: z.string(),
  scanMs: z.number(),
  identity: IdentityScan,
  /** Two JVMs on one world, per server. Empty is the normal case. */
  doubleSpawn: z.array(DoubleSpawnAlert),
})
export type Snapshot = z.infer<typeof Snapshot>

export const AppInfo = z.object({
  name: z.string(),
  version: z.string(),
  node: z.string(),
  serversRoot: z.string(),
  /** Host platform, and whether process enumeration is implemented for it. */
  platform: z.string(),
  platformSupported: z.boolean(),
  platformDetail: z.string().nullable(),
})
export type AppInfo = z.infer<typeof AppInfo>

/**
 * Where a console line came from.
 *
 * `rcon-probe` is this dashboard's own polling: the socket open and close that
 * every ten-second scan produces, plus a command line the server-side ledger can
 * tie to a poll we actually made. On an idle server that was 100% of the output,
 * so the console showed the tool talking to itself and nothing else.
 *
 * Classified on the server, not in the browser, so the rule lives next to the
 * ledger that knows which connections were ours. Hidden by default, with a
 * toggle, because an operator debugging RCON needs to see it.
 */
export const LineOrigin = z.enum(['server', 'rcon-probe'])
export type LineOrigin = z.infer<typeof LineOrigin>

/** One console line, already redacted and colour-stripped in the main process. */
export const LogLine = z.object({
  seq: z.number(),
  text: z.string(),
  level: z.enum(['error', 'warn', 'info', 'other']),
  origin: LineOrigin,
})
export type LogLine = z.infer<typeof LogLine>

export const LogBatch = z.object({
  serverId: z.string(),
  lines: z.array(LogLine),
  /** True when the tailer detected latest.log was replaced under it. */
  rotated: z.boolean(),
})
export type LogBatch = z.infer<typeof LogBatch>

/**
 * Roles.
 *
 * Two, not five. The real requirement here is "friends can watch without being
 * able to touch anything", which is one boundary, and a permission matrix
 * nobody can hold in their head is a permission matrix that gets granted around.
 */
export const Role = z.enum(['admin', 'viewer'])
export type Role = z.infer<typeof Role>

/**
 * The current session, as the browser is allowed to see it.
 *
 * Both expiries are exposed so the UI can warn before a session dies rather
 * than presenting the resulting 401 as an error. There is no token here: the
 * session id is in an HttpOnly cookie and deliberately unreadable from script.
 */
export const SessionUser = z.object({
  username: z.string(),
  role: Role,
  sessionId: z.string(),
  createdAt: z.string(),
  /** Absolute expiry: this session dies then regardless of activity. */
  expiresAt: z.string(),
  /** Idle expiry, pushed forward by every request. */
  idleExpiresAt: z.string(),
})
export type SessionUser = z.infer<typeof SessionUser>

export const AuthState = z.object({
  /** False before the first admin exists; the UI shows setup instead of login. */
  configured: z.boolean(),
  user: SessionUser.nullable(),
  /** True when the bootstrap password is still in use and must be replaced. */
  mustChangePassword: z.boolean(),
})
export type AuthState = z.infer<typeof AuthState>

export const LoginRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(512),
})
export type LoginRequest = z.infer<typeof LoginRequest>

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(512),
  /**
   * 12 is the length at which a generated-then-remembered password stops being
   * the weak link. Enforced server-side; the UI only mirrors it.
   */
  newPassword: z.string().min(12).max(512),
})
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>

/** Opt one directory in or out of the external backup rotation. */
export const SetBackupRequest = z.object({
  enabled: z.boolean(),
})
export type SetBackupRequest = z.infer<typeof SetBackupRequest>

/**
 * Backup detection (decision 0001): the dashboard detects and surfaces
 * whatever backup system a server already has; it does not implement one.
 * Everything below is a READING of what was on disk at one moment, produced
 * by server/backupdetect.ts, and every number carries its provenance.
 */

/**
 * Statistics from statting the TOP LEVEL of one archive directory. The tree
 * is deliberately not walked: a backups directory can be tens of gigabytes
 * (decision 0001), so `totalBytes` sums top-level files only, and a
 * timestamped subdirectory counts as one archive of unknown size.
 */
export const ArchiveStats = z.object({
  /** Absolute path of the directory that was read. */
  dir: z.string(),
  /** Entries that look like archives: known extensions plus dated directories. */
  count: z.number(),
  /** Sum of top-level FILE sizes. Directories are not walked, so this is a floor. */
  totalBytes: z.number(),
  newestAt: z.string().nullable(),
  oldestAt: z.string().nullable(),
  /**
   * Median gap between the newest few archives, in hours. Null below three
   * archives, because two points do not make a cadence.
   */
  approxCadenceHours: z.number().nullable(),
})
export type ArchiveStats = z.infer<typeof ArchiveStats>

/**
 * What one detected system's evidence supports. The vocabulary is decision
 * 0001's reporting rule: a config flag alone is intent, never activity.
 *
 * - `active`: archives observed, newest inside the recency window
 *   (3x the observed cadence with a 24 h floor; 7 days when no cadence is
 *   derivable). The window is code, in server/backupdetect.ts.
 * - `configured`: a flag or an installed jar says backups should run, but
 *   the archives are absent or older than the window. The evidence sentence
 *   states which.
 * - `stale`: archives exist, nothing claims to still produce them, and the
 *   newest is older than the window.
 */
export const BackupSystemStatus = z.enum(['active', 'configured', 'stale'])
export type BackupSystemStatus = z.infer<typeof BackupSystemStatus>

export const BackupSystem = z.object({
  /** Human name: "ServerUtilities", a jar's base name, or the directory read. */
  name: z.string(),
  /** Which of decision 0001's four signals produced this entry. */
  signal: z.enum(['archive-dir', 'serverutilities', 'plugin-or-mod', 'external-path']),
  /**
   * `known` = a recognized provider or directly observed archives.
   * `guess` = a filename that merely contains "backup" (decision 0001 says
   * label that as a guess, so it is one on the wire, not just in the UI).
   */
  confidence: z.enum(['known', 'guess']),
  status: BackupSystemStatus,
  /** Where this system writes (absolute path), when that is known. */
  writesTo: z.string().nullable(),
  /** One sentence naming exactly what was observed on disk. */
  evidence: z.string(),
  archives: ArchiveStats.nullable(),
  /** ServerUtilities only: the configured backup_timer, in hours. Intent, not evidence. */
  configuredTimerHours: z.number().nullable(),
  /** External path only: the newest backup-log line mentioning this server. */
  lastLogLine: z.string().nullable(),
})
export type BackupSystem = z.infer<typeof BackupSystem>

/**
 * One reading of a server's backup systems. Same provenance envelope as
 * WorldsReading: when it was read, what it cost, and whether it is a cached
 * earlier reading being shown again.
 *
 * `externalPathsConfigured` exists because absence means two different
 * things: with no configured external path, an external script is INVISIBLE
 * to the dashboard (decision 0001, signal 4) and "nothing detected" must not
 * be worded as "no backups exist".
 */
export const BackupDetection = z.object({
  readAt: z.string(),
  readMs: z.number(),
  cached: z.boolean(),
  systems: z.array(BackupSystem),
  /** How many systems are `active`. Two or more is the duplicate-work warning. */
  activeCount: z.number(),
  externalPathsConfigured: z.boolean(),
})
export type BackupDetection = z.infer<typeof BackupDetection>

/**
 * Decision 0005: the dashboard's own cold backup, offered only where
 * detection found nothing active. One journaled archive; the manifest is
 * append-only and owned by server/coldbackup.ts. `sha256` is recorded at
 * write time and re-verified before any restore, so a restore can never
 * quietly extract bytes other than the ones journaled.
 */
export const ColdBackupEntry = z.object({
  id: z.string(),
  serverName: z.string(),
  serverDir: z.string(),
  archivePath: z.string(),
  sha256: z.string(),
  bytes: z.number(),
  createdAt: z.string(),
  actor: z.string(),
})
export type ColdBackupEntry = z.infer<typeof ColdBackupEntry>

/** "Back up now": an operator's click naming where the archive goes. */
export const RunColdBackupRequest = z.object({
  destDir: z.string().min(1).max(500),
})
export type RunColdBackupRequest = z.infer<typeof RunColdBackupRequest>

export const RestoreColdBackupRequest = z.object({
  archiveId: z.string().min(1).max(128),
})
export type RestoreColdBackupRequest = z.infer<typeof RestoreColdBackupRequest>

/** One active session, for the "where am I logged in" list. */
export const SessionSummary = z.object({
  sessionId: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  ip: z.string(),
  userAgent: z.string(),
  current: z.boolean(),
})
export type SessionSummary = z.infer<typeof SessionSummary>

/**
 * Read-only world enumeration (Phase B). Sizes are honest sums of what was
 * on disk at walk time, and `walkMs` keeps the cost of producing them
 * visible. There is no write path behind any of this, by design.
 */
export const DimensionInfo = z.object({
  /** Path relative to the world directory, e.g. 'DIM-1' or 'dimensions/ns/name'. */
  path: z.string(),
  kind: z.enum(['overworld', 'nether', 'end', 'custom']),
  sizeBytes: z.number(),
  regionFiles: z.number(),
})
export type DimensionInfo = z.infer<typeof DimensionInfo>

/**
 * One reading of a server's worlds.
 *
 * The envelope exists so the page can say WHEN it read, and whether what it
 * is showing came from a previous read. Same idiom as PublicIpState's
 * `fetchedAt` + `stale` and GcSummary's `coveredMinutes`: ship the
 * provenance of a number next to the number, and never let a cached value
 * imply freshness it does not have.
 */
export const WorldsReading = z.object({
  readAt: z.string(),
  /** What the walk cost, summed across worlds. */
  walkMs: z.number(),
  /** True when this is a previous reading served without re-walking. */
  cached: z.boolean(),
  worlds: z.array(z.lazy(() => WorldInfo)),
})
export type WorldsReading = { readAt: string; walkMs: number; cached: boolean; worlds: WorldInfo[] }

export const WorldInfo = z.object({
  /** Directory name under the server root, e.g. 'world' or 'world_nether'. */
  dir: z.string(),
  kind: z.enum(['overworld', 'nether', 'end', 'custom']),
  sizeBytes: z.number(),
  files: z.number(),
  regionFiles: z.number(),
  lastWrittenAt: z.string().nullable(),
  hasIcon: z.boolean(),
  dimensions: z.array(DimensionInfo),
  walkMs: z.number(),
})
export type WorldInfo = z.infer<typeof WorldInfo>

/**
 * Searching this machine for server directories (spec section 17).
 *
 * Every entry is a CANDIDATE, never an adopted server. `running` comes from
 * the exclusive log hold, never from the declared port: on the development
 * machine three candidate directories are a backup tree declaring the same
 * ports as live servers, and resolving by port would map one JVM onto three
 * directories. Spec section 1.
 */
/**
 * One scan's reading for one server, for the Overview sparklines.
 *
 * Every field is nullable and null means NOT MEASURED, never zero. A stopped
 * server, a process whose counters could not be read, or a server without
 * RCON all produce nulls, and the UI must draw those as gaps. Zero is a
 * measurement and says the opposite thing.
 */
export const HistorySample = z.object({
  at: z.string(),
  /**
   * Percent of ONE core, so a server pegging a single core reads as ~100
   * rather than as a single digit on a many-core machine. Can legitimately
   * exceed 100 for a multi-threaded server. Derived by differencing the
   * cumulative CPU counter, never read directly; null across a restart,
   * because the counter resets and there is nothing to difference against.
   */
  cpuPercentOfCore: z.number().nullable(),
  ramMb: z.number().nullable(),
  tps: z.number().nullable(),
})
export type HistorySample = z.infer<typeof HistorySample>

export const ServerHistory = z.object({
  windowMinutes: z.number(),
  /** Nominal scan cadence. The real gap between samples is in the samples. */
  intervalSeconds: z.number(),
  /**
   * When this process started collecting. The ring is in memory and does not
   * survive a restart, so a short graph can mean a recent restart rather than
   * a quiet server, and the UI has to say which.
   */
  collectingSince: z.string(),
  /** The denominator the UI must state alongside a CPU percentage. */
  cores: z.number(),
  samples: z.array(HistorySample),
})
export type ServerHistory = z.infer<typeof ServerHistory>

export const ScanRoot = z.object({ dir: z.string(), depth: z.number() })
export type ScanRoot = z.infer<typeof ScanRoot>

export const ScanCandidate = z.object({
  dir: z.string(),
  name: z.string(),
  /** Whether the dashboard already covers this directory. */
  known: z.enum(['new', 'watched', 'attached']),
  /** A server.properties was found; a level.dat may not exist yet. */
  looksLikeServer: z.boolean(),
  gamePort: z.number().nullable(),
  levelName: z.string().nullable(),
  /** A JVM holds this directory's log open. Identity, not a port guess. */
  running: z.boolean(),
  pid: z.number().nullable(),
})
export type ScanCandidate = z.infer<typeof ScanCandidate>

export const ScanResult = z.object({
  scannedAt: z.string(),
  ms: z.number(),
  roots: z.array(z.string()),
  cached: z.boolean(),
  candidates: z.array(ScanCandidate),
})
export type ScanResult = z.infer<typeof ScanResult>

/**
 * What the operator is shown before confirming an attach. Lives in the
 * contract, not in the server module, so the browser never imports server
 * code to know the shape of a reply.
 */
export type AttachCandidate =
  | { ok: false; reason: string }
  | {
      ok: true
      dir: string
      gamePort: number | null
      levelName: string | null
      worldDirs: string[]
      rconConfigured: boolean
      /** What a scan FOUND. Reporting it is not confirming it. */
      launchCandidate: ConfirmedLaunch | null
      logHeld: boolean | null
    }

export const AttachRequest = z.object({
  path: z.string().min(1).max(4096),
  confirmedLaunch: ConfirmedLaunch.nullable(),
})
export const AttachLaunchRequest = z.object({
  dir: z.string().min(1).max(4096),
  confirmedLaunch: ConfirmedLaunch.nullable(),
})
export const AttachDetachRequest = z.object({ dir: z.string().min(1).max(4096) })

/**
 * Server creation. The enum deliberately includes 'fabric' so a request for
 * it reaches the catalog's refusal and the caller gets the stated reason,
 * rather than a shapeless 400.
 */
export const CreateFlavor = z.enum(['vanilla', 'paper', 'forge', 'neoforge', 'fabric'])
export type CreateFlavor = z.infer<typeof CreateFlavor>

export const CreateServerRequest = z.object({
  name: z.string().min(1).max(64),
  flavor: CreateFlavor,
  mcVersion: z.string().min(1).max(32),
  loaderVersion: z.string().min(1).max(64).nullable(),
  gamePort: z.number().int().min(1024).max(65535),
  rconPort: z.number().int().min(1024).max(65535),
  /** Must be true; the server refuses otherwise. Unticked by default in the UI. */
  eulaAccepted: z.boolean(),
  memoryMb: z.number().int().min(512).max(65536).nullable(),
  javaMode: z.enum(['existing', 'adoptium']),
})
export type CreateServerRequest = z.infer<typeof CreateServerRequest>

export const RunInstallerRequest = z.object({
  opId: z.string().min(1).max(64),
  /**
   * The wire shape of "I understand I am running a downloaded program."
   * Anything but literal true is a refusal.
   */
  confirmRunDownloadedProgram: z.boolean(),
})

export const RemoveFailedCreationRequest = z.object({
  dir: z.string().min(1).max(4096),
  /** Typed confirmation: must equal the folder's name exactly. */
  folderName: z.string().min(1).max(64),
})

export type CreationJobStatus = {
  opId: string
  name: string
  dir: string
  flavor: CreateFlavor
  mcVersion: string
  state:
    | 'resolving'
    | 'downloading'
    | 'provisioning-java'
    | 'writing-config'
    | 'awaiting-installer'
    | 'running-installer'
    | 'complete'
    | 'failed'
  detail: string
  startedAt: string
  error: string | null
  bytes: number | null
}

export type CreationInfo = {
  flavors: Array<
    | { flavor: Exclude<CreateFlavor, 'fabric'>; available: true; label: string; kind: 'server-jar' | 'installer-jar' }
    | { flavor: 'fabric'; available: false; label: string; reason: string }
  >
  /** Stated denominator for the default Java path. Null until a version is chosen. */
  javaMajor: number | null
  javaLink: string | null
  /** The consequence of choosing provisioning, shown BEFORE the click. */
  adoptiumConsequence: string
  suggestedGamePort: number
  suggestedRconPort: number
  /** Where the folder will be created. */
  parentDir: string
  parentDirExists: boolean
}

/**
 * What removing a failed creation reports: exactly what was deleted, all of
 * it journaled, and anything found in the folder that the journal did not
 * name, which is kept and listed rather than deleted.
 */
export type RemoveFailedResult = { ok: true; removed: string[]; kept: string[] }

/**
 * Public access via a tunnel (playit.gg). The boundaries from DESIGN.md are
 * visible in this contract: exposure is armed by a typed confirmation naming
 * the server (`confirmServerName`); running the downloaded agent binary is
 * its own consent field, separate from installing it; and the tunnel
 * address field is null unless the agent process is reporting connected,
 * enforced server-side, so a stale address cannot be handed out.
 */
export type TunnelAgentStatus = {
  state:
    | 'not-installed' // no verified agent binary on disk
    | 'installed' // binary verified; no credential yet
    | 'claimed' // credential on disk; agent not running
    | 'starting' // process spawned, connection not yet reported
    | 'connected' // the agent itself reported its tunnels are up
    | 'disconnected' // process alive but not connected, or exited
    | 'error'
  /** One human sentence about where it is or why it stopped. */
  detail: string
  /** Release tag of the installed binary, e.g. "v1.0.10". */
  version: string | null
  secretPresent: boolean
  /** The operator has approved running the downloaded binary (audited). */
  runConfirmed: boolean
}

export type TunnelEntry = {
  /** Provider tunnel id (uuid). */
  tunnelId: string
  /** Server id/name this tunnel exposes. */
  serverId: string
  dir: string
  localPort: number
  /**
   * The public address. Null unless the agent currently reports connected;
   * a tunnel that exists but is not being served has no address to show.
   */
  address: string | null
  detail: string
}

export type TunnelStatus = {
  agent: TunnelAgentStatus
  tunnels: TunnelEntry[]
}

export type TunnelClaimState =
  | 'none' // no claim in progress
  | 'waiting-visit' // link not yet opened
  | 'waiting-approval' // opened, not yet approved
  | 'accepted' // approved; exchanging for the credential
  | 'claimed' // credential stored
  | 'rejected'
  | 'timed-out'
  | 'error'

/** Claim progress. The URL is shown; the secret key never appears here. */
export type TunnelClaimStatus = {
  state: TunnelClaimState
  /** https://playit.gg/claim/<code>; null when no claim is in progress. */
  url: string | null
  detail: string
}

export const TunnelRunAgentRequest = z.object({
  /**
   * The wire shape of "I understand I am running a downloaded program."
   * Same standard as the Forge/NeoForge installer; anything but literal
   * true is a refusal.
   */
  confirmRunDownloadedProgram: z.boolean(),
})

export const TunnelEnableRequest = z.object({
  id: z.string().min(1).max(128),
  /**
   * Typed confirmation: must equal the server's name exactly. Exposing a
   * world to the internet is a security decision, not a toggle.
   */
  confirmServerName: z.string().min(1).max(64),
})

export const TunnelDisableRequest = z.object({ id: z.string().min(1).max(128) })

/** HTTP routes. Was `CH`, the Electron IPC channel list. */
export const API = {
  appInfo: '/api/info',
  snapshot: '/api/servers',
  refresh: '/api/servers/refresh',
  logBacklog: (id: string) => `/api/servers/${encodeURIComponent(id)}/log`,
  worlds: (id: string, fresh = false) =>
    `/api/servers/${encodeURIComponent(id)}/worlds${fresh ? '?fresh=1' : ''}`,
  discover: (fresh = false) => `/api/discover${fresh ? '?fresh=1' : ''}`,
  attachValidate: '/api/attach/validate',
  attach: '/api/attach',
  attachLaunch: '/api/attach/launch',
  attachDetach: '/api/attach/detach',
  prefs: '/api/prefs',
  history: (id: string) => `/api/servers/${encodeURIComponent(id)}/history`,
  worldIcon: (id: string, dir: string) =>
    `/api/servers/${encodeURIComponent(id)}/worlds/${encodeURIComponent(dir)}/icon`,
  ackIpChange: '/api/network/ack-ip-change',
  setBackup: (id: string) => `/api/servers/${encodeURIComponent(id)}/backup`,
  backupDetection: (id: string, fresh = false) =>
    `/api/servers/${encodeURIComponent(id)}/backup/detection${fresh ? '?fresh=1' : ''}`,
  profiling: (id: string, thresholdMs?: number) =>
    `/api/servers/${encodeURIComponent(id)}/profiling${thresholdMs ? `?threshold=${thresholdMs}` : ''}`,
  gameRules: (id: string) => `/api/servers/${encodeURIComponent(id)}/gamerules`,
  setGameRule: (id: string) => `/api/servers/${encodeURIComponent(id)}/gamerules/set`,
  coldBackups: (id: string) => `/api/servers/${encodeURIComponent(id)}/coldbackups`,
  runColdBackup: (id: string) => `/api/servers/${encodeURIComponent(id)}/coldbackup`,
  restoreColdBackup: (id: string) => `/api/servers/${encodeURIComponent(id)}/coldbackup/restore`,
  setSetting: (id: string) => `/api/servers/${encodeURIComponent(id)}/settings`,
  control: (id: string, action: 'start' | 'stop' | 'restart') =>
    `/api/servers/${encodeURIComponent(id)}/${action}`,
  runCommand: (id: string) => `/api/servers/${encodeURIComponent(id)}/command`,
  createInfo: (mcVersion?: string) =>
    `/api/create/info${mcVersion ? `?mcVersion=${encodeURIComponent(mcVersion)}` : ''}`,
  createVersions: (flavor: string) => `/api/create/versions?flavor=${encodeURIComponent(flavor)}`,
  create: '/api/create',
  createJobs: '/api/create/jobs',
  createRunInstaller: '/api/create/run-installer',
  createRemoveFailed: '/api/create/remove-failed',
  tunnelStatus: '/api/tunnel/status',
  tunnelInstall: '/api/tunnel/install',
  tunnelClaimStart: '/api/tunnel/claim/start',
  tunnelClaimStatus: '/api/tunnel/claim/status',
  tunnelRunAgent: '/api/tunnel/agent/run',
  tunnelStopAgent: '/api/tunnel/agent/stop',
  tunnelEnable: '/api/tunnel/enable',
  tunnelDisable: '/api/tunnel/disable',
  authState: '/api/auth/state',
  login: '/api/auth/login',
  logout: '/api/auth/logout',
  changePassword: '/api/auth/password',
  sessions: '/api/auth/sessions',
  revokeSession: (id: string) => `/api/auth/sessions/${encodeURIComponent(id)}`,
} as const

/** Cookie name for the session id. HttpOnly, SameSite=Strict, Path=/. */
export const SESSION_COOKIE = 'mcdash_session'

/**
 * Required on every mutating request.
 *
 * CSRF defence that does not depend on SameSite surviving a proxy: a
 * cross-origin form post cannot set a custom header, and a cross-origin fetch
 * that tries is stopped by preflight. `web/client.ts` has always sent it.
 */
export const CSRF_HEADER = 'x-mcdash'

/**
 * WebSocket frames, upgraded on the SAME port at /ws.
 *
 * Kubek moved WebSockets to short polling in v3.0.0 ("port 3001 no longer
 * used") and moved live console back to WebSocket in v4.0.0. Read together, the
 * thing they were fixing was the SECOND PORT -- which complicates reverse
 * proxying, TLS termination, firewall rules and container port mapping -- not
 * the protocol. Polling cannot carry a live console, which is why they came
 * back. One port, real-time frames.
 */
export const WS_PATH = '/ws'

export const ServerFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), data: Snapshot }),
  z.object({ type: z.literal('log'), data: LogBatch }),
  z.object({ type: z.literal('hello'), data: AppInfo }),
])
export type ServerFrame = z.infer<typeof ServerFrame>

export const ClientFrame = z.discriminatedUnion('type', [
  /** Keeps proxies from idling the connection out. */
  z.object({ type: z.literal('ping') }),
])
export type ClientFrame = z.infer<typeof ClientFrame>
