import { open, stat } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'

/**
 * Log tailer.
 *
 * We did not spawn these processes, so there is no stdout to read. The console
 * is `logs/latest.log`, followed from disk. See docs/liveness-spec.md.
 *
 * ROTATION (the hard part on Windows)
 * -----------------------------------
 * Paper rotates latest.log daily around 05:12 and gzips the old one. Two rules
 * follow:
 *
 *   1. Never hold a persistent handle. A handle open without FILE_SHARE_DELETE
 *      can block the server from renaming its own log, which would be a
 *      read-only tool breaking the thing it observes. So: open, read the delta,
 *      close, every poll.
 *   2. Do not trust watchers. fs.watch on Windows does not reliably report a
 *      rename-then-recreate as anything useful. Detection is by polling stat.
 *
 * DETECTING REPLACEMENT (this took two attempts)
 * ----------------------------------------------
 * The obvious signals are both unreliable on Windows:
 *
 *   birthtime  NTFS FILE SYSTEM TUNNELLING deliberately preserves the original
 *              creation time when a file is renamed away and a new one with the
 *              same name appears shortly after. Measured: identical birthtimeMs
 *              across a real rename+recreate. This check never fires.
 *   size       Only catches replacement when the new file happens to be SMALLER
 *              than the old offset. A server's startup burst can easily make it
 *              larger, in which case a rotation goes unnoticed and the tailer
 *              reads from a stale offset into a different file -- gaps, or
 *              garbage from the middle of a line.
 *
 * `ino` is the reliable one. Node populates it on Windows from the NTFS file
 * index, and it does change on replacement (measured: 9570149208939620 ->
 * 8162774325386410 across the same rename+recreate). Size is kept as a
 * secondary signal for truncation-in-place.
 */

export type LogLine = { seq: number; text: string }

export type TailerOptions = {
  /** How often to check for new bytes. */
  pollMs?: number
  /** Bytes of existing file to show when a tab is first opened. */
  backlogBytes?: number
  /** Hard cap on retained lines per server. */
  maxLines?: number
}

const DEFAULTS = {
  pollMs: 250,
  backlogBytes: 64 * 1024,
  maxLines: 5000,
}

export class LogTailer extends EventEmitter {
  readonly path: string
  private pos = 0
  private lastSize = 0
  private lastIno: bigint | number = 0
  private timer: NodeJS.Timeout | null = null
  private reading = false
  private seq = 0
  private carry = ''
  private decoder = new StringDecoder('utf8') // explicit UTF-8; logs are UTF-8
  private ring: LogLine[] = []
  private readonly opts: Required<TailerOptions>

  constructor(path: string, opts: TailerOptions = {}) {
    super()
    this.path = path
    this.opts = { ...DEFAULTS, ...opts }
  }

  /** Recent history so a freshly opened tab is not empty. */
  get backlog(): LogLine[] {
    return this.ring
  }

  async start(): Promise<void> {
    await this.primeFromTail()
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Read the tail of the existing file so the tab opens with context. */
  private async primeFromTail(): Promise<void> {
    try {
      const st = await stat(this.path)
      this.lastSize = st.size
      this.lastIno = st.ino
      const from = Math.max(0, st.size - this.opts.backlogBytes)
      const fh = await open(this.path, 'r')
      try {
        const len = st.size - from
        const buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, from)
        let text = this.decoder.write(buf)
        // A partial first line is expected when we start mid-file.
        if (from > 0) {
          const nl = text.indexOf('\n')
          text = nl >= 0 ? text.slice(nl + 1) : ''
        }
        const lines = text.split(/\r?\n/)
        this.carry = lines.pop() ?? ''
        for (const l of lines) this.push(l)
      } finally {
        await fh.close()
      }
      this.pos = st.size
    } catch {
      this.pos = 0
      this.lastSize = 0
    }
  }

  private async poll(): Promise<void> {
    if (this.reading) return
    this.reading = true
    try {
      let st
      try {
        st = await stat(this.path)
      } catch {
        // File is gone mid-rotation. Keep the tab alive and wait for the new one.
        return
      }

      // ino first: it is the only signal that survives NTFS tunnelling.
      // Size is a fallback for truncate-in-place, where ino would not change.
      const replaced =
        (this.lastIno !== 0 && st.ino !== this.lastIno) || st.size < this.lastSize
      if (replaced) {
        this.pos = 0
        this.carry = ''
        this.decoder = new StringDecoder('utf8')
        this.emit('rotated', this.path)
      }
      this.lastIno = st.ino
      this.lastSize = st.size

      if (st.size <= this.pos) return

      const len = st.size - this.pos
      const fh = await open(this.path, 'r')
      try {
        const buf = Buffer.alloc(len)
        const { bytesRead } = await fh.read(buf, 0, len, this.pos)
        this.pos += bytesRead
        // Decode with a streaming decoder so a multi-byte character split
        // across a read boundary is not turned into replacement characters --
        // this is where mojibake comes from.
        const text = this.carry + this.decoder.write(buf.subarray(0, bytesRead))
        const lines = text.split(/\r?\n/)
        this.carry = lines.pop() ?? ''
        const fresh: LogLine[] = []
        for (const l of lines) fresh.push(this.push(l))
        if (fresh.length) this.emit('lines', fresh)
      } finally {
        await fh.close()
      }
    } finally {
      this.reading = false
    }
  }

  private push(text: string): LogLine {
    const line = { seq: ++this.seq, text }
    this.ring.push(line)
    if (this.ring.length > this.opts.maxLines) {
      this.ring.splice(0, this.ring.length - this.opts.maxLines)
    }
    return line
  }
}
