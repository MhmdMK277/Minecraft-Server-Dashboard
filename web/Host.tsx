import type { HostStatus, HostState, Fault, IdentityScan } from '@shared/api'
import { Indicator, Metric, type Tone } from './status'

/**
 * Host health, shown alongside per-server health rather than folded into it.
 *
 * The thing this panel exists to prevent: four red badges for one event. When
 * every server degrades at once and this dashboard's own event loop is being
 * starved, that is one sentence about the machine, and it belongs at the top of
 * the page in words, not distributed across four cards for the reader to
 * correlate by eye at 2am. See docs/liveness-spec.md §12.
 */

/**
 * `UNMEASURED` is deliberately NOT solid.
 *
 * "We did not measure" and "we measured and the machine is fine" are the same
 * badge in most tools, and that is how an unearned reassurance gets shipped. It
 * uses the dashed form for the same reason a server's UNKNOWN does: it is a
 * statement about the measurement, not about the machine.
 */
const STATE_STYLE: Record<HostState, { tone: Tone; label: string; measured: boolean }> = {
  OK: { tone: 'ok', label: 'Keeping up', measured: true },
  BUSY: { tone: 'warn', label: 'Busy', measured: true },
  STALLING: { tone: 'bad', label: 'Stalling', measured: true },
  UNMEASURED: { tone: 'muted', label: 'Not measured', measured: false },
}

const STATE_TEXT: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  muted: 'text-muted-foreground',
}

/** The masthead's bottom rule steps up in weight when the fault is loud. */
const FAULT_RULE: Record<Fault, string> = {
  none: 'border-b border-border',
  host: 'border-b-2 border-bad/60',
  shared: 'border-b-2 border-warn/40',
  server: 'border-b border-border',
  observer: 'border-b-2 border-warn/40',
}

/**
 * Mirrors LAG_BUSY_MS / LAG_STALLING_MS in server/hostwatch.ts. Copied rather
 * than imported: the browser bundle must not pull in a server module. These are
 * used only to colour a bar. Every verdict on this page is decided server-side
 * and arrives as text, so a drift here changes a shade, never a conclusion.
 */
const BUSY_MS = 250
const STALLING_MS = 2000

export default function Host({
  host,
  identity,
}: {
  host: HostStatus
  identity: IdentityScan
}) {
  const st = STATE_STYLE[host.state]
  const { lag, fleet } = host
  const loud = fleet.fault !== 'none' && fleet.fault !== 'server'
  // An identity failure is fleet-wide by nature, so it belongs here rather than
  // repeated on every card. It is also the failure that looks most like an
  // outage: on 2026-07-29 it turned four healthy servers into four DOWN badges.
  const identityBroken = !identity.ok || identity.unattributed > 0

  return (
    // The masthead of the board: no card, no elevation. A rail for tone and
    // confidence, a hairline rule below that thickens when the fault is loud.
    <section
      className={`rail mb-6 pb-5 pl-5 pt-1 ${STATE_TEXT[st.tone]} ${
        st.measured ? '' : 'rail-dashed'
      } ${FAULT_RULE[fleet.fault]}`}
    >
      <header className="flex flex-wrap items-center gap-2.5 pl-1.5">
        <Indicator
          tone={st.tone}
          confidence={st.measured ? 'measured' : 'unmeasured'}
          large={fleet.fault !== 'none'}
        />
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">This host</h2>
        <span
          className={`text-[12px] ${
            loud ? `font-semibold ${STATE_TEXT[st.tone]}` : 'font-medium text-muted-foreground'
          }`}
        >
          {st.label}
        </span>
        <span className="tnum ml-auto font-mono text-[11px] text-faint">
          held {fleet.scans} scan{fleet.scans === 1 ? '' : 's'} · since{' '}
          {new Date(fleet.since).toLocaleTimeString()}
        </span>
      </header>

      {/*
        The one line that has to be read, and the reason this panel exists above
        the grid rather than as a property of a card. Sized to be read first.
      */}
      <p
        className={`prose-line mt-2.5 pl-1.5 tracking-[-0.02em] ${
          loud ? `text-[19px] font-semibold ${STATE_TEXT[st.tone]}` : 'text-[16px] font-medium text-ink'
        }`}
      >
        {fleet.headline}
      </p>
      <p className="prose-line mt-1.5 pl-1.5 text-[12px] leading-relaxed text-muted-foreground">{fleet.detail}</p>

      {identityBroken && (
        <p className="prose-line mt-2.5 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-warn">
          {identity.ok
            ? `${identity.unattributed} java process${identity.unattributed === 1 ? '' : 'es'} could not be matched to any server directory. Any server shown as not running may in fact be one of them, so those are reported as unknown rather than down.`
            : `Could not enumerate processes on this host${identity.failure ? `: ${identity.failure}` : ''}. Nothing below can be trusted to say whether a server is running. An empty result looks identical to a stopped fleet, so no server is being reported as down.`}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-x-10 gap-y-4 pl-1.5">
        {/* Not flex-1: stretching four figures across a 1500px panel puts 300px
            between each, and a row you have to saccade across is not a row you
            read at a glance. They stay grouped; the sparkline takes the slack. */}
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
          <Metric
            label="Loop lag p95"
            value={`${lag.p95Ms} ms`}
            tier="lead"
            title="95th percentile event-loop delay: how late this process usually is when it wants to run."
          >
            <div className="mt-0.5 text-[10px] text-faint">of {lag.samples} samples</div>
          </Metric>
          <Metric
            label="Worst block"
            value={`${lag.maxMs} ms`}
            tier="lead"
            tone={lag.maxMs >= STALLING_MS ? 'bad' : lag.maxMs >= BUSY_MS ? 'warn' : undefined}
            title="Longest single stretch in which this process could not run. Above 2,000 ms it can manufacture a STALLED verdict on its own."
          >
            <div className="mt-0.5 text-[10px] text-faint">in {lag.windowSeconds}s</div>
          </Metric>
          <Metric
            label="Not scheduled"
            value={`${lag.starvedMs} ms`}
            tier="lead"
            tone={lag.starvedMs > 0 && lag.starvedMs * 2 >= lag.blockedMs ? 'warn' : undefined}
            title="Of the blocked time, how much passed while this process consumed no CPU at all. Nothing in here caused that, so this is the number that is evidence about the machine."
          >
            <div className="mt-0.5 text-[10px] text-faint">{pct(lag.starvedMs, lag.blockedMs)}</div>
          </Metric>
          <Metric
            label="Degraded"
            value={`${fleet.degraded.length}/${fleet.probed}`}
            tier="lead"
            tone={fleet.degraded.length > 0 ? 'warn' : undefined}
            title="Live servers with RCON that are STALLED, HUNG or unreadable. A server without RCON is excluded. It is unreadable in every scan, and a constant cannot correlate with anything."
          >
            <div className="mt-0.5 text-[10px] text-faint">servers probed</div>
          </Metric>
        </div>

        <figure className="ml-auto min-w-0 shrink-0">
          <figcaption className="mb-1 text-[10px] text-faint">
            Event-loop lag · worst per 10s · last 15m
          </figcaption>
          <Sparkline lag={lag} />
        </figure>
      </div>
    </section>
  )
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return 'nothing blocked'
  return `${Math.round((part / whole) * 100)}% of blocked time`
}

/**
 * One series, so no legend: the caption names it.
 *
 * The y-axis floors at 300 ms rather than fitting the data. A chart that
 * rescales to whatever it has turns 3 ms of ordinary timer jitter into a
 * mountain range, and a quiet host has to LOOK quiet or this panel is worse than
 * nothing. The dashed line is the 250 ms mark, above which a block is large
 * enough to distort an RCON reading.
 */
function Sparkline({ lag }: { lag: HostStatus['lag'] }) {
  const W = 300
  const H = 44
  const SLOTS = 90 // 15 minutes of 10 s buckets

  if (lag.history.length === 0) {
    return (
      <div
        className="flex h-11 w-[300px] max-w-full items-center justify-center rounded border border-dashed border-[var(--color-edge)] text-[10px] text-[var(--color-muted)]"
        role="img"
        aria-label="No lag history collected yet"
      >
        collecting…
      </div>
    )
  }

  const ceiling = Math.max(300, ...lag.history.map((b) => b.maxMs))
  const slot = W / SLOTS
  const bar = slot * 0.72
  const y = (v: number) => H - Math.max(v > 0 ? 1.5 : 0.75, (v / ceiling) * (H - 2))

  // Right-aligned: the newest bucket sits at the right edge, so a growing
  // problem grows towards the reader.
  const offset = SLOTS - lag.history.length

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="max-w-full"
      role="img"
      aria-label={`Event-loop lag, worst per 10 second bucket. Peak ${lag.maxMs} milliseconds, 95th percentile ${lag.p95Ms} milliseconds.`}
    >
      {/* Recessive baseline and threshold. */}
      <line x1={0} y1={H - 0.5} x2={W} y2={H - 0.5} stroke="var(--color-edge-strong)" strokeWidth={1} />
      {ceiling > BUSY_MS && (
        <line
          x1={0}
          y1={y(BUSY_MS)}
          x2={W}
          y2={y(BUSY_MS)}
          stroke="var(--color-edge-strong)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      )}
      {lag.history.map((b, i) => {
        const top = y(b.maxMs)
        const fill =
          b.maxMs >= STALLING_MS
            ? 'var(--color-bad)'
            : b.maxMs >= BUSY_MS
              ? 'var(--color-warn)'
              : 'var(--color-muted)'
        return (
          <rect
            key={b.at}
            x={(offset + i) * slot + (slot - bar) / 2}
            y={top}
            width={bar}
            height={H - top - 0.5}
            rx={1}
            fill={fill}
            opacity={b.maxMs >= BUSY_MS ? 1 : 0.55}
          >
            {/* One template string, not interleaved nodes: React requires a
                single text child for <title>, in SVG as well as in <head>. */}
            <title>{`${new Date(b.at).toLocaleTimeString()}, worst ${b.maxMs} ms, mean ${b.meanMs} ms, ${b.starvedMs} ms not scheduled`}</title>
          </rect>
        )
      })}
    </svg>
  )
}
