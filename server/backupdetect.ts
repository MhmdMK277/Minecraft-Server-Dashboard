import { promises as fs } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { ArchiveStats, BackupDetection, BackupSystem } from '@shared/api'

/**
 * Backup detection: decision 0001's four read-only signals.
 *
 * The dashboard detects and surfaces whatever backup system a server already
 * has; it does not implement one. This module opens directories, stats their
 * TOP LEVEL, and reads two kinds of small text file (a ServerUtilities
 * config, a backup log's tail). It never writes, and no route over it ever
 * grows a write.
 *
 * Like worlds.ts, the reading is on-demand (when the Backups page is opened),
 * never part of the ten-second scan: an archive directory can hold years of
 * nightly zips, and statting them every scan would be the observer becoming
 * the load. The read duration is reported so the cost stays visible.
 *
 * The reporting vocabulary is decision 0001's rule: a config flag alone is
 * INTENT; only archives on disk are evidence of a system running. Every
 * threshold that turns an mtime into the word "active" is a constant here,
 * exported so the proof can pin it.
 *
 * Path safety: the server directory and name come from the dashboard's own
 * discovery; external paths come from the operator's config.json. Nothing
 * from a request is ever joined into a path.
 */

/** Directory names an in-server backup system conventionally writes to. */
export const ARCHIVE_DIR_NAMES = ['backups', 'backup', 'world_backups']

/**
 * When is a system "active" rather than merely evidenced? Newest archive
 * within 3x the observed cadence, floored at 24 h so an hourly system is not
 * declared dead over one quiet evening; 7 days when no cadence is derivable.
 * Chosen against the real fleet: a nightly external script whose last run
 * was this morning reads active, and a ServerUtilities timer that has not
 * produced an archive in three days (it skips empty servers) reads
 * "configured", which is exactly what an operator needs to know.
 */
export const ACTIVE_FACTOR = 3
export const ACTIVE_FLOOR_MS = 24 * 3600_000
export const ACTIVE_NO_CADENCE_MS = 7 * 24 * 3600_000

/** How many newest archives the cadence is derived from. */
const CADENCE_SAMPLE = 6

const ARCHIVE_EXT = /\.(zip|tar\.gz|tgz|tar|gz|7z)$/i
/** A directory used as an archive is dated: "2026-07-28-21-48-54", "backup_20260728". */
const DATED_DIR = /\d{4}/

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString()
}

/**
 * Stat the top level of one directory and describe the archives in it.
 * Returns null when the directory does not exist or holds nothing
 * archive-shaped; an absent directory and an empty one are the same
 * non-evidence.
 */
export async function readArchiveDir(dir: string): Promise<ArchiveStats | null> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  let count = 0
  let totalBytes = 0
  const mtimes: number[] = []
  for (const e of entries) {
    const archiveFile = e.isFile() && ARCHIVE_EXT.test(e.name)
    const archiveDir = e.isDirectory() && DATED_DIR.test(e.name)
    if (!archiveFile && !archiveDir) continue
    try {
      const st = await fs.stat(join(dir, e.name))
      count += 1
      if (archiveFile) totalBytes += st.size
      mtimes.push(st.mtimeMs)
    } catch {
      // An archive vanishing mid-read (a rotation deleting its oldest) is
      // normal, not an error.
    }
  }
  if (count === 0) return null
  mtimes.sort((a, b) => b - a)
  return {
    dir,
    count,
    totalBytes,
    newestAt: isoOrNull(mtimes[0] ?? null),
    oldestAt: isoOrNull(mtimes[mtimes.length - 1] ?? null),
    approxCadenceHours: cadenceHours(mtimes),
  }
}

/** Median gap between the newest few archives. Two points are not a cadence. */
function cadenceHours(mtimesDesc: number[]): number | null {
  const newest = mtimesDesc.slice(0, CADENCE_SAMPLE)
  if (newest.length < 3) return null
  const gaps: number[] = []
  for (let i = 0; i + 1 < newest.length; i++) gaps.push((newest[i] ?? 0) - (newest[i + 1] ?? 0))
  gaps.sort((a, b) => a - b)
  const mid = Math.floor(gaps.length / 2)
  const median = gaps.length % 2 ? (gaps[mid] ?? 0) : ((gaps[mid - 1] ?? 0) + (gaps[mid] ?? 0)) / 2
  return Math.round((median / 3600_000) * 100) / 100
}

/** The recency window the word "active" is allowed to claim. */
export function activeWindowMs(cadenceHours: number | null): number {
  if (cadenceHours === null) return ACTIVE_NO_CADENCE_MS
  return Math.max(cadenceHours * 3600_000 * ACTIVE_FACTOR, ACTIVE_FLOOR_MS)
}

function isRecent(stats: ArchiveStats, now: number): boolean {
  if (!stats.newestAt) return false
  return now - Date.parse(stats.newestAt) <= activeWindowMs(stats.approxCadenceHours)
}

function ageDays(iso: string, now: number): string {
  const days = (now - Date.parse(iso)) / 86_400_000
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} h`
  return `${Math.round(days * 10) / 10} days`
}

type SuConfig = {
  cfgPath: string
  enabled: boolean
  timerHours: number | null
  /** backup_folder_path, as written (usually './backups/'). */
  folderPath: string | null
}

/**
 * ServerUtilities / FTBUtilities configuration (decision 0001, signal 2).
 *
 * The file is Forge config format with typed keys, and the type prefix is
 * not stable: the GTNH install this was built against writes
 * `B:enable_backups=true` but `S:backup_timer=0.5` (a string, not a double),
 * so the parser accepts any single-letter prefix or none, and tolerates the
 * JSON-style variants newer forks use. A file this parser cannot read is no
 * signal, never a crash.
 */
export async function readServerUtilities(serverDir: string): Promise<SuConfig | null> {
  const candidates = [
    join(serverDir, 'serverutilities', 'serverutilities.cfg'),
    join(serverDir, 'config', 'serverutilities.cfg'),
    join(serverDir, 'config', 'ftbutilities.cfg'),
  ]
  for (const cfgPath of candidates) {
    let text: string
    try {
      text = await fs.readFile(cfgPath, 'utf8')
    } catch {
      continue
    }
    const enable = /^\s*(?:[A-Z]:)?["']?enable_backups["']?\s*[=:]\s*"?(true|false)"?\s*,?\s*$/im.exec(
      text,
    )
    if (!enable) continue
    const timer = /^\s*(?:[A-Z]:)?["']?backup_timer["']?\s*[=:]\s*"?([0-9]*\.?[0-9]+)"?\s*,?\s*$/im.exec(
      text,
    )
    const folder = /^\s*(?:[A-Z]:)?["']?backup_folder_path["']?\s*[=:]\s*"?([^"\r\n]+?)"?\s*,?\s*$/im.exec(
      text,
    )
    return {
      cfgPath,
      enabled: (enable[1] ?? '').toLowerCase() === 'true',
      timerHours: timer ? Number(timer[1]) : null,
      folderPath: folder?.[1] ? folder[1].trim() : null,
    }
  }
  return null
}

/** Names that identify a backup provider outright (decision 0001, signal 3). */
const KNOWN_PROVIDERS = ['aromabackup', 'serverutilities', 'ftbutilities', 'ftbbackups']

type JarMatch = { file: string; subdir: 'plugins' | 'mods'; known: boolean }

/**
 * Scan plugins/ and mods/ filenames. Names only, no jar is opened. A
 * `.jar.disabled` is skipped: a jar the loader will not load cannot be a
 * running backup system, and reporting it as one would be the exact claim
 * decision 0001 forbids.
 */
export async function scanBackupJars(serverDir: string): Promise<JarMatch[]> {
  const out: JarMatch[] = []
  for (const subdir of ['plugins', 'mods'] as const) {
    let entries: string[]
    try {
      entries = await fs.readdir(join(serverDir, subdir))
    } catch {
      continue
    }
    for (const name of entries) {
      if (!/\.jar$/i.test(name)) continue
      const lower = name.toLowerCase()
      const known = KNOWN_PROVIDERS.some((p) => lower.includes(p))
      if (known || lower.includes('backup')) out.push({ file: name, subdir, known })
    }
  }
  return out
}

/** Tail of a text file, decoded leniently. The log is read, never parsed as structure. */
async function tailOf(path: string, bytes = 65_536): Promise<string | null> {
  let fh
  try {
    fh = await fs.open(path, 'r')
    const st = await fh.stat()
    const start = Math.max(0, st.size - bytes)
    const buf = Buffer.alloc(Math.min(bytes, st.size))
    await fh.read(buf, 0, buf.length, start)
    return buf.toString('utf8')
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * The newest log line mentioning this server, from plain-text logs at the
 * external path's root or inside the per-server directory (decision 0001:
 * "if a plain-text log sits alongside, surface its last line for that
 * server"). Matching is a case-insensitive substring of the server name,
 * because the log belongs to someone else's script and owes us no format.
 */
async function lastLogLineFor(
  rootDir: string,
  serverSubdir: string | null,
  serverName: string,
): Promise<string | null> {
  // A log inside the per-server directory speaks only about that server, so
  // its last non-empty line is the answer. A log at the shared root speaks
  // about the whole rotation, so a line only counts if it names this server.
  const logs: Array<{ path: string; mustName: boolean }> = []
  for (const dir of [serverSubdir, rootDir]) {
    if (!dir) continue
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (/\.(log|txt)$/i.test(name)) logs.push({ path: join(dir, name), mustName: dir === rootDir })
    }
  }
  const needle = serverName.toLowerCase()
  for (const { path, mustName } of logs) {
    const tail = await tailOf(path)
    if (!tail) continue
    const lines = tail.split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = (lines[i] ?? '').trim()
      if (line && (!mustName || line.toLowerCase().includes(needle))) return line
    }
  }
  return null
}

function statusOf(
  stats: ArchiveStats | null,
  now: number,
): 'active' | 'stale' | null {
  if (!stats) return null
  return isRecent(stats, now) ? 'active' : 'stale'
}

/** "N archives, newest X old" for evidence sentences. */
function archiveClause(stats: ArchiveStats, now: number): string {
  const newest = stats.newestAt ? `newest ${ageDays(stats.newestAt, now)} old` : 'mtimes unreadable'
  return `${stats.count} archive${stats.count === 1 ? '' : 's'}, ${newest}`
}

/**
 * Run all four signals for one server and assemble the systems they
 * evidence.
 *
 * Attribution: an in-server system and the directory it writes to are ONE
 * system, not two, or GTNH out of the box would be warned about duplicate
 * backups it does not have. The archive directory is attributed to the
 * highest-priority in-server claimant (a ServerUtilities config that names
 * its folder, then a known provider jar, then a guessed jar); a directory
 * nothing claims is reported as its own anonymous system. External paths
 * are always their own system.
 */
export async function detectBackups(
  serverDir: string,
  serverName: string,
  externalBackupPaths: string[],
): Promise<Omit<BackupDetection, 'readAt' | 'readMs' | 'cached'>> {
  const now = Date.now()
  const systems: BackupSystem[] = []

  // Signal 2 first, because its backup_folder_path steers signal 1.
  const su = await readServerUtilities(serverDir)
  const suDir = su?.folderPath
    ? isAbsolute(su.folderPath)
      ? su.folderPath
      : resolve(serverDir, su.folderPath)
    : null

  // Signal 1: archive directories in the server root (plus the configured one).
  const dirNames = ARCHIVE_DIR_NAMES.map((n) => join(serverDir, n))
  if (suDir && !dirNames.some((d) => resolve(d) === resolve(suDir))) dirNames.unshift(suDir)
  const dirStats = new Map<string, ArchiveStats>()
  for (const dir of dirNames) {
    const stats = await readArchiveDir(dir)
    if (stats) dirStats.set(resolve(dir), stats)
  }
  const claimed = new Set<string>()

  /** The archive directory an in-server system most plausibly writes to. */
  const claimDir = (preferred: string | null): ArchiveStats | null => {
    const order = preferred
      ? [resolve(preferred), ...[...dirStats.keys()].filter((k) => k !== resolve(preferred))]
      : [...dirStats.keys()]
    for (const key of order) {
      if (claimed.has(key)) continue
      const stats = dirStats.get(key)
      if (stats) {
        claimed.add(key)
        return stats
      }
    }
    return null
  }

  if (su) {
    const stats = claimDir(suDir)
    const timer =
      su.timerHours !== null ? `a ${su.timerHours} h timer` : 'no readable timer'
    if (su.enabled) {
      const active = stats !== null && isRecent(stats, now)
      systems.push({
        name: 'ServerUtilities',
        signal: 'serverutilities',
        confidence: 'known',
        status: active ? 'active' : 'configured',
        writesTo: stats?.dir ?? suDir,
        evidence: stats
          ? `${basename(su.cfgPath)} sets enable_backups=true with ${timer}; ${archiveClause(stats, now)} in ${basename(stats.dir)}/.`
          : `${basename(su.cfgPath)} sets enable_backups=true with ${timer}, but no archives were found, so this is configured, not observed.`,
        archives: stats,
        configuredTimerHours: su.timerHours,
        lastLogLine: null,
      })
    } else if (stats) {
      systems.push({
        name: 'ServerUtilities',
        signal: 'serverutilities',
        confidence: 'known',
        status: 'stale',
        writesTo: stats.dir,
        evidence: `${basename(su.cfgPath)} sets enable_backups=false; ${archiveClause(stats, now)} remain in ${basename(stats.dir)}/ from earlier runs.`,
        archives: stats,
        configuredTimerHours: su.timerHours,
        lastLogLine: null,
      })
    }
    // enable_backups=false with no archives: nothing is running and nothing
    // ran; reporting it would be noise about a default.
  }

  // Signal 3: backup-named jars. A ServerUtilities/FTBUtilities jar is the
  // same system as the config parsed above, not a second one.
  const jars = await scanBackupJars(serverDir)
  for (const jar of jars) {
    const lower = jar.file.toLowerCase()
    if (su && (lower.includes('serverutilities') || lower.includes('ftbutilities'))) continue
    const stats = claimDir(null)
    const active = stats !== null && isRecent(stats, now)
    systems.push({
      name: jar.file.replace(/\.jar$/i, ''),
      signal: 'plugin-or-mod',
      confidence: jar.known ? 'known' : 'guess',
      status: active ? 'active' : stats ? 'stale' : 'configured',
      writesTo: stats?.dir ?? null,
      evidence: stats
        ? `${jar.subdir}/${jar.file} is installed${jar.known ? '' : ' (matched only by the word "backup" in its name, so this is a guess)'}; ${archiveClause(stats, now)} in ${basename(stats.dir)}/.`
        : `${jar.subdir}/${jar.file} is installed${jar.known ? '' : ' (matched only by the word "backup" in its name, so this is a guess)'}, but no archive directory could be attributed to it.`,
      archives: stats,
      configuredTimerHours: null,
      lastLogLine: null,
    })
  }

  // Signal 1 remainder: archive directories nothing claimed.
  for (const [key, stats] of dirStats) {
    if (claimed.has(key)) continue
    const status = statusOf(stats, now)
    if (!status) continue
    systems.push({
      name: `Archives in ${basename(stats.dir)}/`,
      signal: 'archive-dir',
      confidence: 'known',
      status,
      writesTo: stats.dir,
      evidence: `${archiveClause(stats, now)} in ${basename(stats.dir)}/; nothing inside the server names the system that writes them.`,
      archives: stats,
      configuredTimerHours: null,
      lastLogLine: null,
    })
  }

  // Signal 4: the operator-configured external paths. The only signal that
  // can see an external script, which leaves no trace inside the server
  // directory at all.
  for (const path of externalBackupPaths) {
    let entries
    try {
      entries = await fs.readdir(path, { withFileTypes: true })
    } catch {
      continue
    }
    const sub = entries.find(
      (e) => e.isDirectory() && e.name.toLowerCase() === serverName.toLowerCase(),
    )
    if (!sub) continue
    const subPath = join(path, sub.name)
    const stats = await readArchiveDir(subPath)
    const status = statusOf(stats, now)
    if (!status) continue
    systems.push({
      name: `External backups at ${path}`,
      signal: 'external-path',
      confidence: 'known',
      status,
      writesTo: subPath,
      evidence: `${archiveClause(stats!, now)} in the ${sub.name}/ directory of the configured external path.`,
      archives: stats,
      configuredTimerHours: null,
      lastLogLine: await lastLogLineFor(path, subPath, serverName),
    })
  }

  return {
    systems,
    activeCount: systems.filter((s) => s.status === 'active').length,
    externalPathsConfigured: externalBackupPaths.length > 0,
  }
}

/**
 * Cache, same convention as worlds.ts: revisiting the page shows the reading
 * it already has, stamped with when it was taken, instead of silently doing
 * the work again and implying the number is live. `maxAgeMs = 0` is the
 * refresh control forcing a fresh read.
 */
export const DETECT_CACHE_MS = 60_000

const cache = new Map<string, { at: number; readMs: number; body: Omit<BackupDetection, 'readAt' | 'readMs' | 'cached'> }>()

/** Test seam: the cache is process-wide, so proofs must be able to clear it. */
export function resetDetectionCache(): void {
  cache.clear()
}

export async function readBackupDetection(
  serverDir: string,
  serverName: string,
  externalBackupPaths: string[],
  maxAgeMs = DETECT_CACHE_MS,
): Promise<BackupDetection> {
  const key = serverDir.toLowerCase()
  const hit = cache.get(key)
  if (hit && maxAgeMs > 0 && Date.now() - hit.at <= maxAgeMs) {
    return { readAt: new Date(hit.at).toISOString(), readMs: hit.readMs, cached: true, ...hit.body }
  }
  const started = Date.now()
  const body = await detectBackups(serverDir, serverName, externalBackupPaths)
  const readMs = Date.now() - started
  cache.set(key, { at: started, readMs, body })
  return { readAt: new Date(started).toISOString(), readMs, cached: false, ...body }
}
