import { Socket } from 'node:net'
import { normaliseSlpPayload, pingIsReady, extractMotd, stripColour } from './parse'
import type { SlpInfo } from '@shared/api'

/**
 * Server List Ping.
 *
 * IMPORTANT: a successful ping proves the PROCESS is alive and the port is
 * open. It proves nothing about server health -- SLP is answered by the network
 * thread from a cached status object, so a server whose main thread is wedged
 * still answers normally. See docs/liveness-spec.md §8.
 */

function varint(n: number): Buffer {
  const bytes: number[] = []
  let v = n
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v) b |= 0x80
    bytes.push(b)
  } while (v)
  return Buffer.from(bytes)
}

class Reader {
  private buf: Buffer
  private pos = 0
  constructor(buf: Buffer) {
    this.buf = buf
  }
  varint(): number {
    let num = 0
    let shift = 0
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error('truncated varint')
      const b = this.buf[this.pos++]!
      num |= (b & 0x7f) << shift
      if (!(b & 0x80)) return num
      shift += 7
      if (shift > 35) throw new Error('varint too long')
    }
  }
  take(n: number): Buffer {
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  get remaining(): number {
    return this.buf.length - this.pos
  }
}

export async function slpPing(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 4000,
): Promise<SlpInfo | null> {
  const started = Date.now()
  const raw = await rawStatus(port, host, timeoutMs)
  if (raw === null) return null

  const data = normaliseSlpPayload(raw)
  const v = data.version
  const versionName =
    v && typeof v === 'object'
      ? ((v as Record<string, unknown>).name as string | undefined) ?? null
      : typeof v === 'string'
        ? v
        : null
  const protocol =
    v && typeof v === 'object'
      ? ((v as Record<string, unknown>).protocol as number | undefined) ?? null
      : null
  const players = data.players as Record<string, unknown> | undefined

  return {
    versionName: versionName ? stripColour(versionName) : null,
    protocol: typeof protocol === 'number' ? protocol : null,
    playersOnline: typeof players?.online === 'number' ? players.online : null,
    playersMax: typeof players?.max === 'number' ? players.max : null,
    motd: extractMotd(data.description),
    ready: pingIsReady(data),
    latencyMs: Date.now() - started,
  }
}

function rawStatus(port: number, host: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = new Socket()
    let chunks: Buffer[] = []
    let settled = false

    const done = (v: string | null) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(v)
    }

    sock.setTimeout(timeoutMs)
    sock.on('timeout', () => done(null))
    sock.on('error', () => done(null))

    sock.connect(port, host, () => {
      const hostBuf = Buffer.from(host, 'utf8')
      const payload = Buffer.concat([
        Buffer.from([0x00]),
        varint(767), // protocol version; any recent value is accepted for status
        varint(hostBuf.length),
        hostBuf,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        varint(1), // next state = status
      ])
      sock.write(Buffer.concat([varint(payload.length), payload]))
      sock.write(Buffer.concat([varint(1), Buffer.from([0x00])])) // status request
    })

    sock.on('data', (d: Buffer) => {
      chunks.push(Buffer.from(d))
      const buf = Buffer.concat(chunks)
      try {
        const r = new Reader(buf)
        r.varint() // packet length
        if (r.varint() !== 0x00) return done(null)
        const len = r.varint()
        if (r.remaining < len) return // wait for more
        done(r.take(len).toString('utf8'))
      } catch {
        // incomplete; wait for the next chunk
      }
    })

    sock.on('close', () => done(null))
  })
}
