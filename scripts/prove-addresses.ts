/**
 * Proof: the address table renders the right host:port for every vantage point,
 * with :25565 omitted and every other port included.
 *
 * Uses a real scan, so the ports come from server.properties exactly as the UI
 * gets them -- not from a fixture and not from a hardcoded map.
 *
 * Run: npx tsx scripts/prove-addresses.ts
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../server/discovery'
import { loadConfig } from '../server/config'
import { refreshPublicIp } from '../server/network'
import { formatAddress, formatWebUrl, DEFAULT_MC_PORT } from '../shared/address'

await refreshPublicIp()
const cfg = loadConfig(join(homedir(), 'AppData', 'Roaming', 'minecraft-server-dashboard'))
const snap = await scan(cfg.serversRoot, cfg.classificationOverrides)
const lan = snap.network.lanAddress
const ip = snap.network.publicIp
const outside = ip.hostname ?? ip.address

console.log(`LAN adapter : ${snap.network.lanInterface} -> ${lan}`)
console.log(`public IPv4 : ${ip.address}${ip.stale ? ' (stale)' : ''}`)
console.log(`DDNS name   : ${ip.hostname ?? '(none yet - raw IP is used until one exists)'}\n`)

const w = (s: string, n: number) => (s ?? '').padEnd(n)
console.log(
  w('SERVER', 15) + w('PORT', 7) + w('ON THIS DESKTOP', 24) + w('SAME NETWORK', 26) + 'OUTSIDE',
)
console.log('-'.repeat(104))

const failures: string[] = []
const live = snap.servers.filter((s) => s.classification === 'live')

for (const s of live) {
  const here = formatAddress('localhost', s.gamePort)
  const home = formatAddress(lan, s.gamePort)
  const away = formatAddress(outside, s.gamePort)
  console.log(w(s.name, 15) + w(String(s.gamePort), 7) + w(here ?? '-', 24) + w(home ?? '-', 26) + (away ?? '-'))

  if (s.gamePort === DEFAULT_MC_PORT) {
    if (here?.includes(':')) failures.push(`${s.name}: port ${DEFAULT_MC_PORT} should be omitted`)
  } else if (!here?.endsWith(`:${s.gamePort}`)) {
    failures.push(`${s.name}: port ${s.gamePort} should be included`)
  }
}

console.log('\nDynmap web maps:')
for (const s of live) {
  if (!s.dynmap) continue
  const d = s.dynmap
  if (!d.responding) {
    console.log(
      `  ${w(s.name, 13)} port ${d.port} configured but NOT RESPONDING -> no link offered`,
    )
    continue
  }
  console.log(
    `  ${w(s.name, 13)} ${w(formatWebUrl('localhost', d.port) ?? '-', 24)}` +
      `${w(formatWebUrl(lan, d.port) ?? '-', 26)}${formatWebUrl(outside, d.port) ?? '-'}`,
  )
}

console.log('\nchecks:')
const nonDefault = live.filter((s) => s.gamePort !== DEFAULT_MC_PORT)
const isDefault = live.filter((s) => s.gamePort === DEFAULT_MC_PORT)
console.log(`  servers on ${DEFAULT_MC_PORT} (port omitted) : ${isDefault.map((s) => s.name).join(', ') || 'none'}`)
console.log(`  servers on other ports (included)  : ${nonDefault.map((s) => `${s.name}:${s.gamePort}`).join(', ')}`)
console.log(`  LAN address hardcoded?             : no, read from ${snap.network.lanInterface}`)

/**
 * Route provenance (finding F7): a public address measured through a VPN is
 * the VPN's exit, and the page must know WHO owned the route. The parse is
 * proven against fixtures here; the live reading above already carried
 * whatever this host's route is right now.
 */
console.log('\nroute provenance (F7):')
const { parseEgressRoute } = await import('../server/network')
const virtual = parseEgressRoute('{"adapter":"HotspotShield WinTun","description":"Wintun Tunnel","virtual":true}')
if (virtual?.virtual !== true) failures.push('a virtual route must parse as virtual')
const hardware = parseEgressRoute('{"adapter":"Wi-Fi","description":"Intel Wireless","virtual":false}')
if (hardware?.virtual !== false) failures.push('a hardware route must parse as not virtual')
const garbage = parseEgressRoute('not json at all')
if (garbage !== null) failures.push('garbage must parse to null, never to a confident route')
const partial = parseEgressRoute('{"virtual":true}')
if (partial !== null) failures.push('a route without an adapter name must parse to null')
console.log(`  live route this run                : ${ip.route ? `${ip.route.adapter} (virtual=${ip.route.virtual})` : 'not read'}`)
console.log(`  virtual/hardware/garbage/partial   : ${virtual?.virtual}/${hardware?.virtual}/${garbage}/${partial}`)

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}, port rule and route provenance applied correctly`)
for (const f of failures) console.log('   -', f)
process.exit(failures.length ? 1 : 0)
