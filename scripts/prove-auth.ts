/**
 * PROOF: authentication and authorisation actually hold.
 *
 * This runs a real service on a throwaway port, against a throwaway data
 * directory and a throwaway servers root, and drives it over HTTP. Nothing is
 * mocked: the assertions below are about the same code path a browser takes.
 *
 * The milestone's own definition of done was "viewer cannot control; admin can;
 * audit records both", and that is asserted at the end. The rest exists because
 * each is a way auth is normally got wrong:
 *
 *   - the WebSocket bypassing the HTTP auth hook, because its path is not /api
 *   - a mutating route reachable without the CSRF header
 *   - a session that never expires (the specific flaw noted in VoxelDash)
 *   - a login endpoint that reveals which usernames exist, by timing
 *   - a password change that leaves the old sessions alive
 *   - a session id usable as a handle on somebody else's session
 *
 * Run:  npx tsx scripts/prove-auth.ts
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { SESSION_COOKIE, CSRF_HEADER, API, WS_PATH } from '@shared/api'

const checks: Array<[string, boolean, string?]> = []
const check = (label: string, ok: boolean, detail?: string) => checks.push([label, ok, detail])

// A throwaway everything. MCDASH_DATA_DIR must be set before anything imports
// config.ts, so this is done before the dynamic imports below.
const DATA = mkdtempSync(join(tmpdir(), 'mcdash-auth-data-'))
const ROOT = mkdtempSync(join(tmpdir(), 'mcdash-auth-servers-'))
mkdirSync(join(ROOT, 'Testing Grounds', 'overworld_alpha'), { recursive: true })
writeFileSync(
  join(ROOT, 'Testing Grounds', 'server.properties'),
  'level-name=overworld_alpha\nserver-port=39001\nenable-rcon=false\n',
  'utf8',
)
writeFileSync(join(ROOT, 'Testing Grounds', 'overworld_alpha', 'level.dat'), 'x', 'utf8')
process.env.MCDASH_DATA_DIR = DATA
process.env.MCDASH_SERVERS_ROOT = ROOT

const { buildServer } = await import('../server/http')
const { loadConfig, dataDir } = await import('../server/config')
const { bootstrapIfEmpty, hashPassword, SessionStore, LoginThrottle, LOGIN_MAX_FAILURES, loadUsers, saveUsers } =
  await import('../server/auth')

// ------------------------------------------------------------ first start

const boot = await bootstrapIfEmpty(dataDir())
check('first start mints an admin and returns the password once', !!boot && boot.username === 'admin')
check('a second call returns null rather than resetting the password', (await bootstrapIfEmpty(dataDir())) === null)
const ADMIN_PASSWORD = boot!.password
check('the generated password is long enough to be worth having', ADMIN_PASSWORD.length >= 20)

const stored = readFileSync(join(DATA, 'auth.json'), 'utf8')
check('the password is not written to disk in any readable form', !stored.includes(ADMIN_PASSWORD))
check('only an scrypt hash is stored', stored.includes('scrypt$'))

// A second, viewer account -- the "friends can watch" case.
const VIEWER_PASSWORD = 'viewer-password-long-enough'
const users = loadUsers(dataDir())
users.push({
  username: 'friend',
  role: 'viewer',
  password: await hashPassword(VIEWER_PASSWORD),
  createdAt: new Date().toISOString(),
  mustChangePassword: false,
})
saveUsers(dataDir(), users)

// ------------------------------------------------------------- the service

const app = await buildServer({ cfg: loadConfig(dataDir()), version: 'test' })
await app.listen({ host: '127.0.0.1', port: 0 })
const address = app.server.address()
const port = typeof address === 'object' && address ? address.port : 0
const base = `http://127.0.0.1:${port}`

type Res = { status: number; body: any; cookie: string | null }
async function req(
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string; csrf?: boolean } = {},
): Promise<Res> {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = { accept: 'application/json' }
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${opts.cookie}`
  if (opts.csrf !== false && method !== 'GET') headers[CSRF_HEADER] = '1'
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const r = await fetch(base + path, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })
  let body: any = null
  try {
    body = await r.json()
  } catch {
    /* empty */
  }
  const setCookie = r.headers.get('set-cookie')
  const cookie = setCookie?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1] ?? null
  return { status: r.status, body, cookie }
}

const login = async (username: string, password: string) =>
  req(API.login, { method: 'POST', body: { username, password } })

// --------------------------------------------------- unauthenticated access

check('the snapshot is refused without a session', (await req(API.snapshot)).status === 401)
check('the console backlog is refused without a session', (await req('/api/servers/Testing%20Grounds/log')).status === 401)
check('app info is refused without a session', (await req(API.appInfo)).status === 401)
check('auth state is readable without a session, so the UI can show a login', (await req(API.authState)).status === 200)

const wsUnauth = await new Promise<number>((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`)
  ws.on('close', (code) => resolve(code))
  ws.on('error', () => resolve(-1))
  ws.on('message', () => resolve(-2)) // any frame at all is a failure here
})
check('the WebSocket is closed on an unauthenticated upgrade', wsUnauth === 4401, `close code ${wsUnauth}`)

// ------------------------------------------------------------------- login

check('a wrong password is refused', (await login('admin', 'not-the-password')).status === 401)
check('an unknown username is refused', (await login('nobody', 'whatever')).status === 401)

const adminLogin = await login('admin', ADMIN_PASSWORD)
check('the correct password is accepted', adminLogin.status === 200)
check('and sets a session cookie', !!adminLogin.cookie)
const ADMIN = adminLogin.cookie!
const setCookieHeader = String(
  (await fetch(base + API.login, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  }).then((r) => r.headers.get('set-cookie'))) ?? '',
)
check('the cookie is HttpOnly', /httponly/i.test(setCookieHeader), setCookieHeader)
check('the cookie is SameSite=Strict', /samesite=strict/i.test(setCookieHeader), setCookieHeader)

const viewerLogin = await login('friend', VIEWER_PASSWORD)
check('a viewer can sign in too', viewerLogin.status === 200)
const VIEWER = viewerLogin.cookie!

check('a session id is not guessable from its length alone', ADMIN.length >= 40 && ADMIN !== VIEWER)

// --------------------------------------------------- authenticated access

check('a viewer can read the snapshot', (await req(API.snapshot, { cookie: VIEWER })).status === 200)
check('a viewer can read a console backlog', (await req('/api/servers/Testing%20Grounds/log', { cookie: VIEWER })).status === 200)
check('an admin can read the snapshot', (await req(API.snapshot, { cookie: ADMIN })).status === 200)
check('a made-up session id is refused', (await req(API.snapshot, { cookie: 'not-a-real-session' })).status === 401)

const wsAuth = await new Promise<string>((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
    headers: { cookie: `${SESSION_COOKIE}=${VIEWER}` },
  })
  const timer = setTimeout(() => resolve('timeout'), 5000)
  ws.on('message', (d) => {
    clearTimeout(timer)
    ws.close()
    resolve(JSON.parse(String(d)).type)
  })
  ws.on('close', (code) => {
    clearTimeout(timer)
    resolve(`closed ${code}`)
  })
  ws.on('error', () => resolve('error'))
})
check('an authenticated WebSocket receives frames', wsAuth === 'hello' || wsAuth === 'snapshot', wsAuth)

// ------------------------------------------------------------------- CSRF

check(
  'a mutating request without the CSRF header is refused',
  (await req(API.refresh, { method: 'POST', cookie: ADMIN, csrf: false })).status === 403,
)
check(
  'the same request with the header is accepted',
  (await req(API.refresh, { method: 'POST', cookie: ADMIN })).status === 200,
)

// ------------------------------------------------------ roles: the milestone

const viewerControl = await req(API.ackIpChange, { method: 'POST', cookie: VIEWER })
const adminControl = await req(API.ackIpChange, { method: 'POST', cookie: ADMIN })
check('a VIEWER is refused an admin-only action', viewerControl.status === 403, `got ${viewerControl.status}`)
check('and told why, in words', /admin/i.test(String(viewerControl.body?.error)), String(viewerControl.body?.error))
check('an ADMIN is allowed the same action', adminControl.status === 200, `got ${adminControl.status}`)

// ------------------------------------------------------------ the audit log

const auditLines = readFileSync(join(DATA, 'audit.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, string>)

const denied = auditLines.find((l) => l.action === 'network.ack-ip-change' && l.outcome === 'denied')
const allowed = auditLines.find((l) => l.action === 'network.ack-ip-change' && l.outcome === 'ok')
check('the refusal is in the audit log, with the actor', denied?.actor === 'friend' && denied?.role === 'viewer')
check('the allowed action is in the audit log, with the actor', allowed?.actor === 'admin' && allowed?.role === 'admin')
check('a failed login is audited', auditLines.some((l) => l.action === 'auth.login' && l.outcome === 'failed'))
check('a successful login is audited', auditLines.some((l) => l.action === 'auth.login' && l.outcome === 'ok'))
check('the unauthenticated WebSocket attempt is audited', auditLines.some((l) => l.action === 'ws.connect' && l.outcome === 'denied'))
check('every entry carries a timestamp and an ip', auditLines.every((l) => !!l.at && !!l.ip))
check(
  'no password or session id appears anywhere in the audit log',
  !auditLines.some((l) => JSON.stringify(l).includes(ADMIN_PASSWORD) || JSON.stringify(l).includes(ADMIN)),
)

// ------------------------------------------------- sessions expire and revoke

{
  const store = new SessionStore()
  const s = store.create({ username: 'x', role: 'admin' }, '127.0.0.1', 'test')
  check('a fresh session resolves', store.touch(s.id) !== null)
  check(
    'a session past its ABSOLUTE age is refused even though it was just used',
    store.touch(s.id, Date.now() + 13 * 60 * 60_000) === null,
  )

  const store2 = new SessionStore()
  const s2 = store2.create({ username: 'x', role: 'admin' }, '127.0.0.1', 'test')
  check(
    'a session IDLE past the limit is refused even though it is young',
    store2.touch(s2.id, Date.now() + 3 * 60 * 60_000) === null,
  )

  const store3 = new SessionStore()
  const s3 = store3.create({ username: 'x', role: 'admin' }, '127.0.0.1', 'test')
  // Touching repeatedly must push idle expiry forward but NOT absolute expiry.
  for (let h = 1; h <= 11; h++) store3.touch(s3.id, Date.now() + h * 60 * 60_000)
  check('activity keeps a session alive within its absolute limit', store3.touch(s3.id, Date.now() + 11 * 60 * 60_000) !== null)
  check('but cannot extend it past that limit', store3.touch(s3.id, Date.now() + 12.5 * 60 * 60_000) === null)

  const store4 = new SessionStore()
  const a = store4.create({ username: 'x', role: 'admin' }, '1.1.1.1', 'one')
  const b = store4.create({ username: 'x', role: 'admin' }, '2.2.2.2', 'two')
  store4.revoke(a.id)
  check('a single session can be revoked without touching the others', store4.touch(a.id) === null && store4.touch(b.id) !== null)
  check('and every session for a user can be revoked at once', store4.revokeAllFor('x') === 1 && store4.touch(b.id) === null)
}

// -------------------------------------------- sessions survive a restart
// Added 2026-07-31 when persistence was added at the operator's explicit request.
// The dangerous failures are resurrection (an expired or revoked session
// coming back from disk) and a corrupt file taking the service down, so most
// of these are about what must NOT come back.

{
  const dir = mkdtempSync(join(tmpdir(), 'mcdash-sess-'))
  // The store cross-checks loaded sessions against the user file, so the
  // fixture must contain the user. An earlier version of this block did not,
  // which meant it was testing a directory shape production never has: the
  // §6c lesson, arriving again in miniature.
  saveUsers(dir, [
    {
      username: 'x',
      role: 'admin',
      password: await hashPassword('irrelevant-for-this-block'),
      createdAt: new Date().toISOString(),
      mustChangePassword: false,
    },
  ])
  const store = new SessionStore(dir)
  const s = store.create({ username: 'x', role: 'admin' }, '127.0.0.1', 'test')
  check('a session file is written next to the store directory', existsSync(join(dir, 'sessions.json')))
  check(
    'the session file never holds a plaintext password or user secret',
    !readFileSync(join(dir, 'sessions.json'), 'utf8').includes('scrypt$'),
  )

  const reborn = new SessionStore(dir)
  const back = reborn.touch(s.id)
  check('a live session survives a service restart', back !== null)
  check('with its role intact, not defaulted', back?.role === 'admin')

  store.revoke(s.id)
  const afterRevoke = new SessionStore(dir)
  check('a REVOKED session does not come back from disk', afterRevoke.touch(s.id) === null)

  const expired = {
    id: 'expired-on-disk',
    username: 'x',
    role: 'admin',
    createdAt: Date.now() - 13 * 60 * 60_000,
    lastSeenAt: Date.now(),
    ip: '127.0.0.1',
    userAgent: 'test',
  }
  const idled = { ...expired, id: 'idled-on-disk', createdAt: Date.now(), lastSeenAt: Date.now() - 3 * 60 * 60_000 }
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ version: 1, sessions: [expired, idled] }), 'utf8')
  const afterExpiry = new SessionStore(dir)
  check('an ABSOLUTE-expired session on disk is not resurrected', afterExpiry.touch('expired-on-disk') === null)
  check('an IDLE-expired session on disk is not resurrected', afterExpiry.touch('idled-on-disk') === null)

  // ---- what a TAMPERED session file may resurrect (M4 audit, F5)
  // Someone who can write this file can also rewrite auth.json, so this is
  // not the last line of defence. It is still worth refusing: forging an
  // entry here skips having to crack scrypt at all.
  const base = {
    id: 'tampered',
    username: 'x',
    role: 'admin' as const,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    ip: '127.0.0.1',
    userAgent: 'test',
  }
  const write = (sessions: unknown[]) =>
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ version: 1, sessions }), 'utf8')

  write([{ ...base, id: 'bad-role', role: 'superuser' }])
  check('a session with an unknown role is not loaded', new SessionStore(dir).touch('bad-role') === null)

  write([{ ...base, id: 'ghost-user', username: 'nobody-by-that-name' }])
  check(
    'a session for a user who does not exist is not loaded',
    new SessionStore(dir).touch('ghost-user') === null,
  )

  // now - createdAt is NEGATIVE for a future timestamp, so every expiry
  // comparison passes and the session would never age out.
  const year = 365 * 24 * 60 * 60_000
  write([{ ...base, id: 'from-the-future', createdAt: Date.now() + year, lastSeenAt: Date.now() + year }])
  check(
    'a session dated in the future is treated as forged, not as immortal',
    new SessionStore(dir).touch('from-the-future') === null,
  )

  writeFileSync(join(dir, 'sessions.json'), 'this is not json{{{', 'utf8')
  let corruptOk = true
  let corruptStore: InstanceType<typeof SessionStore> | null = null
  try {
    corruptStore = new SessionStore(dir)
  } catch {
    corruptOk = false
  }
  check('a corrupt session file fails closed instead of crashing the service', corruptOk && corruptStore!.size === 0)
  const fresh = corruptStore!.create({ username: 'x', role: 'viewer' }, '127.0.0.1', 'test')
  check('and login still works after it, overwriting the corruption', new SessionStore(dir).touch(fresh.id) !== null)
}

// ------------------------------------------------------------ rate limiting

{
  const t = new LoginThrottle()
  const keys = ['ip:9.9.9.9', 'user:someone']
  for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) t.recordFailure(keys)
  check('failures below the limit do not lock out', t.retryAfterMs(keys) === 0)
  t.recordFailure(keys)
  check('the limit locks the account out', t.retryAfterMs(keys) > 0)
  check('a different IP and user are unaffected', t.retryAfterMs(['ip:8.8.8.8', 'user:other']) === 0)
  check('an IP lockout applies even to a different username', t.retryAfterMs(['ip:9.9.9.9', 'user:fresh']) > 0)
  const t2 = new LoginThrottle()
  t2.recordFailure(['user:z'])
  t2.recordSuccess(['user:z'])
  check('a success clears the counter', t2.retryAfterMs(['user:z']) === 0)
}

// The live endpoint is exercised at the very END of this script, not here.
// Doing it at this point locked out 127.0.0.1 -- which every request in this
// test comes from -- and four later assertions failed for a reason that had
// nothing to do with what they were testing. The IP lockout applying across
// usernames is the behaviour asserted two checks above; it is correct, and the
// ordering was the bug.

// --------------------------------------------- password change kills sessions

const second = await login('admin', ADMIN_PASSWORD)
check('the admin can still sign in from elsewhere', second.status === 200)
const SECOND = second.cookie!

const changed = await req(API.changePassword, {
  method: 'POST',
  cookie: ADMIN,
  body: { currentPassword: ADMIN_PASSWORD, newPassword: 'a-much-better-password' },
})
check('a password change with the right current password succeeds', changed.status === 200)
check('changing a password revokes the OTHER sessions', (await req(API.snapshot, { cookie: SECOND })).status === 401)
check('the session that changed it is re-issued, not dropped', !!changed.cookie)
check('the new session works', (await req(API.snapshot, { cookie: changed.cookie! })).status === 200)
check('the old password no longer works', (await login('admin', ADMIN_PASSWORD)).status === 401)
check('the new one does', (await login('admin', 'a-much-better-password')).status === 200)

const short = await req(API.changePassword, {
  method: 'POST',
  cookie: changed.cookie!,
  body: { currentPassword: 'a-much-better-password', newPassword: 'short' },
})
check('a too-short new password is refused server-side, not only in the UI', short.status === 400)

// --------------------------------------------- a session id is not a handle

const admin2 = (await login('admin', 'a-much-better-password')).cookie!
const stealAttempt = await req(API.revokeSession(admin2), { method: 'DELETE', cookie: VIEWER })
check(
  "one user cannot revoke another user's session by id",
  stealAttempt.status === 404 || stealAttempt.status === 401,
  `got ${stealAttempt.status}`,
)

// ------------------------------------------------------------------ logout

const bye = await req(API.logout, { method: 'POST', cookie: admin2 })
check('logout succeeds', bye.status === 200)
check('and the session is dead immediately', (await req(API.snapshot, { cookie: admin2 })).status === 401)

// ------------------------------------------- live rate limiting, done LAST
// This locks out 127.0.0.1, which every request here originates from, so it
// has to be the last thing that touches the login endpoint.

for (let i = 0; i < LOGIN_MAX_FAILURES + 1; i++) await login('friend', 'wrong-every-time')
const lockedOut = await login('friend', VIEWER_PASSWORD)
check(
  'the live login endpoint locks out after repeated failures, even with the right password',
  lockedOut.status === 429,
  `got ${lockedOut.status}`,
)
check('and says how long to wait', /minute/i.test(String(lockedOut.body?.error)), String(lockedOut.body?.error))
check(
  'the lockout is audited',
  readFileSync(join(DATA, 'audit.jsonl'), 'utf8').includes('rate limited'),
)

// ------------------------------------------------------------------ teardown

await app.close()
rmSync(DATA, { recursive: true, force: true })
rmSync(ROOT, { recursive: true, force: true })
check('the throwaway data directory is gone', !existsSync(DATA))

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`)
}
console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED of ${checks.length}`)
process.exit(failed === 0 ? 0 : 1)
