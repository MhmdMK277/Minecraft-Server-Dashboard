/**
 * The one live exercise of the production start path: restart a real server
 * through the real control module, via its real scheduled task.
 *
 * NOT part of the proof suite, and deliberately not wired into an `npm run
 * prove-*` name. It takes a real server offline for as long as that server takes
 * to boot, so it is a decision a person makes, not a side effect of running tests.
 *
 * It refuses to run if anyone is online. That check is the whole reason this is a
 * script rather than something done by hand: "is anybody playing right now" is
 * exactly the question a human forgets to ask.
 *
 * Everything below this is the real thing. The real launcher detection, the real
 * lock, the real pre-check, the real post-start verification. The only reason it
 * exists separately from prove-control.ts is that prove-control must be safe to
 * run at any time.
 *
 * Usage:  npx tsx scripts/live-restart.ts "MC Skyblock"
 */
import { join } from 'node:path'
import { loadConfig, dataDir } from '../server/config'
import { indexTasks, detectLauncher } from '../server/launcher'
import { restartServer, occupancyOf, resetLocks } from '../server/control'
import { rconConfig } from '../server/properties'
import { Rcon } from '../server/rcon'
import { parsePlayerCount } from '../server/parse'

const name = process.argv[2]
if (!name) {
  console.error('usage: npx tsx scripts/live-restart.ts "<server directory name>"')
  process.exit(2)
}

const cfg = loadConfig(dataDir())
const dir = join(cfg.serversRoot, name)
const target = { id: name, name, dir }

console.log(`server   : ${name}`)
console.log(`directory: ${dir}`)

const tasks = await indexTasks()
const launcher = detectLauncher(dir, tasks)
console.log(`launcher : ${launcher.strategy}${launcher.strategy === 'windows-task' ? ` (${launcher.taskName})` : ''}`)
if (launcher.strategy !== 'windows-task') {
  console.error('This script exists to exercise the windows-task path. Refusing to run against anything else.')
  process.exit(1)
}

const before = await occupancyOf(dir)
console.log(`running  : pids ${before.pids.join(', ') || 'none'} (certain=${before.certain})`)
if (before.pids.length !== 1) {
  console.error('Expected exactly one running JVM before a restart. Aborting.')
  process.exit(1)
}

// Nobody online, or nothing happens. Checked directly rather than from the
// cached snapshot, which may be ten seconds old.
const rc = rconConfig(dir)
if (!rc) {
  console.error('RCON is not configured, so this server cannot be restarted cleanly. Aborting.')
  process.exit(1)
}
const conn = await Rcon.connect(rc.port, rc.password, '127.0.0.1', 10_000)
let online = -1
try {
  const res = await conn.run('list', 10_000)
  // A reply we cannot parse leaves `online` at -1, which fails the check below.
  // "I could not tell how many people are on" must not read as "nobody is on".
  online = parsePlayerCount(res.raw).online ?? -1
  console.log(`players  : ${online}. ${res.raw.trim().slice(0, 80)}`)
} finally {
  conn.close()
}
if (online !== 0) {
  console.error(`\n${online} player(s) online. Refusing to restart. Try again when the server is empty.`)
  process.exit(1)
}

console.log('\nrestarting through the real control path ...')
const t0 = Date.now()
resetLocks()
const result = await restartServer(target, launcher)
const took = Math.round((Date.now() - t0) / 1000)

console.log(`\n${result.ok ? 'OK' : 'FAILED'} after ${took}s`)
console.log(`  ${result.detail}`)

const after = await occupancyOf(dir)
console.log(`\nafter    : pids ${after.pids.join(', ') || 'none'} (certain=${after.certain})`)
const changed = after.pids.length === 1 && after.pids[0] !== before.pids[0]
console.log(`pid changed: ${changed} (${before.pids[0]} -> ${after.pids[0] ?? 'none'})`)

// Confirm it is actually serving again, not merely present. A process that exists
// is not a server that works -- that distinction is the whole premise of this
// project.
if (after.pids.length === 1) {
  try {
    const c2 = await Rcon.connect(rc.port, rc.password, '127.0.0.1', 20_000)
    try {
      const res = await c2.run('list', 20_000)
      console.log(`rcon     : answering. ${res.raw.trim().slice(0, 60)} (${res.latencyMs} ms)`)
    } finally {
      c2.close()
    }
  } catch (e) {
    console.log(`rcon     : NOT answering yet (${e instanceof Error ? e.message : 'failed'}). It may still be loading`)
  }
}

process.exit(result.ok && changed ? 0 : 1)
