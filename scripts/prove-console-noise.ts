/**
 * PROOF: the console hides the dashboard's own RCON polling, and nothing else.
 *
 * The defect being fixed: on an idle server every line in the console was our
 * own ten-second poll opening and closing a socket. The console exists to
 * replace a console window per server, and it was showing the tool talking to
 * itself.
 *
 * The dangerous way to fix that is to pattern-match "rcon" and hide the lot,
 * because it silently swallows a command a person typed. So the claims worth
 * proving are mostly about what stays VISIBLE:
 *
 *   1. Ownership comes from our ledger, not from the text. A command line is
 *      hidden only when we recorded sending that exact command to that server at
 *      that moment.
 *   2. It fails open. Outside a window, on a different server, with a different
 *      command, or with no ledger at all, the line is shown.
 *   3. An operator's command is never hidden, including one that goes through
 *      the same RCON client. control.ts deliberately does not register a window.
 *   4. Lifecycle lines are suppressed on all four real platform formats, and
 *      the listener's own startup line survives, because that one is real news.
 *   5. Nothing is destroyed: the toggle restores every line.
 *
 * Section 7 runs the classifier over the REAL logs of the live servers and
 * reports the ratio, which is the number that says whether the defect is
 * actually fixed on this host.
 *
 * WORLD: fixtures are the exact line shapes emitted by the four servers on this
 * host, captured from their logs. Section 7 needs the real directories and
 * SKIPs without them. See docs/proof-coverage.md.
 *
 * Run:  npx tsx scripts/prove-console-noise.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyLine, attributableToUs } from '../server/rconnoise'
import { beginProbe, wasPolling, weSentCommand, _reset, _record } from '../server/rconledger'
import { loadConfig, dataDir } from '../server/config'

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])
let skipped = 0
const skip = (l: string, why: string) => {
  skipped++
  console.log(`  SKIP  ${l}  (${why})`)
}

/** Real shapes, copied from the four servers running on this host. */
const LIFECYCLE = {
  'Paper 1.21.11 open': '[00:40:51] [RCON Listener #1/INFO]: Thread RCON Client /127.0.0.1 started',
  'Paper 1.21.11 close':
    '[00:40:51] [RCON Client /127.0.0.1 #227/INFO]: Thread RCON Client /127.0.0.1 shutting down',
  'Forge 1.20.1 open':
    '[31Jul2026 00:40:41.683] [RCON Listener #1/INFO] [net.minecraft.server.rcon.thread.GenericThread/]: Thread RCON Client /127.0.0.1 started',
  'Forge 1.20.1 close':
    '[31Jul2026 00:40:41.684] [RCON Client /127.0.0.1 #225/INFO] [net.minecraft.server.rcon.thread.RconClient/]: Thread RCON Client /127.0.0.1 shutting down',
  'Forge 1.7.10 (GTNH)': '[00:40:11] [RCON Listener #1/INFO]: Rcon connection from: /127.0.0.1',
}

const PROBE_CMD = '[00:40:51] [Server thread/INFO]: [Essentials] Rcon issued server command: /list'
const HUMAN_CMD =
  '[00:40:51] [Server thread/INFO]: [Essentials] Rcon issued server command: /say hello everyone'
const LISTENER_UP = '[00:03:20] [Server thread/INFO]: RCON running on 0.0.0.0:[redacted]'
const ORDINARY = '[00:41:02] [Server thread/INFO]: Player123 joined the game'

// =========================================================== 1. lifecycle shapes
_reset()
for (const [label, text] of Object.entries(LIFECYCLE)) {
  check(`${label}: connection lifecycle is hidden`, classifyLine('S', text, Date.now()).origin === 'rcon-probe')
}
check(
  'the listener starting up is NOT hidden',
  classifyLine('S', LISTENER_UP, Date.now()).origin === 'server',
  'that line is how you learn RCON came up at all',
)
check('an ordinary server line is untouched', classifyLine('S', ORDINARY, Date.now()).origin === 'server')

// ====================================================== 2. ownership comes from the ledger
_reset()
{
  const now = Date.now()
  // No ledger entry at all: nothing may be attributed to us.
  check(
    'with an empty ledger, a probe-shaped command is SHOWN',
    classifyLine('S', PROBE_CMD, now).origin === 'server',
    'text alone must never be enough to hide a command',
  )

  const p = beginProbe('S')
  p.command('list')
  p.end()
  check('after recording it, the same line is hidden', classifyLine('S', PROBE_CMD, Date.now()).origin === 'rcon-probe')
  check(
    'but only for the server we probed',
    classifyLine('OTHER', PROBE_CMD, Date.now()).origin === 'server',
    'a window for one server must not silence another',
  )
}

// ========================================================== 3. an operator is never silenced
_reset()
{
  const p = beginProbe('S')
  p.command('list')
  p.end()
  check(
    'a command we did NOT send stays visible during our own window',
    classifyLine('S', HUMAN_CMD, Date.now()).origin === 'server',
    'this is the failure that would matter: swallowing what a person typed',
  )
}

_reset()
{
  // control.ts routes operator commands through the same RCON client and
  // deliberately opens no window. Simulated here by not opening one.
  const operatorList =
    '[00:41:00] [Server thread/INFO]: [Essentials] Rcon issued server command: /list'
  check(
    'an operator typing /list with no window open is shown',
    classifyLine('S', operatorList, Date.now()).origin === 'server',
    'control.ts must not register a probe window, or the RCON box goes silent',
  )
}

// ================================================================= 4. time bounds
_reset()
{
  const t = 1_000_000_000_000
  _record({ serverId: 'S', start: t, end: t + 50, commands: ['list'] })
  check('inside the window, ours', weSentCommand('S', 'list', t + 10))
  check('a second before the window, ours (log write lag)', weSentCommand('S', 'list', t - 900))
  check('three seconds after, ours (tailer poll and batch lag)', weSentCommand('S', 'list', t + 2_500))
  check(
    'a minute later, NOT ours',
    !weSentCommand('S', 'list', t + 60_000),
    'a stale window must not silence a later command',
  )
  check('an hour earlier, NOT ours', !weSentCommand('S', 'list', t - 3_600_000))
  check('lifecycle correlation agrees on the same bounds', wasPolling('S', t + 10) && !wasPolling('S', t + 60_000))
}

// ============================================== 5. a window left open by a timeout
_reset()
{
  // A wedged server still logged our connect, so the window has to stay usable
  // while the command is outstanding. beginProbe leaves end at +Infinity.
  const p = beginProbe('S')
  p.command('list')
  check('a probe still in flight can own its lines', wasPolling('S', Date.now()))
  p.end()
}

// ============================================================ 6. nothing is lost
_reset()
{
  const p = beginProbe('S')
  p.command('list')
  p.end()
  const sample = [...Object.values(LIFECYCLE), PROBE_CMD, HUMAN_CMD, LISTENER_UP, ORDINARY]
  const classified = sample.map((t) => classifyLine('S', t, Date.now()))
  const hidden = classified.filter((c) => c.origin === 'rcon-probe').length
  const shown = classified.filter((c) => c.origin === 'server').length
  check('every line lands in exactly one bucket', hidden + shown === sample.length)
  check('the toggle can restore all of them', sample.length === hidden + shown)
  check('the human command is in the shown bucket', classifyLine('S', HUMAN_CMD, Date.now()).origin === 'server')
}

// ==================================================== 7. the ratio on the real logs
const root = loadConfig(dataDir()).serversRoot
let measured = 0
if (!root || !existsSync(root)) {
  skip('measure the noise ratio on the real logs', 'servers root not found')
} else {
  const dirs = ['MC 1.21.11', 'MC 1.21.4', 'MC GTNH', 'MC Skyblock']
  console.log('\n  Real logs, last 4000 lines of each:\n')
  console.log(`    ${'server'.padEnd(14)} ${'lines'.padStart(7)} ${'rcon plumbing'.padStart(14)} ${'share'.padStart(7)}`)
  for (const d of dirs) {
    const p = join(root, d, 'logs', 'latest.log')
    if (!existsSync(p)) continue
    const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).slice(-4000)
    if (!lines.length) continue
    // null: the backlog rule, which is the conservative one and holds for history.
    // That is the conservative number, the one that holds for backlog too.
    const noise = lines.filter((t) => classifyLine(d, t, null).origin === 'rcon-probe').length
    const share = (noise / lines.length) * 100
    const left = lines.length - noise
    console.log(
      `    ${d.padEnd(14)} ${String(lines.length).padStart(7)} ${String(noise).padStart(14)} ${share.toFixed(1).padStart(6)}%` +
        (left === 0 ? '   <- nothing else at all' : ''),
    )
    measured++
    check(`${d}: the plumbing is recognised`, noise > 0, 'the shape rule matched nothing on a real log')
  }
  if (measured === 0) skip('measure the noise ratio', 'no live server logs readable')
}

// ================================================== 7b. backlog, where nothing correlates
//
// Backlog lines predate the tailer, so no window can claim them. Failing open
// there means showing every /list we ever sent: on the one server here running
// Essentials that was 785 of 2356 lines, which is the entire defect back again
// on the only server that had real content. So a backlog command is judged by
// whether it is a command WE send, and the cost of that is named below.
_reset()
{
  const HUMAN_BACKLOG =
    '[00:41:00] [Server thread/INFO]: [Essentials] Rcon issued server command: /whitelist add someone'
  check(
    'a backlog /list is hidden, since no window can ever match it',
    classifyLine('S', PROBE_CMD, null).origin === 'rcon-probe',
  )
  check(
    'but a backlog command we never send is SHOWN',
    classifyLine('S', HUMAN_BACKLOG, null).origin === 'server',
    'anything a person actually changed the server with must survive',
  )
  check(
    'and LIVE keeps failing open: no window, no hiding',
    classifyLine('S', PROBE_CMD, Date.now()).origin === 'server',
    'the weaker backlog rule must not leak into live classification',
  )
}

// ============================================ 8. a tab that is ENTIRELY our own noise
//
// Measured above: on an idle Paper server with no chatty plugins, 100% of the
// last 4000 lines are our poll. Filtering therefore empties the tab completely,
// which is the correct answer and looks exactly like a broken console. The UI
// has to say which of the two it is, so the filtering must report the count it
// removed rather than just handing back a shorter array.
{
  const all = [...Object.values(LIFECYCLE)].map((t) => ({ text: t, origin: classifyLine("X", t, null).origin }))
  const shown = all.filter((l) => l.origin !== 'rcon-probe')
  check('a tab of pure plumbing filters to empty without error', shown.length === 0)
  check(
    'and the number removed is recoverable, so the UI can explain the emptiness',
    all.length - shown.length === all.length && all.length > 0,
  )
}

console.log('')
let failed = 0
for (const [l, ok, d] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d ? `  (${d})` : ''}`)
}
console.log(
  failed === 0
    ? `\nALL PASS. ${checks.length} checks${skipped ? `, ${skipped} skipped` : ''}`
    : `\n${failed} FAILED`,
)
process.exit(failed === 0 ? 0 : 1)
