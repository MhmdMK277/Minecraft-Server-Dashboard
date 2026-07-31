import { readFileSync, writeFileSync, renameSync, existsSync, statSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { serverProps } from './properties'

/**
 * Editing server.properties.
 *
 * This is the first thing the dashboard writes into a directory the Minecraft
 * server itself owns, so the safety properties matter more than the mechanism:
 *
 * 1. **An allowlist, not a property editor.** Only the two keys below can be
 *    written. A general editor is a way to set `rcon.password` from a browser,
 *    which would drive a hole straight through the rule that credentials are
 *    read server-side and never cross the wire.
 *
 * 2. **Only the target line is touched.** The file is edited as TEXT, line by
 *    line -- not parsed into an object and re-serialised. Re-serialising would
 *    drop every comment, reorder every key, and round-trip `rcon.password`
 *    through our own code on the way. Byte-for-byte, every other line survives.
 *
 * 3. **The previous file is kept.** `server.properties.bak-<date>`, next to the
 *    original, matching the `start.bat.bak-<date>` convention already on this
 *    host. Nothing is ever deleted; a second edit on the same day overwrites
 *    only that day's backup, never the original.
 *
 * 4. **The write is atomic.** Temp file then rename. A half-written
 *    server.properties is a server that will not start, and a crash between
 *    `open` and `write` is not a theoretical concern on a machine this project
 *    already has a stall investigation open about.
 */

export type SettingKey = 'white-list' | 'online-mode'

export const EDITABLE: readonly SettingKey[] = ['white-list', 'online-mode'] as const

export function isSettingKey(k: string): k is SettingKey {
  return (EDITABLE as readonly string[]).includes(k)
}

export interface ServerSettingsRead {
  onlineMode: boolean
  whitelist: boolean
  /** server.properties mtime, ISO. Null when the file is missing. */
  fileModifiedAt: string | null
  /**
   * Whether server.properties has been modified since the running process
   * started, which is the honest form of "a restart is needed".
   *
   * Minecraft rewrites server.properties during its own startup, so the mtime
   * of an untouched file sits a few seconds AFTER the process start -- that is
   * why this is not a naive `mtime > start`. Anything past the grace window is
   * an edit the running server has not read.
   *
   * Null when there is no process to compare against: no running server means
   * no stale running config, and reporting "restart needed" for a stopped
   * server would be an accusation about nothing.
   */
  changedSinceStart: boolean | null
}

/** Minecraft finishes writing server.properties within this long of starting. */
const STARTUP_WRITE_GRACE_MS = 120_000

function asBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback
  return v.trim().toLowerCase() === 'true'
}

export function readSettings(dir: string, uptimeSeconds: number | null): ServerSettingsRead {
  const path = join(dir, 'server.properties')
  const p = serverProps(dir)

  let modified: Date | null = null
  try {
    modified = statSync(path).mtime
  } catch {
    /* no file */
  }

  let changedSinceStart: boolean | null = null
  if (modified && uptimeSeconds != null) {
    const processStart = Date.now() - uptimeSeconds * 1000
    changedSinceStart = modified.getTime() > processStart + STARTUP_WRITE_GRACE_MS
  }

  return {
    // Vanilla defaults, used when the key is absent. online-mode defaults TRUE
    // in Minecraft, and getting that fallback backwards would report a secured
    // server as open.
    onlineMode: asBool(p['online-mode'], true),
    whitelist: asBool(p['white-list'], false),
    fileModifiedAt: modified ? modified.toISOString() : null,
    changedSinceStart,
  }
}

export interface WriteResult {
  ok: boolean
  detail: string
  backupPath: string | null
}

/**
 * Set one allowlisted key to one boolean.
 *
 * Returns a sentence rather than throwing, because the sentence is what the UI
 * shows and what the audit log records -- see the control routes, where a
 * refusal from the guard is displayed verbatim because it is the only useful
 * part of the answer.
 */
export function writeSetting(
  dir: string,
  key: SettingKey,
  value: boolean,
  today: string,
): WriteResult {
  if (!isSettingKey(key)) {
    return { ok: false, detail: `${key} is not an editable setting`, backupPath: null }
  }

  const path = join(dir, 'server.properties')
  if (!existsSync(path)) {
    return { ok: false, detail: 'this directory has no server.properties', backupPath: null }
  }

  const original = readFileSync(path, 'utf8')
  const desired = value ? 'true' : 'false'

  // Match the key at the start of a line, allowing surrounding whitespace, and
  // leave a commented-out line alone -- `#online-mode=true` is documentation,
  // not configuration, and uncommenting it would change meaning silently.
  const lines = original.split(/\r?\n/)
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  let found = false
  let previous: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = /^(\s*)([A-Za-z0-9._-]+)(\s*)=(.*)$/.exec(line)
    if (!m || m[2] !== key) continue
    previous = m[4]!.trim()
    lines[i] = `${m[1]}${key}${m[3]}=${desired}`
    found = true
    break
  }

  if (!found) {
    // Absent means the server is running on the vanilla default. Append rather
    // than refuse: the operator asked for a value, and a missing line is a
    // normal state of a freshly generated file.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    lines.push(`${key}=${desired}`, '')
  }

  if (previous === desired) {
    return { ok: true, detail: `${key} was already ${desired}`, backupPath: null }
  }

  // Keep the file we are about to replace, dated, beside the original.
  const backupPath = `${path}.bak-${today}`
  try {
    if (!existsSync(backupPath)) copyFileSync(path, backupPath)
  } catch (e) {
    return {
      ok: false,
      detail: `could not back up server.properties before writing: ${e instanceof Error ? e.message : String(e)}`,
      backupPath: null,
    }
  }

  // Atomic: a truncated server.properties is a server that will not start.
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, lines.join(eol), 'utf8')
    renameSync(tmp, path)
  } catch (e) {
    return {
      ok: false,
      detail: `could not write server.properties: ${e instanceof Error ? e.message : String(e)}`,
      backupPath,
    }
  }

  return {
    ok: true,
    detail:
      previous === null
        ? `${key} was not set, and is now ${desired}`
        : `${key} changed from ${previous} to ${desired}`,
    backupPath,
  }
}
