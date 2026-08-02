/**
 * PROOF: editing server.properties cannot lose a line, leak a secret, or leave
 * a server unstartable.
 *
 * This is the first thing the dashboard writes into a directory the Minecraft
 * server owns, so the failures worth proving against are not "did the value
 * change" -- they are the quiet ones:
 *
 *   1. **Reach.** Only `white-list` and `online-mode` are writable. The reason
 *      that matters is `rcon.password`: a general property editor is a path from
 *      a browser to a credential, and the whole project rests on that path not
 *      existing. Asserted on the allowlist AND on the file after a write.
 *
 *   2. **Preservation.** Every line except the target survives byte for byte --
 *      comments, blank lines, key order, CRLF, escaped values. A writer that
 *      parses to an object and re-serialises passes a naive "value changed"
 *      test and silently destroys the file's comments and ordering.
 *
 *   3. **Recoverability.** The previous file is kept, dated, beside the
 *      original. Nothing is deleted, per the operator's standing instruction.
 *
 *   4. **Atomicity.** A crash between open and write leaves a truncated
 *      server.properties, which is a server that will not start. No temp file
 *      survives a successful write.
 *
 * Runs entirely against throwaway directories. It never touches a real server.
 *
 * Run:  npx tsx scripts/prove-settings.ts
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSettings, writeSetting, writeMotd, EDITABLE, isSettingKey } from '../server/serversettings'
import { serverProps, rconConfig } from '../server/properties'

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])

const TODAY = '2026-07-30'

/** A realistic file: comments, blank lines, escapes, and a secret. */
const SAMPLE = [
  '#Minecraft server properties',
  '#Wed Jul 30 05:03:34 CEST 2026',
  'allow-flight=false',
  'enable-rcon=true',
  '',
  '#online-mode=true',
  'level-name=World',
  'level-type=minecraft\\:normal',
  'motd=A Minecraft Server',
  'online-mode=false',
  'rcon.password=hunter2-not-a-real-password',
  'rcon.port=25575',
  'server-port=25567',
  'white-list=false',
  '',
].join('\n')

function fresh(body = SAMPLE): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcdash-settings-'))
  writeFileSync(join(dir, 'server.properties'), body, 'utf8')
  return dir
}

const read = (dir: string) => readFileSync(join(dir, 'server.properties'), 'utf8')

// --------------------------------------------------------------------- reach

check('the boolean allowlist is exactly two keys', EDITABLE.length === 2)
check('white-list is editable', isSettingKey('white-list'))
check('online-mode is editable', isSettingKey('online-mode'))
check(
  'motd is NOT a boolean key; it goes through its own validated writer only',
  !isSettingKey('motd'),
  'free text must never loosen the boolean pair',
)
check(
  'rcon.password is NOT editable',
  !isSettingKey('rcon.password'),
  'a browser must have no path to a credential',
)
check('server-port is NOT editable', !isSettingKey('server-port'))
check('level-name is NOT editable', !isSettingKey('level-name'))

{
  // The type system forbids this call; a compromised or careless caller does not
  // have the type system. The writer must refuse on its own.
  const dir = fresh()
  const before = read(dir)
  const r = writeSetting(dir, 'rcon.password' as never, true, TODAY)
  check('writeSetting refuses a non-allowlisted key at runtime', !r.ok)
  check('and the file is untouched after that refusal', read(dir) === before)
}

// ---------------------------------------------------------------- preservation

{
  const dir = fresh()
  const before = read(dir).split('\n')
  const r = writeSetting(dir, 'online-mode', true, TODAY)
  const after = read(dir).split('\n')

  check('writing online-mode reports ok', r.ok, r.detail)
  check('the transition is named in the detail', /false to true/.test(r.detail), r.detail)
  check('online-mode is now true', serverProps(dir)['online-mode'] === 'true')
  check('the file still has the same number of lines', before.length === after.length)

  const differing = before.map((l, i) => [i, l, after[i]] as const).filter(([, a, b]) => a !== b)
  check(
    'exactly one line changed',
    differing.length === 1,
    `changed: ${JSON.stringify(differing.map(([, a, b]) => [a, b]))}`,
  )
  check(
    'and it is the online-mode line',
    differing[0]?.[1] === 'online-mode=false' && differing[0]?.[2] === 'online-mode=true',
  )

  check('the leading comment survives', after[0] === '#Minecraft server properties')
  check('the blank line survives', after[4] === '')
  check(
    'the COMMENTED-OUT online-mode line is left commented',
    after[5] === '#online-mode=true',
    'uncommenting it would change meaning silently',
  )
  check('the escaped value survives verbatim', after.includes('level-type=minecraft\\:normal'))
  check('key order is unchanged', after[6] === 'level-name=World')
}

// ---------------------------------------------------------------- the secret

{
  const dir = fresh()
  writeSetting(dir, 'online-mode', true, TODAY)
  writeSetting(dir, 'white-list', true, TODAY)
  const after = read(dir)
  check(
    'rcon.password is byte-identical after two writes',
    after.includes('rcon.password=hunter2-not-a-real-password'),
  )
  const rc = rconConfig(dir)
  check('and RCON still parses, so the file is still valid', rc !== null && rc.port === 25575)
  check(
    'the password appears nowhere in the returned detail',
    !/hunter2/.test(writeSetting(dir, 'white-list', false, TODAY).detail),
  )
}

// ------------------------------------------------------------ recoverability

{
  const dir = fresh()
  const original = read(dir)
  writeSetting(dir, 'online-mode', true, TODAY)
  const bak = join(dir, `server.properties.bak-${TODAY}`)
  check('a dated backup is written beside the original', existsSync(bak))
  check('the backup holds the PREVIOUS content', readFileSync(bak, 'utf8') === original)

  // A second edit the same day must not overwrite the day's original backup --
  // that would quietly destroy the only copy of the pre-change file.
  writeSetting(dir, 'white-list', true, TODAY)
  check(
    'a second edit the same day does not overwrite that backup',
    readFileSync(bak, 'utf8') === original,
    'the backup must remain the file as it was before the first edit',
  )
  check('and nothing was deleted', readdirSync(dir).includes('server.properties'))
}

// ----------------------------------------------------------------- atomicity

{
  const dir = fresh()
  writeSetting(dir, 'online-mode', true, TODAY)
  const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'))
  check('no temp file survives a successful write', leftovers.length === 0, leftovers.join(', '))
}

// ------------------------------------------------------------------- no-ops

{
  const dir = fresh()
  const r = writeSetting(dir, 'white-list', false, TODAY)
  check('setting a value to what it already is reports ok', r.ok)
  check('and says so rather than claiming a change', /already false/.test(r.detail), r.detail)
  check(
    'and writes no backup, because nothing changed',
    !existsSync(join(dir, `server.properties.bak-${TODAY}`)),
  )
}

// ------------------------------------------------------- absent keys and CRLF

{
  const dir = fresh(['allow-flight=false', 'server-port=25565', ''].join('\n'))
  const r = writeSetting(dir, 'white-list', true, TODAY)
  check('an absent key is appended rather than refused', r.ok, r.detail)
  check('and the detail says it was not previously set', /not set/.test(r.detail), r.detail)
  check('the value reads back', serverProps(dir)['white-list'] === 'true')
  check('the pre-existing keys survive', serverProps(dir)['server-port'] === '25565')
}

{
  const dir = fresh('allow-flight=false\r\nonline-mode=false\r\nserver-port=25565\r\n')
  writeSetting(dir, 'online-mode', true, TODAY)
  const after = read(dir)
  check('CRLF line endings are preserved', after.includes('\r\n'))
  check('and no stray LF-only line is introduced', !/[^\r]\n/.test(after))
  check('the value still reads back', serverProps(dir)['online-mode'] === 'true')
}

{
  const dir = fresh('  online-mode  =  false  \n')
  writeSetting(dir, 'online-mode', true, TODAY)
  check(
    'surrounding whitespace in the original key is preserved',
    read(dir).startsWith('  online-mode  ='),
    JSON.stringify(read(dir)),
  )
  check('and the value still parses', serverProps(dir)['online-mode'] === 'true')
}

// ------------------------------------------------------------------ defaults

{
  const dir = fresh('server-port=25565\n')
  const s = readSettings(dir, null)
  check(
    'online-mode defaults to TRUE when absent',
    s.onlineMode,
    "Minecraft's default is true; reporting false would call a secure server open",
  )
  check('white-list defaults to FALSE when absent', !s.whitelist)
}

{
  const dir = fresh()
  const s = readSettings(dir, null)
  check('online-mode=false is read as false', !s.onlineMode)
  check('white-list=false is read as false', !s.whitelist)
  check(
    'a commented-out key does not satisfy the read',
    !s.onlineMode,
    '#online-mode=true is above the real line and must not win',
  )
}

// ----------------------------------------------------- restart-needed signal

{
  const dir = fresh()
  check(
    'with no process, changedSinceStart is null, not false',
    readSettings(dir, null).changedSinceStart === null,
    'a stopped server has no stale running config to report',
  )
  // The file was written moments ago. A server that started an hour ago
  // therefore predates it.
  check(
    'a file newer than the process start reports a needed restart',
    readSettings(dir, 3600) === null ? false : readSettings(dir, 3600).changedSinceStart === true,
  )
  // A server that started just now wrote this file itself during startup.
  check(
    'a file written during startup does NOT report a needed restart',
    readSettings(dir, 1).changedSinceStart === false,
    'Minecraft rewrites server.properties as it boots; that is not an operator edit',
  )
}

// ------------------------------------------------------------------- missing

{
  const dir = mkdtempSync(join(tmpdir(), 'mcdash-settings-empty-'))
  const r = writeSetting(dir, 'white-list', true, TODAY)
  check('a directory with no server.properties is refused', !r.ok)
  check('and no file is created by the refusal', !existsSync(join(dir, 'server.properties')))
}

// ----------------------------------------------------------------------- motd
//
// The MOTD is the allowlist's one free-text value, and free text in a
// line-oriented file that also holds rcon.password is where a property
// injection would live. The writer ENCODES rather than trusts: a newline
// becomes the \n escape, a backslash doubles, anything non-ASCII becomes a
// \uXXXX escape (vanilla's own encoding), so the file cannot gain a line.

{
  const dir = fresh()
  const r = writeMotd(dir, '§6Golden words§r here', TODAY)
  check('a formatted MOTD writes ok', r.ok, r.detail)
  const raw = read(dir).split(/\r?\n/).find((l) => l.startsWith('motd='))!
  check('the section sign is written as the \\u00A7 escape vanilla uses', raw.includes('\\u00A7'), raw)
  check('nothing outside printable ASCII reaches the file', [...raw].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) <= 0x7e), raw)
  check('and the decoded read round-trips exactly', readSettings(dir, null).motd === '§6Golden words§r here')
}

{
  const dir = fresh()
  const before = read(dir).split(/\r?\n/).length
  const r = writeMotd(dir, 'line one\nline two', TODAY)
  check('a two-line MOTD writes ok', r.ok, r.detail)
  const after = read(dir)
  check(
    'the file gained NO line: the newline is carried as the \\n escape',
    after.split(/\r?\n/).length === before,
    `${before} lines before, ${after.split(/\r?\n/).length} after`,
  )
  check('and round-trips as a real newline', readSettings(dir, null).motd === 'line one\nline two')
}

{
  // The injection this encoding exists to make unconstructible: a value shaped
  // like a second property line. The newline is encoded, so the payload stays
  // INSIDE the motd value and the credential line is untouched.
  const dir = fresh()
  const r = writeMotd(dir, 'hello\nrcon.password=evil', TODAY)
  check('a value shaped like an injection still writes; it is only text', r.ok, r.detail)
  const after = read(dir)
  check(
    'the real credential line is byte-identical',
    after.includes('rcon.password=hunter2-not-a-real-password'),
  )
  check(
    'and there is still exactly one rcon.password line',
    after.split(/\r?\n/).filter((l) => l.startsWith('rcon.password=')).length === 1,
  )
  check(
    'the payload stayed inside the motd value',
    after.split(/\r?\n/).some((l) => l.startsWith('motd=') && l.includes('rcon.password=evil')),
  )
  check('and reads back as harmless text', readSettings(dir, null).motd === 'hello\nrcon.password=evil')
}

{
  const dir = fresh()
  const before = read(dir)
  const three = writeMotd(dir, 'a\nb\nc', TODAY)
  check('a third line is refused', !three.ok && /at most 2 lines/.test(three.detail), three.detail)
  const long = writeMotd(dir, 'x'.repeat(129), TODAY)
  check('an over-long line is refused', !long.ok && /capped at 128/.test(long.detail), long.detail)
  const ctrl = writeMotd(dir, 'ding\u0007dong', TODAY)
  check('a control character is refused', !ctrl.ok && /control character/.test(ctrl.detail), ctrl.detail)
  check('and no refusal touched the file', read(dir) === before)
}

{
  const dir = fresh()
  writeMotd(dir, 'CRLF\r\ninput', TODAY)
  check(
    'CRLF input (a Windows textarea) is normalised, not refused or doubled',
    readSettings(dir, null).motd === 'CRLF\ninput',
    JSON.stringify(readSettings(dir, null).motd),
  )
}

{
  const dir = fresh()
  const back = writeMotd(dir, 'a backslash \\ survives', TODAY)
  check('a backslash round-trips through the escaping', back.ok && readSettings(dir, null).motd === 'a backslash \\ survives')
}

{
  const dir = fresh()
  const r = writeMotd(dir, 'A Minecraft Server', TODAY)
  check('setting the MOTD to what it already is says so', r.ok && /already/.test(r.detail), r.detail)
  check('and writes no backup, because nothing changed', !existsSync(join(dir, `server.properties.bak-${TODAY}`)))
}

{
  const dir = fresh('server-port=25565\n')
  check('an absent motd reads null, never invented', readSettings(dir, null).motd === null)
  const r = writeMotd(dir, 'fresh words', TODAY)
  check('and can be set by appending the line', r.ok && serverProps(dir)['motd'] === 'fresh words')
}

console.log('')
let failed = 0
for (const [l, ok, d] of checks) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d ? `  (${d})` : ''}`)
}
console.log(failed === 0 ? `\nALL PASS. ${checks.length} checks` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
