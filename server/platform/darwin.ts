import { UnsupportedPlatformError, type ProcessProvider, type ProviderUnavailable } from './types'

/**
 * macOS process provider, REGISTERED, NOT IMPLEMENTED.
 *
 * macOS is a THIRD path, not a Linux variant. There is no /proc: process
 * ancestry comes from sysctl KERN_PROC, and the working directory needs
 * proc_pidinfo(PROC_PIDVNODEPATHINFO) via libproc, which `lsof -p <pid> -a -d cwd`
 * exposes without a native module, at the cost of a fork per query. Treating it
 * as "Linux with different paths" would produce code that compiles and silently
 * returns nothing.
 */
const UNAVAILABLE: ProviderUnavailable = {
  platform: 'darwin',
  reason:
    'Process enumeration is not implemented for macOS. The dashboard cannot identify which JVM owns each server directory, and every other feature, discovery, health, the double-spawn guard, depends on that.',
  guidance:
    'Windows is the only implemented platform today. If you want macOS support, please open an issue at https://github.com/MhmdMK277/Minecraft-Server-Dashboard/issues. The intended approach (sysctl for ancestry, lsof/libproc for the working directory) is described in docs/platform-support.md.',
}

export const darwinProvider: ProcessProvider = {
  platform: 'darwin',
  name: 'macOS (sysctl + libproc), not implemented',
  available: false,
  unavailable: UNAVAILABLE,
  async scanJvms(): Promise<never> {
    throw new UnsupportedPlatformError(UNAVAILABLE)
  },
}
