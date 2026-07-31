/**
 * Apply a backup opt-in/opt-out from the command line, against the real data
 * directory the dashboard and mcbackup.py both read.
 *
 * The dashboard's tick is the intended way to do this. This exists for the case
 * where the dashboard is not running, and for setting the initial state without
 * having to start it -- it writes the identical file through the identical
 * function, so there is one implementation and one format.
 *
 * Usage:
 *   npx tsx scripts/set-backup-optout.ts --list
 *   npx tsx scripts/set-backup-optout.ts --off "MC Tech" "MC 1.21.4 - Copy"
 *   npx tsx scripts/set-backup-optout.ts --on  "MC Tech"
 */
import { loadConfig, dataDir } from '../server/config'
import { listDirectories, levelDatPath } from '../server/properties'
import { join } from 'node:path'
import { loadPolicy, setBackupEnabled, isBackupEnabled, policyPath } from '../server/backuppolicy'

const args = process.argv.slice(2)
const mode = args[0]
const names = args.slice(1)
const cfg = loadConfig(dataDir())

const known = listDirectories(cfg.serversRoot).filter((n) => levelDatPath(join(cfg.serversRoot, n)))

function list(): void {
  const policy = loadPolicy(dataDir())
  console.log(`policy file : ${policyPath(dataDir())}`)
  console.log(`servers root: ${cfg.serversRoot}`)
  console.log(
    `updated     : ${policy.updatedAt ?? 'never'}${policy.updatedBy ? ` by ${policy.updatedBy}` : ''}`,
  )
  console.log('')
  for (const n of known) {
    const on = isBackupEnabled(policy, n)
    const explicit = typeof policy.servers[n] === 'boolean'
    console.log(`  [${on ? 'x' : ' '}] ${n.padEnd(20)} ${explicit ? '(explicit)' : '(default)'}`)
  }
}

if (mode === '--list' || !mode) {
  list()
  process.exit(0)
}

if (mode !== '--on' && mode !== '--off') {
  console.error('first argument must be --list, --on or --off')
  process.exit(2)
}
if (!names.length) {
  console.error('name at least one server directory')
  process.exit(2)
}

// A typo must not create a policy entry for a directory that does not exist:
// that is indistinguishable from the setting failing to save.
const unknown = names.filter((n) => !known.includes(n))
if (unknown.length) {
  console.error(`not a server directory under ${cfg.serversRoot}: ${unknown.join(', ')}`)
  console.error(`known: ${known.join(', ')}`)
  process.exit(1)
}

for (const n of names) {
  setBackupEnabled(dataDir(), n, mode === '--on', 'cli', cfg.serversRoot)
  console.log(`${mode === '--on' ? 'included' : 'excluded'}: ${n}`)
}
console.log('')
list()
