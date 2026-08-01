import { useState } from 'react'
import type { ServerStatus, NetworkInfo } from '@shared/api'
import { formatAddress, formatWebUrl, DEFAULT_MC_PORT } from '@shared/address'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { dashboard } from './client'

/**
 * Connection addresses.
 *
 * Ports come from server.properties via the snapshot, never a hardcoded map.
 * The LAN address is discovered from the active adapter, because this machine
 * is on Wi-Fi now and moving to Ethernet later.
 *
 * :25565 is omitted everywhere it applies -- it is the default, and typing it
 * confuses people. Every other port is shown.
 */

function Copy({ value }: { value: string | null }) {
  const [done, setDone] = useState(false)
  if (!value) return <span className="text-muted-foreground">–</span>
  return (
    <span className="inline-flex items-center gap-1.5">
      <code className="font-mono text-[12px]">{value}</code>
      <Button
        variant="outline"
        size="sm"
        className="h-5 px-1.5 text-[10px] text-muted-foreground"
        onClick={() => {
          void navigator.clipboard.writeText(value)
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        }}
      >
        {done ? 'copied' : 'copy'}
      </Button>
    </span>
  )
}

export default function Addresses({
  servers,
  network,
}: {
  servers: ServerStatus[]
  network: NetworkInfo
}) {
  const live = servers.filter((s) => s.classification === 'live')
  const lan = network.lanAddress
  const ip = network.publicIp
  /**
   * When a virtual adapter owns the default route (a VPN, per the route
   * read alongside every address fetch, PublicIpState.route), the measured
   * public address is the VPN's exit, not this house. Handing it out as a
   * join address would be finding F7 again, so the outside column is
   * withheld and the reason is stated instead.
   */
  const viaVpn = ip.route?.virtual === true
  // Once DDNS exists, hostname replaces the raw address and nothing else changes.
  const outside = viaVpn ? null : (ip.hostname ?? ip.address)

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      {viaVpn && (
        <div className="rounded-lg border border-warn bg-warn/10 px-3 py-2.5 text-[12px]">
          <p className="font-semibold text-warn">
            A VPN owns this machine's internet route right now.
          </p>
          <p className="prose-line mt-0.5 leading-relaxed text-muted-foreground">
            The default route goes through{' '}
            <code className="font-mono text-ink">{ip.route?.adapter}</code> (
            {ip.route?.description}), a virtual adapter, so the public address that can be measured
            {ip.address ? (
              <>
                {' '}
                (<code className="font-mono">{ip.address}</code>)
              </>
            ) : null}{' '}
            is the VPN's exit, not this house. Players cannot join through it, and your home
            address cannot be measured while the VPN carries the traffic, so the outside column is
            withheld rather than shown wrong.
          </p>
        </div>
      )}

      {ip.changed && (
        <div className="flex items-start gap-3 rounded-lg border border-bad bg-bad/10 px-3 py-2.5">
          <div className="flex-1 text-[12px]">
            <p className="font-semibold text-bad">Your public address has changed.</p>
            <p className="mt-0.5 text-muted-foreground">
              {ip.previous ? (
                <>
                  Was <code className="font-mono">{ip.previous}</code>, now{' '}
                  <code className="font-mono">{ip.address}</code>.{' '}
                </>
              ) : null}
              {viaVpn
                ? 'The route is currently through a VPN, so this is the VPN exit changing, not necessarily your home address.'
                : 'Anyone using the old address cannot connect until you send them the new one.'}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void dashboard.acknowledgeIpChange()}>
            Got it
          </Button>
        </div>
      )}

      <div className="surface overflow-hidden rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Server</TableHead>
              <TableHead>On this desktop</TableHead>
              <TableHead>Same home network</TableHead>
              <TableHead>Outside / abroad</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {live.map((s) => (
              <TableRow key={s.id} className="align-top">
                <TableCell>
                  <div className="font-medium text-ink">{s.name}</div>
                  <div className="text-[11px] text-muted-foreground">{s.slp?.versionName ?? s.kind}</div>
                </TableCell>
                <TableCell>
                  <Copy value={formatAddress('localhost', s.gamePort)} />
                </TableCell>
                <TableCell>
                  <Copy value={formatAddress(lan, s.gamePort)} />
                </TableCell>
                <TableCell>
                  <Copy value={formatAddress(outside, s.gamePort)} />
                </TableCell>
              </TableRow>
            ))}

            {live
              .filter((s) => s.dynmap)
              .map((s) => {
                const d = s.dynmap!
                const dead = !d.responding
                const url = (h: string | null) => formatWebUrl(h, d.port)
                return (
                  <TableRow key={`${s.id}-dynmap`} className="align-top">
                    <TableCell>
                      <div className="flex items-center gap-2 font-medium text-ink">
                        Dynmap. {s.name}
                        {dead && (
                          <Badge className="border-bad/40 bg-bad/15 text-[10px] text-bad">
                            not running
                          </Badge>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {dead
                          ? `port ${d.port} is configured but nothing is listening`
                          : 'web map, open in a browser'}
                      </div>
                    </TableCell>
                    {dead ? (
                      <TableCell colSpan={3} className="text-[12px] text-muted-foreground">
                        No working link to show. The plugin is not loaded, so these addresses would
                        fail if handed out.
                      </TableCell>
                    ) : (
                      <>
                        <TableCell>
                          <Copy value={url('localhost')} />
                        </TableCell>
                        <TableCell>
                          <Copy value={url(lan)} />
                        </TableCell>
                        <TableCell>
                          <Copy value={url(outside)} />
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                )
              })}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-1.5 text-[12px] text-muted-foreground">
        <p className="prose-line">
          <strong className="text-ink">
            The outside address will not work from inside this house.
          </strong>{' '}
          Many home routers do not loop a connection back to themselves (this is called NAT
          hairpinning, and support for it varies by model), so testing your own public address from
          your own network can fail even when everything is set up correctly. That is the router,
          not a fault in your server. Use the home-network column here instead.
        </p>
        <p className="prose-line">
          The public address is dynamic and changes without warning. Last checked{' '}
          {ip.fetchedAt ? new Date(ip.fetchedAt).toLocaleTimeString() : 'never'}
          {ip.stale ? ', could not be refreshed, showing last known value' : ''}
          {ip.error ? ` (${ip.error})` : ''}
          {ip.route
            ? `, measured while ${ip.route.adapter} owned the internet route`
            : ', route not read for this measurement'}
          .
        </p>
        <p className="prose-line">
          LAN address discovered from{' '}
          <code className="font-mono">{network.lanInterface ?? 'no active adapter'}</code>. Port
          omitted where it is {DEFAULT_MC_PORT}, the default.
        </p>
      </div>
    </div>
  )
}
