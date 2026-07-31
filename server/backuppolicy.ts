import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Which directories the external backup script should back up.
 *
 * The problem this solves. `mcbackup.py` walks every directory under the servers
 * root that has a `level.dat` and backs it up, which means a server that will
 * never run again -- a retired modpack, a `- Copy` left over from an upgrade --
 * keeps consuming a slot in the rotation and time in the nightly window forever.
 * The only way to get it out was to delete the directory, and deleting a world
 * to tidy a backup schedule is the wrong trade: the files are the thing worth
 * keeping. So the schedule becomes explicit instead, and nothing is deleted.
 *
 * Why a file rather than the dashboard telling the script directly. The two
 * processes never run at the same time -- the backup runs from Task Scheduler at
 * 05:00 and the dashboard may well be stopped -- so the only channel that works
 * is one that persists. It also has to survive a restart of either side, which a
 * file trivially does and a socket does not.
 *
 * It lives in the dashboard's data directory, alongside config.json and
 * auth.json, and `mcbackup.py` resolves the same path (MCDASH_DATA_DIR, else the
 * platform default). See docs/decisions/0003-backup-optin.md.
 *
 * Two invariants:
 *
 *   Absent means yes. A server nobody has expressed an opinion about is backed
 *   up. A missing, empty or corrupt policy file must never be the reason a world
 *   silently stopped being protected -- that is the one failure here with
 *   irreversible consequences, so it fails safe rather than closed.
 *
 *   Opting out is a schedule change and nothing else. It never touches archives
 *   already written. `mcbackup.py` filters before it reaches rotation, so an
 *   excluded server's existing zips are not merely kept, they are never even
 *   enumerated. Proven in scripts/prove-backup-policy.ts.
 */

export type BackupPolicy = {
  version: 1
  /** What to do about a directory not named in `servers`. */
  backupByDefault: boolean
  /** Directory name -> whether to back it up. Absent means `backupByDefault`. */
  servers: Record<string, boolean>
  /** Informational: which root the names were resolved against when written. */
  serversRoot: string | null
  updatedAt: string | null
  updatedBy: string | null
}

export const POLICY_FILE = 'backup-policy.json'

export function policyPath(dataDir: string): string {
  return join(dataDir, POLICY_FILE)
}

export function defaultPolicy(): BackupPolicy {
  return {
    version: 1,
    backupByDefault: true,
    servers: {},
    serversRoot: null,
    updatedAt: null,
    updatedBy: null,
  }
}

export function loadPolicy(dataDir: string): BackupPolicy {
  const p = policyPath(dataDir)
  if (!existsSync(p)) return defaultPolicy()
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
    if (!isRecord(raw)) return defaultPolicy()
    const servers: Record<string, boolean> = {}
    if (isRecord(raw.servers)) {
      for (const [k, v] of Object.entries(raw.servers)) {
        // Only a literal false opts out. A string, a null or a typo must not be
        // read as "stop backing this up".
        if (typeof v === 'boolean') servers[k] = v
      }
    }
    return {
      version: 1,
      backupByDefault: raw.backupByDefault === false ? false : true,
      servers,
      serversRoot: typeof raw.serversRoot === 'string' ? raw.serversRoot : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : null,
    }
  } catch {
    // A corrupt file means "no opinion recorded", which means back everything up.
    return defaultPolicy()
  }
}

export function isBackupEnabled(policy: BackupPolicy, name: string): boolean {
  const v = policy.servers[name]
  return typeof v === 'boolean' ? v : policy.backupByDefault
}

/**
 * Record a decision for one directory.
 *
 * Written via a temporary file and a rename, so a crash mid-write cannot leave a
 * half-written policy -- which `loadPolicy` would read as "no opinion", silently
 * putting every excluded server back into the rotation.
 */
export function setBackupEnabled(
  dataDir: string,
  name: string,
  enabled: boolean,
  actor: string,
  serversRoot: string | null = null,
): BackupPolicy {
  const next: BackupPolicy = {
    ...loadPolicy(dataDir),
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  }
  next.servers = { ...next.servers, [name]: enabled }
  if (serversRoot) next.serversRoot = serversRoot

  const p = policyPath(dataDir)
  const tmp = `${p}.tmp`
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  renameSync(tmp, p)
  return next
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
