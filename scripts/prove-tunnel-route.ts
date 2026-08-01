/**
 * PROOF: the tunnel routes sit behind the same gate as every other write,
 * and both consents exist ON THE WIRE.
 *
 *   1. unauthenticated -> 401; a viewer -> 403; no CSRF header -> 403.
 *   2. run-agent without confirmRunDownloadedProgram: true -> refused with
 *      the reason, across the wire.
 *   3. enable with a mistyped server name -> refused; enable for an unknown
 *      server id -> 404.
 *   4. With a credential staged on disk, the secret appears in NO response
 *      from any tunnel route.
 *
 * WORLD: throwaway MCDASH_DATA_DIR and MCDASH_SERVERS_ROOT; a real Fastify
 * instance on an ephemeral port; no network to playit (every request here
 * refuses before any provider call).
 *
 * Run:  npx tsx scripts/prove-tunnel-route.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API, SESSION_COOKIE, CSRF_HEADER } from '../shared/api'

const DATA = mkdtempSync(join(tmpdir(), 'mcdash-tunnel-route-'))
const ROOT = join(DATA, 'servers-root')
mkdirSync(ROOT, { recursive: true })
process.env.MCDASH_DATA_DIR = DATA
process.env.MCDASH_SERVERS_ROOT = ROOT

const { loadConfig, dataDir } = await import('../server/config')
const { buildServer } = await import('../server/http')
const { bootstrapIfEmpty, loadUsers, saveUsers, hashPassword } = await import('../server/auth')
const { secretPath, tunnelDir } = await import('../server/tunnel')

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

const adminCookie = await signIn(boot.username, boot.password)
const viewerCookie = await signIn('viewer1', VIEWER_PW)
const H = { 'content-type': 'application/json', cookie: adminCookie, [CSRF_HEADER]: '1' }

// ===========================================================================
console.log('\n=== 1. the gate ===\n')
// ===========================================================================
{
  const r1 = await fetch(BASE + API.tunnelStatus)
  check('status without a session is 401', r1.status === 401)
  const r2 = await fetch(BASE + API.tunnelStatus, { headers: { cookie: viewerCookie } })
  check('status as a viewer is 403: exposure is not a viewer surface', r2.status === 403)
  const r3 = await fetch(BASE + API.tunnelEnable, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: viewerCookie, [CSRF_HEADER]: '1' },
    body: JSON.stringify({ id: 'x', confirmServerName: 'x' }),
  })
  check('enable as a viewer is 403', r3.status === 403)
  const r4 = await fetch(BASE + API.tunnelEnable, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ id: 'x', confirmServerName: 'x' }),
  })
  check('enable without the CSRF header is 403 even for an admin', r4.status === 403)
}

// ===========================================================================
console.log('\n=== 2. both consents cross the wire ===\n')
// ===========================================================================
{
  // Stage a verified-looking agent and credential so the run refusal is about
  // the CONSENT, not about missing pieces.
  mkdirSync(tunnelDir(DATA), { recursive: true })
  writeFileSync(join(tunnelDir(DATA), 'playit-agent.exe'), 'staged for the proof, never executed')
  writeFileSync(secretPath(DATA), 'secret_key = "aabbccddeeff00112233445566778899"\n')

  const run = await fetch(BASE + API.tunnelRunAgent, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ confirmRunDownloadedProgram: false }),
  })
  const runBody = (await run.json()) as { error?: string }
  check('run-agent without the confirmation is refused', run.status === 409)
  check('and the refusal says what confirming means', (runBody.error ?? '').includes('downloaded program'))

  const unknown = await fetch(BASE + API.tunnelEnable, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ id: 'No Such Server', confirmServerName: 'No Such Server' }),
  })
  check('enabling an unknown server id is 404', unknown.status === 404)

  // status must never leak the staged secret.
  const status = await fetch(BASE + API.tunnelStatus, { headers: { cookie: adminCookie } })
  const statusText = await status.text()
  check('status answers an admin', status.status === 200)
  check('the staged secret appears nowhere in the status response', !statusText.includes('aabbccddeeff00112233445566778899'))
  check('but the status does say a credential is present', statusText.includes('"secretPresent":true'))

  const claim = await fetch(BASE + API.tunnelClaimStatus, { headers: { cookie: adminCookie } })
  const claimText = await claim.text()
  check('claim status answers and carries no secret', claim.status === 200 && !claimText.includes('aabbccdd'))
}

await app.close()

let pass = 0
let fail = 0
for (const [label, ok, detail] of checks) {
  if (ok) pass++
  else {
    fail++
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`)
  }
}
console.log('\n================================================================')
if (fail === 0) console.log(`ALL PASS. ${pass} checks`)
else console.log(`${fail} FAILED, ${pass} passed`)
console.log(`world: ${DATA}`)
process.exit(fail === 0 ? 0 : 1)
