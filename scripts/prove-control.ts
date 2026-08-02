/**
 * PROOF: the control routes, end to end against a real service.
 *
 * `prove-concurrent-start.ts` proves the guard's decisions and the lock.
 * This proves the HTTP surface around them: the role gate, the CSRF header, the
 * refusal codes, the audit trail, and. The part that matters most, that a
 * refusal from the guard reaches the user as the guard's own sentence rather than
 * a generic error.
 *
 * WHAT THIS DOES NOT DO: start or stop a real server. Every mutating call here
 * targets a directory that is either not running or has no launcher, so the
 * expected outcome is a refusal. The one live restart is deliberately left to a
 * human decision, run by hand, and reported separately. A proof script that
 * restarts a production server as a side effect of `npm test` is a bad trade.
 *
 * WORLD: production. The identity signals underneath these routes behave
 * differently for task-started and hand-started servers (spec §14), so this
 * asserts the same world prove-identity does. See docs/proof-coverage.md.
 *
 * Run:  npx tsx scripts/prove-control.ts
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API, SESSION_COOKIE, CSRF_HEADER } from '../shared/api'

const DATA = mkdtempSync(join(tmpdir(), 'mcdash-control-'))
process.env.MCDASH_DATA_DIR = DATA

const { loadConfig, dataDir } = await import('../server/config')
const { buildServer } = await import('../server/http')
const { bootstrapIfEmpty, loadUsers, saveUsers, hashPassword } = await import('../server/auth')
const { describeWorld, printWorld } = await import('./world')
const { scanJvms } = await import('../server/platform')
const { indexTasks, detectLauncher } = await import('../server/launcher')

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])

const cfg = loadConfig(dataDir())
const boot = await bootstrapIfEmpty(dataDir())
if (!boot) {
  console.error('bootstrap produced no admin')
  process.exit(1)
}

const VIEWER_PW = 'viewer-password-for-the-proof'
saveUsers(dataDir(), [
  ...loadUsers(dataDir()),
  {
    username: 'viewer1',
    role: 'viewer',
    password: await hashPassword(VIEWER_PW),
    createdAt: new Date().toISOString(),
    mustChangePassword: false,
  },
])

const app = await buildServer({ cfg, version: 'proof' })
await app.listen({ host: '127.0.0.1', port: 0 })
const addr = app.server.address()
const BASE = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`

async function signIn(username: string, password: string): Promise<string> {
  const res = await fetch(BASE + API.login, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
    body: JSON.stringify({ username, password }),
  })
  const c = res.headers.get('set-cookie')?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1]
  if (!c) throw new Error(`could not sign in as ${username}: ${res.status}`)
  return `${SESSION_COOKIE}=${c}`
}
const admin = await signIn(boot.username, boot.password)
const viewer = await signIn('viewer1', VIEWER_PW)

type Snap = {
  servers: Array<{
    id: string
    name: string
    health: string
    launchStrategy: string
    launchDetail: string
    controlBusy: boolean
  }>
  doubleSpawn: unknown[]
}
const snap = (await (await fetch(BASE + API.snapshot, { headers: { cookie: admin } })).json()) as Snap

// -------------------------------------------------------------- world check

const scan = await scanJvms([])
printWorld(describeWorld(scan.jvms))
check('the servers under test are started the way production starts them', describeWorld(scan.jvms).isProduction)

// ------------------------------------------------------- launcher detection

console.log('\n--- launcher detection')
const tasks = await indexTasks()
for (const s of snap.servers) {
  console.log(`  ${s.name.padEnd(18)} ${s.launchStrategy.padEnd(14)} ${s.health}`)
}
check('every server reports a launch strategy', snap.servers.every((s) => !!s.launchStrategy))
check(
  'a strategy of "none" always comes with an explanation',
  snap.servers.every((s) => s.launchStrategy !== 'none' || s.launchDetail.length > 40),
)
check('no server is reported busy on a quiet system', snap.servers.every((s) => !s.controlBusy))
check('no double-spawn alert on a clean system', snap.doubleSpawn.length === 0)

// A running server whose directory has a scheduled task must be detected as
// windows-task: starting it any other way produces a materially different
// process (spec §14). But "every running server is task-started" stopped being
// true of this machine on 2026-08-02, when the Create page made a server that
// runs from its start script -- so the assertion is split by what the task
// index actually says, instead of assuming the fleet's shape.
const running = snap.servers.filter((s) => s.health === 'HEALTHY' || s.health === 'STALLED')
console.log(`  ${running.length} running servers`)
const liveTaskIndex = await indexTasks(0)
const nrm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
const hasOwnTask = (dir: string) => liveTaskIndex.has(nrm(dir))
check(
  'a running, task-started server is detected as windows-task, not script',
  running.every((s) => !hasOwnTask(s.dir) || s.launchStrategy === 'windows-task'),
  running.map((s) => `${s.name}=${s.launchStrategy}`).join(', '),
)
check(
  'a running server with no task of its own is never claimed as windows-task',
  running.every((s) => hasOwnTask(s.dir) || s.launchStrategy !== 'windows-task'),
  running.map((s) => `${s.name}=${s.launchStrategy}`).join(', '),
)
// The task enumeration costs ~870 ms and was the slowest thing in a ten-second
// scan loop. Cached, with control actions forcing a fresh read -- so both the
// cache and the bypass are asserted, because a cache that cannot be bypassed
// means a task created a minute ago is invisible to the button that needs it.
{
  const { invalidateTaskIndex, TASK_CACHE_MS } = await import('../server/launcher')
  invalidateTaskIndex()
  const cold = Date.now()
  await indexTasks()
  const coldMs = Date.now() - cold
  const warm = Date.now()
  await indexTasks()
  const warmMs = Date.now() - warm
  console.log(`  task index: cold ${coldMs} ms, warm ${warmMs} ms (ttl ${TASK_CACHE_MS} ms)`)
  check('the task index is cached', warmMs < Math.max(50, coldMs / 4), `cold ${coldMs}, warm ${warmMs}`)
  const forced = Date.now()
  await indexTasks(0)
  const forcedMs = Date.now() - forced
  check(
    'and maxAge 0 forces a fresh read, so a new task is not invisible',
    forcedMs > warmMs,
    `forced ${forcedMs} ms vs warm ${warmMs} ms`,
  )
  const src = readFileSync(new URL('../server/http.ts', import.meta.url), 'utf8')
  check('the control routes use the forcing form', /indexTasks\(0\)/.test(src))
}

check(
  'detectLauncher agrees with the snapshot',
  snap.servers.every((s) => {
    const server = snap.servers.find((x) => x.id === s.id)!
    const dir = join(cfg.serversRoot, server.name)
    return detectLauncher(dir, tasks).strategy === s.launchStrategy
  }),
)

// ------------------------------------------------------------ the auth gate

console.log('\n--- the gate')

const stopped = snap.servers.find((s) => s.health === 'DOWN')
if (!stopped) {
  /**
   * This proof's world is PRODUCTION: it aims real refusals at a real
   * stopped server. A machine with no fleet (a CI runner, a fresh clone)
   * cannot provide that world, and a proof that cannot run must say so
   * rather than fail as though the code were broken, or pass as though it
   * had checked something. Same SKIP convention as prove-backup-policy.
   */
  console.log('\n  SKIP  this proof needs a real fleet with at least one stopped server.')
  console.log('        Nothing was checked here. Run it on the host that has the servers.')
  process.exit(0)
}
console.log(`  aiming refusals at ${stopped.name} (${stopped.health}, launcher ${stopped.launchStrategy})`)

const url = (id: string, action: string) => `${BASE}/api/servers/${encodeURIComponent(id)}/${action}`

async function post(u: string, cookie: string | null, csrf: boolean, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie
  if (csrf) headers[CSRF_HEADER] = '1'
  const res = await fetch(u, { method: 'POST', headers, body: body ? JSON.stringify(body) : '{}' })
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    /* empty body is fine */
  }
  return { status: res.status, json: json as Record<string, unknown> | null }
}

for (const action of ['start', 'stop', 'restart']) {
  const anon = await post(url(stopped.id, action), null, true)
  check(`${action}: unauthenticated is refused`, anon.status === 401, `${anon.status}`)
  const asViewer = await post(url(stopped.id, action), viewer, true)
  check(`${action}: a viewer is refused`, asViewer.status === 403, `${asViewer.status}`)
  const noCsrf = await post(url(stopped.id, action), admin, false)
  check(`${action}: an admin without the CSRF header is refused`, noCsrf.status === 403, `${noCsrf.status}`)
}

const badId = await post(url('No Such Directory', 'start'), admin, true)
check('an unknown server id is a 404', badId.status === 404, `${badId.status}`)

// ---------------------------------------------------------- guard refusals

console.log('\n--- refusals reach the user as the guard\'s own words')

// Stopping something that is not running. Expected refusal, with a reason.
const stopIdle = await post(url(stopped.id, 'stop'), admin, true)
console.log(`  stop a stopped server: ${stopIdle.status}. ${String(stopIdle.json?.detail ?? '')}`)
check('stopping a stopped server is a 409, not a 500', stopIdle.status === 409, `${stopIdle.status}`)
check('and explains itself', /nothing to stop|not running/i.test(String(stopIdle.json?.detail ?? '')))
check('the response names the action', stopIdle.json?.action === 'stop')

// A server whose launcher is unknown must refuse to start rather than guess.
const noLauncher = snap.servers.find((s) => s.launchStrategy === 'none')
if (noLauncher) {
  const r = await post(url(noLauncher.id, 'start'), admin, true)
  console.log(`  start ${noLauncher.name} (no launcher): ${r.status}. ${String(r.json?.detail ?? '')}`)
  check('a server with no known launcher refuses to start', r.status === 409)
  check('and says it will not guess', /will not try to start it|no launcher is known/i.test(String(r.json?.detail ?? '')))
} else {
  console.log('  (no server with an unknown launcher on this host; case not exercised)')
}

// Starting something that IS running. This is the case that would corrupt a world.
const live = running[0]
if (live) {
  const r = await post(url(live.id, 'start'), admin, true)
  console.log(`  start ${live.name} (already running): ${r.status}. ${String(r.json?.detail ?? '')}`)
  check('starting an already-running server is refused', r.status === 409, `${r.status}`)
  check(
    'and the refusal names the running pid',
    /pid \d+/.test(String(r.json?.detail ?? '')),
    String(r.json?.detail ?? ''),
  )
  check(
    'and says why, in terms of the world',
    /second process against the same world|corrupts/i.test(String(r.json?.detail ?? '')),
  )
}

// ------------------------------------------------------------ rcon commands

console.log('\n--- rcon command input')

const cmdUrl = `${BASE}${API.runCommand(live ? live.id : stopped.id)}`
check(
  'a viewer cannot send a command',
  (await post(cmdUrl, viewer, true, { command: 'list' })).status === 403,
)
check(
  'an empty command is rejected before it reaches RCON',
  (await post(cmdUrl, admin, true, { command: '' })).status === 400,
)
check(
  'a non-string command is rejected',
  (await post(cmdUrl, admin, true, { command: 42 })).status === 400,
)

if (live) {
  const list = await post(cmdUrl, admin, true, { command: 'list' })
  console.log(`  list → ${list.status} ${String(list.json?.raw ?? '').trim().slice(0, 70)}`)
  check('an admin can run a read-only command', list.status === 200, `${list.status}`)
  check('and gets the server\'s reply back', /There are/i.test(String(list.json?.raw ?? '')))
  check('with the main-thread latency alongside it', typeof list.json?.latencyMs === 'number')

  // `stop` via the command box would bypass the lock and the exit verification,
  // and the UI would go on showing a shutting-down server as healthy.
  const rawStop = await post(cmdUrl, admin, true, { command: 'stop' })
  console.log(`  stop via command box → ${rawStop.status}. ${String(rawStop.json?.detail ?? '')}`)
  check('`stop` is refused from the command box', rawStop.status === 400, `${rawStop.status}`)
  check(
    'and points at the button that verifies the exit',
    /Use the Stop button/i.test(String(rawStop.json?.detail ?? '')),
  )
  const rawRestart = await post(cmdUrl, admin, true, { command: ' RESTART ' })
  check('`restart` is refused too, case and space insensitive', rawRestart.status === 400)
}

// ------------------------------------------------------------------- audit

console.log('\n--- audit')
const lines = readFileSync(join(DATA, 'audit.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>)
const control = lines.filter((e) => String(e.action ?? '').startsWith('control.'))
for (const e of control.slice(0, 12)) {
  console.log(`  ${String(e.action).padEnd(26)} ${String(e.outcome).padEnd(7)} ${String(e.target)}`)
}
check('control actions are audited', control.length > 0)
check(
  'a request is audited BEFORE its outcome is known',
  control.some((e) => String(e.action).endsWith('.requested')),
  'a start that hangs for two minutes must not be invisible until it finishes',
)
check('viewer refusals are audited', control.some((e) => e.outcome === 'denied' && e.role === 'viewer'))
check(
  'the command text is recorded',
  !live || control.some((e) => e.action === 'control.command' && /list/.test(String(e.detail ?? ''))),
)
check(
  'but the command OUTPUT is not: `list` returns player names',
  !control.some((e) => /There are \d+/i.test(String(e.detail ?? ''))),
)
check(
  'no audit line contains a password',
  !lines.some((e) => JSON.stringify(e).toLowerCase().includes(VIEWER_PW.toLowerCase())),
)

await app.close()

console.log('')
let failed = 0
for (const [l, ok, d] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d ? `  (${d})` : ''}`)
}
console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
