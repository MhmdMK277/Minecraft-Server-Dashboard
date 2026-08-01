import { useCallback, useEffect, useRef, useState } from 'react'
import type { Snapshot, LogLine, AuthState, SessionUser } from '@shared/api'
import ConsoleView from './Console'
import Addresses from './Addresses'
import Host from './Host'
import Login from './Login'
import ServerDetail from './ServerDetail'
import { ServerRow } from './ServerRow'
import { AttachPage, AttachPointer, ScanPanel } from './Attach'
import { dashboard, type ConnectionState } from './client'
import { SectionHead } from './controls'
import { useRoute, navigate, href } from './router'
import { AppSidebar } from './AppSidebar'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'

/**
 * The gate.
 *
 * Auth state is resolved before anything else mounts, so no request goes out
 * and no socket opens until we know who is asking. Rendering the dashboard
 * first and swapping in a login screen on the resulting 401 would briefly show
 * the shell of a page that exists to be protected.
 */
export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null)

  const refreshAuth = useCallback(() => {
    dashboard
      .getAuthState()
      .then(setAuth)
      .catch(() => setAuth({ configured: true, user: null, mustChangePassword: false }))
  }, [])

  useEffect(() => {
    refreshAuth()
    // A session can expire while the tab is open. When it does, drop straight
    // back to the login screen rather than leaving stale numbers on screen.
    return dashboard.onAuthLost(() => setAuth({ configured: true, user: null, mustChangePassword: false }))
  }, [refreshAuth])

  if (!auth) return <p className="p-5 text-[13px] text-muted-foreground">Checking…</p>
  if (!auth.user) return <Login mustChangePassword={false} onDone={refreshAuth} />
  if (auth.mustChangePassword) {
    return <Login mustChangePassword username={auth.user.username} onDone={refreshAuth} />
  }
  return <Dashboard user={auth.user} onSignedOut={refreshAuth} />
}

/**
 * The first-run state, in board grammar. Shown when discovery found nothing:
 * the one moment the product must explain itself instead of its servers.
 * The masthead above already says no reading is being claimed; this says how
 * to become visible.
 */
function FirstRun({ canEdit, onChanged }: { canEdit: boolean; onChanged: () => void }) {
  return (
    <div className="mx-auto max-w-2xl">
      {/*
        The first thing on a first run is an ACTION, not an essay. The
        explanation below still matters, but a new operator whose servers
        live somewhere this dashboard has never heard of should be one click
        from having them found rather than one configuration file from it.
      */}
      {canEdit && (
        <section className="border-t border-border/60 pt-3 pb-6">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            Find your servers
          </h2>
          <p className="prose-line mt-3 text-[13px] leading-relaxed text-muted-foreground">
            Nothing was found in the folder this dashboard watches by default. If your servers are
            somewhere else, it can look for them: it searches your profile, Documents and Desktop,
            and two levels down each drive, for folders holding a{' '}
            <code className="font-mono text-ink">server.properties</code>. Anything it finds is
            offered to you, never added on its own.
          </p>
          <div className="mt-3">
            <ScanPanel onChanged={onChanged} dense />
          </div>
        </section>
      )}
      <section className="border-t border-border/60 pt-3 pb-6">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
          How discovery works
        </h2>
        <p className="prose-line mt-3 text-[13px] leading-relaxed text-muted-foreground">
          This dashboard does not keep a list of servers. Every ten seconds it scans the servers
          root, by default <code className="font-mono text-ink">Documents\MC Servers</code>, or
          wherever <code className="font-mono text-ink">MCDASH_SERVERS_ROOT</code> points, and
          treats each direct subdirectory containing a{' '}
          <code className="font-mono text-ink">level.dat</code> as a server. Running servers are
          recognised by matching Java processes to those directories through the process tree and
          their launch tasks, never by port.
        </p>
      </section>
      <section className="border-t border-border/60 pt-3 pb-6">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
          For a server to appear here
        </h2>
        <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-muted-foreground">
          <li className="prose-line">
            Its directory sits directly under the servers root and contains a world with a{' '}
            <code className="font-mono text-ink">level.dat</code>. A stopped server still appears;
            it is shown as not running.
          </li>
          <li className="prose-line">
            For health beyond up-or-down, its <code className="font-mono text-ink">server.properties</code>{' '}
            sets <code className="font-mono text-ink">enable-rcon=true</code> with a port and
            password. Without RCON the main game thread cannot be probed, and health honestly
            reads UNKNOWN rather than guessed.
          </li>
          <li className="prose-line">
            For the start button, the server needs a way to start that the dashboard can find: a
            Windows scheduled task whose action names the server directory, or a{' '}
            <code className="font-mono text-ink">start.bat</code> in it. Without one, the
            dashboard will not guess a command line.
          </li>
        </ul>
        <p className="prose-line mt-4 text-[12px] leading-relaxed text-faint">
          If your servers live somewhere else, set the root and restart the service. Directories
          without a level.dat are listed under ignored, with the reason each was skipped.
        </p>
      </section>
    </div>
  )
}

function Dashboard({ user, onSignedOut }: { user: SessionUser; onSignedOut: () => void }) {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [buffers, setBuffers] = useState<Record<string, LogLine[]>>({})
  const [rotations, setRotations] = useState<Record<string, number>>({})
  const [conn, setConn] = useState<ConnectionState>('connecting')
  const asked = useRef<Set<string>>(new Set())
  const route = useRoute()

  const MAX_LINES = 5000

  useEffect(() => {
    dashboard
      .getSnapshot()
      .then(setSnap)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
    const offSnap = dashboard.onSnapshot(setSnap)
    const offConn = dashboard.onConnection(setConn)
    return () => {
      offSnap()
      offConn()
    }
  }, [])

  // Subscribed at app level, not inside the console view, so every tab keeps
  // filling its buffer whichever view is on screen. Switching to the console is
  // then instant instead of blank.
  useEffect(() => {
    return dashboard.onLogBatch((batch) => {
      setBuffers((prev) => {
        const next = (prev[batch.serverId] ?? []).concat(batch.lines)
        return {
          ...prev,
          [batch.serverId]: next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next,
        }
      })
      if (batch.rotated) {
        setRotations((r) => ({ ...r, [batch.serverId]: (r[batch.serverId] ?? 0) + 1 }))
      }
    })
  }, [])

  const ensureBacklog = useCallback((id: string) => {
    if (asked.current.has(id)) return
    asked.current.add(id)
    void dashboard.getLogBacklog(id).then((lines) => {
      setBuffers((prev) => (prev[id]?.length ? prev : { ...prev, [id]: lines }))
    })
  }, [])

  // Prime every live tab once discovery knows about it.
  useEffect(() => {
    for (const s of snap?.servers ?? []) {
      if (s.classification === 'live') ensureBacklog(s.id)
    }
  }, [snap, ensureBacklog])

  const live = snap?.servers.filter((s) => s.classification === 'live') ?? []
  const other = snap?.servers.filter((s) => s.classification !== 'live') ?? []
  const selected = route.name === 'server' ? snap?.servers.find((s) => s.id === route.id) : undefined
  const isAdmin = user.role === 'admin'

  return (
    // TooltipProvider is required ABOVE the sidebar: SidebarMenuButton's
    // tooltip renders a Radix Tooltip, and this shadcn generation does not
    // bundle the provider inside SidebarProvider. Without it the whole app
    // throws on mount and renders a blank page -- found live, 2026-07-31.
    <TooltipProvider>
    <SidebarProvider>
      <AppSidebar
        route={route}
        servers={snap?.servers ?? []}
        user={user}
        onSignOut={() => void dashboard.logout().then(onSignedOut)}
      />
      <SidebarInset>
        <header className="flex h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge/60 px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
        <Breadcrumb>
          <BreadcrumbList>
            {route.name === 'server' ? (
              <>
                <BreadcrumbItem>
                  <BreadcrumbLink href={href({ name: 'fleet' })}>Servers</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                {route.page !== 'overview' ? (
                  <>
                    <BreadcrumbItem>
                      <BreadcrumbLink href={href({ name: 'server', id: route.id, page: 'overview' })}>
                        {selected?.name ?? route.id}
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbPage className="capitalize">{route.page}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </>
                ) : (
                  <BreadcrumbItem>
                    <BreadcrumbPage>{selected?.name ?? route.id}</BreadcrumbPage>
                  </BreadcrumbItem>
                )}
              </>
            ) : (
              <BreadcrumbItem>
                <BreadcrumbPage>
                  {route.name === 'console'
                    ? 'Console'
                    : route.name === 'addresses'
                      ? 'Addresses'
                      : route.name === 'attach'
                        ? 'Attach'
                        : 'Servers'}
                </BreadcrumbPage>
              </BreadcrumbItem>
            )}
          </BreadcrumbList>
        </Breadcrumb>

        {/* Visible from the console and address tabs too: a host-wide event is
            the reason the other tabs look wrong, and finding out should not
            require being on the right page. */}
        {snap &&
          snap.host.fleet.fault !== 'none' &&
          snap.host.fleet.fault !== 'server' &&
          route.name !== 'fleet' && (
            <a
              href={href({ name: 'fleet' })}
              className="rounded-md border border-warn px-2 py-1 text-[11px] font-medium text-warn transition-colors duration-150 hover:bg-warn/10"
              title={snap.host.fleet.headline}
            >
              {snap.host.fleet.fault === 'host' ? 'Host-wide event' : 'Readings unreliable'}
            </a>
          )}

        {/* Acknowledging an IP change is admin-only server-side. A viewer is
            shown the alert but not a button that would refuse them. A control
            you are not allowed to use should not be offered. */}
        {snap?.network.publicIp.changed && route.name !== 'addresses' && (
          isAdmin ? (
            <a
              href={href({ name: 'addresses' })}
              className="rounded-md border border-bad px-2 py-1 text-[11px] font-medium text-bad transition-colors duration-150 hover:bg-bad/10"
            >
              Public IP changed
            </a>
          ) : (
            <span
              className="rounded-md border border-bad px-2 py-1 text-[11px] font-medium text-bad"
              title="An admin needs to acknowledge this."
            >
              Public IP changed
            </span>
          )
        )}

        <div className="ml-auto flex items-center gap-3">
          {snap && (
            <span className="tnum flex items-center gap-2 font-mono text-[11px] text-faint">
              {/*
                The only thing on the page that moves on a timer, and the only
                question a static screenshot of a dashboard cannot answer: is
                this still live, or am I looking at a frozen picture? One dot,
                one pulse per snapshot, nothing that carries a reading.
              */}
              <span
                key={snap.scannedAt}
                className={`live-dot ${conn === 'open' ? 'live-dot-tick text-ok' : 'text-faint'}`}
                aria-hidden="true"
              />
              {new Date(snap.scannedAt).toLocaleTimeString()} · {snap.scanMs} ms
            </span>
          )}
          {/* A dashboard whose own connection has dropped shows stale numbers
              that look current. Say so rather than letting them sit there. */}
          {conn !== 'open' && (
            <span
              className="rounded-md border border-warn px-2 py-1 text-[11px] font-medium text-warn"
              title="These readings are frozen at the last update received."
            >
              {conn === 'connecting' ? 'Connecting…' : 'Disconnected'}
            </span>
          )}
          {/* Quiet chrome: a maintenance control must never be the brightest
              thing on a calm board (finish review, fix 7). */}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-ink"
            onClick={() => void dashboard.refresh()}
          >
            Refresh
          </Button>
        </div>
        </header>

        <main className="flex-1 overflow-auto px-4 py-4 md:px-6">
        {err && (
          <p className="prose-line rounded-md border border-bad bg-bad/10 px-3 py-2 text-[13px] text-bad">
            {err}
          </p>
        )}
        {!err && !snap && <p className="text-[13px] text-muted-foreground">Scanning…</p>}

        {snap && route.name === 'console' && (
          <div className="h-[calc(100dvh-8rem)]">
            <ConsoleView
              servers={snap.servers}
              buffers={buffers}
              rotations={rotations}
              ensureBacklog={ensureBacklog}
              canEdit={isAdmin}
            />
          </div>
        )}

        {snap && route.name === 'addresses' && (
          <Addresses servers={snap.servers} network={snap.network} />
        )}

        {/* Attaching makes a folder eligible for start and settings, so the
            surface is admin-only. A viewer following a bookmark is told why
            rather than shown a page of controls that would refuse them. */}
        {snap && route.name === 'attach' && (
          isAdmin ? (
            <AttachPage
              attachments={snap.attachments ?? []}
              identity={snap.identity}
              onChanged={() => void dashboard.refresh()}
            />
          ) : (
            <div className="mx-auto max-w-lg py-16 text-center">
              <h2 className="text-[15px] font-semibold text-ink">Admins only</h2>
              <p className="prose-line mx-auto mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
                Attaching a folder makes it eligible for start and for settings changes, so it is
                an admin action. You can see everything already attached on the board.
              </p>
            </div>
          )
        )}

        {snap && route.name === 'server' && (
          selected ? (
            <ServerDetail
              s={selected}
              page={route.page}
              canEdit={isAdmin}
              lines={buffers[selected.id] ?? []}
              ensureBacklog={ensureBacklog}
            />
          ) : (
            <div className="mx-auto max-w-lg py-16 text-center">
              <h2 className="text-[15px] font-semibold text-ink">No server with that id</h2>
              <p className="prose-line mx-auto mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
                Nothing in the current scan matches <code className="font-mono text-ink">{route.id}</code>.
                It may have been renamed, or the link may be from a different machine.
              </p>
              <a
                href={href({ name: 'fleet' })}
                className="mt-4 inline-block rounded-md border border-edge px-3 py-1.5 text-[12px] text-ink transition-colors duration-150 hover:border-edge-strong hover:bg-panel2"
              >
                Back to all servers
              </a>
            </div>
          )
        )}

        {snap && route.name === 'fleet' && (
          <>
            {/* Two JVMs on one world. Above everything, unmissable, and NOT
                dismissable: the dashboard cannot fix this and cannot prevent it,
                so the only useful thing it can do is refuse to let it scroll
                past. It clears itself when the condition clears. */}
            {snap.doubleSpawn.map((a) => (
              <section
                key={a.server}
                className="mb-4 rounded-xl border-2 border-bad bg-bad/10 p-4"
              >
                <h2 className="text-[14px] font-bold text-bad">
                  {a.server}: two java processes are serving one world
                </h2>
                <p className="prose-line mt-1.5 text-[12px] leading-relaxed text-ink">{a.detail}</p>
                <p className="mt-1.5 font-mono text-[11px] text-faint">
                  {a.dir} · pids {a.pids.join(', ')} · first seen{' '}
                  {new Date(a.at).toLocaleTimeString()}
                </p>
              </section>
            ))}

            {/* Above the grid, not inside it: when the machine is the problem
                that is one statement about the page, not a property of a card. */}
            <Host host={snap.host} identity={snap.identity} />

            {/* The dashboard's most honest moment, made actionable: a running
                server it can see and is not watching. Admin only, because
                attaching makes a folder eligible for start and settings. */}
            {/* `?? []` deliberately, and the same reason as identity.unwatched
                above it: the browser holds a build that can be newer than the
                service it is talking to for as long as it takes to restart,
                and a white screen is a worse answer than an empty list. */}
            {isAdmin && (
              <AttachPointer attachments={snap.attachments ?? []} identity={snap.identity} />
            )}

            {/* The board: one full-width row per live server, single column by
                design. A departure board is read down, not tiled. */}
            {live.length === 0 && other.length === 0 ? (
              <FirstRun canEdit={isAdmin} onChanged={() => void dashboard.refresh()} />
            ) : (
              <div className="border-t border-border/60">
                {live.map((s) => (
                  <ServerRow key={s.id} s={s} onOpen={(id) => navigate({ name: 'server', id, page: 'overview' })} />
                ))}
              </div>
            )}

            {other.length > 0 && (
              <section className="mt-7">
                <SectionHead
                  title="Not in service"
                  note="Kept visible so they get cleaned up rather than quietly forgotten."
                />
                <div>
                  {other.map((s) => (
                    <ServerRow key={s.id} s={s} onOpen={(id) => navigate({ name: 'server', id, page: 'overview' })} />
                  ))}
                </div>
              </section>
            )}

            {snap.ignored.length > 0 && (
              <section className="mt-7">
                <SectionHead
                  title="Not Minecraft servers"
                  note="Directories under the servers root with no level.dat, listed with the reason each was skipped."
                />
                <ul className="space-y-1 text-[12px] text-muted-foreground">
                  {snap.ignored.map((d) => (
                    <li key={d.name} className="prose-line">
                      <span className="font-mono text-ink">{d.name}</span>. {d.reason}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
        </main>
      </SidebarInset>
    </SidebarProvider>
    </TooltipProvider>
  )
}
