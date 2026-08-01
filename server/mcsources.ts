import { fetchJson, fetchText, type HashAlgo } from './fetchverify'

/**
 * Where server software comes from, and which sources are allowed to exist.
 *
 * Every resolver here produces a `ResolvedDownload`, and that type REQUIRES
 * the publisher's digest. A source whose metadata carries no hash cannot
 * produce one, which is how "no unverified fallback, ever" is a property of
 * the types rather than of handlers being careful. The research behind each
 * source was measured on 2026-08-01:
 *
 *   - **Vanilla**: piston-meta version manifest -> version JSON ->
 *     `downloads.server` with a SHA-1. Mojang's own hash, same origin.
 *   - **Paper**: the v2 builds API carries a SHA-256 per artifact.
 *   - **Forge / NeoForge**: both publish `.sha512` sidecars next to the
 *     installer on the same maven host over HTTPS; both were verified against
 *     real downloads. What we fetch is an INSTALLER, a program, and running
 *     it is a separate, separately-confirmed step (creation.ts).
 *   - **Fabric is refused.** `meta.fabricmc.net/.../server/jar` is generated
 *     per request and has no published hash; byte-stability across fetches is
 *     trust-on-first-use, not verification. The refusal and its reason are
 *     part of the catalog so the UI states it rather than omitting the
 *     option. The way in, if ever revisited: the maven installer jar
 *     (`maven.fabricmc.net/.../fabric-installer-*.jar`) DOES carry sidecars.
 */

export type Flavor = 'vanilla' | 'paper' | 'forge' | 'neoforge' | 'fabric'

export type FlavorInfo =
  | { flavor: Exclude<Flavor, 'fabric'>; available: true; label: string; kind: 'server-jar' | 'installer-jar' }
  | { flavor: 'fabric'; available: false; label: string; reason: string }

export function flavorCatalog(): FlavorInfo[] {
  return [
    { flavor: 'vanilla', available: true, label: 'Vanilla', kind: 'server-jar' },
    { flavor: 'paper', available: true, label: 'Paper', kind: 'server-jar' },
    { flavor: 'forge', available: true, label: 'Forge', kind: 'installer-jar' },
    { flavor: 'neoforge', available: true, label: 'NeoForge', kind: 'installer-jar' },
    {
      flavor: 'fabric',
      available: false,
      label: 'Fabric',
      reason:
        'Fabric is not offered yet. Its server jar is generated per request and nobody publishes a checksum for it, and a file that merely comes out the same twice is not a verified file. This dashboard does not download what it cannot verify.',
    },
  ]
}

export type ResolvedDownload = {
  flavor: Flavor
  mcVersion: string
  /** File name the artifact will be saved under, from the publisher. */
  artifactName: string
  url: string
  algo: HashAlgo
  expected: string
  allowHosts: string[]
  kind: 'server-jar' | 'installer-jar'
  /** Anything the operator should see next to the choice (build, channel). */
  note?: string
}

/** Injectable fetchers so the proof can drive resolvers without a network. */
export type Fetchers = {
  json: (url: string, allowHosts: string[]) => Promise<unknown>
  text: (url: string, allowHosts: string[]) => Promise<string>
}
const live: Fetchers = { json: fetchJson, text: fetchText }

// ----------------------------------------------------------------- vanilla

const PISTON_HOSTS = ['piston-meta.mojang.com', 'piston-data.mojang.com', 'launchermeta.mojang.com', 'launcher.mojang.com']
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

export async function listVanillaVersions(f: Fetchers = live): Promise<string[]> {
  const m = (await f.json(MANIFEST_URL, PISTON_HOSTS)) as {
    versions?: Array<{ id?: string; type?: string }>
  }
  return (m.versions ?? []).filter((v) => v.type === 'release' && v.id).map((v) => v.id as string)
}

export async function resolveVanilla(mcVersion: string, f: Fetchers = live): Promise<ResolvedDownload> {
  const m = (await f.json(MANIFEST_URL, PISTON_HOSTS)) as {
    versions?: Array<{ id?: string; url?: string }>
  }
  const entry = (m.versions ?? []).find((v) => v.id === mcVersion)
  if (!entry?.url) throw new Error(`Mojang's manifest has no version ${mcVersion}.`)
  const detail = (await f.json(entry.url, PISTON_HOSTS)) as {
    downloads?: { server?: { url?: string; sha1?: string } }
  }
  const server = detail.downloads?.server
  if (!server?.url) {
    throw new Error(`Mojang publishes no server jar for ${mcVersion}. Very old versions never had one.`)
  }
  if (!server.sha1) {
    // Belt to the type's braces: no hash, no download, stated out loud.
    throw new Error(`Mojang's metadata for ${mcVersion} carries no server jar hash, so it will not be downloaded.`)
  }
  return {
    flavor: 'vanilla',
    mcVersion,
    artifactName: 'server.jar',
    url: server.url,
    algo: 'sha1',
    expected: server.sha1,
    allowHosts: PISTON_HOSTS,
    kind: 'server-jar',
  }
}

// ------------------------------------------------------------------- paper

/**
 * Paper moved from the v2 API (api.papermc.io, now HTTP 410 Gone -- measured
 * 2026-08-01) to the v3 "Fill" API. v3 serves the download URL itself, from
 * fill-data.papermc.io, with a SHA-256 per artifact.
 */
const PAPER_HOSTS = ['fill.papermc.io', 'fill-data.papermc.io']

type PaperBuild = {
  id?: number
  channel?: string
  downloads?: Record<string, { name?: string; url?: string; checksums?: { sha256?: string } }>
}

export async function listPaperVersions(f: Fetchers = live): Promise<string[]> {
  const m = (await f.json('https://fill.papermc.io/v3/projects/paper', PAPER_HOSTS)) as {
    versions?: Record<string, string[]>
  }
  return Object.values(m.versions ?? {}).flat()
}

export async function resolvePaper(mcVersion: string, f: Fetchers = live): Promise<ResolvedDownload> {
  const builds = (await f.json(
    `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(mcVersion)}/builds`,
    PAPER_HOSTS,
  )) as PaperBuild[]
  if (!Array.isArray(builds) || builds.length === 0) throw new Error(`Paper has no builds for ${mcVersion}.`)
  // The list arrives newest first. Prefer the newest STABLE build; if Paper
  // has only pre-release channels for this version the operator gets that
  // fact stated, not a silent substitution.
  const pick = builds.find((b) => b.channel === 'STABLE') ?? builds[0]!
  const app = pick.downloads?.['server:default']
  if (!app?.name || !app.url) throw new Error(`Paper build ${pick.id} for ${mcVersion} names no artifact.`)
  if (!app.checksums?.sha256) {
    throw new Error(`Paper build ${pick.id} for ${mcVersion} carries no hash, so it will not be downloaded.`)
  }
  return {
    flavor: 'paper',
    mcVersion,
    artifactName: app.name,
    url: app.url,
    algo: 'sha256',
    expected: app.checksums.sha256,
    allowHosts: PAPER_HOSTS,
    kind: 'server-jar',
    note:
      pick.channel === 'STABLE'
        ? `build ${pick.id}`
        : `build ${pick.id}, which Paper marks ${pick.channel ?? 'unstable'}: no stable build exists for ${mcVersion} yet`,
  }
}

// ------------------------------------------------------------------- forge

const FORGE_HOSTS = ['files.minecraftforge.net', 'maven.minecraftforge.net']

/**
 * A `.sha512` sidecar is either bare hex or `hex *filename` (or `hex  file`).
 * Anything that does not start with a plausible hex digest is an error, not
 * an empty string that would then fail verification confusingly.
 */
export function parseSidecar(text: string, algo: HashAlgo): string {
  const first = text.trim().split(/[\s*]+/)[0] ?? ''
  const len = { sha1: 40, sha256: 64, sha512: 128 }[algo]
  if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(first)) {
    throw new Error(`the checksum sidecar does not contain a ${algo} digest`)
  }
  return first.toLowerCase()
}

export async function listForgeVersions(f: Fetchers = live): Promise<Record<string, string>> {
  const m = (await f.json(
    'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
    FORGE_HOSTS,
  )) as { promos?: Record<string, string> }
  return m.promos ?? {}
}

export async function resolveForge(mcVersion: string, forgeVersion: string | null, f: Fetchers = live): Promise<ResolvedDownload> {
  let fv = forgeVersion
  let note: string
  if (!fv) {
    const promos = await listForgeVersions(f)
    fv = promos[`${mcVersion}-recommended`] ?? promos[`${mcVersion}-latest`] ?? null
    if (!fv) throw new Error(`Forge publishes no build for ${mcVersion}.`)
    note = promos[`${mcVersion}-recommended`]
      ? `Forge ${fv}, their recommended build for ${mcVersion}`
      : `Forge ${fv}, their latest build for ${mcVersion}; no recommended build exists`
  } else {
    note = `Forge ${fv}`
  }
  const name = `forge-${mcVersion}-${fv}-installer.jar`
  const base = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${fv}/${name}`
  const expected = parseSidecar(await f.text(`${base}.sha512`, FORGE_HOSTS), 'sha512')
  return {
    flavor: 'forge',
    mcVersion,
    artifactName: name,
    url: base,
    algo: 'sha512',
    expected,
    allowHosts: FORGE_HOSTS,
    kind: 'installer-jar',
    note,
  }
}

// ---------------------------------------------------------------- neoforge

const NEOFORGE_HOSTS = ['maven.neoforged.net']

/**
 * NeoForge version numbers track Minecraft's minor and patch: 21.4.x is for
 * 1.21.4. Versions for 1.20.1 lived under a different artifact with Forge
 * numbering, so anything below 1.20.2 is refused rather than guessed at.
 */
export function neoPrefixFor(mcVersion: string): string {
  const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(mcVersion)
  if (!m) throw new Error(`${mcVersion} is not a Minecraft version NeoForge covers.`)
  const minor = Number(m[1])
  const patch = Number(m[2] ?? 0)
  if (minor < 20 || (minor === 20 && patch < 2)) {
    throw new Error(
      `NeoForge supports 1.20.2 and newer. For ${mcVersion} use Forge, which this dashboard also offers.`,
    )
  }
  return `${minor}.${patch}.`
}

export async function resolveNeoForge(mcVersion: string, neoVersion: string | null, f: Fetchers = live): Promise<ResolvedDownload> {
  let nv = neoVersion
  if (!nv) {
    const prefix = neoPrefixFor(mcVersion)
    const m = (await f.json(
      'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge',
      NEOFORGE_HOSTS,
    )) as { versions?: string[] }
    const matching = (m.versions ?? []).filter((v) => v.startsWith(prefix) && !v.includes('beta'))
    const any = (m.versions ?? []).filter((v) => v.startsWith(prefix))
    const pool = matching.length > 0 ? matching : any
    if (pool.length === 0) throw new Error(`NeoForge publishes no build for ${mcVersion}.`)
    nv = pool[pool.length - 1]!
  }
  const name = `neoforge-${nv}-installer.jar`
  const base = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${nv}/${name}`
  const expected = parseSidecar(await f.text(`${base}.sha512`, NEOFORGE_HOSTS), 'sha512')
  return {
    flavor: 'neoforge',
    mcVersion,
    artifactName: name,
    url: base,
    algo: 'sha512',
    expected,
    allowHosts: NEOFORGE_HOSTS,
    kind: 'installer-jar',
    note: `NeoForge ${nv}`,
  }
}

// ------------------------------------------------------------------ fabric

export function resolveFabric(): never {
  const entry = flavorCatalog().find((e) => e.flavor === 'fabric')
  throw new Error(entry && !entry.available ? entry.reason : 'Fabric is not offered.')
}

// -------------------------------------------------------------------- java

/**
 * The Java major each Minecraft generation needs. The mapping is Mojang's,
 * not ours: 1.17 raised the floor to 16 (17 satisfies it and is the LTS),
 * 1.18 to 17, 1.20.5 to 21. Everything older runs on 8.
 */
export function requiredJavaMajor(mcVersion: string): number {
  const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(mcVersion)
  if (!m) return 21
  const minor = Number(m[1])
  const patch = Number(m[2] ?? 0)
  if (minor < 17) return 8
  if (minor < 20 || (minor === 20 && patch < 5)) return 17
  return 21
}

/** Where the operator gets that Java themselves, the default path. */
export function adoptiumLink(major: number): string {
  return `https://adoptium.net/temurin/releases/?version=${major}&os=windows&arch=x64`
}
