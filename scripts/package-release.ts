/**
 * Build the release artifact: a zip a stranger can unpack and double-click.
 *
 * The distribution problem this solves. Every install path this project had
 * before assumed a developer: clone the repo, install Node, `npm install`,
 * `npm start`. Someone who runs a Minecraft server for their friends has
 * none of that and should not have to acquire it to look at a dashboard.
 *
 * What goes in the zip, and why each piece:
 *
 *   Start Dashboard.bat   the double-click. Calls the bundled node by
 *                         RELATIVE path, so an installed Node, a wrong
 *                         version of one, or none at all changes nothing.
 *   node/node.exe         the official Windows x64 build, unmodified and
 *                         still carrying its own Authenticode signature.
 *                         Bundling the runtime is what makes "no Node
 *                         installed" a supported state rather than a
 *                         prerequisite.
 *   app/server.mjs        the whole service, bundled. The source is
 *                         TypeScript run through tsx in development; a
 *                         release cannot ship a TypeScript loader and a
 *                         node_modules tree and still be a double-click.
 *   dist/                 the built UI, exactly as the dev service serves it.
 *   package.json          trimmed to name, version, description, licence.
 *                         The service reads its version from here at
 *                         startup, so it is a file the app needs, not
 *                         packaging residue.
 *   README.txt            what the operator sees if they open the folder
 *                         before double-clicking anything.
 *   LICENSE, THIRD-PARTY-NOTICES.txt
 *
 * Layout is not arbitrary. `server/http.ts` finds the UI at
 * `import.meta.dirname/../dist` and `server/main.ts` finds the version at
 * `import.meta.dirname/../package.json`. Putting the bundle in `app/` makes
 * both resolve against the zip root with no code changes, so the packaged
 * app and the dev service run the same paths.
 *
 * Deliberately NOT here: an installer, a service registration, a shortcut in
 * the start menu, anything written outside the folder. Unzip and delete are
 * the install and uninstall.
 *
 * Run:  npx tsx scripts/package-release.ts [--out <dir>] [--node <node.exe>]
 *                                          [--version <x.y.z>] [--skip-ui]
 */
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'

const REPO = resolve(import.meta.dirname, '..')

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}
const has = (name: string) => process.argv.includes(`--${name}`)

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
  name: string
  version: string
  description: string
  license: string
}
const version = arg('version') ?? pkg.version
const outDir = resolve(arg('out') ?? join(REPO, 'release'))
const stage = join(outDir, `minecraft-server-dashboard-${version}-win-x64`)
const zipPath = `${stage}.zip`

console.log(`packaging ${pkg.name} ${version}`)
console.log(`  out    ${outDir}`)

rmSync(stage, { recursive: true, force: true })
rmSync(zipPath, { force: true })
mkdirSync(join(stage, 'app'), { recursive: true })

// --------------------------------------------------------------------- UI
if (!has('skip-ui')) {
  console.log('  building the UI')
  execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit', shell: true })
}
if (!existsSync(join(REPO, 'dist', 'index.html'))) {
  console.error('FAIL: dist/index.html is missing. The UI did not build.')
  process.exit(1)
}
cpSync(join(REPO, 'dist'), join(stage, 'dist'), { recursive: true })

// ----------------------------------------------------------------- server
/**
 * ESM output with a `require` shim, not CJS.
 *
 * The service source is ESM and uses `import.meta.dirname` to find the UI and
 * its own package.json; a CJS bundle would have to have both rewritten.
 * Meanwhile Fastify and its plugins are CJS and call `require('node:events')`
 * at load time, which esbuild's ESM output refuses by default. The banner
 * gives the bundle a real `require`, which esbuild's own shim then prefers.
 * Verified by running the artifact, not by reading the output.
 */
console.log('  bundling the service')
const result = await build({
  entryPoints: [join(REPO, 'server', 'main.ts')],
  outfile: join(stage, 'app', 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias: { '@shared': join(REPO, 'shared') },
  banner: {
    js: "import{createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);",
  },
  logLevel: 'warning',
  metafile: true,
})
const bundleBytes = statSync(join(stage, 'app', 'server.mjs')).size
console.log(`  bundle ${(bundleBytes / 1024 / 1024).toFixed(1)} MB`)
writeFileSync(join(outDir, 'bundle-metafile.json'), JSON.stringify(result.metafile), 'utf8')

// The version the app reports comes from this file, so it ships.
writeFileSync(
  join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: pkg.name,
      version,
      description: pkg.description,
      license: pkg.license,
      private: true,
    },
    null,
    2,
  )}\n`,
  'utf8',
)

// ------------------------------------------------------------------- node
/**
 * The runtime. In CI this is the official nodejs.org zip, already extracted
 * by the workflow; locally it defaults to whatever node is running this
 * script, which is fine for a smoke test and wrong for a published artifact.
 * Either way the file is copied unmodified, so its signature survives.
 */
const nodeExe = resolve(arg('node') ?? process.execPath)
if (!existsSync(nodeExe)) {
  console.error(`FAIL: no node.exe at ${nodeExe}`)
  process.exit(1)
}
mkdirSync(join(stage, 'node'), { recursive: true })
cpSync(nodeExe, join(stage, 'node', 'node.exe'))
const nodeVersion = execFileSync(nodeExe, ['--version'], { encoding: 'utf8' }).trim()
console.log(`  runtime ${nodeVersion} from ${nodeExe}`)

// --------------------------------------------------------------- launcher
/**
 * The double-click.
 *
 * `%~dp0` is the folder this .bat lives in, so the whole thing works from
 * wherever it was unzipped, including a path with spaces, which is why every
 * path is quoted. The window stays open on failure: a console that vanishes
 * taking the error with it is the worst possible answer to "it did not
 * start", and this is the one moment a new operator has no other diagnostics.
 */
writeFileSync(
  join(stage, 'Start Dashboard.bat'),
  [
    '@echo off',
    'setlocal',
    'title Minecraft Server Dashboard',
    'cd /d "%~dp0"',
    '',
    'if not exist "node\\node.exe" (',
    '  echo.',
    '  echo   node\\node.exe is missing. Unzip the whole folder, not just',
    '  echo   this file, and run it from the unzipped folder.',
    '  echo.',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    'echo Starting. The dashboard opens at http://127.0.0.1:8422',
    'echo Close this window to stop it.',
    'echo.',
    '"node\\node.exe" "app\\server.mjs" %*',
    'set EXITCODE=%ERRORLEVEL%',
    '',
    'if not "%EXITCODE%"=="0" (',
    '  echo.',
    '  echo   The dashboard stopped with an error ^(code %EXITCODE%^).',
    '  echo   The message above is the reason.',
    '  echo.',
    '  pause',
    ')',
    'endlocal',
    '',
  ].join('\r\n'),
  'utf8',
)

/**
 * The same thing bound to the LAN, as a separate file rather than a flag.
 *
 * Plain HTTP on a network is a real decision with a real consequence, so it
 * is a deliberate act (choosing a different file) and the file says what it
 * costs. Making it a prompt inside the normal launcher would put the choice
 * in front of people who did not come looking for it.
 */
writeFileSync(
  join(stage, 'Start Dashboard (whole network).bat'),
  [
    '@echo off',
    'setlocal',
    'title Minecraft Server Dashboard (whole network)',
    'cd /d "%~dp0"',
    'echo.',
    'echo   This binds the dashboard to every network interface, so any',
    'echo   machine on your network can reach it. It is plain HTTP: anyone',
    'echo   who can watch the traffic can take a signed-in session. Do not',
    'echo   port-forward it to the internet.',
    'echo.',
    'set MCDASH_HOST=0.0.0.0',
    'call "Start Dashboard.bat" %*',
    'endlocal',
    '',
  ].join('\r\n'),
  'utf8',
)

// ------------------------------------------------------------------- docs
const readme = [
  `Minecraft Server Dashboard ${version}`,
  '',
  'Double-click "Start Dashboard.bat", then open http://127.0.0.1:8422',
  '',
  'The first start prints an admin username and password in the black',
  'window. That password is shown once and stored only as a hash, so',
  'copy it before closing the window.',
  '',
  'Nothing is installed. Everything this needs is in this folder,',
  'including the copy of Node.js it runs on. To uninstall, delete the',
  'folder. Your sign-in and settings live in',
  '%APPDATA%\\minecraft-server-dashboard and are not touched by deleting',
  'this folder; delete that too for a clean sweep.',
  '',
  'It never writes into a Minecraft server folder unless you change a',
  'setting from inside the dashboard, and it never starts a server you',
  'did not tell it how to start.',
  '',
  'Windows may warn you before running the .bat. See docs/install.md in',
  'the repository for what the warning says and why.',
  '',
  `Source, issues and full documentation:`,
  'https://github.com/MhmdMK277/Minecraft-Server-Dashboard',
  '',
].join('\r\n')
writeFileSync(join(stage, 'README.txt'), readme, 'utf8')

if (existsSync(join(REPO, 'LICENSE'))) cpSync(join(REPO, 'LICENSE'), join(stage, 'LICENSE'))

/**
 * Third-party notices, generated from what is actually in the bundle rather
 * than from package.json. A dependency list is a claim about the artifact,
 * and the artifact is the bundle.
 */
{
  const inputs = Object.keys(result.metafile.inputs)
  const packages = new Set<string>()
  for (const p of inputs) {
    const m = /node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/.exec(p)
    if (m?.[1]) packages.add(m[1].replace(/\\/g, '/'))
  }
  const lines = [
    `Minecraft Server Dashboard ${version} bundles the following packages.`,
    'Each remains under its own licence, held in its own repository.',
    '',
    ...[...packages].sort().map((p) => `  ${p}`),
    '',
    `Node.js ${nodeVersion} is included unmodified from nodejs.org and is`,
    'licensed by the OpenJS Foundation and Node.js contributors.',
    '',
  ]
  writeFileSync(join(stage, 'THIRD-PARTY-NOTICES.txt'), lines.join('\r\n'), 'utf8')
  console.log(`  bundled packages ${packages.size}`)
}

// -------------------------------------------------------------------- zip
console.log('  zipping')
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -Path '${stage}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
  ],
  { stdio: 'inherit' },
)

/**
 * SHA256SUMS, so a download can be checked without trusting the transport.
 * Written in the `sha256sum -c` format, which is what someone verifying it
 * will already have, and covering the zip rather than its contents: the zip
 * is the thing that travels.
 */
const digest = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
const zipName = zipPath.split(/[\\/]/).pop()!
writeFileSync(join(outDir, 'SHA256SUMS'), `${digest}  ${zipName}\n`, 'utf8')

const zipBytes = statSync(zipPath).size
console.log('')
console.log(`  ${zipName}`)
console.log(`  ${(zipBytes / 1024 / 1024).toFixed(1)} MB`)
console.log(`  sha256 ${digest}`)
console.log('')
console.log('  contents:')
for (const entry of readdirSync(stage)) {
  const p = join(stage, entry)
  const s = statSync(p)
  console.log(`    ${entry}${s.isDirectory() ? '/' : ` (${(s.size / 1024).toFixed(0)} KB)`}`)
}
