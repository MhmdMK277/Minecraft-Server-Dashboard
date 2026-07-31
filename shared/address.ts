/**
 * Connection address formatting.
 *
 * Lives in shared/ rather than inside the component so the port rule can be
 * tested directly instead of by reading the UI.
 */

/** Minecraft's default. Typing it confuses people, so it is never shown. */
export const DEFAULT_MC_PORT = 25565

/**
 * `host:port`, with the port omitted when it is the Minecraft default.
 * Returns null when either half is unknown, so the UI shows a dash rather than
 * a half-built address someone might copy.
 */
export function formatAddress(host: string | null | undefined, port: number | null | undefined): string | null {
  if (!host || port === null || port === undefined) return null
  return port === DEFAULT_MC_PORT ? host : `${host}:${port}`
}

/** Dynmap is a web page, so it always needs a scheme and always shows its port. */
export function formatWebUrl(host: string | null | undefined, port: number | null | undefined): string | null {
  if (!host || port === null || port === undefined) return null
  return `http://${host}:${port}`
}
