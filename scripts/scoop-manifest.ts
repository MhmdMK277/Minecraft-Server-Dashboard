/**
 * Write the Scoop manifest for the release that was just packaged.
 *
 * Scoop rather than winget or an installer, because Scoop matches what this
 * artifact already is: an unpacked folder that runs in place, installed and
 * removed without touching anything else on the machine. winget wants a
 * publisher identity and a review queue, and a signed installer costs real
 * money for a certificate, both of which were deliberately skipped.
 *
 * The bucket is this repository. `bucket/` at the root is a layout Scoop
 * understands directly, so `scoop bucket add` works against the same repo
 * that holds the source, with no second repository to keep in step.
 *
 * The hash is read from the SHA256SUMS that package-release.ts wrote, not
 * recomputed here. There is one authority for what the artifact hashes to,
 * and a manifest disagreeing with the published checksum file is a worse
 * failure than either being wrong on its own.
 *
 * `--published` takes that authority one step further: it reads SHA256SUMS
 * from the RELEASE THAT IS ACTUALLY DOWNLOADABLE rather than from a local
 * build. Both produce the same bytes only if the local tree matches the
 * tag, and on v0.1.0 they did not: a locally generated manifest carried a
 * hash from a different build of the same version, which would have made
 * `scoop install` fail its checksum on a release that was otherwise fine.
 * Use --published whenever fixing up a manifest after a release exists.
 *
 * Run:  npx tsx scripts/scoop-manifest.ts --version 0.1.0 [--published]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const REPO_URL = 'https://github.com/MhmdMK277/Minecraft-Server-Dashboard'

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
  version: string
  description: string
  license: string
}
const version = arg('version') ?? pkg.version
const folder = `minecraft-server-dashboard-${version}-win-x64`

let sums: string
if (process.argv.includes('--published')) {
  const url = `${REPO_URL}/releases/download/v${version}/SHA256SUMS`
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`FAIL: could not read the published SHA256SUMS (HTTP ${res.status}) at ${url}`)
    process.exit(1)
  }
  sums = await res.text()
  console.log(`reading the PUBLISHED checksums from ${url}`)
} else {
  const sumsPath = join(REPO, 'release', 'SHA256SUMS')
  if (!existsSync(sumsPath)) {
    console.error('FAIL: release/SHA256SUMS is missing. Package the release first, or pass --published.')
    process.exit(1)
  }
  sums = readFileSync(sumsPath, 'utf8')
}
const line = sums.split(/\r?\n/).find((l) => l.includes(`${folder}.zip`))
const hash = line?.trim().split(/\s+/)[0]
if (!hash || !/^[0-9a-f]{64}$/.test(hash)) {
  console.error(`FAIL: no sha256 for ${folder}.zip in SHA256SUMS:\n${sums}`)
  process.exit(1)
}

const manifest = {
  version,
  description: pkg.description,
  homepage: REPO_URL,
  license: pkg.license,
  architecture: {
    '64bit': {
      url: `${REPO_URL}/releases/download/v${version}/${folder}.zip`,
      hash,
      extract_dir: folder,
    },
  },
  shortcuts: [['Start Dashboard.bat', 'Minecraft Server Dashboard']],
  notes: [
    'Run "Minecraft Server Dashboard" from the start menu, or Start Dashboard.bat',
    'in the install folder, then open http://127.0.0.1:8422',
    '',
    'The first start prints an admin password once. Copy it before closing',
    'the window. Settings and sign-in live in %APPDATA%\\minecraft-server-dashboard',
    'and survive an update; scoop uninstall does not remove them.',
  ],
  checkver: { github: REPO_URL },
  autoupdate: {
    architecture: {
      '64bit': {
        url: `${REPO_URL}/releases/download/v$version/minecraft-server-dashboard-$version-win-x64.zip`,
        extract_dir: 'minecraft-server-dashboard-$version-win-x64',
      },
    },
    hash: { url: `${REPO_URL}/releases/download/v$version/SHA256SUMS` },
  },
}

const dir = join(REPO, 'bucket')
mkdirSync(dir, { recursive: true })
const out = join(dir, 'minecraft-server-dashboard.json')
writeFileSync(out, `${JSON.stringify(manifest, null, 4)}\n`, 'utf8')
console.log(`wrote ${out}`)
console.log(`  version ${version}`)
console.log(`  hash    ${hash}`)
