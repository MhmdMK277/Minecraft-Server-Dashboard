/**
 * PROOF: the cold-backup routes are gated, honest, and leave an audit trail.
 *
 * The engine's constraints (fresh detection, cold-only, outside-the-directory,
 * append-only manifest, restore-to-a-new-sibling) are proven by
 * prove-cold-backup against the module. What has had NO evidence until now is
 * the HTTP layer above it: that every route refuses the right callers, that a
 * refusal carries the engine's sentence verbatim as a 409, that the manifest
 * and destination stay untouched on every refusal, and above all that every
 * attempt -- allowed or refused, finished or in flight -- appears in the audit
 * log. An archive or a restore is exactly the kind of act you reconstruct
 * from that log after something went wrong.
 *
 * Runs against a real service on an ephemeral port with a THROWAWAY data dir
 * AND a throwaway servers root holding one small fake server, so the success
 * path (a real bsdtar zip, a real sha256, a real restore into a new sibling)
 * is exercised end to end without touching the fleet.
 *
 * Environment note: occupancy of the fake directory is judged against the
 * REAL process table. If an unattributable java.exe is running on this host,
 * doubt counts as running and the success path will refuse; that is the
 * guard working, and this proof failing then is a fact about the host, said
 * out loud, not a flake to suppress.
 *
 * Run:  npx tsx scripts/prove-coldbackup-route.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API, SESSION_COOKIE, CSRF_HEADER } from '../shared/api'

const DATA = mkdtempSync(join(tmpdir(), 'mcdash-cbroute-'))
const ROOT = mkdtempSync(join(tmpdir(), 'mcdash-cbroot-'))
process.env.MCDASH_DATA_DIR = DATA
process.env.MCDASH_SERVERS_ROOT = ROOT

// One small fake server, stopped, with nothing backing it up: the exact
// population decision 0005 allows the offer for.
const NAME = 'MC Cold Fake'
const DIR = join(ROOT, NAME)
mkdirSync(join(DIR, 'world'), { recursive: true })
mkdirSync(join(DIR, 'logs'), { recursive: true })
writeFileSync(join(DIR, 'world', 'level.dat'), 'not-a-real-world')
writeFileSync(join(DIR, 'server.properties'), 'server-port=25998\nlevel-name=world\nenable-rcon=false\n')

const DEST = mkdtempSync(join(tmpdir(), 'mcdash-cbdest-'))

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

const snap = (await (await fetch(BASE + API.snapshot, { headers: { cookie: adminCookie } })).json()) as {
  servers: Array<{ id: string; name: string }>
}
const target = snap.servers.find((s) => s.name === NAME)
if (!target) {
  console.error(`the fake server was not discovered (got: ${snap.servers.map((s) => s.name).join(', ') || 'none'})`)
  process.exit(1)
}
console.log(`target: ${target.name} (${target.id}) in throwaway root ${ROOT}`)

const manifest = () =>
  existsSync(join(DATA, 'coldbackup-manifest.jsonl')) ? readFileSync(join(DATA, 'coldbackup-manifest.jsonl'), 'utf8') : '<absent>'
const destFiles = () => readdirSync(DEST)

const post = (url: string, body: unknown, headers: Record<string, string>) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

// ------------------------------------------------------------------ the gate

const listAnon = await fetch(BASE + API.coldBackups(target.id))
check('listing archives unauthenticated is refused', listAnon.status === 401, `got ${listAnon.status}`)
const listViewer = await fetch(BASE + API.coldBackups(target.id), { headers: { cookie: viewerCookie } })
check('a viewer may not even list archives', listViewer.status === 403, `got ${listViewer.status}`)
const listAdmin = await fetch(BASE + API.coldBackups(target.id), { headers: { cookie: adminCookie } })
const listBody = (await listAdmin.json()) as { entries: unknown[] }
check('an admin sees an empty manifest before any backup', listAdmin.status === 200 && listBody.entries.length === 0)

const runUrl = BASE + API.runColdBackup(target.id)

const runAnon = await post(runUrl, { destDir: DEST }, { [CSRF_HEADER]: '1' })
check('an unauthenticated run is refused', runAnon.status === 401, `got ${runAnon.status}`)
const runViewer = await post(runUrl, { destDir: DEST }, { [CSRF_HEADER]: '1', cookie: viewerCookie })
check('a viewer may not take a backup', runViewer.status === 403, `got ${runViewer.status}`)
const runNoCsrf = await post(runUrl, { destDir: DEST }, { cookie: adminCookie })
check('an admin without the CSRF header is refused', runNoCsrf.status === 403, `got ${runNoCsrf.status}`)
const runBadBody = await post(runUrl, { dest: DEST }, { [CSRF_HEADER]: '1', cookie: adminCookie })
check('a malformed body is a 400', runBadBody.status === 400, `got ${runBadBody.status}`)
const runBadId = await post(BASE + API.runColdBackup('No Such Server'), { destDir: DEST }, { [CSRF_HEADER]: '1', cookie: adminCookie })
check('an unknown server id is a 404', runBadId.status === 404, `got ${runBadId.status}`)
check('and none of that touched the manifest', manifest() === '<absent>')
check('or the destination', destFiles().length === 0)

// ------------------------------------- a refusal carries the engine sentence

const inside = await post(runUrl, { destDir: join(DIR, 'backups') }, { [CSRF_HEADER]: '1', cookie: adminCookie })
const insideBody = (await inside.json()) as { error?: string }
check('a destination inside the server directory is a 409, not a 500', inside.status === 409, `got ${inside.status}`)
check(
  'and the response carries the engine sentence verbatim',
  /inside the server directory/.test(insideBody.error ?? '') && /Nothing was written/.test(insideBody.error ?? ''),
  insideBody.error,
)
check('and the manifest is still untouched', manifest() === '<absent>')

// ------------------------------------------------------------- a real backup

const run = await post(runUrl, { destDir: DEST }, { [CSRF_HEADER]: '1', cookie: adminCookie })
const runBody = (await run.json()) as { ok?: boolean; entry?: { id: string; sha256: string; archivePath: string; bytes: number } }
check('an admin takes a real cold backup through the route', run.status === 200 && runBody.ok === true, JSON.stringify(runBody))
check('the entry records a sha256', !!runBody.entry && /^[0-9a-f]{64}$/.test(runBody.entry.sha256))
check('the archive exists at the destination', !!runBody.entry && existsSync(runBody.entry.archivePath))
check('the manifest now has exactly one line', manifest().split(/\r?\n/).filter(Boolean).length === 1)

const listAfter = (await (await fetch(BASE + API.coldBackups(target.id), { headers: { cookie: adminCookie } })).json()) as {
  entries: Array<{ id: string }>
}
check('the route lists what it wrote', listAfter.entries.length === 1 && listAfter.entries[0]!.id === runBody.entry!.id)

// ------------------------------------------------------------------- restore

const restoreUrl = BASE + API.restoreColdBackup(target.id)
const restViewer = await post(restoreUrl, { archiveId: runBody.entry!.id }, { [CSRF_HEADER]: '1', cookie: viewerCookie })
check('a viewer may not restore', restViewer.status === 403, `got ${restViewer.status}`)
const restUnknown = await post(restoreUrl, { archiveId: 'cb-nope' }, { [CSRF_HEADER]: '1', cookie: adminCookie })
const restUnknownBody = (await restUnknown.json()) as { error?: string }
check('an unknown archive id is a 409 with the manifest rule stated', restUnknown.status === 409 && /Only archives this dashboard wrote/.test(restUnknownBody.error ?? ''), restUnknownBody.error)

const rest = await post(restoreUrl, { archiveId: runBody.entry!.id }, { [CSRF_HEADER]: '1', cookie: adminCookie })
const restBody = (await rest.json()) as { ok?: boolean; restoredDir?: string }
check('an admin restores through the route', rest.status === 200 && restBody.ok === true, JSON.stringify(restBody))
check('into a NEW sibling, never over the original', !!restBody.restoredDir && restBody.restoredDir !== DIR && existsSync(restBody.restoredDir))
check(
  'and the restored sibling contains the world',
  !!restBody.restoredDir && existsSync(join(restBody.restoredDir, 'world', 'level.dat')),
)
check('the original directory was not replaced', existsSync(join(DIR, 'world', 'level.dat')))

// ---------------------------------------------------------------------- audit

const auditLines = readFileSync(join(DATA, 'audit.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>)
const cb = auditLines.filter((e) => String(e.action).startsWith('coldbackup.'))
console.log(`\naudit: ${auditLines.length} entries, ${cb.length} under coldbackup.*`)
for (const e of cb) {
  console.log(`  ${String(e.action).padEnd(28)} ${String(e.outcome).padEnd(7)} ${String(e.actor)} -> ${String(e.target)}`)
}
check(
  'the run was audited twice: requested first, outcome after',
  cb.some((e) => e.action === 'coldbackup.run.requested' && e.outcome === 'ok' && e.target === NAME) &&
    cb.some((e) => e.action === 'coldbackup.run' && e.outcome === 'ok' && e.target === NAME),
)
check(
  'the successful run audit line carries the archive path and hash',
  cb.some(
    (e) =>
      e.action === 'coldbackup.run' &&
      e.outcome === 'ok' &&
      /sha256 [0-9a-f]{64}/.test(String(e.detail ?? '')) &&
      String(e.detail ?? '').includes(runBody.entry!.archivePath),
  ),
)
check(
  'the engine refusal is audited with its reason',
  cb.some((e) => e.action === 'coldbackup.run' && e.outcome === 'denied' && /inside the server directory/.test(String(e.detail ?? ''))),
)
check(
  'the unknown-id refusal is audited',
  cb.some((e) => e.action === 'coldbackup.run' && e.outcome === 'denied' && /no such server directory/.test(String(e.detail ?? ''))),
)
check(
  'the viewer attempts are audited as denied',
  cb.some((e) => e.action === 'coldbackup.run' && e.outcome === 'denied' && e.role === 'viewer') &&
    cb.some((e) => e.action === 'coldbackup.restore' && e.outcome === 'denied' && e.role === 'viewer') &&
    cb.some((e) => e.action === 'coldbackup.list' && e.outcome === 'denied' && e.role === 'viewer'),
)
check(
  'the restore was audited twice: requested first, outcome after',
  cb.some((e) => e.action === 'coldbackup.restore.requested' && e.target === runBody.entry!.id) &&
    cb.some((e) => e.action === 'coldbackup.restore' && e.outcome === 'ok' && e.target === runBody.entry!.id),
)
check(
  'the failed restore is audited with its reason',
  cb.some((e) => e.action === 'coldbackup.restore' && e.outcome === 'denied' && /Only archives this dashboard wrote/.test(String(e.detail ?? ''))),
)
check(
  'no audit entry contains a password',
  !auditLines.some((e) => JSON.stringify(e).toLowerCase().includes(VIEWER_PW.toLowerCase())),
)

await app.close()
console.log(`\nthrowaway root, data dir and destination left in place (nothing is deleted): \n  ${ROOT}\n  ${DATA}\n  ${DEST}`)

console.log('')
let failed = 0
for (const [l, okk, d] of checks) {
  if (!okk) failed++
  console.log(`  ${okk ? 'PASS' : 'FAIL'}  ${l}${!okk && d ? `  (${d})` : ''}`)
}
console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
