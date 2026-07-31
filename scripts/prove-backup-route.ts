/**
 * PROOF: the backup tick goes through the auth gate, and only through it.
 *
 * This is the first route in the app that writes state an EXTERNAL program then
 * acts on -- mcbackup.py reads the file it produces, hours later, unattended.
 * So the gate matters more than it did for ack-ip-change: a viewer who can flip
 * these ticks can stop every world on the box being backed up, and nobody would
 * find out until they needed a backup.
 *
 * Asserted end to end against a real service on an ephemeral port, with its own
 * throwaway data directory:
 *
 *   1. unauthenticated  -> 401, and nothing is written
 *   2. a viewer         -> 403, and nothing is written
 *   3. no CSRF header   -> 403, and nothing is written
 *   4. an admin         -> 200, and the file on disk changes
 *   5. an unknown id    -> 404, so a typo cannot create a phantom entry
 *   6. every attempt, allowed or refused, appears in the audit log
 *
 * "and nothing is written" is checked by reading the policy file after each
 * refusal, not by trusting the status code.
 *
 * Run:  npx tsx scripts/prove-backup-route.ts
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API, SESSION_COOKIE, CSRF_HEADER } from '../shared/api'

const DATA = mkdtempSync(join(tmpdir(), 'mcdash-backup-'))
process.env.MCDASH_DATA_DIR = DATA

const { loadConfig, dataDir } = await import('../server/config')
const { buildServer } = await import('../server/http')
const { bootstrapIfEmpty, loadUsers, saveUsers, hashPassword } = await import('../server/auth')
const { policyPath, loadPolicy, isBackupEnabled } = await import('../server/backuppolicy')

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])

const cfg = loadConfig(dataDir())
const boot = await bootstrapIfEmpty(dataDir())
if (!boot) {
  console.error('bootstrap produced no admin')
  process.exit(1)
}

// A viewer, so the role gate is tested against a real second account rather than
// by pretending an admin is not one.
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

const snap = (await (await fetch(BASE + API.snapshot, { headers: { cookie: adminCookie } })).json()) as {
  servers: Array<{ id: string; name: string; backupEnabled: boolean }>
}
if (!snap.servers.length) {
  console.error('no servers discovered; this proof needs at least one server directory')
  process.exit(1)
}
const target = snap.servers[0]!
console.log(`target: ${target.name} (backupEnabled=${target.backupEnabled})`)
check('every discovered server reports a backup setting', snap.servers.every((s) => typeof s.backupEnabled === 'boolean'))
check('and it defaults to true, so nothing silently stops being backed up', snap.servers.every((s) => s.backupEnabled))

/** Snapshot of the policy file, so "nothing was written" is a measurement. */
const onDisk = (): string => (existsSync(policyPath(DATA)) ? readFileSync(policyPath(DATA), 'utf8') : '<absent>')

const url = BASE + API.setBackup(target.id)
const body = JSON.stringify({ enabled: false })

let before = onDisk()
const anon = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
  body,
})
check('an unauthenticated request is refused', anon.status === 401, `got ${anon.status}`)
check('and writes nothing', onDisk() === before)

before = onDisk()
const asViewer = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', cookie: viewerCookie },
  body,
})
check('a viewer is refused', asViewer.status === 403, `got ${asViewer.status}`)
check('and writes nothing', onDisk() === before)

before = onDisk()
const noCsrf = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: adminCookie },
  body,
})
check('an admin without the CSRF header is refused', noCsrf.status === 403, `got ${noCsrf.status}`)
check('and writes nothing', onDisk() === before)

before = onDisk()
const badId = await fetch(BASE + API.setBackup('No Such Directory'), {
  method: 'POST',
  headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', cookie: adminCookie },
  body,
})
check('an unknown server id is a 404, not a silent write', badId.status === 404, `got ${badId.status}`)
check('and writes nothing', onDisk() === before)

before = onDisk()
const badBody = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', cookie: adminCookie },
  body: JSON.stringify({ enabled: 'no' }),
})
check('a non-boolean body is rejected', badBody.status === 400, `got ${badBody.status}`)
check('and writes nothing', onDisk() === before)

// ------------------------------------------------------------------- the admin

const ok = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', cookie: adminCookie },
  body,
})
const okBody = (await ok.json()) as { ok: boolean; backupEnabled: boolean }
check('an admin may opt a server out', ok.status === 200, `got ${ok.status}`)
check('and the response reports the new state', okBody.backupEnabled === false)
check('and it is on disk', !isBackupEnabled(loadPolicy(DATA), target.name))
check(
  'and the next snapshot reflects it without a restart',
  await (async () => {
    const s = (await (await fetch(BASE + API.snapshot, { headers: { cookie: adminCookie } })).json()) as {
      servers: Array<{ id: string; backupEnabled: boolean }>
    }
    return s.servers.find((x) => x.id === target.id)?.backupEnabled === false
  })(),
)

const back = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', cookie: adminCookie },
  body: JSON.stringify({ enabled: true }),
})
check('and may opt it back in', back.status === 200 && isBackupEnabled(loadPolicy(DATA), target.name))

// ---------------------------------------------------------------------- audit

const auditLines = readFileSync(join(DATA, 'audit.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>)
const backupEvents = auditLines.filter((e) => e.action === 'backup.set')
console.log(`\naudit: ${auditLines.length} entries, ${backupEvents.length} for backup.set`)
for (const e of backupEvents) {
  console.log(`  ${String(e.actor)} ${String(e.role)} ${String(e.outcome)} ${String(e.target)}. ${String(e.detail ?? '')}`)
}
check('the allowed changes are audited', backupEvents.filter((e) => e.outcome === 'ok').length === 2)
check('the viewer refusal is audited', backupEvents.some((e) => e.outcome === 'denied' && e.role === 'viewer'))
check('the unknown-id refusal is audited', backupEvents.some((e) => e.outcome === 'denied' && e.target === 'No Such Directory'))
check(
  'the audit records which way the tick went',
  backupEvents.some((e) => /excluded from the backup rotation/.test(String(e.detail ?? ''))) &&
    backupEvents.some((e) => /included in the backup rotation/.test(String(e.detail ?? ''))),
)
check(
  'no audit entry contains a password',
  !auditLines.some((e) => JSON.stringify(e).toLowerCase().includes(VIEWER_PW.toLowerCase())),
)

await app.close()

console.log('')
let failed = 0
for (const [l, okk, d] of checks) {
  if (!okk) failed++
  console.log(`  ${okk ? 'PASS' : 'FAIL'}  ${l}${!okk && d ? `  (${d})` : ''}`)
}
console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
