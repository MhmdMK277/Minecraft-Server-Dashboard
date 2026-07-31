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
  console.error(e instanceof Error ? e.stack : e)
  process.exit(1)
})
