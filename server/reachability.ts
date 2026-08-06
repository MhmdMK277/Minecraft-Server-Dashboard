import { networkInterfaces } from 'node:os'
import { execFile } from 'node:child_process'
import { serverProps } from './properties'
import { portResponds } from './network'

/**
 * What "can my friends connect" can honestly be answered from this machine,
 * and what cannot.
 *
 * Found 2026-08-06, the project's worst false-confident reading so far: a
 * newly created server had server-ip set to the operator's PUBLIC address so
 * the JVM could not bind at all, there was no firewall rule for its port and
 * no router forward, and the Addresses page composed a public address out of
 * config values and offered it with a copy button. The page whose entire
 * premise is naming which of the four failure points is broken named none of
 * them. Same class as findings F6 and F7: presentation of an unverified
 * reading as fact.
 *
 * The four failure points, and this module's stance on each:
 *
 *   1. process listening    MEASURED: a TCP connect to the port, on loopback
 *                           and on the LAN address, because a server pinned
 *                           to one interface answers only one of them.
 *   2. bind address         MEASURED: server-ip compared against the
 *                           addresses this machine actually holds. A value
 *                           the machine does not hold cannot be bound, and
 *                           the JVM dies trying; this is checkable in one
 *                           interface enumeration and worth one sentence.
 *   3. Windows firewall     READ from the enabled inbound allow rules. When
 *                           the read fails it is reported UNCHECKED, in
 *                           those words; a guess in either direction is the
 *                           false reading this module exists to prevent.
 *   4. router port forward  NOT VERIFIABLE from inside the network, and the
 *                           page says so instead of implying otherwise. The
 *                           router is read-only territory by standing rule,
 *                           and NAT hairpinning makes an inside probe of the
 *                           outside address a coin toss on home routers.
 *
 * Assembly is a pure function (assembleReachability) so the proof can walk
 * every verdict without a socket or a firewall in the loop; the IO wrappers
 * around it stay thin.
 */

export type BindState = { address: string; held: boolean } | null

/**
 * Classify a server.properties `server-ip` against the machine's addresses.
 * Null means unset or a wildcard: the normal case, binds everything.
 */
export function classifyBind(serverIp: string | null | undefined, heldAddresses: string[]): BindState {
  const v = (serverIp ?? '').trim()
  if (v === '' || v === '0.0.0.0' || v === '::' || v === '::0') return null
  const held = heldAddresses.some((a) => a.trim().toLowerCase() === v.toLowerCase())
  return { address: v, held }
}

/** Every IP address this machine currently holds, v4 and v6, including loopback. */
export function machineAddresses(): string[] {
  const out: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) out.push(a.address)
  }
  return out
}

/**
 * Does a firewall rule's LocalPorts string cover a port? Shapes seen in real
 * rule stores: "25565", "80,443", "1000-2000", "*", and keyword values like
 * "RPC" that name no numeric range and never cover a game port.
 */
export function portCovered(localPorts: string, port: number): boolean {
  const s = (localPorts ?? '').trim()
  if (s === '*') return true
  for (const part of s.split(',')) {
    const p = part.trim()
    if (/^\d+$/.test(p) && Number(p) === port) return true
    const m = /^(\d+)-(\d+)$/.exec(p)
    if (m && Number(m[1]) <= port && port <= Number(m[2])) return true
  }
  return false
}

export type FirewallRule = { name: string; localPorts: string; app: string | null; profiles: number }

export type FirewallReading =
  | {
      checked: true
      /** Whether the firewall is on for the CURRENT profile(s). Off means nothing is blocked. */
      enabledForCurrentProfile: boolean
      currentProfiles: number
      rules: FirewallRule[]
    }
  | { checked: false; why: string }

/**
 * Read the enabled inbound TCP allow rules and the firewall's on/off state,
 * via the firewall's own COM object rather than netsh, whose output is
 * localized and unparseable across languages. Failure returns checked:false;
 * the caller must render that as "could not check", never as either verdict.
 */
export function readFirewall(timeoutMs = 15_000): Promise<FirewallReading> {
  const script =
    "$fw = New-Object -ComObject HNetCfg.FwPolicy2; " +
    '$cur = [int]$fw.CurrentProfileTypes; ' +
    '$on = $false; foreach ($p in 1,2,4) { if (($cur -band $p) -ne 0 -and $fw.FirewallEnabled($p)) { $on = $true } }; ' +
    '$rules = @(); foreach ($r in $fw.Rules) { ' +
    'if ($r.Enabled -and $r.Direction -eq 1 -and $r.Action -eq 1 -and $r.Protocol -eq 6) { ' +
    "$rules += @{ name = [string]$r.Name; localPorts = [string]$r.LocalPorts; app = [string]$r.ApplicationName; profiles = [int]$r.Profiles } } }; " +
    '@{ currentProfiles = $cur; enabled = $on; rules = $rules } | ConvertTo-Json -Compress -Depth 3'
  return new Promise((done) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return done({ checked: false, why: err.message })
        try {
          const j = JSON.parse(stdout.trim()) as {
            currentProfiles?: unknown
            enabled?: unknown
            rules?: Array<{ name?: unknown; localPorts?: unknown; app?: unknown; profiles?: unknown }>
          }
          done({
            checked: true,
            enabledForCurrentProfile: j.enabled === true,
            currentProfiles: Number(j.currentProfiles) || 0,
            rules: (Array.isArray(j.rules) ? j.rules : []).map((r) => ({
              name: String(r.name ?? ''),
              localPorts: String(r.localPorts ?? ''),
              app: r.app ? String(r.app) : null,
              profiles: Number(r.profiles) || 0,
            })),
          })
        } catch (e) {
          done({ checked: false, why: e instanceof Error ? e.message : 'unparseable firewall reading' })
        }
      },
    )
  })
}

export type ServerReachability = {
  id: string
  gamePort: number | null
  /** TCP connect results. Null when there was no port to probe. */
  listening: { loopback: boolean; lan: boolean | null } | null
  bind: BindState
  /** Null when the firewall was off, unchecked, or there was no port. */
  firewallRule: string | null
  /**
   * The measured failure points, each as one sentence naming its check.
   * Empty means every point this machine can measure passed; the router
   * remains unverifiable and is stated page-wide, not per server.
   */
  problems: Array<{ point: 'process' | 'bind' | 'firewall'; detail: string }>
  /** False when any measured point failed: the page must not offer addresses. */
  usable: boolean
}

export type ReachabilityInputs = {
  id: string
  gamePort: number | null
  serverIp: string | null
  heldAddresses: string[]
  loopback: boolean | null
  lanProbe: boolean | null
  firewall: FirewallReading
}

/** The verdict, pure. Every sentence names the check that produced it. */
export function assembleReachability(x: ReachabilityInputs): ServerReachability {
  const problems: ServerReachability['problems'] = []
  const bind = classifyBind(x.serverIp, x.heldAddresses)

  if (bind && !bind.held) {
    problems.push({
      point: 'bind',
      detail:
        `server-ip is set to ${bind.address}, an address this machine does not hold on any network interface ` +
        `(compared against all of them just now). The server cannot bind to it and will not accept connections ` +
        `anywhere until the server-ip line in server.properties is cleared and the server restarted.`,
    })
  }

  const answered = x.loopback === true || x.lanProbe === true
  if (x.gamePort !== null && !answered) {
    problems.push({
      point: 'process',
      detail:
        `Nothing answered a TCP connection to port ${x.gamePort} on this machine just now` +
        `${bind && !bind.held ? ', which follows from the server-ip problem above' : ''}. ` +
        `Until the server is running and listening, no address on this page can work.`,
    })
  }

  let firewallRule: string | null = null
  const fw = x.firewall
  if (x.gamePort !== null && fw.checked && fw.enabledForCurrentProfile) {
    // A rule applies when its profile mask overlaps the profiles active right
    // now; the store's "all profiles" value is a full mask, so overlap covers it.
    // An app-scoped rule opens the port for THAT PROGRAM only: the first live
    // run of this check matched Microsoft Teams' any-port rule for a Java
    // server, a verdict that would be wrong for every port on the machine.
    // Program rules count only when the program is a Java executable.
    const appliesToServer = (r: FirewallRule) =>
      r.app === null || r.app === '' || /\\javaw?\.exe$/i.test(r.app)
    const rule = fw.rules.find(
      (r) =>
        appliesToServer(r) && portCovered(r.localPorts, x.gamePort!) && (r.profiles & fw.currentProfiles) !== 0,
    )
    firewallRule = rule?.name ?? null
    if (!rule) {
      problems.push({
        point: 'firewall',
        detail:
          `Windows Firewall is on and none of its enabled inbound allow rules covers TCP ${x.gamePort} ` +
          `(read from the firewall's own rule store just now). Connections from other machines, including ` +
          `your own network, will be blocked. The desktop address still works: loopback is not filtered.`,
      })
    }
  } else if (x.gamePort !== null && !x.firewall.checked) {
    problems.push({
      point: 'firewall',
      detail:
        `The firewall rules could not be read (${x.firewall.why}), so whether TCP ${x.gamePort} is allowed ` +
        `through Windows Firewall is UNCHECKED, not verified. The addresses may work; this page cannot say.`,
    })
  }

  return {
    id: x.id,
    gamePort: x.gamePort,
    listening: x.gamePort === null ? null : { loopback: x.loopback === true, lan: x.lanProbe },
    bind,
    firewallRule,
    problems,
    usable: problems.length === 0,
  }
}

/**
 * The IO wrapper: one firewall read shared across the fleet, one bind read
 * and up to two TCP probes per server. On demand only; this never runs on
 * the ten-second scan.
 */
export async function reachabilityFor(
  servers: Array<{ id: string; dir: string; gamePort: number | null }>,
  lanAddress: string | null,
): Promise<{ checkedAt: string; servers: ServerReachability[] }> {
  const firewall = await readFirewall()
  const held = machineAddresses()
  const out: ServerReachability[] = []
  for (const s of servers) {
    const props = serverProps(s.dir)
    const serverIp = typeof props['server-ip'] === 'string' ? props['server-ip'] : null
    const loopback = s.gamePort !== null ? await portResponds(s.gamePort, '127.0.0.1') : null
    const lanProbe = s.gamePort !== null && lanAddress ? await portResponds(s.gamePort, lanAddress) : null
    out.push(
      assembleReachability({
        id: s.id,
        gamePort: s.gamePort,
        serverIp,
        heldAddresses: held,
        loopback,
        lanProbe,
        firewall,
      }),
    )
  }
  return { checkedAt: new Date().toISOString(), servers: out }
}
