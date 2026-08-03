import { createHash, timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * Download a file and prove it is the file, or have nothing.
 *
 * This module exists for server creation, which is the first time this
 * dashboard pulls executable code onto the machine. The design rule, stated
 * in DESIGN.md and enforced here by the shape of the API rather than by
 * caller discipline:
 *
 *   **There is no way to ask this module for an unverified download.**
 *
 * `fetchVerified` requires the expected hash as a parameter. A source that
 * cannot supply a published hash cannot construct a call, which is exactly
 * why Fabric is refused in mcsources.ts rather than special-cased here with
 * a `skipVerify` flag that would one day be reached.
 *
 * The other rules:
 *
 *   - **A failed verification deletes the staged file.** A jar that failed
 *     its checksum sitting in a server folder is a jar someone will
 *     eventually double-click. The file is hashed as it streams and the
 *     staged `.part` never gains its real name unless the hash matched.
 *   - **Hosts are allowlisted per call.** Every catalog entry names the hosts
 *     its downloads may come from; a redirect that leaves that list aborts
 *     the download. A checksum from host A does not vouch for bytes from
 *     host B unless A said to go there and B was expected.
 *   - **HTTPS only**, except loopback for proofs: the proof suite runs a
 *     local fixture server, and 127.0.0.1 is this machine by definition, so
 *     plain HTTP to loopback leaks nothing and crosses no network.
 */

export type HashAlgo = 'sha1' | 'sha256' | 'sha512'

export class VerifyError extends Error {
  constructor(
    message: string,
    /** Which rule refused, for proofs and for the UI to say why. */
    public readonly kind: 'checksum' | 'host' | 'protocol' | 'http' | 'size',
  ) {
    super(message)
  }
}

export type FetchVerifiedInput = {
  url: string
  /** Absolute path the file will have ONLY if verification passes. */
  dest: string
  algo: HashAlgo
  /** Hex digest the publisher states. Lowercase or uppercase both accepted. */
  expected: string
  /** Hosts the download (and any redirect) may touch. */
  allowHosts: string[]
  /** Bytes above which the download aborts; a jar is not a DVD image. */
  maxBytes?: number
}

const DEFAULT_MAX_BYTES = 800 * 1024 * 1024

/**
 * Is `hostname` permitted by this source's allowlist?
 *
 * Two entry shapes, so an allowlist can name an AUTHORITY rather than a
 * fragile list of one authority's current hosts:
 *
 *   - an exact hostname (`api.github.com`) matches only itself;
 *   - a domain-suffix rule, written with a leading dot (`.githubusercontent.com`),
 *     matches any subdomain of that domain.
 *
 * The suffix form exists because GitHub serves release assets from a CDN host
 * it moves without notice: `objects.githubusercontent.com` became
 * `release-assets.githubusercontent.com`, which broke the Java download on a
 * user's machine (2026-08-03). An exact list has to be chased every time; a
 * suffix rule says what we actually meant, "GitHub's asset authority", and
 * survives the next move.
 *
 * The match is on the DOT BOUNDARY, never a substring, so it cannot be widened
 * by a lookalike: `release-assets.githubusercontent.com` ends with
 * `.githubusercontent.com` and is allowed, while `githubusercontent.com.evil.com`,
 * `evil-githubusercontent.com` and `notgithubusercontent.com` do NOT end with
 * the dotted suffix and are refused. The bare registrable domain
 * (`githubusercontent.com`, no subdomain label) is not matched either; it
 * serves nothing and we never intend it.
 */
export function hostAllowed(hostname: string, allowHosts: string[]): boolean {
  const h = hostname.toLowerCase()
  return allowHosts.some((entry) => {
    const e = entry.toLowerCase()
    if (e.startsWith('.')) return h.endsWith(e) && h.length > e.length
    return h === e
  })
}

function checkUrl(raw: string, allowHosts: string[]): URL {
  const u = new URL(raw)
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new VerifyError(`refusing ${u.protocol.replace(':', '')} download from ${u.hostname}`, 'protocol')
  }
  if (!hostAllowed(u.hostname, allowHosts)) {
    throw new VerifyError(`host ${u.hostname} is not on the allowlist for this source`, 'host')
  }
  return u
}

/**
 * Fetch `url` into `dest`, following redirects only within `allowHosts`,
 * hashing while streaming. On any failure the staged file is deleted and the
 * error says which rule refused. Returns the byte count on success.
 */
export async function fetchVerified(input: FetchVerifiedInput): Promise<{ bytes: number }> {
  const { url, dest, algo, expected, allowHosts } = input
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES
  const part = `${dest}.part`

  await mkdir(dirname(dest), { recursive: true })

  // Redirects are followed by hand so every hop is checked against the
  // allowlist. `redirect: 'follow'` would silently accept a hop to any host.
  let current = checkUrl(url, allowHosts)
  let res: Response | null = null
  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(current, { redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new VerifyError(`redirect from ${current.hostname} without a location`, 'http')
      current = checkUrl(new URL(loc, current).toString(), allowHosts)
      continue
    }
    break
  }
  if (!res || !res.ok || !res.body) {
    await rm(part, { force: true })
    throw new VerifyError(`download failed: HTTP ${res?.status ?? 'no response'} from ${current.hostname}`, 'http')
  }

  const hash = createHash(algo)
  let bytes = 0
  try {
    const counter = async function* (src: AsyncIterable<Uint8Array>) {
      for await (const chunk of src) {
        bytes += chunk.length
        if (bytes > maxBytes) {
          throw new VerifyError(`download exceeded ${maxBytes} bytes`, 'size')
        }
        hash.update(chunk)
        yield chunk
      }
    }
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter, createWriteStream(part))
  } catch (e) {
    await rm(part, { force: true })
    throw e
  }

  const got = hash.digest('hex')
  const want = expected.trim().toLowerCase()
  const same =
    got.length === want.length && timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(want, 'utf8'))
  if (!same) {
    // The rule the operator asked for by name: a failed checksum deletes the
    // staged file and fails the creation. Nothing to fall back to.
    await rm(part, { force: true })
    throw new VerifyError(
      `checksum mismatch for ${current.pathname.split('/').pop()}: expected ${algo} ${want}, got ${got}. The staged file was deleted.`,
      'checksum',
    )
  }

  await rename(part, dest)
  const st = await stat(dest)
  return { bytes: st.size }
}

/**
 * Fetch a checksum sidecar (or other small text) from an allowlisted host.
 * Sidecars come as bare hex or as `hex *filename`; the caller parses.
 */
export async function fetchText(url: string, allowHosts: string[]): Promise<string> {
  const u = checkUrl(url, allowHosts)
  const res = await fetch(u, { redirect: 'manual' })
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location')
    if (!loc) throw new VerifyError('redirect without a location', 'http')
    return fetchText(new URL(loc, u).toString(), allowHosts)
  }
  if (!res.ok) throw new VerifyError(`HTTP ${res.status} from ${u.hostname}`, 'http')
  return res.text()
}

/**
 * POST a JSON body to an allowlisted HTTPS host and return the JSON reply.
 * Same URL discipline as every other fetch here; redirects are NOT followed
 * for a POST (a redirected write is a write to somewhere we did not check).
 * Non-2xx replies still return their body when it is JSON, because APIs like
 * playit's put the refusal reason there; the caller decides what a status
 * means. Network-level failures throw.
 */
export async function postJson(
  url: string,
  allowHosts: string[],
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const u = checkUrl(url, allowHosts)
  const res = await fetch(u, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  })
  if (res.status >= 300 && res.status < 400) {
    throw new VerifyError('a POST was redirected; refusing to follow it', 'http')
  }
  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    /* non-JSON body; the status carries what we know */
  }
  return { status: res.status, body: parsed }
}

/** Fetch a small JSON document from an allowlisted HTTPS host. */
export async function fetchJson(url: string, allowHosts: string[]): Promise<unknown> {
  const u = checkUrl(url, allowHosts)
  const res = await fetch(u, { redirect: 'manual' })
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location')
    if (!loc) throw new VerifyError('redirect without a location', 'http')
    return fetchJson(new URL(loc, u).toString(), allowHosts)
  }
  if (!res.ok) throw new VerifyError(`HTTP ${res.status} from ${u.hostname}`, 'http')
  return res.json()
}
