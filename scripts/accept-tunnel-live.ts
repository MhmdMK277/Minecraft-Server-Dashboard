/**
 * ACCEPTANCE (live half): the whole public-access path against the real
 * world, on a THROWAWAY server, never a live one.
 *
 *   1. A real Vanilla server is created through the real creation flow
 *      (which exercises creation end to end again) and started once.
 *   2. The real agent is downloaded and verified (digest + Authenticode).
 *   3. A claim is started; the URL is written to the handoff file named by
 *      CLAIM_URL_FILE and the script WAITS for the operator to approve it
 *      in their own browser. Approval mints the secret straight from
 *      playit; rejection or a 15 minute silence ends the run honestly.
 *   4. With the operator-approved credential, the verified binary runs
 *      (this execution was approved by the operator in advance), and the
 *      script waits for the agent's own "connected" report.
 *   5. The throwaway server is exposed through enableTunnel, the address
 *      appears only once the agent reports connected, and a REAL SLP
 *      status handshake is performed through the tunnel address: the
 *      proof that a player could join.
 *   6. The tunnel is deleted at the provider, the agent stopped, the
 *      server stopped over RCON. The temp world is left in place.
 *
 * WORLD: throwaway MCDASH_DATA_DIR and MCDASH_SERVERS_ROOT; real network
 * to Mojang, GitHub and playit; one real JVM and one real agent process,
 * both stopped at the end. The claim secret lands in the THROWAWAY data
 * dir and is never printed.
 *
 * RETRY: pass MCDASH_TUNNEL_WORLD=<previous world path> to reuse the
 * throwaway server, the stored credential and the agent entry from an
 * earlier run, so a retry after an external fix (say, a VPN moved out of
 * the path or an account verified) does not mint duplicates anywhere.
 *
 * Run:  CLAIM_URL_FILE=<path> npx tsx scripts/accept-tunnel-live.ts
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REUSE = process.env.MCDASH_TUNNEL_WORLD?.trim()
if (REUSE && !existsSync(REUSE)) {
  console.error(`MCDASH_TUNNEL_WORLD points at ${REUSE}, which does not exist`)
  process.exit(1)
}
const DATA = REUSE || mkdtempSync(join(tmpdir(), 'mcdash-tunnel-live-'))
const ROOT = join(DATA, 'servers-root')
mkdirSync(ROOT, { recursive: true })
process.env.MCDASH_DATA_DIR = DATA
process.env.MCDASH_SERVERS_ROOT = ROOT
console.log(`world     : ${DATA}${REUSE ? ' (reused)' : ''}`)

const URL_FILE = process.env.CLAIM_URL_FILE
if (!URL_FILE) {
  console.error('CLAIM_URL_FILE must name where to write the claim URL')
  process.exit(1)
}

const { initAudit } = await import('../server/audit')
initAudit(DATA)
const { startCreation, jobFor, collectTakenPorts, suggestPort } = await import('../server/creation')
const { detectLauncher, indexTasks } = await import('../server/launcher')
const { startServer, stopServer, resetLocks } = await import('../server/control')
const { slpPing } = await import('../server/slp')
const {
  installAgent,
  startClaim,
  pollClaim,
  runAgent,
  stopAgent,
  enableTunnel,
  disableTunnel,
  tunnelStatus,
} = await import('../server/tunnel')

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const IDENT = { actor: 'acceptance', role: 'admin', ip: '127.0.0.1' }
const NAME = 'Tunnel Test'

function finish(): never {
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
  console.log(`world: ${DATA} (left in place)`)
  process.exit(fail === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. a throwaway server, through the real creation flow ===\n')
// ---------------------------------------------------------------------------

const EXISTING = join(ROOT, NAME)
let DIR: string
let gamePort: number

if (existsSync(join(EXISTING, 'server.properties'))) {
  DIR = EXISTING
  const props = readFileSync(join(EXISTING, 'server.properties'), 'utf8')
  gamePort = Number(/server-port=(\d+)/.exec(props)?.[1] ?? 25565)
  check('the throwaway server was created (reused from the previous run)', true)
  console.log(`server    : ${DIR} (reused, game ${gamePort})`)
} else {
const taken = collectTakenPorts([])
gamePort = await suggestPort(25565, taken)
taken.set(gamePort, 'game')
const rconPort = await suggestPort(25575, taken)

const created = await startCreation(
  {
    name: NAME,
    flavor: 'vanilla',
    mcVersion: '1.21.4',
    loaderVersion: null,
    gamePort,
    rconPort,
    eulaAccepted: true,
    memoryMb: 2048,
    java: { mode: 'existing' },
    parentDir: ROOT,
  },
  { knownDirs: [], ...IDENT },
)
if (!created.ok) {
  check('creation started', false, created.reason)
  finish()
}
DIR = created.dir
const t0 = Date.now()
while (Date.now() - t0 < 300_000) {
  const j = jobFor(created.opId)
  if (j?.state === 'complete' || j?.state === 'failed') break
  await sleep(2000)
}
check('the throwaway server was created', jobFor(created.opId)?.state === 'complete', jobFor(created.opId)?.error ?? undefined)
console.log(`server    : ${DIR} (game ${gamePort}, 1.21.4)`)
}

resetLocks()
const target = { id: NAME, name: NAME, dir: DIR }
const launcher = detectLauncher(DIR, await indexTasks())
const started = await startServer(target, launcher)
// On a reused world the server may still be up from the previous attempt;
// the double-spawn guard refusing to start a second JVM IS the right answer.
const startedOrRunning = started.ok || /already running/i.test(started.detail)
check('it starts through the real start path (or was already running)', startedOrRunning, started.detail)
let ready = false
const t1 = Date.now()
while (Date.now() - t1 < 240_000) {
  const log = existsSync(join(DIR, 'logs', 'latest.log')) ? readFileSync(join(DIR, 'logs', 'latest.log'), 'utf8') : ''
  if (/Done \(/.test(log)) {
    ready = true
    break
  }
  await sleep(3000)
}
check('and boots to Done', ready)
console.log(`boot      : ${ready ? 'Done' : 'not ready'} after ${Math.round((Date.now() - t1) / 1000)}s`)

// ---------------------------------------------------------------------------
console.log('\n=== 2. the verified agent, and the operator boundary ===\n')
// ---------------------------------------------------------------------------

const { agentExePath, secretPath } = await import('../server/tunnel')
if (existsSync(agentExePath(DATA))) {
  check('the agent installed against digest and signature (reused, verified at install)', true)
} else {
  const installed = await installAgent(IDENT)
  check('the agent installed against digest and signature', installed.ok, installed.ok ? undefined : installed.reason)
  if (!installed.ok) finish()
}

if (existsSync(secretPath(DATA))) {
  check('the operator approved the claim and playit issued the credential (reused from the previous run)', true)
  console.log('claim     : reusing the stored credential; no new agent entry is minted')
} else {
  const claim = startClaim(IDENT)
  writeFileSync(URL_FILE, `${claim.url}\n`, 'utf8')
  console.log('claim URL written for the operator; waiting for approval in their browser (15 minute window)...')

  let claimState = claim.state
  const t2 = Date.now()
  while (Date.now() - t2 < 16 * 60_000) {
    const st = await pollClaim(IDENT)
    if (st.state !== claimState) {
      claimState = st.state
      console.log(`claim     : ${st.state} (${st.detail})`)
    }
    if (st.state === 'claimed' || st.state === 'rejected' || st.state === 'timed-out' || st.state === 'error') break
    await sleep(3000)
  }
  check('the operator approved the claim and playit issued the credential', claimState === 'claimed', claimState)
  if (claimState !== 'claimed') {
    await stopServer(target)
    finish()
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. the agent runs (operator-approved) and reports connected ===\n')
// ---------------------------------------------------------------------------

const run = runAgent(true, IDENT)
check('the agent starts with the operator-approved credential', run.ok, run.ok ? undefined : run.reason)
let connected = false
const t3 = Date.now()
while (Date.now() - t3 < 90_000) {
  const st = await tunnelStatus(IDENT)
  if (st.agent.state === 'connected') {
    connected = true
    break
  }
  await sleep(2000)
}
check('the agent itself reports connected', connected)
console.log(`agent     : ${connected ? 'connected' : 'not connected'} after ${Math.round((Date.now() - t3) / 1000)}s`)

// ---------------------------------------------------------------------------
console.log('\n=== 4. exposure, address, and a real handshake through it ===\n')
// ---------------------------------------------------------------------------

const already = (await tunnelStatus(IDENT)).tunnels.some((t) => t.serverId === NAME)
if (already) {
  check('the typed name exposes the throwaway server (tunnel reused from the previous attempt)', true)
} else {
  const enabled = await enableTunnel({ id: NAME, name: NAME, dir: DIR, gamePort }, NAME, IDENT)
  check('the typed name exposes the throwaway server', enabled.ok, enabled.ok ? undefined : enabled.reason)
}

let address: string | null = null
const t4 = Date.now()
while (Date.now() - t4 < 90_000) {
  const st = await tunnelStatus(IDENT)
  address = st.tunnels.find((t) => t.serverId === NAME)?.address ?? null
  if (address) break
  await sleep(3000)
}
check('an address appears while the agent is connected', address !== null)
console.log(`address   : ${address ?? 'none'}`)

if (address) {
  // A minecraft-java tunnel's display address may carry no port at all:
  // it rides Minecraft's default 25565 (measured on the first live run,
  // which crashed exactly here parsing "host" as "host:port").
  const idx = address.lastIndexOf(':')
  const host = idx >= 0 ? address.slice(0, idx) : address
  const port = idx >= 0 ? Number(address.slice(idx + 1)) : 25565
  let slp = null
  const t5 = Date.now()
  while (Date.now() - t5 < 60_000) {
    slp = await slpPing(port, host, 10_000)
    if (slp?.ready) break
    await sleep(3000)
  }
  check('a real SLP handshake succeeds THROUGH the tunnel', slp?.ready === true, JSON.stringify(slp))
  console.log(`slp       : ${slp ? `${slp.versionName ?? '?'} players ${slp.playersOnline}/${slp.playersMax}` : 'no reply'}`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. withdrawal: delete at the provider, stop everything ===\n')
// ---------------------------------------------------------------------------

const disabled = await disableTunnel(NAME, IDENT)
check('the tunnel is deleted at the provider', disabled.ok, disabled.ok ? undefined : disabled.reason)
stopAgent(IDENT)
const afterStop = await tunnelStatus(IDENT)
check('with the agent stopped no address is shown anywhere', afterStop.tunnels.every((t) => t.address === null))
const stopped = await stopServer(target)
check('the throwaway server stops cleanly over RCON', stopped.ok, stopped.detail)

finish()
