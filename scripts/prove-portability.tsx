/**
 * PROOF: discovery is driven by what it reads, not by this machine.
 *
 * A hardcoded map of one person's servers has slipped through this codebase
 * before, and it is the kind of bug that passes every test written against the
 * real directory, because the real directory is the thing being hardcoded. So
 * this builds a throwaway servers root that shares NOTHING with this machine
 * and asserts the app derives every field from it:
 *
 *   - directory names that look nothing like the real ones
 *   - `level-name` that is not `world`, so the world folder cannot be guessed
 *   - ports that are not 25565-25568
 *   - no Dynmap anywhere
 *   - a port collision between two invented names, to show the conflict rule
 *     is structural rather than a special case for "MC 1.21.4 - Copy"
 *   - a directory with no level.dat, which must be classified out, not crash
 *
 * It then asserts the negative that matters: **no string from the real machine
 * appears anywhere in the result**. A test that only checks the fake data is
 * present would still pass if the app also emitted the real servers.
 *
 * Finally it renders the UI from the fake snapshot, because "it parses" and "it
 * displays" are different claims and only one of them was asked for.
 *
 * Nothing here touches the real servers root. The fixture is created under the
 * OS temp directory and deleted at the end.
 *
 * WORLD: n/a, deliberately. Nothing is running in the fake directory, so this
 * proof says nothing whatsoever about process identity -- it cannot, and it is
 * not trying to. Identity coverage is prove-identity and crossvalidate §6. See
 * docs/proof-coverage.md.
 *
 * Run:  npx tsx scripts/prove-portability.tsx
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../server/discovery'
import { ServerCard } from '../web/ServerCard'
import Host from '../web/Host'

const checks: Array<[string, boolean, string?]> = []
const check = (label: string, ok: boolean, detail?: string) => checks.push([label, ok, detail])

// --------------------------------------------------------------- the fixture

const root = mkdtempSync(join(tmpdir(), 'mcdash-portability-'))

/** Deliberately nothing like the real names, ports, or level names. */
const FAKE_RCON_PASSWORD = 'portability-canary-9d2f4a'
const SERVER_A = 'Ancient Vaults [modded]'
const SERVER_B = 'ancient-vaults-backup'
const SERVER_C = 'Skyward Relay'
const NOT_A_SERVER = 'texturepacks'
const LEVEL_A = 'Aether_Hub'
const LEVEL_C = 'relay world 2024'
const PORT_SHARED = 31337
const PORT_C = 47615

function makeServer(
  name: string,
  opts: { levelName: string; port: number; rcon: boolean; kind: 'mods' | 'plugins' },
): void {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const props = [
    `level-name=${opts.levelName}`,
    `server-port=${opts.port}`,
    `enable-rcon=${opts.rcon}`,
    ...(opts.rcon ? [`rcon.port=${opts.port + 10}`, `rcon.password=${FAKE_RCON_PASSWORD}`] : []),
    'motd=A throwaway server',
    'level-type=minecraft\\:normal',
  ].join('\n')
  writeFileSync(join(dir, 'server.properties'), props, 'utf8')
  // The world folder is named by level-name. If anything hardcodes "world",
  // this file is invisible and the directory is classified as not-a-server.
  mkdirSync(join(dir, opts.levelName), { recursive: true })
  writeFileSync(join(dir, opts.levelName, 'level.dat'), 'not really nbt', 'utf8')
  mkdirSync(join(dir, opts.kind), { recursive: true })
}

makeServer(SERVER_A, { levelName: LEVEL_A, port: PORT_SHARED, rcon: true, kind: 'mods' })
makeServer(SERVER_B, { levelName: LEVEL_A, port: PORT_SHARED, rcon: false, kind: 'mods' })
makeServer(SERVER_C, { levelName: LEVEL_C, port: PORT_C, rcon: false, kind: 'plugins' })
mkdirSync(join(root, NOT_A_SERVER, 'assets'), { recursive: true })
writeFileSync(join(root, NOT_A_SERVER, 'pack.mcmeta'), '{}', 'utf8')

console.log(`throwaway servers root: ${root}`)
console.log(`contents: ${readdirSync(root).join(', ')}\n`)

// ------------------------------------------------------------------ the scan

const snap = await scan(root, {})
const byName = new Map(snap.servers.map((s) => [s.name, s]))
const a = byName.get(SERVER_A)
const b = byName.get(SERVER_B)
const c = byName.get(SERVER_C)

console.log('server                          class       port   level-name          worlds  dynmap  rcon')
for (const s of snap.servers) {
  console.log(
    `${s.name.padEnd(30)}  ${s.classification.padEnd(10)} ${String(s.gamePort).padStart(6)}   ${(s.levelName ?? '–').padEnd(18)}  ${String(s.worldDirs.length).padStart(6)}  ${String(s.dynmap === null ? 'none' : s.dynmap.port).padStart(6)}  ${s.rconConfigured}`,
  )
}
for (const i of snap.ignored) console.log(`(ignored) ${i.name}. ${i.reason}`)
console.log('')

check('all three invented servers are discovered', snap.servers.length === 3, `got ${snap.servers.length}`)
check('the directory with no level.dat is classified out, not crashed on', snap.ignored.length === 1 && snap.ignored[0]!.name === NOT_A_SERVER)

check('a non-default port is read from server.properties', a?.gamePort === PORT_SHARED, `got ${a?.gamePort}`)
check('a second, different non-default port is read', c?.gamePort === PORT_C, `got ${c?.gamePort}`)
check('level-name is honoured, not assumed to be "world"', a?.levelName === LEVEL_A, `got ${a?.levelName}`)
check('a level-name containing spaces and digits works', c?.levelName === LEVEL_C, `got ${c?.levelName}`)
check('the world folder is found via level-name', a?.worldDirs.join(',') === LEVEL_A, `got ${a?.worldDirs.join(',')}`)
check('...and for the space-containing one too', c?.worldDirs.join(',') === LEVEL_C, `got ${c?.worldDirs.join(',')}`)
check('no Dynmap is reported when none is configured', a?.dynmap === null && c?.dynmap === null)
check('RCON presence is read per server, not assumed', a?.rconConfigured === true && b?.rconConfigured === false)

// The port-conflict rule is structural. It has to fire for two names it has
// never seen, or it is a special case for one directory on one machine.
check(
  'a port collision between two invented names is reported both ways',
  a?.portConflictWith.includes(SERVER_B) === true && b?.portConflictWith.includes(SERVER_A) === true,
  `${JSON.stringify(a?.portConflictWith)} / ${JSON.stringify(b?.portConflictWith)}`,
)
check('a server with a unique port reports no conflict', c?.portConflictWith.length === 0)

// Nothing owns these directories, so every one of them must read DOWN. If a
// port probe were being used as identity, SERVER_A and SERVER_B would inherit
// whatever is listening on their declared port. Spec §1.
check('no process owns these directories, so all report DOWN', snap.servers.every((s) => s.health === 'DOWN' && s.proc === null))
check('the servers root is echoed back as given', snap.serversRoot === root)

// ------------------------------------------- the negative: no leakage at all

const REAL_MACHINE = [
  'MC 1.21.4',
  'MC 1.21.11',
  'MC GTNH',
  'MC Skyblock',
  'MC Tech',
  'Documents',
  'MC Servers',
  '25565',
  '25566',
  '25567',
  '25568',
  '8123',
  '8124',
  // The machine's own name, derived at runtime so the guard works on any
  // machine rather than only the one this file was written on.
  hostname(),
]
const payload = JSON.stringify({ servers: snap.servers, ignored: snap.ignored })
const leaked = REAL_MACHINE.filter((s) => payload.includes(s))
check(
  'no name, path or port from the real machine appears in the result',
  leaked.length === 0,
  leaked.join(', '),
)
check(
  'the RCON password is not in the snapshot, only the fact that RCON exists',
  !JSON.stringify(snap).includes(FAKE_RCON_PASSWORD),
)

// ------------------------------------------------------------- and it renders

const html = renderToStaticMarkup(
  <div className="p-6">
    <p className="mb-4 text-xs text-[var(--color-muted)]">
      Rendered by <code className="font-mono">scripts/prove-portability.tsx</code> from a throwaway
      servers root at <code className="font-mono">{root}</code>. Every value below was derived from
      files created by that script.
    </p>
    <Host host={snap.host} identity={snap.identity} />
    <div className="grid gap-3 lg:grid-cols-2">
      {snap.servers.map((s) => (
        <ServerCard key={s.id} s={s} />
      ))}
    </div>
  </div>,
)

let css = ''
try {
  const assets = join(import.meta.dirname, '..', 'dist', 'assets')
  const f = readdirSync(assets).find((x) => x.endsWith('.css'))
  if (f) css = readFileSync(join(assets, f), 'utf8')
} catch {
  /* no build yet; the markup assertions below still hold */
}

const OUT = process.argv[2] ?? join(import.meta.dirname, '..', 'portability-render.html')
writeFileSync(
  OUT,
  `<!doctype html><html><head><meta charset="utf-8"><title>Portability</title><style>${css}</style></head><body>${html}</body></html>`,
  'utf8',
)

// Rendering "correctly" means the invented values reach the screen and the real
// ones do not -- checked against the markup, not against the data again.
const text = html.replace(/<[^>]+>/g, ' ')
check('the UI renders every invented server name', [SERVER_A, SERVER_B, SERVER_C].every((n) => text.includes(n)))
check('the UI renders the non-default ports', text.includes(String(PORT_SHARED)) && text.includes(String(PORT_C)))
check('the UI renders the custom level names', text.includes(LEVEL_A) && text.includes(LEVEL_C))
check('the UI explains the port collision in words', /also declared by/i.test(text))
check('nothing from the real machine reaches the markup', !REAL_MACHINE.some((s) => text.includes(s)))
check('the RCON password does not reach the markup', !html.includes(FAKE_RCON_PASSWORD))

console.log(`rendered: ${OUT}\n`)

// ----------------------------------------------------------------- teardown

rmSync(root, { recursive: true, force: true })

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`)
}
console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
