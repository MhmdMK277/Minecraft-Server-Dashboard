import { appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * Append-only audit log, one JSON object per line.
 *
 * JSONL rather than a database or a rotating text log, for three reasons that
 * matter more than elegance: an append is a single syscall and cannot corrupt
 * earlier lines, a truncated final line loses one record instead of the file,
 * and `Get-Content audit.jsonl | ConvertFrom-Json` is a tool the operator
 * already has at 2am.
 *
 * What goes in: who did it, what, to what, and whether it worked. What never
 * goes in: passwords, session ids, RCON credentials, or the contents of a
 * console command's output. The log is a record of authority being exercised,
 * not a second copy of the data.
 *
 * It is written for M3.3, where actions can stop a server. It starts now so
 * that authentication itself -- the thing that decides who may do that -- is
 * already covered by it, rather than being the one unlogged subsystem.
 */

export type AuditOutcome = 'ok' | 'denied' | 'failed'

export type AuditEntry = {
  at: string
  actor: string | null
  role: string | null
  action: string
  target?: string
  outcome: AuditOutcome
  ip: string
  detail?: string
}

let path: string | null = null

export function initAudit(dataDir: string): string {
  path = join(dataDir, 'audit.jsonl')
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    /* best effort */
  }
  return path
}

export function auditPath(): string | null {
  return path
}

/**
 * Synchronous append, deliberately.
 *
 * An audit line that is still buffered when the process dies is an audit line
 * that does not exist, and the events worth auditing are exactly the ones that
 * precede a crash. These are a handful of writes per session, not a hot path.
 */
export function audit(entry: Omit<AuditEntry, 'at'>): void {
  if (!path) return
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
  try {
    appendFileSync(path, `${line}\n`, 'utf8')
  } catch {
    // Never let logging break the request it is describing.
  }
}
