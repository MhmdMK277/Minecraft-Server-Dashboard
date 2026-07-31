import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import { gamePortOf, levelDatPath, worldDirs } from './properties'
import { dataDir as defaultDataDir } from './config'

/**
 * Attaching a server folder the dashboard did not discover.
 *
 * This is the feature the attach model earns: a JVM the scan cannot place is
 * the dashboard's most honest moment ("N java processes could not be matched
 * and any server shown as not running may be one of them"), and this turns
 * that into an action.
 *
 * The boundaries, all of them load-bearing:
 *
 *   - The only write is to the dashboard's own config.json. NOTHING is
 *     written into the server's directory. Attaching does not touch a world.
 *   - A FOLDER is attached, never a jar. The liveness model is keyed on a
 *     directory: worlds, logs, ports and identity all hang off it, and a jar
 *     path answers none of those questions.
 *   - A launch method is CONFIRMED by the operator at attach time or it does
 *     not exist. The dashboard will not notice a start.bat six weeks later
 *     and quietly decide it may run it. Guessing how to start a server is
 *     how a second JVM lands on a live world, and this module is the one
 *     place where a directory the app has never seen becomes eligible for
 *     the start button.
 *   - Nothing is deleted. Detaching removes an entry from the active list
 *     and keeps it, with the time it was set aside.
 */

export type ConfirmedLaunch =
  | { strategy: 'script'; script: string }
  | { strategy: 'windows-task'; task: string }

export type AttachedServer = {
  dir: string
  attachedAt: string
  /**
   * The launch method the operator confirmed while looking at it. Null means
   * "none was confirmed", which is NOT the same as "none exists": a folder
   * with a start.bat that the operator did not confirm still reports no
   * launcher, deliberately.
   */
  confirmedLaunch: ConfirmedLaunch | null
}

type AttachFile = {
  version: 1
  attached: AttachedServer[]
  /** Detached entries are kept, never removed. Delete nothing. */
  detached: Array<AttachedServer & { detachedAt: string }>
}

export type AttachCandidate =
  | { ok: false; reason: string }
  | {
      ok: true
      dir: string
      gamePort: number | null
      levelName: string | null
      worldDirs: string[]
      rconConfigured: boolean
      /** What a launcher scan FOUND. Reporting it is not confirming it. */
      launchCandidate: ConfirmedLaunch | null
      /** True when a JVM currently holds this directory's log open. */
      logHeld: boolean | null
    }

const FILE = 'attached.json'

function filePath(dir: string): string {
  return join(dir, FILE)
}

function empty(): AttachFile {
  return { version: 1, attached: [], detached: [] }
}

function read(dir: string): AttachFile {
  const p = filePath(dir)
  if (!existsSync(p)) return empty()
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as AttachFile
    if (!Array.isArray(parsed.attached)) return empty()
    return {
      version: 1,
      attached: parsed.attached.filter((a) => typeof a?.dir === 'string'),
      detached: Array.isArray(parsed.detached) ? parsed.detached : [],
    }
  } catch {
    // Fail closed, as everywhere else: an unreadable file attaches nothing
    // rather than crashing the scan.
    return empty()
  }
}

function write(dir: string, file: AttachFile): void {
  const p = filePath(dir)
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
  renameSync(tmp, p)
}

/** The active attachments, for discovery and for the UI. */
export function loadAttached(dir: string = defaultDataDir()): AttachedServer[] {
  return read(dir).attached
}

/**
 * Validate a candidate directory WITHOUT changing anything.
 *
 * Everything the operator is shown before confirming comes from here, so it
 * reads the same files discovery would and reports what it actually found.
 */
export async function validateAttachCandidate(input: string): Promise<AttachCandidate> {
  const raw = (input ?? '').trim()
  if (!raw) return { ok: false, reason: 'No path was given.' }

  // A relative path would resolve against the service's working directory,
  // which is not a place the operator was thinking about.
  if (!isAbsolute(raw)) {
    return { ok: false, reason: 'Give an absolute path, for example C:\\Servers\\My Server.' }
  }
  // UNC paths reach another machine; identity, log tailing and the launcher
  // all assume a local directory, and none of that has been tested over SMB.
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    return { ok: false, reason: 'Network paths are not supported. The folder has to be on this machine.' }
  }

  const dir = resolve(normalize(raw))

  if (!existsSync(dir)) return { ok: false, reason: 'There is no folder at that path.' }
  let st
  try {
    st = statSync(dir)
  } catch {
    return { ok: false, reason: 'That path could not be read.' }
  }
  if (!st.isDirectory()) {
    return {
      ok: false,
      reason:
        'That is a file, not a folder. Attach the server folder itself, the one holding server.properties. A jar on its own does not say where the worlds, logs or ports are.',
    }
  }

  if (!existsSync(join(dir, 'server.properties'))) {
    return {
      ok: false,
      reason: 'No server.properties in that folder, so it is not a Minecraft server directory.',
    }
  }
  if (!levelDatPath(dir)) {
    return {
      ok: false,
      reason:
        'No world with a level.dat in that folder. A server that has never generated its world cannot be attached yet; start it once, then attach it.',
    }
  }

  const worlds = worldDirs(dir)
  const props = readFileSync(join(dir, 'server.properties'), 'utf8')
  const levelName = /^level-name=(.*)$/m.exec(props)?.[1]?.trim() ?? null
  const rconConfigured = /^enable-rcon=true\s*$/m.test(props)

  return {
    ok: true,
    dir,
    gamePort: gamePortOf(dir),
    levelName,
    worldDirs: worlds,
    rconConfigured,
    launchCandidate: detectLaunchCandidate(dir),
    logHeld: null,
  }
}

/**
 * What could start this server, as a REPORT. Only a script sitting in the
 * folder is offered: a scheduled task would already have been found by
 * discovery's own launcher detection, and inventing a java command line from
 * a jar is exactly the guess this project refuses to make.
 */
function detectLaunchCandidate(dir: string): ConfirmedLaunch | null {
  for (const name of ['start.bat', 'start.cmd', 'start.sh']) {
    if (existsSync(join(dir, name))) return { strategy: 'script', script: name }
  }
  return null
}

export type AttachResult = { ok: true; attached: AttachedServer } | { ok: false; reason: string }

/**
 * Register a directory. The confirmed launch method is checked against what
 * is really on disk: an operator can only confirm something that exists, so
 * a stale or forged confirmation cannot arm the start button.
 */
export function attachDir(
  dir: string,
  input: { dir: string; confirmedLaunch: ConfirmedLaunch | null },
  opts: { serversRoot?: string } = {},
): AttachResult {
  const target = resolve(normalize(input.dir))
  const file = read(dir)

  if (file.attached.some((a) => sameDir(a.dir, target))) {
    return { ok: false, reason: 'That folder is already attached.' }
  }
  // The servers root is resolved here rather than trusted from the caller:
  // forgetting to pass it would silently disable the duplicate check, and
  // one directory with two identities is a directory the double-spawn guard
  // sees twice and reasons about wrongly.
  const serversRoot = opts.serversRoot ?? currentServersRoot()
  if (serversRoot && isInside(target, serversRoot)) {
    return {
      ok: false,
      reason:
        'That folder is already inside the servers root, so it is discovered automatically. Attaching it again would give one directory two identities.',
    }
  }

  if (input.confirmedLaunch) {
    const c = input.confirmedLaunch
    if (c.strategy === 'script') {
      if (!c.script || !existsSync(join(target, c.script))) {
        return {
          ok: false,
          reason: `There is no ${c.script ?? 'script'} in that folder, so it cannot be confirmed as the way to start it.`,
        }
      }
    }
  }

  const attached: AttachedServer = {
    dir: target,
    attachedAt: new Date().toISOString(),
    confirmedLaunch: input.confirmedLaunch,
  }
  write(dir, { ...file, attached: [...file.attached, attached] })
  return { ok: true, attached }
}

/** Set an attachment aside. The entry is kept; nothing on disk is touched. */
export function detachDir(dir: string, target: string): { ok: boolean } {
  const file = read(dir)
  const found = file.attached.find((a) => sameDir(a.dir, target))
  if (!found) return { ok: false }
  write(dir, {
    ...file,
    attached: file.attached.filter((a) => !sameDir(a.dir, target)),
    detached: [...file.detached, { ...found, detachedAt: new Date().toISOString() }],
  })
  return { ok: true }
}

/**
 * The servers root in force right now, read the same way discovery reads it.
 * Imported lazily to keep attach.ts free of a cycle: config.ts imports this
 * module for the attached list.
 */
function currentServersRoot(): string | null {
  const env = process.env.MCDASH_SERVERS_ROOT
  if (env && env.trim()) return env
  try {
    const p = join(defaultDataDir(), 'config.json')
    if (!existsSync(p)) return null
    const cfg = JSON.parse(readFileSync(p, 'utf8')) as { serversRoot?: string }
    return typeof cfg.serversRoot === 'string' && cfg.serversRoot.trim() ? cfg.serversRoot : null
  } catch {
    return null
  }
}

function norm(p: string): string {
  return resolve(normalize(p)).replace(/[\\/]+$/, '').toLowerCase()
}
function sameDir(a: string, b: string): boolean {
  return norm(a) === norm(b)
}
function isInside(child: string, parent: string): boolean {
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p + (p.endsWith('\\') ? '' : '\\'))
}

/** Directory names that already exist under the servers root, for dedup. */
export function rootDirNames(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}
