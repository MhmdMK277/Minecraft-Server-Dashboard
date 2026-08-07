import { platform as hostPlatform } from 'node:os'
import { windowsProvider } from './windows'
import { linuxProvider } from './linux'
import { darwinProvider } from './darwin'
import {
  UnsupportedPlatformError,
  type DirHint,
  type JvmProcess,
  type JvmScan,
  type ProcessProvider,
} from './types'

export type {
  JvmProcess,
  JvmScan,
  ProcessProvider,
  ProviderUnavailable,
  DirHint,
  UnattributedJvm,
  RuledOutJvm,
  Attribution as JvmAttribution,
  StartedBy,
} from './types'
export { UnsupportedPlatformError } from './types'

/**
 * The registry. Adding a platform means adding one entry here and one file --
 * no existing code changes, no branch to extend.
 */
const REGISTRY: ProcessProvider[] = [windowsProvider, linuxProvider, darwinProvider]

let resolved: ProcessProvider | null = null

/** The provider for the host, whether or not it is implemented. */
export function processProvider(): ProcessProvider {
  if (resolved) return resolved
  const host = hostPlatform()
  const found = REGISTRY.find((p) => p.platform === host)
  resolved =
    found ??
    // Not even registered: freebsd, aix, sunos. Same failure mode, said plainly.
    ({
      platform: host,
      name: `${host}, unrecognised`,
      available: false,
      unavailable: {
        platform: host,
        reason: `Process enumeration is not implemented for ${host}, and no provider is even registered for it. The dashboard cannot identify which JVM owns each server directory, and every other feature depends on that.`,
        guidance: `Windows is the only implemented platform today. Please open an issue at https://github.com/MhmdMK277/Minecraft-Server-Dashboard/issues stating that you run ${host}.`,
      },
      async scanJvms(): Promise<never> {
        throw new UnsupportedPlatformError(this.unavailable!)
      },
    } satisfies ProcessProvider)
  return resolved
}

/** Every platform the registry knows about, for the UI and for docs. */
export function knownPlatforms(): Array<{ platform: string; name: string; available: boolean }> {
  return REGISTRY.map((p) => ({ platform: p.platform, name: p.name, available: p.available }))
}

/**
 * The hints handed to the last identity scan.
 *
 * Recorded so that "was the identity layer even told about this directory?"
 * is a question a proof can answer, rather than one a reader has to trace by
 * eye. It matters for attached servers specifically: a directory that never
 * reaches the hints is a directory whose running JVM the double-spawn
 * pre-check cannot see, and that is how a second JVM lands on a live world.
 */
let lastHints: DirHint[] = []
export function lastDirHints(): DirHint[] {
  return lastHints
}

/** One identity scan, including what it could NOT resolve. Prefer this. */
export function scanJvms(hints?: DirHint[]): Promise<JvmScan> {
  lastHints = hints ?? []
  return processProvider().scanJvms(hints)
}

/**
 * Just the attributed list, for callers that genuinely only want that.
 *
 * Anything deciding a server is *absent* must use `scanJvms` instead: this
 * signature cannot express "the scan failed" or "there are JVMs I could not
 * place", and both of those look identical to an empty array. That conflation is
 * what reported four healthy servers as DOWN.
 */
export async function enumerateJvms(hints?: DirHint[]): Promise<JvmProcess[]> {
  return (await processProvider().scanJvms(hints)).jvms
}

/**
 * Case-insensitive directory match.
 *
 * Case-insensitive is correct on Windows and on default macOS (APFS is
 * case-insensitive out of the box); it is technically loose on Linux, where two
 * directories can differ only by case. That is a deliberate trade: a false match
 * there needs someone to have created `MC Server` and `mc server` side by side,
 * whereas a false *miss* from casing is the common real-world failure.
 */
export function jvmForDir(jvms: JvmProcess[], dir: string): JvmProcess | null {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  const want = norm(dir)
  return jvms.find((j) => norm(j.dir) === want) ?? null
}
