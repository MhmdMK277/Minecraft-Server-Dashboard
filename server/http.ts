import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import fastifyCookie from '@fastify/cookie'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { WebSocket } from 'ws'
import {
  API,
  WS_PATH,
  AppInfo,
  Snapshot,
  SESSION_COOKIE,
  CSRF_HEADER,
  LoginRequest,
  ChangePasswordRequest,
  SetBackupRequest,
  RunColdBackupRequest,
  RestoreColdBackupRequest,
  SetServerSettingRequest,
  SetGameRuleRequest,
  RunCommandRequest,
  AttachRequest,
  AttachLaunchRequest,
  AttachDetachRequest,
  CreateServerRequest,
  RunInstallerRequest,
  RemoveFailedCreationRequest,
  TunnelRunAgentRequest,
  TunnelEnableRequest,
  TunnelDisableRequest,
  type CreationInfo,
  type AuthState,
  type LogBatch,
  type Role,
  type SessionSummary,
} from '@shared/api'
declare module 'fastify' {
  interface FastifyInstance {
    /** Every route Fastify registered. Read by prove-authgate. */
    registeredRoutes: Array<{ method: string; url: string }>
  }
}

import { scan } from './discovery'
import { readWorlds } from './worlds'
import { historyFor } from './history'
import { validateAttachCandidate, attachDir, detachDir, setLaunchMethod } from './attach'
import { scanForServers } from './scan'
import { consoleBus, syncConsoles, backlogFor, stopAllConsoles } from './consoles'
import { refreshPublicIp, acknowledgeIpChange } from './network'
import { loadConfig, dataDir, type AppConfig } from './config'
import { processProvider } from './platform'
import { startObserverMonitor, stopObserverMonitor } from './loopguard'
import {
  SessionStore,
  LoginThrottle,
  loadUsers,
  saveUsers,
  hashPassword,
  verifyPassword,
  toSessionUser,
  type Session,
  SESSION_ABSOLUTE_MS,
} from './auth'
import { audit, initAudit } from './audit'
import { setBackupEnabled, isBackupEnabled } from './backuppolicy'
import { readBackupDetection, resetDetectionCache } from './backupdetect'
import { startPagingSampler, stopPagingSampler } from './hostpaging'
import { runColdBackup, restoreColdBackup, listColdBackups } from './coldbackup'
import { writeSetting, writeMotd } from './serversettings'
import { readGameRules, setGameRule } from './gamerules'
import { startServer, stopServer, restartServer, runCommand } from './control'
import { detectLauncher, indexTasks } from './launcher'
import { loadPrefs, setPlayerAvatars, AVATAR_ORIGIN, type Prefs } from './prefs'
import {
  startCreation,
  runInstaller,
  removeFailedCreation,
  listJobs,
  creationInfo,
  collectTakenPorts,
  suggestPort,
} from './creation'
import { listVanillaVersions, listPaperVersions, listForgeVersions } from './mcsources'
import { provisionJava } from './javaprovision'
import {
  installAgent,
  startClaim,
  pollClaim,
  claimStatusOf,
  runAgent,
  stopAgent,
  enableTunnel,
  disableTunnel,
  tunnelStatus,
  stopAgentOnShutdown,
} from './tunnel'
import { basename } from 'node:path'

/**
 * The HTTP + WebSocket surface.
 *
 * One port. The WebSocket is an upgrade on the same listener at /ws, so there is
 * exactly one thing to firewall, one thing to reverse-proxy and one thing to
 * terminate TLS in front of. See the note on API/WS_PATH in shared/api.ts for
 * why that specific choice, and whose mistake it avoids repeating.
 *
 * As of M3.3 this is no longer read-only: start, stop, restart and RCON command
 * routes exist, all admin-only and audited. The safety story for them lives in
 * server/control.ts, not here -- these handlers do auth, validation and audit,
 * and delegate every decision about whether an action is safe.
 */

const POLL_MS = 10_000
const PUBLIC_IP_MS = 5 * 60_000
/** Below any sane proxy idle timeout, so an idle console does not drop. */
const WS_HEARTBEAT_MS = 30_000

export type Deps = {
  cfg: AppConfig
  version: string
}

export async function buildServer({ cfg, version }: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // A reverse proxy or tunnel in front of this is an expected deployment, not
    // an exotic one; the flag is here from the start so remote access is later a
    // deployment change and not a redesign.
    trustProxy: process.env.MCDASH_TRUST_PROXY === '1',
  })

  /**
   * The real route table, recorded as Fastify registers it.
   *
   * The gate below is default-deny and names its exceptions; this list is
   * what lets a proof check that claim against reality rather than against a
   * hand-written inventory that drifts. `prove-authgate` reads it, fires an
   * unauthenticated request at every route, and fails if any of them answers
   * without being a named exception.
   */
  const registeredRoutes: Array<{ method: string; url: string }> = []
  app.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method]
    for (const m of methods) registeredRoutes.push({ method: m, url: r.url })
  })
  app.decorate('registeredRoutes', registeredRoutes)

  await app.register(fastifyCookie)
  await app.register(fastifyWebsocket)

  // ---------------------------------------------------------------- auth

  const dir = dataDir()

  /**
   * Preferences held in memory, because the CSP on every response depends on
   * them and a synchronous file read per response is not a thing to do on a
   * hot path. We are the only writer, so the copy cannot drift.
   */
  let prefs: Prefs = loadPrefs(dir)

  const store = new SessionStore(dir)
  const throttle = new LoginThrottle()
  initAudit(dir)

  /**
   * A real scrypt hash of a value nobody knows, verified against when the
   * username does not exist.
   *
   * Without it, "no such user" returns in microseconds and "wrong password"
   * takes the ~100 ms scrypt costs, which turns the login endpoint into a
   * username oracle. Computed once at startup.
   */
  const DECOY_HASH = await hashPassword(randomBytes(32).toString('hex'))

  const clientIp = (req: FastifyRequest): string => req.ip || 'unknown'
  const agentOf = (req: FastifyRequest): string => String(req.headers['user-agent'] ?? '')

  function sessionOf(req: FastifyRequest): Session | null {
    return store.touch(req.cookies[SESSION_COOKIE])
  }

  function setSessionCookie(reply: FastifyReply, id: string): void {
    reply.setCookie(SESSION_COOKIE, id, {
      httpOnly: true, // unreadable from script, so XSS cannot exfiltrate it
      sameSite: 'strict', // no cross-site request carries it at all
      path: '/',
      // `secure` is deliberately NOT set: the intended deployment is
      // http://127.0.0.1 or a LAN address behind a tunnel that terminates TLS
      // itself. Setting it here would silently break login on exactly the setup
      // the README tells people to use, which is how someone ends up disabling
      // auth to get in. Behind a real TLS proxy, set MCDASH_TRUST_PROXY=1.
      maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000),
    })
  }

  /**
   * Everything under /api needs a session, except the handful of routes needed
   * to get one. The allowlist is short and explicit: a route is protected
   * unless it is named here, so forgetting to think about a new route fails
   * closed.
   */
  /**
   * The gate is DEFAULT-DENY over every registered route.
   *
   * It used to be default-deny only *within* `/api`: the hook returned early
   * for anything else, so a route registered at, say, `/metrics` would have
   * been born world-readable and nobody would have had to decide that. The
   * safe thing must be what happens when a future change does nothing, so
   * the question is now inverted. A new route is protected unless its
   * pattern appears in one of the three named sets below, and adding it to
   * one of them is a visible edit in a security-relevant file.
   *
   * `npm run prove-authgate` enumerates the real route table and fails if
   * any route answers an unauthenticated caller without being named here.
   */

  /** Deliberately public: the two routes needed in order to get a session. */
  const PUBLIC_ROUTES = new Set<string>([API.authState, API.login])

  /**
   * Routes that authenticate themselves, differently. The WebSocket cannot
   * reply 401 to an upgrade, so it checks the session after the handshake
   * and closes with 4401. Listed here so "not gated by the hook" is written
   * down rather than implied by a prefix test.
   */
  const SELF_GUARDED = new Set<string>([WS_PATH])

  /**
   * The SPA shell. These serve index.html and the built assets and carry no
   * server data; the login screen itself lives here, so requiring a session
   * would make signing in impossible.
   */
  const SHELL_ROUTES = new Set<string>(['/', '/*'])

  /**
   * Security headers on every response, including JSON.
   *
   * The page has a CSP meta tag, but API responses carried nothing at all,
   * so a JSON body sniffed as HTML, or the whole app framed by another
   * origin, had no server-side answer. Four headers, no dependency:
   *
   *   nosniff          a JSON console line must never be sniffed as HTML
   *   frame-ancestors  the panel can start and stop servers; do not let a
   *                    page on another origin frame it and click for you
   *   no-referrer      the URL can contain a server name; do not send it on
   *   permissions      this app needs no camera, microphone or geolocation
   *
   * Deliberately NOT Strict-Transport-Security: this is plain HTTP on a LAN
   * by design (see docs/security-audit.md), and HSTS on a hostname the
   * operator reaches over http would lock them out of their own dashboard.
   */
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()')

    /**
     * The CSP is per response class, and getting this wrong breaks the app.
     * An API response may load nothing at all. The SPA must be allowed to
     * run its own bundle, so it gets the policy index.html already declares
     * in its meta tag; sending `default-src 'none'` to the page instead
     * would forbid its own scripts, because browsers intersect every policy
     * they are given.
     */
    const routed = req.routeOptions?.url
    const isApi = (routed ?? req.url).startsWith('/api')
    /**
     * The avatar host appears in `img-src` ONLY while the operator has
     * player avatars switched on, and this header is the enforcement point.
     *
     * A preference that merely hides a feature is one bug away from being
     * meaningless: any stray <img> would still reach the third party and
     * hand it a player list. Withholding the permission means the browser
     * refuses the request whatever the UI does.
     */
    const imgSrc = prefs.playerAvatars ? `'self' data: ${AVATAR_ORIGIN}` : "'self' data:"
    reply.header(
      'Content-Security-Policy',
      isApi
        ? "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
        : `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src ${imgSrc}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    )
    return payload
  })

  app.addHook('onRequest', async (req, reply) => {
    /**
     * Key on the route Fastify MATCHED, not on how the client spelled it.
     *
     * This used to test `req.url`, the raw request target. Fastify
     * percent-decodes the path when it routes, and routing happens before
     * this hook, so `/%61pi/servers` failed the `startsWith('/api')` test,
     * skipped this hook entirely, and was then handed to the real
     * `/api/servers` handler: an unauthenticated reader on the LAN got the
     * whole snapshot and every console line. Found by the M4 adversarial
     * pass, 2026-07-31; `npm run prove-authgate` is the regression net.
     *
     * `routeOptions.url` is the registered pattern (`/api/servers/:id/log`),
     * which is what the handler IS, and no spelling of the request can
     * change it. When nothing matched it is undefined, and an unmatched
     * request reaches the not-found handler, which serves the SPA and no
     * data. The raw-url fallback is kept for that case only.
     */
    const url = req.routeOptions?.url
    // Nothing matched: the not-found handler answers, with the SPA shell or
    // a 404. There is no handler to protect and no data to leak.
    if (!url) return
    if (SHELL_ROUTES.has(url)) return
    if (SELF_GUARDED.has(url)) return
    if (PUBLIC_ROUTES.has(url)) return

    const session = sessionOf(req)
    if (!session) {
      audit({
        actor: null,
        role: null,
        action: 'request.unauthenticated',
        target: url,
        outcome: 'denied',
        ip: clientIp(req),
      })
      return reply.code(401).send({ error: 'not authenticated' })
    }

    // CSRF: a mutating request must carry a header a cross-origin form cannot
    // set. SameSite=Strict already covers this; the header is the belt to that
    // brace, and survives a proxy that rewrites cookie attributes.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers[CSRF_HEADER] !== '1') {
        audit({
          actor: session.username,
          role: session.role,
          action: 'request.csrf-header-missing',
          target: url,
          outcome: 'denied',
          ip: clientIp(req),
        })
        return reply.code(403).send({ error: `missing ${CSRF_HEADER} header` })
      }
    }
    ;(req as FastifyRequest & { session?: Session }).session = session
  })

  /** Role gate. Returns the session, or replies and returns null. */
  function require_(req: FastifyRequest, reply: FastifyReply, role: Role, action: string): Session | null {
    const session = (req as FastifyRequest & { session?: Session }).session ?? null
    if (!session) {
      reply.code(401).send({ error: 'not authenticated' })
      return null
    }
    if (role === 'admin' && session.role !== 'admin') {
      audit({
        actor: session.username,
        role: session.role,
        action,
        target: req.url,
        outcome: 'denied',
        ip: clientIp(req),
        detail: 'requires admin',
      })
      reply.code(403).send({ error: 'this action requires the admin role' })
      return null
    }
    return session
  }

  function authState(req: FastifyRequest): AuthState {
    const users = loadUsers(dir)
    const session = sessionOf(req)
    const me = session ? users.find((u) => u.username === session.username) : undefined
    return {
      configured: users.length > 0,
      user: session ? toSessionUser(session) : null,
      mustChangePassword: me?.mustChangePassword ?? false,
    }
  }

  app.get(API.authState, async (req) => authState(req))

  app.post(API.login, async (req, reply) => {
    const ip = clientIp(req)
    const parsed = LoginRequest.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'username and password required' })
    const { username, password } = parsed.data
    const keys = [`ip:${ip}`, `user:${username.toLowerCase()}`]

    const wait = throttle.retryAfterMs(keys)
    if (wait > 0) {
      audit({ actor: username, role: null, action: 'auth.login', outcome: 'denied', ip, detail: 'rate limited' })
      return reply
        .code(429)
        .header('retry-after', String(Math.ceil(wait / 1000)))
        .send({ error: `too many attempts, try again in ${Math.ceil(wait / 60_000)} minutes` })
    }

    const user = loadUsers(dir).find((u) => u.username === username)
    // Verify against a decoy hash when the user does not exist, so a missing
    // account and a wrong password take the same time and cannot be told apart.
    const ok = user
      ? await verifyPassword(password, user.password)
      : (await verifyPassword(password, DECOY_HASH), false)

    if (!ok || !user) {
      throttle.recordFailure(keys)
      audit({ actor: username, role: null, action: 'auth.login', outcome: 'failed', ip })
      return reply.code(401).send({ error: 'invalid username or password' })
    }

    throttle.recordSuccess(keys)
    const session = store.create(user, ip, agentOf(req))
    setSessionCookie(reply, session.id)
    audit({ actor: user.username, role: user.role, action: 'auth.login', outcome: 'ok', ip })
    return { user: toSessionUser(session), mustChangePassword: user.mustChangePassword }
  })

  app.post(API.logout, async (req, reply) => {
    const session = (req as FastifyRequest & { session?: Session }).session
    if (session) {
      store.revoke(session.id)
      audit({
        actor: session.username,
        role: session.role,
        action: 'auth.logout',
        outcome: 'ok',
        ip: clientIp(req),
      })
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.post(API.changePassword, async (req, reply) => {
    const session = require_(req, reply, 'viewer', 'auth.password')
    if (!session) return
    const ip = clientIp(req)
    const parsed = ChangePasswordRequest.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'new password must be at least 12 characters' })
    }
    const users = loadUsers(dir)
    const me = users.find((u) => u.username === session.username)
    if (!me || !(await verifyPassword(parsed.data.currentPassword, me.password))) {
      audit({ actor: session.username, role: session.role, action: 'auth.password', outcome: 'failed', ip })
      return reply.code(403).send({ error: 'current password is incorrect' })
    }
    me.password = await hashPassword(parsed.data.newPassword)
    me.mustChangePassword = false
    saveUsers(dir, users)

    // Every other session for this user dies. A password change is usually a
    // response to believing someone else has it, and leaving their session
    // alive makes the change ceremonial.
    const revoked = store.revokeAllFor(session.username)
    const fresh = store.create(me, ip, agentOf(req))
    setSessionCookie(reply, fresh.id)
    audit({
      actor: session.username,
      role: session.role,
      action: 'auth.password',
      outcome: 'ok',
      ip,
      detail: `${revoked} session(s) revoked`,
    })
    return { ok: true, user: toSessionUser(fresh) }
  })

  app.get(API.sessions, async (req, reply) => {
    const session = require_(req, reply, 'viewer', 'auth.sessions')
    if (!session) return
    return store.listFor(session.username).map(
      (s): SessionSummary => ({
        sessionId: s.id,
        createdAt: new Date(s.createdAt).toISOString(),
        lastSeenAt: new Date(s.lastSeenAt).toISOString(),
        ip: s.ip,
        userAgent: s.userAgent,
        current: s.id === session.id,
      }),
    )
  })

  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (req, reply) => {
    const session = require_(req, reply, 'viewer', 'auth.session.revoke')
    if (!session) return
    // A user may only revoke their own sessions. Without this check the id --
    // which is also the bearer of authority -- would be a cross-user handle.
    const own = store.listFor(session.username).some((s) => s.id === req.params.id)
    if (!own) return reply.code(404).send({ error: 'no such session' })
    store.revoke(req.params.id)
    audit({
      actor: session.username,
      role: session.role,
      action: 'auth.session.revoke',
      outcome: 'ok',
      ip: clientIp(req),
      detail: req.params.id === session.id ? 'own current session' : 'another of their sessions',
    })
    return { ok: true }
  })


  // Must be running before the first scan: the very first scan is the one with
  // a cold file cache, and therefore the one most likely to block the loop and
  // mis-attribute the delay to a server's main thread.
  startObserverMonitor()

  const provider = processProvider()

  function appInfo(): AppInfo {
    return AppInfo.parse({
      name: 'Minecraft Server Dashboard',
      version,
      node: process.versions.node,
      serversRoot: cfg.serversRoot,
      platform: provider.platform,
      platformSupported: provider.available,
      platformDetail: provider.available ? provider.name : (provider.unavailable?.reason ?? null),
    })
  }

  // ---------------------------------------------------------------- snapshots

  let latest: Snapshot | null = null
  let scanning = false
  /** A write asked for a rescan while one was already running. */
  let rescanRequested = false

  async function doScan(): Promise<Snapshot> {
    const snap = await scan(cfg.serversRoot, cfg.classificationOverrides)
    // Validate on the way out. This is where a stray credential field would be
    // caught before it reached a browser.
    return Snapshot.parse(snap)
  }

  /**
   * Rescan and broadcast.
   *
   * The `scanning` guard exists so the ten-second poll cannot pile scans on
   * top of each other. But a WRITE route calls this to make its change
   * visible at once ("a tick that takes ten seconds to appear reads as a
   * tick that did not work"), and simply returning while a poll happened to
   * be in flight left `latest` describing the world BEFORE the write. The
   * caller was told it had been reflected; it had not. Found by
   * prove-backup-route failing intermittently, 2026-08-02.
   *
   * So a request that arrives during a scan is now remembered and served by
   * one more scan when the current one finishes, rather than dropped.
   */
  async function pushSnapshot(): Promise<void> {
    if (scanning) {
      rescanRequested = true
      // Wait for the in-flight scan and the follow-up, so a caller that
      // awaits this has the same guarantee whether or not it raced a poll.
      while (scanning || rescanRequested) await new Promise((r) => setTimeout(r, 50))
      return
    }
    scanning = true
    try {
      const snap = await doScan()
      latest = snap
      // Console tabs exist for live and never-started servers; retired and
      // stale directories get no tailer (M1's classification rules).
      // never-started is included so the operator watching a first boot sees
      // its console lines from the first scan that notices the process,
      // rather than only after level.dat appears and the class flips to live.
      await syncConsoles(
        snap.servers
          .filter((s) => s.classification === 'live' || s.classification === 'never-started')
          .map((s) => ({ id: s.id, dir: s.dir })),
      )
      broadcast({ type: 'snapshot', data: snap })
    } catch (e) {
      app.log.error?.(e)
      console.error('scan failed:', e instanceof Error ? e.message : e)
    } finally {
      scanning = false
    }
    // A write that arrived mid-scan is served now, so its change is in
    // `latest` before the caller's next read. Cleared first, so a failure
    // here cannot leave a waiter spinning.
    if (rescanRequested) {
      rescanRequested = false
      await pushSnapshot()
    }
  }

  // -------------------------------------------------------------- websockets

  const clients = new Set<WebSocket>()

  function broadcast(frame: { type: string; data: unknown }): void {
    if (!clients.size) return
    const payload = JSON.stringify(frame)
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload)
    }
  }

  const onBatch = (batch: LogBatch) => broadcast({ type: 'log', data: batch })
  consoleBus.on('batch', onBatch)

  app.get(WS_PATH, { websocket: true }, (socket, req) => {
    const ws = socket as unknown as WebSocket

    // The WebSocket carries every console line on this host, so it is the most
    // sensitive thing served here -- and it is NOT covered by the /api hook
    // above, because its path is /ws. Authenticating it separately is easy to
    // forget and would leave the front door locked and the console streaming to
    // anyone who opened a socket.
    //
    // Note the browser sends cookies on a same-origin WebSocket upgrade, so the
    // session cookie is available here without inventing a token. SameSite=Strict
    // also means a page on another origin cannot open this socket at all.
    const session = sessionOf(req)
    if (!session) {
      audit({
        actor: null,
        role: null,
        action: 'ws.connect',
        outcome: 'denied',
        ip: clientIp(req),
      })
      ws.close(4401, 'not authenticated')
      return
    }

    clients.add(ws)
    ws.send(JSON.stringify({ type: 'hello', data: appInfo() }))
    if (latest) ws.send(JSON.stringify({ type: 'snapshot', data: latest }))

    // Server-driven heartbeat: a browser tab that has been backgrounded stops
    // running its own timers reliably, so the liveness ping cannot come from it.
    const beat = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping()
    }, WS_HEARTBEAT_MS)

    ws.on('close', () => {
      clearInterval(beat)
      clients.delete(ws)
    })
    ws.on('error', () => {
      clearInterval(beat)
      clients.delete(ws)
    })
  })

  // -------------------------------------------------------------------- REST

  /**
   * Read routes carry their own session check as well as the global hook.
   *
   * That is deliberate duplication. The hook was the single line of defence
   * until a URL-spelling bug walked around it (see the hook's comment), and
   * these handlers return the snapshot and raw console lines, which is the
   * whole prize. `require_` with 'viewer' means "any signed-in role"; it
   * reads the session the hook attached, so if the hook is ever skipped
   * again the handler still refuses.
   */
  app.get(API.appInfo, async (req, reply) => {
    if (!require_(req, reply, 'viewer', 'info.read')) return
    return appInfo()
  })

  app.get(API.snapshot, async (req, reply) => {
    if (!require_(req, reply, 'viewer', 'servers.read')) return
    return latest ?? (await doScan())
  })

  app.post(API.refresh, async (req, reply) => {
    // A rescan spawns processes, so it needs a session. It stays open to
    // viewers because the Refresh button is theirs too; the cost is bounded
    // by the scan itself, which is the same work the ten-second loop does.
    if (!require_(req, reply, 'viewer', 'servers.refresh')) return
    await pushSnapshot()
    return { ok: true }
  })

  app.get<{ Params: { id: string } }>('/api/servers/:id/log', async (req, reply) => {
    if (!require_(req, reply, 'viewer', 'log.read')) return
    return backlogFor(req.params.id)
  })

  /**
   * The rolling hour behind the Overview sparklines.
   *
   * A separate route rather than a field on the snapshot: three series times
   * an hour of samples times every server would be pushed over the socket
   * every ten seconds to be read by whoever happens to have one Overview
   * open. The board stays lean and the page that draws graphs fetches them.
   */
  app.get<{ Params: { id: string } }>('/api/servers/:id/history', async (req, reply) => {
    if (!require_(req, reply, 'viewer', 'history.read')) return
    const snap = latest ?? (await doScan())
    const s = snap.servers.find((x) => x.id === req.params.id)
    if (!s) return reply.code(404).send({ error: 'no server with that id' })
    return historyFor(s.dir, POLL_MS / 1000)
  })

  // Read-only world enumeration. The directory and world list come from the
  // dashboard's own discovery, resolved via the server id; nothing from the
  // request is ever joined into a filesystem path.
  app.get<{ Params: { id: string }; Querystring: { fresh?: string } }>(
    '/api/servers/:id/worlds',
    async (req, reply) => {
      if (!require_(req, reply, 'viewer', 'worlds.read')) return
      const snap = latest ?? (await doScan())
      const s = snap.servers.find((x) => x.id === req.params.id)
      if (!s) return reply.code(404).send({ error: 'no server with that id' })
      // ?fresh=1 is the refresh control saying "walk it again". Everything
      // else gets whatever reading is current, with its timestamp.
      return readWorlds(s.dir, s.worldDirs, req.query.fresh === '1' ? 0 : undefined)
    },
  )

  // The world's own icon.png, when it has one. The world segment is matched
  // by strict equality against the discovered list, so no request can name a
  // path discovery did not produce.
  app.get<{ Params: { id: string; dir: string } }>(
    '/api/servers/:id/worlds/:dir/icon',
    async (req, reply) => {
      if (!require_(req, reply, 'viewer', 'worlds.icon')) return
      const snap = latest ?? (await doScan())
      const s = snap.servers.find((x) => x.id === req.params.id)
      if (!s) return reply.code(404).send({ error: 'no server with that id' })
      const world = s.worldDirs.find((d) => d === req.params.dir)
      if (!world) return reply.code(404).send({ error: 'no such world' })
      try {
        const buf = await readFile(join(s.dir, world, 'icon.png'))
        return reply.type('image/png').send(buf)
      } catch {
        return reply.code(404).send({ error: 'this world has no icon.png' })
      }
    },
  )

  // Backup detection (decision 0001): a read-only reading of what backup
  // systems already exist for this server. The directory and name come from
  // the dashboard's own discovery, the external paths from the operator's
  // config.json; nothing from the request is ever joined into a path.
  app.get<{ Params: { id: string }; Querystring: { fresh?: string } }>(
    '/api/servers/:id/backup/detection',
    async (req, reply) => {
      if (!require_(req, reply, 'viewer', 'backup.detection')) return
      const snap = latest ?? (await doScan())
      const s = snap.servers.find((x) => x.id === req.params.id)
      if (!s) return reply.code(404).send({ error: 'no server with that id' })
      return readBackupDetection(
        s.dir,
        s.name,
        cfg.externalBackupPaths,
        req.query.fresh === '1' ? 0 : undefined,
      )
    },
  )

  /**
   * Attaching a server folder. All four are admin-only and audited.
   *
   * The write these guard is the dashboard's own attached.json, never
   * anything inside a server directory, but the CONSEQUENCE is that a folder
   * becomes eligible for start, stop and settings writes. That is why they
   * sit with the control routes rather than with the read routes.
   */
  /**
   * Search this machine for server directories. Admin-only: it reports paths
   * outside the servers root, and every result is one confirmation away from
   * becoming a startable server. Nothing here adopts anything.
   */
  app.get<{ Querystring: { fresh?: string } }>('/api/discover', async (req, reply) => {
    const session = require_(req, reply, 'admin', 'discover.scan')
    if (!session) return
    return scanForServers(req.query.fresh === '1' ? { maxAgeMs: 0 } : {})
  })

  app.post(API.attachValidate, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'attach.validate')
    if (!session) return
    const body = AttachDetachRequest.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'a path is required' })
    return validateAttachCandidate(body.data.dir)
  })

  app.post(API.attach, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'attach.add')
    if (!session) return
    const body = AttachRequest.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid attach request' })

    // Validated again here, not just in the browser: the preview the operator
    // saw was produced by a separate request, and nothing stops a client
    // sending a different path than the one it previewed.
    const candidate = await validateAttachCandidate(body.data.path)
    if (!candidate.ok) {
      audit({
        actor: session.username,
        role: session.role,
        action: 'attach.add',
        target: body.data.path,
        outcome: 'denied',
        ip: clientIp(req),
        detail: candidate.reason,
      })
      return reply.code(400).send({ error: candidate.reason })
    }

    const result = attachDir(dataDir(), {
      dir: candidate.dir,
      confirmedLaunch: body.data.confirmedLaunch,
    })
    audit({
      actor: session.username,
      role: session.role,
      action: 'attach.add',
      target: candidate.dir,
      outcome: result.ok ? 'ok' : 'denied',
      ip: clientIp(req),
      detail: result.ok
        ? `launch=${body.data.confirmedLaunch?.strategy ?? 'none confirmed'}`
        : result.reason,
    })
    if (!result.ok) return reply.code(409).send({ error: result.reason })
    await pushSnapshot()
    return result.attached
  })

  app.post(API.attachLaunch, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'attach.launch')
    if (!session) return
    const body = AttachLaunchRequest.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid request' })

    // Refused while a control action is in flight: that action already read
    // the launcher inside its lock.
    const busy = (latest?.servers ?? []).some(
      (s) => s.dir.toLowerCase() === body.data.dir.toLowerCase() && s.controlBusy,
    )
    const result = setLaunchMethod(dataDir(), body.data.dir, body.data.confirmedLaunch, {
      controlBusy: busy,
    })
    audit({
      actor: session.username,
      role: session.role,
      action: 'attach.launch',
      target: body.data.dir,
      outcome: result.ok ? 'ok' : 'denied',
      ip: clientIp(req),
      detail: result.ok
        ? `launch=${body.data.confirmedLaunch?.strategy ?? 'cleared'}`
        : result.reason,
    })
    if (!result.ok) return reply.code(409).send({ error: result.reason })
    await pushSnapshot()
    return result.attached
  })

  app.post(API.attachDetach, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'attach.remove')
    if (!session) return
    const body = AttachDetachRequest.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'a dir is required' })
    const result = detachDir(dataDir(), body.data.dir)
    audit({
      actor: session.username,
      role: session.role,
      action: 'attach.remove',
      target: body.data.dir,
      outcome: result.ok ? 'ok' : 'denied',
      ip: clientIp(req),
      detail: 'the folder itself is untouched; the entry is kept',
    })
    if (!result.ok) return reply.code(404).send({ error: 'that folder is not attached' })
    await pushSnapshot()
    return { ok: true }
  })

  /**
   * Server creation. All admin-only, all audited; the safety rules live in
   * server/creation.ts, and the two decisions that must never be implicit
   * are visible in the contract itself: eulaAccepted on the create request,
   * confirmRunDownloadedProgram on the installer run.
   */
  const knownDirsForPorts = (): string[] => {
    const cfg2 = loadConfig(dataDir())
    const fromSnapshot = (latest?.servers ?? []).map((s) => s.dir)
    return [...new Set([...fromSnapshot, ...cfg2.attachedDirs])]
  }

  app.get<{ Querystring: { mcVersion?: string } }>('/api/create/info', async (req, reply) => {
    const session = require_(req, reply, 'admin', 'create.info')
    if (!session) return
    const cfg2 = loadConfig(dataDir())
    const taken = collectTakenPorts(knownDirsForPorts())
    const suggestedGamePort = await suggestPort(25565, taken)
    // The RCON suggestion must also dodge the game port it rides next to.
    taken.set(suggestedGamePort, 'the suggested game port')
    const suggestedRconPort = await suggestPort(25575, taken)
    // javaMajor comes from the static table: correct for both version
    // schemes today, answers offline, and keeps this route free of publisher
    // round-trips on an interactive page. Provisioning itself re-reads the
    // major Mojang DECLARES for the exact version (requiredJavaMajorLive),
    // so if the table ever drifts, the installed runtime is still right.
    const info = creationInfo(req.query.mcVersion ?? null)
    const { CONSEQUENCE_TEXT } = await import('./javaprovision')
    const out: CreationInfo = {
      flavors: info.flavors,
      javaMajor: info.javaMajor,
      javaLink: info.javaLink,
      adoptiumConsequence: CONSEQUENCE_TEXT,
      suggestedGamePort,
      suggestedRconPort,
      parentDir: cfg2.serversRoot,
      parentDirExists: cfg2.serversRootExists,
    }
    return out
  })

  app.get<{ Querystring: { flavor?: string } }>('/api/create/versions', async (req, reply) => {
    const session = require_(req, reply, 'admin', 'create.versions')
    if (!session) return
    try {
      switch (req.query.flavor) {
        case 'vanilla':
          return { versions: await listVanillaVersions() }
        case 'paper':
          return { versions: await listPaperVersions() }
        case 'forge':
          // The promotions map; the UI shows recommended/latest per MC version.
          return { promos: await listForgeVersions() }
        default:
          return reply.code(400).send({ error: 'flavor must be vanilla, paper or forge' })
      }
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : 'the publisher could not be reached' })
    }
  })

  app.get(API.createJobs, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'create.jobs')
    if (!session) return
    return { jobs: listJobs() }
  })

  app.post(API.create, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'create.start')
    if (!session) return
    const body = CreateServerRequest.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid creation request' })
    const cfg2 = loadConfig(dataDir())
    const result = await startCreation(
      {
        name: body.data.name,
        flavor: body.data.flavor,
        mcVersion: body.data.mcVersion,
        loaderVersion: body.data.loaderVersion,
        gamePort: body.data.gamePort,
        rconPort: body.data.rconPort,
        eulaAccepted: body.data.eulaAccepted,
        memoryMb: body.data.memoryMb,
        java: { mode: body.data.javaMode },
        parentDir: cfg2.serversRoot,
      },
      {
        knownDirs: knownDirsForPorts(),
        provision: provisionJava,
        actor: session.username,
        role: session.role,
        ip: clientIp(req),
      },
    )
    audit({
      actor: session.username,
      role: session.role,
      action: 'create.start',
      target: body.data.name,
      outcome: result.ok ? 'ok' : 'denied',
      ip: clientIp(req),
      detail: result.ok ? `flavor=${body.data.flavor} version=${body.data.mcVersion}` : result.reason,
    })
    if (!result.ok) return reply.code(409).send({ error: result.reason })
    return { opId: result.opId, dir: result.dir }
  })

  app.post(API.createRunInstaller, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'create.run-installer')
    if (!session) return
    const body = RunInstallerRequest.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid request' })
    const result = await runInstaller(body.data.opId, body.data.confirmRunDownloadedProgram, {
      knownDirs: [],
      actor: session.username,
      role: session.role,
      ip: clientIp(req),
    })
    if (!result.ok) return reply.code(409).send({ error: result.reason })
    await pushSnapshot()
    return { ok: true }
  })

  app.post(API.createRemoveFailed, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'create.remove-failed')
    if (!session) return
    const body = RemoveFailedCreationRequest.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid request' })
    // The typed confirmation: the caller must name the exact folder. A
    // mismatch is a refusal, not a fuzzy match.
    if (basename(body.data.dir) !== body.data.folderName) {
      audit({
        actor: session.username,
        role: session.role,
        action: 'create.remove-failed',
        target: body.data.dir,
        outcome: 'denied',
        ip: clientIp(req),
        detail: `confirmation name "${body.data.folderName}" does not match the folder`,
      })
      return reply.code(400).send({ error: 'the confirmation name does not match the folder name' })
    }
    const result = removeFailedCreation(body.data.dir, {
      actor: session.username,
      role: session.role,
      ip: clientIp(req),
    })
    if (!result.ok) return reply.code(409).send({ error: result.reason })
    await pushSnapshot()
    return result
  })

  /**
   * Public access (playit tunnel). All admin-only; the boundaries live in
   * server/tunnel.ts: exposure needs the server's name typed back, running
   * the downloaded binary needs its own confirmation every time, and the
   * address field is null unless the agent reports connected.
   */
  const tunnelDeps = (session: Session, req: { ip?: string } & object) => ({
    actor: session.username,
    role: session.role,
    ip: clientIp(req as Parameters<typeof clientIp>[0]),
  })

  app.get(API.tunnelStatus, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'tunnel.status')
    if (!session) return
    return tunnelStatus(tunnelDeps(session, req))
  })

  app.post(API.tunnelInstall, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'tunnel.install')
    if (!session) return
    const result = await installAgent(tunnelDeps(session, req))
    if (!result.ok) {
      audit({
        actor: session.username, role: session.role, action: 'tunnel.install',
        target: 'playit agent', outcome: 'failed', ip: clientIp(req), detail: result.reason,
      })
      return reply.code(409).send({ error: result.reason })
    }
    return result
  })

  app.post(API.tunnelClaimStart, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'tunnel.claim-start')
    if (!session) return
    return startClaim(tunnelDeps(session, req))
  })

  app.get(API.tunnelClaimStatus, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'tunnel.claim-status')
    if (!session) return
    // The GET drives one poll step; there is no background loop anywhere.
    return claimStatusOf().state === 'none' ? claimStatusOf() : pollClaim(tunnelDeps(session, req))
  })

  app.post(API.tunnelRunAgent, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'tunnel.run-agent')
    if (!session) return
    const body = TunnelRunAgentRequest.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid request' })
    const result = runAgent(body.data.confirmRunDownloadedProgram, tunnelDeps(session, req))
    if (!result.ok) return reply.code(409).send({ error: result.reason })
    return { ok: true }
  })

  app.post(API.tunnelStopAgent, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'tunnel.stop-agent')
    if (!session) return
    return stopAgent(tunnelDeps(session, req))
  })

  app.post(API.tunnelEnable, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'tunnel.enable')
    if (!session) return
    const body = TunnelEnableRequest.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid request' })
    const server = latest?.servers.find((s) => s.id === body.data.id)
    if (!server) return reply.code(404).send({ error: 'no server with that id in the current scan' })
    const result = await enableTunnel(
      { id: server.id, name: server.name, dir: server.dir, gamePort: server.gamePort },
      body.data.confirmServerName,
      tunnelDeps(session, req),
    )
    if (!result.ok) return reply.code(409).send({ error: result.reason })
    return result
  })

  app.post(API.tunnelDisable, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'tunnel.disable')
    if (!session) return
    const body = TunnelDisableRequest.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid request' })
    const result = await disableTunnel(body.data.id, tunnelDeps(session, req))
    if (!result.ok) return reply.code(409).send({ error: result.reason })
    return result
  })

  /**
   * Turning player avatars on or off.
   *
   * Admin-only and audited like any other change of what leaves this
   * machine. Turning it ON is the consequential direction: from then on
   * every browser looking at a Players page tells a third party which names
   * are on your server. The audit line records who decided that.
   */
  app.post(API.prefs, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'prefs.set')
    if (!session) return
    const body = req.body as { playerAvatars?: unknown } | undefined
    if (typeof body?.playerAvatars !== 'boolean') {
      return reply.code(400).send({ error: 'playerAvatars must be true or false' })
    }
    prefs = setPlayerAvatars(dir, body.playerAvatars, session.username)
    audit({
      actor: session.username,
      role: session.role,
      action: 'prefs.set',
      target: 'playerAvatars',
      outcome: 'ok',
      ip: clientIp(req),
      detail: prefs.playerAvatars
        ? `on: browsers may now send player names to ${AVATAR_ORIGIN}`
        : 'off: the avatar host is no longer permitted by the policy',
    })
    await pushSnapshot()
    return { ok: true, playerAvatars: prefs.playerAvatars }
  })

  // Admin-only, and the first route to be so. Acknowledging an IP change writes
  // persisted state and silences a warning the whole household depends on, so
  // it is an operator action rather than a view. It is also what proves the
  // role gate works today -- M3.3's control routes will use the same call.
  app.post(API.ackIpChange, async (req, reply) => {
    const session = require_(req, reply, 'admin', 'network.ack-ip-change')
    if (!session) return
    acknowledgeIpChange()
    audit({
      actor: session.username,
      role: session.role,
      action: 'network.ack-ip-change',
      outcome: 'ok',
      ip: clientIp(req),
    })
    return { ok: true }
  })

  /**
   * Opt one directory in or out of the external backup rotation.
   *
   * The first route that writes state an *external* program acts on, so it is
   * admin-only and audited like ack-ip-change. The blast radius is bounded on
   * purpose: this writes one boolean to one file. It cannot delete an archive,
   * cannot reach the backup script's own settings, and cannot touch the server
   * directory -- see server/backuppolicy.ts.
   *
   * The id must be a directory the current scan actually found. Without that
   * check, a typo writes a policy entry for a server that does not exist, which
   * looks like the setting silently failing to stick.
   */
  // Registered with the literal pattern, not API.setBackup(':id') -- that helper
  // percent-encodes its argument, so ':id' would become '%3Aid' and the route
  // would never match. Same reason /api/servers/:id/log is spelled out below.
  app.post<{ Params: { id: string } }>('/api/servers/:id/backup', async (req, reply) => {
    const session = require_(req, reply, 'admin', 'backup.set')
    if (!session) return

    const parsed = SetBackupRequest.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'expected { enabled: boolean }' })
    }
    const snapshot = latest ?? (await doScan())
    const server = snapshot.servers.find((s) => s.id === req.params.id)
    if (!server) {
      audit({
        actor: session.username,
        role: session.role,
        action: 'backup.set',
        target: req.params.id,
        outcome: 'denied',
        ip: clientIp(req),
        detail: 'no such server directory in the current scan',
      })
      return reply.code(404).send({ error: 'no such server directory' })
    }

    const policy = setBackupEnabled(
      dir,
      server.name,
      parsed.data.enabled,
      session.username,
      snapshot.serversRoot,
    )
    audit({
      actor: session.username,
      role: session.role,
      action: 'backup.set',
      target: server.name,
      outcome: 'ok',
      ip: clientIp(req),
      detail: parsed.data.enabled
        ? 'included in the backup rotation'
        : 'excluded from the backup rotation; existing archives untouched',
    })
    // Reflect it immediately rather than waiting for the next poll: a tick that
    // takes ten seconds to appear reads as a tick that did not work.
    await pushSnapshot()
    return { ok: true, backupEnabled: isBackupEnabled(policy, server.name) }
  })

  /**
   * Decision 0005: the dashboard's own cold backup. Every constraint lives in
   * server/coldbackup.ts (the fresh-detection gate, the occupancy check, the
   * outside-the-directory rule, the append-only manifest, restore-to-a-new-
   * sibling); these handlers do auth, validation and audit, and return the
   * module's refusal sentences verbatim as 409s, control-route style.
   */
  app.get<{ Params: { id: string } }>('/api/servers/:id/coldbackups', async (req, reply) => {
    if (!require_(req, reply, 'admin', 'coldbackup.list')) return
    const snap = latest ?? (await doScan())
    const s = snap.servers.find((x) => x.id === req.params.id)
    if (!s) return reply.code(404).send({ error: 'no server with that id' })
    return { entries: await listColdBackups(dataDir(), s.dir) }
  })

  app.post<{ Params: { id: string } }>('/api/servers/:id/coldbackup', async (req, reply) => {
    const session = require_(req, reply, 'admin', 'coldbackup.run')
    if (!session) return
    const parsed = RunColdBackupRequest.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'expected { destDir: string }' })
    const snapshot = latest ?? (await doScan())
    const server = snapshot.servers.find((s) => s.id === req.params.id)
    if (!server) {
      audit({
        actor: session.username,
        role: session.role,
        action: 'coldbackup.run',
        target: req.params.id,
        outcome: 'denied',
        ip: clientIp(req),
        detail: 'no such server directory in the current scan',
      })
      return reply.code(404).send({ error: 'no such server directory' })
    }
    // Requested before anything happens: a backup in flight when the process
    // dies must not be invisible in the log.
    audit({
      actor: session.username,
      role: session.role,
      action: 'coldbackup.run.requested',
      target: server.name,
      outcome: 'ok',
      ip: clientIp(req),
      detail: `destination ${parsed.data.destDir}`,
    })
    const result = await runColdBackup({
      serverDir: server.dir,
      serverName: server.name,
      destDir: parsed.data.destDir,
      dataDir: dataDir(),
      actor: session.username,
      externalBackupPaths: cfg.externalBackupPaths,
    })
    audit({
      actor: session.username,
      role: session.role,
      action: 'coldbackup.run',
      target: server.name,
      outcome: result.ok ? 'ok' : 'denied',
      ip: clientIp(req),
      detail: result.ok ? `${result.entry.archivePath} sha256 ${result.entry.sha256}` : result.reason,
    })
    if (!result.ok) return reply.code(409).send({ error: result.reason })
    // A new archive changes what detection would say; drop the cached reading
    // so the page's next look reflects the world as it now is.
    resetDetectionCache()
    return result
  })

  app.post<{ Params: { id: string } }>('/api/servers/:id/coldbackup/restore', async (req, reply) => {
    const session = require_(req, reply, 'admin', 'coldbackup.restore')
    if (!session) return
    const parsed = RestoreColdBackupRequest.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'expected { archiveId: string }' })
    audit({
      actor: session.username,
      role: session.role,
      action: 'coldbackup.restore.requested',
      target: parsed.data.archiveId,
      outcome: 'ok',
      ip: clientIp(req),
    })
    const result = await restoreColdBackup({ archiveId: parsed.data.archiveId, dataDir: dataDir() })
    audit({
      actor: session.username,
      role: session.role,
      action: 'coldbackup.restore',
      target: parsed.data.archiveId,
      outcome: result.ok ? 'ok' : 'denied',
      ip: clientIp(req),
      detail: result.ok ? `extracted to ${result.restoredDir}` : result.reason,
    })
    if (!result.ok) return reply.code(409).send({ error: result.reason })
    return result
  })

  /**
   * Start, stop, restart. The first routes that can destroy data.
   *
   * Admin-only and audited, like every mutating route. Two things specific to
   * these, both about honesty rather than mechanism:
   *
   *   - The audit entry is written when the action is REQUESTED and again with
   *     its outcome, because a start that hangs for two minutes must not be
   *     invisible in the log until it finishes. "Who asked for this" is the
   *     question you have after a corrupt world, and it has to survive the
   *     process dying mid-action.
   *   - A refusal is a 409, not a 500. "Already running" and "cannot confirm it
   *     is stopped" are correct, expected answers from the guard, and the UI
   *     needs to show the sentence rather than a generic failure.
   */
  // Registered as three literal paths rather than one `:action` parameter. A
  // parametric segment would sit alongside the static `/backup` and `/command`
  // siblings and leave router precedence deciding which handler wins, which is
  // not something the safety of a start route should depend on.
  for (const action of ['start', 'stop', 'restart'] as const) {
    app.post<{ Params: { id: string } }>(`/api/servers/:id/${action}`, async (req, reply) => {
      const session = require_(req, reply, 'admin', `control.${action}`)
      if (!session) return

      const snapshot = latest ?? (await doScan())
      const server = snapshot.servers.find((s) => s.id === req.params.id)
      if (!server) {
        audit({
          actor: session.username,
          role: session.role,
          action: `control.${action}`,
          target: req.params.id,
          outcome: 'denied',
          ip: clientIp(req),
          detail: 'no such server directory in the current scan',
        })
        return reply.code(404).send({ error: 'no such server directory' })
      }

      // Requested, before anything happens. If the process dies during a start,
      // this line is what tells you a start was in flight.
      audit({
        actor: session.username,
        role: session.role,
        action: `control.${action}.requested`,
        target: server.name,
        outcome: 'ok',
        ip: clientIp(req),
        detail: `launcher: ${server.launchStrategy}`,
      })

      // `kind` only selects the fallback start window for the readiness sentence
      // a successful start returns. See server/boottime.ts.
      const target = { id: server.id, name: server.name, dir: server.dir, kind: server.kind }
      // maxAge 0: a fresh read, because the operator may have just created the task
      // they are trying to use, and one extra second on a button press is invisible.
      const launcher = detectLauncher(server.dir, await indexTasks(0))
      const result =
        action === 'start'
          ? await startServer(target, launcher)
          : action === 'stop'
            ? await stopServer(target)
            : await restartServer(target, launcher)

      audit({
        actor: session.username,
        role: session.role,
        action: `control.${action}`,
        target: server.name,
        outcome: result.ok ? 'ok' : 'denied',
        ip: clientIp(req),
        detail: result.detail,
      })

      // The snapshot is stale the moment a process appears or disappears.
      await pushSnapshot()
      return reply.code(result.ok ? 200 : 409).send(result)
    })
  }

  /**
   * Send one RCON command.
   *
   * Admin-only. A viewer must not be able to run `op`, `whitelist` or `ban`, and
   * the read-only value of RCON output does not outweigh that: there is no
   * meaningful subset of commands that is safe to expose to a weaker role, since
   * plugin commands are unbounded and unknowable.
   *
   * The command text is audited verbatim, which is the point of an audit log.
   * OUTPUT is not audited: `list` returns player names and some plugin commands
   * echo configuration, and the audit file is the one artefact designed to be
   * kept and read later.
   */
  app.post<{ Params: { id: string } }>('/api/servers/:id/command', async (req, reply) => {
    const session = require_(req, reply, 'admin', 'control.command')
    if (!session) return

    const parsed = RunCommandRequest.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'expected { command: string }' })
    }
    const snapshot = latest ?? (await doScan())
    const server = snapshot.servers.find((s) => s.id === req.params.id)
    if (!server) {
      audit({
        actor: session.username,
        role: session.role,
        action: 'control.command',
        target: req.params.id,
        outcome: 'denied',
        ip: clientIp(req),
        detail: 'no such server directory in the current scan',
      })
      return reply.code(404).send({ error: 'no such server directory' })
    }

    const outcome = await runCommand(
      { id: server.id, name: server.name, dir: server.dir },
      parsed.data.command,
    )
    audit({
      actor: session.username,
      role: session.role,
      action: 'control.command',
      target: server.name,
      outcome: outcome.ok ? 'ok' : 'denied',
      ip: clientIp(req),
      // The command, never the reply.
      detail: parsed.data.command.slice(0, 300) + (outcome.ok ? '' : `. ${outcome.detail}`),
    })
    return reply.code(outcome.ok ? 200 : 400).send(outcome)
  })

  /**
   * Write one allowlisted server.properties value.
   *
   * Admin-only and audited, like every mutating route. Three things specific to
   * this one:
   *
   *   - **The key is validated against an enum on the wire**, so the route can
   *     only ever reach `white-list` and `online-mode`. There is no path from
   *     the browser to `rcon.password`, and that is a property of the contract
   *     rather than of this handler being careful.
   *   - **The audit records the transition, not the request.** "online-mode
   *     changed from true to false" is what you need months later; "set
   *     online-mode" is not. The sentence comes back from the writer, which is
   *     the only thing that saw the previous value.
   *   - **A restart is NOT performed.** The setting takes effect when the server
   *     next starts, and quietly restarting a server with players on it because
   *     someone flipped a toggle would be a far worse surprise than the setting
   *     not applying yet. The UI says so instead; `changedSinceStart` on the
   *     next snapshot is the measured confirmation.
   */
  app.post<{ Params: { id: string } }>('/api/servers/:id/settings', async (req, reply) => {
    const session = require_(req, reply, 'admin', 'settings.set')
    if (!session) return

    const parsed = SetServerSettingRequest.safeParse(req.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "expected { key: 'white-list' | 'online-mode', value: boolean } or { key: 'motd', value: string }" })
    }

    const snapshot = latest ?? (await doScan())
    const server = snapshot.servers.find((s) => s.id === req.params.id)
    if (!server) {
      audit({
        actor: session.username,
        role: session.role,
        action: 'settings.set',
        target: req.params.id,
        outcome: 'denied',
        ip: clientIp(req),
        detail: 'no such server directory in the current scan',
      })
      return reply.code(404).send({ error: 'no such server directory' })
    }

    const today = new Date().toISOString().slice(0, 10)
    // The union discriminates on `key`: the boolean pair goes through the
    // enum-checked writer, the MOTD through its own validate-and-encode path.
    const result =
      parsed.data.key === 'motd'
        ? writeMotd(server.dir, parsed.data.value, today)
        : writeSetting(server.dir, parsed.data.key, parsed.data.value, today)

    audit({
      actor: session.username,
      role: session.role,
      action: 'settings.set',
      target: server.name,
      outcome: result.ok ? 'ok' : 'failed',
      ip: clientIp(req),
      detail: result.backupPath
        ? `${result.detail}; previous file kept as ${result.backupPath}`
        : result.detail,
    })

    if (!result.ok) return reply.code(400).send({ error: result.detail })

    // Reflect it immediately rather than waiting for the next poll.
    await pushSnapshot()
    return { ok: true, detail: result.detail }
  })

  /**
   * Game rules: the runtime surface. Both routes work on a FRESH occupancy
   * reading inside server/gamerules.ts (doubt refuses, like the start guard),
   * and the RCON work happens only on demand -- never in the 10 s scan.
   * The read is viewer-visible like every other reading; the set is
   * admin-only and audited with the read-back, because "what did it change
   * to" is the fact worth having later, not "what was asked".
   */
  app.get<{ Params: { id: string } }>('/api/servers/:id/gamerules', async (req, reply) => {
    if (!require_(req, reply, 'viewer', 'gamerules.read')) return
    const snap = latest ?? (await doScan())
    const s = snap.servers.find((x) => x.id === req.params.id)
    if (!s) return reply.code(404).send({ error: 'no server with that id' })
    return readGameRules(s.dir)
  })

  app.post<{ Params: { id: string } }>('/api/servers/:id/gamerules/set', async (req, reply) => {
    const session = require_(req, reply, 'admin', 'gamerule.set')
    if (!session) return
    const parsed = SetGameRuleRequest.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'expected { name: <catalogued rule>, value: boolean | integer }' })
    }
    const snapshot = latest ?? (await doScan())
    const server = snapshot.servers.find((s) => s.id === req.params.id)
    if (!server) {
      audit({
        actor: session.username,
        role: session.role,
        action: 'gamerule.set',
        target: req.params.id,
        outcome: 'denied',
        ip: clientIp(req),
        detail: 'no such server directory in the current scan',
      })
      return reply.code(404).send({ error: 'no such server directory' })
    }
    const result = await setGameRule(server.dir, parsed.data.name, parsed.data.value)
    audit({
      actor: session.username,
      role: session.role,
      action: 'gamerule.set',
      target: server.name,
      outcome: result.ok ? 'ok' : 'denied',
      ip: clientIp(req),
      detail: `${parsed.data.name} -> ${String(parsed.data.value)}. ${result.detail}`,
    })
    if (!result.ok) return reply.code(409).send({ error: result.detail })
    return { ok: true, detail: result.detail, readBack: result.readBack }
  })

  // ------------------------------------------------------------------ static

  // Built UI, when present. In development Vite serves the UI on its own port
  // and proxies /api and /ws here, so a missing dist is normal, not an error.
  const dist = join(import.meta.dirname, '..', 'dist')
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist })
    app.setNotFoundHandler((req, reply) => {
      /**
       * No route matched, so there is no routed pattern to key on and this
       * has to look at the raw target. That is safe HERE, and only here,
       * because both branches are data-free: an unmatched path either gets a
       * JSON 404 or the SPA shell. It decides nothing about access.
       *
       * The decoded form is compared as well as the raw one, so that
       * `/%61pi/nope` gets the API's 404 rather than a page of HTML. Same
       * reasoning as the gate above, where the difference was a
       * vulnerability rather than a cosmetic one.
       */
      const raw = req.url.split('?')[0] ?? ''
      let decoded = raw
      try {
        decoded = decodeURIComponent(raw)
      } catch {
        // A malformed escape sequence is not an API path.
      }
      const isApiish = [raw, decoded].some(
        (u) => u.startsWith('/api') || u.startsWith(WS_PATH),
      )
      if (isApiish) return reply.code(404).send({ error: 'not found' })
      return reply.sendFile('index.html')
    })
  }

  // ------------------------------------------------------------------- loops

  const timers = [
    setInterval(() => void pushSnapshot(), POLL_MS),
    setInterval(() => void refreshPublicIp(), PUBLIC_IP_MS),
    // Expiry is enforced on every lookup, so this only bounds memory for
    // sessions of users who never come back. Unref'd: it must not hold the
    // process open on its own.
    setInterval(() => store.sweep(), 5 * 60_000).unref(),
  ]
  // Hard-fault sampling runs on its own timer, never inside the scan: it
  // spawns a PowerShell, and spec §11 forbids the scan path carrying that.
  startPagingSampler()

  app.addHook('onClose', async () => {
    for (const t of timers) clearInterval(t)
    stopPagingSampler()
    consoleBus.off('batch', onBatch)
    stopObserverMonitor()
    stopAllConsoles()
    // The tunnel agent is OUR child process and public reachability is its
    // doing, so it does not outlive the dashboard that started it. The
    // Public page says so; this is the code that makes it true, rather than
    // relying on Windows to reap a child, which it does not promise.
    stopAgentOnShutdown()
    for (const ws of clients) ws.close()
  })

  void refreshPublicIp().then(() => void pushSnapshot())
  void pushSnapshot()

  return app
}

export { loadConfig }
