/**
 * Backup detection: decision 0001's four read-only signals.
 *
 * Why this has a proof at all: the word "active" on the Backups page is a
 * statement that this server's worlds are being copied somewhere. A false
 * "active" tells an operator they are safe when they are not, which is the
 * false-healthy failure class, and decision 0005 gates the dashboard's own
 * cold-backup offer on this module reading "nothing found". Both directions
 * of error do harm, so both are pinned here.
 *
 * Everything runs in throwaway directories under %TEMP%; mtimes are set with
 * utimesSync so every recency threshold is exercised deliberately, not by
 * the clock of whichever machine runs this.
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectBackups,
  readArchiveDir,
  readBackupDetection,
  resetDetectionCache,
  activeWindowMs,
  ACTIVE_FLOOR_MS,
  ACTIVE_NO_CADENCE_MS,
} from '../server/backupdetect'

const checks: Array<[string, boolean, string?]> = []
const check = (label: string, ok: boolean, detail?: string) => checks.push([label, ok, detail])

const HOUR = 3600_000
const DAY = 24 * HOUR
const now = Date.now()

function mkServer(): string {
  return mkdtempSync(join(tmpdir(), 'mcdash-detect-'))
}

/** A file whose mtime is `ageMs` ago, with real bytes so sizes are testable. */
function plant(path: string, ageMs: number, bytes = 1000): void {
  writeFileSync(path, 'x'.repeat(bytes))
  const t = new Date(now - ageMs)
  utimesSync(path, t, t)
}

function plantDir(path: string, ageMs: number): void {
  mkdirSync(path, { recursive: true })
  const t = new Date(now - ageMs)
  utimesSync(path, t, t)
}

async function main() {
  console.log('prove-backup-detect: decision 0001 signals, thresholds, attribution\n')

  // ---------------------------------------------------------------- §1 nothing
  {
    const dir = mkServer()
    const r = await detectBackups(dir, 'Empty', [])
    check('§1 an empty server detects no systems', r.systems.length === 0)
    check('§1 activeCount is zero', r.activeCount === 0)
    check('§1 no external path configured is reported as such', !r.externalPathsConfigured)
  }

  // ------------------------------------------------- §2 signal 1: archive dirs
  {
    const dir = mkServer()
    const bk = join(dir, 'backups')
    mkdirSync(bk)
    for (let i = 1; i <= 4; i++) plant(join(bk, `w-${i}.zip`), i * HOUR)
    const r = await detectBackups(dir, 'S', [])
    const sys = r.systems[0]
    check('§2 recent archives make one system', r.systems.length === 1)
    check('§2 the signal is archive-dir', sys?.signal === 'archive-dir')
    check('§2 hourly zips one hour old read active', sys?.status === 'active')
    check('§2 count is the top-level archive count', sys?.archives?.count === 4)
    check(
      '§2 cadence is roughly the hour the mtimes describe',
      sys?.archives?.approxCadenceHours != null &&
        Math.abs(sys.archives.approxCadenceHours - 1) < 0.1,
      `got ${sys?.archives?.approxCadenceHours}`,
    )
    check(
      '§2 evidence names the directory that was read',
      (sys?.evidence ?? '').includes('backups/'),
    )
  }
  {
    const dir = mkServer()
    const bk = join(dir, 'backups')
    mkdirSync(bk)
    plant(join(bk, 'one.zip'), 2 * HOUR, 1000)
    plantDir(join(bk, '2026-01-01-02-03-04'), 20 * DAY)
    plant(join(bk, '2026-01-01-02-03-04', 'huge.dat'), 20 * DAY, 5000)
    plantDir(join(bk, 'stuff'), HOUR)
    plant(join(bk, 'stuff', 'notes.dat'), HOUR, 7000)
    plant(join(bk, 'readme.txt'), HOUR, 3000)
    const stats = await readArchiveDir(bk)
    check('§2 a dated directory counts as one archive', stats?.count === 2)
    check(
      '§2 totalBytes sums top-level files only, never a walk',
      stats?.totalBytes === 1000,
      `got ${stats?.totalBytes}`,
    )
    check(
      '§2 an undated directory and a txt file are not archives',
      stats?.count === 2 && !(stats?.totalBytes === 1000 + 3000),
    )
  }
  {
    const dir = mkServer()
    mkdirSync(join(dir, 'backups'))
    const r = await detectBackups(dir, 'S', [])
    check('§2 an empty backups directory is not evidence of a system', r.systems.length === 0)
  }
  {
    const dir = mkServer()
    const bk = join(dir, 'world_backups')
    mkdirSync(bk)
    for (let i = 0; i < 3; i++) plant(join(bk, `a${i}.tar.gz`), 10 * DAY + i * DAY)
    const r = await detectBackups(dir, 'S', [])
    check('§2 the world_backups variant is found', r.systems.length === 1)
    check('§2 ten-day-old daily archives read stale, not active', r.systems[0]?.status === 'stale')
    check('§2 a stale system is not in activeCount', r.activeCount === 0)
  }

  // -------------------------------------------- §3 signal 2: ServerUtilities
  const GTNH_CFG = `
backups {
    # Path to backups folder. [default: ./backups/]
    S:backup_folder_path=./backups/

    # Time between backups in hours.
    S:backup_timer=0.5

    B:enable_backups=true
}
`
  {
    const dir = mkServer()
    mkdirSync(join(dir, 'serverutilities'))
    writeFileSync(join(dir, 'serverutilities', 'serverutilities.cfg'), GTNH_CFG)
    const bk = join(dir, 'backups')
    mkdirSync(bk)
    for (let i = 1; i <= 4; i++) plant(join(bk, `${i}.zip`), i * HOUR)
    const r = await detectBackups(dir, 'S', [])
    check('§3 the real GTNH config shape parses', r.systems.length === 1)
    check('§3 an enabled config with recent archives is ONE system, not two', r.systems.length === 1)
    check('§3 that system is serverutilities and active', r.systems[0]?.signal === 'serverutilities' && r.systems[0]?.status === 'active')
    check(
      '§3 the string-typed S:backup_timer parses as 0.5 hours',
      r.systems[0]?.configuredTimerHours === 0.5,
    )
    check(
      '§3 the archive directory is attributed, not double-reported',
      !r.systems.some((s) => s.signal === 'archive-dir'),
    )
  }
  {
    const dir = mkServer()
    mkdirSync(join(dir, 'serverutilities'))
    writeFileSync(join(dir, 'serverutilities', 'serverutilities.cfg'), GTNH_CFG)
    const r = await detectBackups(dir, 'S', [])
    check('§3 enabled with no archives reads configured, never active', r.systems[0]?.status === 'configured')
    check(
      '§3 its evidence says configured, not observed',
      (r.systems[0]?.evidence ?? '').includes('configured, not observed'),
    )
    check('§3 configured is not in activeCount', r.activeCount === 0)
  }
  {
    const dir = mkServer()
    mkdirSync(join(dir, 'serverutilities'))
    writeFileSync(join(dir, 'serverutilities', 'serverutilities.cfg'), GTNH_CFG)
    const bk = join(dir, 'backups')
    mkdirSync(bk)
    for (let i = 0; i < 3; i++) plant(join(bk, `${i}.zip`), 5 * DAY + i * DAY)
    const r = await detectBackups(dir, 'S', [])
    check(
      '§3 enabled but newest archive outside the window reads configured with the archives shown',
      r.systems[0]?.status === 'configured' && r.systems[0]?.archives?.count === 3,
    )
  }
  {
    const dir = mkServer()
    mkdirSync(join(dir, 'serverutilities'))
    writeFileSync(
      join(dir, 'serverutilities', 'serverutilities.cfg'),
      GTNH_CFG.replace('B:enable_backups=true', 'B:enable_backups=false'),
    )
    const bk = join(dir, 'backups')
    mkdirSync(bk)
    plant(join(bk, 'old.zip'), 30 * DAY)
    const r = await detectBackups(dir, 'S', [])
    check('§3 disabled with leftover archives reads stale', r.systems[0]?.status === 'stale')
    const dir2 = mkServer()
    mkdirSync(join(dir2, 'serverutilities'))
    writeFileSync(
      join(dir2, 'serverutilities', 'serverutilities.cfg'),
      GTNH_CFG.replace('B:enable_backups=true', 'B:enable_backups=false'),
    )
    const r2 = await detectBackups(dir2, 'S', [])
    check('§3 disabled with no archives reports nothing', r2.systems.length === 0)
  }
  {
    const dir = mkServer()
    mkdirSync(join(dir, 'serverutilities'))
    writeFileSync(
      join(dir, 'serverutilities', 'serverutilities.cfg'),
      GTNH_CFG.replace('S:backup_folder_path=./backups/', 'S:backup_folder_path=./mybk/'),
    )
    const bk = join(dir, 'mybk')
    mkdirSync(bk)
    plant(join(bk, 'a.zip'), HOUR)
    const r = await detectBackups(dir, 'S', [])
    check(
      '§3 a custom backup_folder_path is read and attributed',
      r.systems[0]?.status === 'active' && (r.systems[0]?.writesTo ?? '').endsWith('mybk'),
      r.systems[0]?.writesTo ?? 'none',
    )
  }
  {
    const dir = mkServer()
    mkdirSync(join(dir, 'config'))
    writeFileSync(join(dir, 'config', 'serverutilities.cfg'), GTNH_CFG)
    const r = await detectBackups(dir, 'S', [])
    check('§3 the older config/serverutilities.cfg layout is found', r.systems.length === 1)
  }
  {
    const dir = mkServer()
    mkdirSync(join(dir, 'serverutilities'))
    writeFileSync(
      join(dir, 'serverutilities', 'serverutilities.cfg'),
      '{\n  "enable_backups": true,\n  "backup_timer": 6.0,\n}\n',
    )
    const r = await detectBackups(dir, 'S', [])
    check(
      '§3 a JSON-style config variant parses too',
      r.systems[0]?.signal === 'serverutilities' && r.systems[0]?.configuredTimerHours === 6,
    )
  }
  {
    const dir = mkServer()
    mkdirSync(join(dir, 'serverutilities'))
    writeFileSync(join(dir, 'serverutilities', 'serverutilities.cfg'), Buffer.from([0, 159, 146, 150]))
    const r = await detectBackups(dir, 'S', [])
    check('§3 an unreadable config is no signal, never a crash', r.systems.length === 0)
  }

  // ------------------------------------------------------ §4 signal 3: jars
  {
    const dir = mkServer()
    mkdirSync(join(dir, 'mods'))
    writeFileSync(join(dir, 'mods', 'AromaBackup-1.7.10-0.1.0.0.jar'), '')
    const r = await detectBackups(dir, 'S', [])
    check('§4 AromaBackup is recognized by name', r.systems.length === 1)
    check('§4 a recognized provider is confidence known', r.systems[0]?.confidence === 'known')
    check('§4 a jar alone reads configured, never active', r.systems[0]?.status === 'configured')
  }
  {
    const dir = mkServer()
    mkdirSync(join(dir, 'plugins'))
    writeFileSync(join(dir, 'plugins', 'SuperWorldBackupThing.jar'), '')
    writeFileSync(join(dir, 'plugins', 'Essentials.jar'), '')
    writeFileSync(join(dir, 'plugins', 'AutoBackupPro.jar.disabled'), '')
    const r = await detectBackups(dir, 'S', [])
    check('§4 a filename merely containing backup is reported', r.systems.length === 1)
    check('§4 and labelled a guess on the wire', r.systems[0]?.confidence === 'guess')
    check('§4 its evidence says it is a guess', (r.systems[0]?.evidence ?? '').includes('guess'))
    check(
      '§4 a .jar.disabled is not a running system and is skipped',
      !r.systems.some((s) => s.name.includes('AutoBackupPro')),
    )
  }
  {
    const dir = mkServer()
    mkdirSync(join(dir, 'serverutilities'))
    writeFileSync(join(dir, 'serverutilities', 'serverutilities.cfg'), GTNH_CFG)
    mkdirSync(join(dir, 'mods'))
    writeFileSync(join(dir, 'mods', 'serverutilities-1.7.10-2.0.jar'), '')
    const r = await detectBackups(dir, 'S', [])
    check(
      '§4 a ServerUtilities jar plus its config is one system, not two',
      r.systems.filter((s) => s.name.toLowerCase().includes('serverutilities') || s.signal === 'serverutilities').length === 1,
    )
  }

  // -------------------------------------------- §5 signal 4: external paths
  {
    const ext = mkdtempSync(join(tmpdir(), 'mcdash-detect-ext-'))
    const sub = join(ext, 'My Server')
    mkdirSync(sub)
    for (let i = 1; i <= 3; i++) plant(join(sub, `My Server_2026-0${i}.zip`), i * DAY)
    writeFileSync(
      join(ext, 'backup.log'),
      [
        '2026-08-01 05:00:01 | My Server  | BACKED UP | 10 files',
        '2026-08-01 05:01:00 | Other One  | BACKED UP | 99 files',
        '',
      ].join('\n'),
    )
    const dir = mkServer()
    const r = await detectBackups(dir, 'my server', [ext])
    const sys = r.systems[0]
    check('§5 a per-server subdirectory is matched case-insensitively', r.systems.length === 1)
    check('§5 the external system is active on recent daily archives', sys?.status === 'active')
    check('§5 writesTo is the per-server subdirectory', (sys?.writesTo ?? '').endsWith('My Server'))
    check(
      '§5 the root log line surfaced is the one naming THIS server',
      (sys?.lastLogLine ?? '').includes('My Server') && !(sys?.lastLogLine ?? '').includes('Other One'),
      sys?.lastLogLine ?? 'none',
    )
    check('§5 externalPathsConfigured is true', r.externalPathsConfigured)

    const r2 = await detectBackups(dir, 'Unknown Server', [ext])
    check('§5 a path with no subdirectory for this server is no system', r2.systems.length === 0)
    check('§5 but the configured flag still says the path was looked at', r2.externalPathsConfigured)

    const r3 = await detectBackups(dir, 'my server', [join(ext, 'does-not-exist')])
    check('§5 a missing external path is tolerated, not thrown', r3.systems.length === 0)
  }
  {
    // A log INSIDE the per-server directory speaks only about that server, so
    // its last line counts without naming it.
    const ext = mkdtempSync(join(tmpdir(), 'mcdash-detect-ext-'))
    const sub = join(ext, 'srv')
    mkdirSync(sub)
    plant(join(sub, 'a.zip'), HOUR)
    writeFileSync(join(sub, 'runs.log'), 'run finished, 42 files\n')
    const dir = mkServer()
    const r = await detectBackups(dir, 'srv', [ext])
    check(
      '§5 a per-server log needs no name match for its last line',
      r.systems[0]?.lastLogLine === 'run finished, 42 files',
      r.systems[0]?.lastLogLine ?? 'none',
    )
  }

  // ----------------------------------- §6 thresholds and the duplicate case
  {
    check(
      '§6 hourly cadence is floored at 24 h, one quiet evening is not death',
      activeWindowMs(1) === ACTIVE_FLOOR_MS,
    )
    check('§6 daily cadence widens to three days', activeWindowMs(24) === 72 * HOUR)
    check('§6 no cadence falls back to seven days', activeWindowMs(null) === ACTIVE_NO_CADENCE_MS)
  }
  {
    const dir = mkServer()
    mkdirSync(join(dir, 'serverutilities'))
    writeFileSync(join(dir, 'serverutilities', 'serverutilities.cfg'), GTNH_CFG)
    const bk = join(dir, 'backups')
    mkdirSync(bk)
    for (let i = 1; i <= 3; i++) plant(join(bk, `${i}.zip`), i * HOUR)
    const ext = mkdtempSync(join(tmpdir(), 'mcdash-detect-ext-'))
    const sub = join(ext, 'Dup')
    mkdirSync(sub)
    for (let i = 1; i <= 3; i++) plant(join(sub, `${i}.zip`), i * DAY)
    const r = await detectBackups(dir, 'Dup', [ext])
    check(
      '§6 two systems both running is activeCount 2, the duplicate-work case',
      r.activeCount === 2,
      `got ${r.activeCount}`,
    )
    check(
      '§6 both duplicates name where they write',
      r.systems.filter((s) => s.status === 'active').every((s) => !!s.writesTo),
    )
  }

  // ----------------------------------------------------------- §7 the cache
  {
    const dir = mkServer()
    const bk = join(dir, 'backups')
    mkdirSync(bk)
    plant(join(bk, 'a.zip'), HOUR)
    resetDetectionCache()
    const first = await readBackupDetection(dir, 'S', [])
    const second = await readBackupDetection(dir, 'S', [])
    check('§7 the first reading is fresh', !first.cached)
    check('§7 the second reading says it is the cached one', second.cached)
    check('§7 the cached reading keeps the original timestamp', second.readAt === first.readAt)
    const forced = await readBackupDetection(dir, 'S', [], 0)
    check('§7 maxAgeMs 0 forces a fresh read', !forced.cached)
  }

  // ------------------------------------------------------------------- tail
  console.log('')
  let failed = 0
  for (const [label, ok, detail] of checks) {
    if (!ok) failed++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`)
  }
  console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
