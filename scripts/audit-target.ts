/**
 * M4: stand up an ISOLATED instance for the adversarial pass.
 *
 * Everything here is throwaway. The point is that an attacker (or an agent
 * acting as one) can hammer every route without any possibility of touching
 * a real server:
 *
 *   - a temp servers root holding FAKE server directories, so the control
 *     routes cannot stop a real JVM and a double-spawn cannot corrupt a real
 *     world. The fakes have no launcher, so start is unavailable by design;
 *   - a temp data dir, so real sessions, the real audit log and the real
 *     config are untouched;
 *   - a distinctive fake RCON password, so a credential-leak test has
 *     something greppable that is not a live secret;
 *   - a fixed spare port, never 8422.
 *
 * Run:  npx tsx scripts/audit-target.ts
 * Then attack the printed base URL. Ctrl-C to stop; the temp dirs are left
 * behind on purpose (nothing is ever deleted by this project).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 8477 // deliberately not 8422
const FAKE_RCON_PASSWORD = 'AUDIT-CANARY-RCON-PW-do-not-use-anywhere'
const FAKE_TOKEN = 'AUDIT-CANARY-DISCORD-TOKEN-do-not-use-anywhere'

const ROOT = mkdtempSync(join(tmpdir(), 'mcdash-audit-root-'))
const DATA = mkdtempSync(join(tmpdir(), 'mcdash-audit-data-'))
process.env.MCDASH_DATA_DIR = DATA
process.env.MCDASH_SERVERS_ROOT = ROOT

/** A directory that looks enough like a server for discovery to classify it. */
function fakeServer(name: string, opts: { rcon: boolean; port: number }) {
  const dir = join(ROOT, name)
  mkdirSync(join(dir, 'world'), { recursive: true })
  mkdirSync(join(dir, 'logs'), { recursive: true })
  // level.dat need not be valid NBT: discovery only tests for its presence.
  writeFileSync(join(dir, 'world', 'level.dat'), Buffer.from([0x0a, 0x00, 0x00]))
  writeFileSync(
    join(dir, 'server.properties'),
    [
      `server-port=${opts.port}`,
      'level-name=world',
      'online-mode=true',
      'white-list=false',
      `enable-rcon=${opts.rcon}`,
      `rcon.port=${opts.port + 10}`,
      `rcon.password=${FAKE_RCON_PASSWORD}`,
      '',
    ].join('\n'),
    'utf8',
  )
  // A plausible log, including a line carrying a secret and a player IP, so
  // redaction has something real to fail at.
  writeFileSync(
    join(dir, 'logs', 'latest.log'),
    [
      '[19:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.4',
      `[19:00:01] [Server thread/INFO]: [DiscordSRV] Using token ${FAKE_TOKEN}`,
      '[19:00:02] [Server thread/INFO]: Canary_Player[/203.0.113.9:51234] logged in',
      '[19:00:03] [Server thread/INFO]: RCON running on 0.0.0.0:25585',
      '',
    ].join('\n'),
    'utf8',
  )
  return dir
}

fakeServer('Audit Server One', { rcon: true, port: 25595 })
fakeServer('Audit Server Two', { rcon: false, port: 25596 })
// A hostile directory name, to see how it flows through discovery, the
// launcher and any path handling. Windows forbids " < > | : * ? in names, so
// this is the nastiest legal one.
fakeServer('Audit & Co %TEMP% $(whoami) `id`', { rcon: true, port: 25597 })

const { loadConfig, dataDir } = await import('../server/config')
const { buildServer } = await import('../server/http')
const { bootstrapIfEmpty, loadUsers, saveUsers, hashPassword } = await import('../server/auth')

const cfg = loadConfig(dataDir())
const boot = await bootstrapIfEmpty(dataDir())
if (!boot) throw new Error('bootstrap produced no admin')

const VIEWER_PW = 'audit-viewer-password-1234'
saveUsers(dataDir(), [
  ...loadUsers(dataDir()),
  {
    username: 'auditviewer',
    role: 'viewer',
    password: await hashPassword(VIEWER_PW),
    createdAt: new Date().toISOString(),
    mustChangePassword: false,
  },
])

const app = await buildServer({ cfg, version: 'audit-target' })
await app.listen({ host: '127.0.0.1', port: PORT })

console.log(
  [
    '',
    '=== M4 AUDIT TARGET (isolated, throwaway) ===',
    `base URL         http://127.0.0.1:${PORT}`,
    `admin            ${boot.username} / ${boot.password}`,
    `viewer           auditviewer / ${VIEWER_PW}`,
    `servers root     ${ROOT}`,
    `data dir         ${DATA}`,
    `RCON canary      ${FAKE_RCON_PASSWORD}`,
    `token canary     ${FAKE_TOKEN}`,
    '',
    'The admin account starts with mustChangePassword set; sign-in works, and',
    'that flag is itself worth testing.',
    'Ctrl-C to stop. Temp directories are left in place.',
    '',
  ].join('\n'),
)
