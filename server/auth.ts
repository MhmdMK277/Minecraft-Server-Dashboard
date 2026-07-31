import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import type { Role, SessionUser } from '@shared/api'

/**
 * Authentication.
 *
 * This became mandatory the moment the app stopped being an Electron window on
 * one desktop. It now listens on a socket, and it holds RCON passwords: an
 * unauthenticated reader gets every console line on the host, and after M3.3 an
 * unauthenticated writer gets `stop`.
 *
 * Copied from established projects rather than invented, per the standing
 * preference for proven designs over novel ones:
 *
 *  - **Two roles** (WebConsole's Admin/Viewer). Viewer exists for the real case
 *    here: friends who want to see whether the server is up without being able
 *    to touch it.
 *  - **First-start credentials generated and printed once** (VoxelDash). No
 *    default password to forget to change, and nothing to leak in a config file
 *    that gets pasted into a support thread.
 *
 * One deliberate improvement on VoxelDash: its `SessionController` tracks
 * `lastUsed` but never expires anything, so a session lives until the process
 * restarts. Here a session dies on **absolute age** and on **idle**, and can be
 * revoked individually -- which is what makes "I logged in from a friend's PC"
 * recoverable.
 *
 * scrypt comes from `node:crypto` on purpose: argon2 and bcrypt are native
 * modules, and a native build step on Windows is exactly the kind of install
 * friction that gets solved by someone disabling auth.
 */

/** OWASP's floor for scrypt is N=2^17 with r=8, p=1. */
const SCRYPT_N = 1 << 17
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64
/** scrypt at N=2^17 needs ~128 MB; the default 32 MB cap would reject it. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024

/**
 * A session dies at 12 hours no matter what, and after 2 hours untouched.
 *
 * Absolute expiry bounds the damage from a stolen cookie; idle expiry closes
 * the tab someone left open on a shared machine. Neither alone does both.
 */
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60_000
export const SESSION_IDLE_MS = 2 * 60 * 60_000

/** Login throttle. Slow enough to stop guessing, loose enough to survive typos. */
export const LOGIN_MAX_FAILURES = 5
export const LOGIN_WINDOW_MS = 15 * 60_000
export const LOGIN_LOCKOUT_MS = 15 * 60_000

export type StoredUser = {
  username: string
  role: Role
  /** scrypt output, `scrypt$N$r$p$salt$hash`, all base64. Never a plaintext. */
  password: string
  createdAt: string
  /** Set when the account was created by the first-start bootstrap. */
  mustChangePassword: boolean
}

type AuthFile = { version: 1; users: StoredUser[] }

export type Session = {
  id: string
  username: string
  role: Role
  createdAt: number
  lastSeenAt: number
  /** For the session list, so a user can recognise which one to revoke. */
  userAgent: string
  ip: string
}

// ---------------------------------------------------------------- hashing

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    )
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt)
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`
}

/**
 * Constant-time verification.
 *
 * Returns false rather than throwing on a malformed stored value: a corrupt
 * auth file must fail closed, not crash the service into a restart loop.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, hashB64] = parts
  try {
    const salt = Buffer.from(saltB64!, 'base64')
    const expected = Buffer.from(hashB64!, 'base64')
    const key = await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        expected.length,
        { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM },
        (err, k) => (err ? reject(err) : resolve(k)),
      )
    })
    return key.length === expected.length && timingSafeEqual(key, expected)
  } catch {
    return false
  }
}

// ------------------------------------------------------------- user store

export function authPath(dataDir: string): string {
  return join(dataDir, 'auth.json')
}

export function loadUsers(dataDir: string): StoredUser[] {
  const p = authPath(dataDir)
  if (!existsSync(p)) return []
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as AuthFile
    return Array.isArray(parsed.users) ? parsed.users : []
  } catch {
    // Fail closed: an unreadable auth file means nobody is authenticated, not
    // that everybody is.
    return []
  }
}

export function saveUsers(dataDir: string, users: StoredUser[]): void {
  const p = authPath(dataDir)
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, users } satisfies AuthFile, null, 2), 'utf8')
  renameSync(tmp, p)
  try {
    // Owner read/write only. A no-op on Windows, where ACLs are the real
    // mechanism -- recorded here so the gap is visible rather than assumed away.
    chmodSync(p, 0o600)
  } catch {
    /* best effort */
  }
}

/** A password a human can read over the phone once and then never again. */
export function generatePassword(): string {
  // Base32-ish, no vowels and no look-alike characters, so nobody mistypes it.
  const alphabet = '23456789BCDFGHJKLMNPQRSTVWXZ'
  const bytes = randomBytes(20)
  let out = ''
  for (let i = 0; i < 20; i++) {
    if (i > 0 && i % 5 === 0) out += '-'
    out += alphabet[bytes[i]! % alphabet.length]
  }
  return out
}

/**
 * First start: create one admin and hand the password back exactly once.
 *
 * Returns null when users already exist, so this is safe to call on every boot.
 */
export async function bootstrapIfEmpty(
  dataDir: string,
): Promise<{ username: string; password: string } | null> {
  const users = loadUsers(dataDir)
  if (users.length > 0) return null
  const username = 'admin'
  const password = generatePassword()
  saveUsers(dataDir, [
    {
      username,
      role: 'admin',
      password: await hashPassword(password),
      createdAt: new Date().toISOString(),
      mustChangePassword: true,
    },
  ])
  return { username, password }
}

// --------------------------------------------------------------- sessions

type SessionFile = { version: 1; sessions: Session[] }

/**
 * Idle expiry only needs minute resolution across a restart. Persisting every
 * touch would rewrite the file on every request and every 10 s snapshot.
 */
const TOUCH_PERSIST_MS = 60_000

/**
 * Sessions persist to `<dataDir>/sessions.json`, so a service restart does not
 * sign everyone out.
 *
 * An earlier version kept them memory-only, arguing that session tokens are
 * bearer credentials and belong off disk. The operator overruled that on
 * 2026-07-31, after every restart this project performed cost a re-login. The
 * exposure is bounded: the file sits next to auth.json in the per-user
 * %APPDATA% directory, so a reader who can take it can already take the
 * account store, and expiry is enforced on load as well as on lookup, so a
 * stale file cannot resurrect an expired session.
 *
 * Constructed without a directory the store is memory-only. Proofs use that;
 * the real service must not.
 */
export class SessionStore {
  private sessions = new Map<string, Session>()
  private readonly file: string | null
  private lastTouchSave = 0

  constructor(persistDir?: string) {
    this.file = persistDir ? join(persistDir, 'sessions.json') : null
    this.load()
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as SessionFile
      if (!Array.isArray(parsed.sessions)) return
      const now = Date.now()
      for (const s of parsed.sessions) {
        if (typeof s?.id !== 'string' || typeof s.createdAt !== 'number' || typeof s.lastSeenAt !== 'number') continue
        if (now - s.createdAt >= SESSION_ABSOLUTE_MS || now - s.lastSeenAt >= SESSION_IDLE_MS) continue
        this.sessions.set(s.id, s)
      }
    } catch {
      // Fail closed, same as loadUsers: an unreadable file signs everyone out,
      // it does not crash the service and it does not trust garbage.
    }
  }

  private save(): void {
    if (!this.file) return
    try {
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, sessions: [...this.sessions.values()] } satisfies SessionFile), 'utf8')
      renameSync(tmp, this.file)
      try {
        chmodSync(this.file, 0o600)
      } catch {
        /* best effort, as in saveUsers */
      }
    } catch {
      // A failed write must not break login. The session still works; it just
      // will not survive the next restart.
    }
  }

  create(user: { username: string; role: Role }, ip: string, userAgent: string): Session {
    const now = Date.now()
    const s: Session = {
      id: randomBytes(32).toString('base64url'),
      username: user.username,
      role: user.role,
      createdAt: now,
      lastSeenAt: now,
      ip,
      userAgent: userAgent.slice(0, 200),
    }
    this.sessions.set(s.id, s)
    this.save()
    return s
  }

  /**
   * Look up and touch. Returns null for unknown, aged-out or idled-out
   * sessions, and deletes them on the way past so the map cannot grow forever.
   */
  touch(id: string | undefined, now = Date.now()): Session | null {
    if (!id) return null
    const s = this.sessions.get(id)
    if (!s) return null
    if (now - s.createdAt >= SESSION_ABSOLUTE_MS || now - s.lastSeenAt >= SESSION_IDLE_MS) {
      this.sessions.delete(id)
      this.save()
      return null
    }
    s.lastSeenAt = now
    if (now - this.lastTouchSave >= TOUCH_PERSIST_MS) {
      this.lastTouchSave = now
      this.save()
    }
    return s
  }

  revoke(id: string): boolean {
    const removed = this.sessions.delete(id)
    if (removed) this.save()
    return removed
  }

  /** Every session for a user -- used when a password changes. */
  revokeAllFor(username: string): number {
    let n = 0
    for (const [id, s] of this.sessions) {
      if (s.username === username) {
        this.sessions.delete(id)
        n++
      }
    }
    if (n > 0) this.save()
    return n
  }

  listFor(username: string, now = Date.now()): Session[] {
    this.sweep(now)
    return [...this.sessions.values()].filter((s) => s.username === username)
  }

  sweep(now = Date.now()): number {
    let n = 0
    for (const [id, s] of this.sessions) {
      if (now - s.createdAt >= SESSION_ABSOLUTE_MS || now - s.lastSeenAt >= SESSION_IDLE_MS) {
        this.sessions.delete(id)
        n++
      }
    }
    if (n > 0) this.save()
    return n
  }

  get size(): number {
    return this.sessions.size
  }
}

// ------------------------------------------------------------ rate limiting

/**
 * Failure counting, keyed by IP **and** by username.
 *
 * By IP alone, one NAT'd household locks itself out together. By username
 * alone, an attacker rotating usernames is never slowed. Both, and either one
 * tripping is enough to refuse.
 */
export class LoginThrottle {
  private hits = new Map<string, { count: number; first: number; until: number }>()

  private entry(key: string, now: number) {
    const e = this.hits.get(key)
    if (!e || now - e.first > LOGIN_WINDOW_MS) {
      const fresh = { count: 0, first: now, until: 0 }
      this.hits.set(key, fresh)
      return fresh
    }
    return e
  }

  /** Milliseconds remaining before this key may try again; 0 when allowed. */
  retryAfterMs(keys: string[], now = Date.now()): number {
    let worst = 0
    for (const k of keys) {
      const e = this.hits.get(k)
      if (e && e.until > now) worst = Math.max(worst, e.until - now)
    }
    return worst
  }

  recordFailure(keys: string[], now = Date.now()): void {
    for (const k of keys) {
      const e = this.entry(k, now)
      e.count++
      if (e.count >= LOGIN_MAX_FAILURES) e.until = now + LOGIN_LOCKOUT_MS
    }
  }

  recordSuccess(keys: string[]): void {
    for (const k of keys) this.hits.delete(k)
  }
}

export function toSessionUser(s: Session): SessionUser {
  return {
    username: s.username,
    role: s.role,
    sessionId: s.id,
    createdAt: new Date(s.createdAt).toISOString(),
    expiresAt: new Date(s.createdAt + SESSION_ABSOLUTE_MS).toISOString(),
    idleExpiresAt: new Date(s.lastSeenAt + SESSION_IDLE_MS).toISOString(),
  }
}
