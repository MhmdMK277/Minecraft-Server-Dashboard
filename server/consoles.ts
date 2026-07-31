import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { LogTailer } from './logtail'
import { redactLine, stripColourCodes, levelOf } from './redact'
import { classifyLine } from './rconnoise'
import type { LogLine, LogBatch } from '@shared/api'

/**
 * One tailer per live server, with batching.
 *
 * Volume matters: GTNH with 209 mods out-logs a Paper server by a wide margin,
 * and four tabs stream at once. Lines are coalesced into batches on a fixed
 * flush interval rather than sent per line, so a burst is one message instead
 * of hundreds.
 *
 * Numbers, chosen and measured rather than guessed:
 *   poll        250 ms   responsive without hammering the disk
 *   flush       100 ms   at most 10 messages per second per server
 *   backlog      64 KB   what a tab shows on open, roughly 400-600 lines
 *   scrollback 5,000 lines per server, ring buffer, ~1-2 MB of strings
 *
 * Redaction and colour stripping happen HERE, server-side, so a browser bug
 * cannot surface a raw line -- and now that lines cross a network rather than an
 * IPC bridge, an unredacted line would be on the wire, not merely in a renderer.
 *
 * This module emits; it does not know what a WebSocket is. Keeping that boundary
 * is what made the Electron-to-web port cheap, and it is worth keeping for the
 * same reason next time.
 */

const FLUSH_MS = 100

type Entry = {
  tailer: LogTailer
  pending: LogLine[]
  rotated: boolean
  timer: NodeJS.Timeout
}

const entries = new Map<string, Entry>()

/** Transport-agnostic fan-out. The WebSocket layer subscribes to this. */
export const consoleBus = new EventEmitter<{ batch: [LogBatch] }>()

/**
 * `arrivedAt` is when this line reached us, which is what the RCON ledger
 * correlates against. Parsing the log's own clock would mean handling three
 * formats, a missing date on two of them, and midnight rollover, to reach the
 * same answer.
 *
 * For backlog there is no arrival time: those lines were written before the
 * tailer existed, so `arrivedAt` is null and no window can be correlated against
 * them. See classifyLine for what that changes, and why it is not simply
 * "show everything".
 */
function toLine(serverId: string, seq: number, raw: string, arrivedAt: number | null): LogLine {
  const level = levelOf(raw)
  const text = stripColourCodes(redactLine(raw, 'on'))
  const { origin } = classifyLine(serverId, text, arrivedAt)
  return { seq, text, level, origin }
}

export async function ensureConsole(serverId: string, dir: string): Promise<void> {
  if (entries.has(serverId)) return
  const path = join(dir, 'logs', 'latest.log')
  const tailer = new LogTailer(path)

  const entry: Entry = {
    tailer,
    pending: [],
    rotated: false,
    timer: setInterval(() => flush(serverId), FLUSH_MS),
  }
  entries.set(serverId, entry)

  tailer.on('lines', (lines: Array<{ seq: number; text: string }>) => {
    const arrivedAt = Date.now()
    for (const l of lines) entry.pending.push(toLine(serverId, l.seq, l.text, arrivedAt))
  })
  tailer.on('rotated', () => {
    entry.rotated = true
  })

  await tailer.start()
}

export function stopConsole(serverId: string): void {
  const e = entries.get(serverId)
  if (!e) return
  clearInterval(e.timer)
  e.tailer.stop()
  entries.delete(serverId)
}

export function stopAllConsoles(): void {
  for (const id of [...entries.keys()]) stopConsole(id)
}

/** Reconcile tailers against the current set of live servers. */
export async function syncConsoles(live: Array<{ id: string; dir: string }>): Promise<void> {
  const want = new Set(live.map((s) => s.id))
  for (const id of [...entries.keys()]) if (!want.has(id)) stopConsole(id)
  for (const s of live) await ensureConsole(s.id, s.dir)
}

export function backlogFor(serverId: string): LogLine[] {
  const e = entries.get(serverId)
  if (!e) return []
  return e.tailer.backlog.map((l) => toLine(serverId, l.seq, l.text, null))
}

function flush(serverId: string): void {
  const e = entries.get(serverId)
  if (!e) return
  if (!e.pending.length && !e.rotated) return
  const batch: LogBatch = { serverId, lines: e.pending, rotated: e.rotated }
  e.pending = []
  e.rotated = false
  consoleBus.emit('batch', batch)
}
