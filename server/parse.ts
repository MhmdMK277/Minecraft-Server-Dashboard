/**
 * Pure parsers. No I/O, so they can be tested directly against the fixtures
 * captured from the live servers.
 *
 * Every rule here exists because the naive version was wrong in production.
 * See docs/liveness-spec.md.
 */

/** Minecraft section-sign colour codes. Spec §5. */
const COLOUR = /§./g

/**
 * Strip colour codes before ANY numeric parse.
 *
 * MC 1.21.11 returns "§6There are §c0§6 out of maximum §c30§6 players online."
 * A regex looking for digits near "of" matches the 6 in "§6" and reports six
 * phantom players.
 */
export function stripColour(s: string): string {
  return s.replace(COLOUR, '')
}

/**
 * Player count from `list`.
 *
 * Three formats in play across four servers (spec §7):
 *   1.21.4 / Skyblock : "There are 0 of a max of 20 players online:"
 *   1.21.11           : colour-coded, "... 0 out of maximum 30 ..."
 *   GTNH (1.7.10)     : "There are 0/20 players online:"
 *
 * The "of|out of" fallback does NOT match GTNH's slash form, which is why
 * "There are N" is tried first.
 */
export function parsePlayerCount(raw: string): { online: number | null; max: number | null } {
  const s = stripColour(raw)
  const slash = s.match(/There are\s+(\d+)\s*\/\s*(\d+)/i)
  if (slash) return { online: Number(slash[1]), max: Number(slash[2]) }

  const there = s.match(/There are\s+(\d+)/i)
  const max = s.match(/(?:max(?:imum)?(?:\s+of)?)\s+(\d+)/i)
  if (there) return { online: Number(there[1]), max: max ? Number(max[1]) : null }

  const loose = s.match(/(\d+)\s*(?:of|out of)/i)
  return { online: loose ? Number(loose[1]) : null, max: max ? Number(max[1]) : null }
}

/** Player names from `list`, which follow the colon. */
export function parsePlayerNames(raw: string): string[] {
  const s = stripColour(raw)
  const idx = s.indexOf(':')
  if (idx < 0) return []
  return s
    .slice(idx + 1)
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && !/^\s*$/.test(x))
}

export type TpsParsed = {
  overall: number | null
  windows: number[] | null
  dimensions: number | null
}

/**
 * TPS, per platform. The command must be chosen from the detected kind and
 * never probed blindly -- `tps` on 1.7.10 is a DIFFERENT command that replies
 * "You must specify which player you wish to perform this action on." and a
 * naive parser will happily treat that as a reading. Spec §7.
 */
export function parseTps(kind: string, raw: string): TpsParsed | null {
  const s = stripColour(raw)

  if (/unknown or incomplete command/i.test(s)) return null
  if (/you must specify which player/i.test(s)) return null // 1.7.10 bare `tps`

  if (kind === 'paper') {
    // "TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0"
    const m = s.match(/TPS from last[^:]*:\s*([\d.,\s*]+)/i)
    if (!m) return null
    const windows = (m[1] ?? '')
      .split(',')
      .map((x) => Number(x.replace('*', '').trim()))
      .filter((x) => Number.isFinite(x))
    const first = windows[0]
    if (first === undefined) return null
    return { overall: first, windows, dimensions: null }
  }

  if (kind === 'forge-1710') {
    // CoFH: "Overall: 20.00 TPS/0.94MS (100%)Overworld [0]: 20.00 TPS/..."
    const overall = s.match(/Overall:\s*([\d.]+)\s*TPS/i)
    const dims = (s.match(/\[-?\d+\]:/g) ?? []).length
    if (overall) {
      return { overall: Number(overall[1]), windows: null, dimensions: dims || null }
    }
    // forge tps fallback: numeric dims, lines CONCATENATED without separators
    return parseForgeMeanTps(s)
  }

  // forge-modern: "Dim minecraft:overworld (...): Mean tick time: 0.7 ms. Mean TPS: 20.000"
  return parseForgeMeanTps(s)
}

/**
 * Shared by both Forge eras. GTNH concatenates its per-dimension lines with no
 * separator ("...20.000Dim 93 :..."), so this must scan globally rather than
 * split on newlines.
 */
function parseForgeMeanTps(s: string): TpsParsed | null {
  const all = [...s.matchAll(/Mean TPS:\s*([\d.]+)/gi)].map((m) => Number(m[1]))
  if (!all.length) return null
  const overallLine = s.match(/Overall\s*:\s*Mean TPS:\s*([\d.]+)/i)
  const overall = overallLine ? Number(overallLine[1]) : Math.min(...all)
  return { overall, windows: null, dimensions: all.length }
}

/** Which TPS command is valid for this platform. Never probe blindly. */
export function tpsCommandFor(kind: string): string | null {
  switch (kind) {
    case 'paper':
      return 'tps'
    case 'forge-modern':
      return 'forge tps'
    case 'forge-1710':
      return 'cofh tps' // only source of an "Overall" figure on GTNH
    default:
      return null
  }
}

/**
 * Placeholder detection. GTNH answers pings for ~40s while still loading with
 * "Server is still starting! Please wait before reconnecting." Treating that as
 * ready declared the server up 40 seconds early. Spec §4.
 */
const NOT_READY = ['still starting', 'starting up', 'please wait']

export function pingIsReady(status: unknown): boolean {
  if (!status || typeof status !== 'object') return false
  const s = status as Record<string, unknown>
  const v = s.version
  const name =
    v && typeof v === 'object'
      ? String((v as Record<string, unknown>).name ?? '')
      : typeof v === 'string'
        ? v
        : ''
  const d = s.description
  const desc =
    typeof d === 'string'
      ? d
      : d && typeof d === 'object'
        ? String((d as Record<string, unknown>).text ?? '')
        : ''
  const blob = `${name} ${desc}`.toLowerCase()
  return !NOT_READY.some((mk) => blob.includes(mk))
}

/**
 * Normalise an SLP payload AT THE PARSE SITE. Spec §3.
 *
 * Modern servers return an object. GTNH returns the payload double-encoded, so
 * JSON.parse yields a string and every property access on it throws. Guarding
 * downstream was tried twice and failed identically both times; the fix belongs
 * here so callers always receive an object.
 */
export function normaliseSlpPayload(text: string): Record<string, unknown> {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { version: { name: text } }
  }
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      return { version: { name: data } }
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { version: { name: String(data) } }
  }
  return data as Record<string, unknown>
}

/** MOTD can be a string, a {text}, or a chat component tree. */
export function extractMotd(desc: unknown): string | null {
  if (typeof desc === 'string') return stripColour(desc)
  if (!desc || typeof desc !== 'object') return null
  const d = desc as Record<string, unknown>
  let out = typeof d.text === 'string' ? d.text : ''
  if (Array.isArray(d.extra)) {
    for (const part of d.extra) out += extractMotd(part) ?? ''
  }
  return out ? stripColour(out) : null
}
