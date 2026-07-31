import { networkInterfaces } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Socket } from 'node:net'

/**
 * Address discovery for the connection table.
 *
 * Nothing here is hardcoded. The LAN address comes from the active adapter
 * because this machine is on Wi-Fi today and moving to Ethernet later, which
 * will change it. The public address comes from an external service because the
 * router does not expose it (NMC.getWANStatus returns link state but no IP),
 * and because the outside view is the truthful one anyway.
 */

/** Best-guess LAN IPv4: a non-internal address on an up interface. */
export function lanAddress(): { address: string; iface: string } | null {
  const ifaces = networkInterfaces()
  const candidates: Array<{ address: string; iface: string; score: number }> = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      // Prefer real private ranges; deprioritise link-local and virtual adapters.
      let score = 0
      if (/^192\.168\./.test(a.address)) score += 30
      else if (/^10\./.test(a.address)) score += 25
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 20
      if (/^169\.254\./.test(a.address)) score -= 100
      if (/ethernet/i.test(name)) score += 6
      if (/wi-?fi|wlan/i.test(name)) score += 4
      if (/vethernet|virtualbox|vmware|hyper-v|loopback|docker|wsl/i.test(name)) score -= 50
      candidates.push({ address: a.address, iface: name, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  return best && best.score > 0 ? { address: best.address, iface: best.iface } : null
}

export type PublicIpState = {
  /** null while unknown or unreachable. */
  address: string | null
  /** The value before the most recent change, if it changed this session. */
  previous: string | null
  changed: boolean
  fetchedAt: string | null
  stale: boolean
  error: string | null
  /**
   * Set once DDNS exists. When present the UI prefers it over the raw IP, and
   * the "it changes without warning" problem goes away.
   */
  hostname: string | null
}

const SOURCES = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com']

let state: PublicIpState = {
  address: null,
  previous: null,
  changed: false,
  fetchedAt: null,
  stale: true,
  error: null,
  hostname: null, // DDNS goes here later; nothing else needs to change
}

export function publicIp(): PublicIpState {
  return { ...state }
}

export async function refreshPublicIp(timeoutMs = 6000): Promise<PublicIpState> {
  for (const url of SOURCES) {
    try {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), timeoutMs)
      const res = await fetch(url, { signal: ac.signal })
      clearTimeout(t)
      if (!res.ok) continue
      const text = (await res.text()).trim()
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) continue

      const prior = state.address
      state = {
        address: text,
        previous: prior && prior !== text ? prior : state.previous,
        // Sticky: once it changes the banner stays until acknowledged, because
        // everything downstream breaks silently and quietly clearing the
        // warning would defeat the point.
        changed: state.changed || (prior !== null && prior !== text),
        fetchedAt: new Date().toISOString(),
        stale: false,
        error: null,
        hostname: state.hostname,
      }
      return publicIp()
    } catch (e) {
      state = { ...state, error: e instanceof Error ? e.message : 'fetch failed' }
    }
  }
  // Every source failed: keep the last known value but mark it stale rather
  // than blanking the table.
  state = { ...state, stale: true }
  return publicIp()
}

export function acknowledgeIpChange(): void {
  state = { ...state, changed: false, previous: null }
}

/**
 * Dynmap web port, read from the plugin's own config rather than assumed.
 * Returns null when the plugin is not present at all.
 */
export function dynmapPort(serverDir: string): number | null {
  const cfg = join(serverDir, 'plugins', 'dynmap', 'configuration.txt')
  if (!existsSync(cfg)) return null
  try {
    const text = readFileSync(cfg, 'utf8')
    const m = text.match(/^\s*webserver-port:\s*(\d+)/m)
    const disabled = /^\s*disable-webserver:\s*true/m.test(text)
    if (disabled || !m) return null
    return Number(m[1])
  } catch {
    return null
  }
}

/** Is anything actually listening? MC 1.21.11 has 8124 configured but dead. */
export function portResponds(port: number, host = '127.0.0.1', timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new Socket()
    let done = false
    const finish = (v: boolean) => {
      if (done) return
      done = true
      s.destroy()
      resolve(v)
    }
    s.setTimeout(timeoutMs)
    s.once('connect', () => finish(true))
    s.once('timeout', () => finish(false))
    s.once('error', () => finish(false))
    s.connect(port, host)
  })
}
