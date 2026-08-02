# 0009. The observer runs BelowNormal; what it spawns runs like a server

**Status:** accepted
**Date:** 2026-08-03

## Decision

Two stances, one rule: **priority follows role, not ancestry.**

- **The dashboard's own process stays BelowNormal** (its scheduled task keeps
  Task Scheduler's default `Settings.Priority=7`). An observer must not
  compete for CPU with the servers it watches, and its lag instrumentation
  (liveness-spec rules 11 and 12) already separates "starved" from
  "self-inflicted", so the penalty costs nothing in reading quality.
- **A server the dashboard spawns is raised to Normal.** Windows priority
  class is inherited, so without intervention a `script`-strategy start would
  hand the server the observer's penalty. `server/launcher.ts` raises the
  spawned wrapper immediately after `spawn()`, so the JVM it launches
  inherits Normal; `server/control.ts` (`ensureSpawnedPriority`) closes the
  race by reading the identified JVM's priority back after the post-start
  verification names it, raising it if the wrapper's raise came too late.
  The control result states the read-back as fact, not intention.
- **Task-started servers are never touched.** Their priority belongs to the
  task definition, which the operator owns and already fixed (7 to 5,
  2026-08-02). Overriding it silently would make the task XML a lie.

Proof: `scripts/prove-live-start.ts` lowers its own process to BelowNormal
(the production condition), starts through the real path, and asserts the
JVM's base priority reads 8 from the process table and that the control
sentence carries the read-back.

## Why

Found 2026-08-02 by accident: a server created through the Create page ran at
base priority 6, and its working set was trimmed to 9 MB of 2.3 GB within
half an hour while the four base-8 servers held hundreds of MB through a
deliberate 43,000-160,000 pages/s bulk-read storm. That is the exact eviction
exposure the stall investigation spent days removing from the fleet (the
story is in `docs/history.md`), reintroduced invisibly for any server the
dashboard starts.
An invisible penalty on dashboard-started servers is a silent asymmetry:
the same server behaves differently depending on which button started it,
and nothing on screen says so.

The "observer stays at 7" stance was recorded against the dashboard's own
process. It was never a statement about children; reading it as one made the
two stances contradict. This record states them as the single rule above.

## What this means

- A server started by the dashboard's Start button behaves like one started
  by its scheduled task, as far as memory-priority eviction is concerned.
- The raise is same-user and unelevated (BelowNormal to Normal needs no
  privilege); if it ever fails, the control result says the priority could
  not be verified and points at the Overview's eviction exposure panel,
  which reads the live value every scan (`server/residency.ts`).
- Non-Windows spawn paths are untouched: on POSIX an unprivileged process
  cannot lower a nice value, and no supported platform runs the identity
  provider anyway (decision 0006).
