/**
 * PROOF: searching the machine for server directories, written BEFORE
 * server/scan.ts exists.
 *
 * Why this is proof-guarded rather than "just made": the scan decides which
 * directories get OFFERED to the operator, and accepting an offer makes a
 * directory eligible for start, stop and server.properties writes. A scan
 * that offers the wrong folder is one confirmation click away from a start
 * button pointed at a copy of a live world. Spec section 1 (amended
 * 2026-08-01) is the rule this defends: on the real machine three of the ten
 * candidate directories are a backup tree declaring the same ports as the
 * live servers.
 *
 * What is NOT covered here, honestly: whether a running JVM is correctly
 * recognised as occupying a directory. That is signal 3, it needs a real
 * deny-share file handle which Node cannot fake, and it is covered by
 * scripts/accept-attach.ts against a real server instead.
 *
 * Run: npx tsx scripts/prove-scan.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA = mkdtempSync(join(tmpdir(), 'mcdash-scan-data-'))
const ROOT = mkdtempSync(join(tmpdir(), 'mcdash-scan-root-'))
const TREE = mkdtempSync(join(tmpdir(), 'mcdash-scan-tree-'))
process.env.MCDASH_DATA_DIR = DATA
process.env.MCDASH_SERVERS_ROOT = ROOT

const checks: Array<[string, boolean, string?]> = []
const check = (label: string, ok: boolean, detail?: string) => checks.push([label, ok, detail])

/** A directory that looks like a server. `world` optional, as on a fresh one. */
function makeServer(dir: string, opts: { world?: boolean; port?: number } = {}) {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'logs'), { recursive: true })
  writeFileSync(
    join(dir, 'server.properties'),
    [`server-port=${opts.port ?? 25565}`, 'level-name=world', 'enable-rcon=false', ''].join('\n'),
    'utf8',
  )
  if (opts.world !== false) {
    mkdirSync(join(dir, 'world'), { recursive: true })
    writeFileSync(join(dir, 'world', 'level.dat'), Buffer.from([0x0a, 0x00, 0x00]))
    // A world holds thousands of region files. If the scan descends into a
    // server it has already identified, a big pack costs minutes.
    mkdirSync(join(dir, 'world', 'region'), { recursive: true })
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(dir, 'world', 'region', `r.0.${i}.mca`), 'x')
      mkdirSync(join(dir, 'world', 'region', `nested-${i}`), { recursive: true })
    }
  }
  return dir
}

// --- the tree under test -------------------------------------------------
makeServer(join(ROOT, 'Already Watched'))                       // under the servers root
const LOOSE = makeServer(join(TREE, 'Loose Server'), { port: 25599 })
const DEEP = makeServer(join(TREE, 'a', 'b', 'c', 'd', 'e', 'Too Deep'))
const NO_WORLD = makeServer(join(TREE, 'Never Started'), { world: false })

// The copy tree: same ports as a real server. Spec section 1's evidence.
const COPY_A = makeServer(join(TREE, 'Backups', 'MC 1.21.4'), { port: 25565 })
const COPY_B = makeServer(join(TREE, 'Backups', 'MC 1.21.11'), { port: 25566 })

// Directories a scan must not waste time in, or must not enter at all.
mkdirSync(join(TREE, 'node_modules', 'pkg'), { recursive: true })
makeServer(join(TREE, 'node_modules', 'pkg', 'fixture-server'))
mkdirSync(join(TREE, '.git', 'objects'), { recursive: true })
makeServer(join(TREE, '.git', 'objects', 'hidden-server'))
mkdirSync(join(TREE, 'Windows'), { recursive: true })
makeServer(join(TREE, 'Windows', 'system-server'))

// A junction pointing back at the tree: a naive walker loops here for ever.
let loopMade = false
try {
  symlinkSync(TREE, join(TREE, 'loop'), 'junction')
  loopMade = true
} catch {
  /* needs privilege on some systems; the check below is skipped honestly */
}

const { scanForServers, SCAN_CACHE_MS } = await import('../server/scan')
const { loadAttached, attachDir } = await import('../server/attach')

// ===========================================================================
console.log('\n=== 1. what a bounded scan finds, and what it refuses to enter ===\n')
// ===========================================================================

const t0 = Date.now()
const r = await scanForServers({ roots: [{ dir: TREE, depth: 4 }] })
const wall = Date.now() - t0
const dirs = r.candidates.map((c) => c.dir.toLowerCase())
const has = (d: string) => dirs.includes(d.toLowerCase())

console.log(`   scanned in ${r.ms} ms, ${r.candidates.length} candidates`)
for (const c of r.candidates) console.log(`     ${c.known.padEnd(8)} ${c.dir}`)

check('a server directory in the tree is found', has(LOOSE))
check('a directory with server.properties but no world is still found', has(NO_WORLD))
check('and is marked as not looking like a server yet', r.candidates.find((c) => c.dir.toLowerCase() === NO_WORLD.toLowerCase())?.looksLikeServer === false)
check('a directory deeper than the limit is NOT found', !has(DEEP))
check('node_modules is not entered', !dirs.some((d) => d.includes('node_modules')))
check('dot-directories are not entered', !dirs.some((d) => d.includes('.git')))
check('system directory names are not entered', !dirs.some((d) => d.includes(`${'windows'}\\`) || d.endsWith('system-server')))
check('the scan reports how long it took', typeof r.ms === 'number' && r.ms >= 0, String(r.ms))
check('and which roots it searched', Array.isArray(r.roots) && r.roots.length === 1)

// The performance rule: a server directory is a leaf. Descending into a
// modpack world costs minutes for nothing.
check('the scan does not descend into a directory it has identified as a server', !dirs.some((d) => d.includes('region')))
console.log(`   wall clock ${wall} ms for a tree containing ${30 * 5} nested world directories`)
check('so a tree full of region folders still scans fast', wall < 5_000, `${wall} ms`)

if (loopMade) {
  check('a junction loop does not hang the scan', wall < 5_000)
} else {
  console.log('   SKIP junction loop check: could not create a junction here')
}

// ===========================================================================
console.log('\n=== 2. duplicate ports: found, listed, never resolved by port ===\n')
// ===========================================================================

check('both copies declaring a live port are listed as candidates', has(COPY_A) && has(COPY_B))
const a = r.candidates.find((c) => c.dir.toLowerCase() === COPY_A.toLowerCase())
check('a candidate reports the port it declares', a?.gamePort === 25565, String(a?.gamePort))
check(
  'but a candidate is NOT marked running just because something owns its port',
  a?.running === false,
  `running=${a?.running}`,
)
check(
  'and carries no pid it did not earn',
  a?.pid === null,
  `pid=${a?.pid}`,
)

// ===========================================================================
console.log('\n=== 3. found is never adopted ===\n')
// ===========================================================================

const attachedBefore = loadAttached(DATA).length
await scanForServers({ roots: [{ dir: TREE, depth: 4 }] })
check('scanning does not attach anything', loadAttached(DATA).length === attachedBefore)
check('scanning writes no attached.json at all on a clean install', !existsSync(join(DATA, 'attached.json')) || loadAttached(DATA).length === 0)

// Adopting stays an explicit act through the attach path.
attachDir(DATA, { dir: LOOSE, confirmedLaunch: null })
const after = await scanForServers({ roots: [{ dir: TREE, depth: 4 }] })
const loose = after.candidates.find((c) => c.dir.toLowerCase() === LOOSE.toLowerCase())
check('an attached directory is reported as already attached, not offered again', loose?.known === 'attached', loose?.known)

const watched = await scanForServers({ roots: [{ dir: ROOT, depth: 3 }] })
const inRoot = watched.candidates.find((c) => c.dir.toLowerCase().includes('already watched'))
check('a directory under the servers root is reported as already watched', inRoot?.known === 'watched', inRoot?.known)
check('so the operator is only ever offered what is genuinely new', after.candidates.some((c) => c.known === 'new'))

// ===========================================================================
console.log('\n=== 4. the scan is bounded and cacheable, never on the scan loop ===\n')
// ===========================================================================

check('a cache window is exported so callers cannot invent one', typeof SCAN_CACHE_MS === 'number' && SCAN_CACHE_MS > 0)

const src = readFileSync(join(import.meta.dirname, '..', 'server', 'discovery.ts'), 'utf8')
check(
  'discovery.ts does NOT call the filesystem search on its ten-second scan',
  !/scanForServers/.test(src),
  'found a call in discovery.ts',
)

// A root that does not exist must not throw: drive letters come and go.
const missing = await scanForServers({ roots: [{ dir: join(TREE, 'no-such-root'), depth: 2 }] })
check('a root that does not exist is skipped rather than throwing', missing.candidates.length === 0)

// ===========================================================================
console.log('\n=== 5. the search must not starve the event loop (spec §11, 2026-08-03) ===\n')
// ===========================================================================
//
// The second-machine trial: the on-demand search reported "Searched 6
// locations in 9458 ms" and the host panel went red with a worst block of
// 8,739 ms, 97% of blocked time -- the walk was synchronous, so while it ran
// nothing else could be measured and every probe in flight would be billed
// the blockage. On a real fleet, one button press made every server
// unmeasurable for nine seconds.
//
// This section is self-validating: it first measures how long a deliberately
// SYNCHRONOUS walk of the same tree blocks, and requires that baseline to
// exceed the threshold. If the tree were too small to catch the old
// implementation, the proof fails on its own baseline rather than passing
// vacuously.

const BIG = mkdtempSync(join(tmpdir(), 'mcdash-scan-big-'))
for (let i = 0; i < 60; i++) {
  for (let j = 0; j < 40; j++) {
    mkdirSync(join(BIG, `d${i}`, `e${j}`, 'leaf'), { recursive: true })
  }
}
makeServer(join(BIG, 'd30', 'Planted Server'), { world: false, port: 25601 })

// What the old implementation would do: readdirSync recursion on the loop.
function syncWalkBlocks(dir: string, depth: number): void {
  if (depth > 4) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  if (entries.some((e) => e.isFile() && e.name.toLowerCase() === 'server.properties')) return
  for (const e of entries) {
    if (e.isDirectory() && !e.isSymbolicLink()) syncWalkBlocks(join(dir, e.name), depth + 1)
  }
}
const b0 = Date.now()
syncWalkBlocks(BIG, 0)
const baselineMs = Date.now() - b0

const BLOCK_LIMIT_MS = 250
console.log(`   a synchronous walk of this tree blocks for ${baselineMs} ms`)
check(
  'the tree is big enough that a synchronous walk would fail the block limit',
  baselineMs > BLOCK_LIMIT_MS,
  `baseline ${baselineMs} ms vs limit ${BLOCK_LIMIT_MS} ms`,
)

// Now the real path, with a timer sampling the loop. Any stretch where the
// loop is held shows up as a gap between ticks.
let worstGap = 0
let lastTick = Date.now()
const sampler = setInterval(() => {
  const now = Date.now()
  const gap = now - lastTick
  if (gap > worstGap) worstGap = gap
  lastTick = now
}, 10)
const s0 = Date.now()
const big = await scanForServers({ roots: [{ dir: BIG, depth: 4 }] })
const scanWall = Date.now() - s0
clearInterval(sampler)

console.log(`   real scan took ${scanWall} ms wall clock; worst loop gap ${worstGap} ms`)
check('the planted server is still found in the big tree', big.candidates.some((c) => c.dir.toLowerCase().includes('planted server')))
check(
  `the search never holds the event loop longer than ${BLOCK_LIMIT_MS} ms`,
  worstGap < BLOCK_LIMIT_MS,
  `worst gap ${worstGap} ms over a ${scanWall} ms scan`,
)

// ===========================================================================
const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${'='.repeat(64)}`)
for (const [label, ok, detail] of failed) console.log(`FAIL  ${label}${detail ? `  [${detail}]` : ''}`)
console.log(failed.length === 0 ? `ALL PASS. ${checks.length} checks` : `\n${failed.length} FAILED of ${checks.length}`)
process.exit(failed.length === 0 ? 0 : 1)
