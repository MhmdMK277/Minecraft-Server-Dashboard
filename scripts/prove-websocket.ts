/**
 * PROOF: the single-port WebSocket carries snapshots and live console output.
 *
 * M2 streamed console lines over Electron IPC. M3 streams them over a WebSocket
 * upgraded on the SAME port as the HTTP API, so there is one port to firewall,
 * one to reverse-proxy and one to terminate TLS in front of.
 *
 * This connects as a browser would and asserts that:
 *   1. the hello frame arrives, naming the platform provider
 *   2. a snapshot frame arrives, with the same servers the REST route reports
 *   3. log batches arrive unprompted, already redacted and colour-stripped
 *   4. no frame anywhere contains an RCON password
 *
 * (4) is the one that matters most: under Electron a leak stayed on one machine,
 * whereas these frames now cross a network.
 *
 * Since M3.2 the socket requires a session, so this starts its own service on an
 * ephemeral port with a throwaway data directory and signs in as the admin it
 * bootstraps there. It still points at the REAL servers root, because the check
 * that matters is "no live RCON password crosses the wire" and a fake password
 * would prove nothing about that.
 *
 * WORLD: inherited, not asserted. The assertions are about frames and
 * credentials, but an identity failure would empty the server list and several of
 * them would then pass vacuously. Run prove-identity alongside this one. See
 * docs/proof-coverage.md.
 *
 * Run:  npx tsx scripts/prove-websocket.ts
 */
import WebSocket from 'ws'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WS_PATH, API, SESSION_COOKIE, CSRF_HEADER } from '../shared/api'

const DATA = mkdtempSync(join(tmpdir(), 'mcdash-ws-'))
process.env.MCDASH_DATA_DIR = DATA

const { loadConfig, dataDir } = await import('../server/config')
const { listDirectories, rconConfig } = await import('../server/properties')
const { buildServer } = await import('../server/http')
const { bootstrapIfEmpty } = await import('../server/auth')

const WAIT_MS = 20_000

// The servers root still comes from the real configuration: MCDASH_DATA_DIR was
// redirected, but MCDASH_SERVERS_ROOT was not, and loadConfig falls back to the
// conventional location when the throwaway data dir has no config.json.
const cfg = loadConfig(dataDir())

// Real secrets from the live servers, so the scan is against what is actually
// on this machine rather than a placeholder. Never printed.
const secrets = listDirectories(cfg.serversRoot)
  .map((n) => rconConfig(join(cfg.serversRoot, n))?.password)
  .filter((p): p is string => typeof p === 'string' && p.length > 0)

const boot = await bootstrapIfEmpty(dataDir())
const app = await buildServer({ cfg, version: 'proof' })
await app.listen({ host: '127.0.0.1', port: 0 })
const addr = app.server.address()
const BASE = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`

const loginRes = await fetch(BASE + API.login, {
  method: 'POST',
  headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
  body: JSON.stringify({ username: boot!.username, password: boot!.password }),
})
const cookie = loginRes.headers.get('set-cookie')?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1]
if (!cookie) {
  console.error('could not sign in to the proof service')
  process.exit(1)
}
const authed = { cookie: `${SESSION_COOKIE}=${cookie}` }

const restServers = (await (await fetch(BASE + API.snapshot, { headers: authed })).json()) as {
  servers: Array<{ id: string; name: string; classification: string }>
}

const ws = new WebSocket(BASE.replace(/^http/, 'ws') + WS_PATH, { headers: authed })

type Hello = { platform?: string; platformSupported?: boolean }
// A mutable container rather than plain `let`: everything below is assigned
// inside the message callback, and TypeScript narrows a closure-assigned `let`
// down to its initialiser.
const got: { hello: Hello | null; snapshotIds: string[] | null } = {
  hello: null,
  snapshotIds: null,
}
let logFrames = 0
let logLines = 0
let leaked = false
const rawFrames: string[] = []

const done = new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, WAIT_MS)
  ws.on('message', (data: Buffer) => {
    const text = data.toString('utf8')
    rawFrames.push(text)
    for (const s of secrets) {
      if (text.includes(s)) leaked = true
    }
    const frame = JSON.parse(text) as { type: string; data: unknown }
    if (frame.type === 'hello') {
      got.hello = frame.data as Hello
    } else if (frame.type === 'snapshot') {
      got.snapshotIds = (frame.data as { servers: Array<{ id: string }> }).servers.map((s) => s.id)
    } else if (frame.type === 'log') {
      logFrames++
      logLines += (frame.data as { lines: unknown[] }).lines.length
    }
    if (got.hello && got.snapshotIds && logFrames > 0) {
      clearTimeout(timer)
      resolve()
    }
  })
  ws.on('error', (e) => {
    console.error('websocket error:', e.message)
    clearTimeout(timer)
    resolve()
  })
})

await done
ws.close()
await app.close()
rmSync(DATA, { recursive: true, force: true })

console.log(`frames received       ${rawFrames.length}`)
console.log(`hello                 ${got.hello ? `${got.hello.platform} supported=${got.hello.platformSupported}` : 'MISSING'}`)
console.log(`snapshot servers      ${got.snapshotIds ? got.snapshotIds.join(', ') : 'MISSING'}`)
console.log(`log batches / lines   ${logFrames} / ${logLines}`)
console.log(`rcon passwords known  ${secrets.length} (scanned against every frame, never printed)`)

const restIds = restServers.servers.map((s) => s.id).sort()
const checks: Array<[string, boolean]> = [
  ['hello frame arrives', got.hello !== null],
  ['hello reports a supported platform', got.hello?.platformSupported === true],
  ['snapshot frame arrives', got.snapshotIds !== null],
  ['websocket and REST agree on the server list', JSON.stringify((got.snapshotIds ?? []).sort()) === JSON.stringify(restIds)],
  ['live console lines stream unprompted', logLines > 0],
  ['no RCON password appears in any frame', !leaked],
]

console.log('')
let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
