import { ChevronsUpDown, LayoutDashboard, LogOut, Network, Terminal } from 'lucide-react'
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
import { href, type Route } from './router'
import logo from '../docs/images/logo.png'

const VIEWS = [
  { route: { name: 'fleet' } as Route, label: 'Servers', icon: LayoutDashboard },
  { route: { name: 'console' } as Route, label: 'Console', icon: Terminal },
  { route: { name: 'addresses' } as Route, label: 'Addresses', icon: Network },
]

function viewActive(view: Route, route: Route): boolean {
  if (view.name === 'fleet') return route.name === 'fleet'
  return view.name === route.name
}

/**
 * The navigation rail. Views on top; one entry per live server below, each
 * carrying the same tone + confidence indicator as its card, so the sidebar
 * is a miniature of the fleet read: a calm fleet is a column of small quiet
 * dots, and a fault is visible from every screen, not only the fleet.
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

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <a href={href({ name: 'fleet' })}>
                {/* The brand block: glyph in a tile, name, version. The tile is
                    what survives icon-collapse, so it has to read alone. */}
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary ring-1 ring-border">
                  <img src={logo} alt="" width={20} height={20} className="rounded-[3px]" />
                </span>
                <span className="grid leading-tight">
                  <span className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
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
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {VIEWS.map((v) => (
                <SidebarMenuItem key={v.label}>
                  {/* The active view carries the accent. Server entries below
                      deliberately do NOT: their colour channel belongs to the
                      status indicator, and blue must never dress a server. */}
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
                        <a href={href({ name: 'server', id: s.id })}>
                          {/* Not a lucide icon: the same mark as the card, so
                              tone and confidence read identically everywhere. */}
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
