/**
 * Which world is a proof testing?
 *
 * The suite was green for weeks while validating a configuration that does not
 * occur in production. Every server it exercised had been started from an
 * interactive session, because that is what happens when a developer starts a
 * server to test something. In production they are started by boot-triggered S4U
 * scheduled tasks in session 0, and a session-0 process has no readable command
 * line to an unelevated query, which was the primary identity signal. So the
 * assertions were all true, of a world that never runs.
 *
 * One definition of "the production world", in one file, used by every proof that
 * touches process identity. See docs/proof-coverage.md.
 */
import type { JvmProcess } from '../server/platform'

export type World = {
  total: number
  taskStarted: number
  session0: number
  /** True only if EVERY running server is task-started and in session 0. */
  isProduction: boolean
  summary: string
  /** What to do about it when it is not the production world. */
  remedy: string
}

export function describeWorld(jvms: JvmProcess[]): World {
  const taskStarted = jvms.filter((j) => j.startedBy === 'scheduled-task').length
  const session0 = jvms.filter((j) => j.sessionId === 0).length
  const total = jvms.length
  // Revised 2026-08-03. "Every JVM task-started" was the original gate, and it
  // broke on a case that is production BY DESIGN: a server the dashboard
  // spawns outlives the dashboard (spawned detached -- the attach model), and
  // once the dashboard restarts, the survivor's ancestry walk dies at a dead
  // pid and its provenance reads `unknown`.
  //
  // Revised again 2026-08-06. "Everything in session 0" stopped describing
  // production too: the operator now runs a hand-started vanilla server from
  // the desktop as a durable fleet member, and that exact shape produced a
  // 10-hour misreport (a v6-only listener invisible to the IPv4-only port
  // table; prove-identity group E). A gate that disqualifies the world for
  // containing it would gate the proofs OUT of the newest hard case. The
  // hazard this gate exists to catch is unchanged -- proving identity only
  // against interactively started servers, where command lines are readable
  // and everything is easy -- so the gate demands the HARD shape present and
  // exercised: scheduler-started servers, all of them in session 0. A
  // desktop-started server alongside them no longer disqualifies the world;
  // it is the second shape production actually runs.
  const isProduction =
    total > 0 && taskStarted > 0 && jvms.every((j) => j.startedBy !== 'scheduled-task' || j.sessionId === 0)

  const bySignal = jvms.reduce<Record<string, number>>((a, j) => {
    a[j.attributedBy] = (a[j.attributedBy] ?? 0) + 1
    return a
  }, {})

  return {
    total,
    taskStarted,
    session0,
    isProduction,
    summary:
      total === 0
        ? 'no servers are running, so nothing about process identity is being tested at all'
        : `${total} running: ${taskStarted} started by a scheduled task, ${session0} in session 0` +
          (session0 - taskStarted > 0
            ? `, ${session0 - taskStarted} session-0 with no surviving launcher ancestry (a detached spawn outliving its launcher)`
            : '') +
          (total - session0 > 0
            ? `, ${total - session0} desktop-started (the second production shape since 2026-08-06)`
            : '') +
          `. Attributed by ${Object.entries(bySignal).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
    remedy:
      total === 0
        ? 'Start the servers via their scheduled tasks before running this.'
        : 'Start the scheduler-run servers through their scheduled tasks (Start-ScheduledTask); the task-started session-0 shape must be present, or the hard case goes untested.',
  }
}

/** Printed by every identity-touching proof, pass or fail. */
export function printWorld(w: World): void {
  console.log(`\nWORLD UNDER TEST: ${w.summary}`)
  console.log(
    w.isProduction
      ? '  This IS the production configuration: session 0, launched by the scheduler.'
      : `  This is NOT the production configuration. ${w.remedy}`,
  )
}
