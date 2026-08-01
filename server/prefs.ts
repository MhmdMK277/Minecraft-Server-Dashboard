import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Dashboard-wide preferences the operator sets, as opposed to per-server
 * settings (server/serversettings.ts) or operator judgements about a
 * directory (config.json).
 *
 * There is exactly one so far, and it is here rather than in config.json
 * because it is a privacy decision rather than a piece of configuration:
 *
 * `playerAvatars` sends player names off this machine. With it on, the
 * BROWSER fetches each avatar directly from a third party, so that third
 * party learns the names on your server and the IP of whoever is looking at
 * the dashboard. That is a real cost for a decorative gain, so it is off
 * until someone turns it on, and the UI states the cost next to the switch
 * rather than in a settings page nobody reads.
 *
 * The switch is not the only defence. While it is off, the Content-Security
 * Policy does not name the avatar host at all, so the browser refuses the
 * request even if some future bug in the UI tries to make it. A preference
 * that only hides a feature is a preference one bug away from being
 * meaningless; this one removes the permission.
 *
 * The host is a single hardcoded constant. It is deliberately not
 * configurable: an operator-supplied URL would be an operator-supplied entry
 * in our own CSP, which is a way of saying "no CSP".
 */

/**
 * The one avatar service, chosen and stated.
 *
 * It takes a NAME, not a UUID, which matters: services that key on UUID
 * would force a second third party into the path to resolve name to UUID
 * first, and two parties learning your player list is worse than one.
 *
 * Measured, not assumed: it answers 404 for a name that does not resolve to
 * a Mojang account, rather than quietly returning a default skin. That is
 * the better behaviour for us, because it means an offline-mode server's
 * invented names produce a placeholder WE draw, labelled as unresolved,
 * instead of a stranger's face that looks like a real answer.
 */
export const AVATAR_ORIGIN = 'https://minotar.net'
export const avatarUrl = (name: string, size = 32): string =>
  `${AVATAR_ORIGIN}/avatar/${encodeURIComponent(name)}/${size}.png`

export type Prefs = {
  version: 1
  /** Off until an admin turns it on. See the note above. */
  playerAvatars: boolean
  updatedAt: string | null
  updatedBy: string | null
}

export const PREFS_FILE = 'prefs.json'

export function prefsPath(dataDir: string): string {
  return join(dataDir, PREFS_FILE)
}

export function defaultPrefs(): Prefs {
  return { version: 1, playerAvatars: false, updatedAt: null, updatedBy: null }
}

/**
 * Absent, empty or corrupt all mean the same thing: off.
 *
 * The opposite of the backup policy's fail-safe rule, and for the same
 * reason. There, silence had to mean "keep backing this up", because the
 * irreversible outcome was losing a world. Here the irreversible outcome is
 * a name having left the machine, so silence has to mean "send nothing".
 */
export function loadPrefs(dataDir: string): Prefs {
  const p = prefsPath(dataDir)
  if (!existsSync(p)) return defaultPrefs()
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<Prefs>
    return {
      version: 1,
      playerAvatars: raw.playerAvatars === true,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : null,
    }
  } catch {
    return defaultPrefs()
  }
}

export function setPlayerAvatars(dataDir: string, on: boolean, by: string): Prefs {
  const next: Prefs = {
    version: 1,
    playerAvatars: on,
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  }
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch {
    /* best effort */
  }
  // Same atomic write as every other file in the data directory: a torn
  // prefs.json must never be able to read as "avatars were on".
  const p = prefsPath(dataDir)
  const tmp = `${p}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, p)
  return next
}
