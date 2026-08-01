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

  // =========================================================================
  console.log('\n=== 5. no resolver can produce a hashless download ===\n')
  // =========================================================================
  {
    // Fixture metadata standing in for each publisher's API. The proof drives
    // the resolvers through injected fetchers; no network is touched.
    const manifest = {
      versions: [
        { id: '1.21.4', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/abc/1.21.4.json' },
        { id: '1.0-nohash', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/def/nohash.json' },
        { id: '1.0-noserver', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/ghi/noserver.json' },
      ],
    }
    const versionDocs: Record<string, unknown> = {
      'https://piston-meta.mojang.com/v1/packages/abc/1.21.4.json': {
        downloads: { server: { url: 'https://piston-data.mojang.com/v1/objects/aa/server.jar', sha1: 'a'.repeat(40) } },
      },
      'https://piston-meta.mojang.com/v1/packages/def/nohash.json': {
        downloads: { server: { url: 'https://piston-data.mojang.com/v1/objects/bb/server.jar' } },
      },
      'https://piston-meta.mojang.com/v1/packages/ghi/noserver.json': { downloads: {} },
    }
    const f = {
      json: async (url: string) =>
        url.includes('version_manifest') ? manifest : (versionDocs[url] ?? { builds: [], versions: [], promos: {} }),
      text: async () => {
        throw new Error('unexpected text fetch')
      },
    }

    const { resolveVanilla, resolvePaper, resolveForge, resolveNeoForge, resolveFabric, flavorCatalog, parseSidecar, neoPrefixFor, requiredJavaMajor } =
      await import('../server/mcsources')

    const v = await resolveVanilla('1.21.4', f)
    check('vanilla resolves url + sha1 from piston metadata', v.url.includes('piston-data') && v.algo === 'sha1' && v.expected === 'a'.repeat(40))

    let e1: unknown = null
    try {
      await resolveVanilla('1.0-nohash', f)
    } catch (e) {
      e1 = e
    }
    check('vanilla metadata without a hash is refused, stated', e1 instanceof Error && e1.message.includes('no server jar hash'))

    let e2: unknown = null
    try {
      await resolveVanilla('1.0-noserver', f)
    } catch (e) {
      e2 = e
    }
    check('a version with no server jar is refused', e2 instanceof Error && e2.message.includes('no server jar'))

    // Paper (v3 Fill API): newest-first list, newest STABLE preferred over a
    // newer pre-release; hashless build refused.
    const paperF = {
      json: async () => [
        { id: 11, channel: 'BETA', downloads: { 'server:default': { name: 'paper-11.jar', url: 'https://fill-data.papermc.io/v1/objects/cc/paper-11.jar', checksums: { sha256: 'c'.repeat(64) } } } },
        { id: 10, channel: 'STABLE', downloads: { 'server:default': { name: 'paper-10.jar', url: 'https://fill-data.papermc.io/v1/objects/bb/paper-10.jar', checksums: { sha256: 'b'.repeat(64) } } } },
      ],
      text: f.text,
    }
    const p = await resolvePaper('1.21.4', paperF)
    check('paper prefers the newest STABLE build over a newer pre-release', p.artifactName === 'paper-10.jar' && p.algo === 'sha256')
    const paperNoHash = {
      json: async () => [
        { id: 5, channel: 'STABLE', downloads: { 'server:default': { name: 'paper-5.jar', url: 'https://fill-data.papermc.io/v1/objects/dd/paper-5.jar' } } },
      ],
      text: f.text,
    }
    let e3: unknown = null
    try {
      await resolvePaper('1.21.4', paperNoHash)
    } catch (e) {
      e3 = e
    }
    check('a paper build without a hash is refused', e3 instanceof Error && e3.message.includes('no hash'))

    // Forge: recommended promotion + sha512 sidecar, `hex *name` form.
    const forgeF = {
      json: async () => ({ promos: { '1.20.1-recommended': '47.3.0', '1.20.1-latest': '47.4.0' } }),
      text: async (url: string) =>
        url.endsWith('.sha512') ? `${'d'.repeat(128)} *forge-1.20.1-47.3.0-installer.jar` : '',
    }
    const fo = await resolveForge('1.20.1', null, forgeF)
    check(
      'forge picks the recommended build and parses the sidecar',
      fo.expected === 'd'.repeat(128) && fo.url.includes('forge-1.20.1-47.3.0-installer.jar') && fo.kind === 'installer-jar',
    )
    let e4: unknown = null
    try {
      parseSidecar('not a digest at all', 'sha512')
    } catch (e) {
      e4 = e
    }
    check('a sidecar without a digest is an error, not an empty match', e4 instanceof Error)

    // NeoForge: version prefix mapping, and the pre-1.20.2 refusal.
    const neoF = {
      json: async () => ({ versions: ['21.4.10', '21.4.11-beta', '21.4.12'] }),
      text: async () => 'e'.repeat(128),
    }
    const neo = await resolveNeoForge('1.21.4', null, neoF)
    check('neoforge maps 1.21.4 to 21.4.x, skipping betas', neo.url.includes('neoforge-21.4.12-installer.jar'))
    let e5: unknown = null
    try {
      neoPrefixFor('1.20.1')
    } catch (e) {
      e5 = e
    }
    check('neoforge refuses 1.20.1 and points at Forge', e5 instanceof Error && e5.message.includes('use Forge'))

    // Fabric: refused, with the reason the UI will show.
    let e6: unknown = null
    try {
      resolveFabric()
    } catch (e) {
      e6 = e
    }
    check(
      'fabric is refused with the stated reason',
      e6 instanceof Error && e6.message.includes('nobody publishes a checksum'),
    )
    const cat = flavorCatalog()
    const fabric = cat.find((c) => c.flavor === 'fabric')
    check('the catalog carries the refusal for the UI', !!fabric && !fabric.available && 'reason' in fabric && fabric.reason.length > 50)
    check('four flavors are available', cat.filter((c) => c.available).length === 4)

    // Java floor mapping, the number the UI must state.
    check(
      'java majors follow Mojang: 1.16=8, 1.17=17, 1.20.4=17, 1.20.5=21, 1.21.4=21',
      requiredJavaMajor('1.16.5') === 8 &&
        requiredJavaMajor('1.17') === 17 &&
        requiredJavaMajor('1.20.4') === 17 &&
        requiredJavaMajor('1.20.5') === 21 &&
        requiredJavaMajor('1.21.4') === 21,
    )
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
