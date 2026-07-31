import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * App configuration.
 *
 * NOTHING about one particular machine may be baked into this codebase. The
 * first version of discovery.ts shipped with
 *
 *     const OVERRIDES = { 'MC Tech': 'retired', 'MC 1.21.4 - Copy': 'stale' }
 *
 * which is worse than useless for anyone else: their directories would never be
 * classified, and someone who happened to name a directory "MC Tech" would find
 * it silently marked retired. Those are operator judgements about one install,
 * so they live in that operator's config file, not in the source.
 *
 * Resolution order for the servers root, first hit wins:
 *   1. MCDASH_SERVERS_ROOT environment variable
 *   2. `serversRoot` in <userData>/config.json
 *   3. the conventional Documents/MC Servers, as a starting guess only
 *
 * The third is a default, not an assumption: if it does not exist the UI says
 * so and asks for a path rather than showing an empty list as though the user
 * had no servers.
 */

export type Classification = 'live' | 'retired' | 'stale' | 'not-a-server'

export type AppConfig = {
  serversRoot: string
  /** Operator judgements the app cannot infer. Keyed by directory name. */
  classificationOverrides: Record<string, Classification>
  /**
   * Where an external backup system writes, if the user has one. Used only to
   * surface its status -- the dashboard never writes here. See
   * docs/decisions/0001-backups.md.
   */
  externalBackupPaths: string[]
  serversRootExists: boolean
  source: 'env' | 'config' | 'default'
}

function defaultRoot(): string {
  return join(homedir(), 'Documents', 'MC Servers')
}

const APP_DIR = 'minecraft-server-dashboard'

/**
 * Where the app keeps config, sessions and the audit log.
 *
 * These are the same locations Electron's `app.getPath('userData')` returned, so
 * an existing config.json is picked up unchanged after the web pivot rather than
 * silently ignored -- an ignored config would present as "no servers found",
 * which looks like a discovery bug and is the sort of thing someone debugs for
 * an hour.
 *
 * MCDASH_DATA_DIR overrides everything, which is what a systemd unit or a
 * container bind-mount will use.
 */
export function dataDir(): string {
  const env = process.env.MCDASH_DATA_DIR?.trim()
  if (env) return env
  const home = homedir()
  switch (process.platform) {
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), APP_DIR)
    case 'darwin':
      return join(home, 'Library', 'Application Support', APP_DIR)
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), APP_DIR)
  }
}

export function configPath(userData: string): string {
  return join(userData, 'config.json')
}

export function loadConfig(userData: string): AppConfig {
  let fromFile: Partial<AppConfig> = {}
  const p = configPath(userData)
  if (existsSync(p)) {
    try {
      fromFile = JSON.parse(readFileSync(p, 'utf8')) as Partial<AppConfig>
    } catch {
      // A corrupt config must not stop the app from starting.
      fromFile = {}
    }
  }

  const env = process.env.MCDASH_SERVERS_ROOT?.trim()
  let serversRoot: string
  let source: AppConfig['source']
  if (env) {
    serversRoot = env
    source = 'env'
  } else if (typeof fromFile.serversRoot === 'string' && fromFile.serversRoot.trim()) {
    serversRoot = fromFile.serversRoot
    source = 'config'
  } else {
    serversRoot = defaultRoot()
    source = 'default'
  }

  try {
    mkdirSync(userData, { recursive: true })
  } catch {
    /* best effort */
  }

  return {
    serversRoot,
    classificationOverrides: isRecord(fromFile.classificationOverrides)
      ? (fromFile.classificationOverrides as Record<string, Classification>)
      : {},
    externalBackupPaths: Array.isArray(fromFile.externalBackupPaths)
      ? fromFile.externalBackupPaths.filter((x): x is string => typeof x === 'string')
      : [],
    serversRootExists: existsSync(serversRoot),
    source,
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
