/**
 * ACCEPTANCE: the zip runs on a machine that has no Node, no npm and no git.
 *
 * This is the whole claim of the release artifact, and it is the one claim a
 * developer machine is worst placed to check, because a developer machine has
 * all three and every one of them is on PATH. So this test takes them away.
 *
 * What it does:
 *
 *   1. Extracts the zip somewhere else entirely, so it tests the ARTIFACT and
 *      not the staging directory it was assembled in. A file that never made
 *      it into the zip fails here.
 *   2. Builds an environment with PATH reduced to the two Windows system
 *      directories, and with every NODE_*, NPM_* and MCDASH_* variable
 *      removed. It then ASSERTS that `node`, `npm` and `git` cannot be
 *      resolved in that environment. Without that precondition the rest of
 *      this file proves nothing: it would just be a test running under the
 *      developer's own toolchain.
 *   3. Runs "Start Dashboard.bat" the way a double-click runs it, through
 *      cmd.exe, from the extracted folder.
 *   4. Asserts the service that comes up is the real one: the SPA shell, its
 *      built asset, the auth endpoint answering, and a guarded route
 *      answering 401 rather than serving data.
 *   5. Asserts the running process is the node.exe inside the folder, not one
 *      found somewhere on the machine.
 *   6. Asserts nothing new appeared in the unzipped folder. "Unzip and
 *      delete" is the install and the uninstall, and a release that scatters
 *      state next to itself breaks the second half of that.
 *
 * WORLD: no Minecraft server is involved and none is started. This says
 * nothing about discovery or health; it is about whether the artifact runs at
 * all on a bare machine. Its data directory and servers root are throwaway
 * temp directories, so it cannot read or write the real ones.
 *
 * What it still cannot prove, stated because the gap is the point: PATH is
 * not a clean machine. A genuinely fresh Windows install could differ in ways
 * an environment variable cannot simulate. See docs/install.md, "Verifying
 * this yourself".
 *
 * Run:  npx tsx scripts/accept-release.ts [--zip <path>] [--port 8479]
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

const REPO = resolve(import.meta.dirname, '..')
const PORT = Number(arg('port') ?? 8479)

const checks: Array<[string, boolean, string?]> = []
const check = (label: string, ok: boolean, detail?: string) => checks.push([label, ok, detail])

// ------------------------------------------------------------------ the zip
const zip =
  arg('zip') ??
  (() => {
    const dir = join(REPO, 'release')
    if (!existsSync(dir)) return null
    const found = readdirSync(dir)
      .filter((f) => f.endsWith('.zip'))
      .sort()
      .pop()
    return found ? join(dir, found) : null
  })()

if (!zip || !existsSync(zip)) {
  console.error('FAIL: no zip found. Run `npx tsx scripts/package-release.ts` first.')
  process.exit(1)
}
console.log(`artifact: ${zip} (${(statSync(zip).size / 1024 / 1024).toFixed(1)} MB)\n`)

const work = mkdtempSync(join(tmpdir(), 'mcdash-accept-release-'))
const dataDir = mkdtempSync(join(tmpdir(), 'mcdash-accept-data-'))
const serversRoot = mkdtempSync(join(tmpdir(), 'mcdash-accept-servers-'))

execFileSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -Path '${zip}' -DestinationPath '${work}' -Force`],
  { stdio: 'inherit' },
)

const roots = readdirSync(work)
const appDir = roots.length === 1 && roots[0] ? join(work, roots[0]) : work
check('the zip contains a single named folder, not loose files', roots.length === 1, roots.join(', '))
check('the launcher is in it', existsSync(join(appDir, 'Start Dashboard.bat')))
check('the bundled runtime is in it', existsSync(join(appDir, 'node', 'node.exe')))
check('the service bundle is in it', existsSync(join(appDir, 'app', 'server.mjs')))
check('the built UI is in it', existsSync(join(appDir, 'dist', 'index.html')))
check('the version file the service reads is in it', existsSync(join(appDir, 'package.json')))
check('a plain-text readme is in it', existsSync(join(appDir, 'README.txt')))
check('the licence is in it', existsSync(join(appDir, 'LICENSE')))
check('third-party notices are in it', existsSync(join(appDir, 'THIRD-PARTY-NOTICES.txt')))

// A release that shipped the repository by accident is a different failure
// from a release that is missing a file, and both are worth catching.
for (const forbidden of ['node_modules', 'server', 'web', 'shared', 'scripts', '.git']) {
  check(`no ${forbidden} directory was shipped`, !existsSync(join(appDir, forbidden)))
}

const before = readdirSync(appDir).sort().join('|')

// ------------------------------------------- the environment without a toolchain
/**
 * PATH reduced to the two directories Windows itself needs. Everything that
 * could reintroduce a toolchain, including npm's own variables and any
 * MCDASH_ setting inherited from this shell, is dropped.
 */
const bare: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue
  const key = k.toUpperCase()
  if (key === 'PATH') continue
  if (key.startsWith('NODE') || key.startsWith('NPM_') || key.startsWith('MCDASH_')) continue
  bare[k] = v
}
bare.PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\system32;${process.env.SystemRoot ?? 'C:\\Windows'}`
bare.MCDASH_PORT = String(PORT)
bare.MCDASH_DATA_DIR = dataDir
bare.MCDASH_SERVERS_ROOT = serversRoot

/** The precondition. Without this the rest of the file is meaningless. */
function resolvable(tool: string): boolean {
  try {
    const out = execFileSync('cmd.exe', ['/c', 'where', tool], { env: bare, encoding: 'utf8' })
    return out.trim().length > 0
  } catch {
    return false
  }
}
for (const tool of ['node', 'npm', 'npx', 'git']) {
  check(`PRECONDITION: ${tool} cannot be found in the test environment`, !resolvable(tool))
}
// ...and the same check the other way round, so a broken `where` cannot make
// the precondition pass by accident.
check(
  'PRECONDITION SANITY: a tool that does exist is still found',
  resolvable('cmd'),
  'if this fails the absence checks above prove nothing',
)

// ------------------------------------------------------------------ run it
const base = `http://127.0.0.1:${PORT}`

/**
 * Nothing may already be listening on the test port, and this is a hard stop
 * rather than a check.
 *
 * It is not hypothetical: the first run of this script left an instance
 * behind, the second run's launcher died of EADDRINUSE, and every HTTP
 * assertion below then passed against the ORPHAN. A test that answers
 * questions about a process it did not start is worse than no test, because
 * it reports green. The dev service has the same trap: stopping the npx
 * wrapper leaves the node child holding the port, and it answers your probes
 * for a while after you think you killed it.
 */
try {
  await fetch(`${base}/api/auth/state`)
  console.error(`\nABORT: something is already listening on ${PORT}.`)
  console.error('Every check below would be answered by it instead of by the artifact.')
  console.error('Kill it, or pass --port with a free one.')
  process.exit(1)
} catch {
  /* nothing there, which is what we need */
}

console.log('starting "Start Dashboard.bat" with no toolchain on PATH\n')
const child = spawn('cmd.exe', ['/c', 'Start Dashboard.bat'], {
  cwd: appDir,
  env: bare,
  windowsHide: true,
})
let out = ''
child.stdout.on('data', (b: Buffer) => (out += b.toString()))
child.stderr.on('data', (b: Buffer) => (out += b.toString()))

async function get(path: string): Promise<{ status: number; body: string }> {
  const r = await fetch(base + path, { redirect: 'manual' })
  return { status: r.status, body: await r.text() }
}

let up = false
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try {
    const r = await get('/api/auth/state')
    if (r.status === 200) {
      up = true
      break
    }
  } catch {
    /* not listening yet */
  }
}
check('the dashboard starts and answers, with no Node installed', up, out.slice(-800))

if (up) {
  const shell = await get('/')
  check('it serves the app shell', shell.status === 200 && /<script/i.test(shell.body))

  // The shell naming an asset is not the asset existing. A dist/ that half
  // made it into the zip would pass the first check and fail this one.
  const asset = /src="([^"]*assets\/[^"]+\.js)"/.exec(shell.body)?.[1]
  check('the shell references a built asset', !!asset, shell.body.slice(0, 200))
  if (asset) {
    const a = await get(asset.startsWith('/') ? asset : `/${asset}`)
    check('and that asset is actually served', a.status === 200 && a.body.length > 10_000, `${a.status}, ${a.body.length} bytes`)
  }

  const state = await get('/api/auth/state')
  check('the auth endpoint answers', state.status === 200 && state.body.includes('"configured":true'), state.body)

  // The gate, from a stranger's position. This is what separates "a web
  // server came up" from "the dashboard came up".
  const guarded = await get('/api/servers')
  check('a guarded route refuses an unauthenticated request', guarded.status === 401, String(guarded.status))

  check(
    'the first start printed an administrator password once',
    /username\s+admin/.test(out) && /password/.test(out),
    out.slice(-400),
  )

  // Which node is it? A test that passed because the machine happened to have
  // one somewhere would be worthless, so ask the OS what is actually running.
  const listing = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.mjs*' } | Select-Object -ExpandProperty ExecutablePath`,
    ],
    { encoding: 'utf8' },
  ).trim()
  check(
    'the process running is the node.exe inside the unzipped folder',
    listing.toLowerCase().includes(appDir.toLowerCase()),
    listing || '(no node.exe found running server.mjs)',
  )

  check(
    'its data went to the data directory, not next to the app',
    existsSync(join(dataDir, 'users.json')) || readdirSync(dataDir).length > 0,
    readdirSync(dataDir).join(', '),
  )
}

// ---------------------------------------------------------------- shut down
/**
 * Kill the whole tree by pid rather than by matching paths. cmd.exe is the
 * parent and node.exe is its child; killing only the parent leaves the child
 * holding the directory open, which is how this first failed.
 */
try {
  if (child.pid) execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
} catch {
  /* already gone */
}
child.kill()
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 250))
  try {
    await get('/api/auth/state')
  } catch {
    break // no longer listening
  }
}

check('the unzipped folder is unchanged by running it', readdirSync(appDir).sort().join('|') === before, readdirSync(appDir).sort().join('|'))

// The readme is the only documentation someone who never opens a browser
// will see, so it has to carry the two facts they cannot guess.
{
  const readme = readFileSync(join(appDir, 'README.txt'), 'utf8')
  check('the readme names the launcher', readme.includes('Start Dashboard.bat'))
  check('the readme gives the address', readme.includes('127.0.0.1:8422'))
  check('the readme says the first-start password is shown once', /shown once|only time/i.test(readme))
  check('the readme says how to uninstall', /delete the\s+folder/i.test(readme.replace(/\r?\n/g, ' ')))
}

// Teardown must never be able to hide a result. A locked directory is worth
// reporting, not worth losing thirty checks over.
for (const dir of [work, dataDir, serversRoot]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch (e) {
    console.log(`  (could not remove ${dir}: ${e instanceof Error ? e.message : String(e)})`)
  }
}

const failed = checks.filter(([, ok]) => !ok)
console.log('')
for (const [label, ok, detail] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `\n        ${detail}` : ''}`)
}
console.log('')
console.log(failed.length === 0 ? `ACCEPTED. ${checks.length} checks` : `${failed.length} FAILED of ${checks.length}`)
process.exit(failed.length === 0 ? 0 : 1)
