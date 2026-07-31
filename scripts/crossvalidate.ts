/**
 * Cross-validation: the TypeScript dashboard vs the Python backup script.
 *
 * They cannot share code, so they can drift -- and a dashboard that disagrees
 * with the backup script about whether a server is running is worse than no
 * dashboard. This runs the TS implementation over the same fixtures the Python
 * one was run over and asserts they agree on every shared behaviour.
 *
 * Run: npx tsx scripts/crossvalidate.ts
 */
import { readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePlayerCount, pingIsReady, normaliseSlpPayload, parseTps, tpsCommandFor } from '../server/parse'
import { worldDirs, levelDatPath, detectKind, gamePortOf } from '../server/properties'
import { enumerateJvms, jvmForDir } from '../server/platform'
import { listDirectories } from '../server/properties'
import { loadConfig, dataDir } from '../server/config'
import { describeWorld, printWorld } from './world'

const HERE = dirname(fileURLToPath(import.meta.url))
const FX = join(HERE, '..', 'fixtures')
const read = (f: string) => JSON.parse(readFileSync(join(FX, f), 'utf8'))

/**
 * The fixture stores server NAMES, never absolute paths.
 *
 * It used to store `dir`, which meant every regeneration wrote the developer's
 * Windows username into a tracked file. The servers root is machine state and
 * belongs in config; the fixture's job is to say what should be true of a
 * directory called "MC GTNH", not where that directory lives.
 */
const ROOT = loadConfig(dataDir()).serversRoot
const servers: Array<Record<string, any>> = (read('servers.json') as Array<Record<string, any>>).map(
  (e) => ({ ...e, dir: join(ROOT, e.name as string) }),
)
const samples = read('samples.json') as Record<string, any>
const expected = read('expected-python.json') as Record<string, any>

let pass = 0
const failures: string[] = []

function check(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL  ${label}\n          ts     = ${g}\n          python = ${w}`)
  }
}

console.log('\n=== 1. player count parsing (spec §5, §7) ===')
for (const [name, exp] of Object.entries(expected.playerCount as Record<string, any>)) {
  const got = parsePlayerCount(exp.raw).online
  check(`${name}  ${JSON.stringify(exp.raw).slice(0, 54)}`, got, exp.online)
}

console.log('\n=== 2. SLP readiness / still-starting placeholder (spec §4) ===')
for (const [name, want] of Object.entries(expected.slpReady as Record<string, boolean>)) {
  const parsed = samples.slp[name]?.parsed
  check(name, pingIsReady(parsed), want)
}

console.log('\n=== 3. SLP payload normalisation (spec §3) ===')
for (const [k, input] of Object.entries(expected.normaliseInput as Record<string, string>)) {
  check(k, normaliseSlpPayload(input), expected.normalise[k])
}

console.log('\n=== 4. world folder resolution from level-name (spec §6) ===')
for (const e of servers) {
  const want = expected.worlds[e.name]
  const lvl = levelDatPath(e.dir)
  const got = {
    worldDirs: worldDirs(e.dir),
    levelDat: lvl ? relative(e.dir, lvl).replace(/\\/g, '/') : null,
  }
  check(e.name, got, want)
}

console.log('\n=== 5. directory classification (spec §9) ===')
const root = servers[0]?.dir.replace(/\\[^\\]+$/, '') ?? ''
const dirs = listDirectories(root)
const tsServers = dirs.filter((n) => levelDatPath(join(root, n)) !== null).sort()
const tsNot = dirs.filter((n) => levelDatPath(join(root, n)) === null).sort()
check('servers', tsServers, expected.discovery.servers)
check('not servers', tsNot, expected.discovery.notServers)

console.log('\n=== 6. process identity, port is not identity (spec §1) ===')
// Hints are passed for the same reason discovery passes them: a server started
// by a boot task has no readable command line, and without the second signal
// every one of these would report as not running. Ports come from the live
// server.properties, never from the fixture -- the fixture deliberately does not
// record them.
const jvms = await enumerateJvms(
  servers.map((e) => ({ dir: e.dir as string, gamePort: gamePortOf(e.dir as string) })),
)
// Which world this is validating, stated out loud. A green 37/37 used to mean
// "identity works" when it only meant "identity works for servers someone
// started by hand", which is not how these servers run. See docs/proof-coverage.md.
const world = describeWorld(jvms)
printWorld(world)
check('the servers under test are started the way production starts them', world.isProduction, true)
for (const [name, want] of Object.entries(expected.identity as Record<string, boolean>)) {
  const e = servers.find((s) => s.name === name)
  // A fixture naming a directory that no longer exists must fail the check, not
  // crash the run -- the point of this script is to report every divergence.
  check(name, e ? jvmForDir(jvms, e.dir) !== null : false, want)
}

console.log('\n=== 7. TPS command selection + parsing (dashboard-only, vs captured raw) ===')
for (const e of servers) {
  if (!e.isServer) continue
  const rc = samples.rcon[e.name]
  if (!rc?.connected) continue
  const cmd = tpsCommandFor(e.kind)
  check(`${e.name} command`, cmd, e.expectedTpsCommand ?? null)
  if (!cmd) continue
  const raw = rc.commands[cmd]?.raw ?? ''
  const parsed = parseTps(e.kind, raw)
  const ok = parsed !== null && parsed.overall !== null && parsed.overall > 0 && parsed.overall <= 20.1
  check(`${e.name} parsed a sane TPS from \`${cmd}\``, ok, true)
}

console.log('\n=== 8. misleading replies must parse to null, not a number ===')
const gt = samples.rcon['MC GTNH']?.commands
if (gt) {
  check('GTNH bare `tps` (is a player command on 1.7.10)', parseTps('forge-1710', gt['tps'].raw), null)
}
const paper = samples.rcon['MC 1.21.4']?.commands
if (paper) {
  check('Paper `forge tps` (unknown command)', parseTps('paper', paper['forge tps'].raw), null)
}

console.log(
  `\n${failures.length === 0 ? 'ALL PASS' : 'FAILURES'}. ${pass} passed, ${failures.length} failed`,
)
if (failures.length) {
  for (const f of failures) console.log('   -', f)
  process.exit(1)
}
