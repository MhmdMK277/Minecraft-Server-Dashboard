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
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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
const extraRoutes = new Map<string, Buffer>()

async function main() {
  fixture = createServer((req, res) => {
    const extra = extraRoutes.get(req.url ?? '')
    if (extra) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(extra)
    } else if (req.url === '/good.jar') {
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

    const { resolveVanilla, resolvePaper, resolveForge, resolveNeoForge, resolveFabric, flavorCatalog, parseSidecar, neoPrefixFor, requiredJavaMajor, requiredJavaMajorLive } =
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

    // The date-based scheme: NeoForge adopted Mojang's versions verbatim, so
    // MC 26.1.2 is 26.1.2.x and plain 26.1 is 26.1.0.x. Stable builds are
    // bare digits; every pre-release carries a dash suffix and is skipped.
    check('neoforge maps MC 26.1.2 to the 26.1.2.x family', neoPrefixFor('26.1.2') === '26.1.2.')
    check('and plain 26.1 to 26.1.0.x', neoPrefixFor('26.1') === '26.1.0.')
    const neoDated = {
      json: async () => ({ versions: ['26.1.2.93', '26.1.2.94', '26.2.0.41-beta', '26.1.0.0-alpha.2+snapshot-1'] }),
      text: async () => 'e'.repeat(128),
    }
    const neoNew = await resolveNeoForge('26.1.2', null, neoDated)
    check('a dated-scheme resolve picks the newest stable, not an alpha or beta', neoNew.url.includes('neoforge-26.1.2.94-installer.jar'))
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

    // Java floor mapping, the number the UI must state. Getting this wrong
    // is not cosmetic: provisioning installs it, and a 26.x server refuses
    // to start on Java 21.
    check(
      'java majors follow Mojang: 1.16=8, 1.17=17, 1.20.4=17, 1.20.5=21, 1.21.4=21, 26.2=25',
      requiredJavaMajor('1.16.5') === 8 &&
        requiredJavaMajor('1.17') === 17 &&
        requiredJavaMajor('1.20.4') === 17 &&
        requiredJavaMajor('1.20.5') === 21 &&
        requiredJavaMajor('1.21.4') === 21 &&
        requiredJavaMajor('26.2') === 25,
    )

    // The live path reads what Mojang declares for the exact version, and
    // falls back to the table when the metadata is silent or unreachable.
    const javaF = {
      json: async (url: string) =>
        url.includes('version_manifest')
          ? { versions: [{ id: '1.21.4', url: 'https://piston-meta.mojang.com/v1/packages/xyz/j.json' }] }
          : { javaVersion: { majorVersion: 99 } },
      text: f.text,
    }
    check('the live java lookup answers with the DECLARED major, not the table', (await requiredJavaMajorLive('1.21.4', javaF)) === 99)
    const deadF = {
      json: async () => {
        throw new Error('offline')
      },
      text: f.text,
    }
    check('and falls back to the table when the publisher is unreachable', (await requiredJavaMajorLive('1.21.4', deadF)) === 21)
  }

  // =========================================================================
  console.log('\n=== 6. no EULA, no creation, and acceptance is audited ===\n')
  // =========================================================================
  const { initAudit } = await import('../server/audit')
  const {
    startCreation, runInstaller, removeFailedCreation, collectTakenPorts, suggestPort,
    generateRconPassword, validateName, jobFor, resetJobs,
  } = await import('../server/creation')

  const AUDIT_DIR = join(ROOT, 'audit')
  mkdirSync(AUDIT_DIR, { recursive: true })
  initAudit(AUDIT_DIR)
  const auditLines = () =>
    existsSync(join(AUDIT_DIR, 'audit.jsonl'))
      ? readFileSync(join(AUDIT_DIR, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { action: string; outcome: string; detail?: string })
      : []

  const PARENT = join(ROOT, 'servers-root')
  mkdirSync(PARENT, { recursive: true })
  // Explicit world for the attach-on-complete path (decision 0010): creation
  // must never resolve the data dir itself, or this proof would write into
  // the operator's real attached.json.
  const FAKE_DATA = join(ROOT, 'data-dir')
  mkdirSync(FAKE_DATA, { recursive: true })
  const DEPS = {
    knownDirs: [] as string[],
    dataDir: FAKE_DATA,
    serversRoot: PARENT,
    actor: 'prover',
    role: 'admin',
    ip: '127.0.0.1',
  }

  // Fixture fetchers that resolve a vanilla download served by our fixture
  // HTTP server, so the whole pipeline runs without the internet.
  const vanillaFx = {
    json: async (url: string) =>
      url.includes('version_manifest')
        ? { versions: [{ id: '1.21.4', type: 'release', url: 'https://piston-meta.mojang.com/v1/x.json' }] }
        : { downloads: { server: { url: `${base}/good.jar`, sha1: createHash('sha1').update(JAR).digest('hex') } } },
    text: async () => {
      throw new Error('unexpected')
    },
  }
  // The download seam runs the REAL fetchVerified against the loopback
  // fixture, so verification stays in the loop.
  const realDownload = (r: { url: string; algo: 'sha1' | 'sha256' | 'sha512'; expected: string }, dest: string) =>
    fetchVerified({ url: r.url, dest, algo: r.algo, expected: r.expected, allowHosts: ['127.0.0.1'] })

  const baseReq = {
    name: 'Proof Vanilla',
    flavor: 'vanilla' as const,
    mcVersion: '1.21.4',
    loaderVersion: null,
    gamePort: 25765,
    rconPort: 25775,
    eulaAccepted: true,
    memoryMb: null,
    java: { mode: 'existing' as const },
    parentDir: PARENT,
  }

  {
    resetJobs()
    const r = await startCreation({ ...baseReq, eulaAccepted: false }, { ...DEPS, fetchers: vanillaFx, download: realDownload })
    check('creation without the EULA is refused', !r.ok && r.reason.includes('EULA'))
    check('the refusal names the real EULA link', !r.ok && r.reason.includes('https://aka.ms/MinecraftEULA'))
    check('and NOTHING was created', !existsSync(join(PARENT, 'Proof Vanilla')))
    check('no acceptance was audited for a refusal', !auditLines().some((l) => l.action === 'create.eula-accepted'))
  }

  // =========================================================================
  console.log('\n=== 7. ports are checked against everything the fleet declares ===\n')
  // =========================================================================
  {
    const other = join(ROOT, 'existing-server')
    mkdirSync(other, { recursive: true })
    writeFileSync(
      join(other, 'server.properties'),
      'server-port=25565\r\nenable-rcon=true\r\nrcon.port=25575\r\nrcon.password=sekrit\r\n',
      'utf8',
    )
    const taken = collectTakenPorts([other])
    check('the port map carries the declared game port', taken.get(25565)?.includes('25565') === true)
    check('and the declared RCON port', taken.get(25575)?.includes('25575') === true)

    const withFleet = { ...DEPS, knownDirs: [other], fetchers: vanillaFx, download: realDownload }
    const r1 = await startCreation({ ...baseReq, gamePort: 25565 }, withFleet)
    check('a game port the fleet declares is refused, naming the holder', !r1.ok && r1.reason.includes('existing-server'))
    const r2 = await startCreation({ ...baseReq, rconPort: 25575 }, withFleet)
    check('an RCON port the fleet declares is refused', !r2.ok && r2.reason.includes('25575'))
    check('a refused creation leaves no folder behind', !existsSync(join(PARENT, 'Proof Vanilla')))

    // A port something is LISTENING on right now, declared by nobody.
    const squatter = createServer(() => {})
    await new Promise<void>((res) => squatter.listen(25999, '0.0.0.0', res))
    const r3 = await startCreation({ ...baseReq, gamePort: 25999 }, withFleet)
    check('a port that is live on the host is refused even if no server declares it', !r3.ok && r3.reason.includes('listening'))
    const suggested = await suggestPort(25565, taken)
    check('the suggested port skips everything declared', suggested !== 25565 && suggested !== 25575 && !taken.has(suggested))
    await new Promise<void>((res) => squatter.close(() => res()))
  }

  // =========================================================================
  console.log('\n=== 8. names cannot traverse and folders are never adopted ===\n')
  // =========================================================================
  {
    check('a name with .. is refused', !validateName('evil..name').ok)
    check('a name with a path separator is refused', !validateName('..\\up').ok && !validateName('a/b').ok)
    check('a reserved device name is refused', !validateName('CON').ok && !validateName('com1.server').ok)
    check('a trailing dot is refused (NTFS strips it silently)', !validateName('server.').ok)
    check('an honest name passes', validateName('MC Proof 1.21').ok)

    const taken2 = join(PARENT, 'Taken Name')
    mkdirSync(taken2, { recursive: true })
    const r = await startCreation({ ...baseReq, name: 'Taken Name' }, { ...DEPS, fetchers: vanillaFx, download: realDownload })
    check('an existing folder is refused, never adopted', !r.ok && r.reason.includes('already exists'))
  }

  // =========================================================================
  console.log('\n=== 9. a full creation: verified, configured, journaled ===\n')
  // =========================================================================
  {
    resetJobs()
    const r = await startCreation(baseReq, { ...DEPS, fetchers: vanillaFx, download: realDownload })
    check('the creation is accepted', r.ok)
    if (r.ok) {
      // The pipeline is async; wait for the terminal state.
      for (let i = 0; i < 100 && !['complete', 'failed'].includes(jobFor(r.opId)?.state ?? ''); i++) {
        await new Promise((res) => setTimeout(res, 50))
      }
      const job = jobFor(r.opId)
      check('the job completes', job?.state === 'complete', job?.error ?? job?.state)
      const dir = join(PARENT, 'Proof Vanilla')
      check('the verified jar is in place', existsSync(join(dir, 'server.jar')))
      const eula = readFileSync(join(dir, 'eula.txt'), 'utf8')
      check('eula.txt says eula=true and cites the real link', eula.includes('eula=true') && eula.includes('https://aka.ms/MinecraftEULA'))
      const props = readFileSync(join(dir, 'server.properties'), 'utf8')
      check('the chosen ports are written', props.includes('server-port=25765') && props.includes('rcon.port=25775'))
      const pw = /rcon\.password=(.*)/.exec(props)?.[1]?.trim() ?? ''
      check('RCON is enabled with a generated password, never blank', props.includes('enable-rcon=true') && pw.length >= 20)
      check('the password appears in no job detail and no audit line', !(job?.detail ?? '').includes(pw) && !auditLines().some((l) => JSON.stringify(l).includes(pw)))
      check('start.bat runs the jar', readFileSync(join(dir, 'start.bat'), 'utf8').includes('server.jar'))
      const journal = JSON.parse(readFileSync(join(dir, '.mcdash-creation.json'), 'utf8')) as { state: string; files: string[] }
      check('the journal is complete and lists every file written', journal.state === 'complete' && ['server.jar', 'eula.txt', 'server.properties', 'start.bat'].every((f2) => journal.files.includes(f2)))
      check('the acceptance was audited', auditLines().some((l) => l.action === 'create.eula-accepted'))
      check('completion was audited', auditLines().some((l) => l.action === 'create.complete'))
    }

    // The provisioned-Java variant: the start script carries the ABSOLUTE
    // path and says so, which is the consequence the operator confirmed.
    const fakeHome = join(ROOT, 'appdata', 'java', 'jdk-21.0.0-jre')
    const r2 = await startCreation(
      { ...baseReq, name: 'Proof Adoptium', gamePort: 25767, rconPort: 25777, java: { mode: 'adoptium' } },
      { ...DEPS, fetchers: vanillaFx, download: realDownload, provision: async (major: number) => ({ javaHome: `${fakeHome}-${major}`, reused: false }) },
    )
    check('the adoptium creation is accepted', r2.ok)
    if (r2.ok) {
      for (let i = 0; i < 100 && !['complete', 'failed'].includes(jobFor(r2.opId)?.state ?? ''); i++) {
        await new Promise((res) => setTimeout(res, 50))
      }
      check('it completes with the provision seam', jobFor(r2.opId)?.state === 'complete', jobFor(r2.opId)?.error ?? '')
      const bat = readFileSync(join(PARENT, 'Proof Adoptium', 'start.bat'), 'utf8')
      check('start.bat carries the absolute provisioned path', bat.includes(`${fakeHome}-21`))
      check('and states the consequence in the script itself', bat.includes('absolute') && bat.includes('breaks this script'))
      check('it asked for the major the version needs (21 for 1.21.4)', bat.includes('jdk-21'))
    }
  }

  // =========================================================================
  console.log('\n=== 10. a failed creation is marked, and removal is scoped ===\n')
  // =========================================================================
  {
    resetJobs()
    const badDownload = async () => {
      throw new Error('checksum mismatch: the staged file was deleted (simulated)')
    }
    const r = await startCreation({ ...baseReq, name: 'Proof Failed' }, { ...DEPS, fetchers: vanillaFx, download: badDownload })
    check('the creation starts', r.ok)
    if (r.ok) {
      for (let i = 0; i < 100 && jobFor(r.opId)?.state !== 'failed'; i++) {
        await new Promise((res) => setTimeout(res, 50))
      }
      const dir = join(PARENT, 'Proof Failed')
      const job = jobFor(r.opId)
      check('the job reports failed with the reason', job?.state === 'failed' && (job.error ?? '').includes('checksum'))
      const journal = JSON.parse(readFileSync(join(dir, '.mcdash-creation.json'), 'utf8')) as { state: string }
      check('the folder is left MARKED as a failed creation', journal.state === 'failed')
      check('the failure was audited', auditLines().some((l) => l.action === 'create.failed'))

      // Removal refuses folders that are not ours.
      const foreign = join(ROOT, 'not-ours')
      mkdirSync(foreign, { recursive: true })
      writeFileSync(join(foreign, 'somebody-elses.txt'), 'x', 'utf8')
      const r1 = removeFailedCreation(foreign, DEPS)
      check('removal refuses a folder without our journal', !r1.ok && r1.reason.includes('did not create'))
      check('and touched nothing in it', existsSync(join(foreign, 'somebody-elses.txt')))

      // Removal refuses a COMPLETE creation: that is a server now.
      const r2 = removeFailedCreation(join(PARENT, 'Proof Vanilla'), DEPS)
      check('removal refuses a completed creation', !r2.ok && r2.reason.includes('server'))

      // A stray file the journal does not list survives removal, named.
      writeFileSync(join(dir, 'operator-notes.txt'), 'do not lose me', 'utf8')
      const r3 = removeFailedCreation(dir, DEPS)
      check('removal with a stray file keeps the folder', r3.ok && 'kept' in r3 && r3.kept.includes('operator-notes.txt'))
      check('the stray file survives', existsSync(join(dir, 'operator-notes.txt')))
      check('the journal survives with it, so the folder stays marked', existsSync(join(dir, '.mcdash-creation.json')))

      // With the stray gone, removal takes exactly the journaled files and
      // then the folder.
      unlinkSync(join(dir, 'operator-notes.txt'))
      const r4 = removeFailedCreation(dir, DEPS)
      check('a clean failed creation is fully removed', r4.ok && !existsSync(dir))
      check('the removal was audited', auditLines().some((l) => l.action === 'create.remove-failed' && l.outcome === 'ok'))
    }
  }

  // =========================================================================
  console.log('\n=== 11. an installer runs only behind its own confirmation ===\n')
  // =========================================================================
  {
    resetJobs()
    const forgeFx = {
      json: async () => ({ promos: { '1.20.1-recommended': '47.3.0' } }),
      text: async () => createHash('sha512').update(JAR).digest('hex'),
    }
    const forgeDownload = (r2: { algo: 'sha1' | 'sha256' | 'sha512'; expected: string }, dest: string) =>
      fetchVerified({ url: `${base}/good.jar`, dest, algo: 'sha512', expected: r2.expected, allowHosts: ['127.0.0.1'] })
    const r = await startCreation(
      { ...baseReq, name: 'Proof Forge', flavor: 'forge', mcVersion: '1.20.1', gamePort: 25865, rconPort: 25875 },
      { ...DEPS, fetchers: forgeFx, download: forgeDownload },
    )
    check('the forge creation starts', r.ok)
    if (r.ok) {
      for (let i = 0; i < 100 && jobFor(r.opId)?.state !== 'awaiting-installer'; i++) {
        await new Promise((res) => setTimeout(res, 50))
      }
      const job = jobFor(r.opId)
      check('it STOPS at awaiting-installer after the verified download', job?.state === 'awaiting-installer')
      check('the pause explains it is about running a downloaded program', (job?.detail ?? '').includes('downloaded program'))

      const deny = await runInstaller(r.opId, false, DEPS)
      check('without the confirmation field the installer does not run', !deny.ok && deny.reason.includes('explicitly confirm'))
      check('the refusal was audited as denied', auditLines().some((l) => l.action === 'create.run-installer' && l.outcome === 'denied'))
      check('the job still awaits the installer', jobFor(r.opId)?.state === 'awaiting-installer')

      const wrongState = await runInstaller('no-such-op', true, DEPS)
      check('an unknown operation is refused', !wrongState.ok)
    }
  }

  // =========================================================================
  console.log('\n=== 12. Adoptium: on demand, one version, verified, consequence stated ===\n')
  // =========================================================================
  {
    const { provisionJava, findProvisioned, CONSEQUENCE_TEXT } = await import('../server/javaprovision')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const pexec = promisify(execFile)

    // A real zip with the Temurin layout, built locally: jdk-21.0.0-jre/bin/java.exe
    const tree = join(ROOT, 'zip-src', 'jdk-21.0.0-jre', 'bin')
    mkdirSync(tree, { recursive: true })
    writeFileSync(join(tree, 'java.exe'), 'not really java, only the layout matters', 'utf8')
    const zipPath = join(ROOT, 'jre.zip')
    await pexec('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path '${join(ROOT, 'zip-src', 'jdk-21.0.0-jre')}' -DestinationPath '${zipPath}' -Force`,
    ], { windowsHide: true })
    const zipBytes = readFileSync(zipPath)
    extraRoutes.set('/jre.zip', zipBytes)

    const APPDATA = join(ROOT, 'appdata')
    let jsonCalls = 0
    const deps = {
      base: APPDATA,
      json: async () => {
        jsonCalls++
        return [{ binary: { package: { name: 'temurin-21-jre.zip', link: `${base}/jre.zip`, checksum: createHash('sha256').update(zipBytes).digest('hex') } } }]
      },
      download: (url: string, dest: string, expected: string) =>
        fetchVerified({ url, dest, algo: 'sha256', expected, allowHosts: ['127.0.0.1'] }),
    }

    const p1 = await provisionJava(21, deps)
    check('the runtime is provisioned and its home found', !p1.reused && existsSync(join(p1.javaHome, 'bin', 'java.exe')))
    check('the home is inside the dashboard data dir, the stated consequence', p1.javaHome.startsWith(join(APPDATA, 'java')))
    check('the staged zip did not accumulate', !existsSync(join(APPDATA, 'java', 'staging', 'temurin-21-jre.zip')))

    const p2 = await provisionJava(21, deps)
    check('a second creation REUSES the runtime', p2.reused && p2.javaHome === p1.javaHome)
    check('reuse fetched nothing', jsonCalls === 1)
    check('findProvisioned sees exactly the one major', findProvisioned(21, APPDATA) === p1.javaHome && findProvisioned(17, APPDATA) === null)

    // Metadata without a checksum is a refusal, same rule as every source.
    const noHash = { ...deps, base: join(ROOT, 'appdata2'), json: async () => [{ binary: { package: { name: 'x.zip', link: `${base}/jre.zip` } } }] }
    let e1: unknown = null
    try {
      await provisionJava(17, noHash)
    } catch (e) {
      e1 = e
    }
    check('adoptium metadata without a checksum is refused', e1 instanceof Error && e1.message.includes('no checksum'))

    // A wrong checksum leaves no zip behind.
    const badHash = { ...deps, base: join(ROOT, 'appdata3'), json: async () => [{ binary: { package: { name: 'bad.zip', link: `${base}/jre.zip`, checksum: 'f'.repeat(64) } } }] }
    let e2: unknown = null
    try {
      await provisionJava(17, badHash)
    } catch (e) {
      e2 = e
    }
    check('a wrong checksum fails the provisioning', e2 instanceof VerifyError && e2.kind === 'checksum')
    check('and leaves no archive staged', !existsSync(join(ROOT, 'appdata3', 'java', 'staging', 'bad.zip')))

    check('the consequence text names the absolute path problem', CONSEQUENCE_TEXT.includes('absolute path') && CONSEQUENCE_TEXT.includes('breaks'))
  }

  // =========================================================================
  console.log('\n=== 13. hostile parents refused; outside the root ends attached ===\n')
  // =========================================================================
  //
  // Decision 0010: the parent folder is an operator pick now, which makes it
  // a request field, and a start button can end up aimed at whatever tree it
  // names. Every hostile shape is refused BEFORE anything touches disk, and
  // the one legitimate non-root shape (a folder elsewhere on the machine)
  // must end ATTACHED, or the created server would be invisible.
  {
    resetJobs()
    const fx = { ...DEPS, fetchers: vanillaFx, download: realDownload }
    const tryParent = (parentDir: string) =>
      startCreation({ ...baseReq, name: 'Parent Proof', parentDir }, fx)

    const r1 = await tryParent(join(ROOT, 'no-such-parent'))
    check('a parent that does not exist is refused', !r1.ok && r1.reason.includes('does not exist'))

    const filePath = join(ROOT, 'a-file.txt')
    writeFileSync(filePath, 'x', 'utf8')
    const r2 = await tryParent(filePath)
    check('a parent that is a file, not a folder, is refused', !r2.ok && r2.reason.includes('does not exist'))

    const r3 = await tryParent(FAKE_DATA)
    check("the dashboard's own data directory is refused", !r3.ok && r3.reason.includes('data directory'))
    const insideData = join(FAKE_DATA, 'nested')
    mkdirSync(insideData, { recursive: true })
    const r4 = await tryParent(insideData)
    check('a folder inside the data directory is refused', !r4.ok && r4.reason.includes('data directory'))
    // The other direction must stay ALLOWED: a home folder contains
    // %APPDATA%, and refusing it would refuse the most ordinary real pick.
    // The fetchers fail fast so acceptance is proven without a download.
    const offline = {
      json: async () => {
        throw new Error('offline by design')
      },
      text: async () => {
        throw new Error('offline by design')
      },
    }
    const r5 = await startCreation({ ...baseReq, name: 'Home Like', parentDir: ROOT }, { ...DEPS, fetchers: offline })
    check('a folder that merely CONTAINS the data directory is accepted', r5.ok === true, r5.ok ? undefined : r5.reason)

    const nested = join(PARENT, 'Nested Level')
    mkdirSync(nested, { recursive: true })
    const r6 = await tryParent(nested)
    check(
      'nested inside the servers root is refused: discovery lists only direct children and attach refuses inside-root, so the server would be invisible to both',
      !r6.ok && r6.reason.includes('inside the servers root'),
      r6.ok ? 'accepted' : r6.reason,
    )

    const serverParent = join(ROOT, 'is-a-server')
    mkdirSync(serverParent, { recursive: true })
    writeFileSync(join(serverParent, 'server.properties'), 'server-port=25640\r\n', 'utf8')
    const r7 = await tryParent(serverParent)
    check('a parent that is itself a server folder is refused, naming the file', !r7.ok && r7.reason.includes('server.properties'))
    const insideServer = join(serverParent, 'plugins')
    mkdirSync(insideServer, { recursive: true })
    const r8 = await tryParent(insideServer)
    check('a parent anywhere inside a server folder is refused', !r8.ok && r8.reason.includes('server.properties'))

    check(
      'no refusal created a folder anywhere',
      [join(ROOT, 'no-such-parent'), FAKE_DATA, insideData, ROOT, nested, serverParent, insideServer].every(
        (p) => !existsSync(join(p, 'Parent Proof')),
      ),
    )

    // The legitimate case: a folder outside the servers root, end to end.
    const OUTSIDE = join(ROOT, 'another-drive')
    mkdirSync(OUTSIDE, { recursive: true })
    const ok = await startCreation(
      { ...baseReq, name: 'Outside Root', gamePort: 25965, rconPort: 25975, parentDir: OUTSIDE },
      fx,
    )
    check('a folder outside the servers root is accepted', ok.ok, ok.ok ? undefined : ok.reason)
    if (ok.ok) {
      for (let i = 0; i < 100 && !['complete', 'failed'].includes(jobFor(ok.opId)?.state ?? ''); i++) {
        await new Promise((res) => setTimeout(res, 50))
      }
      const job = jobFor(ok.opId)
      check('the outside-root creation completes', job?.state === 'complete', job?.error ?? job?.state)

      const attachedFile = join(FAKE_DATA, 'attached.json')
      const reg = existsSync(attachedFile)
        ? (JSON.parse(readFileSync(attachedFile, 'utf8')) as { attached: Array<{ dir: string; confirmedLaunch: { strategy: string; script?: string } | null }> })
        : { attached: [] }
      const entry = reg.attached.find((a) => a.dir.toLowerCase() === join(OUTSIDE, 'Outside Root').toLowerCase())
      check('and ends ATTACHED: attached.json lists the new folder', !!entry)
      check(
        'with the journaled start.bat as the confirmed launcher, so the row carries the normal start path',
        entry?.confirmedLaunch?.strategy === 'script' && entry?.confirmedLaunch?.script === 'start.bat',
      )
      check('the job detail states the attach and what detaching does', /attached/.test(job?.detail ?? '') && /[Dd]etach/.test(job?.detail ?? ''))
      check('the attach was audited', auditLines().some((l) => l.action === 'create.attach' && l.outcome === 'ok'))
      check(
        'creations INSIDE the servers root did not attach anything',
        !reg.attached.some((a) => a.dir.toLowerCase().startsWith(PARENT.toLowerCase() + '\\')),
      )
    }
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
