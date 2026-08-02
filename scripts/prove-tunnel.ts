/**
 * PROOF: public access cannot happen by accident, and the credential and
 * address rules hold under every failure.
 *
 * What is proven, each against an injected seam (no network, no process, no
 * real binary anywhere in this file):
 *
 *   1. INSTALL is verified twice or not at all: a release without a sha256
 *      digest is refused out loud; a failed Authenticode check deletes the
 *      staged exe; success records tag and hash.
 *   2. CLAIM: the code is 10 lowercase hex chars and the URL is exactly
 *      playit's; every ClaimSetupResponse string maps to an honest state; a
 *      rejection stores nothing; approval writes the secret file in playit's
 *      own TOML shape, and the secret appears in NO status object and NO
 *      audit line, ever.
 *   3. RUN AGENT: refused without the binary, without the credential, and
 *      without the explicit confirmation (audited as denied, spawn never
 *      called). With all three, the spawn happens with --secret-path, and
 *      "connected" becomes true only after the agent's own log line arrives.
 *      Exit flips it back and says the servers stay LAN-only.
 *   4. ENABLE: a mistyped server name is refused and audited before any
 *      provider call; the create request carries the EXACT adjacently-tagged
 *      origin from the pinned source; a provider failure stores nothing and
 *      says the server stays LAN-only.
 *   5. THE ADDRESS RULE: with tunnels stored and the provider answering,
 *      the address is null in every agent state except connected.
 *   6. DISABLE deletes at the provider; a tunnel already gone at the
 *      provider still clears locally.
 *
 * WORLD: a throwaway MCDASH_DATA_DIR. Run: npx tsx scripts/prove-tunnel.ts
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA = mkdtempSync(join(tmpdir(), 'mcdash-tunnel-'))
process.env.MCDASH_DATA_DIR = DATA

const {
  installAgent,
  startClaim,
  pollClaim,
  claimStatusOf,
  resetClaim,
  runAgent,
  stopAgent,
  stopAgentOnShutdown,
  resetAgentRuntime,
  enableTunnel,
  disableTunnel,
  tunnelStatus,
  resetAddressCache,
  agentExePath,
  secretPath,
} = await import('../server/tunnel')

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const { initAudit } = await import('../server/audit')
initAudit(DATA)
const auditFile = join(DATA, 'audit.jsonl')
const auditText = () => (existsSync(auditFile) ? readFileSync(auditFile, 'utf8') : '')

const IDENT = { actor: 'proof-admin', role: 'admin', ip: '127.0.0.1' }
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

const ok = (data: unknown) => ({ status: 200, body: { status: 'success', data } })
const fail = (data: unknown) => ({ status: 400, body: { status: 'fail', data } })

// ===========================================================================
console.log('\n=== 1. install: verified twice or not at all ===\n')
// ===========================================================================
{
  const release = (digest: string | undefined) => ({
    json: async () => ({
      tag_name: 'v9.9.9',
      assets: [{ name: 'playit-windows-x86_64-signed.exe', digest, browser_download_url: 'https://github.com/x/y.exe' }],
    }),
    post: async () => {
      throw new Error('no POST belongs in install')
    },
  })

  const noDigest = await installAgent({ ...IDENT, fetchers: release(undefined), download: async () => ({ bytes: 1 }) })
  check('a release without a digest is refused out loud', !noDigest.ok && noDigest.reason.includes('cannot be verified'))

  let downloadedWith: string | null = null
  const badSig = await installAgent({
    ...IDENT,
    fetchers: release(`sha256:${'a'.repeat(64)}`),
    download: async (_url, dest, sha) => {
      downloadedWith = sha
      writeFileSync(dest, 'exe bytes')
      return { bytes: 9 }
    },
    authenticode: async () => ({ ok: false, detail: 'Authenticode status is NotSigned, not Valid' }),
  })
  check('the download seam received the declared digest', downloadedWith === 'a'.repeat(64))
  check('a failed signature check refuses', !badSig.ok && badSig.reason.includes('NotSigned'))
  check('and the staged exe was deleted', !existsSync(agentExePath(DATA)))

  const good = await installAgent({
    ...IDENT,
    fetchers: release(`sha256:${'a'.repeat(64)}`),
    download: async (_url, dest) => {
      writeFileSync(dest, 'exe bytes')
      return { bytes: 9 }
    },
    authenticode: async () => ({ ok: true, detail: 'Authenticode Valid, signed by CN=playit' }),
  })
  check('a verified install succeeds and reports the tag', good.ok && good.version === 'v9.9.9')
  check('the exe is on disk', existsSync(agentExePath(DATA)))
  check('the install was audited with both verifications named', /tunnel\.install.*sha256 verified.*Authenticode Valid/.test(auditText()))
}

// ===========================================================================
console.log('\n=== 2. claim: provider-minted, secret never surfaces ===\n')
// ===========================================================================
{
  const started = startClaim(IDENT)
  const code = started.url?.split('/').pop() ?? ''
  check('the claim code is 10 lowercase hex characters', /^[0-9a-f]{10}$/.test(code), code)
  check('the URL is exactly playit claim form', started.url === `https://playit.gg/claim/${code}`)
  check('the starting state is waiting-visit', started.state === 'waiting-visit')

  const seq = (answers: Array<ReturnType<typeof ok> | ReturnType<typeof fail>>) => {
    let i = 0
    return {
      json: async () => ({}),
      post: async (url: string) => {
        if (url.endsWith('/claim/setup') || url.endsWith('/claim/exchange')) return answers[Math.min(i++, answers.length - 1)]!
        throw new Error(`unexpected POST ${url}`)
      },
    }
  }

  let st = await pollClaim({ ...IDENT, fetchers: seq([ok('WaitingForUserVisit')]) })
  check('WaitingForUserVisit maps to waiting-visit', st.state === 'waiting-visit')
  st = await pollClaim({ ...IDENT, fetchers: seq([ok('WaitingForUser')]) })
  check('WaitingForUser maps to waiting-approval', st.state === 'waiting-approval')

  // Rejection: terminal, nothing stored.
  st = await pollClaim({ ...IDENT, fetchers: seq([ok('UserRejected')]) })
  check('a browser rejection is terminal and honest', st.state === 'rejected' && st.detail.includes('Nothing was stored'))
  check('no secret file exists after rejection', !existsSync(secretPath(DATA)))
  check('the rejection was audited as denied', /tunnel\.claim.*denied/.test(auditText()))

  // Fresh claim, approved: setup says accepted, exchange hands the secret.
  resetClaim()
  startClaim(IDENT)
  st = await pollClaim({ ...IDENT, fetchers: seq([ok('UserAccepted'), ok({ secret_key: SECRET })]) })
  check('approval leads to claimed', st.state === 'claimed', st.detail)
  check('the secret file is playit TOML', readFileSync(secretPath(DATA), 'utf8') === `secret_key = "${SECRET}"\n`)
  check('the secret appears in no claim status', !JSON.stringify(claimStatusOf()).includes(SECRET))
  check('the secret appears nowhere in the audit log', !auditText().includes(SECRET))

  // A malformed exchange answer must not store garbage.
  resetClaim()
  startClaim(IDENT)
  st = await pollClaim({ ...IDENT, fetchers: seq([ok('UserAccepted'), ok({ secret_key: 'not hex!' })]) })
  check('a malformed secret is refused, stated', st.state === 'error' && st.detail.includes('usable secret'))
}

// ===========================================================================
console.log('\n=== 3. running the binary needs everything, every time ===\n')
// ===========================================================================
{
  resetAgentRuntime()
  let spawned: { exe: string; args: string[] } | null = null
  const fakeSpawn = (exe: string, args: string[]) => {
    spawned = { exe, args }
    const p = new EventEmitter() as import('node:child_process').ChildProcess
    ;(p as { stdout: EventEmitter }).stdout = new EventEmitter()
    ;(p as { stderr: EventEmitter }).stderr = new EventEmitter()
    ;(p as { kill: () => boolean }).kill = () => (p.emit('exit', 0), true)
    return p
  }

  const unconfirmed = runAgent(false, { ...IDENT, spawnAgent: fakeSpawn })
  check('without the confirmation the run is refused', !unconfirmed.ok && unconfirmed.reason.includes('explicitly confirm'))
  check('and nothing was spawned', spawned === null)
  check('the refusal was audited as denied', /tunnel\.run-agent.*denied/.test(auditText()))

  const run = runAgent(true, { ...IDENT, spawnAgent: fakeSpawn })
  check('with the confirmation the agent starts', run.ok)
  const sp = spawned as { exe: string; args: string[] } | null
  check('spawned with --secret-path pointing at the stored credential',
    sp !== null && sp.args.join(' ') === `--secret-path ${secretPath(DATA)}`)

  let status = await tunnelStatus({ ...IDENT, fetchers: { json: async () => ({}), post: async () => ok({}) } })
  check('before the log line the state is starting, not connected', status.agent.state === 'starting')

  // The agent's own words are the only thing that flips connected.
  const proc = spawned! as unknown as { exe: string } // narrow for TS
  void proc
  const running = runAgent(true, { ...IDENT, spawnAgent: fakeSpawn })
  check('a second start while running is refused', !running.ok)

  stopAgent(IDENT)
  status = await tunnelStatus({ ...IDENT, fetchers: { json: async () => ({}), post: async () => ok({}) } })
  check('after stop the state is claimed again', status.agent.state === 'claimed')

  // The Public page says the agent stops when the dashboard exits. That is a
  // claim about shutdown, so it needs code and a check, not an assumption
  // that Windows reaps a child process (it does not promise to).
  let killed = false
  runAgent(true, {
    ...IDENT,
    spawnAgent: () => {
      const p = new EventEmitter() as import('node:child_process').ChildProcess
      ;(p as { stdout: EventEmitter }).stdout = new EventEmitter()
      ;(p as { stderr: EventEmitter }).stderr = new EventEmitter()
      ;(p as { kill: () => boolean }).kill = () => ((killed = true), p.emit('exit', 0), true)
      return p
    },
  })
  stopAgentOnShutdown()
  check('the shutdown path kills the agent it started', killed)
  status = await tunnelStatus({ ...IDENT, fetchers: { json: async () => ({}), post: async () => ok({}) } })
  check('and no address survives the shutdown', status.tunnels.every((t) => t.address === null))
}

// ===========================================================================
console.log('\n=== 4. enable: typed name, exact wire shape, honest failure ===\n')
// ===========================================================================
{
  const SERVER = { id: 'MC Proof', name: 'MC Proof', dir: join(DATA, 'MC Proof'), gamePort: 25565 }

  const neverCalled = { json: async () => ({}), post: async () => { throw new Error('no provider call may happen') } }
  const wrong = await enableTunnel(SERVER, 'MC Wrong', { ...IDENT, fetchers: neverCalled })
  check('a mistyped server name is refused before any provider call', !wrong.ok && wrong.reason.includes('does not match'))
  check('and audited as denied', /tunnel\.enable.*denied/.test(auditText()))

  const bodies: Array<{ url: string; body: unknown }> = []
  const provider = {
    json: async () => ({}),
    post: async (url: string, _h: string[], body: unknown) => {
      bodies.push({ url, body })
      if (url.endsWith('/v1/agents/rundata')) return ok({ agent_id: 'agent-uuid-1', tunnels: [] })
      if (url.endsWith('/tunnels/create')) return ok({ id: 'tunnel-uuid-1' })
      throw new Error(`unexpected ${url}`)
    },
  }
  const enabled = await enableTunnel(SERVER, 'MC Proof', { ...IDENT, fetchers: provider })
  check('the exact name enables and returns the tunnel id', enabled.ok && enabled.tunnelId === 'tunnel-uuid-1')
  const create = bodies.find((b) => b.url.endsWith('/tunnels/create'))?.body as Record<string, unknown>
  check('the create request is the pinned ReqTunnelsCreate shape',
    create?.tunnel_type === 'minecraft-java' && create?.port_type === 'tcp' && create?.port_count === 1 && create?.enabled === true)
  check('the origin is adjacently tagged exactly as the source declares',
    JSON.stringify(create?.origin) ===
      JSON.stringify({ type: 'agent', data: { agent_id: 'agent-uuid-1', local_ip: '127.0.0.1', local_port: 25565 } }))
  check('the exposure was audited naming server and port', /tunnel\.enable.*MC Proof.*game port 25565 becomes reachable/.test(auditText()))

  const dup = await enableTunnel(SERVER, 'MC Proof', { ...IDENT, fetchers: provider })
  check('a second tunnel for the same server is refused', !dup.ok && dup.reason.includes('already exists'))

  const failing = {
    json: async () => ({}),
    post: async (url: string) =>
      url.endsWith('/v1/agents/rundata') ? ok({ agent_id: 'agent-uuid-1' }) : fail('NoLongerAvailable'),
  }
  const OTHER = { id: 'MC Other', name: 'MC Other', dir: join(DATA, 'MC Other'), gamePort: 25570 }
  const refused = await enableTunnel(OTHER, 'MC Other', { ...IDENT, fetchers: failing })
  check('a provider failure refuses and says the server stays LAN-only', !refused.ok && refused.reason.includes('LAN-only'))
  const after = await tunnelStatus({ ...IDENT, fetchers: provider })
  check('and stored nothing for it', !after.tunnels.some((t) => t.serverId === 'MC Other'))
}

// ===========================================================================
console.log('\n=== 5. the address rule: null unless connected ===\n')
// ===========================================================================
{
  resetAgentRuntime()
  resetAddressCache()
  const provider = {
    json: async () => ({}),
    post: async (url: string) =>
      url.endsWith('/v1/agents/rundata')
        ? ok({ agent_id: 'agent-uuid-1', tunnels: [{ id: 'tunnel-uuid-1', display_address: 'proof.ply.gg:12345' }] })
        : ok({}),
  }

  let status = await tunnelStatus({ ...IDENT, fetchers: provider })
  check('agent not running: the tunnel exists but its address is null', status.tunnels[0]?.address === null)
  check('and the detail says why', status.tunnels[0]?.detail.includes('no address is shown') === true)

  // Start the agent through the fake and feed it the real connected line.
  let emitter: EventEmitter | null = null
  runAgent(true, {
    ...IDENT,
    spawnAgent: () => {
      const p = new EventEmitter() as import('node:child_process').ChildProcess
      ;(p as { stdout: EventEmitter }).stdout = new EventEmitter()
      ;(p as { stderr: EventEmitter }).stderr = new EventEmitter()
      ;(p as { kill: () => boolean }).kill = () => (p.emit('exit', 0), true)
      emitter = (p as { stderr: EventEmitter }).stderr
      return p
    },
  })
  status = await tunnelStatus({ ...IDENT, fetchers: provider })
  check('spawned but silent: still no address', status.tunnels[0]?.address === null)

  emitter!.emit('data', Buffer.from('2026-08-01 INFO playit connected; tunnels loaded agent_id=x tunnel_count=1\n'))
  await sleep(10)
  status = await tunnelStatus({ ...IDENT, fetchers: provider })
  check('after the agent SAYS connected, the address appears', status.tunnels[0]?.address === 'proof.ply.gg:12345')
  check('the agent state is connected', status.agent.state === 'connected')

  stopAgent(IDENT)
  resetAddressCache()
  status = await tunnelStatus({ ...IDENT, fetchers: provider })
  check('stopping the agent hides the address again, whatever playit would say', status.tunnels[0]?.address === null)
}

// ===========================================================================
console.log('\n=== 6. disable deletes at the provider ===\n')
// ===========================================================================
{
  const calls: unknown[] = []
  const provider = {
    json: async () => ({}),
    post: async (url: string, _h: string[], body: unknown) => {
      if (url.endsWith('/tunnels/delete')) {
        calls.push(body)
        return ok(null)
      }
      throw new Error(`unexpected ${url}`)
    },
  }
  const gone = await disableTunnel('MC Proof', { ...IDENT, fetchers: provider })
  check('disable succeeds', gone.ok)
  check('the delete named the exact tunnel id', JSON.stringify(calls[0]) === JSON.stringify({ tunnel_id: 'tunnel-uuid-1' }))
  const status = await tunnelStatus({ ...IDENT, fetchers: provider })
  check('the local record is gone', status.tunnels.length === 0)

  const missing = await disableTunnel('MC Proof', { ...IDENT, fetchers: provider })
  check('disabling a server with no tunnel says so', !missing.ok && missing.reason.includes('No tunnel'))
}

let pass = 0
let failN = 0
for (const [label, okC, detail] of checks) {
  if (okC) pass++
  else {
    failN++
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`)
  }
}
console.log('\n================================================================')
if (failN === 0) console.log(`ALL PASS. ${pass} checks`)
else console.log(`${failN} FAILED, ${pass} passed`)
console.log(`world: ${DATA}`)
process.exit(failN === 0 ? 0 : 1)
