import {
  Activity,
  Archive,
  ChevronsUpDown,
  Dices,
  Earth,
  FolderPlus,
  Gauge,
  Globe,
  LayoutDashboard,
  LogOut,
  Network,
  PackagePlus,
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
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

const VIEWS: Array<{ route: Route; label: string; icon: LucideIcon; adminOnly?: boolean }> = [
  { route: { name: 'fleet' }, label: 'Servers', icon: LayoutDashboard },
  { route: { name: 'console' }, label: 'Console', icon: Terminal },
  { route: { name: 'addresses' }, label: 'Addresses', icon: Network },
  // Admin only: attaching a folder makes it eligible for start and settings.
  { route: { name: 'attach' }, label: 'Attach', icon: FolderPlus, adminOnly: true },
  // Admin only: creation downloads executable code and writes a folder.
  { route: { name: 'create' }, label: 'Create', icon: PackagePlus, adminOnly: true },
  // Admin only: exposing a world to the internet is a security decision.
  { route: { name: 'public' }, label: 'Public', icon: Globe, adminOnly: true },
]

const SERVER_NAV: Array<{ page: ServerPage; label: string; icon: LucideIcon; adminOnly?: boolean }> = [
  { page: 'overview', label: 'Overview', icon: Gauge },
  { page: 'players', label: 'Players', icon: Users },
  { page: 'console', label: 'Console', icon: Terminal },
  { page: 'worlds', label: 'Worlds', icon: Earth },
  // Readable by a viewer (it is a reading); changing a rule is gated at the
  // route and the buttons, not by hiding the page.
  { page: 'gamerules', label: 'Game Rules', icon: Dices },
  { page: 'profiling', label: 'Profiling', icon: Activity },
  { page: 'backups', label: 'Backups', icon: Archive },
  { page: 'settings', label: 'Settings', icon: Settings2, adminOnly: true },
]

function viewActive(view: Route, route: Route): boolean {
  if (view.name === 'fleet') return route.name === 'fleet'
  return view.name === route.name
}

/**
 * One server in the tree.
 *
 * The expansion is derived from the ROUTE, never from local open/closed
 * state: the server named in the URL is the one whose pages show, exactly
 * one at a time, so a deep link or a refresh lands already expanded and
 * there is no chevron state to get out of sync with where the reader
 * actually is.
 *
 * On the icon-collapsed rail the sub-list cannot render (the sidebar hides
 * it at icon width), so the row becomes a flyout: clicking the lamp opens a
 * menu of that server's pages. Deliberately the SAME DropdownMenu primitives
 * the footer account menu already uses -- an existing pattern, not new
 * machinery. The `tooltip` prop is NOT passed in that mode: SidebarMenuButton
 * would wrap itself in a TooltipTrigger and stacking a DropdownMenuTrigger
 * on top of that gives Radix two asChild parents fighting over one button.
 */
function ServerNavItem({
  s,
  route,
  isAdmin,
  closeMobile,
}: {
  s: ServerStatus
  route: Route
  isAdmin: boolean
  closeMobile: () => void
}) {
  const { state, isMobile } = useSidebar()
  const iconRail = state === 'collapsed' && !isMobile
  const selected = route.name === 'server' && route.id === s.id
  const v = verdict(s)
  const pages = SERVER_NAV.filter((n) => !n.adminOnly || isAdmin)

  const lamp = (
    <span className={`flex size-4 items-center justify-center ${TONE_TEXT[v.tone]}`}>
      <Indicator tone={v.tone} confidence={v.confidence} large={v.attention} />
    </span>
  )

  if (iconRail) {
    return (
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton isActive={selected}>
              {lamp}
              <span className="truncate">{s.name}</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="w-52">
            <DropdownMenuLabel className="grid gap-0.5 font-normal">
              <span className="text-[12px] font-medium">{s.name}</span>
              <span className="prose-line text-[11px] text-muted-foreground">{verdictSentence(v)}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {pages.map((n) => (
              <DropdownMenuItem key={n.page} asChild>
                <a href={href({ name: 'server', id: s.id, page: n.page })}>
                  <n.icon />
                  {n.label}
                </a>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    )
  }

  return (
    <SidebarMenuItem>
      {/* The row itself goes to Overview, which is also what expands it.
          Server rows deliberately carry NO accent: their colour channel
          belongs to the status lamp; the accent marks the active page. */}
      <SidebarMenuButton asChild isActive={selected} tooltip={`${s.name}: ${verdictSentence(v)}`}>
        <a href={href({ name: 'server', id: s.id, page: 'overview' })} onClick={closeMobile}>
          {lamp}
          <span className="truncate">{s.name}</span>
        </a>
      </SidebarMenuButton>
      {selected && (
        <SidebarMenuSub>
          {pages.map((n) => (
            <SidebarMenuSubItem key={n.page}>
              <SidebarMenuSubButton
                asChild
                isActive={route.name === 'server' && route.page === n.page}
                className="data-[active=true]:text-sidebar-primary"
              >
                <a href={href({ name: 'server', id: s.id, page: n.page })} onClick={closeMobile}>
                  <n.icon />
                  <span>{n.label}</span>
                </a>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  )
}

/**
 * The navigation rail: ONE tree, no modes (operator decision 2026-08-07,
 * replacing the two-context VoxelDash model).
 *
 * The top-level views stay visible everywhere. The server list stays visible
 * everywhere, each entry carrying the same tone + confidence indicator as its
 * board row, so the sidebar remains a miniature of the board and a fault is
 * visible from every screen. The server named in the route expands IN PLACE:
 * its pages nest under its row, so the reader can see where they are and
 * switch servers without leaving anything. The colour channel still belongs
 * to the lamps; the single accent marks the active view or page.
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
  const { isMobile, setOpenMobile } = useSidebar()
  // On the phone-width sheet, choosing a destination must also dismiss the
  // sheet, or the page just navigated to stays hidden behind it.
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false)
  }

  // never-started rides along: a fresh creation must be navigable to be started.
  const live = servers.filter(
    (s) => s.classification === 'live' || s.classification === 'never-started',
  )
  const isAdmin = user.role === 'admin'
  const current = route.name === 'server' ? servers.find((s) => s.id === route.id) : undefined
  // A retired or stale server opened from the board is not in the live list,
  // but "where am I" must never break: it joins the tree while selected.
  const listed = current && !live.some((s) => s.id === current.id) ? [...live, current] : live

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="h-auto py-2">
              <a href={href({ name: 'fleet' })} onClick={closeMobile}>
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
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {VIEWS.filter((v) => !v.adminOnly || isAdmin).map((v) => (
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
                    <a href={href(v.route)} onClick={closeMobile}>
                      <v.icon />
                      <span>{v.label}</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {listed.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Servers</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {listed.map((s) => (
                  <ServerNavItem
                    key={s.id}
                    s={s}
                    route={route}
                    isAdmin={isAdmin}
                    closeMobile={closeMobile}
                  />
                ))}
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
