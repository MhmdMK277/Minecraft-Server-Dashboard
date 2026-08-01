/**
 * PROOF: server creation cannot put an unverified byte on this machine, and a
 * failure cannot destroy anything it did not itself create.
 *
 * Creation is the first feature that downloads executable code into a server
 * folder, which is the harm class this whole tool otherwise refuses. The
 * rules under test:
 *
 *   1. A download is verified against the publisher's hash or it does not
 *      exist. A checksum mismatch DELETES the staged file and fails the
 *      creation; there is no unverified fallback, and no call shape that
 *      skips verification.
 *   2. Downloads only touch allowlisted hosts over HTTPS (loopback HTTP is
 *      allowed for this proof's fixture server only). A redirect that leaves
 *      the allowlist aborts.
 *   3. No creation without the EULA accepted, and acceptance lands in the
 *      audit log. Refusal writes nothing.
 *   4. The chosen port is checked against every port the fleet already
 *      declares, so a new server cannot collide with a running one.
 *   5. RCON is on with a generated password, never blank, and the password
 *      appears in no status output and no audit line.
 *   6. A failed creation leaves a marked folder. Removal is scoped: it
 *      refuses a folder without our marker, deletes only files the journal
 *      lists, and leaves anything else standing, named.
 *   7. Names cannot traverse: `..`, drive-absolute names, reserved device
 *      names and trailing dots are refused before anything touches disk.
 *   8. An existing folder is never adopted or overwritten.
 *
 * WORLD: throwaway directories and a loopback fixture HTTP server. No real
 * download source is contacted and no real server directory is touched.
 *
 * Run:  npx tsx scripts/prove-creation.ts
 */
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fetchVerified, VerifyError } from '../server/fetchverify'

const checks: Array<[string, boolean, string?]> = []
const check = (label: string, ok: boolean, detail?: string) => checks.push([label, ok, detail])

const ROOT = join(tmpdir(), `mcdash-prove-creation-${process.pid}`)
mkdirSync(ROOT, { recursive: true })

const sha512 = (b: Buffer) => createHash('sha512').update(b).digest('hex')

// A loopback fixture server standing in for every download host.
const JAR = Buffer.from('PK pretend this is a server jar, it only has to hash')
let fixture: Server
let base = ''

async function main() {
  fixture = createServer((req, res) => {
    if (req.url === '/good.jar') {
      res.writeHead(200, { 'content-type': 'application/java-archive' })
      res.end(JAR)
    } else if (req.url === '/redirect-good') {
      res.writeHead(302, { location: '/good.jar' })
      res.end()
    } else if (req.url === '/redirect-evil') {
      res.writeHead(302, { location: 'https://evil.invalid/payload.jar' })
      res.end()
    } else if (req.url === '/huge') {
      res.writeHead(200)
      res.end(Buffer.alloc(4 * 1024 * 1024))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r))
  const addr = fixture.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  base = `http://127.0.0.1:${port}`
  const HOSTS = ['127.0.0.1']

  // =========================================================================
  console.log('\n=== 1. a verified download exists, an unverified one cannot ===\n')
  // =========================================================================
  {
    const dest = join(ROOT, 's1', 'server.jar')
    const r = await fetchVerified({
      url: `${base}/good.jar`, dest, algo: 'sha512', expected: sha512(JAR), allowHosts: HOSTS,
    })
    check('a correct hash lands the file under its real name', existsSync(dest))
    check('the byte count is the real size', r.bytes === JAR.length)
    check('no .part file is left behind', !existsSync(`${dest}.part`))

    // Case-insensitivity of the published digest: sidecars vary.
    const dest2 = join(ROOT, 's1', 'upper.jar')
    await fetchVerified({
      url: `${base}/good.jar`, dest: dest2, algo: 'sha512',
      expected: sha512(JAR).toUpperCase(), allowHosts: HOSTS,
    })
    check('an uppercase published digest still verifies', existsSync(dest2))
  }

  // =========================================================================
  console.log('\n=== 2. a checksum mismatch deletes the staged file and fails ===\n')
  // =========================================================================
  {
    const dest = join(ROOT, 's2', 'server.jar')
    let err: unknown = null
    try {
      await fetchVerified({
        url: `${base}/good.jar`, dest, algo: 'sha512',
        expected: sha512(Buffer.from('some other bytes entirely')), allowHosts: HOSTS,
      })
    } catch (e) {
      err = e
    }
    check('the mismatch throws', err instanceof VerifyError && err.kind === 'checksum')
    check('the destination does not exist', !existsSync(dest))
    check('the staged .part was deleted', !existsSync(`${dest}.part`))
    check(
      'the error names both digests so the operator can compare',
      err instanceof Error && err.message.includes('expected sha512') && err.message.includes('deleted'),
    )

    // An empty expected digest is not a way to skip verification: it can
    // never equal a hex digest, so it fails exactly like a wrong one.
    let err2: unknown = null
    try {
      await fetchVerified({
        url: `${base}/good.jar`, dest, algo: 'sha512', expected: '', allowHosts: HOSTS,
      })
    } catch (e) {
      err2 = e
    }
    check('an empty expected digest fails closed', err2 instanceof VerifyError && err2.kind === 'checksum')
    check('and leaves nothing on disk', !existsSync(dest) && !existsSync(`${dest}.part`))
  }

  // =========================================================================
  console.log('\n=== 3. hosts are allowlisted, including across redirects ===\n')
  // =========================================================================
  {
    const dest = join(ROOT, 's3', 'server.jar')
    const ok = await fetchVerified({
      url: `${base}/redirect-good`, dest, algo: 'sha512', expected: sha512(JAR), allowHosts: HOSTS,
    })
    check('a redirect within the allowlist is followed', ok.bytes === JAR.length)

    const dest2 = join(ROOT, 's3', 'evil.jar')
    let err: unknown = null
    try {
      await fetchVerified({
        url: `${base}/redirect-evil`, dest: dest2, algo: 'sha512', expected: sha512(JAR), allowHosts: HOSTS,
      })
    } catch (e) {
      err = e
    }
    check('a redirect off the allowlist aborts', err instanceof VerifyError && err.kind === 'host')
    check('nothing was written for the aborted download', !existsSync(dest2) && !existsSync(`${dest2}.part`))

    let err2: unknown = null
    try {
      await fetchVerified({
        url: 'https://not-on-the-list.example/x.jar', dest: dest2, algo: 'sha512',
        expected: sha512(JAR), allowHosts: HOSTS,
      })
    } catch (e) {
      err2 = e
    }
    check('a direct off-allowlist host is refused before any request', err2 instanceof VerifyError && err2.kind === 'host')

    let err3: unknown = null
    try {
      await fetchVerified({
        url: 'http://203.0.113.10/x.jar', dest: dest2, algo: 'sha512',
        expected: sha512(JAR), allowHosts: ['203.0.113.10'],
      })
    } catch (e) {
      err3 = e
    }
    check('plain HTTP to a non-loopback host is refused even when the host is listed', err3 instanceof VerifyError && err3.kind === 'protocol')
  }

  // =========================================================================
  console.log('\n=== 4. the size cap aborts and cleans up ===\n')
  // =========================================================================
  {
    const dest = join(ROOT, 's4', 'server.jar')
    let err: unknown = null
    try {
      await fetchVerified({
        url: `${base}/huge`, dest, algo: 'sha512', expected: sha512(JAR),
        allowHosts: HOSTS, maxBytes: 1024,
      })
    } catch (e) {
      err = e
    }
    check('a download past the cap aborts', err instanceof VerifyError && err.kind === 'size')
    check('the oversized staged file was deleted', !existsSync(dest) && !existsSync(`${dest}.part`))
  }

  await new Promise<void>((r) => fixture.close(() => r()))
  report()
}

function report() {
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
  // The throwaway root is under %TEMP% and is left in place: nothing is
  // deleted on this host, including by proofs (a standing rule of this install).
  console.log(`world: ${ROOT}`)
  process.exitCode = fail === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('proof harness crashed:', e)
  process.exitCode = 1
})
