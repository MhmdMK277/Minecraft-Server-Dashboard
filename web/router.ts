import { useEffect, useState } from 'react'

/**
 * A hash router in thirty lines, and no dependency.
 *
 * Hash rather than the History API because a path route needs the server to
 * serve index.html for URLs it has never heard of, and this pass is presentation
 * only -- `server/http.ts` is not being touched to add a design feature. The
 * hash never reaches the server, so deep links and refreshes work as they are.
 *
 * What this buys, which the previous `useState<View>` could not: a server is
 * addressable. You can leave a tab open on one server, reload without losing
 * your place, and send someone a link to the thing you are looking at.
 */

export type Route =
  | { name: 'fleet' }
  | { name: 'server'; id: string }
  | { name: 'console' }
  | { name: 'addresses' }

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '')
  const [head, ...rest] = path.split('/')
  if (head === 'server' && rest.length > 0) {
    return { name: 'server', id: decodeURIComponent(rest.join('/')) }
  }
  if (head === 'console') return { name: 'console' }
  if (head === 'addresses') return { name: 'addresses' }
  return { name: 'fleet' }
}

export function href(route: Route): string {
  switch (route.name) {
    case 'server':
      return `#/server/${encodeURIComponent(route.id)}`
    case 'console':
      return '#/console'
    case 'addresses':
      return '#/addresses'
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
