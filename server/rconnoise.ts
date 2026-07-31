import { isProbeCommand, wasPolling, weSentCommand } from './rconledger'
import type { LineOrigin } from '@shared/api'

/**
 * Deciding which console lines are the dashboard talking to itself.
 *
 * The console exists to replace a console window per server. It was failing at
 * that: on an idle server every single line was RCON plumbing from our own
 * ten-second poll, roughly a thousand lines an hour per server, and the real
 * output was buried under it. That is a product defect, not a display
 * preference, which is why the default changed rather than a filter being added.
 *
 * There are two kinds of RCON line and they are treated differently on purpose.
 *
 * CONNECTION LIFECYCLE, e.g.
 *     [RCON Listener #1/INFO]: Thread RCON Client /127.0.0.1 started
 *     [RCON Client /127.0.0.1 #227/INFO]: Thread RCON Client ... shutting down
 *     [RCON Listener #1/INFO]: Rcon connection from: /127.0.0.1
 *
 *   These say "a socket opened" and nothing else. They carry no information
 *   about the server's behaviour whoever opened them, so they are suppressed by
 *   shape and need no attribution at all. Attribution would be undecidable for
 *   them anyway: no server logs the client port (see server/rconledger.ts).
 *
 * COMMANDS, e.g.
 *     [Server thread/INFO]: [Essentials] Rcon issued server command: /list
 *
 *   These DO carry information, and one of them may be something a person typed.
 *   A command is hidden only when the ledger says we sent that exact command to
 *   that server at that moment. Everything else is shown, including a person's
 *   `/list`, and including our own probe if the correlation is not certain.
 *
 * The failure this is designed against is hiding an operator's command. Showing
 * some of our own noise is untidy; swallowing what a person typed is a lie about
 * what happened on the server.
 */

/** A connection opening or closing. Contentless on every platform. */
const LIFECYCLE = [
  // Paper and modern Forge, both directions.
  /Thread RCON Client\b/i,
  // 1.7.10 (GTNH).
  /\bRcon connection from:/i,
  // The listener announcing itself at boot is kept: it tells you RCON is up.
  // Only the per-connection chatter is matched here.
]

/** `[Essentials] Rcon issued server command: /list` and its variants. */
const COMMAND = /Rcon issued server command:\s*(.+?)\s*$/i

/** The listener's own startup line, which is real information and stays. */
const LISTENER_READY = /RCON running on\b|Starting remote control listener/i

export interface Classified {
  origin: LineOrigin
  /** The command, when the line is one. Exposed for the proof. */
  command: string | null
}

/**
 * `arrivedAt` is null for BACKLOG: lines written before the tailer existed, which
 * no window can be correlated against.
 *
 * That distinction has to be explicit, because the two cases want opposite
 * defaults and the first version got it wrong by treating them the same.
 *
 * LIVE, no window matched: show it. Our own probe leaking through occasionally
 * is untidy; hiding a command a person typed is a lie about what happened.
 *
 * BACKLOG: correlation is impossible, so failing open means showing every
 * `/list` we ever sent. On a server running Essentials, which logs every RCON
 * command, that was 785 of 2356 lines, and it is the whole defect back again on
 * the one server that had real content. So a backlog command is hidden when it
 * is one of the commands this dashboard actually sends.
 *
 * The cost is bounded and named: an operator's own historical `/list`,
 * `forge tps` or `cofh tps` is hidden too. Those are read-only commands whose
 * absence from scrollback costs nothing, the toggle brings them straight back,
 * and no other command is affected. Anything a person actually changed the
 * server with survives.
 */
export function classifyLine(
  serverId: string,
  text: string,
  arrivedAt: number | null,
): Classified {
  if (LISTENER_READY.test(text)) return { origin: 'server', command: null }

  const cmd = COMMAND.exec(text)
  if (cmd) {
    const command = cmd[1]!.trim()
    if (arrivedAt === null) {
      return { origin: isProbeCommand(command) ? 'rcon-probe' : 'server', command }
    }
    // Live: ours only if the ledger says so.
    const ours = weSentCommand(serverId, command, arrivedAt)
    return { origin: ours ? 'rcon-probe' : 'server', command }
  }

  if (LIFECYCLE.some((re) => re.test(text))) {
    return { origin: 'rcon-probe', command: null }
  }

  return { origin: 'server', command: null }
}

/**
 * Whether a lifecycle line can additionally be tied to one of our windows.
 *
 * Not used to decide visibility, since lifecycle lines are suppressed either
 * way. It exists so the proof can show that the ledger genuinely correlates
 * with what the servers logged, rather than the shape rule quietly doing all the
 * work and the ledger being decorative.
 */
export function attributableToUs(serverId: string, text: string, arrivedAt: number): boolean {
  if (!LIFECYCLE.some((re) => re.test(text))) return false
  return wasPolling(serverId, arrivedAt)
}

export { isProbeCommand }
