/**
 * Stop one server cleanly over RCON: save the world, then `stop`, then wait for
 * the process to exit on its own.
 *
 * Why not Stop-Process. A hard kill of a Minecraft server drops whatever region
 * chunks were mid-write and can leave a corrupt world -- and the whole point of
 * taking MC Tech out of the rotation is that its files keep existing intact.
 * `save-all flush` followed by `stop` is the same shutdown the nightly backup
 * uses, and it is the only stop that is safe to run unattended.
 *
 * Credentials are read from server.properties and never printed. Ports are not
 * printed either; nothing from a server directory may leave this host.
 *
 * Usage: node scripts/graceful-stop.mjs "<server directory>"
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Rcon } from 'rcon-client'
import { execFileSync } from 'node:child_process'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node scripts/graceful-stop.mjs "<server directory>"')
  process.exit(2)
}

const props = Object.fromEntries(
  readFileSync(join(dir, 'server.properties'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)

if (props['enable-rcon'] !== 'true') {
  console.error('RCON is not enabled for this server; refusing to stop it any other way.')
  process.exit(1)
}
const port = Number(props['rcon.port'])
const password = props['rcon.password']
if (!Number.isFinite(port) || !password) {
  console.error('RCON port or password missing from server.properties.')
  process.exit(1)
}

/** PID listening on a port, so we can watch for a real exit rather than guess. */
function listenerPid(p) {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-NetTCPConnection -State Listen -LocalPort ${p} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
      ],
      { encoding: 'utf8' },
    ).trim()
    return out ? Number(out) : null
  } catch {
    return null
  }
}

const gamePort = Number(props['server-port'])
const pid = listenerPid(gamePort)
console.log(`server directory : ${dir}`)
console.log(`process          : ${pid ?? 'not listening'}`)

const rcon = await Rcon.connect({ host: '127.0.0.1', port, password })
console.log('rcon             : connected')
const players = await rcon.send('list')
console.log(`players          : ${players.trim()}`)
console.log(`save-all flush   : ${(await rcon.send('save-all flush')).trim()}`)
// `stop` closes the connection from the server side; that is a success, not an
// error, so the rejection it produces is expected and swallowed.
await rcon.send('stop').catch(() => {})
rcon.end().catch(() => {})
console.log('stop             : sent')

const deadline = Date.now() + 180_000
let alive = true
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000))
  if (listenerPid(gamePort) === null) {
    alive = false
    break
  }
}
if (alive) {
  console.log('RESULT           : still listening after 180 s, NOT killed, left running')
  process.exit(1)
}
console.log(`RESULT           : exited cleanly after ${Math.round((Date.now() - (deadline - 180_000)) / 1000)} s`)
