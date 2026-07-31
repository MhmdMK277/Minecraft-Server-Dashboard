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
  SetServerSettingRequest,
  RunCommandRequest,
  type AuthState,
  type LogBatch,
  type Role,
  type SessionSummary,
} from '@shared/api'
import { scan } from './discovery'
import { listWorlds } from './worlds'
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
import { writeSetting } from './serversettings'
import { startServer, stopServer, restartServer, runCommand } from './control'
import { detectLauncher, indexTasks } from './launcher'

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

  await app.register(fastifyCookie)
  await app.register(fastifyWebsocket)

  // ---------------------------------------------------------------- auth

  const dir = dataDir()
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
  const PUBLIC_ROUTES = new Set<string>([API.authState, API.login])

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0] ?? ''
    if (!url.startsWith('/api')) return
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

  async function doScan(): Promise<Snapshot> {
    const snap = await scan(cfg.serversRoot, cfg.classificationOverrides)
    // Validate on the way out. This is where a stray credential field would be
    // caught before it reached a browser.
    return Snapshot.parse(snap)
  }

  async function pushSnapshot(): Promise<void> {
    if (scanning) return
    scanning = true
    try {
      const snap = await doScan()
      latest = snap
      // Console tabs exist only for live servers. Retired and stale directories
      // get no tailer -- carried forward from M1's classification rules.
      await syncConsoles(
        snap.servers.filter((s) => s.classification === 'live').map((s) => ({ id: s.id, dir: s.dir })),
      )
      broadcast({ type: 'snapshot', data: snap })
    } catch (e) {
      app.log.error?.(e)
      console.error('scan failed:', e instanceof Error ? e.message : e)
    } finally {
      scanning = false
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

  app.get(API.appInfo, async () => appInfo())

  app.get(API.snapshot, async () => latest ?? (await doScan()))

  app.post(API.refresh, async () => {
    await pushSnapshot()
    return { ok: true }
  })

  app.get<{ Params: { id: string } }>('/api/servers/:id/log', async (req) => {
    return backlogFor(req.params.id)
  })

  // Read-only world enumeration. The directory and world list come from the
  // dashboard's own discovery, resolved via the server id; nothing from the
  // request is ever joined into a filesystem path.
  app.get<{ Params: { id: string } }>('/api/servers/:id/worlds', async (req, reply) => {
    const snap = latest ?? (await doScan())
    const s = snap.servers.find((x) => x.id === req.params.id)
    if (!s) return reply.code(404).send({ error: 'no server with that id' })
    return listWorlds(s.dir, s.worldDirs)
  })

  // The world's own icon.png, when it has one. The world segment is matched
  // by strict equality against the discovered list, so no request can name a
  // path discovery did not produce.
  app.get<{ Params: { id: string; dir: string } }>(
    '/api/servers/:id/worlds/:dir/icon',
    async (req, reply) => {
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
        .send({ error: "expected { key: 'white-list' | 'online-mode', value: boolean }" })
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
    const result = writeSetting(server.dir, parsed.data.key, parsed.data.value, today)

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

  // ------------------------------------------------------------------ static

  // Built UI, when present. In development Vite serves the UI on its own port
  // and proxies /api and /ws here, so a missing dist is normal, not an error.
  const dist = join(import.meta.dirname, '..', 'dist')
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith(WS_PATH)) {
        return reply.code(404).send({ error: 'not found' })
      }
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

  app.addHook('onClose', async () => {
    for (const t of timers) clearInterval(t)
    consoleBus.off('batch', onBatch)
    stopObserverMonitor()
    stopAllConsoles()
    for (const ws of clients) ws.close()
  })

  void refreshPublicIp().then(() => void pushSnapshot())
  void pushSnapshot()

  return app
}

export { loadConfig }
