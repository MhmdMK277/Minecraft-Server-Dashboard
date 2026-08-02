/**
 * Decision 0005: the dashboard's own cold backup. Data-loss category, so
 * every constraint in the decision record is pinned here, both directions:
 *
 *  - the things it must REFUSE (an active backup system, a running or
 *    uncertain server, a destination inside the world, any overwrite,
 *    a tampered archive), because each of those is a way to lose data
 *    while reporting success;
 *  - the things it must DO faithfully (hidden files in the archive, the
 *    sha256 the manifest promises, a restore that lands beside the world
 *    and touches nothing else), because a backup that quietly drops files
 *    is worse than no backup: it cancels the operator's plan B.
 *
 * Occupancy is injected through the module's test seam, so no real JVM and
 * no process enumeration is involved; everything runs in throwaway
 * directories under %TEMP% and nothing is ever deleted.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  utimesSync,
  existsSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { runColdBackup, restoreColdBackup, listColdBackups, MANIFEST_FILE, tarBin } from '../server/coldbackup'
import type { Occupancy } from '../server/control'

const checks: Array<[string, boolean, string?]> = []
const check = (label: string, ok: boolean, detail?: string) => checks.push([label, ok, detail])

const IDLE: Occupancy = { pids: [], certain: true, doubt: null }
const RUNNING: Occupancy = { pids: [4242], certain: true, doubt: null }
const UNSURE: Occupancy = {
  pids: [],
  certain: false,
  doubt: 'process enumeration failed (proof-injected)',
}
const occ = (o: Occupancy) => ({ occupancy: async () => o })
const at = (iso: string) => ({ now: () => new Date(iso) })

function mk(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A little world: nested dirs, a hidden file, real bytes. */
function plantWorld(dir: string): void {
  mkdirSync(join(dir, 'world', 'region'), { recursive: true })
  writeFileSync(join(dir, 'server.properties'), 'level-name=world\n')
  writeFileSync(join(dir, 'world', 'level.dat'), 'LEVELDATA-' + 'x'.repeat(500))
  writeFileSync(join(dir, 'world', 'region', 'r.0.0.mca'), 'REGION-' + 'y'.repeat(2000))
  writeFileSync(join(dir, 'world', 'session.lock'), 'lock')
  writeFileSync(join(dir, '.hidden-canary'), 'hidden-bytes-must-survive')
  execFileSync('attrib', ['+h', join(dir, '.hidden-canary')])
}

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

async function main() {
  console.log('prove-cold-backup: decision 0005, refusals and fidelity\n')

  const DATA = mk('mcdash-cold-data-')
  const DEST = mk('mcdash-cold-dest-')

  // ------------------------------------------------ §1 the detection gate
  {
    const dir = mk('mcdash-cold-busy-')
    plantWorld(dir)
    const bk = join(dir, 'backups')
    mkdirSync(bk)
    for (let i = 1; i <= 3; i++) {
      writeFileSync(join(bk, `${i}.zip`), 'z')
      const t = new Date(Date.now() - i * 3600_000)
      utimesSync(join(bk, `${i}.zip`), t, t)
    }
    const r = await runColdBackup(
      { serverDir: dir, serverName: 'Busy', destDir: DEST, dataDir: DATA, actor: 'proof', externalBackupPaths: [] },
      occ(IDLE),
    )
    check('§1 an active backup system refuses the offer', !r.ok)
    check(
      '§1 the refusal names the system and cites the decision',
      !r.ok && r.reason.includes('already active') && r.reason.includes('0005'),
      !r.ok ? r.reason : 'succeeded',
    )
    check('§1 nothing was written for the refused server', readdirSync(DEST).every((f) => !f.startsWith('Busy')))
  }
  {
    const dir = mk('mcdash-cold-conf-')
    plantWorld(dir)
    mkdirSync(join(dir, 'serverutilities'))
    writeFileSync(join(dir, 'serverutilities', 'serverutilities.cfg'), 'B:enable_backups=true\n')
    const r = await runColdBackup(
      { serverDir: dir, serverName: 'ConfOnly', destDir: DEST, dataDir: DATA, actor: 'proof', externalBackupPaths: [] },
      occ(IDLE),
    )
    check('§1 a configured-but-never-observed system does not block the offer', r.ok, !r.ok ? r.reason : undefined)
  }

  // ------------------------------------------------------- §2 cold only
  {
    const dir = mk('mcdash-cold-run-')
    plantWorld(dir)
    const r1 = await runColdBackup(
      { serverDir: dir, serverName: 'Live', destDir: DEST, dataDir: DATA, actor: 'proof', externalBackupPaths: [] },
      occ(RUNNING),
    )
    check('§2 a running server is refused', !r1.ok)
    check('§2 the refusal names the pid', !r1.ok && r1.reason.includes('4242'))
    const r2 = await runColdBackup(
      { serverDir: dir, serverName: 'Live', destDir: DEST, dataDir: DATA, actor: 'proof', externalBackupPaths: [] },
      occ(UNSURE),
    )
    check('§2 an uncertain reading is refused, doubt counts as running', !r2.ok && r2.reason.includes('doubt counts as running'))
    check('§2 nothing was written in either case', readdirSync(DEST).every((f) => !f.startsWith('Live')))
  }

  // ------------------------------------------------------- §3 the write
  // The world lives one level inside its own temp parent, so the restore
  // sibling lands in THIS run's folder: earlier runs are never deleted
  // (nothing is), and a fixed clock would collide with them in shared %TEMP%.
  const world = join(mk('mcdash-cold-parent-'), 'World')
  mkdirSync(world)
  plantWorld(world)
  let firstArchive = ''
  let manifestAfterFirst = ''
  {
    const r = await runColdBackup(
      { serverDir: world, serverName: 'World', destDir: DEST, dataDir: DATA, actor: 'proof', externalBackupPaths: [] },
      { ...occ(IDLE), ...at('2026-08-02T10:30:00') },
    )
    check('§3 an idle undetected server backs up', r.ok, !r.ok ? r.reason : undefined)
    if (r.ok) {
      firstArchive = r.entry.archivePath
      check('§3 the archive lands at the destination, named for server and moment', existsSync(firstArchive) && basename(firstArchive).startsWith('World 2026-08-02'))
      check('§3 the manifest sha256 is the sha256 of the bytes on disk', r.entry.sha256 === sha(firstArchive))
      check('§3 the manifest bytes are the file size', r.entry.bytes === statSync(firstArchive).size)

      const out = mk('mcdash-cold-verify-')
      execFileSync(tarBin(), ['-x', '-f', firstArchive, '-C', out])
      // The zip's single top-level folder is the directory's real name (in
      // production that IS the server name; here the temp dir differs).
      const inner = join(out, basename(world))
      check(
        '§3 the archive round-trips the nested region file byte for byte',
        readFileSync(join(inner, 'world', 'region', 'r.0.0.mca'), 'utf8') === readFileSync(join(world, 'world', 'region', 'r.0.0.mca'), 'utf8'),
      )
      check(
        '§3 a HIDDEN file survives the archive, the silent-loss case',
        existsSync(join(inner, '.hidden-canary')) &&
          readFileSync(join(inner, '.hidden-canary'), 'utf8') === 'hidden-bytes-must-survive',
      )
      manifestAfterFirst = readFileSync(join(DATA, MANIFEST_FILE), 'utf8')
    }
  }
  {
    const r = await runColdBackup(
      { serverDir: world, serverName: 'World', destDir: DEST, dataDir: DATA, actor: 'proof', externalBackupPaths: [] },
      { ...occ(IDLE), ...at('2026-08-02T10:30:00') },
    )
    check('§3 the same name is never overwritten', !r.ok && r.reason.includes('ever overwritten'))
    check('§3 the first archive is intact after the refusal', firstArchive !== '' && sha(firstArchive) === (await listColdBackups(DATA, world))[0]?.sha256)
  }
  {
    const rIn = await runColdBackup(
      { serverDir: world, serverName: 'World', destDir: join(world, 'backups'), dataDir: DATA, actor: 'proof', externalBackupPaths: [] },
      occ(IDLE),
    )
    check('§3 a destination inside the server directory is refused', !rIn.ok && rIn.reason.includes('outside'))
    const rOver = await runColdBackup(
      { serverDir: world, serverName: 'World', destDir: join(world, '..'), dataDir: DATA, actor: 'proof', externalBackupPaths: [] },
      occ(IDLE),
    )
    check('§3 a destination containing the server directory is refused', !rOver.ok)
  }
  {
    const r = await runColdBackup(
      { serverDir: world, serverName: 'World', destDir: DEST, dataDir: DATA, actor: 'proof', externalBackupPaths: [] },
      { ...occ(IDLE), ...at('2026-08-02T11:00:00') },
    )
    check('§3 a second backup a moment later is a second archive', r.ok)
    const entries = await listColdBackups(DATA, world)
    check('§3 the manifest holds both, append-only', entries.length === 2)
    const raw = readFileSync(join(DATA, MANIFEST_FILE), 'utf8')
    check(
      '§3 the manifest is append-only: everything before the write is byte-identical after it',
      manifestAfterFirst.length > 0 && raw.startsWith(manifestAfterFirst),
    )
  }

  // --------------------------------------------------------- §4 restore
  {
    const entries = await listColdBackups(DATA, world)
    const entry = entries[0]!
    const before = sha(join(world, 'world', 'level.dat'))

    const rBusy = await restoreColdBackup({ archiveId: entry.id, dataDir: DATA }, occ(RUNNING))
    check('§4 restore refuses a running server', !rBusy.ok && rBusy.reason.includes('Nothing was restored'))

    const r = await restoreColdBackup({ archiveId: entry.id, dataDir: DATA }, { ...occ(IDLE), ...at('2026-08-02T12:00:00') })
    check('§4 restore succeeds into a NEW sibling folder', r.ok, !r.ok ? r.reason : undefined)
    if (r.ok) {
      check('§4 the folder says it is a restore and of what', basename(r.restoredDir).startsWith('World restored 2026-08-02'))
      check('§4 the restored region file matches the original byte for byte', readFileSync(join(r.restoredDir, 'world', 'region', 'r.0.0.mca'), 'utf8') === readFileSync(join(world, 'world', 'region', 'r.0.0.mca'), 'utf8'))
      check('§4 the hidden file came back too', existsSync(join(r.restoredDir, '.hidden-canary')))
      check('§4 the original directory was not touched', sha(join(world, 'world', 'level.dat')) === before)

      const rAgain = await restoreColdBackup({ archiveId: entry.id, dataDir: DATA }, { ...occ(IDLE), ...at('2026-08-02T12:00:00') })
      check('§4 the same restore name is refused, never extracted over', !rAgain.ok && rAgain.reason.includes('never extracts over'))
    }

    const rNone = await restoreColdBackup({ archiveId: 'cb-not-real', dataDir: DATA }, occ(IDLE))
    check('§4 an id the manifest never journaled is refused', !rNone.ok && rNone.reason.includes('manifest'))

    // A journaled archive whose file is gone (drive unplugged): refused, said plainly.
    appendFileSync(
      join(DATA, MANIFEST_FILE),
      JSON.stringify({ ...entry, id: 'cb-ghost', archivePath: join(DEST, 'not-there.zip') }) + '\n',
    )
    const rGhost = await restoreColdBackup({ archiveId: 'cb-ghost', dataDir: DATA }, occ(IDLE))
    check('§4 a missing archive file is refused with its path', !rGhost.ok && rGhost.reason.includes('not-there.zip'))

    // Tampering: the archive on disk stops matching the journaled sha256.
    const tampered = join(DEST, 'tampered.zip')
    writeFileSync(tampered, readFileSync(entry.archivePath))
    appendFileSync(tampered, Buffer.from([0x00]))
    appendFileSync(
      join(DATA, MANIFEST_FILE),
      JSON.stringify({ ...entry, id: 'cb-tamper', archivePath: tampered }) + '\n',
    )
    const rTamper = await restoreColdBackup({ archiveId: 'cb-tamper', dataDir: DATA }, { ...occ(IDLE), ...at('2026-08-02T13:00:00') })
    check('§4 bytes that do not match the journaled sha256 are refused', !rTamper.ok && rTamper.reason.includes('sha256'))
    check('§4 the tamper refusal created no folder', !existsSync(join(world, '..', 'World restored 2026-08-02 1300')))
  }

  // ------------------------------------------------- §5 manifest honesty
  {
    appendFileSync(join(DATA, MANIFEST_FILE), 'this line is not JSON {{{ \n')
    const entries = await listColdBackups(DATA, world)
    check('§5 a corrupt manifest line is skipped, the rest still listed', entries.length >= 2)
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
