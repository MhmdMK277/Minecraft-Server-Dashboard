/**
 * Proof: a console tab survives a full server stop and start.
 *
 * Harder than rotation. At 05:00 the cold backup stops the server, copies, and
 * starts it again -- so the PID changes, latest.log is rotated away and a brand
 * new one is created, all while the tab is supposed to keep streaming. If this
 * breaks, the console dies every morning and nobody notices for a week.
 *
 * The restart is driven by the real mcbackup.py cold path rather than a
 * simulation, so this exercises the actual nightly mechanism. That script is
 * the operator's tool, not the dashboard: M2 remains read-only and this is test
 * tooling only.
 *
 * WORLD: inherited, not asserted. This resolves a PID before and after the
 * restart, so it depends on process identity -- and identity behaves differently
 * depending on how a server was started (spec §14). It is correct today only
 * because mcbackup.py restarts via `Start-ScheduledTask`, so the server comes
 * back in session 0 exactly as it does in production. If that ever becomes a
 * direct spawn, this proof silently starts testing the wrong world. See
 * docs/proof-coverage.md.
 *
 * Run: npx tsx scripts/prove-restart.ts
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { LogTailer } from '../server/logtail'
import { levelOf, redactLine, stripColourCodes } from '../server/redact'
import { enumerateJvms, jvmForDir } from '../server/platform'
import { gamePortOf } from '../server/properties'

const TARGET = 'MC Skyblock'
const dir = join(homedir(), 'Documents', 'MC Servers', TARGET)
const logPath = join(dir, 'logs', 'latest.log')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The operator's backup script drives the restart. Same convention as
// prove-backup-policy: without the env var this SKIPs rather than passing
// vacuously, and rather than hardcoding a path that only exists on one machine.
const backupScript = process.env.MCDASH_BACKUP_SCRIPT
if (!backupScript) {
  console.log('SKIP: set MCDASH_BACKUP_SCRIPT to the path of mcbackup.py to run this proof.')
  process.exit(0)
}
const backupDir = join(backupScript, '..')

// Hints included: this server may have been started by its boot task, in which
// case its command line is unreadable and the open-log signal is the only one.
const pidOf = async () =>
  jvmForDir(await enumerateJvms([{ dir, gamePort: gamePortOf(dir) }]), dir)?.pid ?? null

const received: string[] = []
let rotations = 0
let garbage = 0

const tailer = new LogTailer(logPath, { pollMs: 250 })
tailer.on('lines', (ls: Array<{ text: string }>) => {
  for (const l of ls) {
    const text = stripColourCodes(redactLine(l.text, 'on'))
    received.push(text)
    // Compressed or binary content would show up as NULs or a pile of
    // replacement characters. Count it rather than trusting it did not happen.
    if (text.includes('\u0000') || (text.match(/\uFFFD/g)?.length ?? 0) > 3) garbage++
  }
})
tailer.on('rotated', () => {
  rotations++
})

const pidBefore = await pidOf()
const stBefore = statSync(logPath)
const inoBefore = stBefore.ino
console.log(`target        : ${TARGET}`)
console.log(`pid before    : ${pidBefore}`)
console.log(`log ino       : ${inoBefore}  (birthtime is unreliable on NTFS - tunnelling)`)

await tailer.start()
console.log(`backlog primed: ${tailer.backlog.length} lines\n`)

const beforeCount = received.length
console.log('running the real cold-backup stop/copy/start for this server ...')

await new Promise<void>((resolve) => {
  const py = spawn(
    'python',
    [
      '-c',
      [
        'import sys,os',
        `sys.path.insert(0, ${JSON.stringify(backupDir)})`,
        'import mcbackup as m',
        `d = os.path.join(m.SERVERS_ROOT, ${JSON.stringify(TARGET)})`,
        `m.backup_cold(${JSON.stringify(TARGET)}, d, False)`,
      ].join('\n'),
    ],
    { stdio: 'inherit', shell: false },
  )
  py.on('close', () => resolve())
})

// Give the tailer a few polls to catch up with the new file.
await sleep(4000)
tailer.stop()

const pidAfter = await pidOf()
const inoAfter = statSync(logPath).ino
const fresh = received.slice(beforeCount)

console.log(`\npid after     : ${pidAfter}`)
console.log(`log ino       : ${inoAfter}`)
console.log(`rotations seen: ${rotations}`)
console.log(`lines received during the restart: ${fresh.length}`)
console.log(`garbage lines : ${garbage}`)

const sawShutdown = fresh.some((l) => /Stopping server|Saving worlds|All dimensions are saved/i.test(l))
const sawBoot = fresh.some((l) => /Starting minecraft server|Loading Minecraft|ModLauncher/i.test(l))
const sawDone = fresh.some((l) => /Done \(/i.test(l))

console.log('\nevidence from the stream itself:')
for (const l of fresh.slice(-6)) console.log(`   ${l.slice(0, 108)}`)

const checks: Array<[string, boolean]> = [
  ['process identity changed (new PID)', pidBefore !== null && pidAfter !== null && pidBefore !== pidAfter],
  ['latest.log was replaced (new inode)', inoAfter !== inoBefore],
  ['tailer detected the replacement', rotations > 0],
  ['captured the shutdown of the old process', sawShutdown],
  ['captured the boot of the new process', sawBoot],
  ['captured the new server reaching Done', sawDone],
  ['no compressed or binary garbage rendered', garbage === 0],
]

console.log('')
let ok = true
for (const [label, pass] of checks) {
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}`)
  if (!pass) ok = false
}
console.log(`\n${ok ? 'PASS' : 'FAIL'}, console survived a full stop/start with no intervention`)
process.exit(ok ? 0 : 1)
