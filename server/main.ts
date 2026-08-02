import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildServer } from './http'
import { loadConfig, dataDir } from './config'
import { processProvider, knownPlatforms } from './platform'
import { bootstrapIfEmpty } from './auth'

/**
 * Entry point for the self-hosted service.
 *
 * Configuration, in the same first-hit-wins style as the servers root:
 *   MCDASH_HOST   bind address   default 127.0.0.1
 *   MCDASH_PORT   port           default 8422
 *   MCDASH_DATA_DIR, MCDASH_SERVERS_ROOT, MCDASH_TRUST_PROXY  see config.ts
 */

const DEFAULT_PORT = 8422
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

type SysError = NodeJS.ErrnoException & { port?: number; address?: string }

/**
 * Plain-language explanations for the startup failures a first-time user can
 * plausibly hit. The first release's launcher printed a raw
 * "Error: listen EACCES ... 127.0.0.1:8422" stack when a second copy was
 * started while the first held the port, which teaches a new user nothing.
 * Anything not recognised here keeps its stack: a raw trace is bad copy but
 * good evidence, and swallowing it would hide real bugs.
 */
function explainStartupError(e: unknown): string[] | null {
  if (!(e instanceof Error)) return null
  const err = e as SysError

  if (err.syscall === 'listen' && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
    // On Windows a port held by another process surfaces as EACCES, not only
    // EADDRINUSE; EACCES can also mean the port sits in a range Windows has
    // reserved. Both codes get the same advice because the user's next step
    // is the same.
    const port = err.port ?? DEFAULT_PORT
    const addr = !err.address || err.address === '0.0.0.0' ? 'localhost' : err.address
    return [
      err.code === 'EACCES'
        ? `Port ${port} is not available: another program holds it, or Windows has reserved it.`
        : `Port ${port} is not available: another program is already listening on it.`,
      '',
      'If the dashboard is already running, there is nothing to start:',
      `  open http://${addr}:${port} in your browser.`,
      '',
      'Otherwise, close the program that is using the port, or run the',
      'dashboard on a different port by setting the MCDASH_PORT environment',
      'variable.',
    ]
  }

  if (err.syscall === 'listen' && err.code === 'EADDRNOTAVAIL') {
    return [
      `MCDASH_HOST is set to ${err.address ?? 'an address'} but this machine`,
      'has no network interface with that address.',
      '',
      'Use an address this machine owns, 0.0.0.0 for all interfaces, or',
      'unset MCDASH_HOST to serve on 127.0.0.1 only.',
    ]
  }

  if ((err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') && err.path) {
    // Filesystem errors during startup come from the data directory: config,
    // the first-start admin account, sessions. err.syscall distinguishes them
    // from the listen cases above.
    return [
      `Cannot ${err.syscall === 'mkdir' ? 'create' : 'write'} ${err.path}`,
      '',
      'The dashboard keeps its configuration, accounts and sessions there',
      "and cannot start without it. Check the folder's permissions, or set",
      'MCDASH_DATA_DIR to a writable directory.',
    ]
  }

  return null
}

function version(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

async function main(): Promise<void> {
  const provider = processProvider()
  if (!provider.available) {
    // Say plainly what is not implemented and where to raise it, rather than
    // starting up and reporting zero servers -- which looks identical to
    // "you have no servers" and would send someone hunting a discovery bug.
    const u = provider.unavailable!
    console.error('')
    console.error('  Minecraft Server Dashboard cannot run on this platform.')
    console.error('')
    console.error(`  ${u.reason}`)
    console.error('')
    console.error(`  ${u.guidance}`)
    console.error('')
    console.error('  Platform support:')
    for (const p of knownPlatforms()) {
      console.error(`    ${p.available ? 'yes' : ' no'}  ${p.platform.padEnd(7)} ${p.name}`)
    }
    console.error('')
    process.exit(2)
  }

  const cfg = loadConfig(dataDir())
  const host = process.env.MCDASH_HOST?.trim() || '127.0.0.1'
  const port = Number(process.env.MCDASH_PORT ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('')
    console.error(`  MCDASH_PORT is set to "${process.env.MCDASH_PORT}", which is not a`)
    console.error('  usable port. It must be a whole number between 1 and 65535.')
    console.error(`  Unset it to use the default, ${DEFAULT_PORT}.`)
    console.error('')
    process.exit(2)
  }

  // First start: mint one admin and print the password exactly once, before the
  // socket opens. There is deliberately no default password to change later and
  // no credential written anywhere a human can read -- only its scrypt hash
  // reaches disk. If this scrolls past unread, the recovery is to delete
  // auth.json, which is a decision the operator makes on the machine.
  const bootstrap = await bootstrapIfEmpty(dataDir())

  const app = await buildServer({ cfg, version: version() })
  await app.listen({ host, port })

  console.log(`Minecraft Server Dashboard  http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`)
  console.log(`  servers root  ${cfg.serversRoot}${cfg.serversRootExists ? '' : '   (DOES NOT EXIST)'}`)
  console.log(`  data dir      ${dataDir()}`)
  console.log(`  platform      ${provider.name}`)

  if (bootstrap) {
    console.log('')
    console.log('  ─────────────────────────────────────────────────────────────')
    console.log('   FIRST START. An administrator account has been created.')
    console.log('')
    console.log(`     username   ${bootstrap.username}`)
    console.log(`     password   ${bootstrap.password}`)
    console.log('')
    console.log('   This is the only time this password is shown. It is stored')
    console.log('   only as a hash. Sign in and change it; every other session')
    console.log('   is dropped when you do.')
    console.log('  ─────────────────────────────────────────────────────────────')
    console.log('')
  }

  if (!LOOPBACK.has(host)) {
    // The user asked for LAN access deliberately; this is not second-guessing
    // that, it is naming what is exposed.
    console.warn('')
    console.warn(`  WARNING: bound to ${host} and reachable from the network.`)
    console.warn('  Sessions are protected, but this is plain HTTP: anyone who can')
    console.warn('  watch the traffic can take a session cookie. Put it behind a')
    console.warn('  tunnel or a TLS proxy, and do not port-forward it.')
    console.warn('')
  }

  const shutdown = () => {
    void app.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void main().catch((e: unknown) => {
  const explained = explainStartupError(e)
  if (explained) {
    console.error('')
    for (const line of explained) console.error(line ? `  ${line}` : '')
    console.error('')
  } else {
    console.error(e instanceof Error ? e.stack : e)
  }
  process.exit(1)
})
