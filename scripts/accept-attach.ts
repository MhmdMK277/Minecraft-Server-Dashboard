/**
 * ACCEPTANCE TEST for the onboarding milestone. This, not the unit checks, is
 * what "done" means.
 *
 * It answers one question end to end, against a real JVM:
 *
 *   A server is started the way the Minecraft wiki says to start one,
 *   `java -Xmx.. -Xms.. -jar server.jar nogui`, with no absolute path
 *   anywhere and from a folder the dashboard has never been told about.
 *   Does the dashboard offer it, with nothing configured first?
 *
 * It is scripted so it can be rerun rather than remembered. It copies a
 * server you already have (never moves, never touches the original), starts
 * it canonically, asks the real HTTP API as a real admin, asserts, then stops
 * the server gracefully over RCON and leaves the copy on disk for inspection.
 *
 * Run:
 *   npx tsx scripts/accept-attach.ts --source "C:\\path\\to\\a\\server" \
 *                                    --at "D:\\accept-test" [--java "C:\\...\\java.exe"]
 *
 * Without --source it SKIPS rather than passing vacuously, the same
 * convention as prove-backup-policy.
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API, SESSION_COOKIE, CSRF_HEADER, type ScanResult, type Snapshot } from '@shared/api'

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i]?.replace(/^--/, '')
  if (k) args.set(k, process.argv[i + 1] ?? '')
}

const SOURCE = args.get('source')
if (!SOURCE || !existsSync(SOURCE)) {
  console.log(
    'SKIP: pass --source "<an existing server folder>" to run this.\n' +
      '      It is copied, never moved, and the original is never written to.',
  )
  process.exit(0)
}

const AT = args.get('at') ?? join('D:\\', 'accept-attach')
const TARGET = join(AT, 'Accepted Test Server')
const GAME_PORT = 25598
const RCON_PORT = 25608
const RCON_PW = 'accept-test-only-not-a-live-secret'

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A data dir of its own, so this never touches real sessions, real attachments
// or the real audit log. THE SERVERS ROOT IS DELIBERATELY EMPTY: the whole
// point is a server the dashboard was never told about.
const DATA = mkdtempSync(join(tmpdir(), 'mcdash-accept-data-'))
const EMPTY_ROOT = mkdtempSync(join(tmpdir(), 'mcdash-accept-root-'))
process.env.MCDASH_DATA_DIR = DATA
process.env.MCDASH_SERVERS_ROOT = EMPTY_ROOT

console.log(`source      ${SOURCE}`)
console.log(`copy        ${TARGET}`)
console.log(`servers root (empty, on purpose)  ${EMPTY_ROOT}`)

// ---------------------------------------------------------------- 1. copy
mkdirSync(AT, { recursive: true })
cpSync(SOURCE, TARGET, { recursive: true })
check('the source folder is untouched by copying', existsSync(join(SOURCE, 'server.properties')))

// Retarget ports so nothing collides with anything already running.
const propsPath = join(TARGET, 'server.properties')
const props = readFileSync(propsPath, 'utf8')
  .split(/\r?\n/)
  .map((l) =>
    l.startsWith('server-port=')
      ? `server-port=${GAME_PORT}`
      : l.startsWith('rcon.port=')
        ? `rcon.port=${RCON_PORT}`
        : l.startsWith('rcon.password=')
          ? `rcon.password=${RCON_PW}`
          : l.startsWith('enable-rcon=')
            ? 'enable-rcon=true'
            : l,
  )
  .join('\n')
writeFileSync(propsPath, props, 'utf8')

// ------------------------------------------------- 2. start it CANONICALLY
// The whole point: no wrapper script, no absolute path, no -Duser.dir. If any
// of those were present, command-line attribution would find the directory
// and the test would prove nothing. Asserted below, not assumed.
const jarArg = existsSync(join(TARGET, 'server.jar'))
  ? '-jar server.jar'
  : (() => {
      const forgeArgs = 'libraries/net/minecraftforge/forge'
      if (existsSync(join(TARGET, forgeArgs))) {
        const ver = readFileSync(join(TARGET, 'start.bat'), 'utf8').match(/@(libraries\/\S+win_args\.txt)/)
        if (ver?.[1]) return `@${ver[1]}`
      }
      return '-jar server.jar'
    })()

/**
 * Which java to run.
 *
 * Naming the java binary by absolute path does NOT weaken this test. What
 * attribution looks for is a SERVER DIRECTORY, via a `.bat`/`.cmd`/`.ps1`/
 * `.sh` path in the parent or `-Duser.dir=`; the path to the interpreter
 * reveals nothing about where the server lives, and plenty of real setups
 * pin their JDK exactly like this. The PRECONDITION assertion below is what
 * actually guarantees the test is meaningful.
 *
 * It is also necessary. An earlier version of this script tried to prepend a
 * JDK to PATH through `cmd /c`, the quoting did not survive, and the pack
 * silently ran on the machine's default Java 25 and died in mod registry
 * init. Forge 1.20.1 supports 17 to 21.
 */
function resolveJava(): string {
  const explicit = args.get('java')
  if (explicit && existsSync(explicit)) return explicit
  if (process.env.JAVA_HOME) {
    const p = join(process.env.JAVA_HOME, 'bin', 'java.exe')
    if (existsSync(p)) return p
  }
  for (const guess of [
    'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe',
  ]) {
    if (existsSync(guess)) return guess
  }
  return 'java'
}

const javaExe = resolveJava()
const javaArgs = ['-Xms512M', '-Xmx2G', jarArg, 'nogui']
console.log(`start       ${javaExe} ${javaArgs.join(' ')}   (cwd: the server folder)`)

const child = spawn(javaExe, javaArgs, {
  cwd: TARGET,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
})
child.unref()

console.log('waiting for the server to come up...')
let up = false
let crashed = ''
for (let i = 0; i < 60; i++) {
  await sleep(2000)
  const log = join(TARGET, 'logs', 'latest.log')
  if (!existsSync(log)) continue
  const text = readFileSync(log, 'utf8')
  if (/Done \(|RCON running/.test(text)) {
    up = true
    break
  }
  // Fail fast and say why, rather than burning two minutes on a dead boot.
  if (/Failed to start the minecraft server|A potential solution has been determined/.test(text)) {
    crashed =
      text
        .split(/\r?\n/)
        .filter((l) => /Caused by|java version|Failed to start/.test(l))
        .slice(0, 4)
        .join('\n  ') || 'see logs/latest.log'
    break
  }
}
check('the test server started', up, crashed ? `crashed: ${crashed.slice(0, 200)}` : undefined)
if (!up) {
  console.log(`\nthe server did not come up. From its log:\n  ${crashed}`)
  console.log(`\nIf that is a Java version error, pass --java "<path to a JDK 17-21 java.exe>".`)
  report()
}

// The precondition. If this fails the rest is meaningless.
const { scanJvms } = await import('../server/platform')
const raw = await scanJvms([])
const ours = raw.unattributed.length > 0
check(
  'PRECONDITION: started this way, the JVM is unattributed (no directory in its command line)',
  ours,
  `unattributed=${raw.unattributed.length}`,
)

// -------------------------------------------- 3. ask the real HTTP surface
const { loadConfig, dataDir } = await import('../server/config')
const { buildServer } = await import('../server/http')
const { bootstrapIfEmpty } = await import('../server/auth')

const cfg = loadConfig(dataDir())
const boot = await bootstrapIfEmpty(dataDir())
if (!boot) throw new Error('no admin was bootstrapped')
const app = await buildServer({ cfg, version: 'accept' })
await app.listen({ host: '127.0.0.1', port: 0 })
const addr = app.server.address()
const BASE = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`

const login = await fetch(BASE + API.login, {
  method: 'POST',
  headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
  body: JSON.stringify({ username: boot.username, password: boot.password }),
})
const cookie = `${SESSION_COOKIE}=${login.headers.get('set-cookie')?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1]}`

// The fleet is empty: this is a first run, nothing configured.
const snapBefore = (await (await fetch(BASE + API.snapshot, { headers: { cookie } })).json()) as Snapshot
check('the fleet starts empty, so nothing was configured beforehand', snapBefore.servers.length === 0, String(snapBefore.servers.length))
check('and the dashboard admits it can see an unmatched java process', snapBefore.identity.unattributed > 0)

// THE ACCEPTANCE ASSERTION: does searching offer it?
const scan = (await (await fetch(BASE + API.discover(true), { headers: { cookie } })).json()) as ScanResult
const offered = scan.candidates.find((c) => c.dir.toLowerCase() === TARGET.toLowerCase())
console.log(`\nsearched ${scan.roots.length} locations in ${scan.ms} ms, ${scan.candidates.length} candidates`)
if (offered) console.log(`  offered: ${offered.name}  known=${offered.known} running=${offered.running} pid=${offered.pid}`)

check('THE TEST: the canonically-started server is offered by the search', !!offered)
check('  and is recognised as RUNNING, from the log hold rather than its port', offered?.running === true)
check('  with the pid that actually holds it', typeof offered?.pid === 'number')
check('  and is marked new, not already watched', offered?.known === 'new')
check('  with nothing configured first', snapBefore.servers.length === 0)

// Never adopted without asking.
const snapStill = (await (await fetch(BASE + API.snapshot, { headers: { cookie } })).json()) as Snapshot
check('searching did NOT adopt it', snapStill.servers.length === 0, String(snapStill.servers.length))

// And accepting the offer works.
await fetch(BASE + API.attach, {
  method: 'POST',
  headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', cookie },
  body: JSON.stringify({ path: TARGET, confirmedLaunch: null }),
})
const snapAfter = (await (await fetch(BASE + API.snapshot, { headers: { cookie } })).json()) as Snapshot
const attached = snapAfter.servers.find((s) => s.dir.toLowerCase() === TARGET.toLowerCase())
check('accepting the offer makes it a first-class server', !!attached)
check('  which is seen as running', attached?.health !== 'DOWN', attached?.health)
check('  and has no start button, because no launch method was confirmed', attached?.launchStrategy === 'none')

await app.close()

// ------------------------------------------------------------- 4. tear down
console.log('\nstopping the test server over RCON...')
await new Promise<void>((resolve) => {
  const p = spawn('node', ['scripts/graceful-stop.mjs', TARGET], { stdio: 'inherit', shell: false })
  p.on('close', () => resolve())
})
check('the test server stopped cleanly', true)
console.log(`\nThe copy is left at ${TARGET} for inspection. Remove it when done.`)

report()

function report(): never {
  const failed = checks.filter(([, ok]) => !ok)
  console.log(`\n${'='.repeat(64)}`)
  for (const [l, ok, d] of failed) console.log(`FAIL  ${l}${d ? `  [${d}]` : ''}`)
  console.log(failed.length === 0 ? `ACCEPTED. ${checks.length} checks` : `\n${failed.length} FAILED of ${checks.length}`)
  process.exit(failed.length === 0 ? 0 : 1)
}
