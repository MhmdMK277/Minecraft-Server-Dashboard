/**
 * PROOF: game rules are a measured reading, never a guess, and the set path
 * cannot become a raw RCON pipe.
 *
 * The harm categories this guards:
 *
 *   1. **Misreporting.** A parse that shows keepInventory=true when the
 *      server said false is a false reading about a live world. Every parse
 *      shape asserted here is a VERBATIM reply measured on this machine's
 *      fleet on 2026-08-03 (Paper 1.21.4, Paper 1.21.11, GTNH 1.7.10, Forge
 *      1.20.1, vanilla 1.21.x) -- including vanilla RCON gluing a stale
 *      `list` fragment onto an answer, and Paper 1.21.11 rejecting the query
 *      form outright.
 *
 *   2. **Reach.** The command sent is constructible only from the catalog
 *      constant plus a validated boolean/bounded integer. The wire enum and
 *      the server catalog are asserted identical, so they cannot drift.
 *
 *   3. **Honesty about absence.** Not running, identity in doubt, no RCON,
 *      RCON dying mid-read, queries unsupported: each is its own state with
 *      its own sentence, and none of them renders rules it did not read.
 *
 * Run:  npx tsx scripts/prove-gamerules.ts
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GAME_RULE_NAMES } from '../shared/api'
import {
  CATALOG,
  catalogNames,
  parseQueryReply,
  readGameRules,
  setGameRule,
} from '../server/gamerules'
import type { Occupancy } from '../server/control'

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])

// ---------------------------------------------------- 1. catalog and wire

console.log('--- 1. the catalog and the wire cannot drift')

check(
  'the wire enum and the server catalog hold exactly the same names',
  JSON.stringify([...catalogNames()].sort()) === JSON.stringify([...GAME_RULE_NAMES].sort()),
  `catalog ${catalogNames().length}, wire ${GAME_RULE_NAMES.length}`,
)
check(
  'every rule carries a description for the UI',
  CATALOG.every((r) => r.description.length > 20),
)
check(
  'every integer rule carries bounds',
  CATALOG.filter((r) => r.type === 'integer').every((r) => r.min !== undefined && r.max !== undefined),
)

// ------------------------------------------- 2. measured reply shapes parse

console.log('--- 2. the measured reply shapes')

// Verbatim from the 2026-08-03 measurement. Do not tidy these strings.
const MODERN_BOOL = 'Gamerule keepInventory is currently set to: false'
const MODERN_INT = 'Gamerule randomTickSpeed is currently set to: 20'
const MODERN_TRAILING_LF = 'Gamerule keepInventory is currently set to: false\n'
const LEGACY_BOOL = 'keepInventory = false'
const LEGACY_INT = 'randomTickSpeed = 3'
const LEGACY_ABSENT = "No game rule called 'playersSleepingPercentage' is available"
const MODERN_REJECTED = 'Incorrect argument for command\ngamerule keepInventory<--[HERE]'
const GLUED =
  'There are 0 of a max of 20 players online: Gamerule randomTickSpeed is currently set to: 3'

const p1 = parseQueryReply('keepInventory', MODERN_BOOL)
check('modern boolean parses', p1.kind === 'value' && p1.value === 'false', JSON.stringify(p1))
const p2 = parseQueryReply('randomTickSpeed', MODERN_INT)
check('modern integer parses', p2.kind === 'value' && p2.value === '20', JSON.stringify(p2))
const p3 = parseQueryReply('keepInventory', MODERN_TRAILING_LF)
check('a trailing newline (Forge 1.20.1) does not break the parse', p3.kind === 'value')
const p4 = parseQueryReply('keepInventory', LEGACY_BOOL)
check('the 1.7.10 shape parses', p4.kind === 'value' && p4.value === 'false', JSON.stringify(p4))
const p5 = parseQueryReply('randomTickSpeed', LEGACY_INT)
check('the 1.7.10 integer shape parses', p5.kind === 'value' && p5.value === '3')
check(
  "the 1.7.10 absent shape reads as absent, not as a value",
  parseQueryReply('playersSleepingPercentage', LEGACY_ABSENT).kind === 'absent',
)
check(
  'the modern rejection shape reads as query-rejected',
  parseQueryReply('keepInventory', MODERN_REJECTED).kind === 'query-rejected',
)
check(
  'a glued stale fragment (measured on vanilla RCON) does not corrupt the value',
  (() => {
    const p = parseQueryReply('randomTickSpeed', GLUED)
    return p.kind === 'value' && p.value === '3'
  })(),
)
check(
  "a reply about a DIFFERENT rule never parses as this rule's value",
  parseQueryReply('keepInventory', 'Gamerule doFireTick is currently set to: true').kind === 'unparsed',
  'anchoring on the asked-for name is what makes the glued case safe',
)
check('junk is unparsed, never coerced', parseQueryReply('keepInventory', 'lorem ipsum').kind === 'unparsed')

// ------------------------------------------------- 3. the honest refusals

console.log('--- 3. every way of not knowing says so')

/** A directory with RCON configured, so only the injected deps vary. */
function rconDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcdash-gamerules-'))
  mkdirSync(join(dir, 'world'), { recursive: true })
  writeFileSync(join(dir, 'world', 'level.dat'), '')
  writeFileSync(
    join(dir, 'server.properties'),
    'server-port=25997\nenable-rcon=true\nrcon.port=25996\nrcon.password=proof-only-not-real\n',
  )
  return dir
}
function noRconDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcdash-gamerules-'))
  writeFileSync(join(dir, 'server.properties'), 'server-port=25997\nenable-rcon=false\n')
  return dir
}

const running = async (): Promise<Occupancy> => ({ pids: [4242], certain: true, doubt: null })
const stopped = async (): Promise<Occupancy> => ({ pids: [], certain: true, doubt: null })
const unsure = async (): Promise<Occupancy> => ({
  pids: [],
  certain: false,
  doubt: 'its log file is held open but no process could be matched',
})

/** A fake RCON that answers from a table and records what was asked. */
function fakeConn(replies: (cmd: string) => string) {
  const sent: string[] = []
  return {
    sent,
    connect: async () => ({
      run: async (cmd: string) => {
        sent.push(cmd)
        return { raw: replies(cmd), latencyMs: 1 }
      },
      close: () => undefined,
    }),
  }
}

{
  const conn = fakeConn(() => '')
  const r = await readGameRules(rconDir(), { occupancy: unsure, connect: conn.connect })
  check('identity doubt refuses with the doubt named', r.state === 'uncertain' && /log file is held open/.test(r.detail))
  check('and nothing was asked over RCON', conn.sent.length === 0)
  check('and no rules are rendered', r.rules.length === 0)
}

{
  const r = await readGameRules(rconDir(), { occupancy: stopped })
  check('a stopped server is its own honest state', r.state === 'not-running')
  check('and the sentence says where rules live and why they are not read', /level\.dat/.test(r.detail))
}

{
  const r = await readGameRules(noRconDir(), { occupancy: running })
  check('no RCON is its own honest state', r.state === 'no-rcon')
}

{
  const r = await readGameRules(rconDir(), {
    occupancy: running,
    connect: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  check('a dead RCON is rcon-failed, not an empty rule list', r.state === 'rcon-failed' && r.rules.length === 0)
}

{
  // Paper 1.21.11, measured: every query rejected. The probe rule turns that
  // into one honest state instead of sixteen absences.
  const conn = fakeConn((cmd) => `Incorrect argument for command\n${cmd}<--[HERE]`)
  const r = await readGameRules(rconDir(), { occupancy: running, connect: conn.connect })
  check('a server that rejects the query form is queries-unsupported', r.state === 'queries-unsupported')
  check('and the sentence names the measured server class', /1\.21\.11/.test(r.detail))
  check('and no rules are rendered as absent-by-default', r.rules.length === 0)
}

{
  // A modern server: booleans and integers answer; one rule is absent.
  const conn = fakeConn((cmd) => {
    const name = cmd.split(' ')[1]!
    if (name === 'playersSleepingPercentage') return `Incorrect argument for command\n${cmd}<--[HERE]`
    if (name === 'randomTickSpeed' || name === 'spawnRadius') return `Gamerule ${name} is currently set to: 10`
    return `Gamerule ${name} is currently set to: false`
  })
  const r = await readGameRules(rconDir(), { occupancy: running, connect: conn.connect })
  check('a normal read reports state read', r.state === 'read')
  check('every catalogued rule was asked for', conn.sent.length === CATALOG.length, `${conn.sent.length}`)
  check(
    'every command sent is exactly "gamerule <catalog name>"',
    conn.sent.every((c) => /^gamerule [A-Za-z]+$/.test(c) && catalogNames().includes(c.split(' ')[1]!)),
  )
  const keep = r.rules.find((x) => x.name === 'keepInventory')
  const tick = r.rules.find((x) => x.name === 'randomTickSpeed')
  const sleep = r.rules.find((x) => x.name === 'playersSleepingPercentage')
  check('a boolean value is typed as a boolean', keep?.status === 'value' && keep.boolValue === false)
  check('an integer value is typed as an integer', tick?.status === 'value' && tick.intValue === 10)
  check('a per-rule rejection on a working server reads as absent', sleep?.status === 'absent')
  check('the count sentence matches what answered', new RegExp(`^${r.rules.filter((x) => x.status === 'value').length} of ${CATALOG.length}`).test(r.detail))
}

{
  // RCON dying mid-read must not render a partial list as a complete one.
  let n = 0
  const conn = fakeConn(() => '')
  const dying = async () => {
    const c = await conn.connect()
    return {
      run: async (cmd: string) => {
        if (++n > 3) throw new Error('socket closed')
        return { raw: `Gamerule ${cmd.split(' ')[1]} is currently set to: true`, latencyMs: 1 }
      },
      close: () => undefined,
    }
  }
  const r = await readGameRules(rconDir(), { occupancy: running, connect: dying })
  check('a mid-read failure is rcon-failed with zero rules', r.state === 'rcon-failed' && r.rules.length === 0)
  check('and the sentence says a partial list is why', /partial list/.test(r.detail))
}

// --------------------------------------------------------- 4. the set path

console.log('--- 4. the set path is catalog-shaped or refused')

{
  const r = await setGameRule(rconDir(), 'notARule', true, { occupancy: running })
  check('an uncatalogued name is refused', !r.ok && /not in the game rule catalog/.test(r.detail))
}
{
  const r = await setGameRule(rconDir(), 'keepInventory', 7 as never, { occupancy: running })
  check('a boolean rule refuses a number', !r.ok && /takes true or false/.test(r.detail))
}
{
  const r = await setGameRule(rconDir(), 'randomTickSpeed', true as never, { occupancy: running })
  check('an integer rule refuses a boolean', !r.ok && /whole number/.test(r.detail))
}
{
  const r = await setGameRule(rconDir(), 'randomTickSpeed', 100000, { occupancy: running })
  check('an out-of-bounds integer is refused with the bounds named', !r.ok && /between 0 and 1000/.test(r.detail))
}
{
  const conn = fakeConn(() => '')
  const r = await setGameRule(rconDir(), 'keepInventory', true, { occupancy: unsure, connect: conn.connect })
  check('doubt refuses a set before anything is sent', !r.ok && conn.sent.length === 0)
}
{
  // Happy path: the set is sent, then the READ-BACK decides the sentence.
  let after = 'false'
  const conn = fakeConn((cmd) => {
    if (/^gamerule keepInventory (true|false)$/.test(cmd)) {
      after = cmd.split(' ')[2]!
      return 'Gamerule keepInventory is now set to: ' + after
    }
    return `Gamerule keepInventory is currently set to: ${after}`
  })
  const r = await setGameRule(rconDir(), 'keepInventory', true, { occupancy: running, connect: conn.connect })
  check('a set sends exactly the catalog command', conn.sent[0] === 'gamerule keepInventory true', conn.sent[0])
  check('and re-queries the same rule afterwards', conn.sent[1] === 'gamerule keepInventory')
  check('the claim comes from the read-back', r.ok && r.readBack === 'true' && /read back from the server/.test(r.detail))
}
{
  // The server takes the set but reads back something else: say so, claim nothing.
  const conn = fakeConn((cmd) =>
    /true$/.test(cmd) ? 'ok' : 'Gamerule keepInventory is currently set to: false',
  )
  const r = await setGameRule(rconDir(), 'keepInventory', true, { occupancy: running, connect: conn.connect })
  check('a read-back mismatch is reported as NOT ok', !r.ok && /reads back keepInventory = false/.test(r.detail))
}
{
  // Paper 1.21.11: set accepted, query rejected. Honest sentence, no claim.
  const conn = fakeConn((cmd) =>
    cmd.split(' ').length === 3 ? 'ok' : `Incorrect argument for command\n${cmd}<--[HERE]`,
  )
  const r = await setGameRule(rconDir(), 'keepInventory', true, { occupancy: running, connect: conn.connect })
  check(
    'a server that cannot be read back gets the could-not-verify sentence',
    r.ok && r.readBack === null && /could not be read back/.test(r.detail),
  )
}

console.log('')
let failed = 0
for (const [l, ok, d] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d ? `  (${d})` : ''}`)
}
console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
