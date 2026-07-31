import { useCallback, useEffect, useRef, useState } from 'react'
import type { Snapshot, LogLine, AuthState, SessionUser } from '@shared/api'
import ConsoleView from './Console'
import Addresses from './Addresses'
import Host from './Host'
import Login from './Login'
import ServerDetail from './ServerDetail'
import { ServerCard } from './ServerCard'
import { dashboard, type ConnectionState } from './client'
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

/** A heading with the sentence that explains why the section exists. */
function SectionHead({ title, note }: { title: string; note: string }) {
  return (
    <header className="mb-2.5">
      <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-muted-foreground">{title}</h2>
      <p className="prose-line mt-0.5 text-[12px] leading-relaxed text-faint">{note}</p>
    </header>
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
                <BreadcrumbItem>
                  <BreadcrumbPage>{selected?.name ?? route.id}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            ) : (
              <BreadcrumbItem>
                <BreadcrumbPage>
                  {route.name === 'console'
                    ? 'Console'
                    : route.name === 'addresses'
                      ? 'Addresses'
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
          <Button variant="outline" size="sm" onClick={() => void dashboard.refresh()}>
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
            />
          </div>
        )}

        {snap && route.name === 'addresses' && (
          <Addresses servers={snap.servers} network={snap.network} />
        )}

        {snap && route.name === 'server' && (
          selected ? (
            <ServerDetail
              s={selected}
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

            <div className="grid gap-4 xl:grid-cols-2">
              {live.map((s) => (
                <ServerCard
                  key={s.id}
                  s={s}
                  canEdit={isAdmin}
                  onOpen={(id) => navigate({ name: 'server', id })}
                />
              ))}
            </div>

            {other.length > 0 && (
              <section className="mt-7">
                <SectionHead
                  title="Not in service"
                  note="Kept visible so they get cleaned up rather than quietly forgotten."
                />
                <div className="grid gap-4 xl:grid-cols-2">
                  {other.map((s) => (
                    <ServerCard
                      key={s.id}
                      s={s}
                      canEdit={isAdmin}
                      onOpen={(id) => navigate({ name: 'server', id })}
                    />
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
