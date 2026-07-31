import { UnsupportedPlatformError, type ProcessProvider, type ProviderUnavailable } from './types'

/**
 * Linux process provider, REGISTERED, NOT IMPLEMENTED.
 *
 * The shape is known: /proc/<pid>/cmdline for the JVM, /proc/<pid>/stat field 4
 * for the parent, /proc/<pid>/cwd (a symlink) for the working directory, which on
 * Linux is usually a *better* identity signal than the launcher command line
 * because systemd sets WorkingDirectory explicitly.
 *
 * It is not written yet because it would be unverified at the time of writing,
 * and process-tree identity is exactly where untested platform assumptions have
 * caused the worst bugs in this project (see docs/liveness-spec.md §1). Shipping
 * a plausible-looking implementation nobody has run is worse than shipping a
 * clear "not implemented".
 *
 * TESTABLE WITHOUT NEW HARDWARE: WSL2 on a Windows development box exposes a
 * real /proc with genuine Linux process semantics, as does a Docker container.
 * This is not blocked on acquiring a Linux machine. See docs/platform-support.md.
 */
const UNAVAILABLE: ProviderUnavailable = {
  platform: 'linux',
  reason:
    'Process enumeration is not implemented for Linux. The dashboard cannot identify which JVM owns each server directory, and every other feature, discovery, health, the double-spawn guard, depends on that.',
  guidance:
    'Windows is the only implemented platform today. If you want Linux support, please open an issue at https://github.com/MhmdMK277/Minecraft-Server-Dashboard/issues. The intended approach (/proc/<pid>/cwd plus the parent from /proc/<pid>/stat) is described in docs/platform-support.md.',
}

export const linuxProvider: ProcessProvider = {
  platform: 'linux',
  name: 'Linux (/proc), not implemented',
  available: false,
  unavailable: UNAVAILABLE,
  async scanJvms(): Promise<never> {
    throw new UnsupportedPlatformError(UNAVAILABLE)
  },
}
