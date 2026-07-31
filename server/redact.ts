/**
 * Render-layer redaction for console output.
 *
 * Audit of 1,457,552 log lines across all four servers on 2026-07-28 found:
 *
 *   rcon-auth-line          0   servers never log an RCON password or auth attempt
 *   discord-token-shaped    0   DiscordSRV logs nothing token-shaped
 *   password= / token=      0
 *   Bearer                  0
 *   live secret verbatim    0   no rcon.password appears in any log
 *   ip-address          2,214   <-- this is the real finding
 *
 * So there is no credential problem, but `log-ips=true` is set and player join
 * and disconnect lines carry real public IP addresses. That is other people's
 * PII rendered in a window that gets screenshotted and shared, so it is masked
 * by default.
 *
 * The token patterns are kept anyway: they cost nothing, and "no token has ever
 * been logged" is a statement about today's mods, not a guarantee about the
 * next one that gets installed.
 */

const RULES: Array<{ name: string; re: RegExp; replace: (m: string) => string }> = [
  {
    // Discord bot token: id.timestamp.hmac
    name: 'discord-token',
    re: /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40}\b/g,
    replace: () => '[redacted token]',
  },
  {
    name: 'assigned-secret',
    re: /\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi,
    replace: (m) => `${m.split(/[:=]/)[0]!}=[redacted]`,
  },
  {
    name: 'bearer',
    re: /\bBearer\s+[A-Za-z0-9._-]{10,}/gi,
    replace: () => 'Bearer [redacted]',
  },
  {
    // Player IPs. Loopback and private ranges are left alone: 127.0.0.1 in an
    // RCON line and 192.168.x are useful and not anyone's personal data.
    name: 'player-ip',
    re: /\b(?!127\.0\.0\.1)(?!10\.)(?!192\.168\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)(?!0\.0\.0\.0)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    replace: (m) => {
      const parts = m.split('.')
      return `${parts[0]}.${parts[1]}.x.x`
    },
  },
]

export type RedactionMode = 'on' | 'off'

export function redactLine(text: string, mode: RedactionMode = 'on'): string {
  if (mode === 'off') return text
  let out = text
  for (const r of RULES) out = out.replace(r.re, (m) => r.replace(m))
  return out
}

/** Minecraft section-sign colour codes, stripped for display. */
export function stripColourCodes(text: string): string {
  return text.replace(/§[0-9a-fk-orA-FK-OR]/g, '')
}

/** Log level, for colouring the console without parsing the whole line. */
export function levelOf(text: string): 'error' | 'warn' | 'info' | 'other' {
  if (/\/(ERROR|FATAL)\]|\bSEVERE\b/.test(text)) return 'error'
  if (/\/WARN\]/.test(text)) return 'warn'
  if (/\/INFO\]/.test(text)) return 'info'
  return 'other'
}
