import { useEffect, useState } from 'react'
import type { GameRuleReading, GameRulesReading, ServerStatus } from '@shared/api'
import { dashboard } from './client'
import { Btn } from './controls'
import { Section } from './ServerDetail'

/**
 * Game rules: the runtime surface.
 *
 * Everything shown here was ASKED of the running server over RCON moments
 * ago (server/gamerules.ts, on demand, never in the scan), which is why the
 * panel has a refresh time and five refusal states instead of a spinner that
 * ends in a guess. The refusals are the feature: a stopped server's rules
 * live in level.dat, which this dashboard does not parse or write; a server
 * whose identity is in doubt is not probed; a server that rejects the query
 * form (measured on Paper 1.21.11) says so rather than rendering sixteen
 * absent rules.
 *
 * A set is admin-only, and what the page reports afterwards is the READ-BACK
 * -- the value the server says it now holds -- not an echo of the request.
 */
export default function GameRulesPanel({ s, canEdit }: { s: ServerStatus; canEdit: boolean }) {
  const [reading, setReading] = useState<GameRulesReading | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingRule, setPendingRule] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<{ ok: boolean; detail: string } | null>(null)

  const load = () => {
    setBusy(true)
    setError(null)
    dashboard
      .getGameRules(s.id)
      .then(setReading)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'could not read game rules'))
      .finally(() => setBusy(false))
  }

  // One read when the page opens. Deliberately not polled: every read is a
  // burst of RCON commands, and a panel someone is not looking at should
  // cost the server nothing.
  useEffect(load, [s.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (name: GameRuleReading['name'], value: boolean | number) => {
    setPendingRule(name)
    setLastResult(null)
    dashboard
      .setGameRule(s.id, name, value)
      .then((r) => {
        setLastResult({ ok: r.ok, detail: r.detail })
        load()
      })
      .catch((e: unknown) =>
        setLastResult({ ok: false, detail: e instanceof Error ? e.message : 'could not set the rule' }),
      )
      .finally(() => setPendingRule(null))
  }

  return (
    <Section
      label="Game Rules"
      note="Read from the running server over RCON when this page opens. A change takes effect immediately and is saved with the world."
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="prose-line text-[11px] leading-relaxed text-faint">
            {reading?.state === 'read' && reading.queriedAt
              ? `Read at ${new Date(reading.queriedAt).toLocaleTimeString()}. ${reading.detail}`
              : 'Values are asked of the server, never remembered from an earlier visit.'}
          </p>
          <Btn onClick={load} disabled={busy} label={busy ? 'Reading…' : 'Re-read'} />
        </div>

        {error && (
          <p className="prose-line rounded-md border border-bad/40 bg-bad/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-bad">
            {error}
          </p>
        )}

        {reading && reading.state !== 'read' && (
          <p className="prose-line rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-warn">
            {reading.detail}
          </p>
        )}

        {lastResult && (
          <p
            className={`prose-line rounded-md border px-2.5 py-1.5 text-[12px] leading-relaxed ${
              lastResult.ok ? 'border-ok/40 bg-ok/10 text-ink' : 'border-bad/40 bg-bad/10 text-bad'
            }`}
          >
            {lastResult.detail}
          </p>
        )}

        {reading?.state === 'read' && (
          <div className="divide-y divide-border">
            {reading.rules
              .filter((r) => r.status !== 'absent')
              .map((r) => (
                <RuleRow
                  key={r.name}
                  rule={r}
                  canEdit={canEdit}
                  pending={pendingRule === r.name}
                  anyPending={pendingRule !== null}
                  onSet={(v) => set(r.name, v)}
                />
              ))}
          </div>
        )}
      </div>
    </Section>
  )
}

function RuleRow({
  rule,
  canEdit,
  pending,
  anyPending,
  onSet,
}: {
  rule: GameRuleReading
  canEdit: boolean
  pending: boolean
  anyPending: boolean
  onSet: (v: boolean | number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)

  if (rule.status === 'unparsed') {
    return (
      <div className="py-2.5">
        <div className="font-mono text-[12px] text-ink">{rule.name}</div>
        <p className="prose-line mt-0.5 text-[11px] leading-relaxed text-faint">
          The server's reply did not match any measured shape, so no value is claimed. It said:{' '}
          <span className="font-mono">{rule.raw.slice(0, 120)}</span>
        </p>
      </div>
    )
  }

  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[12px] text-ink">{rule.name}</span>
          <span className="font-mono text-[12px] text-muted-foreground">
            {rule.type === 'boolean' ? String(rule.boolValue) : String(rule.intValue)}
          </span>
        </div>
        <p className="prose-line mt-0.5 text-[11px] leading-relaxed text-faint">{rule.description}</p>
      </div>

      {canEdit && rule.type === 'boolean' && (
        <Btn
          onClick={() => onSet(!rule.boolValue)}
          disabled={anyPending}
          label={pending ? 'Setting…' : rule.boolValue ? 'Turn off' : 'Turn on'}
        />
      )}

      {canEdit && rule.type === 'integer' && (
        <div className="flex shrink-0 items-center gap-1.5">
          <input
            type="number"
            value={draft ?? String(rule.intValue ?? '')}
            min={rule.min ?? undefined}
            max={rule.max ?? undefined}
            onChange={(e) => setDraft(e.target.value)}
            className="w-20 rounded-md border border-border bg-panel2 px-2 py-1 text-right font-mono text-[12px] text-ink outline-none focus:border-ring"
            aria-label={rule.name}
          />
          <Btn
            onClick={() => {
              const n = Number(draft)
              if (Number.isInteger(n)) onSet(n)
              setDraft(null)
            }}
            disabled={
              anyPending ||
              draft === null ||
              !Number.isInteger(Number(draft)) ||
              Number(draft) === rule.intValue ||
              (rule.min !== null && Number(draft) < rule.min) ||
              (rule.max !== null && Number(draft) > rule.max)
            }
            label={pending ? 'Setting…' : 'Set'}
          />
        </div>
      )}
    </div>
  )
}
