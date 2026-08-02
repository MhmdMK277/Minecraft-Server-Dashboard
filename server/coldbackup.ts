import { createHash } from 'node:crypto'
import { createReadStream, existsSync, promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { ColdBackupEntry } from '@shared/api'
import { occupancyOf, type Occupancy } from './control'
import { detectBackups } from './backupdetect'

const execFileP = promisify(execFile)

/**
 * Decision 0005: the dashboard's own backup, narrow, manual, cold.
 *
 * Decision 0001 (the dashboard does not own backups) stands wherever a
 * backup system exists. This module is the one deliberate exception, for the
 * operator who has NOTHING, and every constraint from the decision record is
 * enforced here rather than in the UI, so the page can only offer what the
 * code refuses to exceed:
 *
 *  - offered only where detection found no active system; the gate runs a
 *    FRESH detection at request time, not whatever the page happened to show;
 *  - manual only, no scheduler in this codebase, ever;
 *  - cold only: occupancy zero and CERTAIN, the same probe the start guard
 *    uses; doubt counts as running, and a running server is refused out loud;
 *  - the archive is written OUTSIDE the server directory to an
 *    operator-named destination, sha256 recorded at write in a manifest this
 *    module owns, append-only, no rotation;
 *  - restore never extracts over anything: hash verified against the
 *    manifest, target server refused if occupied, the world lands in a NEW
 *    sibling folder and the swap is the operator's.
 *
 * The zip is produced by Windows' bundled bsdtar (tar.exe, present since
 * Windows 10 1803), chosen over Compress-Archive deliberately: bsdtar
 * includes hidden files, streams instead of buffering the world in memory,
 * and its --strip-components makes restore-to-a-new-name exact. A backup
 * tool that silently skips hidden files is a data-loss bug wearing a
 * success message; prove-cold-backup round-trips a hidden file to pin this.
 *
 * Every refusal is a full sentence, because the sentence is the product.
 */

export const MANIFEST_FILE = 'coldbackup-manifest.jsonl'

/**
 * Windows' own bsdtar, by absolute path. `execFile('tar', ...)` resolves
 * through PATH, and in a Git Bash or MSYS environment that finds GNU tar,
 * which reads `C:\...` as a REMOTE HOST named C ("Cannot connect to C:
 * resolve failed", measured here). The bundled System32 bsdtar understands
 * drive letters, hidden files and zip output; PATH resolution is only the
 * fallback for environments without it.
 */
export function tarBin(): string {
  if (process.platform === 'win32') {
    const sys = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    if (existsSync(sys)) return sys
  }
  return 'tar'
}

export type ColdRefusal = { ok: false; reason: string }
export type ColdBackupResult = { ok: true; entry: ColdBackupEntry } | ColdRefusal
export type RestoreResult = { ok: true; restoredDir: string } | ColdRefusal

/**
 * Test seams. The proofs must exercise "a JVM owns this directory" and "the
 * process table is unreadable" without a real JVM, and a fixed clock forces
 * the name-collision refusals deterministically. Routes pass nothing.
 */
export type ColdDeps = {
  occupancy?: (dir: string) => Promise<Occupancy>
  now?: () => Date
}

function stamp(d: Date, withSeconds: boolean): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`
  return withSeconds ? `${base}${p(d.getSeconds())}` : base
}

function within(child: string, parent: string): boolean {
  const c = resolve(child).toLowerCase()
  const p = resolve(parent).toLowerCase()
  return c === p || c.startsWith(p + sep)
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((res, rej) => {
    createReadStream(path).on('data', (c) => hash.update(c)).on('end', res).on('error', rej)
  })
  return hash.digest('hex')
}

function manifestPath(dataDir: string): string {
  return join(dataDir, MANIFEST_FILE)
}

/**
 * Read the manifest. A corrupt line is skipped, not fatal: the manifest is
 * append-only JSONL and one torn write must not hide every archive ever
 * taken. Nothing here ever rewrites the file.
 */
export async function listColdBackups(dataDir: string, serverDir?: string): Promise<ColdBackupEntry[]> {
  let text: string
  try {
    text = await fs.readFile(manifestPath(dataDir), 'utf8')
  } catch {
    return []
  }
  const out: ColdBackupEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as ColdBackupEntry
      if (typeof e.id === 'string' && typeof e.archivePath === 'string' && typeof e.sha256 === 'string') {
        if (!serverDir || resolve(e.serverDir).toLowerCase() === resolve(serverDir).toLowerCase()) {
          out.push(e)
        }
      }
    } catch {
      // skipped, see above
    }
  }
  return out
}

/**
 * The first archive member that is not a plain file or directory, or null.
 *
 * F10, found by attack 2026-08-03: a symlink member is how a crafted archive
 * escapes the restore folder. bsdtar refuses every `..` and absolute path, but
 * it will CREATE a symlink member and then write the next member through it,
 * landing outside the destination. In the lab that escaped; in production it
 * was contained only because a limited Windows token is denied
 * SeCreateSymbolicLinkPrivilege. That is an OS default, not our code, and it
 * breaks for an elevated dashboard or a host with Developer Mode on. So the
 * members are enumerated BEFORE extraction and anything that is not a file or
 * directory is refused by name, regardless of what the OS would permit.
 *
 * A cold backup of a Minecraft world is files and directories only; a link,
 * device, fifo or socket member has no legitimate place in one. Enumeration
 * uses two listings (names, and the verbose type column) zipped by index; if
 * their counts disagree -- which a member name containing a newline would
 * cause -- the archive is refused rather than risk mis-typing a member.
 */
const MEMBER_KIND: Record<string, string> = {
  l: 'symlink',
  h: 'hardlink',
  b: 'block-device',
  c: 'character-device',
  p: 'fifo',
  s: 'socket',
}

async function firstNonFileMember(archivePath: string): Promise<{ member: string; kind: string } | null> {
  const list = async (args: string[]): Promise<string[]> => {
    const { stdout } = await execFileP(tarBin(), args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    return stdout.split(/\r?\n/).filter((l) => l.length > 0)
  }
  let names: string[]
  let verbose: string[]
  try {
    names = await list(['-tf', archivePath])
    verbose = await list(['-tvf', archivePath])
  } catch (e) {
    // Could not read the members at all. Refuse: an archive whose table of
    // contents will not parse is not one to extract blindly.
    return { member: '(archive)', kind: `unreadable table of contents: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (names.length !== verbose.length) {
    return { member: '(unnamed)', kind: 'a member whose two listings disagree, likely a newline in the name' }
  }
  for (let i = 0; i < verbose.length; i++) {
    const t = verbose[i]![0]!
    if (t !== '-' && t !== 'd') {
      return { member: names[i] ?? verbose[i]!, kind: MEMBER_KIND[t] ?? `non-file type '${t}'` }
    }
  }
  return null
}

async function coldCheck(dir: string, deps: ColdDeps): Promise<ColdRefusal | null> {
  const occ = await (deps.occupancy ?? occupancyOf)(dir)
  if (occ.pids.length > 0) {
    return {
      ok: false,
      reason:
        `This server is running (pid ${occ.pids.join(', ')}). A cold backup copies a quiescent world; ` +
        'a copy taken while the JVM writes it can be corrupt while looking complete. Stop the server first. ' +
        'Nothing was written.',
    }
  }
  if (!occ.certain) {
    return {
      ok: false,
      reason:
        `Whether this server is running could not be established (${occ.doubt ?? 'no reason reported'}), ` +
        'and doubt counts as running, the same rule the start guard uses. Nothing was written.',
    }
  }
  return null
}

/**
 * Take one cold backup now. This is the whole feature: an operator's click,
 * no schedule, no rotation.
 */
export async function runColdBackup(
  args: {
    serverDir: string
    serverName: string
    destDir: string
    dataDir: string
    actor: string
    externalBackupPaths: string[]
  },
  deps: ColdDeps = {},
): Promise<ColdBackupResult> {
  const { serverDir, serverName, destDir, dataDir, actor } = args

  // The 0005 gate, on a FRESH reading: offered only where nothing is active.
  const detection = await detectBackups(serverDir, serverName, args.externalBackupPaths)
  if (detection.activeCount > 0) {
    const names = detection.systems.filter((s) => s.status === 'active').map((s) => s.name)
    return {
      ok: false,
      reason:
        `A backup system is already active for this server (${names.join(', ')}). ` +
        'Decision 0005 offers the dashboard’s own backup only where nothing exists, because a second ' +
        'system copying the same world doubles disk and I/O without asking. Nothing was written.',
    }
  }

  const refusal = await coldCheck(serverDir, deps)
  if (refusal) return refusal

  if (within(destDir, serverDir)) {
    return {
      ok: false,
      reason:
        'The destination is inside the server directory. An archive must live outside the world it ' +
        'protects, or losing the directory loses the backup with it. Nothing was written.',
    }
  }
  if (within(serverDir, destDir)) {
    return {
      ok: false,
      reason:
        'The destination contains the server directory itself. Pick a folder that is not a parent of ' +
        'the world being archived, or the archive would try to swallow itself. Nothing was written.',
    }
  }

  const now = (deps.now ?? (() => new Date()))()
  const archivePath = join(resolve(destDir), `${serverName} ${stamp(now, true)}.zip`)
  try {
    await fs.access(archivePath)
    return {
      ok: false,
      reason: `${basename(archivePath)} already exists at the destination. Nothing is ever overwritten; try again in a moment for a new name.`,
    }
  } catch {
    // good: the name is free
  }

  await fs.mkdir(resolve(destDir), { recursive: true })

  // -C parent + the folder name: the zip carries one top-level folder, so a
  // stray double-click extraction cannot scatter files.
  try {
    await execFileP(
      tarBin(),
      ['-a', '-c', '-f', archivePath, '-C', dirname(resolve(serverDir)), basename(resolve(serverDir))],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    )
  } catch (e) {
    return {
      ok: false,
      reason: `The archiver failed: ${e instanceof Error ? e.message : String(e)}. The partial file, if any, was left for inspection; nothing else was touched.`,
    }
  }

  const st = await fs.stat(archivePath)
  const entry: ColdBackupEntry = {
    id: `cb-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    serverName,
    serverDir: resolve(serverDir),
    archivePath,
    sha256: await sha256Of(archivePath),
    bytes: st.size,
    createdAt: now.toISOString(),
    actor,
  }
  await fs.appendFile(manifestPath(dataDir), JSON.stringify(entry) + '\n', 'utf8')
  return { ok: true, entry }
}

/**
 * Restore one journaled archive into a NEW sibling folder. The swap stays
 * the operator's move, so this function is incapable of destroying a world:
 * it refuses an occupied server, refuses a hash mismatch, refuses an
 * existing target, and extracts only into a folder it just created.
 */
export async function restoreColdBackup(
  args: { archiveId: string; dataDir: string },
  deps: ColdDeps = {},
): Promise<RestoreResult> {
  const entries = await listColdBackups(args.dataDir)
  const entry = entries.find((e) => e.id === args.archiveId)
  if (!entry) {
    return {
      ok: false,
      reason: 'No archive with that id is in the manifest. Only archives this dashboard wrote and journaled can be restored here.',
    }
  }

  let actual: string
  try {
    actual = await sha256Of(entry.archivePath)
  } catch {
    return {
      ok: false,
      reason: `The archive is missing or unreadable at ${entry.archivePath}. Nothing was restored.`,
    }
  }
  if (actual !== entry.sha256) {
    return {
      ok: false,
      reason:
        'The archive on disk does not match the sha256 recorded when it was written. These are not the ' +
        'bytes that were journaled, so restoring them would restore an unknown world. Nothing was restored.',
    }
  }

  // F10: refuse link/device members BEFORE extraction, whatever the OS would
  // allow. A symlink member is how a crafted archive writes outside the
  // restore folder; a world backup never legitimately contains one.
  const link = await firstNonFileMember(entry.archivePath)
  if (link) {
    return {
      ok: false,
      reason:
        `The archive contains a ${link.kind} member ("${link.member}"), which a cold backup of a world ` +
        'never legitimately has. A member of that kind is how a crafted archive writes outside the restore ' +
        'folder, so extraction was refused before it began. Nothing was restored.',
    }
  }

  const refusal = await coldCheck(entry.serverDir, deps)
  if (refusal) return { ok: false, reason: refusal.reason.replace('Nothing was written.', 'Nothing was restored.') }

  const now = (deps.now ?? (() => new Date()))()
  const restoredDir = join(dirname(entry.serverDir), `${entry.serverName} restored ${stamp(now, false)}`)
  try {
    await fs.access(restoredDir)
    return {
      ok: false,
      reason: `${basename(restoredDir)} already exists. Restore never extracts over anything; move or rename it first.`,
    }
  } catch {
    // good: the name is free
  }

  await fs.mkdir(restoredDir, { recursive: true })
  try {
    await execFileP(tarBin(), ['-x', '-f', entry.archivePath, '-C', restoredDir, '--strip-components', '1'], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (e) {
    return {
      ok: false,
      reason: `Extraction failed: ${e instanceof Error ? e.message : String(e)}. The partial folder ${basename(restoredDir)} was left for inspection; the original server directory was not touched.`,
    }
  }
  return { ok: true, restoredDir }
}
