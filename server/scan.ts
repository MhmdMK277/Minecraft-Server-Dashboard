import { existsSync, readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { homedir } from 'node:os'
import { join, parse } from 'node:path'
import { gamePortOf, levelDatPath } from './properties'
import { loadAttached } from './attach'
import { loadConfig, dataDir } from './config'
import { scanJvms, type DirHint } from './platform'
import type { ScanResult, ScanCandidate, ScanRoot } from '@shared/api'

/**
 * Finding Minecraft servers on this machine, without being told where.
 *
 * WHY this exists: the canonical way to start a server, the one the wiki and
 * every tutorial gives, is
 *
 *     java -Xmx1024M -Xms1024M -jar server.jar nogui
 *
 * run from inside the server folder. That command line contains no directory
 * at all, and neither does its parent shell, so command-line attribution
 * (signal 2) finds nothing. Measured as an A/B on a real server, spec §17:
 * started through a start.bat it is attributed; started canonically it is
 * one anonymous java process. The most common way people run servers was the
 * way this dashboard could not see.
 *
 * WHAT fixes it: not a new signal. Signal 3 already probes the exclusive hold
 * on `logs/latest.log` and then uses the listening port only to name the pid.
 * It was simply never ASKED about directories outside the configured servers
 * root. This module produces those candidates.
 *
 * THE RULE THIS MODULE MUST NOT BREAK (spec §1, amended 2026-08-01): the log
 * hold is the identity, the port is only a lookup. A bounded scan of the
 * development machine found ten directories holding a `server.properties`,
 * three of which are a backup tree declaring the SAME PORTS as the live
 * servers. Deciding "this directory is running" from its declared port would
 * map one JVM onto three directories and put a copy of a live world under a
 * start button. So `running` here is set from occupancy, never from a port.
 *
 * COST, measured on the real machine: 769 ms over 723 directories. That is
 * cheap once and far too expensive sixty times a minute, so this never runs
 * on the ten-second scan loop; it runs on demand and at first run, and it
 * reports its own duration the way the worlds walk does.
 *
 * THE SECOND RULE THIS MODULE MUST NOT BREAK (spec §11, amended 2026-08-03):
 * being on demand does not license blocking. On the second-machine trial the
 * walk was synchronous and its 9,458 ms search held the event loop for
 * 8,739 ms; while the loop is held, every probe in flight is billed the
 * blockage, so one button press made the whole fleet unmeasurable and the
 * host panel read "Stalling", correctly, about us. The walk therefore uses
 * the async filesystem API and yields between candidates: wall-clock time is
 * spent in the disk, never in the loop. prove-scan section 5 measures the
 * worst loop gap during a scan of a tree big enough that the synchronous
 * version fails it.
 */

/** Same convention as launcher.ts and worlds.ts: 0 means do not use the cache. */
export const SCAN_CACHE_MS = 120_000

let cache: { at: number; result: ScanResult } | null = null

/** Test seam: the cache is process-wide, so proofs must be able to clear it. */
export function resetScanCache(): void {
  cache = null
}

/**
 * Directories never worth entering. Skipping them is about cost and noise,
 * not permission: `Windows` and `Program Files` hold hundreds of thousands of
 * directories and no Minecraft server anybody wants managed.
 */
const SKIP = new Set([
  'windows', 'winnt', 'program files', 'program files (x86)', 'programdata',
  '$recycle.bin', 'system volume information', 'recovery', 'perflogs',
  'appdata', 'node_modules', 'onedrive', 'msocache', '.git', '.svn', '.hg',
  'temp', 'tmp', 'cache', 'caches', '.cache', 'venv', '.venv',
])

/**
 * The default places to look, per the operator's decision:
 * profile, Documents and Desktop always; drive roots shallow; anything
 * deeper is a location the operator adds themselves.
 */
export function defaultRoots(): ScanRoot[] {
  const home = homedir()
  const roots: ScanRoot[] = [
    { dir: join(home, 'Documents'), depth: 4 },
    { dir: join(home, 'Desktop'), depth: 4 },
    { dir: home, depth: 2 },
  ]
  // Drive roots at depth 2: enough to find D:\Servers\MyServer, not enough
  // to walk an entire archive drive. D: took 703 ms of the measured 769 at
  // depth 4, and almost none of it at depth 2.
  for (const letter of 'CDEFGH') {
    const d = `${letter}:\\`
    if (existsSync(d)) roots.push({ dir: d, depth: 2 })
  }
  return roots
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * One bounded walk. A server directory is a LEAF: never descend into it.
 *
 * Async on purpose, not for speed: each `await readdir` is one small task,
 * so the event loop stays live between directories and a slow disk costs
 * wall-clock, never measurement. The synchronous version of this function
 * blocked the loop for 8.7 s on the trial machine (spec §11 amendment).
 */
async function walk(root: string, maxDepth: number, out: Set<string>, seen: Set<string>): Promise<void> {
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    // Junctions and symlinks can point back up the tree. Without this a
    // single junction turns the walk into an infinite one.
    const key = dir.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Permission denied, or the directory vanished mid-walk. Both are
      // ordinary on a live machine and neither is worth reporting.
      return
    }

    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === 'server.properties')) {
      out.add(dir)
      return // a server is a leaf: its world holds tens of thousands of files
    }

    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.isSymbolicLink()) continue
      const name = e.name.toLowerCase()
      if (SKIP.has(name) || name.startsWith('.')) continue
      await visit(join(dir, e.name), depth + 1)
    }
  }
  if (!(await isDir(root))) return
  await visit(root, 0)
}

/**
 * Search for server directories and report what is already known about each.
 *
 * Nothing here adopts anything. Every result is a candidate the operator may
 * choose; see `known` for whether it is already watched or attached.
 */
export async function scanForServers(
  opts: { roots?: ScanRoot[]; maxAgeMs?: number } = {},
): Promise<ScanResult> {
  const maxAgeMs = opts.maxAgeMs ?? SCAN_CACHE_MS
  if (!opts.roots && cache && maxAgeMs > 0 && Date.now() - cache.at <= maxAgeMs) {
    return { ...cache.result, cached: true }
  }

  const roots = opts.roots ?? defaultRoots()
  const started = Date.now()

  const found = new Set<string>()
  const seen = new Set<string>()
  for (const r of roots) await walk(r.dir, r.depth, found, seen)

  // What the dashboard already knows about, so nothing is offered twice.
  const cfg = loadConfig(dataDir())
  const attached = new Set(loadAttached(dataDir()).map((a) => norm(a.dir)))
  const watched = new Set<string>()
  try {
    for (const name of await readdir(cfg.serversRoot)) {
      watched.add(norm(join(cfg.serversRoot, name)))
    }
  } catch {
    /* a missing servers root is reported elsewhere, not here */
  }

  const dirs = [...found].sort()

  /**
   * Occupancy comes from the identity layer, which probes the exclusive hold
   * on each candidate's log and only then uses the port to name the pid.
   * This is the whole reason the scan is worth anything, and the reason it
   * must not shortcut to a port lookup itself.
   *
   * The per-candidate property reads are synchronous but each is one small
   * file; the yield between candidates keeps the loop live even when the
   * disk is slow enough that many small reads would add up (spec §11).
   */
  const hints: DirHint[] = []
  for (const d of dirs) {
    hints.push({ dir: d, gamePort: gamePortOf(d) })
    await nextTurn()
  }
  let occupied = new Map<string, number>()
  try {
    const jvms = await scanJvms(hints)
    occupied = new Map(jvms.jvms.map((j) => [norm(j.dir), j.pid]))
  } catch {
    // If identity cannot be enumerated we still report the folders we found;
    // we just cannot say which are running. Saying nothing about occupancy is
    // honest, claiming "not running" would not be.
  }

  const candidates: ScanCandidate[] = []
  for (const [i, dir] of dirs.entries()) {
    const key = norm(dir)
    const pid = occupied.get(key) ?? null
    candidates.push({
      dir,
      name: parse(dir).base,
      known: attached.has(key) ? 'attached' : watched.has(key) ? 'watched' : 'new',
      looksLikeServer: levelDatPath(dir) !== null,
      gamePort: hints[i]?.gamePort ?? null,
      levelName: levelNameOf(dir),
      running: pid !== null,
      pid,
    })
    await nextTurn()
  }

  const result: ScanResult = {
    scannedAt: new Date(started).toISOString(),
    ms: Date.now() - started,
    roots: roots.map((r) => r.dir),
    cached: false,
    candidates,
  }
  if (!opts.roots) cache = { at: started, result }
  return result
}

function norm(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase()
}

function levelNameOf(dir: string): string | null {
  try {
    const props = readFileSync(join(dir, 'server.properties'), 'utf8')
    return /^level-name=(.*)$/m.exec(props)?.[1]?.trim() ?? null
  } catch {
    return null
  }
}
