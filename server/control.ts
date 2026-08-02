import { join } from 'node:path'
import { getPriority, setPriority, constants as osConstants } from 'node:os'
import { scanJvms, jvmForDir, type JvmScan } from './platform'
import { gamePortOf, rconConfig } from './properties'
import { Rcon } from './rcon'
import { detectLauncher, invokeLauncher, indexTasks, type Launcher } from './launcher'
import { readinessNote, timingFor } from './boottime'
import type { ControlAction, ControlResult, DoubleSpawnAlert } from '@shared/api'

/**
 * Start, stop and restart.
 *
 * THIS IS THE FIRST CODE IN THIS PROJECT THAT CAN DESTROY DATA. Two JVMs against
 * one world corrupts it, and the corruption is not immediate or obvious -- it is
 * region files written by two processes that each believe they own the world.
 *
 * Four layers, in the order they run:
 *
 *   1. A per-server async mutex, so two concurrent requests cannot both pass the
 *      pre-check. Node is single-threaded but `await` is a yield point, and
 *      "check, then await, then act" is a race like any other.
 *   2. A fresh authoritative pre-check immediately before delegating, using
 *      process-tree identity -- NEVER a port probe (spec §1). A dormant duplicate
 *      directory declares the same port as a live server, so a port probe answers
 *      about the wrong directory.
 *   3. Doubt counts as running. If identity could not be resolved, we refuse.
 *      Spec §14: an unattributable JVM is indistinguishable from an absent one,
 *      and the consequences are wildly asymmetric -- refusing to start costs a
 *      click, starting a second JVM costs a world.
 *   4. Post-start verification: poll until exactly one JVM owns the directory. If
 *      two ever do, raise a first-class alert rather than logging it.
 *
 * HONEST LIMIT, ON RECORD. Because starting is *delegated* to a mechanism we do
 * not own, this guard cannot be atomic. Task Scheduler at boot, or someone
 * double-clicking start.bat, can still create a second JVM between our check and
 * the launcher taking effect. The app can detect that; it cannot prevent it.
 * Detection-and-alarm is the ceiling, and the README says so rather than implying
 * a guarantee. Anyone tempted to describe this as "prevents double starts" should
 * read this paragraph again.
 */

/** How long to wait for a JVM to appear after delegating a start. */
export const START_APPEAR_TIMEOUT_MS = 120_000
/** How long to wait for the process to go away after `stop`. */
export const STOP_EXIT_TIMEOUT_MS = 180_000
/** Gap between verification polls. Each one costs a process enumeration. */
export const VERIFY_POLL_MS = 2000
/** RCON timeout for a `stop`: generous, because it queues on the main thread. */
const STOP_RCON_TIMEOUT_MS = 15_000

// ------------------------------------------------------------------- mutex

/**
 * One promise chain per server id. Not a general lock library: the only property
 * needed is that two requests for the SAME server never interleave, while two
 * requests for different servers may run concurrently.
 */
const chains = new Map<string, Promise<unknown>>()
/** Exposed so the UI can grey a button, and so a proof can observe queueing. */
const busy = new Set<string>()

export function isBusy(id: string): boolean {
  return busy.has(id)
}

export function withServerLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(id) ?? Promise.resolve()
  const next = prev.then(async () => {
    busy.add(id)
    try {
      return await fn()
    } finally {
      busy.delete(id)
    }
  })
  // Swallowed on the chain only: the failure still reaches the caller through
  // `next`. Without this an early rejection would make every later request for
  // this server reject with a stale error.
  chains.set(
    id,
    next.catch(() => undefined),
  )
  return next
}

/** Test seam. Never called by the service. */
export function resetLocks(): void {
  chains.clear()
  busy.clear()
}

// ------------------------------------------------------------- double spawn

let alerts: DoubleSpawnAlert[] = []

export function doubleSpawnAlerts(): DoubleSpawnAlert[] {
  return alerts
}
export function clearDoubleSpawnAlerts(): void {
  alerts = []
}

function raiseDoubleSpawn(name: string, dir: string, pids: number[]): void {
  alerts = [
    ...alerts.filter((a) => a.server !== name),
    {
      server: name,
      dir,
      pids,
      at: new Date().toISOString(),
      detail:
        `${pids.length} java processes are serving this directory at once (pids ${pids.join(', ')}). ` +
        'Two JVMs writing one world corrupts it. Stop one of them now, pick the newer pid if you know which you started. ' +
        'The dashboard cannot prevent this, only detect it: starting is delegated to Task Scheduler or a script, so something outside this app can always create a second process.',
    },
  ]
}

// ------------------------------------------------------------------ probing

/**
 * How many JVMs own this directory, and whether we are sure.
 *
 * `certain: false` means the answer is unusable, NOT that the answer is zero.
 * Every caller here must treat it as "possibly running".
 */
export type Occupancy = {
  pids: number[]
  certain: boolean
  doubt: string | null
}

export async function occupancyOf(dir: string, scan?: JvmScan): Promise<Occupancy> {
  const s = scan ?? (await scanJvms([{ dir, gamePort: gamePortOf(dir) }]))
  if (!s.ok) {
    return {
      pids: [],
      certain: false,
      doubt: `process enumeration failed${s.failure ? ` (${s.failure})` : ''}`,
    }
  }
  // Every JVM attributed to this directory, not just the first. The whole point
  // of this function is to be able to say "two".
  const nkey = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  const pids = s.jvms.filter((j) => nkey(j.dir) === nkey(dir)).map((j) => j.pid)
  if (pids.length > 0) return { pids, certain: true, doubt: null }

  // Nothing attributed. Before concluding "empty", check the two ways that answer
  // can be a lie.
  if (s.occupiedDirs.some((o) => nkey(o) === nkey(dir))) {
    return {
      pids: [],
      certain: false,
      doubt:
        'this directory is holding its log file open, so something IS running from it, but no process could be matched to it',
    }
  }
  if (s.unattributed.length > 0) {
    return {
      pids: [],
      certain: false,
      doubt: `${s.unattributed.length} java process(es) are running that could not be matched to any directory, and one of them may be this server`,
    }
  }
  return { pids: [], certain: true, doubt: null }
}

// ------------------------------------------------------------------ actions

/**
 * `kind` is optional and only used to pick the fallback start window for the
 * readiness sentence. A caller that does not know the platform gets the generic
 * wording, never a wrong number.
 */
export type Target = { id: string; name: string; dir: string; kind?: string }

/** What a start may claim about a server that exists but has not answered yet. */
function readiness(t: Target): string {
  return readinessNote(timingFor(t.kind ?? 'unknown', t.name))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Poll until the directory settles on an expected occupancy, or time out.
 *
 * Also the double-spawn detector: any observation of two PIDs raises the alert
 * immediately rather than waiting for the loop to finish, because the damage is
 * happening while we poll.
 */
/**
 * A server the dashboard spawns must run like a server, not like the
 * dashboard. The observer deliberately stays BelowNormal (decision 0009: it
 * must not compete with what it watches), but priority class is inherited,
 * so a script-started server would run at base 6 with its pages first in
 * line for eviction. launcher.ts raises the wrapper at spawn; this closes
 * the race for the JVM itself once the post-start verification has named
 * it. Task-started servers are never touched here: their priority belongs
 * to the task definition, which the operator owns.
 *
 * Node maps Windows priority classes onto nice-style numbers: BelowNormal
 * reads as 10, Normal as 0. Raising to Normal needs no elevation for a
 * same-user process.
 */
function ensureSpawnedPriority(pid: number): 'normal' | 'unverified' {
  try {
    if (getPriority(pid) > osConstants.priority.PRIORITY_NORMAL) {
      setPriority(pid, osConstants.priority.PRIORITY_NORMAL)
    }
    // Read back rather than trust either raise (launcher's or this one): the
    // sentence built from this return value states the priority as a fact.
    return getPriority(pid) <= osConstants.priority.PRIORITY_NORMAL ? 'normal' : 'unverified'
  } catch {
    return 'unverified'
  }
}

/** The sentence fragment the control result carries for each outcome. */
function priorityNote(outcome: 'normal' | 'unverified' | null): string {
  if (outcome === 'normal')
    return ' It runs at normal priority, read back after the start: a spawned process would otherwise inherit this dashboard\'s own below-normal class (decision 0009).'
  if (outcome === 'unverified')
    return ' Its priority could not be read or raised, so it may be running below normal; the Overview\'s eviction exposure panel shows the live reading.'
  return ''
}

async function waitForOccupancy(
  t: Target,
  want: 'one' | 'none',
  timeoutMs: number,
): Promise<Occupancy> {
  const deadline = Date.now() + timeoutMs
  let last: Occupancy = { pids: [], certain: false, doubt: 'not yet observed' }
  for (;;) {
    last = await occupancyOf(t.dir)
    if (last.pids.length > 1) raiseDoubleSpawn(t.name, t.dir, last.pids)
    if (want === 'one' && last.pids.length === 1) return last
    if (want === 'none' && last.certain && last.pids.length === 0) return last
    if (Date.now() >= deadline) return last
    await sleep(VERIFY_POLL_MS)
  }
}

export async function startServer(t: Target, launcher: Launcher): Promise<ControlResult> {
  return withServerLock(t.id, async () => {
    if (launcher.strategy === 'none') {
      return fail(t, 'start', 'No launcher is known for this server, so the dashboard will not try to start it.')
    }

    // Layer 2 and 3: a FRESH check, inside the lock, immediately before acting.
    // Not the cached snapshot -- that may be ten seconds old, which is long
    // enough for someone else to have started it.
    const before = await occupancyOf(t.dir)
    if (before.pids.length > 0) {
      return fail(
        t,
        'start',
        `Already running as pid ${before.pids.join(', ')}. Refusing to start a second process against the same world.`,
      )
    }
    if (!before.certain) {
      return fail(
        t,
        'start',
        `Cannot confirm this server is stopped. ${before.doubt}. Refusing to start, because a second JVM on one world corrupts it and "I cannot tell" is not "it is not running".`,
      )
    }

    await invokeLauncher(t.dir, launcher)

    const after = await waitForOccupancy(t, 'one', START_APPEAR_TIMEOUT_MS)
    if (after.pids.length > 1) {
      return fail(
        t,
        'start',
        `TWO java processes now own this directory (pids ${after.pids.join(', ')}). Stop one immediately. Two JVMs writing one world corrupts it.`,
      )
    }
    if (after.pids.length === 1) {
      // A PROCESS is what was verified, not a server that answers, and the
      // sentence says so.
      //
      // Do not "finish this off" by polling until it is ready. That would hold an
      // HTTP request open for the length of a GTNH boot -- 100 s measured here --
      // and hold this server's lock across it, so an operator trying to stop a
      // server wedged mid-boot would be refused by the very call that is waiting
      // for it. A server left starting is recoverable; a control surface that
      // will not answer during the minute you need it is not. The measured boot
      // time (M3.5) makes the wait unnecessary: the reader is told what to expect
      // instead of being made to sit through it.
      const pri = launcher.strategy === 'script' ? ensureSpawnedPriority(after.pids[0]!) : null
      return ok(
        t,
        'start',
        `Started. One java process owns this directory (pid ${after.pids[0]}).${priorityNote(pri)} ${readiness(t)}`,
      )
    }
    return fail(
      t,
      'start',
      `The launcher was invoked but no java process appeared within ${START_APPEAR_TIMEOUT_MS / 1000}s${
        after.doubt ? ` (${after.doubt})` : ''
      }. Check the server's own log. The launcher reporting success only means the task started, not that the server did.`,
    )
  })
}

export async function stopServer(t: Target): Promise<ControlResult> {
  return withServerLock(t.id, async () => {
    const before = await occupancyOf(t.dir)
    if (before.certain && before.pids.length === 0) {
      return fail(t, 'stop', 'Not running, so there is nothing to stop.')
    }

    // Stopping is universal: RCON `stop` works regardless of how the server was
    // started. Deliberately NOT a kill -- a killed server loses whatever the
    // chunk writer had in flight, and this is the same shutdown the nightly
    // backup has been performing without incident.
    const rc = rconConfig(t.dir)
    if (!rc) {
      return fail(
        t,
        'stop',
        'RCON is not configured for this server, so it cannot be asked to shut down cleanly. The dashboard will not kill a running server: that risks a corrupt world. Enable RCON in server.properties, or stop it from its own console.',
      )
    }

    try {
      const conn = await Rcon.connect(rc.port, rc.password, '127.0.0.1', STOP_RCON_TIMEOUT_MS)
      try {
        // Flush first. `stop` saves too, but if `stop` is what wedges, an
        // explicit save has already happened.
        await conn.run('save-all flush', STOP_RCON_TIMEOUT_MS)
        await conn.run('stop', STOP_RCON_TIMEOUT_MS).catch(() => undefined)
      } finally {
        conn.close()
      }
    } catch (e) {
      return fail(
        t,
        'stop',
        `Could not ask the server to stop over RCON: ${e instanceof Error ? e.message : 'failed'}. Not escalating to a kill, that is a data-loss risk, and a server that will not answer RCON may be mid-save.`,
      )
    }

    const after = await waitForOccupancy(t, 'none', STOP_EXIT_TIMEOUT_MS)
    if (after.certain && after.pids.length === 0) {
      return ok(t, 'stop', 'Stopped cleanly. The world was flushed before shutdown.')
    }
    if (after.pids.length > 0) {
      return fail(
        t,
        'stop',
        `Accepted the stop command but pid ${after.pids.join(', ')} is still running after ${STOP_EXIT_TIMEOUT_MS / 1000}s. Left alone deliberately rather than killed. A slow shutdown is normal for a large modpack; check its log before intervening.`,
      )
    }
    return fail(t, 'stop', `Could not confirm the server exited. ${after.doubt ?? 'identity unresolved'}.`)
  })
}

/**
 * Stop then start, holding the lock across BOTH.
 *
 * The reason this is not `stopServer()` followed by `startServer()`: between two
 * separately-locked calls another request could slip in, and a start racing the
 * tail of a shutdown is exactly the two-JVM case. It also means the pre-check for
 * the start half is the verified result of the stop half.
 */
export async function restartServer(t: Target, launcher: Launcher): Promise<ControlResult> {
  return withServerLock(t.id, async () => {
    if (launcher.strategy === 'none') {
      return fail(
        t,
        'restart',
        'No launcher is known for this server, so it would stop and not come back. Refusing.',
      )
    }
    const before = await occupancyOf(t.dir)
    if (before.pids.length > 0) {
      const rc = rconConfig(t.dir)
      if (!rc) {
        return fail(t, 'restart', 'Running, but RCON is not configured, so it cannot be shut down cleanly.')
      }
      try {
        const conn = await Rcon.connect(rc.port, rc.password, '127.0.0.1', STOP_RCON_TIMEOUT_MS)
        try {
          await conn.run('save-all flush', STOP_RCON_TIMEOUT_MS)
          await conn.run('stop', STOP_RCON_TIMEOUT_MS).catch(() => undefined)
        } finally {
          conn.close()
        }
      } catch (e) {
        return fail(t, 'restart', `Could not stop it over RCON: ${e instanceof Error ? e.message : 'failed'}.`)
      }
      const gone = await waitForOccupancy(t, 'none', STOP_EXIT_TIMEOUT_MS)
      if (!gone.certain || gone.pids.length > 0) {
        return fail(
          t,
          'restart',
          `Did not confirm the old process exited${gone.pids.length ? ` (pid ${gone.pids.join(', ')} still running)` : ''}, so NOT starting a new one. Starting now would put two JVMs on one world.`,
        )
      }
    } else if (!before.certain) {
      return fail(
        t,
        'restart',
        `Cannot confirm what is running. ${before.doubt}. Refusing to restart rather than risk a second process.`,
      )
    }

    await invokeLauncher(t.dir, launcher)
    const after = await waitForOccupancy(t, 'one', START_APPEAR_TIMEOUT_MS)
    if (after.pids.length > 1) {
      return fail(
        t,
        'restart',
        `TWO java processes now own this directory (pids ${after.pids.join(', ')}). Stop one immediately.`,
      )
    }
    if (after.pids.length === 1) {
      const pri = launcher.strategy === 'script' ? ensureSpawnedPriority(after.pids[0]!) : null
      return ok(
        t,
        'restart',
        `Restarted. One java process owns this directory (pid ${after.pids[0]}).${priorityNote(pri)} ${readiness(t)}`,
      )
    }
    return fail(
      t,
      'restart',
      `Stopped cleanly but no java process appeared within ${START_APPEAR_TIMEOUT_MS / 1000}s. THE SERVER IS NOW DOWN. Check its log.`,
    )
  })
}

// --------------------------------------------------------------- rcon input

/** Commands refused outright, whatever the role. */
const FORBIDDEN = [
  // `stop` has a route of its own that verifies the exit and holds the lock. Sent
  // as a raw command it bypasses both, and the UI would keep showing a server
  // that is shutting down as healthy.
  { re: /^\s*stop\s*$/i, why: 'Use the Stop button. It flushes the world first and confirms the process actually exited.' },
  { re: /^\s*restart\s*$/i, why: 'Use the Restart button, which holds a lock across the stop and the start.' },
  // Reading these back would put a password on the wire and into the UI.
  { re: /^\s*(?:rcon|password|op\s+.*password)/i, why: 'Refused: this could echo a credential into the dashboard.' },
]

export type CommandOutcome = { ok: boolean; raw: string; latencyMs: number; detail: string }

export async function runCommand(t: Target, command: string): Promise<CommandOutcome> {
  const trimmed = command.trim()
  if (!trimmed) return { ok: false, raw: '', latencyMs: 0, detail: 'Empty command.' }
  for (const f of FORBIDDEN) {
    if (f.re.test(trimmed)) return { ok: false, raw: '', latencyMs: 0, detail: f.why }
  }
  const rc = rconConfig(t.dir)
  if (!rc) {
    return { ok: false, raw: '', latencyMs: 0, detail: 'RCON is not configured for this server.' }
  }
  const t0 = Date.now()
  try {
    const conn = await Rcon.connect(rc.port, rc.password, '127.0.0.1', 10_000)
    try {
      const res = await conn.run(trimmed, 10_000)
      return { ok: true, raw: res.raw, latencyMs: res.latencyMs, detail: '' }
    } finally {
      conn.close()
    }
  } catch (e) {
    return {
      ok: false,
      raw: '',
      latencyMs: Date.now() - t0,
      detail: e instanceof Error ? e.message : 'rcon failed',
    }
  }
}

// ------------------------------------------------------------------ helpers

function ok(t: Target, action: ControlAction, detail: string): ControlResult {
  return { server: t.name, action, ok: true, detail, at: new Date().toISOString() }
}
function fail(t: Target, action: ControlAction, detail: string): ControlResult {
  return { server: t.name, action, ok: false, detail, at: new Date().toISOString() }
}

export { detectLauncher, indexTasks, join }
