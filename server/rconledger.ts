/**
 * A record of the RCON connections THIS dashboard opens for polling.
 *
 * Why a ledger and not a look at the log line:
 *
 * The obvious way to recognise our own RCON traffic is our source port, and it
 * cannot be done. No server logs it. Checked against all four platforms running
 * on this host:
 *
 *   Paper 1.21.4/1.21.11   Thread RCON Client /127.0.0.1 started
 *   Forge 1.20.1           Thread RCON Client /127.0.0.1 started
 *   Forge 1.7.10 (GTNH)    Rcon connection from: /127.0.0.1
 *
 * Every one of them logs the address and drops the port. The `#227` that Paper
 * and modern Forge print is the SERVER's own connection counter, not anything
 * about the client. So there is nothing in the text that distinguishes our
 * socket from any other RCON client on the same host.
 *
 * What we do have is our own side of it: we know exactly when we opened a
 * connection, what we sent, and when we closed it. That is what this records,
 * and it is what decides ownership. The log text is used only to find candidate
 * lines; it never decides whose they are.
 *
 * Two rules keep this honest:
 *
 *   1. Only POLLING is recorded. An operator's command through the RCON box goes
 *      through the same client but is deliberately not registered here, so it is
 *      never hidden from the console. Hiding what a person typed would be a much
 *      worse failure than showing some of our own noise.
 *
 *   2. It fails OPEN. A line that cannot be attributed to a window is treated as
 *      the server's, and shown.
 */

/** Keep enough history for a console backlog to be classified against it. */
const RETAIN_MS = 10 * 60_000

/**
 * The log line lands slightly after the socket event that caused it: the tailer
 * polls at 250 ms and batches at 100 ms, and the JVM flushes its own appender on
 * its own schedule. The window is widened at both ends to cover that.
 *
 * Widening trades one error for the other. Too narrow and our own noise leaks
 * through, which is untidy. Too wide and a person's command issued in the same
 * second could be attributed to us, which is a real loss. Three seconds is set
 * against the observed lag, and command lines additionally have to match a
 * command we actually send, so the wide end is not load-bearing on its own.
 */
const LEAD_MS = 1_000
const TRAIL_MS = 3_000

export interface ProbeWindow {
  serverId: string
  start: number
  end: number
  /** The commands we issued on this connection. */
  commands: string[]
}

const windows: ProbeWindow[] = []

/** Commands this dashboard issues while polling, across every platform. */
const PROBE_COMMANDS = new Set(['list', 'tps', 'forge tps', 'cofh tps'])

export function isProbeCommand(command: string): boolean {
  return PROBE_COMMANDS.has(command.trim().toLowerCase().replace(/^\//, ''))
}

export interface ProbeHandle {
  command(text: string): void
  end(): void
}

/**
 * Open a window. Call this around a POLLING connection only.
 *
 * Returns a handle rather than an id so a caller cannot forget which window it
 * is writing to, and so `end()` is idempotent.
 */
export function beginProbe(serverId: string): ProbeHandle {
  const w: ProbeWindow = { serverId, start: Date.now(), end: Number.POSITIVE_INFINITY, commands: [] }
  windows.push(w)
  prune()
  let ended = false
  return {
    command(text: string) {
      w.commands.push(text.trim().toLowerCase())
    },
    end() {
      if (ended) return
      ended = true
      w.end = Date.now()
    },
  }
}

function prune(): void {
  const cutoff = Date.now() - RETAIN_MS
  let i = 0
  while (i < windows.length && windows[i]!.end < cutoff) i++
  if (i > 0) windows.splice(0, i)
}

/**
 * Was this dashboard polling `serverId` at `at`?
 *
 * `at` is the moment the line ARRIVED, not a timestamp parsed out of the line.
 * Parsing the log's own clock would mean handling three different formats, a
 * missing date on two of them, and midnight rollover, to end up with the same
 * answer the arrival time already gives.
 */
export function wasPolling(serverId: string, at: number): boolean {
  for (const w of windows) {
    if (w.serverId !== serverId) continue
    const end = Number.isFinite(w.end) ? w.end : Date.now()
    if (at >= w.start - LEAD_MS && at <= end + TRAIL_MS) return true
  }
  return false
}

/** Did we send exactly this command to this server around then? */
export function weSentCommand(serverId: string, command: string, at: number): boolean {
  const needle = command.trim().toLowerCase().replace(/^\//, '')
  for (const w of windows) {
    if (w.serverId !== serverId) continue
    const end = Number.isFinite(w.end) ? w.end : Date.now()
    if (at < w.start - LEAD_MS || at > end + TRAIL_MS) continue
    if (w.commands.some((c) => c.replace(/^\//, '') === needle)) return true
  }
  return false
}

/** Test seam. Not used in production. */
export function _reset(): void {
  windows.length = 0
}

/** Test seam: inject a window with explicit times. */
export function _record(w: ProbeWindow): void {
  windows.push(w)
}
