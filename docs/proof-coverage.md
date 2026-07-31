# Proof coverage: which world is each proof testing?

## The lesson

On 2026-07-29 this project's process identity was completely broken in
production. Not degraded. **zero of four servers could be identified**, and the
dashboard reported a fully healthy machine as four `DOWN` cards.

The proof suite was green. It had been green the whole time.

The bug is described in `liveness-spec.md` §14 and is not the interesting part.
The interesting part is why nine proof scripts, several hundred assertions, and a
cross-validation against an independent Python implementation all failed to
notice.

**Every proof had only ever run against servers started from an interactive
session.** That is what happens when a developer starts a server to test
something: you open a terminal, or double-click `start.bat`, and it runs in your
desktop session as a child of your shell. In production these servers are started
by boot-triggered S4U scheduled tasks, which run in **session 0**, and a session-0
process returns an **empty command line** to an unelevated WMI query, which was
the one and only identity signal.

So the suite was not testing a weaker version of production. It was testing a
*different configuration*, one that does not occur on the running system, and
every assertion in it was true.

This is worth stating precisely, because the obvious lesson is the wrong one:

- ❌ "Identity resolution had a bug." It did, and it is fixed, and that fix is
  worth about a day of value.
- ❌ "We needed more test coverage." There was extensive coverage. Adding more
  assertions of the same kind would have added more green.
- ✅ **"A proof only tells you about the configuration it ran in, and nothing in
  the suite recorded what that configuration was."** Coverage was measured in
  assertions when the thing that mattered was unmeasured and invisible.

The failure mode is specific and it generalises: a test environment differs from
production in some way nobody wrote down, the difference is load-bearing, and
because it was never named it can never be checked. The proofs here are unusually
good in one respect. They run against the real machine and real servers rather
than mocks, which is why they catch so much. That is also exactly what made this
blind spot invisible: "we test against the real thing" felt like it settled the
question of realism.

### What was done about it

1. **Provenance is now a fact the code carries.** `JvmProcess.startedBy` records
   whether a process descends from a scheduled task or a desktop session, and
   `JvmProcess.attributedBy` records which signal identified it. Both are
   reported in `Snapshot.identity` and printed by `npm run probe`.

   The value of this is concrete: after the fix, `attributedBy` showed all four
   servers resolving via the *fallback* signal and none via the primary. That is
   a dead primary in production, and it was invisible until the count existed.

2. **Identity-touching proofs state which world they are in, every run**, via
   `scripts/world.ts`. One definition of "the production world", used by all of
   them so it cannot drift. `crossvalidate` and `prove-identity` **fail** if the
   servers under test were not started by the scheduler. A green run now means
   "production works", not "something works".

3. **Proofs that do NOT cover it say so**, in the table below and in their own
   headers. The point is not to make every proof cover every world; it is that
   nobody should have to guess which ones do.

### It found a second bug immediately

The world assertion earned its place on the first run. With the scheduled-task
signal added, `prove-identity` failed on an occupancy check and exposed that
PowerShell 5.1's `ConvertFrom-Json` emits a JSON array as a single object, so
`@($raw | ConvertFrom-Json)` had nested it. The per-directory loop ran **once**
with all six hints merged, and **signal 3 was completely inert**. It had been
masked because signal 1 was answering for every server. That is the same shape of
failure as the original: a component doing nothing, hidden by another that
happened to succeed.

---

## Coverage table

Legend for **World**:

- **production**, asserts the servers under test are session-0 and
  scheduler-started, and fails otherwise
- **inherited**, exercises identity but does not assert the world; correct today
  because of how it drives the servers, noted per row
- **n/a**, does not depend on process identity at all

| Proof | Touches identity | World | Note |
| --- | --- | --- | --- |
| `prove-identity` | **directly**. The three signals, doubt vs absence, cost | **production** | Fails unless every running server is session-0 and task-started. Also asserts the loop-blockage instrument works, via a deliberate 300 ms block. |
| `crossvalidate` | **directly**. §6 process identity, vs the Python implementation | **production** | Fails unless the world is production. §§1–5, 7–8 are pure parsing and world-independent. |
| `prove-concurrent-start` | no. The lock and the decision table, no real process | n/a | Deliberate: a proof that risked a live world to test the guard protecting live worlds would be self-defeating. Also asserts against the source that `control.ts` contains no kill and that restart holds one lock. |
| `prove-control` | indirectly, launcher detection and every refusal, over HTTP | **production** | Never starts or stops anything: every mutating call targets a stopped server or an already-running one, so the expected outcome is a refusal. |
| `prove-live-start` | **yes**, launches a real JVM and attributes it | n/a, deliberately | Exercises the `script` strategy in session 1, which is explicitly NOT the production path. That is the point: it covers the launcher code the other two cannot, against a throwaway directory instead of a world. |
| `live-restart` (not a proof) | **yes**. The real `windows-task` path on a real server | **production** | Run by hand, refuses if anyone is online. Not wired to an `npm run prove-*` name, because taking a live server down should not be a side effect of running tests. |
| `prove-restart` | yes, resolves a PID before and after a restart | **inherited** | Correct today: it drives `mcbackup.py`'s cold path, which restarts via `Start-ScheduledTask`, so the server comes back in session 0. Would silently become the wrong world if that ever changed to a direct spawn. |
| `prove-stall` | yes, via `probe-once`, plus `jstack` on the resolved PID | **inherited** | Whatever started the server is what gets tested. Run it after a scheduler start, not after a hand start. |
| `prove-websocket` | indirectly, needs identity to have found servers at all | **inherited** | Its own assertions are about frames and credentials, but an identity failure would empty the server list and several checks would pass vacuously. |
| `prove-addresses` | indirectly, reachability of servers identity found | **inherited** | Same caveat. |
| `prove-rotation` | no, tails a log file directly | n/a | |
| `prove-host-lag` | no, synthetic fleets, no real processes | n/a | Deliberate: the events it models cannot be produced on demand. |
| `prove-boottime` | **reads** identity output (pid, uptime) but asserts nothing about it | n/a | Sections 1–10 drive the boot state machine with synthetic readings and touch no process, for the same reason as `prove-host-lag`: a real boot cannot be requested. Section 11 runs a real scan but asserts only properties that hold whatever identity resolved. A `DOWN` server reports a start window too, so a broken identity signal cannot make it pass vacuously in a way that matters. **What it cannot cover:** a real measurement. The values come from real servers booting; the first arrive on the next reboot or nightly backup restart. |
| `prove-observer-lag` | no | n/a | |
| `prove-portability` | **no, deliberately**. A fake server directory with **no process** | n/a | Proves address/port derivation is not machine-specific. It cannot say anything about identity, because nothing is running. |
| `prove-gclog` | no, parses log text | n/a | |
| `prove-auth` | no | n/a | |
| `prove-backup-policy` | no | n/a | Cross-language, against the real `mcbackup.py`. |
| `prove-backup-route` | no | n/a | |

## The rule going forward

**A proof that depends on how a process was started must either assert the
production configuration or say in its header that it does not.**

And the general form, which is the part worth carrying to the next project:

> When a proof runs against a real environment, the environment is an input. If
> nothing records which environment it was, a green result is not evidence about
> production. It is evidence about whatever happened to be set up that day.

Concretely, for anything added here later: if a new proof touches process
identity, import `describeWorld` from `scripts/world.ts`, call `printWorld`, and
assert `world.isProduction`. If it genuinely cannot (because it uses synthetic
data, or no process at all), add a row to the table above with **n/a** and a
sentence saying why. An unlisted proof is the state this document exists to
prevent.
