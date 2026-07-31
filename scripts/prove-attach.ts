/**
 * PROOF: attaching a server folder, written BEFORE the code.
 *
 * Attaching is not a display feature. A directory the dashboard accepts here
 * becomes eligible for start, stop and server.properties writes, so a wrong
 * attach reaches a real world. The failure that matters most is the one the
 * operator named when approving this: a server the dashboard did NOT start,
 * launched a second time BY the dashboard, is two JVMs on one world, which is
 * the corruption this project's whole proof discipline exists to prevent.
 *
 * The rules under test:
 *
 *   1. Validation refuses anything that is not demonstrably a server folder.
 *   2. A folder is attached, never a jar: the liveness model is directory
 *      keyed, and a jar path says nothing about worlds, logs or ports.
 *   3. NOTHING is written into the server's own directory. The only write is
 *      the dashboard's own config.
 *   4. Start is unavailable unless a launch method was CONFIRMED at attach
 *      time. The dashboard never infers one later from a start.bat it has
 *      never run.
 *   5. An attached directory reaches the identity layer exactly like a
 *      discovered one, so the double-spawn pre-check can see a JVM that is
 *      already serving it.
 *   6. Nothing is ever deleted. Detaching sets an entry aside.
 *
 * Run: npx tsx scripts/prove-attach.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'mcdash-attach-root-'))
const DATA = mkdtempSync(join(tmpdir(), 'mcdash-attach-data-'))
const OUTSIDE = mkdtempSync(join(tmpdir(), 'mcdash-attach-outside-'))
process.env.MCDASH_DATA_DIR = DATA
process.env.MCDASH_SERVERS_ROOT = ROOT

const checks: Array<[string, boolean, string?]> = []
const check = (label: string, ok: boolean, detail?: string) => checks.push([label, ok, detail])

/** A directory that really looks like a server, optionally with a launcher. */
function makeServer(base: string, name: string, opts: { script?: boolean; rcon?: boolean } = {}) {
  const dir = join(base, name)
  mkdirSync(join(dir, 'world'), { recursive: true })
  mkdirSync(join(dir, 'logs'), { recursive: true })
  writeFileSync(join(dir, 'world', 'level.dat'), Buffer.from([0x0a, 0x00, 0x00]))
  writeFileSync(
    join(dir, 'server.properties'),
    [
      'server-port=25599',
      'level-name=world',
      `enable-rcon=${opts.rcon ?? false}`,
      'rcon.port=25609',
      'rcon.password=ATTACH-PROOF-CANARY',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(join(dir, 'logs', 'latest.log'), '[00:00:00] [Server thread/INFO]: Done\n', 'utf8')
  if (opts.script) writeFileSync(join(dir, 'start.bat'), '@echo off\r\nrem never run by this proof\r\n', 'utf8')
  return dir
}

// A normal discovered server, and a hand-started one living outside the root.
makeServer(ROOT, 'Discovered Server')
const HAND_STARTED = makeServer(OUTSIDE, 'Hand Started Server', { script: true, rcon: true })
const NO_LAUNCHER = makeServer(OUTSIDE, 'No Launcher Server')

// Directories that must never be accepted.
const EMPTY_DIR = join(OUTSIDE, 'Just A Folder')
mkdirSync(EMPTY_DIR, { recursive: true })
const JAR_ONLY = join(OUTSIDE, 'Jar Only')
mkdirSync(JAR_ONLY, { recursive: true })
writeFileSync(join(JAR_ONLY, 'server.jar'), 'not really a jar', 'utf8')
const PROPS_NO_WORLD = join(OUTSIDE, 'Props But No World')
mkdirSync(PROPS_NO_WORLD, { recursive: true })
writeFileSync(join(PROPS_NO_WORLD, 'server.properties'), 'server-port=25600\n', 'utf8')

const { validateAttachCandidate, attachDir, detachDir, loadAttached } = await import('../server/attach')
const { loadConfig, dataDir } = await import('../server/config')

// ===========================================================================
console.log('\n=== 1. what may be attached, and what may not ===\n')
// ===========================================================================

const good = await validateAttachCandidate(HAND_STARTED)
console.log(`   ${HAND_STARTED} -> ok=${good.ok}`)
check('a real server folder outside the root validates', good.ok)
check('and its port is read from server.properties', good.ok && good.gamePort === 25599, String(good.ok && good.gamePort))
check('and its level-name is reported', good.ok && good.levelName === 'world')
check('and RCON being enabled is reported', good.ok && good.rconConfigured === true)
check('and its world directories are listed', good.ok && good.worldDirs.includes('world'))

for (const [label, path] of [
  ['a directory that does not exist', join(OUTSIDE, 'nope-not-here')],
  ['an empty directory', EMPTY_DIR],
  ['a directory holding only a jar', JAR_ONLY],
  ['a directory with server.properties but no world', PROPS_NO_WORLD],
] as Array<[string, string]>) {
  const r = await validateAttachCandidate(path)
  console.log(`   ${r.ok ? 'FAIL' : 'PASS'}  refused: ${label}`)
  check(`refuses ${label}`, !r.ok, r.ok ? 'accepted' : r.reason)
  check(`and says why for ${label}`, !r.ok && typeof r.reason === 'string' && r.reason.length > 10)
}

// A jar is not a folder. The whole model is directory keyed.
const jarPath = join(JAR_ONLY, 'server.jar')
const jarResult = await validateAttachCandidate(jarPath)
check('refuses a path to a jar rather than a folder', !jarResult.ok)

// Path shapes that should never reach the filesystem as-is.
for (const bad of ['', '   ', 'relative/path', '\\\\server\\share\\world', join(OUTSIDE, '..', '..')]) {
  const r = await validateAttachCandidate(bad)
  check(`refuses the path shape ${JSON.stringify(bad.slice(0, 28))}`, !r.ok)
}

// ===========================================================================
console.log('\n=== 2. the launch method is confirmed, never inferred later ===\n')
// ===========================================================================

const withScript = await validateAttachCandidate(HAND_STARTED)
check(
  'a start.bat present in the folder is REPORTED at attach time',
  withScript.ok && withScript.launchCandidate?.strategy === 'script',
  JSON.stringify(withScript.ok ? withScript.launchCandidate : null),
)
const noScript = await validateAttachCandidate(NO_LAUNCHER)
check(
  'a folder with no launcher says so rather than inventing one',
  noScript.ok && noScript.launchCandidate === null,
)

// Attaching WITHOUT confirming the launcher: start must stay unavailable.
attachDir(dataDir(), { dir: HAND_STARTED, confirmedLaunch: null })
{
  const rec = loadAttached(dataDir()).find((a) => a.dir === HAND_STARTED)
  check('an attach with no confirmed launch method is recorded as such', rec?.confirmedLaunch === null)
}

// Attaching WITH the operator confirming the script they were shown.
detachDir(dataDir(), HAND_STARTED)
attachDir(dataDir(), {
  dir: HAND_STARTED,
  confirmedLaunch: { strategy: 'script', script: 'start.bat' },
})
{
  const rec = loadAttached(dataDir()).find((a) => a.dir === HAND_STARTED)
  check('a confirmed launch method is recorded verbatim', rec?.confirmedLaunch?.strategy === 'script')
  const cl = rec?.confirmedLaunch
  check('including which script was confirmed', cl?.strategy === 'script' && cl.script === 'start.bat')
}

// The operator may only confirm what they were actually shown.
const forged = attachDir(dataDir(), {
  dir: NO_LAUNCHER,
  confirmedLaunch: { strategy: 'script', script: 'does-not-exist.bat' },
})
check('a launch method naming a script that is not there is refused', forged.ok === false, JSON.stringify(forged))

// ===========================================================================
console.log('\n=== 3. nothing is written into the server directory ===\n')
// ===========================================================================

const before = readdirSync(HAND_STARTED).sort().join(',')
const propsBefore = readFileSync(join(HAND_STARTED, 'server.properties'), 'utf8')
attachDir(dataDir(), { dir: NO_LAUNCHER, confirmedLaunch: null })
detachDir(dataDir(), NO_LAUNCHER)
const after = readdirSync(HAND_STARTED).sort().join(',')
check('attaching adds no file to the server directory', before === after, `${before} -> ${after}`)
check(
  'and does not touch server.properties',
  readFileSync(join(HAND_STARTED, 'server.properties'), 'utf8') === propsBefore,
)
{
  const files = readdirSync(dataDir()).filter((f) => f.endsWith('.json'))
  const anySecret = files.some((f) => readFileSync(join(dataDir(), f), 'utf8').includes('ATTACH-PROOF-CANARY'))
  check('the RCON password is never copied into any dashboard file', !anySecret, files.join(','))
}

// ===========================================================================
console.log('\n=== 4. duplicates, and the delete-nothing rule ===\n')
// ===========================================================================

const dup = attachDir(dataDir(), { dir: HAND_STARTED, confirmedLaunch: null })
check('attaching the same directory twice is refused', dup.ok === false)
const insideRoot = attachDir(dataDir(), { dir: join(ROOT, 'Discovered Server'), confirmedLaunch: null })
check('attaching a directory already covered by the servers root is refused', insideRoot.ok === false)

const countBefore = loadAttached(dataDir()).length
detachDir(dataDir(), HAND_STARTED)
check('detaching removes it from the active list', !loadAttached(dataDir()).some((a) => a.dir === HAND_STARTED))
check('and the server directory still exists on disk', existsSync(HAND_STARTED))
check('and its world is untouched', existsSync(join(HAND_STARTED, 'world', 'level.dat')))
check('detach changed exactly one entry', loadAttached(dataDir()).length === countBefore - 1)

// ===========================================================================
console.log('\n=== 5. the config survives a reload, atomically ===\n')
// ===========================================================================

attachDir(dataDir(), { dir: HAND_STARTED, confirmedLaunch: { strategy: 'script', script: 'start.bat' } })
const reloaded = loadConfig(dataDir())
check('an attached directory is visible to a freshly loaded config', reloaded.attachedDirs.includes(HAND_STARTED))
check('no temp file is left behind', !readdirSync(dataDir()).some((f) => f.endsWith('.tmp')))

// ===========================================================================
console.log('\n=== 6. THE ONE THAT MATTERS: the double-spawn guard covers it ===\n')
// ===========================================================================
// An attached directory must reach the identity layer exactly like a
// discovered one. If it does not, the pre-check cannot see the JVM that is
// already serving that world, and pressing Start launches a second one.

const { scan } = await import('../server/discovery')
const snap = await scan(ROOT, {})

const attachedInSnapshot = snap.servers.find((s) => s.dir === HAND_STARTED)
check('an attached directory appears in the snapshot as a server', !!attachedInSnapshot)
check(
  'and is a first-class server, not a second-class listing',
  !!attachedInSnapshot && attachedInSnapshot.classification === 'live',
  attachedInSnapshot?.classification,
)

// The identity layer must have been ASKED about this directory. This is the
// wiring that makes the pre-check able to see an existing JVM at all.
const { lastDirHints } = await import('../server/platform')
check(
  'the identity scan was given the attached directory as a hint',
  lastDirHints().some((h) => h.dir === HAND_STARTED),
  JSON.stringify(lastDirHints().map((h) => h.dir)),
)

// Start must be refused because no launcher was confirmed for THIS record...
{
  detachDir(dataDir(), HAND_STARTED)
  attachDir(dataDir(), { dir: HAND_STARTED, confirmedLaunch: null })
  const s2 = (await scan(ROOT, {})).servers.find((x) => x.dir === HAND_STARTED)
  check(
    'with no confirmed launch method, the server reports launchStrategy none',
    s2?.launchStrategy === 'none',
    s2?.launchStrategy,
  )
  check(
    'and says why, rather than offering a button that cannot work',
    typeof s2?.launchDetail === 'string' && /attach|confirm/i.test(s2.launchDetail),
    s2?.launchDetail,
  )
  check(
    'a start.bat sitting in the folder does NOT silently become the launcher',
    s2?.launchStrategy !== 'script',
  )
}

// ...and the control layer must refuse a start for a directory a JVM owns,
// by the same path it uses for discovered servers.
{
  const { startServer } = await import('../server/control')
  detachDir(dataDir(), HAND_STARTED)
  attachDir(dataDir(), {
    dir: HAND_STARTED,
    confirmedLaunch: { strategy: 'script', script: 'start.bat' },
  })
  const s3 = (await scan(ROOT, {})).servers.find((x) => x.dir === HAND_STARTED)!
  // Nothing is actually running in the throwaway dir, so this asserts the
  // shape of the guard rather than a live refusal: the call must consult
  // process identity for THIS directory before delegating. prove-live-start
  // covers the live refusal against a real JVM.
  const src = readFileSync(join(import.meta.dirname, '..', 'server', 'control.ts'), 'utf8')
  check(
    'the start path pre-checks occupancy before delegating',
    /occupancyOf\(/.test(src) && /const before = await occupancyOf/.test(src),
  )
  check(
    'and occupancy is keyed on the DIRECTORY, which is what makes an attached server covered',
    /nkey\(j\.dir\) === nkey\(dir\)/.test(src),
  )
  check(
    'and control.ts contains no directory allowlist that could exclude attached servers',
    !/serversRoot/.test(src),
  )
  check('an attached server carries a real directory into control', s3.dir === HAND_STARTED)
}

// ===========================================================================
const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${'='.repeat(64)}`)
for (const [label, ok, detail] of failed) console.log(`FAIL  ${label}${detail ? `  [${detail}]` : ''}`)
console.log(failed.length === 0 ? `ALL PASS. ${checks.length} checks` : `\n${failed.length} FAILED of ${checks.length}`)
process.exit(failed.length === 0 ? 0 : 1)
