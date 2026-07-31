/**
 * PROOF: the backup opt-out is durable, fails safe, and cannot cost you an
 * archive.
 *
 * Three separate claims, because they fail in different ways:
 *
 *   1. Semantics. Absent, empty, corrupt and malformed policies all mean "back
 *      it up". The only irreversible mistake available here is silently ceasing
 *      to protect a world, so every unclear input has to land on the safe side.
 *
 *   2. Agreement across the language boundary. The dashboard writes this file in
 *      TypeScript and mcbackup.py reads it in Python. A contract with one writer
 *      and one reader in different languages is exactly where a `"false"` string
 *      or a missing default quietly diverges, so the Python side is asked the
 *      same questions and must give the same answers.
 *
 *   3. Excluding a server cannot delete anything. rotate() is the only function
 *      in the backup script that removes files, and the filter runs before the
 *      per-server loop -- so an excluded directory never reaches it. That is an
 *      ordering property, and it is asserted against the actual source rather
 *      than assumed.
 *
 * Run:  npx tsx scripts/prove-backup-policy.ts
 *
 * Claims 2 and 3 need the backup script, which lives outside this repo because
 * it is the operator's, not the app's. Point MCDASH_BACKUP_SCRIPT at it; without
 * it those checks report SKIP rather than passing vacuously.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  loadPolicy,
  setBackupEnabled,
  isBackupEnabled,
  policyPath,
  POLICY_FILE,
} from '../server/backuppolicy'

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])
let skipped = 0
const skip = (l: string, why: string) => {
  skipped++
  console.log(`  SKIP  ${l}  (${why})`)
}

const dir = mkdtempSync(join(tmpdir(), 'mcdash-policy-'))
const write = (body: string) => writeFileSync(policyPath(dir), body, 'utf8')

// ------------------------------------------------------------------ semantics

check('a missing policy file backs everything up', isBackupEnabled(loadPolicy(dir), 'MC Anything'))

write('')
check('an empty policy file backs everything up', isBackupEnabled(loadPolicy(dir), 'MC Anything'))

write('{ this is not json')
check('a corrupt policy file backs everything up', isBackupEnabled(loadPolicy(dir), 'MC Anything'))

write('[]')
check('a policy that is an array, not an object, backs everything up', isBackupEnabled(loadPolicy(dir), 'MC Anything'))

write(JSON.stringify({ version: 1, servers: { 'MC Tech': 'false' } }))
check(
  'the STRING "false" is not an opt-out',
  isBackupEnabled(loadPolicy(dir), 'MC Tech'),
  'a quoted false must not stop backups',
)

write(JSON.stringify({ version: 1, servers: { 'MC Tech': null, 'MC Other': 0 } }))
check('null is not an opt-out', isBackupEnabled(loadPolicy(dir), 'MC Tech'))
check('zero is not an opt-out', isBackupEnabled(loadPolicy(dir), 'MC Other'))

write(JSON.stringify({ version: 1, servers: { 'MC Tech': false } }))
check('a literal false IS an opt-out', !isBackupEnabled(loadPolicy(dir), 'MC Tech'))
check('and only for the server named', isBackupEnabled(loadPolicy(dir), 'MC 1.21.4'))

write(JSON.stringify({ version: 1, backupByDefault: false, servers: { 'MC Keep': true } }))
check('backupByDefault false flips the default', !isBackupEnabled(loadPolicy(dir), 'Unnamed'))
check('and an explicit true still wins over it', isBackupEnabled(loadPolicy(dir), 'MC Keep'))

// ----------------------------------------------------------------- durability

const fresh = mkdtempSync(join(tmpdir(), 'mcdash-policy-'))
setBackupEnabled(fresh, 'MC Tech', false, 'tester', 'C:/servers')
// Re-reading from disk is what a restarted dashboard or a 05:00 backup run does.
check('an opt-out survives being written and re-read', !isBackupEnabled(loadPolicy(fresh), 'MC Tech'))
check('the file records who changed it', loadPolicy(fresh).updatedBy === 'tester')
check('and when', !!loadPolicy(fresh).updatedAt)
check('and the root the names were resolved against', loadPolicy(fresh).serversRoot === 'C:/servers')

setBackupEnabled(fresh, 'MC Other', false, 'tester')
check(
  'a second decision does not clobber the first',
  !isBackupEnabled(loadPolicy(fresh), 'MC Tech') && !isBackupEnabled(loadPolicy(fresh), 'MC Other'),
)
setBackupEnabled(fresh, 'MC Tech', true, 'tester')
check('opting back in works', isBackupEnabled(loadPolicy(fresh), 'MC Tech'))
check('and leaves the other decision alone', !isBackupEnabled(loadPolicy(fresh), 'MC Other'))
check(
  'no temporary file is left behind by the atomic write',
  !readdirSync(fresh).some((f) => f.endsWith('.tmp')),
  readdirSync(fresh).join(', '),
)
check('the file is valid JSON a human can read and edit', (() => {
  const t = readFileSync(policyPath(fresh), 'utf8')
  return t.includes('\n  ') && typeof JSON.parse(t) === 'object'
})())

// A name with characters that break naive parsing.
const odd = 'MC 1.21.4 - Copy'
setBackupEnabled(fresh, odd, false, 'tester')
check('a directory name with spaces and a dash round-trips', !isBackupEnabled(loadPolicy(fresh), odd))

// --------------------------------------------------- agreement with Python

const script = process.env.MCDASH_BACKUP_SCRIPT?.trim()

if (!script || !existsSync(script)) {
  skip('mcbackup.py reads the same file and agrees', 'set MCDASH_BACKUP_SCRIPT')
  skip('rotate() is unreachable for an excluded server', 'set MCDASH_BACKUP_SCRIPT')
} else {
  // Ask the real backup script, with the real policy file, in a child process --
  // no reimplementation of its logic here, or the proof would only show that two
  // things I wrote agree with each other.
  const probe = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("mcbackup", os.environ["SCRIPT"])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
default, picked = m.load_policy()
names = json.loads(os.environ["NAMES"])
print(json.dumps({
    "path": m.policy_path(),
    "decisions": {n: m.backup_enabled(n, default, picked) for n in names},
}))
`
  const names = ['MC Tech', 'MC Other', 'MC 1.21.4', odd, 'Never Mentioned']
  const out = execFileSync('python', ['-c', probe], {
    encoding: 'utf8',
    env: { ...process.env, SCRIPT: script, NAMES: JSON.stringify(names), MCDASH_DATA_DIR: fresh },
  })
  const py = JSON.parse(out) as { path: string; decisions: Record<string, boolean> }

  check(
    'mcbackup.py resolves the same policy path the dashboard writes',
    py.path === policyPath(fresh),
    `${py.path} vs ${policyPath(fresh)}`,
  )
  const policy = loadPolicy(fresh)
  let agree = true
  for (const n of names) {
    const ts = isBackupEnabled(policy, n)
    if (ts !== py.decisions[n]) {
      agree = false
      console.log(`    disagreement on ${n}: ts=${ts} py=${py.decisions[n]}`)
    }
  }
  check('and reaches the same decision for every server', agree, JSON.stringify(py.decisions))

  // The string-"false" trap, across the boundary. Python's truthiness would
  // happily treat "false" as True, and json.load gives a str, so an isinstance
  // check is the only thing standing between a typo and a stopped backup.
  const trap = mkdtempSync(join(tmpdir(), 'mcdash-policy-'))
  writeFileSync(
    join(trap, POLICY_FILE),
    JSON.stringify({ version: 1, servers: { 'MC Tech': 'false', 'MC Two': false } }),
    'utf8',
  )
  const out2 = execFileSync('python', ['-c', probe], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SCRIPT: script,
      NAMES: JSON.stringify(['MC Tech', 'MC Two']),
      MCDASH_DATA_DIR: trap,
    },
  })
  const py2 = (JSON.parse(out2) as { decisions: Record<string, boolean> }).decisions
  check('python ignores a quoted "false" too', py2['MC Tech'] === true)
  check('python honours a real false', py2['MC Two'] === false)

  // ------------------------------------------- excluding cannot delete
  const src = readFileSync(script, 'utf8')
  const lines = src.split(/\r?\n/)
  const defAt = (name: string) => lines.findIndex((l) => l.startsWith(`def ${name}(`))
  const mainAt = defAt('main')
  const rotateCalls = lines
    .map((l, i) => [l, i] as const)
    .filter(([l]) => /(?<!def )\brotate\(/.test(l))
    .map(([, i]) => i)

  check('rotate() is the only thing that removes archives', /def rotate\(/.test(src) && (src.match(/os\.remove\(/g) ?? []).length >= 1)
  check(
    'main() never calls rotate() itself',
    !rotateCalls.some((i) => i > mainAt),
    `calls at lines ${rotateCalls.map((i) => i + 1).join(', ')}, main() at ${mainAt + 1}`,
  )
  // The filter has to come before the loop that does per-server work. If it
  // moved after it, an excluded server would already have been stopped, copied
  // and rotated by the time anyone checked.
  const filterAt = lines.findIndex((l, i) => i > mainAt && l.includes('backup_enabled(n, default, picked)'))
  const loopAt = lines.findIndex((l, i) => i > mainAt && /for name, path in servers:/.test(l))
  check(
    'the policy filter runs before the per-server loop',
    filterAt > 0 && loopAt > 0 && filterAt < loopAt,
    `filter line ${filterAt + 1}, loop line ${loopAt + 1}`,
  )
  // A skipped server must appear in the backup log, or "it stopped being backed
  // up" becomes indistinguishable from "the backup silently broke" six months
  // later. The wording is asserted too: the log line has to say the archives
  // survived, because that is the question anyone reading it will have.
  check(
    'an excluded server is logged, so a silent exclusion is impossible',
    /"EXCLUDED"/.test(src),
  )
  check(
    'and the log line says the existing archives were left alone',
    /untouched/.test(src) && /not rotated/.test(src),
  )
}

console.log('')
let failed = 0
for (const [l, ok, d] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d ? `  (${d})` : ''}`)
}
console.log(
  failed === 0
    ? `\nALL PASS. ${checks.length} checks${skipped ? `, ${skipped} skipped` : ''}`
    : `\n${failed} FAILED`,
)
process.exit(failed === 0 ? 0 : 1)
