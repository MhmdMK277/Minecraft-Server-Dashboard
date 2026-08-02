import { useEffect, useState } from 'react'

/**
 * A hash router, still dependency-free.
 *
 * Hash rather than the History API because a path route needs the server to
 * serve index.html for URLs it has never heard of, and presentation work does
 * not touch `server/http.ts`. The hash never reaches the server, so deep
 * links and refreshes work as they are.
 *
 * A server page is addressable: `#/server/<id>/<page>`. The id is encoded
 * (server names contain spaces); the page is a fixed vocabulary and anything
 * unknown falls back to overview, so an old bookmark `#/server/<id>` still
 * lands somewhere sensible.
 */

export const SERVER_PAGES = ['overview', 'players', 'console', 'worlds', 'gamerules', 'backups', 'settings'] as const
export type ServerPage = (typeof SERVER_PAGES)[number]

export type Route =
  | { name: 'fleet' }
  | { name: 'server'; id: string; page: ServerPage }
  | { name: 'console' }
  | { name: 'addresses' }
  | { name: 'attach' }
  | { name: 'create' }
  | { name: 'public' }

function asPage(raw: string | undefined): ServerPage {
  return (SERVER_PAGES as readonly string[]).includes(raw ?? '') ? (raw as ServerPage) : 'overview'
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '')
  const [head, ...rest] = path.split('/')
  if (head === 'server' && rest.length > 0) {
    // The last segment is the page only when it is a known page name;
    // otherwise the whole rest is the id (ids may contain a slash once
    // decoded, and old links have no page segment at all).
    const last = rest[rest.length - 1] ?? ''
    if (rest.length > 1 && (SERVER_PAGES as readonly string[]).includes(last)) {
      return { name: 'server', id: decodeURIComponent(rest.slice(0, -1).join('/')), page: asPage(last) }
    }
    return { name: 'server', id: decodeURIComponent(rest.join('/')), page: 'overview' }
  }
  if (head === 'console') return { name: 'console' }
  if (head === 'addresses') return { name: 'addresses' }
  if (head === 'attach') return { name: 'attach' }
  if (head === 'create') return { name: 'create' }
  if (head === 'public') return { name: 'public' }
  return { name: 'fleet' }
}

export function href(route: Route): string {
  switch (route.name) {
    case 'server':
      return route.page === 'overview'
        ? `#/server/${encodeURIComponent(route.id)}`
        : `#/server/${encodeURIComponent(route.id)}/${route.page}`
    case 'console':
      return '#/console'
    case 'addresses':
      return '#/addresses'
    case 'attach':
      return '#/attach'
    case 'create':
      return '#/create'
    case 'public':
      return '#/public'
    default:
      return '#/'
  }
}

export function navigate(route: Route): void {
  const next = href(route)
  if (window.location.hash !== next) window.location.hash = next
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
