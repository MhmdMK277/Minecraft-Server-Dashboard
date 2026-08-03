import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dataDir } from './config'
import { fetchJson, fetchVerified } from './fetchverify'

const exec = promisify(execFile)

/**
 * Provisioning a Java runtime from Adoptium, on the operator's explicit
 * per-server choice and never otherwise.
 *
 * The decisions this module encodes, from the approved proposal:
 *
 *   - **On demand only, one version only.** This is called from a creation
 *     whose operator chose "download Java for me", with exactly the major
 *     that creation needs. There is no warm-all-versions path and no
 *     background call site; if one appears in review, it is a bug.
 *   - **Verified like everything else.** Adoptium publishes a SHA-256 per
 *     package; the zip goes through the same fetchVerified as a server jar.
 *   - **The consequence is stated before the click.** The runtime lands
 *     under this dashboard's data directory in the user profile, and the
 *     created start.bat carries that ABSOLUTE path: move the folder to
 *     another machine or delete the dashboard's data directory and the
 *     script breaks. The UI shows CONSEQUENCE_TEXT next to the choice; the
 *     default remains "use the Java you already have".
 *   - **Reuse over re-download.** A runtime of the right major that is
 *     already provisioned is used as is. Reuse is not a background download;
 *     it is not a download at all.
 */

// api.adoptium.net redirects to a GitHub release, which redirects again to
// GitHub's asset CDN. That CDN host is not stable (`objects.` became
// `release-assets.`), so the CDN is named by authority, not by a host string
// that has to be chased. See hostAllowed in fetchverify.ts.
export const ADOPTIUM_HOSTS = ['api.adoptium.net', 'github.com', '.githubusercontent.com']

export const CONSEQUENCE_TEXT =
  'The runtime is stored inside this dashboard\'s data folder in your user profile, and the server\'s start.bat will carry that absolute path. Moving the server folder to another machine, or removing the dashboard\'s data folder, breaks the script until you point it at another Java.'

export function javaRoot(base: string = dataDir()): string {
  return join(base, 'java')
}

/** An already-provisioned runtime for this major, if one exists. */
export function findProvisioned(major: number, base: string = dataDir()): string | null {
  const root = javaRoot(base)
  if (!existsSync(root)) return null
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith(`jdk-${major}`) && !entry.startsWith(`jdk${major}`)) continue
    const home = join(root, entry)
    if (existsSync(join(home, 'bin', 'java.exe')) || existsSync(join(home, 'bin', 'java'))) return home
  }
  return null
}

export type ProvisionDeps = {
  base?: string
  json?: (url: string, allowHosts: string[]) => Promise<unknown>
  download?: (url: string, dest: string, expected: string) => Promise<unknown>
  /** Test seam for the zip extraction. */
  extract?: (zip: string, into: string) => Promise<void>
}

type AdoptiumAsset = {
  binary?: { package?: { name?: string; link?: string; checksum?: string } }
  release_name?: string
}

/**
 * Ensure a Temurin JRE for `major` exists locally and return its home.
 * Downloads at most one package, and only when nothing is provisioned yet.
 */
export async function provisionJava(major: number, deps: ProvisionDeps = {}): Promise<{ javaHome: string; reused: boolean }> {
  const base = deps.base ?? dataDir()
  const already = findProvisioned(major, base)
  if (already) return { javaHome: already, reused: true }

  const json = deps.json ?? fetchJson
  const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?os=windows&architecture=x64&image_type=jre&vendor=eclipse`
  const assets = (await json(url, ADOPTIUM_HOSTS)) as AdoptiumAsset[]
  const pkg = Array.isArray(assets) ? assets[0]?.binary?.package : undefined
  if (!pkg?.link || !pkg.name) throw new Error(`Adoptium lists no Windows x64 JRE ${major} package.`)
  if (!pkg.checksum) {
    throw new Error(`Adoptium's metadata for JRE ${major} carries no checksum, so it will not be downloaded.`)
  }

  const root = javaRoot(base)
  const staging = join(root, 'staging')
  mkdirSync(staging, { recursive: true })
  const zip = join(staging, pkg.name)

  if (deps.download) await deps.download(pkg.link, zip, pkg.checksum)
  else await fetchVerified({ url: pkg.link, dest: zip, algo: 'sha256', expected: pkg.checksum, allowHosts: ADOPTIUM_HOSTS })

  const before = new Set(existsSync(root) ? readdirSync(root) : [])
  try {
    if (deps.extract) await deps.extract(zip, root)
    else {
      await exec(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:MCDASH_ZIP -DestinationPath $env:MCDASH_DEST -Force'],
        { timeout: 300_000, windowsHide: true, env: { ...process.env, MCDASH_ZIP: zip, MCDASH_DEST: root } },
      )
    }
  } finally {
    // The verified zip has served its purpose either way; the staging area
    // must not accumulate archives. This deletes only what this call staged.
    await rm(zip, { force: true })
  }

  const appeared = readdirSync(root).filter((e) => !before.has(e) && e !== 'staging')
  const home = appeared.map((e) => join(root, e)).find((h) => existsSync(join(h, 'bin', 'java.exe')) || existsSync(join(h, 'bin', 'java')))
  const found = home ?? findProvisioned(major, base)
  if (!found) throw new Error('The archive extracted, but no runtime with a bin/java appeared inside it.')
  return { javaHome: found, reused: false }
}
