import { readFileSync, writeFileSync, renameSync, existsSync, statSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { MOTD_MAX_LINES, MOTD_MAX_LINE_LENGTH } from '@shared/api'
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
  /**
   * The MOTD as the player would read it: Java .properties escapes decoded,
   * `\n` a real newline, `§` the section sign the formatting codes use.
   * Null when the key is absent (the server then shows Minecraft's default).
   */
  motd: string | null
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

/**
 * The raw right-hand side of one key's line, before any unescaping.
 *
 * `serverProps()` half-decodes (`\:` and `\=` only), which is enough for ports
 * and level names but corrupts anything with real escapes in it. The MOTD is
 * the first value here that legitimately contains them: vanilla writes the
 * section sign as `\u00A7` and a two-line MOTD as `\n`.
 */
function rawPropertyValue(path: string, key: string): string | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\s*)([A-Za-z0-9._-]+)(\s*)=(.*)$/.exec(line)
    if (m && m[2] === key) return m[4]!
  }
  return null
}

/**
 * Decode the Java .properties escapes a Minecraft server writes.
 *
 * The subset java.util.Properties emits: `\uXXXX`, `\n`, `\t`, `\r`, `\f`,
 * `\\`, and a backslash before `:`, `=`, `#`, `!` or space. An unknown escaped
 * character decodes to itself, which is Properties.load's own rule.
 */
export function decodeJavaProps(v: string): string {
  let out = ''
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!
    if (c !== '\\' || i === v.length - 1) {
      out += c
      continue
    }
    const e = v[++i]!
    if (e === 'u') {
      const hex = v.slice(i + 1, i + 5)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16))
        i += 4
      } else out += 'u'
    } else if (e === 'n') out += '\n'
    else if (e === 't') out += '\t'
    else if (e === 'r') out += '\r'
    else if (e === 'f') out += '\f'
    else out += e
  }
  return out
}

export function readSettings(dir: string, uptimeSeconds: number | null): ServerSettingsRead {
  const path = join(dir, 'server.properties')
  const p = serverProps(dir)
  const rawMotd = rawPropertyValue(path, 'motd')

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
    motd: rawMotd === null ? null : decodeJavaProps(rawMotd.trim()),
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
/**
 * The line editor both public writers share. MODULE-PRIVATE on purpose: an
 * exported "write any key" function would BE the general property editor this
 * file's first rule forbids. The only ways in are `writeSetting` (two boolean
 * keys, enum-checked) and `writeMotd` (one string key, validated and encoded
 * before it gets here). prove-settings asserts that reach.
 */
type LineEdit =
  | { ok: true; changed: boolean; previous: string | null; backupPath: string | null }
  | { ok: false; detail: string; backupPath: string | null }

function editPropertyLine(dir: string, key: string, desired: string, today: string): LineEdit {
  const path = join(dir, 'server.properties')
  if (!existsSync(path)) {
    return { ok: false, detail: 'this directory has no server.properties', backupPath: null }
  }

  const original = readFileSync(path, 'utf8')

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
    return { ok: true, changed: false, previous, backupPath: null }
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

  return { ok: true, changed: true, previous, backupPath }
}

export function writeSetting(
  dir: string,
  key: SettingKey,
  value: boolean,
  today: string,
): WriteResult {
  if (!isSettingKey(key)) {
    return { ok: false, detail: `${key} is not an editable setting`, backupPath: null }
  }

  const desired = value ? 'true' : 'false'
  const r = editPropertyLine(dir, key, desired, today)
  if (!r.ok) return { ok: false, detail: r.detail, backupPath: r.backupPath }
  if (!r.changed) {
    return { ok: true, detail: `${key} was already ${desired}`, backupPath: null }
  }
  return {
    ok: true,
    detail:
      r.previous === null
        ? `${key} was not set, and is now ${desired}`
        : `${key} changed from ${r.previous} to ${desired}`,
    backupPath: r.backupPath,
  }
}

// ------------------------------------------------------------------- MOTD

/**
 * Why the MOTD is validated and ENCODED rather than written as typed: the
 * value lands in a line-oriented file next to `rcon.password`. A raw newline
 * in the value would become a second property line -- a property injection
 * through the one field that takes free text. So line breaks the operator
 * wants are carried as the `\n` escape Minecraft itself uses, every backslash
 * is escaped, and everything outside printable ASCII becomes a `\uXXXX`
 * escape, exactly the encoding vanilla's own writer produces (the section
 * sign becomes `\u00A7`). By construction the written value cannot contain
 * a newline.
 */
export function validateMotd(text: string): string | null {
  const lines = text.split('\n')
  if (lines.length > MOTD_MAX_LINES) {
    return `An MOTD is at most ${MOTD_MAX_LINES} lines; this has ${lines.length}.`
  }
  const long = lines.find((l) => l.length > MOTD_MAX_LINE_LENGTH)
  if (long !== undefined) {
    return `An MOTD line is capped at ${MOTD_MAX_LINE_LENGTH} characters here (the client shows fewer); one line has ${long.length}.`
  }
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (ch !== '\n' && (code < 0x20 || code === 0x7f)) {
      return 'The MOTD contains a control character, which server.properties cannot carry.'
    }
  }
  return null
}

function encodeMotd(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const code = text.charCodeAt(i)
    if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (code >= 0x20 && code <= 0x7e) out += ch
    else out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** For the result sentence and the audit line: short, one visual line. */
function motdForSentence(text: string): string {
  const flat = text.replace(/\n/g, ' \\n ')
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat
}

export function writeMotd(dir: string, text: string, today: string): WriteResult {
  // Textarea input arrives with CRLF on Windows; the semantic value is LF.
  const motd = text.replace(/\r\n?/g, '\n')
  const why = validateMotd(motd)
  if (why) return { ok: false, detail: why, backupPath: null }

  const r = editPropertyLine(dir, 'motd', encodeMotd(motd), today)
  if (!r.ok) return { ok: false, detail: r.detail, backupPath: r.backupPath }
  if (!r.changed) {
    return { ok: true, detail: 'the MOTD is already exactly that', backupPath: null }
  }
  return {
    ok: true,
    detail:
      motd === ''
        ? 'the MOTD is now empty (the server list shows a blank line)'
        : `the MOTD is now "${motdForSentence(motd)}"`,
    backupPath: r.backupPath,
  }
}
