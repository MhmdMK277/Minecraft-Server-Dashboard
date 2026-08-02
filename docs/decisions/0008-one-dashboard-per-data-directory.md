# 0008. One dashboard per data directory, enforced by a lock, not a port probe

**Status:** accepted
**Date:** 2026-08-02

## Decision

On startup the dashboard acquires `<dataDir>/instance.lock`
(`server/instancelock.ts`) before writing anything into the data directory.
If the lock is held by a live process, startup is refused with exit code 3,
naming the holder's pid and the lock path. If the holder died without
releasing, the lock is taken over and the takeover is announced. A clean
shutdown marks the lock released rather than deleting it. Liveness is judged
by pid **and** process start time against the process table, because pids
are recycled. Proof: `npm run prove-instancelock` (28 checks, including the
real entry point end to end).

## Why a lock, and why not a pre-listen port probe

The defect that surfaced this (2026-08-02): with the service bound to
`0.0.0.0:8422`, Windows allowed a second instance to bind `127.0.0.1:8422`
with no error, and two dashboards ran at once. The first idea was a
pre-listen probe: ask the port whether a dashboard already answers there.
Rejected, because the probe tests the wrong resource:

- **The shared resource is the data directory, not the socket.** Two
  instances on *different* ports pass any port probe and still write
  `sessions.json`, `attached.json`, `backup-policy.json` and the audit log
  concurrently. Those are read-modify-write files that assume a single
  writer; two writers corrupt them. That is data loss, not a UX annoyance.
- **A port probe cannot identify its counterpart.** Whatever answers might
  be another dashboard, a different app, or a stale process; the probe
  would have to guess. The lock file names its holder exactly.
- **The port case comes along for free.** Two instances contending for one
  data directory are refused by the lock before either touches a socket,
  which also covers the same-port scenario that started this.

A plain port-in-use error (something *else* holding the port) is still
handled separately, by `explainStartupError` in `server/main.ts`.

## What this means

- Running a second dashboard on one machine requires giving it its own
  `MCDASH_DATA_DIR`. The refusal message says exactly that.
- Dev runs (`npm start`, `npm run dev`) on a machine where the service is
  running are refused unless pointed at their own data directory. That is
  the guard working, not a bug.
- The takeover race between two simultaneous starters is narrowed by a
  verify-after-write, not eliminated; the module header documents the
  residual window and why it is accepted.
