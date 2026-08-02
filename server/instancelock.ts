import {
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  renameSync,
} from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * One dashboard per data directory, enforced with a lock file.
 *
 * The invariant is deliberately NOT one dashboard per port. Found 2026-08-02:
 * with the service bound to 0.0.0.0:8422, Windows let a second instance bind
 * 127.0.0.1:8422 with no error at all, and two dashboards ran against one
 * data directory. Two instances on DIFFERENT ports would do the same. What
 * they share is not the socket, it is sessions.json, attached.json,
 * backup-policy.json and the audit log, all written with read-modify-write
 * cycles that assume a single writer; concurrent writers corrupt them. A
 * pre-listen "is a dashboard answering on this port" probe was considered
 * and rejected: it tests the wrong resource, misses the different-port case
 * entirely, and cannot tell another dashboard from an unrelated app.
 *
 * The lock lives at <dataDir>/instance.lock and records pid + process start
 * time. Liveness is judged against the process table, not pid existence
 * alone: pids are recycled, so a lock is only "held" if the recorded pid is
 * alive AND its creation time matches what the lock recorded. A clean
 * shutdown rewrites the lock with a released marker rather than deleting it
 * (nothing in this project deletes files), so the takeover message only
 * appears when a holder actually died holding it.
 *
 * The window that remains: two processes that both pass the check within
 * milliseconds of each other can both believe they took over a stale lock.
 * Fresh acquisition is atomic (open with 'wx'); takeover narrows the race
 * with a re-read after writing but does not eliminate it. The realistic
 * threats (service plus a manual `npm start`, a double-clicked launcher) are
 * seconds apart, not milliseconds.
 */

export const LOCK_FILE = 'instance.lock'

/** |recorded - actual| start time within this is the same process. The
 *  recorded value derives from process.uptime() and the actual from the
 *  process table; they measure the same instant through different clocks. */
export const START_TIME_TOLERANCE_MS = 5_000

type LockFileBody = {
  version: 1
  pid: number
  /** epoch ms of process start, as close as this process can know it */
  processStartMs: number
  host: string
  port: number
  acquiredAt: string
  released?: true
  releasedAt?: string
}

export type LockAcquired = {
  acquired: true
  lockPath: string
  /** 'fresh' and 'released' are the quiet paths; 'stale' and 'corrupt' mean
   *  a previous holder died and the caller should say so. */
  via: 'fresh' | 'released' | 'stale' | 'corrupt' | 'reacquired'
  previousPid: number | null
}

export type LockRefused = {
  acquired: false
  lockPath: string
  holder: { pid: number; host: string; port: number; acquiredAt: string }
}

export type LockResult = LockAcquired | LockRefused

function lockPathOf(dataDir: string): string {
  return join(dataDir, LOCK_FILE)
}

function ownStartMs(): number {
  return Math.round(Date.now() - process.uptime() * 1000)
}

/**
 * Creation time of a live process in epoch ms, null if no such process.
 * Windows only by design (decision 0006: one repo, one platform); elsewhere
 * this returns undefined and the caller falls back to existence alone,
 * which cannot see pid reuse.
 */
function tableStartMs(pid: number): number | null | undefined {
  if (process.platform !== 'win32') return undefined
  // pid is validated as an integer before it reaches the command line, so
  // nothing here is attacker-writable. -Filter takes it as a literal.
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p -and $p.CreationDate) { [DateTimeOffset]::new($p.CreationDate.ToUniversalTime(), [TimeSpan]::Zero).ToUnixTimeMilliseconds() }`,
      ],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    ).trim()
    if (!out) return null
    const ms = Number(out)
    return Number.isFinite(ms) ? ms : null
  } catch {
    // The query failing is not evidence the holder is dead. Report the pid
    // as alive-unknown by returning undefined, and let the caller refuse:
    // a wrongly refused start is an inconvenience, a wrongly granted one is
    // two writers on one data directory.
    return undefined
  }
}

function processLooksAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readLock(lockPath: string): LockFileBody | 'corrupt' | 'missing' {
  let raw: string
  try {
    raw = readFileSync(lockPath, 'utf8')
  } catch {
    return 'missing'
  }
  try {
    const body = JSON.parse(raw) as LockFileBody
    if (
      body.version === 1 &&
      Number.isInteger(body.pid) &&
      Number.isFinite(body.processStartMs)
    ) {
      return body
    }
    return 'corrupt'
  } catch {
    return 'corrupt'
  }
}

function ownBody(host: string, port: number): LockFileBody {
  return {
    version: 1,
    pid: process.pid,
    processStartMs: ownStartMs(),
    host,
    port,
    acquiredAt: new Date().toISOString(),
  }
}

/** Atomic replace: write beside, rename over. Windows MoveFileEx semantics
 *  make the rename replace the existing file. */
function overwriteLock(lockPath: string, body: LockFileBody): void {
  const tmp = `${lockPath}.tmp`
  writeFileSync(tmp, JSON.stringify(body, null, 2))
  renameSync(tmp, lockPath)
}

export function acquireInstanceLock(
  dataDir: string,
  opts: { host: string; port: number },
): LockResult {
  const lockPath = lockPathOf(dataDir)

  // Fresh acquisition, the atomic path: 'wx' fails if the file exists. Any
  // other failure (unwritable directory, missing directory) propagates to
  // explainStartupError in main.ts, which knows how to word fs errors.
  try {
    const fd = openSync(lockPath, 'wx')
    try {
      writeFileSync(fd, JSON.stringify(ownBody(opts.host, opts.port), null, 2))
    } finally {
      closeSync(fd)
    }
    return { acquired: true, lockPath, via: 'fresh', previousPid: null }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    /* exists; evaluate the holder */
  }

  const existing = readLock(lockPath)

  if (existing === 'missing') {
    // Raced between openSync failing and readFileSync: someone else is
    // mid-write. Treat as held by an unknown live process and refuse.
    return {
      acquired: false,
      lockPath,
      holder: { pid: 0, host: opts.host, port: opts.port, acquiredAt: 'unknown' },
    }
  }

  if (existing === 'corrupt') {
    // A live holder's lock is intact: it was written whole via rename. A
    // half-written file means a crash during acquisition.
    overwriteLock(lockPath, ownBody(opts.host, opts.port))
    return verifyOwn(lockPath, 'corrupt', null)
  }

  if (existing.released) {
    overwriteLock(lockPath, ownBody(opts.host, opts.port))
    return verifyOwn(lockPath, 'released', existing.pid)
  }

  if (existing.pid === process.pid) {
    // Our own pid in an unreleased lock: either a genuine reacquire or pid
    // recycling landing on us. Either way no OTHER process holds it.
    overwriteLock(lockPath, ownBody(opts.host, opts.port))
    return verifyOwn(lockPath, 'reacquired', existing.pid)
  }

  const actualStart = tableStartMs(existing.pid)
  const alive =
    actualStart === undefined
      ? // No process table available (non-Windows, or the query failed):
        // existence is all we can check, and doubt counts as held.
        processLooksAlive(existing.pid)
      : actualStart !== null &&
        Math.abs(actualStart - existing.processStartMs) <= START_TIME_TOLERANCE_MS

  if (alive) {
    return {
      acquired: false,
      lockPath,
      holder: {
        pid: existing.pid,
        host: existing.host,
        port: existing.port,
        acquiredAt: existing.acquiredAt,
      },
    }
  }

  overwriteLock(lockPath, ownBody(opts.host, opts.port))
  return verifyOwn(lockPath, 'stale', existing.pid)
}

/** After a takeover, confirm the lock still names us; if another starter won
 *  the rename race, stand down instead of running as a second writer. */
function verifyOwn(
  lockPath: string,
  via: LockAcquired['via'],
  previousPid: number | null,
): LockResult {
  const now = readLock(lockPath)
  if (now !== 'missing' && now !== 'corrupt' && now.pid === process.pid) {
    return { acquired: true, lockPath, via, previousPid }
  }
  const holder =
    now !== 'missing' && now !== 'corrupt'
      ? { pid: now.pid, host: now.host, port: now.port, acquiredAt: now.acquiredAt }
      : { pid: 0, host: 'unknown', port: 0, acquiredAt: 'unknown' }
  return { acquired: false, lockPath, holder }
}

/**
 * Mark the lock released rather than deleting it. Idempotent; safe to call
 * from both the signal handler and the exit handler. Only releases a lock
 * this process holds: releasing someone else's would hand the directory to
 * the next starter while the real holder still runs.
 */
export function releaseInstanceLock(dataDir: string): void {
  const lockPath = lockPathOf(dataDir)
  const existing = readLock(lockPath)
  if (existing === 'missing' || existing === 'corrupt') return
  if (existing.pid !== process.pid || existing.released) return
  overwriteLock(lockPath, {
    ...existing,
    released: true,
    releasedAt: new Date().toISOString(),
  })
}
