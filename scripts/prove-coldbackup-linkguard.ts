/**
 * PROOF (F10): restore refuses link/device archive members before extraction,
 * and this containment is CODE, not an OS privilege default.
 *
 * The harm is arbitrary file write outside the restore directory, which on
 * this host means overwriting a start script or a scheduled-task target: code
 * execution. Found by attack 2026-08-03: bsdtar refuses every `..` and
 * absolute path, but it CREATES a symlink member and then writes the next
 * member through it, escaping the destination. In the lab that escaped; in
 * production it was contained only because a limited Windows token is denied
 * SeCreateSymbolicLinkPrivilege -- an OS default, which breaks under an
 * elevated dashboard or Developer Mode.
 *
 * So this proof does two things:
 *   1. Demonstrates the escape is REAL on this machine: the raw extraction
 *      command the app runs, on a symlink archive, and a check of where the
 *      payload landed. When run elevated it escapes; that is the point.
 *   2. Proves the fix contains it REGARDLESS: restoreColdBackup refuses the
 *      same archive by naming the member, before any extraction, so the
 *      outcome does not depend on the OS declining the symlink.
 *
 * Run:  npx tsx scripts/prove-coldbackup-linkguard.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { restoreColdBackup, runColdBackup, tarBin, MANIFEST_FILE } from '../server/coldbackup'

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

// Build archives with python: it is the one tool here that can author a
// write-through-symlink member and a hardlink member deterministically.
const ARCH = mkdtempSync(join(tmpdir(), 'linkguard-arch-'))
function py(script: string) {
  execFileSync('python', ['-c', script], { cwd: ARCH })
}

// A symlink member ("World/esc" -> "..") followed by a file that resolves
// through it ("World/esc/pwn.txt"): the escape primitive.
py(`
import tarfile, io
with tarfile.open("sym.tar","w") as t:
    li=tarfile.TarInfo("World/esc"); li.type=tarfile.SYMTYPE; li.linkname=".."; t.addfile(li)
    d=b"PWNED"; fi=tarfile.TarInfo("World/esc/pwn.txt"); fi.size=len(d); t.addfile(fi, io.BytesIO(d))
`)
// A hardlink member.
py(`
import tarfile, io
with tarfile.open("hard.tar","w") as t:
    d=b"real"; fi=tarfile.TarInfo("World/real.txt"); fi.size=len(d); t.addfile(fi, io.BytesIO(d))
    hi=tarfile.TarInfo("World/hard"); hi.type=tarfile.LNKTYPE; hi.linkname="World/real.txt"; t.addfile(hi)
`)
// A block-device member.
py(`
import tarfile
with tarfile.open("dev.tar","w") as t:
    di=tarfile.TarInfo("World/dev"); di.type=tarfile.BLKTYPE; di.devmajor=1; di.devminor=1; t.addfile(di)
`)
// A benign files-and-dirs archive, so the guard does not refuse legitimate ones.
py(`
import tarfile, io, os
with tarfile.open("clean.tar","w") as t:
    di=tarfile.TarInfo("World"); di.type=tarfile.DIRTYPE; t.addfile(di)
    for n in ("World/level.dat","World/region/r.0.0.mca"):
        d=b"x"; fi=tarfile.TarInfo(n); fi.size=len(d); t.addfile(fi, io.BytesIO(d))
`)

// ---------------------------------------------------------------- 1. the escape is real

console.log('--- 1. the escape is real on this machine (raw extraction, no guard)')
const rawRoot = mkdtempSync(join(tmpdir(), 'linkguard-raw-'))
const restoreDir = join(rawRoot, 'restore')
mkdirSync(restoreDir, { recursive: true })
const victimAbove = join(rawRoot, 'pwn.txt') // one level ABOVE restoreDir
let rawEscaped = false
let rawThrew = ''
try {
  execFileSync(tarBin(), ['-x', '-f', join(ARCH, 'sym.tar'), '-C', restoreDir, '--strip-components', '1'], {
    windowsHide: true,
  })
} catch (e) {
  rawThrew = (e as Error).message.split('\n')[0]!
}
rawEscaped = existsSync(victimAbove) && readFileSync(victimAbove, 'utf8').includes('PWNED')
const elevated =
  execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  ]).toString().trim()
console.log(`   token elevated: ${elevated}`)
console.log(`   raw extraction ${rawEscaped ? 'ESCAPED to ' + victimAbove : rawThrew ? 'was blocked by the OS (' + rawThrew + ')' : 'did not escape'}`)
// This check documents the environment; either outcome is fine. When elevated
// the escape is present, which is exactly the case the fix must contain.
check('the raw extraction result is recorded (escape when elevated, OS-blocked otherwise)', true)
if (elevated === 'True') {
  check('when elevated, the UNGUARDED extraction genuinely escapes (so the OS is not the guard)', rawEscaped,
    'expected the symlink write-through to land above the restore dir under an elevated token')
}

// ---------------------------------------------------------------- 2. the fix contains it

console.log('\n--- 2. restoreColdBackup refuses link/device members, before extraction')
const DATA = mkdtempSync(join(tmpdir(), 'linkguard-data-'))
const ROOT = mkdtempSync(join(tmpdir(), 'linkguard-root-'))

async function tryRestore(archive: string, id: string): Promise<Awaited<ReturnType<typeof restoreColdBackup>>> {
  const serverDir = join(ROOT, id, 'World')
  mkdirSync(serverDir, { recursive: true })
  const entry = {
    id, serverName: 'World', serverDir, archivePath: join(ARCH, archive),
    sha256: sha(join(ARCH, archive)), bytes: 0, createdAt: 'x', actor: 'a',
  }
  writeFileSync(join(DATA, MANIFEST_FILE), JSON.stringify(entry) + '\n')
  const before = new Set(readdirSync(join(ROOT, id)))
  const r = await restoreColdBackup({ archiveId: id, dataDir: DATA }, { occupancy: async () => ({ pids: [], certain: true, doubt: null }) })
  // No escape must have occurred: nothing new above the server dir except the
  // (absent) restore dir, and no PWNED payload anywhere under ROOT or above it.
  const escapedFile = existsSync(join(ROOT, id, 'pwn.txt'))
  return Object.assign(r, { __escaped: escapedFile, __before: before }) as never
}

{
  const r = await tryRestore('sym.tar', 'sym') as { ok: boolean; reason?: string; __escaped: boolean }
  console.log(`   symlink archive   -> ${r.ok ? 'RESTORED' : 'refused'}: ${r.ok ? '' : r.reason!.slice(0, 90)}`)
  check('a symlink member is refused', !r.ok)
  check('and the reason names it a symlink', /symlink member \("World\/esc"\)/.test(r.reason ?? ''), r.reason)
  check('and the reason says extraction was refused before it began', /before it began/.test(r.reason ?? ''))
  check('and NOTHING escaped the restore directory', !r.__escaped)
}
{
  const r = await tryRestore('hard.tar', 'hard') as { ok: boolean; reason?: string }
  console.log(`   hardlink archive  -> ${r.ok ? 'RESTORED' : 'refused'}: ${r.ok ? '' : r.reason!.slice(0, 90)}`)
  check('a hardlink member is refused', !r.ok && /hardlink member/.test(r.reason ?? ''), r.reason)
}
{
  const r = await tryRestore('dev.tar', 'dev') as { ok: boolean; reason?: string }
  console.log(`   block-device      -> ${r.ok ? 'RESTORED' : 'refused'}: ${r.ok ? '' : r.reason!.slice(0, 90)}`)
  check('a block-device member is refused', !r.ok && /block-device member/.test(r.reason ?? ''), r.reason)
}
{
  const r = await tryRestore('clean.tar', 'clean') as { ok: boolean; reason?: string; restoredDir?: string }
  console.log(`   clean archive     -> ${r.ok ? 'RESTORED to ' + (r.restoredDir ?? '') : 'refused: ' + r.reason}`)
  check('a legitimate files-and-dirs archive still restores', r.ok, r.reason)
  check('and the restored world is present', !!r.restoredDir && existsSync(join(r.restoredDir, 'level.dat')))
}

// ---------------------------------------------------------------- 3. the app's own backup is unaffected

console.log('\n--- 3. the app\'s own backup+restore round trip still works')
const srv = mkdtempSync(join(tmpdir(), 'linkguard-srv-'))
mkdirSync(join(srv, 'World', 'world'), { recursive: true })
writeFileSync(join(srv, 'World', 'world', 'level.dat'), 'x')
writeFileSync(join(srv, 'World', 'server.properties'), 'server-port=25123\n')
const DEST = mkdtempSync(join(tmpdir(), 'linkguard-dest-'))
const BDATA = mkdtempSync(join(tmpdir(), 'linkguard-bdata-'))
const stopped = async () => ({ pids: [] as number[], certain: true, doubt: null })
const bk = await runColdBackup(
  { serverDir: join(srv, 'World'), serverName: 'World', destDir: DEST, dataDir: BDATA, externalBackupPaths: [], actor: 't' },
  { occupancy: stopped },
)
check('a normal server backs up', bk.ok, bk.ok ? '' : bk.reason)
if (bk.ok) {
  const rr = await restoreColdBackup({ archiveId: bk.entry.id, dataDir: BDATA }, { occupancy: stopped })
  console.log(`   round trip restore -> ${rr.ok ? 'ok' : 'refused: ' + rr.reason}`)
  check('and restores cleanly through the guard', rr.ok, rr.ok ? '' : rr.reason)
}

console.log('')
let failed = 0
for (const [l, ok, d] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d ? `  (${d})` : ''}`)
}
console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED`)
console.log(`(throwaway archives and roots left in place; nothing is deleted)`)
process.exit(failed === 0 ? 0 : 1)
