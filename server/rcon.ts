import { Socket } from 'node:net'

/**
 * Minimal RCON client.
 *
 * Its value here is NOT the command output -- it is the round-trip latency.
 * RCON commands are queued onto the main server thread, so a prompt reply is
 * direct evidence the main thread is ticking. SLP cannot tell you that; it is
 * served by the network thread from a cached object. See docs/liveness-spec.md §8.
 *
 * SECURITY: the password is passed in, used, and never stored on the instance
 * beyond the connect call, never logged, and never returned.
 */

const TYPE_AUTH = 3
const TYPE_COMMAND = 2

export type RconResult = { raw: string; latencyMs: number }

export class Rcon {
  private sock: Socket
  private id = 0
  private constructor(sock: Socket) {
    this.sock = sock
  }

  static connect(port: number, password: string, host = '127.0.0.1', timeoutMs = 5000): Promise<Rcon> {
    return new Promise((resolve, reject) => {
      const sock = new Socket()
      let settled = false
      const fail = (e: Error) => {
        if (settled) return
        settled = true
        sock.destroy()
        reject(e)
      }
      sock.setTimeout(timeoutMs)
      sock.on('timeout', () => fail(new Error('rcon connect timeout')))
      sock.on('error', (e) => fail(e))
      sock.connect(port, host, () => {
        const r = new Rcon(sock)
        r.send(TYPE_AUTH, password, timeoutMs)
          .then(() => {
            if (settled) return
            settled = true
            resolve(r)
          })
          .catch(fail)
      })
    })
  }

  /** Round-trip a command and report how long the main thread took to answer. */
  async run(command: string, timeoutMs = 5000): Promise<RconResult> {
    const t0 = Date.now()
    const raw = await this.send(TYPE_COMMAND, command, timeoutMs)
    return { raw, latencyMs: Date.now() - t0 }
  }

  close(): void {
    this.sock.destroy()
  }

  private send(type: number, body: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      const bodyBuf = Buffer.from(body, 'utf8')
      const payload = Buffer.alloc(10 + bodyBuf.length)
      payload.writeInt32LE(id, 0)
      payload.writeInt32LE(type, 4)
      bodyBuf.copy(payload, 8)
      payload.writeUInt8(0, 8 + bodyBuf.length)
      payload.writeUInt8(0, 9 + bodyBuf.length)
      const frame = Buffer.alloc(4 + payload.length)
      frame.writeInt32LE(payload.length, 0)
      payload.copy(frame, 4)

      let acc = Buffer.alloc(0)
      let settled = false

      const cleanup = () => {
        clearTimeout(timer)
        this.sock.off('data', onData)
        this.sock.off('error', onErr)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        // Deliberately NOT destroying the socket: a timeout here usually means
        // the main thread is wedged, not that the connection is broken. The
        // caller wants to record that as STALLED, not as a transport error.
        reject(new Error('rcon command timeout'))
      }, timeoutMs)

      const onErr = (e: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(e)
      }

      const onData = (d: Buffer) => {
        acc = Buffer.concat([acc, d])
        while (acc.length >= 4) {
          const len = acc.readInt32LE(0)
          if (acc.length < 4 + len) return
          const pkt = acc.subarray(4, 4 + len)
          acc = acc.subarray(4 + len)
          const rid = pkt.readInt32LE(0)
          if (rid === -1) {
            if (settled) return
            settled = true
            cleanup()
            reject(new Error('rcon auth rejected'))
            return
          }
          const text = pkt.subarray(8, pkt.length - 2).toString('utf8')
          if (settled) return
          settled = true
          cleanup()
          resolve(text)
          return
        }
      }

      this.sock.on('data', onData)
      this.sock.on('error', onErr)
      this.sock.write(frame)
    })
  }
}
