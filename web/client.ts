import type {
  AppInfo,
  AuthState,
  CommandResponse,
  ControlResult,
  LogBatch,
  LogLine,
  SessionSummary,
  SessionUser,
  Snapshot,
  ServerSettingKey,
} from '@shared/api'
import { API, WS_PATH } from '@shared/api'

/**
 * The browser's data access layer.
 *
 * This replaces the Electron preload bridge and deliberately keeps the same
 * shape -- request/response methods plus subscribe-with-unsubscribe -- so the
 * React components did not have to change when the transport did. It is also
 * the reason the pivot cost one file instead of a rewrite: everything above
 * this only ever knew "give me a snapshot" and "call me when a batch arrives".
 *
 * The socket reconnects with backoff, because a dashboard that watches servers
 * for uptime and then silently stops updating when its own connection drops is
 * worse than useless -- it shows stale numbers that look current. `onConnection`
 * exists so the UI can say so out loud.
 */

type Unsub = () => void

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 15_000

/** Raised on 401 so callers can show the login screen instead of an error. */
export class NotAuthenticated extends Error {
  constructor() {
    super('not authenticated')
    this.name = 'NotAuthenticated'
  }
}

const authSubs = new Set<() => void>()

async function check(r: Response, url: string): Promise<void> {
  if (r.status === 401) {
    // A session can expire between page load and the next request. Telling the
    // app rather than throwing a generic error is what turns that into "please
    // sign in again" instead of a red box saying 401.
    for (const fn of authSubs) fn()
    throw new NotAuthenticated()
  }
  if (!r.ok) {
    // Prefer the server's sentence. These endpoints answer with an explanation
    // written for a person; replacing it with "403 Forbidden" throws that away.
    let detail = ''
    try {
      detail = ((await r.json()) as { error?: string }).error ?? ''
    } catch {
      /* not json */
    }
    throw new Error(detail || `${r.status} ${r.statusText} from ${url}`)
  }
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: 'application/json' } })
  await check(r, url)
  return (await r.json()) as T
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    // A custom header on every mutating request: CSRF defence that survives
    // even if SameSite is weakened by a proxy, and it costs nothing now. The
    // server rejects any mutating request without it.
    headers: {
      accept: 'application/json',
      'x-mcdash': '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  await check(r, url)
  return (await r.json()) as T
}

const post = <T,>(url: string, body?: unknown) => send<T>(url, 'POST', body)

/**
 * A control action, where a refusal is an ANSWER rather than an error.
 *
 * The guard replies 409 with a sentence it wrote for a person -- "already running
 * as pid 9876, refusing to start a second process against the same world". Routing
 * that through `check()` would replace it with a thrown Error and lose the
 * structured result, so this reads the body on both outcomes. A 401 still has to
 * behave like a 401, and anything that is not a well-formed ControlResult is still
 * an error.
 */
async function sendControl(url: string): Promise<ControlResult> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'x-mcdash': '1' },
  })
  if (r.status === 401) {
    for (const fn of authSubs) fn()
    throw new NotAuthenticated()
  }
  let body: unknown = null
  try {
    body = await r.json()
  } catch {
    /* handled below */
  }
  const asResult = body as Partial<ControlResult> | null
  if (asResult && typeof asResult.detail === 'string' && typeof asResult.ok === 'boolean') {
    return asResult as ControlResult
  }
  const err = (body as { error?: string } | null)?.error
  throw new Error(err || `${r.status} ${r.statusText} from ${url}`)
}

/**
 * Same reasoning as sendControl: a rejected command answers 400 with the reason
 * ("Use the Stop button -- it flushes the world first"), and that reason is the
 * point. Throwing it away and showing "400 Bad Request" would make the refusal
 * look like a bug in the dashboard.
 */
async function sendCommand(url: string, command: string): Promise<CommandResponse> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'x-mcdash': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ command }),
  })
  if (r.status === 401) {
    for (const fn of authSubs) fn()
    throw new NotAuthenticated()
  }
  let body: unknown = null
  try {
    body = await r.json()
  } catch {
    /* handled below */
  }
  const asResp = body as Partial<CommandResponse> | null
  if (asResp && typeof asResp.detail === 'string' && typeof asResp.ok === 'boolean') {
    return asResp as CommandResponse
  }
  const err = (body as { error?: string } | null)?.error
  throw new Error(err || `${r.status} ${r.statusText} from ${url}`)
}

type ConnectionState = 'connecting' | 'open' | 'closed'

const snapshotSubs = new Set<(s: Snapshot) => void>()
const logSubs = new Set<(b: LogBatch) => void>()
const connSubs = new Set<(s: ConnectionState) => void>()

let socket: WebSocket | null = null
let backoff = RECONNECT_MIN_MS
let state: ConnectionState = 'closed'

function setState(s: ConnectionState): void {
  state = s
  for (const fn of connSubs) fn(s)
}

function connect(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  setState('connecting')
  const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`)
  socket = ws

  ws.onopen = () => {
    backoff = RECONNECT_MIN_MS
    setState('open')
  }

  ws.onmessage = (ev) => {
    let frame: { type: string; data: unknown }
    try {
      frame = JSON.parse(String(ev.data)) as { type: string; data: unknown }
    } catch {
      return
    }
    if (frame.type === 'snapshot') {
      for (const fn of snapshotSubs) fn(frame.data as Snapshot)
    } else if (frame.type === 'log') {
      for (const fn of logSubs) fn(frame.data as LogBatch)
    }
  }

  const retry = (ev?: CloseEvent) => {
    setState('closed')
    socket = null
    // 4401 is this server saying "you are not authenticated". Reconnecting
    // would be an infinite loop against a door that is locked on purpose, so
    // tell the app to show the login screen and stop.
    if (ev?.code === 4401) {
      for (const fn of authSubs) fn()
      return
    }
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
  }
  ws.onclose = retry
  ws.onerror = () => ws.close()
}

export const dashboard = {
  getAppInfo: () => get<AppInfo>(API.appInfo),
  getSnapshot: () => get<Snapshot>(API.snapshot),
  getLogBacklog: (id: string) => get<LogLine[]>(API.logBacklog(id)),
  refresh: () => post<{ ok: boolean }>(API.refresh),
  acknowledgeIpChange: () => post<{ ok: boolean }>(API.ackIpChange),
  setBackupEnabled: (id: string, enabled: boolean) =>
    post<{ ok: boolean; backupEnabled: boolean }>(API.setBackup(id), { enabled }),

  /** Write one allowlisted server.properties value. Admin only, audited. */
  setServerSetting: (id: string, key: ServerSettingKey, value: boolean) =>
    post<{ ok: boolean; detail: string }>(API.setSetting(id), { key, value }),

  /**
   * A control action. A refused action comes back 409 with the guard's own
   * sentence, and that sentence is the whole value. "already running as pid
   * 9876, refusing to start a second process against the same world" is what the
   * user needs, not "request failed". So the ControlResult is returned for both
   * outcomes rather than a rejection being thrown for the 409.
   */
  control: (id: string, action: 'start' | 'stop' | 'restart') =>
    sendControl(API.control(id, action)),
  runCommand: (id: string, command: string) => sendCommand(API.runCommand(id), command),

  getAuthState: () => get<AuthState>(API.authState),
  login: (username: string, password: string) =>
    post<{ user: SessionUser; mustChangePassword: boolean }>(API.login, { username, password }),
  logout: () => post<{ ok: boolean }>(API.logout),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ ok: boolean; user: SessionUser }>(API.changePassword, { currentPassword, newPassword }),
  getSessions: () => get<SessionSummary[]>(API.sessions),
  revokeSession: (id: string) => send<{ ok: boolean }>(API.revokeSession(id), 'DELETE'),

  /** Fires when a request comes back 401, i.e. the session has gone. */
  onAuthLost(fn: () => void): Unsub {
    authSubs.add(fn)
    return () => void authSubs.delete(fn)
  },

  /** After logging in or out, the socket must be re-opened under the new identity. */
  reconnect(): void {
    if (socket) {
      socket.onclose = null
      socket.close()
      socket = null
    }
    backoff = RECONNECT_MIN_MS
    connect()
  },

  onSnapshot(fn: (s: Snapshot) => void): Unsub {
    snapshotSubs.add(fn)
    connect()
    return () => void snapshotSubs.delete(fn)
  },
  onLogBatch(fn: (b: LogBatch) => void): Unsub {
    logSubs.add(fn)
    connect()
    return () => void logSubs.delete(fn)
  },
  onConnection(fn: (s: ConnectionState) => void): Unsub {
    connSubs.add(fn)
    fn(state)
    return () => void connSubs.delete(fn)
  },
}

export type { ConnectionState }
