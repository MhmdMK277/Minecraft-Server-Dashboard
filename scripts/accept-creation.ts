/**
 * ACCEPTANCE: creation produces a real server, end to end, with no shortcuts.
 *
 * The unit proofs (prove-creation, 113 checks) exercise every refusal against
 * fixtures. What none of them can claim is that the whole path works against
 * the real world: the real Mojang metadata, the real download, the real jar,
 * a real JVM, a real world generated on this disk. This script claims exactly
 * that, the same standard the release zip is held to by accept-release:
 *
 *   1. A real Fastify instance (throwaway data dir and servers root) accepts
 *      a Vanilla creation for the latest release, through the same HTTP
 *      routes the UI calls, EULA consent and all.
 *   2. Checksum enforcement is verified INDEPENDENTLY: this script fetches
 *      Mojang's declared sha1 and size itself, straight from piston-meta,
 *      and recomputes the digest of the jar that landed on disk. The test
 *      does not trust the code under test to grade its own homework.
 *   3. The generated RCON password stays where it belongs: it exists in
 *      server.properties, and the jobs API, the audit log and this output
 *      never contain it.
 *   4. The new folder arrives as a NORMAL server: before its first start,
 *      discovery lists it as "no world yet" (not as a server, not as junk);
 *      it is started EXACTLY ONCE through the dashboard's own start path; a
 *      second start is refused by the double-spawn guard; and after the
 *      world exists, discovery reports it like any other server.
 *   5. It is stopped through the dashboard's own stop path, which is RCON
 *      with the generated password, proving that password works without
 *      ever printing it.
 *
 * WORLD: a real Minecraft server runs for a few minutes in a temp directory
 * and generates a real world there. Ports are the suggestions from the info
 * route, which dodge everything declared and everything listening, so the
 * real fleet is not touched. The temp directories are left in place, nothing
 * on this host is deleted.
 *
 * Run:  npx tsx scripts/accept-creation.ts        (needs network and Java)
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API, SESSION_COOKIE, CSRF_HEADER, type CreationJobStatus, type CreationInfo } from '../shared/api'

const DATA = mkdtempSync(join(tmpdir(), 'mcdash-accept-create-'))
const ROOT = join(DATA, 'servers-root')
mkdirSync(ROOT, { recursive: true })
process.env.MCDASH_DATA_DIR = DATA
process.env.MCDASH_SERVERS_ROOT = ROOT

const { loadConfig, dataDir } = await import('../server/config')
const { buildServer } = await import('../server/http')
const { bootstrapIfEmpty } = await import('../server/auth')
const { scan } = await import('../server/discovery')
const { detectLauncher, indexTasks } = await import('../server/launcher')
const { startServer, stopServer, occupancyOf, resetLocks } = await import('../server/control')

const NAME = 'Accept Vanilla'
const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const cfg = loadConfig(dataDir())
const boot = await bootstrapIfEmpty(dataDir())
if (!boot) {
  console.error('bootstrap produced no admin')
  process.exit(1)
}
const app = await buildServer({ cfg, version: 'acceptance' })
await app.listen({ host: '127.0.0.1', port: 0 })
const addr = app.server.address()
const BASE = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`

const login = await fetch(BASE + API.login, {
  method: 'POST',
  headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
  body: JSON.stringify({ username: boot.username, password: boot.password }),
})
const cookie = `${SESSION_COOKIE}=${login.headers.get('set-cookie')?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1] ?? ''}`
const H = { 'content-type': 'application/json', cookie, [CSRF_HEADER]: '1' }

// ---------------------------------------------------------------------------
console.log('\n=== 1. the request, through the same routes the UI calls ===\n')
// ---------------------------------------------------------------------------

const info = (await (await fetch(BASE + API.createInfo(), { headers: { cookie } })).json()) as CreationInfo
const versions = (await (await fetch(BASE + API.createVersions('vanilla'), { headers: { cookie } })).json()) as {
  versions: string[]
}
const MC = versions.versions[0]!
console.log(`version   : ${MC} (latest release, the UI default)`)
console.log(`ports     : game ${info.suggestedGamePort}, rcon ${info.suggestedRconPort}`)
check('the info route suggested two distinct free ports', info.suggestedGamePort !== info.suggestedRconPort)

/**
 * The independent truth: Mojang's own declaration of what the server jar for
 * this version is, fetched by THIS SCRIPT, not by the code under test.
 */
const manifest = (await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json()) as {
  versions: Array<{ id: string; url: string }>
}
const entry = manifest.versions.find((v) => v.id === MC)
if (!entry) throw new Error(`Mojang's manifest has no entry for ${MC}`)
const detail = (await (await fetch(entry.url)).json()) as {
  downloads: { server: { sha1: string; size: number; url: string } }
}
const declared = detail.downloads.server
console.log(`declared  : sha1 ${declared.sha1}, ${(declared.size / 1024 / 1024).toFixed(1)} MB`)

const created = await fetch(BASE + API.create, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    name: NAME,
    flavor: 'vanilla',
    mcVersion: MC,
    loaderVersion: null,
    gamePort: info.suggestedGamePort,
    rconPort: info.suggestedRconPort,
    eulaAccepted: true,
    memoryMb: 2048,
    javaMode: 'existing',
  }),
})
const createdBody = (await created.json()) as { opId?: string; dir?: string; error?: string }
check('the creation request was accepted', created.status === 200, createdBody.error)
if (created.status !== 200) {
  console.error(`creation refused: ${createdBody.error}`)
  process.exit(1)
}
const DIR = createdBody.dir!
const OP = createdBody.opId!
console.log(`folder    : ${DIR}`)

// ---------------------------------------------------------------------------
console.log('\n=== 2. the download, watched to completion ===\n')
// ---------------------------------------------------------------------------

let job: CreationJobStatus | null = null
const t0 = Date.now()
while (Date.now() - t0 < 300_000) {
  const jobs = (await (await fetch(BASE + API.createJobs, { headers: { cookie } })).json()) as {
    jobs: CreationJobStatus[]
  }
  job = jobs.jobs.find((j) => j.opId === OP) ?? null
  if (job && (job.state === 'complete' || job.state === 'failed')) break
  await sleep(2000)
}
console.log(`state     : ${job?.state} after ${Math.round((Date.now() - t0) / 1000)}s`)
if (job?.state !== 'complete') {
  console.error(`creation did not complete: ${job?.error ?? 'timed out'}`)
  process.exit(1)
}
check('the creation completed', job.state === 'complete')

// ---------------------------------------------------------------------------
console.log('\n=== 3. checksum enforcement, verified independently ===\n')
// ---------------------------------------------------------------------------

const jarName = 'server.jar'
const jarPath = join(DIR, jarName)
check('the server jar landed under its publisher name', existsSync(jarPath), jarName)
check('no .part file was left behind', !existsSync(`${jarPath}.part`))

const bytes = readFileSync(jarPath)
const sha1 = createHash('sha1').update(bytes).digest('hex')
console.log(`on disk   : sha1 ${sha1}, ${(bytes.length / 1024 / 1024).toFixed(1)} MB`)
check(
  'the jar on disk hashes to exactly what Mojang declares for this version',
  sha1 === declared.sha1,
  `${sha1} vs ${declared.sha1}`,
)
check('and is exactly the declared size', bytes.length === declared.size, `${bytes.length} vs ${declared.size}`)

const props = readFileSync(join(DIR, 'server.properties'), 'utf8')
const password = /rcon\.password=(\S+)/.exec(props)?.[1] ?? ''
check('RCON is enabled in the written config', props.includes('enable-rcon=true'))
check('the generated password is real, not blank or short', password.length >= 20)
check('eula.txt cites the EULA it accepts', readFileSync(join(DIR, 'eula.txt'), 'utf8').includes('https://aka.ms/MinecraftEULA'))

const auditRaw = readFileSync(join(DATA, 'audit.jsonl'), 'utf8')
check('the EULA acceptance is in the audit log', auditRaw.includes('create.eula-accepted'))
check('so is the completion', auditRaw.includes('create.complete'))
const jobsRaw = JSON.stringify(await (await fetch(BASE + API.createJobs, { headers: { cookie } })).json())
check('the password appears nowhere in the jobs API', !jobsRaw.includes(password))
check('and nowhere in the audit log', !auditRaw.includes(password))

// ---------------------------------------------------------------------------
console.log('\n=== 4. before its first start, discovery calls it what it is ===\n')
// ---------------------------------------------------------------------------

// Spec section 9, amended 2026-08-01: a folder with server.properties and no
// world is a SERVER that has never started, not junk, and it must arrive as
// a row carrying the ordinary start path. A server we can create but cannot
// start from the dashboard would be broken.
const snap1 = await scan(ROOT)
const row = snap1.servers.find((s) => s.name === NAME)
check('the never-started folder appears as a server row', !!row)
check('classified never-started, not live and not junk', row?.classification === 'never-started', row?.classification)
check('and not in the ignored list', !snap1.ignored.some((d) => d.name === NAME))
check('its health detail says what it is and what fixes it', /Never started/.test(row?.healthDetail ?? ''), row?.healthDetail)
check(
  'the row carries the NORMAL start path: the created start.bat was detected',
  row?.launchStrategy === 'script',
  row?.launchStrategy,
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. started exactly once, through the dashboard start path ===\n')
// ---------------------------------------------------------------------------

resetLocks()
const target = { id: NAME, name: NAME, dir: DIR }
const launcher = detectLauncher(DIR, await indexTasks())
check('the created start.bat is detected as the script launcher', launcher.strategy === 'script', launcher.strategy)

const started = await startServer(target, launcher)
console.log(`start     : ${started.ok ? 'OK' : 'REFUSED'} ${started.detail}`)
check('the dashboard start path starts it', started.ok, started.detail)

// Boot to readiness: the world exists and the log says Done.
const t1 = Date.now()
let ready = false
while (Date.now() - t1 < 240_000) {
  const log = existsSync(join(DIR, 'logs', 'latest.log')) ? readFileSync(join(DIR, 'logs', 'latest.log'), 'utf8') : ''
  if (/Done \(/.test(log) && existsSync(join(DIR, 'world', 'level.dat'))) {
    ready = true
    break
  }
  await sleep(3000)
}
console.log(`boot      : ${ready ? 'Done' : 'not ready'} after ${Math.round((Date.now() - t1) / 1000)}s`)
check('the server boots and generates a real world', ready)

const twice = await startServer(target, launcher)
console.log(`again     : ${twice.ok ? 'STARTED (bad)' : 'REFUSED'} ${twice.detail}`)
check('a second start is refused: exactly once is enforced', !twice.ok, twice.detail)
check('and the refusal names the running pid', /pid \d+/.test(twice.detail), twice.detail)

// ---------------------------------------------------------------------------
console.log('\n=== 6. it is a normal server now, and stops the normal way ===\n')
// ---------------------------------------------------------------------------

const snap2 = await scan(ROOT)
const asServer = snap2.servers.find((s) => s.name === NAME)
check('discovery now reports it as a server like any other', !!asServer)
check('the world exists, so the classification flipped to live', asServer?.classification === 'live', asServer?.classification)
check('with a live process attributed to it', !!asServer?.proc, asServer?.proc ? `pid ${asServer.proc.pid}` : 'none')

// Stop through the real path: RCON with the generated password, never a kill.
const stopped = await stopServer(target)
console.log(`stop      : ${stopped.ok ? 'OK' : 'FAILED'} ${stopped.detail}`)
check('the dashboard stop path stops it over RCON, generated password and all', stopped.ok, stopped.detail)

let gone = false
const t2 = Date.now()
while (Date.now() - t2 < 120_000) {
  const occ = await occupancyOf(DIR)
  if (occ.certain && occ.pids.length === 0) {
    gone = true
    break
  }
  await sleep(2000)
}
check('and the process is gone afterwards', gone)

// ---------------------------------------------------------------------------
console.log('\n=== 7. created outside the root, it ends attached and watched ===\n')
// ---------------------------------------------------------------------------

// Decision 0010: the operator may aim creation at any folder they pick. The
// unit matrix is prove-creation section 13; what only this script can claim
// is the real end: a real download into a real folder outside the root, and
// the finished server WATCHED, through the same scan that watches the fleet.
const OUTSIDE = mkdtempSync(join(tmpdir(), 'mcdash-accept-outside-'))
const NAME2 = 'Accept Outside'
const info2 = (await (await fetch(BASE + API.createInfo(), { headers: { cookie } })).json()) as CreationInfo
const created2 = await fetch(BASE + API.create, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    name: NAME2,
    flavor: 'vanilla',
    mcVersion: MC,
    loaderVersion: null,
    gamePort: info2.suggestedGamePort,
    rconPort: info2.suggestedRconPort,
    eulaAccepted: true,
    memoryMb: 2048,
    javaMode: 'existing',
    parentDir: OUTSIDE,
  }),
})
const created2Body = (await created2.json()) as { opId?: string; dir?: string; error?: string }
check('an outside-root creation is accepted through the route', created2.status === 200, created2Body.error)
if (created2.status === 200) {
  const DIR2 = created2Body.dir!
  console.log(`folder    : ${DIR2}`)
  let job2: CreationJobStatus | null = null
  const t3 = Date.now()
  while (Date.now() - t3 < 300_000) {
    const jobs2 = (await (await fetch(BASE + API.createJobs, { headers: { cookie } })).json()) as {
      jobs: CreationJobStatus[]
    }
    job2 = jobs2.jobs.find((j) => j.opId === created2Body.opId) ?? null
    if (job2 && (job2.state === 'complete' || job2.state === 'failed')) break
    await sleep(2000)
  }
  check('it completes', job2?.state === 'complete', job2?.error ?? job2?.state)
  check('the completion sentence states the attach and what detaching does', /attached/.test(job2?.detail ?? '') && /[Dd]etach/.test(job2?.detail ?? ''))

  const reg = JSON.parse(readFileSync(join(DATA, 'attached.json'), 'utf8')) as {
    attached: Array<{ dir: string; confirmedLaunch: { strategy: string; script?: string } | null }>
  }
  const entry = reg.attached.find((a) => a.dir.toLowerCase() === DIR2.toLowerCase())
  check('attached.json carries the folder', !!entry)
  check('with start.bat as the confirmed launcher', entry?.confirmedLaunch?.strategy === 'script' && entry?.confirmedLaunch?.script === 'start.bat')
  check('the attach was audited', readFileSync(join(DATA, 'audit.jsonl'), 'utf8').includes('create.attach'))

  const snap3 = await scan(ROOT)
  const row2 = snap3.servers.find((s) => s.dir.toLowerCase() === DIR2.toLowerCase())
  check('the same scan that watches the fleet lists it as a server row', !!row2)
  check('classified never-started, like any created server before first start', row2?.classification === 'never-started', row2?.classification)
  check('carrying the normal start path from the attach confirmation', row2?.launchStrategy === 'script', row2?.launchStrategy)
  check('and its attachment state is reported', snap3.attachments.some((a) => a.dir.toLowerCase() === DIR2.toLowerCase()))
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
console.log(`world: ${DATA} (left in place, like every proof world)`)
process.exit(fail === 0 ? 0 : 1)
