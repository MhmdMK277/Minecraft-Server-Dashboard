import type { ServerStatus, Health, Attribution } from '@shared/api'

/**
 * The visual language for "what is wrong" and "can I stand behind this reading".
 *
 * These are two different questions and the UI used to answer only the first.
 * `STARTING` and `UNKNOWN` both rendered as a plain amber dot -- but STARTING is
 * a claim about the server ("it is booting") and UNKNOWN is a claim about the
 * measurement ("I could not get a reading"). Collapsing them throws away the one
 * distinction this project exists to make.
 *
 * So there are two axes, carried by different channels:
 *
 *   TONE       ok / warn / bad / muted     -- how bad it is
 *   CONFIDENCE solid / ring / dashed       -- whether we can stand behind it
 *
 * Confidence is carried by FORM rather than colour on purpose. It survives
 * greyscale, distance and colourblind vision, and it stays legible independently
 * of severity -- an operator can see "we are not sure" without first decoding
 * how bad the thing we are unsure about is.
 */

export type Tone = 'ok' | 'warn' | 'bad' | 'muted'

export type Confidence =
  /** We probed it. This is the server's own behaviour. */
  | 'measured'
  /** Degraded, but the cause is not this server. Do not accuse it. */
  | 'elsewhere'
  /** No usable reading. A statement about the measurement, not the server. */
  | 'unmeasured'

export interface Verdict {
  tone: Tone
  confidence: Confidence
  label: string
  /** Large indicator + coloured label. False for healthy, which stays quiet. */
  attention: boolean
  /** Short qualifier beside the label, or null. */
  note: string | null
}

const HEALTH_LABEL: Record<Health, string> = {
  HEALTHY: 'Healthy',
  STALLED: 'Stalled',
  HUNG: 'Hung',
  STARTING: 'Starting',
  DOWN: 'Down',
  UNKNOWN: 'Unknown',
}

/**
 * Attribution decides confidence, because attribution is literally the answer to
 * "whose behaviour is this reading about".
 */
const BY_ATTRIBUTION: Record<Attribution, { tone: Tone; confidence: Confidence; note: string }> = {
  server: { tone: 'bad', confidence: 'measured', note: 'this server' },
  host: { tone: 'warn', confidence: 'elsewhere', note: 'the host, not this server' },
  observer: { tone: 'warn', confidence: 'unmeasured', note: 'unconfirmed reading' },
  configuration: { tone: 'muted', confidence: 'unmeasured', note: 'not measurable' },
}

export function verdict(s: ServerStatus): Verdict {
  const label = HEALTH_LABEL[s.health]

  // A server that freezes for over a second is not healthy, whatever the probe
  // that happened to land between the freezes says. The GC log is a complete
  // record where the ten-second scan is a sample, so it overrides the probe --
  // and it is a MEASURED claim about this server, not a doubt about the reading.
  const pausing = s.gc != null && s.gc.severity !== 'ok'

  if (s.attribution) {
    const a = BY_ATTRIBUTION[s.attribution]
    return { tone: a.tone, confidence: a.confidence, label, attention: true, note: a.note }
  }

  if (s.health === 'HEALTHY') {
    return pausing
      ? { tone: 'warn', confidence: 'measured', label, attention: true, note: 'pausing' }
      : { tone: 'ok', confidence: 'measured', label, attention: false, note: null }
  }

  if (s.health === 'STARTING') {
    return { tone: 'warn', confidence: 'measured', label, attention: true, note: null }
  }
  if (s.health === 'DOWN') {
    return { tone: 'muted', confidence: 'measured', label, attention: true, note: null }
  }
  if (s.health === 'UNKNOWN') {
    return { tone: 'muted', confidence: 'unmeasured', label, attention: true, note: null }
  }
  return { tone: 'bad', confidence: 'measured', label, attention: true, note: pausing ? 'pausing' : null }
}

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  muted: 'text-muted-foreground',
}

export const TONE_BORDER: Record<Tone, string> = {
  ok: 'border-edge',
  warn: 'border-warn/45',
  bad: 'border-bad/70',
  muted: 'border-edge',
}

/**
 * The rail colour is NOT the same as the text colour.
 *
 * A 3px bar the full height of a card is a lot more colour than a word is, so
 * healthy uses a dimmed green that reads as "present and fine" rather than as a
 * green stripe demanding to be looked at. Everything that wants attention is at
 * full strength. This keeps the rule that a calm fleet is quiet while still
 * giving every card an edge you can find from across the room.
 */
export const TONE_RAIL: Record<Tone, string> = {
  ok: 'text-ok/45',
  warn: 'text-warn',
  bad: 'text-bad',
  muted: 'text-faint/60',
}

/**
 * The dot.
 *
 * Small when healthy, large otherwise. Four healthy servers are a regular field
 * of small quiet marks and a fault breaks the pattern -- pattern-break is the
 * strongest pre-attentive signal there is, and it works at a distance where
 * neither colour nor text does.
 */
export function Indicator({
  tone,
  confidence,
  large,
  className = '',
}: {
  tone: Tone
  confidence: Confidence
  large: boolean
  className?: string
}) {
  const form =
    confidence === 'measured' ? 'ind-solid' : confidence === 'elsewhere' ? 'ind-ring' : 'ind-dashed'
  return (
    <span
      aria-hidden="true"
      className={`ind ${large ? 'ind-lg' : 'ind-sm'} ${form} ${TONE_TEXT[tone]} ${className}`}
    />
  )
}

/** Spoken form of the two axes, for screen readers and for the `title`. */
/**
 * The RAM pair, per the DESIGN.md display rule: used / allocated in matching
 * units chosen from the allocated side. Integer MB below 1000, one-decimal
 * GB at or above (trailing .0 dropped): "0.6 / 8 GB", never "1100 MB".
 */
export function fmtMemPair(usedMb: number | null, allocMb: number | null): string {
  if (usedMb == null) return '–'
  const gb = (n: number) => {
    const v = (n / 1024).toFixed(1)
    return v.endsWith('.0') ? v.slice(0, -2) : v
  }
  if (allocMb == null) return usedMb >= 1000 ? `${gb(usedMb)} GB` : `${Math.round(usedMb)} MB`
  return allocMb >= 1000
    ? `${gb(usedMb)} / ${gb(allocMb)} GB`
    : `${Math.round(usedMb)} / ${Math.round(allocMb)} MB`
}

export function verdictSentence(v: Verdict): string {
  const conf =
    v.confidence === 'measured'
      ? 'measured'
      : v.confidence === 'elsewhere'
        ? 'degraded, but attributed elsewhere'
        : 'no reading we can stand behind'
  return `${v.label}. ${conf}`
}

/**
 * A hairline proportion bar.
 *
 * Deliberately 2px and unlabelled: it exists so a number has a SHAPE next to it,
 * not to be read as a chart. "20.0" means nothing without knowing 20 is the
 * ceiling; a bar at full width says it instantly and costs two pixels of height.
 *
 * Rendered only where an honest denominator exists. There is no bar for RAM
 * against heap size, because the heap ceiling is not on the wire -- inventing a
 * denominator would be exactly the kind of unearned confidence this project is
 * built to avoid.
 */
export function Meter({
  value,
  max,
  tone = 'muted',
  title,
}: {
  value: number | null
  max: number | null
  tone?: Tone
  title?: string
}) {
  if (value == null || max == null || max <= 0) return null
  const frac = Math.max(0, Math.min(1, value / max))
  const fill =
    tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : tone === 'bad' ? 'bg-bad' : 'bg-muted'
  return (
    <div className="mt-1 h-[2px] w-full overflow-hidden rounded-full bg-edge/40" title={title}>
      <div className={`h-full ${fill}`} style={{ width: `${frac * 100}%` }} />
    </div>
  )
}

/**
 * One figure, at one of three weights.
 *
 * The old card rendered eleven values at an identical 12px mono, so PID was as
 * loud as TPS and nothing directed the eye. The tiers answer different
 * questions, and that is what decides the size:
 *
 *   lead   is it serving players, and is the main thread alive
 *   body   is it degrading
 *   meta   which process, which world, what window -- identity and provenance
 */
export function Metric({
  label,
  value,
  tier = 'body',
  tone,
  title,
  children,
}: {
  label: string
  value: string
  tier?: 'lead' | 'body' | 'meta'
  tone?: Tone
  title?: string
  children?: React.ReactNode
}) {
  const colour = tone ? TONE_TEXT[tone] : tier === 'meta' ? 'text-faint' : 'text-ink'
  // Lead figures carry the page, so they are sized like it. 19px read as "a
  // slightly bigger label"; at 26px with tight tracking they read as the answer
  // to the question, which is what the tier is for.
  const size =
    tier === 'lead'
      ? 'text-[26px] leading-[30px] font-medium tracking-[-0.03em]'
      : tier === 'body'
        ? 'text-[14px] leading-5 font-medium tracking-[-0.01em]'
        : 'text-[11px] leading-4'
  return (
    // Layout law: labels and identity values never ellipsize. A label may
    // wrap to a second line; a meta value (a world name, a path fragment)
    // breaks and wraps. Lead figures are numbers and cannot overflow, so
    // they keep the single line their size implies.
    //
    // The board voice (DESIGN.md Own world): mono carries every figure and
    // label; sans is reserved for prose.
    <div title={title} className="min-w-0">
      <div className="font-mono text-[9px] uppercase leading-4 tracking-[0.1em] text-faint">
        {label}
      </div>
      <div
        className={`tnum font-mono ${tier === 'meta' ? 'break-words' : 'truncate'} ${size} ${colour}`}
      >
        {value}
      </div>
      {children}
    </div>
  )
}
