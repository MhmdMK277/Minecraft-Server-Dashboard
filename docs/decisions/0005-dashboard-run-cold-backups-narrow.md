# 0005. Dashboard-run backups: approved, narrow, manual, cold

**Status:** accepted; built 2026-08-02 (`server/coldbackup.ts`,
`prove-cold-backup`), after 0001's detection signals
(`server/backupdetect.ts`, `prove-backup-detect`). The one piece not built:
the `.bat` + Task Scheduler XML generator for operator-registered
scheduling, deferred until someone asks for it; the no-scheduler rule it
exists to protect is enforced regardless.
**Date:** 2026-08-01

## Decision

Decision 0001 (the dashboard does not own backups) stands for every server
where a backup system exists. This decision opens one narrow, deliberate
exception for the operator who has **nothing**: the dashboard may offer to
run a backup itself, under all of the following constraints, each of which
is load-bearing.

- **Offered only where nothing was detected.** The offer appears per server
  only when 0001's detection signals, which must be implemented first, find
  no active backup system, and it disappears if one appears later.
- **Manual only. No scheduler inside the dashboard.** "Back up now" is an
  operator's click, audited, admin-only, off by default. If scheduling is
  wanted, the dashboard generates a `.bat` and Task Scheduler XML for the
  operator to register themselves, exactly how the dashboard's own boot
  task works. Write authority on a timer is the part of 0001's reasoning
  that stays true forever.
- **Cold only.** An archive is written only when no process owns the
  directory (occupancy zero and certain, the same check the start guard
  uses). A running server is skipped out loud with the reason, never
  silently and never "quickly while it runs".
- **Every archive journaled.** Zip of the server directory, written outside
  it to an operator-named destination, sha256 recorded at write in a
  manifest the dashboard owns. No rotation in v1; any future rotation
  deletes only archives named in its own manifest, never a file it did not
  write.
- **Restore never extracts over anything.** It verifies the archive hash,
  refuses if any JVM owns the target, and extracts into a new sibling
  folder ("Name restored 2026-08-01 0930"), leaving the swap to the
  operator.
- **Proof suite before shipping.** This is the data-loss category; the
  proof rule applies in full.

## Sequencing

After public access, and after 0001's detection signals actually exist,
because the offer's precondition is detection saying "nothing found".

## Why the exception does not swallow the rule

0001's three objections were: the dashboard is the least-informed backup
agent; duplicate systems double I/O on a box that stalls under it; and
write authority does not belong in a read-only tool. The first two are
answered by the precondition (cold copies of a stopped server need no
inside knowledge, and "only where nothing exists" cannot duplicate
anything). The third is answered by refusing the scheduler: every write
this feature performs traces to an operator's explicit click in the same
session.
