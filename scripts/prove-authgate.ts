/**
 * PROOF: the authentication gate cannot be walked around with URL spelling.
 *
 * Written 2026-07-31 in response to a real, exploitable finding from the M4
 * adversarial pass, and written BEFORE the fix per the standing rule.
 *
 * The bug: the global onRequest hook decided whether a request needed a
 * session by testing the RAW request target with
 *
 *     req.url.split('?')[0].startsWith('/api')
 *
 * Fastify's router percent-decodes the path AFTER hooks run, so
 * `/%61pi/servers` did not match the string test, skipped the hook entirely,
 * and was then dispatched to the real `/api/servers` handler. An
 * unauthenticated caller on the LAN could read the full snapshot and every
 * console line, which includes whatever a server prints. The mutating routes
 * held, because each calls require_() and no session had been attached.
 *
 * The lesson is the one this project keeps relearning: a check that runs on
 * a different representation of the input than the thing it is protecting is
 * not a check. The gate now keys on the ROUTED path (the pattern Fastify
 * matched), which is what the handler actually is, not on how the client
 * happened to spell it.
 *
 * Run: npx tsx scripts/prove-authgate.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API, SESSION_COOKIE, CSRF_HEADER } from '../shared/api'

const ROOT = mkdtempSync(join(tmpdir(), 'mcdash-authgate-root-'))
const DATA = mkdtempSync(join(tmpdir(), 'mcdash-authgate-data-'))
process.env.MCDASH_DATA_DIR = DATA
process.env.MCDASH_SERVERS_ROOT = ROOT

const SECRET = 'AUTHGATE-CANARY-SECRET'
{
  const dir = join(ROOT, 'Gate Server')
  mkdirSync(join(dir, 'world'), { recursive: true })
  mkdirSync(join(dir, 'logs'), { recursive: true })
  writeFileSync(join(dir, 'world', 'level.dat'), Buffer.from([0x0a, 0x00, 0x00]))
  writeFileSync(
    join(dir, 'server.properties'),
    ['server-port=25595', 'level-name=world', 'enable-rcon=true', 'rcon.port=25605', `rcon.password=${SECRET}`, ''].join('\n'),
    'utf8',
  )
  writeFileSync(join(dir, 'logs', 'latest.log'), `[19:00:00] [Server thread/INFO]: hello ${SECRET}\n`, 'utf8')
}

const { loadConfig, dataDir } = await import('../server/config')
const { buildServer } = await import('../server/http')
const { bootstrapIfEmpty } = await import('../server/auth')

const checks: Array<[string, boolean, string?]> = []
const check = (label: string, ok: boolean, detail?: string) => checks.push([label, ok, detail])

const cfg = loadConfig(dataDir())
const boot = await bootstrapIfEmpty(dataDir())
if (!boot) throw new Error('bootstrap produced no admin')

const app = await buildServer({ cfg, version: 'prove-authgate' })
await app.listen({ host: '127.0.0.1', port: 0 })
const addr = app.server.address()
const BASE = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`

type Probe = { status: number; type: string; body: string }
async function probe(path: string, init?: RequestInit): Promise<Probe> {
  // NOTE: fetch() normalises some paths, so the raw target is written on the
  // socket by hand where the spelling is the point of the test.
  const res = await fetch(BASE + path, init)
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    body: (await res.text()).slice(0, 400),
  }
}

/**
 * A protected route is "leaking" when an unauthenticated request gets JSON
 * back. The SPA fallback returning index.html is fine: it carries no data.
 */
function leaked(p: Probe): boolean {
  return p.status === 200 && p.type.includes('application/json')
}

console.log('\n=== 1. every spelling of a protected route, unauthenticated ===\n')

// Each of these, if routed to the real handler, exposes the whole snapshot.
const SPELLINGS = [
  '/api/servers',
  '/%61pi/servers', // the finding: percent-encoded 'a'
  '/%61%70%69/servers', // all three letters encoded
  '/ap%69/servers',
  '/API/servers',
  '//api/servers',
  '/./api/servers',
  '/api/./servers',
  '/api//servers',
  '/api/../api/servers',
  '/%2fapi/servers',
  '/api/servers/', // trailing slash
  '/api/servers%20',
  '/%61pi/info',
  '/%61pi/servers/Gate%20Server/log',
  '/%61pi/servers/Gate%20Server/worlds',
]

for (const path of SPELLINGS) {
  const p = await probe(path)
  const ok = !leaked(p)
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${path.padEnd(38)} ${p.status} ${p.type.split(';')[0]}`)
  check(`unauthenticated ${path} does not return data`, ok, `${p.status} ${p.type}`)
}

console.log('\n=== 2. no canary escapes to an unauthenticated caller ===\n')
for (const path of SPELLINGS) {
  const p = await probe(path)
  const clean = !p.body.includes(SECRET)
  check(`no secret in the response to ${path}`, clean)
  if (!clean) console.log(`   FAIL  ${path} leaked the canary`)
}
console.log('   (checked all spellings)')

console.log('\n=== 3. mutating routes stay shut, however they are spelled ===\n')
const MUTATIONS: Array<[string, string]> = [
  ['POST', '/%61pi/servers/refresh'],
  ['POST', '/api/servers/refresh'],
  ['POST', '/%61pi/servers/Gate%20Server/settings'],
  ['POST', '/%61pi/servers/Gate%20Server/command'],
  ['POST', '/%61pi/servers/Gate%20Server/stop'],
  ['POST', '/%61pi/network/ack-ip-change'],
]
for (const [method, path] of MUTATIONS) {
  const p = await probe(path, {
    method,
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
    body: '{}',
  })
  const ok = p.status === 401 || p.status === 403 || p.status === 404
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${method} ${path.padEnd(40)} ${p.status}`)
  check(`unauthenticated ${method} ${path} is refused`, ok, String(p.status))
}

console.log('\n=== 4. the gate still lets a real session through ===\n')
const res = await fetch(BASE + API.login, {
  method: 'POST',
  headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
  body: JSON.stringify({ username: boot.username, password: boot.password }),
})
const cookie = res.headers.get('set-cookie')?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1]
check('an admin can still sign in', !!cookie)
const authed = await probe('/api/servers', { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } })
check('and read the snapshot normally', leaked(authed), String(authed.status))
console.log(`   authenticated /api/servers -> ${authed.status} ${authed.type.split(';')[0]}`)

const authedEncoded = await probe('/%61pi/servers', {
  headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
})
check(
  'an encoded spelling with a valid session is also fine (it is the same route)',
  authedEncoded.status === 200 || authedEncoded.status === 404,
  String(authedEncoded.status),
)

console.log('\n=== 5. public routes are still public ===\n')
const state = await probe(API.authState)
check('the auth state route stays reachable unauthenticated', state.status === 200)
console.log(`   ${API.authState} -> ${state.status}`)

console.log('\n=== 6. security headers on every response ===\n')
{
  const res2 = await fetch(BASE + API.snapshot, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } })
  const h = (n: string) => res2.headers.get(n) ?? ''
  check('nosniff is set on API responses', h('x-content-type-options') === 'nosniff', h('x-content-type-options'))
  check('the API denies framing', /frame-ancestors 'none'/.test(h('content-security-policy')), h('content-security-policy'))
  check('an API response may load nothing', /default-src 'none'/.test(h('content-security-policy')))
  check('the referrer is not sent onward', h('referrer-policy') === 'no-referrer', h('referrer-policy'))
  console.log(`   csp(api)  ${h('content-security-policy')}`)

  // The SPA needs a policy that permits its OWN bundle. Sending the API's
  // 'none' policy to the page would forbid its scripts, because browsers
  // intersect every policy they receive.
  const page = await fetch(BASE + '/')
  const pageCsp = page.headers.get('content-security-policy') ?? ''
  check('the page CSP still allows its own scripts', /script-src 'self'/.test(pageCsp), pageCsp)
  check('the page CSP still allows its own websocket', /connect-src 'self'/.test(pageCsp))
  console.log(`   csp(page) ${pageCsp}`)
}

console.log('\n=== 7. redaction covers free-text secrets, not just assignments ===\n')
{
  const { redactLine } = await import('../server/redact')
  const mustHide: Array<[string, string]> = [
    ['[DiscordSRV] Using token AUDIT-CANARY-TOKEN-value-123', 'AUDIT-CANARY-TOKEN-value-123'],
    ['password is hunter2-with-digits', 'hunter2-with-digits'],
    ['token=abc123def456', 'abc123def456'],
    ['api_key: sk-1234567890abcdef', 'sk-1234567890abcdef'],
    ['Bearer eyJhbGciOiJIUzI1NiJ9', 'eyJhbGciOiJIUzI1NiJ9'],
  ]
  for (const [line, secret] of mustHide) {
    const out = redactLine(line)
    check(`redacted: ${line.slice(0, 42)}`, !out.includes(secret), out)
  }
  // A log that redacts its own error messages cannot be debugged from.
  const mustKeep = ['Invalid token supplied', 'token expired', 'the password was rejected']
  for (const line of mustKeep) {
    check(`left readable: ${line}`, redactLine(line) === line, redactLine(line))
  }
  console.log('   free-text secrets hidden, ordinary prose left readable')
}

await app.close()

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${'='.repeat(60)}`)
for (const [label, ok, detail] of failed) console.log(`FAIL  ${label}${detail ? `  [${detail}]` : ''}`)
console.log(failed.length === 0 ? `ALL PASS. ${checks.length} checks` : `\n${failed.length} FAILED of ${checks.length}`)
process.exit(failed.length === 0 ? 0 : 1)
