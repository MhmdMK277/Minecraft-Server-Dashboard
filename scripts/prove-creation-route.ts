/**
 * PROOF: the creation routes sit behind the same gate as every other write,
 * and the two explicit consents exist ON THE WIRE, not only in the UI.
 *
 * Creation downloads executable code and writes a folder, which makes its
 * routes worth the same end-to-end treatment as the backup ticks:
 *
 *   1. unauthenticated -> 401; a viewer -> 403; no CSRF header -> 403.
 *      Nothing is created in any of those cases.
 *   2. eulaAccepted: false -> refused with the EULA named, nothing created,
 *      and the refusal audited.
 *   3. Fabric -> refused end to end with the stated reason in the response
 *      body, which is what the UI shows.
 *   4. remove-failed demands the folder's exact name as typed confirmation;
 *      a mismatch refuses and audits, a match removes only the journaled
 *      folder.
 *   5. run-installer on an unknown operation refuses; the
 *      confirmRunDownloadedProgram gate itself is proven at the unit level
 *      in prove-creation section 11.
 *
 * WORLD: throwaway MCDASH_DATA_DIR and MCDASH_SERVERS_ROOT; a real Fastify
 * instance on an ephemeral port. No real server directory, no network to any
 * publisher (every request here refuses before resolving).
 *
 * Run:  npx tsx scripts/prove-creation-route.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API, SESSION_COOKIE, CSRF_HEADER } from '../shared/api'

const DATA = mkdtempSync(join(tmpdir(), 'mcdash-create-route-'))
const ROOT = join(DATA, 'servers-root')
mkdirSync(ROOT, { recursive: true })
process.env.MCDASH_DATA_DIR = DATA
process.env.MCDASH_SERVERS_ROOT = ROOT

const { loadConfig, dataDir } = await import('../server/config')
const { buildServer } = await import('../server/http')
const { bootstrapIfEmpty, loadUsers, saveUsers, hashPassword } = await import('../server/auth')

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

const auditLines = () =>
  existsSync(join(DATA, 'audit.jsonl'))
    ? readFileSync(join(DATA, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { action: string; outcome: string; detail?: string })
    : []

const CREATE_BODY = {
  name: 'Route Proof',
  flavor: 'vanilla',
  mcVersion: '1.21.4',
  loaderVersion: null,
  gamePort: 26565,
  rconPort: 26575,
  eulaAccepted: true,
  memoryMb: null,
  javaMode: 'existing',
}

// ===========================================================================
console.log('\n=== 1. the gate: 401, 403, CSRF ===\n')
// ===========================================================================
{
  const r1 = await fetch(BASE + API.createInfo(), { headers: {} })
  check('info without a session is 401', r1.status === 401)

  const r2 = await fetch(BASE + API.createInfo(), { headers: { cookie: viewerCookie } })
  check('info as a viewer is 403: creation is not a viewer surface', r2.status === 403)

  const r3 = await fetch(BASE + API.create, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: viewerCookie, [CSRF_HEADER]: '1' },
    body: JSON.stringify(CREATE_BODY),
  })
  check('create as a viewer is 403', r3.status === 403)

  const r4 = await fetch(BASE + API.create, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify(CREATE_BODY),
  })
  check('create without the CSRF header is 403 even for an admin', r4.status === 403)
  check('none of that created anything', !existsSync(join(ROOT, 'Route Proof')))
}

// ===========================================================================
console.log('\n=== 2. the EULA refusal crosses the wire ===\n')
// ===========================================================================
{
  const r = await fetch(BASE + API.create, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie, [CSRF_HEADER]: '1' },
    body: JSON.stringify({ ...CREATE_BODY, eulaAccepted: false }),
  })
  const body = (await r.json()) as { error?: string }
  check('an unaccepted EULA is refused', r.status === 409)
  check('the response names the EULA and its link', (body.error ?? '').includes('https://aka.ms/MinecraftEULA'))
  check('nothing was created', !existsSync(join(ROOT, 'Route Proof')))
  check('the refusal was audited', auditLines().some((l) => l.action === 'create.start' && l.outcome === 'denied'))
}

// ===========================================================================
console.log('\n=== 3. Fabric is refused end to end, reason in the body ===\n')
// ===========================================================================
{
  const info = await fetch(BASE + API.createInfo('1.21.4'), { headers: { cookie: adminCookie } })
  const infoBody = (await info.json()) as {
    flavors: Array<{ flavor: string; available: boolean; reason?: string }>
    javaMajor: number | null
    javaLink: string | null
    adoptiumConsequence: string
    suggestedGamePort: number
    suggestedRconPort: number
  }
  check('info returns 200 for an admin', info.status === 200)
  const fabric = infoBody.flavors.find((f) => f.flavor === 'fabric')
  check('the catalog carries fabric as unavailable with its reason', !!fabric && !fabric.available && (fabric.reason ?? '').includes('checksum'))
  check('the java default path is stated: major and link', infoBody.javaMajor === 21 && (infoBody.javaLink ?? '').includes('adoptium.net'))
  check('the adoptium consequence is stated before any click', infoBody.adoptiumConsequence.includes('absolute path'))
  check('suggested ports differ and are sane', infoBody.suggestedGamePort !== infoBody.suggestedRconPort && infoBody.suggestedGamePort >= 25565)

  const r = await fetch(BASE + API.create, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie, [CSRF_HEADER]: '1' },
    body: JSON.stringify({ ...CREATE_BODY, flavor: 'fabric' }),
  })
  const body = (await r.json()) as { error?: string }
  check('a fabric creation is refused with the stated reason', r.status === 409 && (body.error ?? '').includes('not a verified file'))
  check('and created nothing', !existsSync(join(ROOT, 'Route Proof')))
}

// ===========================================================================
console.log('\n=== 4. removal demands the exact folder name ===\n')
// ===========================================================================
{
  // A failed creation, staged by hand the way creation.ts would leave it.
  const failed = join(ROOT, 'Failed Creation')
  mkdirSync(failed)
  writeFileSync(join(failed, 'stray.jar'), 'staged bytes', 'utf8')
  writeFileSync(
    join(failed, '.mcdash-creation.json'),
    JSON.stringify({
      version: 1,
      opId: 'op-route-proof',
      name: 'Failed Creation',
      flavor: 'vanilla',
      mcVersion: '1.21.4',
      startedAt: new Date().toISOString(),
      state: 'failed',
      error: 'simulated',
      files: ['.mcdash-creation.json', 'stray.jar'],
      dirs: [],
    }),
    'utf8',
  )

  const wrong = await fetch(BASE + API.createRemoveFailed, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie, [CSRF_HEADER]: '1' },
    body: JSON.stringify({ dir: failed, folderName: 'Wrong Name' }),
  })
  check('a mismatched confirmation name is refused', wrong.status === 400)
  check('and the folder survives', existsSync(failed))
  check('the mismatch was audited as denied', auditLines().some((l) => l.action === 'create.remove-failed' && l.outcome === 'denied'))

  const right = await fetch(BASE + API.createRemoveFailed, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie, [CSRF_HEADER]: '1' },
    body: JSON.stringify({ dir: failed, folderName: 'Failed Creation' }),
  })
  check('the exact name removes the journaled folder', right.status === 200 && !existsSync(failed))

  const foreign = join(ROOT, 'Not Ours')
  mkdirSync(foreign)
  writeFileSync(join(foreign, 'world-backup.zip'), 'precious', 'utf8')
  const refuse = await fetch(BASE + API.createRemoveFailed, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie, [CSRF_HEADER]: '1' },
    body: JSON.stringify({ dir: foreign, folderName: 'Not Ours' }),
  })
  check('a folder without our journal is refused even with the right name', refuse.status === 409)
  check('and its contents are untouched', existsSync(join(foreign, 'world-backup.zip')))
}

// ===========================================================================
console.log('\n=== 5. the installer route refuses the unknown ===\n')
// ===========================================================================
{
  const r = await fetch(BASE + API.createRunInstaller, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie, [CSRF_HEADER]: '1' },
    body: JSON.stringify({ opId: 'no-such-operation', confirmRunDownloadedProgram: true }),
  })
  check('an unknown operation is 409', r.status === 409)

  const jobs = await fetch(BASE + API.createJobs, { headers: { cookie: adminCookie } })
  const jobsBody = (await jobs.json()) as { jobs: unknown[] }
  check('the jobs list answers an admin and is empty in this world', jobs.status === 200 && jobsBody.jobs.length === 0)
}

// ===========================================================================
console.log('\n=== 6. a hostile parent pick is refused on the wire ===\n')
// ===========================================================================
// Decision 0010: parentDir is a request field now. The refusal matrix lives
// in creation.ts (prove-creation section 13 exercises all of it); this
// section proves a hostile pick is refused THROUGH the route, verbatim,
// with nothing created and the denial audited.
{
  const r = await fetch(BASE + API.create, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie, [CSRF_HEADER]: '1' },
    body: JSON.stringify({ ...CREATE_BODY, parentDir: DATA }),
  })
  const body = (await r.json()) as { error?: string }
  check('aiming creation at the data directory is 409', r.status === 409)
  check('with the reason verbatim in the body', (body.error ?? '').includes('data directory'))
  check('and nothing was created there', !existsSync(join(DATA, 'Route Proof')))
  check('the denial was audited', auditLines().some((l) => l.action === 'create.start' && l.outcome === 'denied' && (l.detail ?? '').includes('data directory')))

  const r2 = await fetch(BASE + API.create, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie, [CSRF_HEADER]: '1' },
    body: JSON.stringify({ ...CREATE_BODY, parentDir: '' }),
  })
  check('an empty parentDir fails the wire shape, not the filesystem', r2.status === 400)
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
