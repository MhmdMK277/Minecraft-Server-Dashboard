/**
 * PROOF: the download allowlist names an AUTHORITY, follows redirects while
 * checking every hop, and would have caught the hostname change that broke the
 * Java download on a user's machine (2026-08-03).
 *
 * The bug: GitHub serves release assets from a CDN host it moves without
 * notice (`objects.githubusercontent.com` became
 * `release-assets.githubusercontent.com`), and the allowlist was an exact-string
 * list, so the Adoptium (Java) download aborted with "host ... is not on the
 * allowlist". The fix is a domain-suffix rule, `.githubusercontent.com`, that
 * says what we meant. This proof pins that it accepts a NOVEL subdomain (so a
 * future move does not break it), rejects the lookalike traps, and that the
 * real redirect-following honours the same rule end to end.
 *
 * Run:  npx tsx scripts/prove-fetchverify.ts
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchVerified, hostAllowed, VerifyError } from '../server/fetchverify'
import { ADOPTIUM_HOSTS } from '../server/javaprovision'
import { GH_ASSET_HOSTS } from '../server/tunnel'

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])

// -------------------------------------------------- 1. the host-match matrix

console.log('--- 1. hostAllowed: authority suffix, on the dot boundary')

const GH = ['github.com', '.githubusercontent.com']
const accept: Array<[string, string[]]> = [
  ['github.com', GH],
  ['objects.githubusercontent.com', GH],
  ['release-assets.githubusercontent.com', GH],
  // The whole point: a subdomain nobody has seen yet is accepted, so the next
  // CDN move does not break the download or this test.
  ['future-assets.githubusercontent.com', GH],
  ['api.github.com', ['api.github.com']],
]
for (const [host, list] of accept) {
  check(`accepts ${host}`, hostAllowed(host, list), JSON.stringify(list))
}

const reject: Array<[string, string[]]> = [
  // Substring lookalikes that a naive endsWith without the dot, or an includes(),
  // would wrongly allow.
  ['githubusercontent.com.evil.com', GH],
  ['evil-githubusercontent.com', GH],
  ['notgithubusercontent.com', GH],
  // The bare registrable domain has no subdomain label and serves nothing.
  ['githubusercontent.com', GH],
  // A completely different authority.
  ['evil.com', GH],
  // Exact rules stay exact: a subdomain of an exact host is not implied.
  ['assets.api.github.com', ['api.github.com']],
]
for (const [host, list] of reject) {
  check(`rejects ${host}`, !hostAllowed(host, list), JSON.stringify(list))
}

// ---------------------------------------- 2. the SHIPPED allowlists (regression)

console.log('\n--- 2. the shipped allowlists survive a GitHub CDN move')

// These two are the only download paths that resolve to a GitHub release. Both
// must accept the host that broke, AND a hypothetical future one; that second
// assertion is the guard that would have caught the 2026-08-03 change.
for (const [name, list] of [['ADOPTIUM_HOSTS (Java)', ADOPTIUM_HOSTS], ['GH_ASSET_HOSTS (playit agent)', GH_ASSET_HOSTS]] as const) {
  check(`${name} accepts the host that broke (release-assets.githubusercontent.com)`,
    hostAllowed('release-assets.githubusercontent.com', list), JSON.stringify(list))
  check(`${name} accepts a FUTURE CDN host, so the next move does not break it`,
    hostAllowed('some-new-cdn.githubusercontent.com', list))
  check(`${name} still rejects a non-GitHub host`,
    !hostAllowed('cdn.evil.com', list))
  check(`${name} rejects the dot-boundary lookalike`,
    !hostAllowed('githubusercontent.com.evil.com', list))
}

// ------------------------------------- 3. redirect-follow end to end (loopback)

console.log('\n--- 3. fetchVerified follows redirects and checks every hop')

const PAYLOAD = Buffer.from('the-verified-bytes-'.repeat(1000))
const DIGEST = createHash('sha256').update(PAYLOAD).digest('hex')
const DEST = join(mkdtempSync(join(tmpdir(), 'ex-fv-')), 'out.bin')

const server = createServer((req, res) => {
  if (req.url === '/redir1') { res.writeHead(302, { location: '/redir2' }); res.end(); return }
  if (req.url === '/redir2') { res.writeHead(302, { location: '/file' }); res.end(); return }
  if (req.url === '/file') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(PAYLOAD); return }
  if (req.url === '/toevil') { res.writeHead(302, { location: 'https://cdn.evil.com/x' }); res.end(); return }
  res.writeHead(404); res.end()
})

async function main() {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const base = `http://127.0.0.1:${port}`

  // A two-hop redirect within the allowed host, then a checksum-verified body.
  try {
    const r = await fetchVerified({ url: `${base}/redir1`, dest: DEST, algo: 'sha256', expected: DIGEST, allowHosts: ['127.0.0.1'] })
    check('a two-hop redirect chain is followed and the file verifies', r.bytes === PAYLOAD.length, `${r.bytes} bytes`)
    check('and the bytes on disk are exactly what was served', readFileSync(DEST).equals(PAYLOAD))
  } catch (e) {
    check('a two-hop redirect chain is followed and the file verifies', false, (e as Error).message)
  }

  // A redirect that leaves the allowed host aborts with kind 'host'.
  try {
    await fetchVerified({ url: `${base}/toevil`, dest: DEST, algo: 'sha256', expected: DIGEST, allowHosts: ['127.0.0.1'] })
    check('a redirect to a disallowed host is refused', false, 'it was NOT refused')
  } catch (e) {
    check('a redirect to a disallowed host is refused', e instanceof VerifyError && e.kind === 'host', (e as Error).message)
  }

  // A wrong checksum deletes the staged file and fails.
  try {
    await fetchVerified({ url: `${base}/file`, dest: DEST, algo: 'sha256', expected: 'deadbeef'.repeat(8), allowHosts: ['127.0.0.1'] })
    check('a checksum mismatch fails', false, 'it did NOT fail')
  } catch (e) {
    check('a checksum mismatch fails with kind checksum', e instanceof VerifyError && e.kind === 'checksum', (e as Error).message)
  }

  server.close()

  console.log('')
  let failed = 0
  for (const [l, ok, d] of checks) {
    if (!ok) failed++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d ? `  (${d})` : ''}`)
  }
  console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}
void main()
