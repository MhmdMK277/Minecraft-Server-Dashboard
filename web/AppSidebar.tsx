import {
  Archive,
  ArrowLeft,
  ChevronsUpDown,
  Gauge,
  LayoutDashboard,
  LogOut,
  Network,
  Settings2,
  Terminal,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ServerStatus, SessionUser } from '@shared/api'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Indicator, TONE_TEXT, verdict, verdictSentence } from './status'
import { href, type Route, type ServerPage } from './router'
import logo from '../docs/images/logo.png'

const VIEWS = [
  { route: { name: 'fleet' } as Route, label: 'Servers', icon: LayoutDashboard },
  { route: { name: 'console' } as Route, label: 'Console', icon: Terminal },
  { route: { name: 'addresses' } as Route, label: 'Addresses', icon: Network },
]

const SERVER_NAV: Array<{ page: ServerPage; label: string; icon: LucideIcon; adminOnly?: boolean }> = [
  { page: 'overview', label: 'Overview', icon: Gauge },
  { page: 'players', label: 'Players', icon: Users },
  { page: 'console', label: 'Console', icon: Terminal },
  { page: 'backups', label: 'Backups', icon: Archive },
  { page: 'settings', label: 'Settings', icon: Settings2, adminOnly: true },
]

function viewActive(view: Route, route: Route): boolean {
  if (view.name === 'fleet') return route.name === 'fleet'
  return view.name === route.name
}

/**
 * The navigation rail. Two contexts, the VoxelDash model:
 *
 * On fleet views: the three views plus one entry per live server, each
 * carrying the same tone + confidence indicator as its row, so the sidebar
 * is a miniature of the board and a fault is visible from every screen.
 *
 * Inside a server: a way back, that server's pages, and the same server
 * list as a switcher. The colour channel still belongs to the lamps.
 */
export function AppSidebar({
  route,
  servers,
  user,
  onSignOut,
}: {
  route: Route
  servers: ServerStatus[]
  user: SessionUser
  onSignOut: () => void
}) {
  const live = servers.filter((s) => s.classification === 'live')
  const isAdmin = user.role === 'admin'
  const current = route.name === 'server' ? servers.find((s) => s.id === route.id) : undefined

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="h-auto py-2">
              <a href={href({ name: 'fleet' })}>
                {/* The brand block: glyph in a tile, name, version tag. The
                    tile is what survives icon-collapse, so it reads alone.
                    The wordmark wraps rather than clipping (layout law 1). */}
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary ring-1 ring-border">
                  <img src={logo} alt="" width={20} height={20} className="rounded-[3px]" />
                </span>
                <span className="grid leading-tight">
                  <span className="whitespace-normal text-[13px] font-semibold tracking-[-0.01em] text-foreground [text-wrap:balance]">
                    Minecraft Server Dashboard
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    attach-model monitor
                  </span>
                </span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {current ? (
          <>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild tooltip="All servers">
                      <a href={href({ name: 'fleet' })}>
                        <ArrowLeft />
                        <span>All servers</span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            <SidebarGroup>
              <SidebarGroupLabel className="gap-1.5 font-mono uppercase tracking-[0.1em]">
                <span className={TONE_TEXT[verdict(current).tone]}>
                  <Indicator
                    tone={verdict(current).tone}
                    confidence={verdict(current).confidence}
                    large={false}
                  />
                </span>
                <span className="truncate">{current.name}</span>
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {SERVER_NAV.filter((n) => !n.adminOnly || isAdmin).map((n) => (
                    <SidebarMenuItem key={n.page}>
                      <SidebarMenuButton
                        asChild
                        isActive={route.name === 'server' && route.page === n.page}
                        tooltip={n.label}
                        className="data-[active=true]:text-sidebar-primary"
                      >
                        <a href={href({ name: 'server', id: current.id, page: n.page })}>
                          <n.icon />
                          <span>{n.label}</span>
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        ) : (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {VIEWS.map((v) => (
                  <SidebarMenuItem key={v.label}>
                    {/* The active view carries the accent. Server entries
                        deliberately do NOT: their colour channel belongs to
                        the status indicator. */}
                    <SidebarMenuButton
                      asChild
                      isActive={viewActive(v.route, route)}
                      tooltip={v.label}
                      className="data-[active=true]:text-sidebar-primary"
                    >
                      <a href={href(v.route)}>
                        <v.icon />
                        <span>{v.label}</span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {live.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Servers</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {live.map((s) => {
                  const v = verdict(s)
                  return (
                    <SidebarMenuItem key={s.id}>
                      <SidebarMenuButton
                        asChild
                        isActive={route.name === 'server' && route.id === s.id}
                        tooltip={`${s.name}: ${verdictSentence(v)}`}
                      >
                        <a href={href({ name: 'server', id: s.id, page: 'overview' })}>
                          <span className={`flex size-4 items-center justify-center ${TONE_TEXT[v.tone]}`}>
                            <Indicator tone={v.tone} confidence={v.confidence} large={v.attention} />
                          </span>
                          <span className="truncate">{s.name}</span>
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg">
                  <span className="grid leading-tight">
                    <span className="text-[13px] font-medium">{user.username}</span>
                    <span className="text-[11px] text-muted-foreground">{user.role}</span>
                  </span>
                  <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuLabel className="grid gap-0.5 font-normal">
                  <span className="text-[12px]">
                    Signed in since {new Date(user.createdAt).toLocaleString()}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    Session expires at {new Date(user.expiresAt).toLocaleTimeString()}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onSignOut}>
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
