import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * server.properties reader.
 *
 * SECURITY: this is the only place rcon.password is read. The value is returned
 * to callers inside the main process and must never be placed on any object
 * that crosses the IPC bridge. See shared/ipc.ts -- ServerStatus has no
 * credential field.
 */
export type Props = Record<string, string>

export function readProperties(path: string): Props {
  if (!existsSync(path)) return {}
  const out: Props = {}
  const text = readFileSync(path, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#') || !s.includes('=')) continue
    const i = s.indexOf('=')
    const k = s.slice(0, i).trim()
    // Java .properties escapes ':' and '=' in values (level-type=minecraft\:normal)
    const v = s
      .slice(i + 1)
      .trim()
      .replace(/\\:/g, ':')
      .replace(/\\=/g, '=')
    out[k] = v
  }
  return out
}

export function serverProps(dir: string): Props {
  return readProperties(join(dir, 'server.properties'))
}

export function gamePortOf(dir: string): number | null {
  const n = Number(serverProps(dir)['server-port'])
  return Number.isFinite(n) && n > 0 ? n : null
}

export type RconConfig = { port: number; password: string } | null

/** Returns credentials for main-process use only. Never expose the result. */
export function rconConfig(dir: string): RconConfig {
  const p = serverProps(dir)
  if ((p['enable-rcon'] ?? 'false').toLowerCase() !== 'true') return null
  const port = Number(p['rcon.port'])
  const password = p['rcon.password'] ?? ''
  if (!Number.isFinite(port) || port <= 0 || !password) return null
  return { port, password }
}

/**
 * World folders, driven by level-name. Spec §6.
 *
 * Hardcoding "world" only ever worked because Windows is case-insensitive and
 * GTNH happens to use "World"; it breaks outright on any other name. 1.7.10
 * also keeps dimensions INSIDE the world folder (World/DIM-1, World/DIM94)
 * rather than beside it, so the _nether/_the_end siblings simply do not exist
 * there and are skipped.
 */
export function worldDirs(dir: string): string[] {
  const name = serverProps(dir)['level-name'] || 'world'
  const out: string[] = []
  for (const cand of [name, `${name}_nether`, `${name}_the_end`]) {
    const p = join(dir, cand)
    try {
      if (statSync(p).isDirectory()) out.push(cand)
    } catch {
      /* not present */
    }
  }
  return out
}

export function levelDatPath(dir: string): string | null {
  for (const w of worldDirs(dir)) {
    const p = join(dir, w, 'level.dat')
    if (existsSync(p)) return p
  }
  const fallback = join(dir, 'world', 'level.dat')
  return existsSync(fallback) ? fallback : null
}

/** Platform detection from directory contents. Decides the TPS command. */
export function detectKind(dir: string): 'paper' | 'forge-modern' | 'forge-1710' | 'vanilla' | 'unknown' {
  const has = (f: string) => existsSync(join(dir, f))
  if (has('paper.jar')) return 'paper'
  if (has('lwjgl3ify-forgePatches.jar')) return 'forge-1710'
  try {
    if (statSync(join(dir, 'plugins')).isDirectory()) return 'paper'
  } catch {
    /* no plugins dir */
  }
  if (existsSync(join(dir, 'libraries', 'net', 'minecraftforge'))) return 'forge-modern'
  try {
    if (statSync(join(dir, 'mods')).isDirectory()) return 'forge-modern'
  } catch {
    /* no mods dir */
  }
  /**
   * Last and weakest: this dashboard's own creation journal, checked only
   * after every real marker has said nothing. Vanilla is the platform with
   * NO on-disk marker of its own (no plugins/, no mods/, no loader jar;
   * telling a vanilla server.jar apart from anything else means unzipping
   * it), so a server this dashboard created read "unknown" forever
   * (2026-08-06, found by the operator on a server the dashboard itself
   * downloaded and journaled). The journal is a normal file living in the
   * folder, written at creation and never consulted as a registry: real
   * markers above win precisely because an operator can swap jars in a
   * folder and the journal would then be stale evidence.
   */
  try {
    const j = JSON.parse(readFileSync(join(dir, '.mcdash-creation.json'), 'utf8')) as {
      state?: unknown
      flavor?: unknown
    }
    if (j.state === 'complete') {
      if (j.flavor === 'vanilla') return 'vanilla'
      if (j.flavor === 'paper') return 'paper'
      if (j.flavor === 'forge' || j.flavor === 'neoforge') return 'forge-modern'
    }
  } catch {
    /* no journal, or not ours: not created here */
  }
  return 'unknown'
}

export function listDirectories(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}
