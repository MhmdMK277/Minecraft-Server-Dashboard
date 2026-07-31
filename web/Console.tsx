import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { LogLine, ServerStatus } from '@shared/api'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

/**
 * Tabbed console.
 *
 * Virtualisation numbers, chosen for the worst case (GTNH, 209 mods, four tabs
 * streaming at once):
 *
 *   ROW_H          18 px   fixed, so row offsets are arithmetic not measurement
 *   OVERSCAN       20 rows above and below the viewport
 *   MAX_LINES   5,000 per tab, matching the main-process ring buffer
 *
 * Only the visible window plus overscan is ever in the DOM -- roughly 60-80
 * nodes regardless of whether the buffer holds 50 lines or 5,000.
 */
const ROW_H = 18
const OVERSCAN = 20
const MAX_LINES = 5000

const LEVEL_CLASS: Record<LogLine['level'], string> = {
  error: 'text-bad',
  warn: 'text-warn',
  info: 'text-ink',
  other: 'text-muted-foreground',
}

/**
 * Frame-timing probe. Reports the worst frame in each window, which is what
 * actually shows up as a stutter -- an average would hide exactly the spikes
 * we care about.
 *
 * Under Electron this had to be shipped over IPC and appended to a file: a
 * GUI-subsystem app on Windows has no stdout attached to the console that
 * launched it, so console.log went nowhere. In a browser it is just the console.
 */
function useFrameProbe(label: string) {
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let worst = 0
    let frames = 0
    let sum = 0
    let windowStart = last

    const tick = (now: number) => {
      const dt = now - last
      last = now
      frames++
      sum += dt
      if (dt > worst) worst = dt
      if (now - windowStart >= 5000) {
        console.debug(
          `[perf] ${label} frames=${frames} avg=${(sum / frames).toFixed(1)}ms ` +
            `worst=${worst.toFixed(1)}ms fps=${(frames / ((now - windowStart) / 1000)).toFixed(1)}`,
        )
        worst = 0
        frames = 0
        sum = 0
        windowStart = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [label])
}

export default function ConsoleView({
  servers,
  buffers,
  rotations,
  ensureBacklog,
}: {
  servers: ServerStatus[]
  buffers: Record<string, LogLine[]>
  rotations: Record<string, number>
  ensureBacklog: (id: string) => void
}) {
  useFrameProbe('console')
  const live = servers.filter((s) => s.classification === 'live')
  const [active, setActive] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // Off by default. An idle server logs nothing BUT our own ten-second poll, so
  // the unfiltered tail was the tool talking to itself and the real output was
  // buried. Kept as a toggle because someone debugging RCON needs to see it.
  const [showProbe, setShowProbe] = useState(false)

  // Keep a valid tab selected as servers come and go.
  useEffect(() => {
    if (live.length === 0) {
      if (active !== null) setActive(null)
      return
    }
    if (!active || !live.some((s) => s.id === active)) setActive(live[0]!.id)
  }, [live, active])

  // Backlog on first view of a tab, so it opens with context rather than blank.
  useEffect(() => {
    if (active) ensureBacklog(active)
  }, [active, ensureBacklog])

  const all = active ? (buffers[active] ?? []) : []
  const lines = useMemo(
    () => (showProbe ? all : all.filter((l) => l.origin !== 'rcon-probe')),
    [all, showProbe],
  )
  const hiddenProbe = all.length - lines.length
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return lines
    return lines.filter((l) => l.text.toLowerCase().includes(q))
  }, [lines, query])

  if (live.length === 0) {
    return <p className="text-[13px] text-muted-foreground">No live servers to show a console for.</p>
  }

  return (
    <Tabs
      value={active ?? undefined}
      onValueChange={setActive}
      className="flex h-full flex-col gap-0"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
        <TabsList>
          {live.map((s) => (
            <TabsTrigger key={s.id} value={s.id} className="text-[12px]">
              {s.name}
              {rotations[s.id] ? (
                <span className="ml-1 text-[10px] text-warn" title="Log rotations seen">
                  ↻{rotations[s.id]}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* The toggle the empty-state copy always referred to. Off by default:
            an idle server's tail is otherwise the dashboard talking to itself. */}
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
          <Switch size="sm" checked={showProbe} onCheckedChange={setShowProbe} />
          RCON polling
          {!showProbe && hiddenProbe > 0 && <span className="text-faint">({hiddenProbe} hidden)</span>}
        </label>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search this tab…"
          className="h-7 w-56 text-[12px]"
        />
        <span className="w-28 text-right font-mono text-[11px] text-muted-foreground">
          {query ? `${filtered.length}/${lines.length}` : `${lines.length} lines`}
        </span>
      </div>

      {active && (
        <TabsContent value={active} className="flex min-h-0 flex-1 flex-col">
          {filtered.length === 0 && !query && hiddenProbe > 0 ? (
            /*
              Measured on this host: two of four servers log NOTHING but our own
              ten-second poll while idle, so filtering empties the tab completely.
              That is the correct answer and it looks identical to a broken
              console, which is why it says which one it is.
            */
            <div className="mt-2 flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-border text-center">
              <p className="text-[13px] font-medium text-muted-foreground">This server has been quiet</p>
              <p className="prose-line mt-1 max-w-md px-6 text-[12px] leading-relaxed text-faint">
                Nothing in the last {hiddenProbe} lines except this dashboard opening and closing
                its own RCON connection every ten seconds. Turn on{' '}
                <span className="text-muted-foreground">RCON polling</span> to see it.
              </p>
            </div>
          ) : (
            <Virtual key={active} lines={filtered} query={query} />
          )}
        </TabsContent>
      )}
    </Tabs>
  )
}

function Virtual({ lines, query }: { lines: LogLine[]; query: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(400)
  const [stick, setStick] = useState(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  // Follow the tail unless the user has scrolled up to read something.
  useEffect(() => {
    const el = ref.current
    if (el && stick) el.scrollTop = el.scrollHeight
  }, [lines.length, stick])

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    setScrollTop(el.scrollTop)
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 2)
  }, [])

  const total = lines.length * ROW_H
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const count = Math.ceil(height / ROW_H) + OVERSCAN * 2
  const slice = lines.slice(first, first + count)

  return (
    <div className="relative mt-2 flex-1 overflow-hidden rounded-lg border border-border bg-sidebar">
      <div ref={ref} onScroll={onScroll} className="h-full overflow-auto">
        <div style={{ height: total, position: 'relative' }}>
          {slice.map((l, i) => (
            <div
              key={l.seq}
              style={{
                position: 'absolute',
                top: (first + i) * ROW_H,
                height: ROW_H,
                lineHeight: `${ROW_H}px`,
              }}
              className={`w-full whitespace-pre px-2 font-mono text-[11px] ${LEVEL_CLASS[l.level]}`}
            >
              {query ? highlight(l.text, query) : l.text}
            </div>
          ))}
        </div>
      </div>
      {!stick && (
        <button
          type="button"
          onClick={() => {
            const el = ref.current
            if (el) el.scrollTop = el.scrollHeight
            setStick(true)
          }}
          className="absolute bottom-3 right-4 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-ink transition-colors duration-150 hover:border-edge-strong hover:bg-secondary"
        >
          Jump to live ↓
        </button>
      )}
    </div>
  )
}

function highlight(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q.trim().toLowerCase())
  if (i < 0) return text
  const n = q.trim().length
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-warn/40 text-inherit">{text.slice(i, i + n)}</mark>
      {text.slice(i + n)}
    </>
  )
}
