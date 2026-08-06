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

/**
 * Reachability (2026-08-06): the page must OFFER an address only after the
 * machine-side checks pass, because it once offered a public address for a
 * server that could not bind, had no firewall rule and no router forward,
 * and named none of the three. The verdict assembly is pure, so every state
 * is walked here without a socket or a firewall in the loop; then the real
 * IO path runs once against the live fleet.
 */
console.log('\nreachability verdicts (defect: the confident unusable address):')
const { assembleReachability, classifyBind, portCovered, reachabilityFor } = await import(
  '../server/reachability'
)

// The firewall LocalPorts shapes seen in real rule stores.
if (!portCovered('25570', 25570)) failures.push('a single-port rule must cover its port')
if (portCovered('25570', 25571)) failures.push('a single-port rule must not cover a neighbour')
if (!portCovered('80,443,25570', 25570)) failures.push('a list rule must cover a listed port')
if (!portCovered('25000-26000', 25570)) failures.push('a range rule must cover a port inside it')
if (portCovered('25000-25569', 25570)) failures.push('a range rule must not cover a port outside it')
if (!portCovered('*', 25570)) failures.push('a star rule covers everything')
if (portCovered('RPC', 25570)) failures.push('a keyword rule names no numeric port and covers nothing')

// Bind classification against a synthetic interface list.
const HELD = ['127.0.0.1', '192.168.0.42', 'fe80::1', '::1']
if (classifyBind('', HELD) !== null) failures.push('an empty server-ip is the normal case, not a finding')
if (classifyBind('0.0.0.0', HELD) !== null) failures.push('a wildcard bind is the normal case')
if (classifyBind('192.168.0.42', HELD)?.held !== true) failures.push('a held address must read held')
if (classifyBind('198.51.100.23', HELD)?.held !== false)
  failures.push('a public IP the machine does not hold must read not-held: the 2026-08-06 misconfiguration shape')

const FW_ON = {
  checked: true as const,
  enabledForCurrentProfile: true,
  currentProfiles: 2,
  rules: [{ name: 'Minecraft Server (TCP 25570)', localPorts: '25570', app: null, profiles: 2147483647 }],
}
const base = {
  id: 's',
  gamePort: 25570,
  serverIp: '',
  heldAddresses: HELD,
  loopback: true,
  lanProbe: true,
  firewall: FW_ON,
  expectRunning: true,
}

const ok = assembleReachability(base)
if (!ok.usable || ok.problems.length > 0) failures.push('all checks passing must read usable')
if (ok.firewallRule !== 'Minecraft Server (TCP 25570)') failures.push('the covering rule is named')

// An app-scoped any-port rule belongs to its program, not to the port. The
// first live run matched Microsoft Teams' rule for a Java server.
const teamsOnly = assembleReachability({
  ...base,
  firewall: {
    ...FW_ON,
    rules: [{ name: 'Microsoft Teams', localPorts: '*', app: 'C:\\Program Files\\Teams\\ms-teams.exe', profiles: 2147483647 }],
  },
})
if (teamsOnly.usable || teamsOnly.firewallRule !== null)
  failures.push("another program's any-port rule must not count as covering the server")
const javaScoped = assembleReachability({
  ...base,
  firewall: {
    ...FW_ON,
    rules: [{ name: 'Java(TM) Platform SE binary', localPorts: '*', app: 'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe', profiles: 2147483647 }],
  },
})
if (!javaScoped.usable || javaScoped.firewallRule !== 'Java(TM) Platform SE binary')
  failures.push('a java-scoped any-port rule does cover the server and is named')

const foreign = assembleReachability({ ...base, serverIp: '203.0.113.47', loopback: false, lanProbe: false })
if (foreign.usable) failures.push('a foreign bind address must never read usable')
if (!foreign.problems.some((p) => p.point === 'bind' && p.detail.includes('does not hold')))
  failures.push('the foreign bind sentence names the check (interfaces compared)')
if (!foreign.problems.some((p) => p.point === 'process'))
  failures.push('nothing listening is its own named failure point')

const dead = assembleReachability({ ...base, loopback: false, lanProbe: false })
if (dead.usable) failures.push('a port nothing answers on must never read usable')
if (!dead.problems.some((p) => p.point === 'process' && p.detail.includes('TCP connection')))
  failures.push('the not-listening sentence names the TCP connect that measured it')

const noRule = assembleReachability({ ...base, firewall: { ...FW_ON, rules: [] } })
if (noRule.usable) failures.push('firewall on with no covering rule must not read usable')
if (!noRule.problems.some((p) => p.point === 'firewall' && p.detail.includes('loopback is not filtered')))
  failures.push('the firewall sentence says the desktop address still works, because it does')

const fwOff = assembleReachability({ ...base, firewall: { ...FW_ON, enabledForCurrentProfile: false } })
if (!fwOff.usable) failures.push('firewall off blocks nothing and must not be reported as a problem')

const unchecked = assembleReachability({
  ...base,
  firewall: { checked: false as const, why: 'powershell timed out' },
})
if (unchecked.usable) failures.push('an unchecked firewall is not a verified pass')
if (!unchecked.problems.some((p) => p.point === 'firewall' && p.detail.includes('UNCHECKED')))
  failures.push('the unchecked sentence says UNCHECKED in those words, never a guessed verdict')

// The real IO path, once, against the live fleet: a server that answered SLP
// in this very scan must not carry a not-listening verdict.
// Never-started servers (defect 4): the checks that are meaningful before a
// first start still run; "nothing answered" is not a finding there, and the
// UNCHECKED firewall state stays distinct from "no rule exists", because
// those two demand different actions from the operator.
const fresh = assembleReachability({ ...base, loopback: null, lanProbe: null, expectRunning: false })
if (!fresh.usable || fresh.problems.some((p) => p.point === 'process'))
  failures.push('a never-started server must not be accused of not listening')
if (fresh.listening !== null) failures.push('no listening claim is made for a server not expected to run')
const freshNoRule = assembleReachability({
  ...base,
  loopback: null,
  lanProbe: null,
  expectRunning: false,
  firewall: { ...FW_ON, rules: [] },
})
if (!freshNoRule.problems.some((p) => p.point === 'firewall' && p.detail.includes('none of its enabled inbound allow rules')))
  failures.push('a never-started server still hears that no firewall rule exists')
const freshUnchecked = assembleReachability({
  ...base,
  loopback: null,
  lanProbe: null,
  expectRunning: false,
  firewall: { checked: false as const, why: 'powershell timed out' },
})
if (!freshUnchecked.problems.some((p) => p.point === 'firewall' && p.detail.includes('UNCHECKED')))
  failures.push('the unchecked state stays distinct from no-rule for a never-started server')
if (
  freshNoRule.problems[0]!.detail === freshUnchecked.problems[0]!.detail
)
  failures.push('no-rule and unchecked must be different sentences: they demand different actions')

const report = await reachabilityFor(
  live.map((s) => ({ id: s.id, dir: s.dir, gamePort: s.gamePort, expectRunning: true })),
  lan,
)
for (const s of live) {
  const r = report.servers.find((x) => x.id === s.id)
  const verdict = r ? (r.usable ? 'usable' : r.problems.map((p) => p.point).join('+')) : 'missing'
  console.log(`  ${w(s.name, 15)} ${verdict}${r?.firewallRule ? `  (rule: ${r.firewallRule})` : ''}`)
  if (s.slp !== null && r?.problems.some((p) => p.point === 'process')) {
    failures.push(`${s.name}: answered SLP this scan but reachability claims nothing is listening`)
  }
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}, port rule, route provenance and reachability verdicts applied correctly`)
for (const f of failures) console.log('   -', f)
process.exit(failures.length ? 1 : 0)
