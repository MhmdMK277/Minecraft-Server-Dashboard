import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Editing the heap in a start script THIS DASHBOARD WROTE, and only such a
 * script.
 *
 * Defect 5 from the three-day-use report (2026-08-06): memory could only be
 * set at creation, and raising a live server's heap meant hand-editing
 * start.bat. The dashboard generated that file, so it can edit it, with the
 * same discipline as every other write (serversettings.ts is the template):
 *
 * 1. **Only our own script.** The creation journal (.mcdash-creation.json)
 *    must be present in the folder and must list start.bat among the files
 *    creation wrote. A script the operator wrote themselves is theirs; the
 *    refusal says so and points at editing it directly. This is the same
 *    boundary removeFailedCreation draws with the same file.
 *
 * 2. **Only the recognized line.** Creation writes exactly one launch shape,
 *    `java -Xms<n>M -Xmx<n>M -jar "<jar>" nogui`, optionally under a
 *    provisioned-Java PATH line. If start.bat no longer contains that shape,
 *    the operator has rewritten it, and this module refuses to guess rather
 *    than corrupting a launcher: a broken start.bat is a server that cannot
 *    start. The Forge/NeoForge wrapper (`call run.bat nogui`) carries no
 *    heap at all -- memory lives in user_jvm_args.txt there -- and the
 *    refusal names that file instead of pretending.
 *
 * 3. **The previous file is kept**, `start.bat.bak-<date>`, the same
 *    convention the operator already uses on this host by hand.
 *
 * 4. **The write is atomic** (temp then rename), and Xms stays equal to Xmx,
 *    exactly as creation writes it.
 *
 * What this module does NOT claim: that the change applies to a running
 * server. It cannot. The route composes the honest sentence from the running
 * JVM's actual -Xmx (read from its command line by identity), and the UI
 * repeats it.
 */

/** Same bounds as creation's memoryMb; a heap outside them is a typo. */
export const HEAP_MIN_MB = 512
export const HEAP_MAX_MB = 65536

const LAUNCH_LINE = /^(\s*java\s+-Xms)(\d+)(M\s+-Xmx)(\d+)(M\s+-jar\s+"[^"]+"\s+nogui\s*)$/

export type HeapRead =
  | { editable: true; scriptMb: number }
  | { editable: false; why: string }

/** Whether creation's journal claims start.bat as a file it wrote. */
function wroteStartBat(dir: string): boolean {
  try {
    const j = JSON.parse(readFileSync(join(dir, '.mcdash-creation.json'), 'utf8')) as {
      files?: unknown
    }
    return Array.isArray(j.files) && j.files.includes('start.bat')
  } catch {
    return false
  }
}

export function readHeap(dir: string): HeapRead {
  const path = join(dir, 'start.bat')
  if (!existsSync(path)) {
    return { editable: false, why: 'There is no start.bat in this folder.' }
  }
  if (!wroteStartBat(dir)) {
    return {
      editable: false,
      why:
        'This dashboard did not write this start script (no creation journal claims it), so it will not edit it. ' +
        'Change the memory by editing start.bat yourself; the -Xmx value is the ceiling.',
    }
  }

  const text = readFileSync(path, 'utf8')
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const m = LAUNCH_LINE.exec(line)
    if (m) return { editable: true, scriptMb: Number(m[4]) }
  }
  if (lines.some((l) => /^\s*call\s+run\.bat\b/i.test(l))) {
    return {
      editable: false,
      why:
        'This start.bat delegates to the Forge/NeoForge run.bat, so the memory lives in user_jvm_args.txt, ' +
        'which this dashboard does not edit yet. Set -Xmx there.',
    }
  }
  return {
    editable: false,
    why:
      'start.bat no longer matches what creation wrote, so this dashboard will not guess at it. ' +
      'A wrong edit here is a server that cannot start; change the memory by editing the script yourself.',
  }
}

export type HeapWriteResult = {
  ok: boolean
  detail: string
  backupPath: string | null
}

export function writeHeap(dir: string, memoryMb: number, today: string): HeapWriteResult {
  if (!Number.isInteger(memoryMb) || memoryMb < HEAP_MIN_MB || memoryMb > HEAP_MAX_MB) {
    return {
      ok: false,
      detail: `Memory must be a whole number between ${HEAP_MIN_MB} and ${HEAP_MAX_MB} MB.`,
      backupPath: null,
    }
  }

  const read = readHeap(dir)
  if (!read.editable) return { ok: false, detail: read.why, backupPath: null }
  if (read.scriptMb === memoryMb) {
    return { ok: true, detail: `start.bat already says ${memoryMb} MB.`, backupPath: null }
  }

  const path = join(dir, 'start.bat')
  const original = readFileSync(path, 'utf8')
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = original.split(/\r?\n/)
  let edited = false
  for (let i = 0; i < lines.length; i++) {
    const m = LAUNCH_LINE.exec(lines[i]!)
    if (!m) continue
    lines[i] = `${m[1]}${memoryMb}${m[3]}${memoryMb}${m[5]}`
    edited = true
    break
  }
  if (!edited) {
    return { ok: false, detail: 'The launch line vanished between reading and writing; nothing was changed.', backupPath: null }
  }

  const backupPath = `${path}.bak-${today}`
  try {
    if (!existsSync(backupPath)) copyFileSync(path, backupPath)
  } catch (e) {
    return {
      ok: false,
      detail: `could not back up start.bat before writing: ${e instanceof Error ? e.message : String(e)}`,
      backupPath: null,
    }
  }

  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, lines.join(eol), 'utf8')
    renameSync(tmp, path)
  } catch (e) {
    return {
      ok: false,
      detail: `could not write start.bat: ${e instanceof Error ? e.message : String(e)}`,
      backupPath,
    }
  }

  return {
    ok: true,
    detail: `Memory changed from ${read.scriptMb} MB to ${memoryMb} MB (-Xms and -Xmx in start.bat, equal as creation writes them).`,
    backupPath,
  }
}
