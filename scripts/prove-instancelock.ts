/**
 * PROOF: one dashboard per data directory.
 *
 * The harm this guards is concurrent writers: sessions.json, attached.json,
 * backup-policy.json and the audit log are all read-modify-write files that
 * assume a single writer, and 2026-08-02 showed Windows happily running two
 * instances at once (wildcard bind plus specific bind on the same port, no
 * error). The port is not the shared resource, the directory is, so the lock
 * lives in the directory and the port plays no part in the verdict.
 *
 * Asserted:
 *
 *   1. an empty directory is acquired, and the lock names this process
 *   2. a lock held by a LIVE process refuses the second starter, naming the
 *      holder, and the refusal writes nothing at all
 *   3. the port is irrelevant: a holder on another port still refuses
 *   4. a lock whose holder died is taken over, and labelled stale
 *   5. a live pid with the wrong start time is a RECYCLED pid, taken over
 *   6. a cleanly released lock is reacquired without takeover
 *   7. an unparseable lock is a crash artifact, taken over and labelled
 *   8. release marks the lock released without deleting the file, and only
 *      the holder can release it
 *   9. end to end: the real entry point refuses with exit code 3 before
 *      writing anything into the held directory
 *
 * Run:  npx tsx scripts/prove-instancelock.ts
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  acquireInstanceLock,
  releaseInstanceLock,
  LOCK_FILE,
} from '../server/instancelock'

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])

const dir = (tag: string) => mkdtempSync(join(tmpdir(), `mcdash-lock-${tag}-`))
const lockAt = (d: string) => join(d, LOCK_FILE)

/** A throwaway process to play the living holder. Not a server. */
function spawnHolder(): { pid: number; startMs: number; kill: () => void } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
    stdio: 'ignore',
  })
  if (!child.pid) throw new Error('holder did not spawn')
  return {
    pid: child.pid,
    // Within the lock's tolerance of the process table's creation time.
    startMs: Date.now(),
    kill: () => child.kill(),
  }
}

function plantLock(
  d: string,
  pid: number,
  startMs: number,
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    lockAt(d),
    JSON.stringify({
      version: 1,
      pid,
      processStartMs: startMs,
      host: '0.0.0.0',
      port: 9999,
      acquiredAt: new Date().toISOString(),
      ...extra,
    }),
  )
}

// ---------------------------------------------------------------- 1. fresh
{
  const d = dir('fresh')
  const r = acquireInstanceLock(d, { host: '127.0.0.1', port: 8422 })
  check('an empty directory is acquired', r.acquired)
  check('fresh acquisition says so', r.acquired && r.via === 'fresh')
  const body = JSON.parse(readFileSync(lockAt(d), 'utf8')) as { pid: number }
  check('the lock names this process', body.pid === process.pid)
}

// ------------------------------------------------- 2. live holder refuses
{
  const d = dir('held')
  const holder = spawnHolder()
  try {
    plantLock(d, holder.pid, holder.startMs)
    const before = readFileSync(lockAt(d), 'utf8')
    const r = acquireInstanceLock(d, { host: '127.0.0.1', port: 8422 })
    check('a live holder refuses the second starter', !r.acquired)
    check(
      'the refusal names the holder pid',
      !r.acquired && r.holder.pid === holder.pid,
    )
    const after = readFileSync(lockAt(d), 'utf8')
    check('the refusal writes nothing: lock byte-identical', before === after)
    check(
      'the refusal leaves no other file behind',
      readdirSync(d).length === 1,
    )
  } finally {
    holder.kill()
  }
}

// -------------------------------------------- 3. the port plays no part
{
  const d = dir('port')
  const holder = spawnHolder()
  try {
    plantLock(d, holder.pid, holder.startMs) // holder claims port 9999
    const r = acquireInstanceLock(d, { host: '127.0.0.1', port: 8422 })
    check('a holder on a different port still refuses', !r.acquired)
    check(
      'the holder port is reported for the message',
      !r.acquired && r.holder.port === 9999,
    )
  } finally {
    holder.kill()
  }
}

// ----------------------------------------------------- 4. dead holder: stale
{
  const d = dir('stale')
  const holder = spawnHolder()
  holder.kill()
  // Wait for the pid to actually leave the process table.
  await new Promise((res) => setTimeout(res, 500))
  plantLock(d, holder.pid, holder.startMs)
  const r = acquireInstanceLock(d, { host: '127.0.0.1', port: 8422 })
  check('a dead holder is taken over', r.acquired)
  check('the takeover is labelled stale', r.acquired && r.via === 'stale')
  check(
    'the previous pid is reported',
    r.acquired && r.previousPid === holder.pid,
  )
  const body = JSON.parse(readFileSync(lockAt(d), 'utf8')) as { pid: number }
  check('the lock now names this process', body.pid === process.pid)
}

// -------------------------------------------------- 5. recycled pid: stale
{
  const d = dir('recycled')
  const holder = spawnHolder()
  try {
    // The pid is alive, but the recorded start time is an hour before the
    // process actually started: that lock belonged to an earlier life of the
    // pid, and its writer is gone.
    plantLock(d, holder.pid, holder.startMs - 3_600_000)
    const r = acquireInstanceLock(d, { host: '127.0.0.1', port: 8422 })
    check('a live pid with the wrong start time is taken over', r.acquired)
    check('pid recycling reads as stale', r.acquired && r.via === 'stale')
  } finally {
    holder.kill()
  }
}

// ------------------------------------------------ 6. released lock is quiet
{
  const d = dir('released')
  const holder = spawnHolder()
  holder.kill()
  plantLock(d, holder.pid, holder.startMs, {
    released: true,
    releasedAt: new Date().toISOString(),
  })
  const r = acquireInstanceLock(d, { host: '127.0.0.1', port: 8422 })
  check('a released lock is reacquired', r.acquired)
  check(
    'a clean release does not read as a takeover',
    r.acquired && r.via === 'released',
  )
}

// ----------------------------------------------------- 7. corrupt lock file
{
  const d = dir('corrupt')
  writeFileSync(lockAt(d), '{"version":1,"pid":')
  const r = acquireInstanceLock(d, { host: '127.0.0.1', port: 8422 })
  check('an unparseable lock is taken over', r.acquired)
  check('the takeover is labelled corrupt', r.acquired && r.via === 'corrupt')
}

// ------------------------------------------------------ 8. release semantics
{
  const d = dir('release')
  acquireInstanceLock(d, { host: '127.0.0.1', port: 8422 })
  releaseInstanceLock(d)
  check('release keeps the file', existsSync(lockAt(d)))
  const body = JSON.parse(readFileSync(lockAt(d), 'utf8')) as {
    released?: boolean
    pid: number
  }
  check('release marks the lock released', body.released === true)

  // Only the holder can release: plant a live stranger's lock and try.
  const d2 = dir('release-other')
  const holder = spawnHolder()
  try {
    plantLock(d2, holder.pid, holder.startMs)
    releaseInstanceLock(d2)
    const other = JSON.parse(readFileSync(lockAt(d2), 'utf8')) as {
      released?: boolean
    }
    check(
      "release of another process's lock is a no-op",
      other.released !== true,
    )
  } finally {
    holder.kill()
  }
}

// --------------------------------- 9. the real entry point, end to end
{
  const d = dir('e2e')
  const holder = spawnHolder()
  try {
    plantLock(d, holder.pid, holder.startMs)
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'server/main.ts'],
      {
        cwd: join(import.meta.dirname, '..'),
        env: { ...process.env, MCDASH_DATA_DIR: d },
        encoding: 'utf8',
        timeout: 120_000,
      },
    )
    check('main.ts refuses with exit code 3', run.status === 3)
    check(
      'the refusal names the situation',
      /Another dashboard is already running/.test(run.stderr),
    )
    check(
      'the refusal names the holder pid',
      new RegExp(`pid ${holder.pid}`).test(run.stderr),
    )
    check(
      'the refusal names the lock file',
      run.stderr.includes(LOCK_FILE),
    )
    check(
      'nothing was written into the held directory: no admin was minted',
      !existsSync(join(d, 'auth.json')),
    )
    check(
      'the held lock is untouched',
      (JSON.parse(readFileSync(lockAt(d), 'utf8')) as { pid: number }).pid ===
        holder.pid,
    )
  } finally {
    holder.kill()
  }
}

console.log('')
let failed = 0
for (const [l, ok, d] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d ? `  (${d})` : ''}`)
}
console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
