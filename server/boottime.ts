import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { START_GRACE_SECONDS, START_GRACE_DEFAULT } from './health'

/**
 * How long this particular server takes to start, measured rather than assumed.
 *
 * WHAT THIS REPLACES. `START_GRACE_SECONDS` is a constant keyed by platform --
 * 420 s for 1.7.10, 180 s otherwise. It decides STARTING vs HUNG for a process
 * that is up but silent on its port, and HUNG renders as "It is not going to come
 * back on its own." One constant cannot be right for a 13 s Paper server and a
 * 100 s modpack, and docs/portability-audit.md flagged the case that actually
 * breaks: a larger pack on a slower disk exceeds 420 s and is called HUNG while
 * it is starting perfectly normally.
 *
 * WHAT IS MEASURED. The uptime of a java process at the moment it first answers
 * a status ping with a real version rather than the still-starting placeholder
 * (spec §4). Uptime, not a stopwatch: the process itself carries how long it has
 * been alive, so the measurement does not depend on the scan having witnessed the
 * exact moment the process appeared. The only thing the scan must witness is the
 * server NOT being ready first, which is a much weaker requirement -- and the
 * whole safety of this file rests on it.
 *
 * THE FAILURE THIS IS BUILT AROUND. If a sample is taken from a process that was
 * already ready the first time we looked at it, the number is not a boot time,
 * it is however long that server had been up. Start the dashboard against a
 * server running since breakfast and the naive version records a 14,400 s "boot",
 * derives an eight-hour grace, writes it to disk, and a genuinely hung server is
 * never reported HUNG again. One bad sample disables the mechanism permanently
 * and nothing ever prompts anyone to look at it.
 *
 * So: a sample is recorded ONLY for a process whose first sighting showed it not
 * yet ready. That single rule also disposes of the mid-life blip -- a healthy
 * server that misses one SLP reply and answers the next (a dropped packet, or a
 * stop-the-world pause per spec §13) -- because that process's first sighting was
 * ready, so it is never a candidate. A plausibility bound backstops both, for the
 * paths nobody thought of.
 *
 * THE DIRECTION OF SAFETY, which decides every tie-break here. Too wide a window
 * delays a HUNG verdict: a wedged server reads STARTING for longer than it should,
 * and the cost is a slower diagnosis. Too narrow a window produces a false HUNG
 * on a server that is booting fine, which is an untrue sentence in the UI and an
 * invitation to intervene in a boot. Those costs are not comparable, so:
 *
 *   - widening is adopted from a single observation;
 *   - shortening below the platform default is not adopted until SAMPLES_TO_SHORTEN
 *     boots have been seen, because one lucky fast boot is not evidence that a
 *     slow one cannot happen;
 *   - a floor applies regardless of how fast this server has ever been;
 *   - every unreadable, corrupt or implausible input means "nothing measured",
 *     which means the platform default -- the same shape as decision 0003's
 *     "absent means yes".
 *
 * THE HONEST LIMIT. A boot genuinely longer than everything measured before it --
 * a modpack update, a world converting after a version change, a first run that
 * rebuilds registries -- will be reported HUNG before it finishes. That boot is
 * still watched, so it is recorded when it completes and the window widens to fit
 * it: the mechanism gets one such call wrong per server and then never again. It
 * is not designed away because doing so would mean never shortening any window,
 * and the wording of the HUNG verdict says what it is based on so the reader can
 * judge it.
 *
 * Proof: scripts/prove-boottime.ts, written before this file.
 */

export const BOOT_FILE = 'boot-times.json'

/**
 * How many boots to remember per server. Enough that one anomalous boot does not
 * dominate for ever, few enough that a genuine slowdown (a disk starting to fail,
 * a pack getting heavier) is reflected within a couple of weeks of restarts.
 */
export const KEEP_SAMPLES = 10

/**
 * The narrowest window this will ever derive, whatever the measurements say.
 *
 * Measured boots on this host: ~13 s Paper, ~5 s for a bare JVM, 85-100 s GTNH.
 * 60 s is over four times the fastest real server here, which leaves room for a
 * cold file cache or four servers contending at boot -- the conditions under
 * which a normally-fast server is slow, and exactly when a false HUNG would fire.
 */
export const FLOOR_SECONDS = 60

/**
 * The widest window this will ever derive. Bounds the damage a single enormous
 * sample can do if one gets past the guards below.
 */
export const CEILING_SECONDS = 1800

/**
 * Above this, a reading is not treated as a boot at all.
 *
 * Backstop to the born-ready rule rather than the primary defence. A WMI creation
 * date that is wrong, a clock adjustment mid-boot, or a path through the state
 * machine nobody anticipated all produce a large number, and a large number is
 * the shape of the failure that matters. 15 minutes is far past any boot observed
 * here and still well short of the uptimes that would poison the window.
 */
export const MAX_PLAUSIBLE_SECONDS = 900

/** Boots that must be measured before a window shorter than the default is used. */
export const SAMPLES_TO_SHORTEN = 5

/** Headroom over the longest observed boot. */
export const GRACE_MULTIPLIER = 2

export type BootSample = {
  /** Process start -> a status ping answered with a real version. The boot. */
  readySeconds: number
  /**
   * Process start -> the port answering at all, placeholder included. Null unless
   * we saw the port closed first, so this is never inferred from a late arrival.
   * Informational: it is what separates "not listening yet" from "listening and
   * still loading", which is the difference between GTNH's 15 s and its 100 s.
   */
  portSeconds: number | null
  at: string
  pid: number
}

export type BootHistory = {
  version: 1
  /** Directory name -> samples, oldest first. Same key as the backup policy. */
  servers: Record<string, BootSample[]>
  updatedAt: string | null
}

export type BootTiming = {
  graceSeconds: number
  /** Whether the window came from measurement or from the platform table. */
  source: 'measured' | 'default'
  samples: number
  maxSeconds: number | null
  lastSeconds: number | null
  lastPortSeconds: number | null
  detail: string
}

/** One scan's reading of one server. */
export type Reading = {
  pid: number | null
  uptimeSeconds: number | null
  /** The port answered at all, placeholder included. */
  responding: boolean
  /** The port answered with a real version. Spec §4: responding is not ready. */
  ready: boolean
}

export type BootObservation = {
  recorded: BootSample | null
  /** Why a candidate was not recorded. Null when there was no candidate. */
  discarded: string | null
}

// ------------------------------------------------------------------ the file

export function bootPath(dataDir: string): string {
  return join(dataDir, BOOT_FILE)
}

export function defaultHistory(): BootHistory {
  return { version: 1, servers: {}, updatedAt: null }
}

/**
 * Read the history from disk, discarding anything that is not a sample.
 *
 * Every rejection lands on "nothing measured", which derives the platform
 * default. A corrupt file must never be the reason a window silently becomes
 * eight hours wide.
 */
export function loadHistory(dataDir: string): BootHistory {
  const p = bootPath(dataDir)
  if (!existsSync(p)) return defaultHistory()
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
    if (!isRecord(raw)) return defaultHistory()
    // A file written by a later version may have given these fields different
    // meanings. Reading it as if it had not is how a wrong number gets trusted.
    if (raw.version !== 1) return defaultHistory()
    if (!isRecord(raw.servers)) return defaultHistory()

    const servers: Record<string, BootSample[]> = {}
    for (const [name, list] of Object.entries(raw.servers)) {
      if (!Array.isArray(list)) continue
      const clean = list.filter(isSample).slice(-KEEP_SAMPLES)
      if (clean.length > 0) servers[name] = clean
    }
    return {
      version: 1,
      servers,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    }
  } catch {
    return defaultHistory()
  }
}

function isSample(v: unknown): v is BootSample {
  if (!isRecord(v)) return false
  const r = v.readySeconds
  // The same bound the recorder applies. A value that could not have been
  // written by this code must not be honoured just because it is on disk.
  if (typeof r !== 'number' || !Number.isFinite(r)) return false
  if (r <= 0 || r > MAX_PLAUSIBLE_SECONDS) return false
  const p = v.portSeconds
  if (p !== null && p !== undefined && (typeof p !== 'number' || !Number.isFinite(p))) return false
  return true
}

export function samplesFor(h: BootHistory, name: string): BootSample[] {
  return h.servers[name] ?? []
}

// ----------------------------------------------------------------- the window

/**
 * Derive the start window from what has been measured. Pure.
 *
 * Kept separate from the state and the file so the decision can be asserted
 * directly, and so `health.ts` stays a pure function of its inputs.
 */
export function deriveTiming(kind: string, samples: BootSample[]): BootTiming {
  const platformDefault = START_GRACE_SECONDS[kind] ?? START_GRACE_DEFAULT
  const last = samples.length > 0 ? samples[samples.length - 1] : null

  if (samples.length === 0) {
    return {
      graceSeconds: platformDefault,
      source: 'default',
      samples: 0,
      maxSeconds: null,
      lastSeconds: null,
      lastPortSeconds: null,
      detail:
        `No boot has been measured for this server yet, so the ${platformDefault}s window for its platform applies. ` +
        'A measurement is taken the next time it is watched starting from cold.',
    }
  }

  // The longest, not the mean. The window has to survive the worst normal case,
  // which on this host is four servers booting at once after a reboot and
  // contending for the same disk -- not the median restart on a quiet machine.
  const maxSeconds = Math.max(...samples.map((s) => s.readySeconds))
  const raw = maxSeconds * GRACE_MULTIPLIER
  const clamped = Math.min(CEILING_SECONDS, Math.max(FLOOR_SECONDS, raw))

  // Widening is free -- it can only delay a HUNG verdict. Shortening can invent
  // one, so it has to be earned.
  if (clamped < platformDefault && samples.length < SAMPLES_TO_SHORTEN) {
    return {
      graceSeconds: platformDefault,
      source: 'default',
      samples: samples.length,
      maxSeconds,
      lastSeconds: last?.readySeconds ?? null,
      lastPortSeconds: last?.portSeconds ?? null,
      detail:
        `${samples.length} boot${samples.length === 1 ? '' : 's'} measured, the longest ${maxSeconds}s, ` +
        `which would give a ${clamped}s window. Holding the ${platformDefault}s platform default until ` +
        `${SAMPLES_TO_SHORTEN} boots have been seen: narrowing the window on a couple of fast starts is how a ` +
        'server that is booting slowly gets called hung.',
    }
  }

  const bounded =
    clamped === CEILING_SECONDS && raw > CEILING_SECONDS
      ? ` Capped at the ${CEILING_SECONDS}s ceiling.`
      : clamped === FLOOR_SECONDS && raw < FLOOR_SECONDS
        ? ` Raised to the ${FLOOR_SECONDS}s floor.`
        : ''

  return {
    graceSeconds: clamped,
    source: 'measured',
    samples: samples.length,
    maxSeconds,
    lastSeconds: last?.readySeconds ?? null,
    lastPortSeconds: last?.portSeconds ?? null,
    detail:
      `${clamped}s, from ${samples.length} measured boot${samples.length === 1 ? '' : 's'}: the longest was ` +
      `${maxSeconds}s and the window is ${GRACE_MULTIPLIER}x that.${bounded} ` +
      `The platform default would have been ${platformDefault}s.`,
  }
}

/**
 * What a successful start is allowed to say about readiness.
 *
 * `startServer` verifies a *process*, not a server that answers. The live
 * Skyblock restart on 2026-07-30 returned in 5 s with a healthy JVM and RCON
 * refusing connections for another ~25 s, correct behaviour, reported in a way
 * that reads as finished.
 *
 * The fix is the sentence, not the wait. Blocking until ready would hold an HTTP
 * request for the length of a GTNH boot and hold the per-server lock across it,
 * so an operator wanting to stop a server wedged mid-boot would be refused by the
 * call that is waiting for it. A server left starting is recoverable; a control
 * surface that will not answer during the one minute you need it is not.
 *
 * With nothing measured this says so rather than quoting the platform default as
 * though it were an observation of this server. A guess presented as a
 * measurement is the failure this whole file exists to avoid.
 */
export function readinessNote(t: BootTiming): string {
  // Keyed on whether anything was measured, NOT on whether the measurement won
  // the window. Those are different questions: SAMPLES_TO_SHORTEN exists to keep
  // a thin record from narrowing a HUNG accusation, and it has no bearing on
  // telling someone how long this server has historically taken to start. Two
  // boots is a poor basis for calling a server hung and a perfectly good basis
  // for "expect about a minute and a half".
  if (t.samples > 0 && t.maxSeconds !== null) {
    return (
      `Not accepting players yet: this server has taken up to ${t.maxSeconds}s to finish starting ` +
      `across ${t.samples} measured boot${t.samples === 1 ? '' : 's'}.`
    )
  }
  return (
    'Not accepting players yet. No boot has been measured for this server, so there is no estimate of ' +
    'how long that takes, watch its console, or check back once it has been seen starting once.'
  )
}

// ------------------------------------------------------------------ the state

/**
 * What we know about the process currently occupying one directory.
 *
 * `bornReady` is the load-bearing field. See the header: it is the difference
 * between measuring a boot and laundering an uptime into one.
 */
type Watch = {
  pid: number
  bornReady: boolean
  /** Highest uptime seen for this pid. A drop means a different process. */
  lastUptime: number
  /** We saw this process silent, so a later first response is a real transition. */
  sawSilent: boolean
  portSeconds: number | null
  /** A candidate has already been resolved for this process, recorded or not. */
  settled: boolean
}

const watching = new Map<string, Watch>()

let cache: BootHistory = defaultHistory()
let dirty = false
/** Which data dir the cache was loaded from, so priming stays a no-op per scan. */
let loadedFrom: string | null = null

/**
 * Uptime is `round((now - creationDate)/1000)` and so monotonic, but a system
 * clock adjustment can move it. A few seconds of tolerance keeps a clock nudge
 * from being read as a restart.
 */
const UPTIME_REGRESSION_TOLERANCE = 5

/**
 * Load the history into memory.
 *
 * A no-op once loaded: this service is the only writer, so re-reading the file
 * on a loop that runs every ten seconds would be a synchronous read that can only
 * ever return what we already have.
 */
export function primeHistory(dataDir: string): BootHistory {
  if (loadedFrom === dataDir) return cache
  cache = loadHistory(dataDir)
  dirty = false
  loadedFrom = dataDir
  return cache
}

/** The window for one server, from memory. Sync and allocation-light. */
export function timingFor(kind: string, name: string): BootTiming {
  return deriveTiming(kind, samplesFor(cache, name))
}

/**
 * Feed one scan's reading for one server.
 *
 * Memory only -- this runs on the scan path, where synchronous disk I/O below an
 * await gets billed to whichever server's RCON reply is in flight (spec §11).
 * `flush()` does the writing, once, after every probe has finished.
 */
export function observe(name: string, r: Reading): BootObservation {
  // No process: forget everything. The next appearance is a different process
  // and must be measured from its own first sighting.
  if (r.pid === null) {
    watching.delete(name)
    return { recorded: null, discarded: null }
  }

  const prev = watching.get(name)
  const uptime = r.uptimeSeconds

  // Unreadable uptime: nothing can be measured, but the sighting still counts --
  // if it is ready now, it was not watched booting, and that must be remembered.
  if (uptime === null || !Number.isFinite(uptime)) {
    if (!prev || prev.pid !== r.pid) {
      watching.set(name, {
        pid: r.pid,
        bornReady: r.ready,
        lastUptime: 0,
        sawSilent: !r.responding,
        portSeconds: null,
        settled: false,
      })
    }
    return { recorded: null, discarded: null }
  }

  const isNewProcess =
    !prev || prev.pid !== r.pid || uptime < prev.lastUptime - UPTIME_REGRESSION_TOLERANCE

  const w: Watch = isNewProcess
    ? {
        pid: r.pid,
        bornReady: r.ready,
        lastUptime: uptime,
        sawSilent: !r.responding,
        portSeconds: null,
        settled: false,
      }
    : {
        ...prev,
        lastUptime: Math.max(prev.lastUptime, uptime),
      }

  // Only credit a port-open time we actually watched happen. A dashboard that
  // started late would otherwise report its own first sighting as the moment the
  // port opened, which is an over-estimate presented as a measurement.
  if (r.responding && w.portSeconds === null && w.sawSilent) w.portSeconds = uptime

  watching.set(name, w)

  if (!r.ready || w.settled) return { recorded: null, discarded: null }

  if (w.bornReady) {
    // Not an error, and not rare -- it is the normal case every time the service
    // restarts against a running fleet. It is reported rather than silent so the
    // reason a server has no measurements is answerable.
    w.settled = true
    return {
      recorded: null,
      discarded:
        'this process was already answering when the dashboard first saw it, so its uptime is not a boot time',
    }
  }

  w.settled = true

  if (uptime <= 0) {
    return { recorded: null, discarded: 'uptime read as 0s, which is a rounding artefact rather than a boot' }
  }
  if (uptime > MAX_PLAUSIBLE_SECONDS) {
    return {
      recorded: null,
      discarded: `${uptime}s is past the ${MAX_PLAUSIBLE_SECONDS}s plausible bound for a boot, so it is treated as a bad reading rather than a slow server`,
    }
  }

  const s: BootSample = {
    readySeconds: uptime,
    portSeconds: w.portSeconds,
    at: new Date().toISOString(),
    pid: r.pid,
  }
  cache = {
    version: 1,
    servers: { ...cache.servers, [name]: [...samplesFor(cache, name), s].slice(-KEEP_SAMPLES) },
    updatedAt: new Date().toISOString(),
  }
  dirty = true
  return { recorded: s, discarded: null }
}

/**
 * Write anything `observe()` recorded. Returns whether it wrote.
 *
 * Called after the scan's probes have all completed, so the disk write cannot
 * land inside another server's latency measurement. Writes are rare by
 * construction: one per observed boot, not one per scan.
 *
 * tmp + rename, as with the backup policy: a crash mid-write would otherwise
 * leave a file that reads as "nothing measured", quietly discarding the history.
 */
export function flush(dataDir: string): boolean {
  if (!dirty) return false
  const p = bootPath(dataDir)
  const tmp = `${p}.tmp`
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf8')
  renameSync(tmp, p)
  dirty = false
  return true
}

/** Test seam. Never called by the service. */
export function resetForTest(): void {
  watching.clear()
  cache = defaultHistory()
  dirty = false
  loadedFrom = null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
