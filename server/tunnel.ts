import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { TunnelAgentStatus, TunnelClaimStatus, TunnelEntry, TunnelStatus } from '@shared/api'
import { fetchJson, fetchVerified, postJson } from './fetchverify'
import { audit } from './audit'
import { dataDir } from './config'

/**
 * Public access through a playit.gg tunnel. The boundaries (DESIGN.md) shape
 * every function here:
 *
 *   - **Off by default, per server.** Nothing in this file is called by the
 *     scan loop, by Start, or by anything else on a timer. Every entry point
 *     is an operator's audited click, and "never in the background" includes
 *     the agent process: it runs when the operator starts it and stops when
 *     they stop it or the dashboard exits.
 *   - **The credential is minted by the provider.** The claim flow is
 *     playit's own: we generate a 10-hex-char code locally, the operator
 *     opens https://playit.gg/claim/<code> in their browser and approves it
 *     against their own account, and playit issues the agent secret straight
 *     to this machine over HTTPS. No third party, no proxy of ours, and the
 *     secret never appears in a response, an audit line, or a log.
 *   - **Honest failure leaves the server LAN-only.** Any refusal or error
 *     stores nothing and changes nothing; there is no partially-exposed
 *     state.
 *   - **The address is shown only while the agent reports connected.**
 *     Enforced here, not in the UI: tunnelStatus() returns address: null
 *     unless the agent process is alive and has reported its tunnels are
 *     loaded, so a stale address cannot be handed out by any client.
 *
 * Every wire shape below was read from the agent's own source at the pinned
 * commit 9e7b9a1 (v1.0.10): the ApiResult envelope ({"status","data"}), the
 * adjacently tagged TunnelOriginCreate ({"type":"agent","data":{...}}), the
 * ClaimSetupResponse strings, AgentRunDataV1.display_address, and the
 * "playit connected; tunnels loaded" log line. Nothing here is guessed; if
 * playit changes their API the failure is loud, not silent.
 */

const GH_API_HOSTS = ['api.github.com']
const GH_ASSET_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']
const PLAYIT_HOSTS = ['api.playit.gg']
const PLAYIT_API = 'https://api.playit.gg'
const RELEASES_URL = 'https://api.github.com/repos/playit-cloud/playit-agent/releases/latest'
/** The signed build, so Authenticode gives a second check independent of GitHub. */
const ASSET_NAME = 'playit-windows-x86_64-signed.exe'
/** Sent to /claim/setup; the version of the agent this claim is for. */
const AGENT_VERSION_TEXT = 'playit 1.0.10'
const CLAIM_TTL_MS = 15 * 60_000
const CONNECTED_LINE = /playit connected; tunnels loaded/
const ADDRESS_CACHE_MS = 30_000

export function tunnelDir(base: string = dataDir()): string {
  return join(base, 'tunnel')
}
export function agentExePath(base: string = dataDir()): string {
  return join(tunnelDir(base), 'playit-agent.exe')
}
export function secretPath(base: string = dataDir()): string {
  return join(tunnelDir(base), 'playit.toml')
}
const statePath = (base: string) => join(tunnelDir(base), 'tunnel.json')
const agentLogPath = (base: string) => join(tunnelDir(base), 'agent.log')

// ------------------------------------------------------------------- state

type StoredTunnel = {
  tunnelId: string
  serverId: string
  dir: string
  localPort: number
  enabledAt: string
}

type TunnelState = {
  version: 1
  agentTag: string | null
  agentSha256: string | null
  runConfirmedAt: string | null
  tunnels: StoredTunnel[]
}

function loadState(base: string): TunnelState {
  try {
    const raw = JSON.parse(readFileSync(statePath(base), 'utf8')) as Partial<TunnelState>
    return {
      version: 1,
      agentTag: typeof raw.agentTag === 'string' ? raw.agentTag : null,
      agentSha256: typeof raw.agentSha256 === 'string' ? raw.agentSha256 : null,
      runConfirmedAt: typeof raw.runConfirmedAt === 'string' ? raw.runConfirmedAt : null,
      tunnels: Array.isArray(raw.tunnels)
        ? raw.tunnels.filter(
            (t): t is StoredTunnel =>
              !!t && typeof t.tunnelId === 'string' && typeof t.serverId === 'string' && typeof t.localPort === 'number',
          )
        : [],
    }
  } catch {
    return { version: 1, agentTag: null, agentSha256: null, runConfirmedAt: null, tunnels: [] }
  }
}

function saveState(base: string, s: TunnelState): void {
  mkdirSync(tunnelDir(base), { recursive: true })
  const p = statePath(base)
  writeFileSync(`${p}.tmp`, JSON.stringify(s, null, 2), 'utf8')
  renameSync(`${p}.tmp`, p)
}

// -------------------------------------------------------------------- deps

export type Refusal = { ok: false; reason: string }

export type TunnelDeps = {
  base?: string
  fetchers?: {
    json: (url: string, allowHosts: string[]) => Promise<unknown>
    post: (
      url: string,
      allowHosts: string[],
      body: unknown,
      headers?: Record<string, string>,
    ) => Promise<{ status: number; body: unknown }>
  }
  download?: (url: string, dest: string, sha256: string) => Promise<{ bytes: number }>
  /** Reads the file's Authenticode signature. Never executes the file. */
  authenticode?: (exe: string) => Promise<{ ok: boolean; detail: string }>
  spawnAgent?: (exe: string, args: string[]) => ChildProcess
  actor: string | null
  role: string | null
  ip: string
}

const liveFetchers = { json: fetchJson, post: postJson }

/**
 * playit's ApiResult envelope: {"status":"success"|"fail"|"error","data":...}.
 * A fail carries a typed reason (bare enum string or object); an error
 * carries {type, message}. Both become one sentence.
 */
function unwrap(res: { status: number; body: unknown }): { ok: true; data: unknown } | Refusal {
  const b = res.body as { status?: string; data?: unknown } | null
  if (!b || typeof b.status !== 'string') {
    return { ok: false, reason: `playit answered HTTP ${res.status} without the expected envelope.` }
  }
  if (b.status === 'success') return { ok: true, data: b.data }
  if (b.status === 'fail') {
    const d = typeof b.data === 'string' ? b.data : JSON.stringify(b.data)
    return { ok: false, reason: `playit refused: ${d}.` }
  }
  const err = b.data as { type?: string; message?: unknown } | null
  return {
    ok: false,
    reason: `playit error${err?.type ? ` (${err.type})` : ''}: ${typeof err?.message === 'string' ? err.message : 'no detail'}.`,
  }
}

const agentKeyHeader = (secret: string) => ({ authorization: `Agent-Key ${secret}` })

function readSecret(base: string): string | null {
  try {
    const text = readFileSync(secretPath(base), 'utf8')
    const m = /secret_key\s*=\s*"([0-9a-fA-F]+)"/.exec(text)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

// ----------------------------------------------------------------- install

/** PowerShell reads the signature from the file; the file is not executed. */
async function checkAuthenticode(exe: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((done) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$s = Get-AuthenticodeSignature -LiteralPath '${exe.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`,
      ],
      { timeout: 30_000 },
      (err, stdout) => {
        if (err) return done({ ok: false, detail: `signature check failed to run: ${err.message}` })
        const [status, subject] = stdout.trim().split('|')
        if (status === 'Valid') return done({ ok: true, detail: `Authenticode Valid, signed by ${subject ?? 'unknown'}` })
        done({ ok: false, detail: `Authenticode status is ${status ?? 'unreadable'}, not Valid` })
      },
    )
  })
}

/**
 * Download the agent, verified twice: the sha256 digest GitHub's release API
 * declares for the asset (fetchVerified refuses on mismatch and deletes the
 * staged file), then the Authenticode signature on the signed build, which is
 * playit's own and does not depend on GitHub. A release without a digest is
 * refused out loud. Nothing is executed here.
 */
export async function installAgent(deps: TunnelDeps): Promise<{ ok: true; version: string } | Refusal> {
  const base = deps.base ?? dataDir()
  const f = deps.fetchers ?? liveFetchers
  let release: { tag_name?: string; assets?: Array<{ name?: string; digest?: string; browser_download_url?: string }> }
  try {
    release = (await f.json(RELEASES_URL, GH_API_HOSTS)) as typeof release
  } catch (e) {
    return { ok: false, reason: `Could not read the release listing: ${e instanceof Error ? e.message : e}` }
  }
  const asset = (release.assets ?? []).find((a) => a.name === ASSET_NAME)
  if (!asset?.browser_download_url) {
    return { ok: false, reason: `The latest release (${release.tag_name ?? 'unknown'}) has no ${ASSET_NAME} asset.` }
  }
  const digest = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')
  if (!digest) {
    return {
      ok: false,
      reason: `The release publishes no sha256 digest for ${ASSET_NAME}, so the download cannot be verified and will not be made.`,
    }
  }
  const expected = digest[1]!

  mkdirSync(tunnelDir(base), { recursive: true })
  const dest = agentExePath(base)
  try {
    if (deps.download) await deps.download(asset.browser_download_url, dest, expected)
    else
      await fetchVerified({
        url: asset.browser_download_url,
        dest,
        algo: 'sha256',
        expected,
        allowHosts: GH_ASSET_HOSTS,
      })
  } catch (e) {
    return { ok: false, reason: `Download failed verification: ${e instanceof Error ? e.message : e}` }
  }

  const sig = await (deps.authenticode ?? checkAuthenticode)(dest)
  if (!sig.ok) {
    // Our own staged download failing its second check is deleted like a
    // failed checksum: it never becomes an installed agent.
    try {
      unlinkSync(dest)
    } catch {
      /* reported either way */
    }
    return { ok: false, reason: `The downloaded agent was removed: ${sig.detail}.` }
  }

  const s = loadState(base)
  s.agentTag = release.tag_name ?? null
  s.agentSha256 = expected
  saveState(base, s)
  audit({
    actor: deps.actor,
    role: deps.role,
    action: 'tunnel.install',
    target: ASSET_NAME,
    outcome: 'ok',
    ip: deps.ip,
    detail: `${release.tag_name ?? 'unknown tag'}, sha256 verified, ${sig.detail}`,
  })
  return { ok: true, version: release.tag_name ?? 'unknown' }
}

// ------------------------------------------------------------------- claim

let claim: { code: string; state: TunnelClaimStatus['state']; detail: string; startedAt: number } | null = null

export function claimStatusOf(): TunnelClaimStatus {
  if (!claim) return { state: 'none', url: null, detail: 'No claim is in progress.' }
  return {
    state: claim.state,
    url: claim.state === 'claimed' ? null : `https://playit.gg/claim/${claim.code}`,
    detail: claim.detail,
  }
}

/** Starts a claim: a locally generated code and the URL to open. */
export function startClaim(deps: TunnelDeps): TunnelClaimStatus {
  // 5 random bytes, hex: the same entropy the official CLI generates.
  const code = randomBytes(5).toString('hex')
  claim = {
    code,
    state: 'waiting-visit',
    detail: 'Open the link and approve this dashboard as an agent in your playit account. Nothing is created until you approve it there.',
    startedAt: Date.now(),
  }
  audit({
    actor: deps.actor,
    role: deps.role,
    action: 'tunnel.claim-start',
    target: 'playit.gg',
    outcome: 'ok',
    ip: deps.ip,
    detail: 'claim code generated locally; approval happens in the operator browser',
  })
  return claimStatusOf()
}

/**
 * One poll step, driven by the client's own polling; there is no server-side
 * loop. On approval the code is exchanged for the agent secret, which is
 * written to the secret file and nowhere else: not into this return value,
 * not into the audit log.
 */
export async function pollClaim(deps: TunnelDeps): Promise<TunnelClaimStatus> {
  const base = deps.base ?? dataDir()
  const f = deps.fetchers ?? liveFetchers
  if (!claim) return claimStatusOf()
  if (claim.state === 'claimed' || claim.state === 'rejected' || claim.state === 'timed-out' || claim.state === 'error') {
    return claimStatusOf()
  }
  if (Date.now() - claim.startedAt > CLAIM_TTL_MS) {
    claim.state = 'timed-out'
    claim.detail = 'The claim was not approved within 15 minutes. Start a new one when you are ready.'
    return claimStatusOf()
  }

  let setup: { ok: true; data: unknown } | Refusal
  try {
    setup = unwrap(
      await f.post(`${PLAYIT_API}/claim/setup`, PLAYIT_HOSTS, {
        code: claim.code,
        agent_type: 'self-managed',
        version: AGENT_VERSION_TEXT,
      }),
    )
  } catch (e) {
    // A transient network failure is not a verdict; the state holds.
    claim.detail = `Could not reach playit just now (${e instanceof Error ? e.message : e}); still waiting.`
    return claimStatusOf()
  }
  if (!setup.ok) {
    claim.state = 'error'
    claim.detail = setup.reason
    return claimStatusOf()
  }

  switch (setup.data) {
    case 'WaitingForUserVisit':
      claim.state = 'waiting-visit'
      claim.detail = 'Waiting for the link to be opened.'
      break
    case 'WaitingForUser':
      claim.state = 'waiting-approval'
      claim.detail = 'The link is open; waiting for approval in the browser.'
      break
    case 'UserRejected':
      claim.state = 'rejected'
      claim.detail = 'The claim was rejected in the browser. Nothing was stored.'
      audit({
        actor: deps.actor, role: deps.role, action: 'tunnel.claim', target: 'playit.gg',
        outcome: 'denied', ip: deps.ip, detail: 'rejected by the operator in the browser',
      })
      break
    case 'UserAccepted': {
      const ex = unwrap(await f.post(`${PLAYIT_API}/claim/exchange`, PLAYIT_HOSTS, { code: claim.code }))
      if (!ex.ok) {
        claim.detail = `Approved; the credential exchange has not completed yet (${ex.reason})`
        break
      }
      const key = (ex.data as { secret_key?: unknown } | null)?.secret_key
      if (typeof key !== 'string' || !/^[0-9a-fA-F]{16,}$/.test(key)) {
        claim.state = 'error'
        claim.detail = 'playit answered the exchange without a usable secret key.'
        break
      }
      mkdirSync(tunnelDir(base), { recursive: true })
      writeFileSync(secretPath(base), `secret_key = "${key}"\n`, 'utf8')
      claim.state = 'claimed'
      claim.detail = 'The agent credential was issued by playit and stored. It is never shown.'
      audit({
        actor: deps.actor, role: deps.role, action: 'tunnel.claim', target: 'playit.gg',
        outcome: 'ok', ip: deps.ip, detail: 'agent secret issued and stored; the key itself is not logged',
      })
      break
    }
    default:
      claim.state = 'error'
      claim.detail = `playit answered the claim poll with an unrecognised state (${String(setup.data)}).`
  }
  return claimStatusOf()
}

/** Test seam. */
export function resetClaim(): void {
  claim = null
}

// ------------------------------------------------------------------- agent

type AgentRuntime = {
  proc: ChildProcess | null
  connected: boolean
  startedAt: string | null
  detail: string
}

const runtime: AgentRuntime = { proc: null, connected: false, startedAt: null, detail: 'The agent is not running.' }

function watchLine(base: string, line: string): void {
  try {
    appendFileSync(agentLogPath(base), line + '\n', 'utf8')
  } catch {
    /* the log is best effort */
  }
  if (CONNECTED_LINE.test(line)) {
    runtime.connected = true
    runtime.detail = 'The agent reports its tunnels are loaded.'
  }
  if (/invalid secret/i.test(line)) {
    runtime.connected = false
    runtime.detail = 'The agent reports its secret is invalid. Re-run the claim to mint a new one.'
  }
}

/**
 * Run the downloaded agent. This is the one place the binary is executed,
 * and it happens only behind the explicit confirmation field, every time:
 * running a downloaded program does not become routine by having happened
 * before.
 */
export function runAgent(
  confirmRunDownloadedProgram: boolean,
  deps: TunnelDeps,
): { ok: true } | Refusal {
  const base = deps.base ?? dataDir()
  if (runtime.proc) return { ok: false, reason: 'The agent is already running.' }
  if (!existsSync(agentExePath(base))) {
    return { ok: false, reason: 'No verified agent binary is installed. Install it first.' }
  }
  if (!readSecret(base)) {
    return { ok: false, reason: 'No agent credential exists yet. Complete the claim first.' }
  }
  if (confirmRunDownloadedProgram !== true) {
    audit({
      actor: deps.actor, role: deps.role, action: 'tunnel.run-agent', target: agentExePath(base),
      outcome: 'denied', ip: deps.ip, detail: 'confirmation field missing',
    })
    return {
      ok: false,
      reason:
        'Starting the tunnel agent executes a downloaded program on this machine. It was verified against its published digest and its Authenticode signature, but it only runs after you explicitly confirm that.',
    }
  }

  const args = ['--secret-path', secretPath(base)]
  const child = deps.spawnAgent
    ? deps.spawnAgent(agentExePath(base), args)
    : spawn(agentExePath(base), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

  runtime.proc = child
  runtime.connected = false
  runtime.startedAt = new Date().toISOString()
  runtime.detail = 'The agent was started; waiting for it to report connected.'

  const onData = (buf: Buffer) => {
    for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) watchLine(base, line)
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.on('exit', (code) => {
    runtime.proc = null
    runtime.connected = false
    runtime.detail = `The agent exited with code ${code ?? 'unknown'}. Tunnel addresses are hidden until it runs again; the servers stay reachable on the LAN as before.`
  })
  child.on('error', (e) => {
    runtime.proc = null
    runtime.connected = false
    runtime.detail = `The agent could not be started: ${e.message}.`
  })

  const s = loadState(base)
  s.runConfirmedAt = new Date().toISOString()
  saveState(base, s)
  audit({
    actor: deps.actor, role: deps.role, action: 'tunnel.run-agent', target: agentExePath(base),
    outcome: 'ok', ip: deps.ip, detail: 'operator confirmed running the downloaded agent binary',
  })
  return { ok: true }
}

export function stopAgent(deps: TunnelDeps): { ok: true } {
  if (runtime.proc) {
    runtime.proc.kill()
    runtime.proc = null
  }
  runtime.connected = false
  runtime.detail = 'The agent was stopped. Tunnel addresses are hidden; the servers stay reachable on the LAN.'
  audit({
    actor: deps.actor, role: deps.role, action: 'tunnel.stop-agent', target: 'playit agent',
    outcome: 'ok', ip: deps.ip, detail: 'stopped by the operator',
  })
  return { ok: true }
}

/**
 * Kill the agent when the dashboard is shutting down, without auditing an
 * operator action nobody took. Public reachability is this process's doing,
 * so it ends with this process: Windows does not promise to reap a child,
 * and an orphaned agent would keep a world reachable after the dashboard
 * that exposed it is gone. Called from the server's onClose hook.
 */
export function stopAgentOnShutdown(): void {
  if (!runtime.proc) return
  runtime.proc.kill()
  runtime.proc = null
  runtime.connected = false
  runtime.detail = 'The agent was stopped because the dashboard shut down.'
}

/** Test seam. */
export function resetAgentRuntime(): void {
  runtime.proc = null
  runtime.connected = false
  runtime.startedAt = null
  runtime.detail = 'The agent is not running.'
}

// ----------------------------------------------------------------- tunnels

/**
 * Expose one server. The typed confirmation is checked here, server-side:
 * the caller must repeat the server's exact name, because this is the moment
 * a world becomes reachable by anyone on the internet.
 */
export async function enableTunnel(
  server: { id: string; name: string; dir: string; gamePort: number | null },
  confirmServerName: string,
  deps: TunnelDeps,
): Promise<{ ok: true; tunnelId: string } | Refusal> {
  const base = deps.base ?? dataDir()
  const f = deps.fetchers ?? liveFetchers
  if (confirmServerName !== server.name) {
    audit({
      actor: deps.actor, role: deps.role, action: 'tunnel.enable', target: server.name,
      outcome: 'denied', ip: deps.ip, detail: `confirmation name "${confirmServerName}" does not match the server`,
    })
    return { ok: false, reason: 'The confirmation name does not match the server name. Nothing was exposed.' }
  }
  if (server.gamePort === null) {
    return { ok: false, reason: 'This server declares no game port, so there is nothing to expose.' }
  }
  const secret = readSecret(base)
  if (!secret) return { ok: false, reason: 'No agent credential exists yet. Complete the claim first.' }
  const s = loadState(base)
  if (s.tunnels.some((t) => t.serverId === server.id)) {
    return { ok: false, reason: 'A tunnel already exists for this server.' }
  }

  let agentId: string
  try {
    const rd = unwrap(await f.post(`${PLAYIT_API}/v1/agents/rundata`, PLAYIT_HOSTS, {}, agentKeyHeader(secret)))
    if (!rd.ok) return { ok: false, reason: `Could not identify the agent with playit: ${rd.reason} The server stays LAN-only.` }
    const id = (rd.data as { agent_id?: unknown } | null)?.agent_id
    if (typeof id !== 'string') return { ok: false, reason: 'playit answered without an agent id. The server stays LAN-only.' }
    agentId = id
  } catch (e) {
    return { ok: false, reason: `Could not reach playit: ${e instanceof Error ? e.message : e}. The server stays LAN-only.` }
  }

  // Exact ReqTunnelsCreate shape from the pinned source; None fields are
  // sent as explicit null the way the official client does.
  const body = {
    name: server.name,
    tunnel_type: 'minecraft-java',
    port_type: 'tcp',
    port_count: 1,
    origin: { type: 'agent', data: { agent_id: agentId, local_ip: '127.0.0.1', local_port: server.gamePort } },
    enabled: true,
    alloc: null,
    firewall_id: null,
    proxy_protocol: null,
  }
  let tunnelId: string
  try {
    const created = unwrap(await f.post(`${PLAYIT_API}/tunnels/create`, PLAYIT_HOSTS, body, agentKeyHeader(secret)))
    if (!created.ok) return { ok: false, reason: `playit did not create the tunnel: ${created.reason} The server stays LAN-only.` }
    const id = (created.data as { id?: unknown } | null)?.id
    if (typeof id !== 'string') return { ok: false, reason: 'playit created no tunnel id. The server stays LAN-only.' }
    tunnelId = id
  } catch (e) {
    return { ok: false, reason: `Could not reach playit: ${e instanceof Error ? e.message : e}. The server stays LAN-only.` }
  }

  s.tunnels.push({
    tunnelId,
    serverId: server.id,
    dir: server.dir,
    localPort: server.gamePort,
    enabledAt: new Date().toISOString(),
  })
  saveState(base, s)
  audit({
    actor: deps.actor, role: deps.role, action: 'tunnel.enable', target: server.name,
    outcome: 'ok', ip: deps.ip,
    detail: `game port ${server.gamePort} becomes reachable from the internet through playit tunnel ${tunnelId}`,
  })
  return { ok: true, tunnelId }
}

/** Withdraw a server from public access. Deleting at the provider is the guarantee. */
export async function disableTunnel(serverId: string, deps: TunnelDeps): Promise<{ ok: true } | Refusal> {
  const base = deps.base ?? dataDir()
  const f = deps.fetchers ?? liveFetchers
  const s = loadState(base)
  const entry = s.tunnels.find((t) => t.serverId === serverId)
  if (!entry) return { ok: false, reason: 'No tunnel exists for this server.' }
  const secret = readSecret(base)
  if (!secret) return { ok: false, reason: 'No agent credential exists; the tunnel record cannot be deleted at playit.' }

  try {
    const del = unwrap(
      await f.post(`${PLAYIT_API}/tunnels/delete`, PLAYIT_HOSTS, { tunnel_id: entry.tunnelId }, agentKeyHeader(secret)),
    )
    // TunnelNotFound means it is already gone at the provider, which is the
    // outcome the operator asked for.
    if (!del.ok && !del.reason.includes('TunnelNotFound')) {
      return { ok: false, reason: `playit did not delete the tunnel: ${del.reason} It may still be reachable; try again.` }
    }
  } catch (e) {
    return { ok: false, reason: `Could not reach playit: ${e instanceof Error ? e.message : e}. The tunnel may still be reachable; try again.` }
  }

  s.tunnels = s.tunnels.filter((t) => t.serverId !== serverId)
  saveState(base, s)
  audit({
    actor: deps.actor, role: deps.role, action: 'tunnel.disable', target: serverId,
    outcome: 'ok', ip: deps.ip, detail: `tunnel ${entry.tunnelId} deleted at playit; the server is LAN-only again`,
  })
  return { ok: true }
}

// ------------------------------------------------------------------ status

let addressCache: { at: number; byTunnelId: Map<string, string> } | null = null

/**
 * The whole picture, with the address rule enforced at the source: addresses
 * are looked up (and cached briefly) ONLY while the agent process is alive
 * and has reported connected. In every other state they are null, whatever
 * the provider would say, because an address on screen is a claim that
 * players can join.
 */
export async function tunnelStatus(deps: TunnelDeps): Promise<TunnelStatus> {
  const base = deps.base ?? dataDir()
  const f = deps.fetchers ?? liveFetchers
  const s = loadState(base)
  const exe = existsSync(agentExePath(base))
  const secret = readSecret(base)

  const state: TunnelAgentStatus['state'] = !exe
    ? 'not-installed'
    : !secret
      ? 'installed'
      : runtime.proc === null
        ? 'claimed'
        : runtime.connected
          ? 'connected'
          : 'starting'

  const detailByState: Record<TunnelAgentStatus['state'], string> = {
    'not-installed': 'No agent binary is installed. Installing downloads it from the playit release and verifies its digest and signature; nothing is executed.',
    installed: 'The agent binary is verified and on disk. No credential exists yet; the claim flow mints one in your playit account.',
    claimed: 'Credential stored, agent not running. Tunnel addresses are hidden while nothing is serving them.',
    starting: runtime.detail,
    connected: runtime.detail,
    disconnected: runtime.detail,
    error: runtime.detail,
  }

  let byId = new Map<string, string>()
  if (state === 'connected' && secret && s.tunnels.length > 0) {
    if (addressCache && Date.now() - addressCache.at < ADDRESS_CACHE_MS) {
      byId = addressCache.byTunnelId
    } else {
      try {
        const rd = unwrap(await f.post(`${PLAYIT_API}/v1/agents/rundata`, PLAYIT_HOSTS, {}, agentKeyHeader(secret)))
        if (rd.ok) {
          const tunnels = (rd.data as { tunnels?: Array<{ id?: string; display_address?: string }> } | null)?.tunnels ?? []
          for (const t of tunnels) {
            if (typeof t.id === 'string' && typeof t.display_address === 'string') byId.set(t.id, t.display_address)
          }
          addressCache = { at: Date.now(), byTunnelId: byId }
        }
      } catch {
        /* no addresses rather than stale ones */
      }
    }
  }

  const tunnels: TunnelEntry[] = s.tunnels.map((t) => ({
    tunnelId: t.tunnelId,
    serverId: t.serverId,
    dir: t.dir,
    localPort: t.localPort,
    address: state === 'connected' ? (byId.get(t.tunnelId) ?? null) : null,
    detail:
      state === 'connected'
        ? byId.get(t.tunnelId)
          ? 'Reachable at the address shown while the agent stays connected.'
          : 'The agent is connected but playit reported no address for this tunnel yet.'
        : 'Not currently served: the agent is not connected, so no address is shown. The server is reachable on the LAN as always.',
  }))

  return {
    agent: {
      state,
      detail: detailByState[state],
      version: s.agentTag,
      secretPresent: secret !== null,
      runConfirmed: s.runConfirmedAt !== null,
    },
    tunnels,
  }
}

/** Test seam. */
export function resetAddressCache(): void {
  addressCache = null
}
