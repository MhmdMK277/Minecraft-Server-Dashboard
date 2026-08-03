# Liveness & discovery spec

Extracted from `C:\Users\<user>\mcbackup\mcbackup.py`, which reached these rules
by failing in production first. The dashboard reimplements this in TypeScript
and **must not drift from it**. Every rule below is a behaviour, not a
preference, and each has a fixture in `fixtures/servers.json`.

> If the dashboard and the backup script ever disagree about whether a server is
> running, the dashboard is wrong until proven otherwise. The backup script is
> the one that has been shutting down live servers nightly without incident.

---

## 1. Port is not identity

`MC 1.21.4 - Copy` is a dormant duplicate that declares `server-port=25565` , 
the same port as the live `MC 1.21.4`. Asking "is 25565 listening?" therefore
reports the dormant copy as **running** whenever the real server is up.

**Rule.** Identity is resolved as `java.exe → parent cmd.exe → server directory`.
The Task Scheduler action is `cmd.exe /c "<dir>\start.bat"`, so the parent's
command line contains the directory. The java command line alone is **not**
sufficient either: both Paper servers show `-jar paper.jar` and both 1.20.1
Forge servers show an identical `win_args.txt` argument.

**Consequence.** `pid_of_server(dir)` is the authoritative liveness signal.
Port-derived PIDs are only ever a cross-check.

*(Backup script: this bug aborted an entire production run.)*

**Amended 2026-07-30.** The parent command line is not always readable. See §14:
a boot-started server has an empty one, and that took down attribution for every
server at once. The rule above is still the primary signal; it is no longer the
only one.

**Amended 2026-08-01, and this is the part to read before widening discovery.**

Discovery is about to search the filesystem for server directories rather than
only reading one configured root (§17). That makes this rule sharper, not
softer, because searching finds *copies*.

A bounded scan of this machine found **ten** directories holding a
`server.properties`. Six are the real servers. One was a deliberate test copy.
The other three live in `Documents\MC Servers - Copy\`, a duplicate tree
nobody had mentioned, and they declare **the same ports as the live servers**:
that tree contains its own `MC 1.21.4` claiming 25565.

So the tempting shortcut is now actively dangerous. It looks like this:

> read `server-port` from each candidate directory, ask Windows which process
> owns that port, and call that the server for that directory

With ten candidates and duplicate ports, that maps one running JVM onto
**three different directories**, and the dashboard would offer to start, stop
or write settings into a backup copy while reporting the live server's health
next to it.

**Rule, stated as a rule because a future reader will be tempted:**

> **The exclusive hold on `logs/latest.log` is the identity. The port is only
> a lookup.**

The hold is per-directory and a running JVM has exactly one, so it cannot be
ambiguous no matter how many directories declare the same port. Once a
directory is known to be held, the listening port is used only to name *which
pid* holds it. Never the reverse, and never the port alone.

Measured, 2026-08-01: port-to-pid is reliable for a JVM started any way at all
(four servers started by boot scheduled tasks in session 0, one started by
hand in session 1: five for five), which is exactly why it is tempting. It
answers "which process listens here" perfectly. It just does not answer "which
directory is this".

## 2. `session.lock` is advisory, never authoritative

Two independent traps:

- **1.7.10 does not hold it with a deny-share handle.** A running GTNH server
  reads as "unlocked".
- **Default file opens on Windows request shared access.** Python's `open()` and
  Node's `fs.open()` both succeed against a lock held by a live JVM. The probe
  must deny sharing explicitly: `CreateFileW` with `dwShareMode = 0`. Python's
  `open()` returned "unlocked" for all four *running* servers before this was
  fixed.

**Rule.** Use the lock only as a secondary opinion, and only after PID has
already answered. Never gate anything on it alone.

## 3. SLP responses are not one shape

The status payload is JSON, but:

- Modern servers return an object: `{"version": {"name": "Paper 1.21.4"}}`.
- **GTNH returns it double-encoded**, so `JSON.parse` yields a *string*, and
  every property access on it throws.

**Rule.** Normalise **at the parse site**, not with a type guard at the call
site. Parse; if the result is a string, parse again; if it is still not an
object, wrap it. Callers must always receive an object.

*(Backup script: fixing this downstream failed identically twice before it was
fixed at the parse site.)*

## 4. Responding is not ready

GTNH answers status pings for roughly 40 seconds *while still loading*, with a
placeholder in place of a version:

```
Server is still starting! Please wait before reconnecting.
```

**Rule.** Treat a response containing `still starting`, `starting up` or
`please wait` (case-insensitive, checked across both `version.name` and
`description`) as **not ready**. Measured effect: readiness moved from a false
44 s to a true 85 s.

## 5. Strip colour codes before parsing anything

`MC 1.21.11` returns:

```
§6There are §c0§6 out of maximum §c30§6 players online.
```

A regex looking for digits near "of" matches the **`6` in the colour code `§6`**
and reports six phantom players.

**Rule.** Strip `§.` before any numeric parse of RCON output.

## 6. `level-name` is not always `world`

GTNH uses `level-name=World`. This only ever worked by luck, because Windows
filesystems are case-insensitive; it would break outright on any other name.

Additionally, **1.7.10 keeps its dimensions inside the world folder**
(`World/DIM-1`, `World/DIM1`, `World/DIM94`) rather than beside it as
`world_nether` / `world_the_end`.

**Rule.** Read `level-name` from `server.properties`. Probe `<name>`,
`<name>_nether`, `<name>_the_end` and keep only those that exist.

## 7. Command output formats differ per platform *and* per version

Verified live on 2026-07-28 against all four servers.

### `list`

| Server | Raw output | Note |
|---|---|---|
| MC 1.21.4 | `There are 0 of a max of 20 players online:` | |
| MC 1.21.11 | `§6There are §c0§6 out of maximum §c30§6 players online.` | colour codes |
| MC Skyblock | `There are 0 of a max of 20 players online:` | |
| MC GTNH | `There are 0/20 players online:` | **third format**, slash-separated |

**Rule.** Strip colour codes, then match `There are\s+(\d+)` first. A fallback of
`(\d+)\s*(?:of|out of)` does **not** match GTNH's `0/20` form.

### TPS

| Server | Working command | Output shape |
|---|---|---|
| MC 1.21.4 | `tps` | `TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0` |
| MC 1.21.11 | `tps` | same |
| MC Skyblock | `forge tps` | per-dimension `Mean tick time: 0.702 ms. Mean TPS: 20.000` |
| MC GTNH | `cofh tps` **preferred** | `Overall: 20.00 TPS/1.31MS (100%)` then per-dim |
| MC GTNH | `forge tps` (fallback) | `Dim 94 : Mean tick time: … Mean TPS: 20.000` |

**Traps:**

- `tps` on **1.7.10 is a different command entirely** and replies
  `You must specify which player you wish to perform this action on.`
  A naive parser will treat that as a TPS response. Never send bare `tps` to a
  1.7.10 server.
- `forge tps` on Paper returns `Unknown or incomplete command`.
- GTNH's `forge tps` uses **numeric** dimension ids and **concatenates lines
  without separators** (`…20.000Dim 93 :…`).
- Only `cofh tps` yields a single **Overall** figure; `forge tps` requires
  aggregating per-dimension values.

**Rule.** Select the command from the detected platform. Never probe blindly.

## 8. Health is a state, not a boolean

SLP is answered by the **network thread** from a cached status object. RCON
commands are queued onto the **main server thread**.

During the 2026-07-28 stall, all four servers answered pings normally while
single ticks took 128 seconds. SLP said healthy; the main thread was dead.

**Rule.** SLP alone can never establish health. RCON round-trip latency is a
direct probe of main-thread liveness, because the command must reach that thread
to execute.

| Process | SLP | RCON | State |
|---|---|---|---|
| absent | – | – | `DOWN` |
| present | no response | – | `STARTING` or `HUNG` |
| present | responds, placeholder | – | `STARTING` |
| present | responds | prompt | `HEALTHY` |
| present | responds | slow / timeout | **`STALLED`** |

Measured healthy RCON round-trips, 2026-07-28: 0.3–220 ms.
`MC 1.21.11` is consistently the slowest of the four; thresholds must not be set
so tight that its normal 220 ms reads as stalled.

## 9. Directory classification

`Documents\MC Servers\` holds six directories; only four are servers.

| Directory | Classification |
|---|---|
| MC 1.21.4 | server, live |
| MC 1.21.11 | server, live |
| MC GTNH | server, live (1.7.10 via `lwjgl3ify-forgePatches.jar`) |
| MC Skyblock | server, live |
| MC Tech | server, **retired**, archived, never starts |
| MC 1.21.4 - Copy | server, **stale duplicate**, never starts |
| MC 26.1 | **not a server**, empty directory |
| clientpacks | **not a server**. No `level.dat` |
| (a fresh creation) | server, **never-started**: `server.properties` but no `level.dat` |

**Rule.** Classify; never crash; never list a non-server as a server; never
silently hide retired or stale directories, surface them separately so they can
be cleaned up.

**Amended 2026-08-01: never-started is a server, not junk.** A directory
with a `server.properties` but no world is what a server looks like before
its first start, and creation (M-create) produces exactly this. It becomes
a row classified `never-started`, with the ordinary launcher detection, so
its Start button is the same start path every server uses; the first start
generates the world and the classification flips to `live` on the next
scan. A directory with neither `level.dat` nor `server.properties` remains
not-a-server. The predicate crossvalidate section 5 pins (`level.dat`
means world-bearing server) is unchanged; this amendment adds a second,
narrower gate for the world-less case. Proven end to end by
`scripts/accept-creation.ts` sections 4 to 6 against a real server.

## 10. Secrets

RCON passwords live in `server.properties` and the app needs them. They are read
**server-side only** and never cross the wire, never render, never log. The
client's server model has no credential field at all.

Under Electron this boundary was an IPC bridge on one machine. It is now an HTTP
response on a LAN, so the same rule protects more.

## 11. The observer must not bill its own delay to the server

Added 2026-07-29, after this file's own argument was violated by this codebase.

RCON round-trip latency is the probe of the main game thread (§8), but **both
timestamps are taken in the dashboard's event loop**. If that loop is blocked
when the reply lands, the reply waits unread in the socket buffer and the delay
is attributed to the server. A healthy server is then reported `STALLED`.

Observed, not hypothesised. The first snapshot after the web service started:

| Server | Reported | RCON | Same server a minute later |
|---|---|---|---|
| MC 1.21.4 | `STALLED` | 3,120 ms | `HEALTHY`, 1 ms |
| MC Skyblock | `STALLED` | 5,010 ms (timeout) | `HEALTHY`, 0 ms |

Cause: `scan()` inspects every candidate concurrently with `Promise.all`, and
`inspect()` called `worldDirs()`: `readdirSync` + `statSync` per world. *after*
awaiting RCON. With a cold file cache that blocks the loop for seconds, and the
server whose reply is in flight gets the bill.

This is the same failure the README attributes to in-process panels, reproduced
in the observer. Being outside the server does not help if you are inside your
own measurement.

**Rule, two parts.**

1. **Ordering.** All synchronous filesystem work in `inspect()` happens before
   the first `await`, so it completes before any probe is outstanding.
2. **Measurement.** `server/loopguard.ts` samples event-loop delay, and
   `assessHealth` subtracts time the observer was provably not listening.
   A timeout that overlaps a long block reports `UNKNOWN`. "this reading is not
   usable", rather than `STALLED`, which is an accusation about the server.

The guard must compute the *currently open* gap at query time, not only replay
recorded ones: a caller asking immediately after a block has given the sampler no
turn in which to notice. Measured, after a 1,500 ms block the naive version
returned 0 ms, and 1,496 ms one macrotask later.

Proof: `scripts/prove-observer-lag.ts`, blocks the loop for 3,000 ms during a
probe of a server answering in 1 ms, and asserts the unguarded verdict is
`STALLED` while the guarded one is not.

**Amended 2026-08-04, after the second-machine first-run trial.** The rule as
first written governed `inspect()`, and the on-demand filesystem search
(`server/scan.ts`) violated its spirit from outside it: the walk was
synchronous `readdirSync` recursion, and on the trial machine one press of
"Look for servers on this machine" held the event loop for 8,739 ms of a
9,458 ms search, 97% of blocked time. The attribution built in §12 worked --
the host panel read "Stalling" and correctly blamed the observer rather than
a server -- but while the loop is held nothing can be measured at all, so on
a real fleet every server goes unmeasurable for the duration because someone
pressed a button. The rule therefore extends beyond `inspect()`: **no
on-demand route may run unbounded synchronous filesystem work on the event
loop.** The search now walks with the async filesystem API and yields between
candidates; a slow disk costs wall-clock, never measurement.

Proof: `scripts/prove-scan.ts` section 5, self-validating: it GROWS a
synthetic tree until a deliberately synchronous walk of it measurably blocks
past the 250 ms limit (so the tree is proven big enough to catch a
regression on the machine actually running the proof), then asserts the real
search's worst loop gap stays under the limit. The growth is not decoration:
the first version used a fixed 4,860-directory tree, which blocks 325 ms on
the dev machine and only 146 ms on a GitHub runner's NVMe, and CI failed the
self-check rather than passing vacuously. Measured at the fix on the dev
machine: worst gap 16 ms (the Windows timer tick) across a 1,263 ms search.

## 12. Observer lag is a host measurement, not just a correction

Added 2026-07-29, immediately after §11 and directly out of it.

§11 established that the observer must subtract its own delay before judging a
server. That correction **throws the measurement away**, and the measurement is
the most valuable thing this tool has: the dashboard is a Node service that
spends its life asleep, so when *its* event loop is late, the cause is outside
it. Event-loop delay here is a reading about the machine.

**Rule, part one: report it.** Loop lag is a host-level metric shown alongside
per-server health, p50, p95, worst block, and 15 minutes of history.

Two things make the number honest, and both were wrong in the first attempt:

1. **Subtract the platform's timer granularity, and measure it rather than
   assuming it.** A 20 ms `setInterval` on this host fires every ~31 ms, because
   the Windows timer tick is 15.6 ms. Reported raw, an idle machine showed p50
   lag 11 ms and 47 ms of "starvation" per minute. A baseline nobody would
   read. The floor is the **median** of recent samples, not the minimum: after a
   block, `setInterval` fires catch-up ticks at zero delay, and one of those
   pins a minimum-based floor at 0 for the rest of the run. Capped at one sample
   interval, so a permanently late host cannot hide behind its own floor.
2. **Separate our own CPU from being starved of it.** `process.cpuUsage()` per
   sample splits the delay two ways:

   | | Cause | Says what |
   |---|---|---|
   | **self-inflicted** | we were on-CPU running our own code | nothing about the host. This is §11's bug |
   | **starved** | wall clock passed, no CPU consumed | we were not scheduled: evidence about the machine |

   `cpuUsage()` counts every thread, so our own CPU is over-counted and the
   split is biased *away* from blaming the machine. That is the direction to be
   wrong in.

**Rule, part two: correlate.** The observer is a witness that is **not a
Minecraft server**, and a witness outside the population turns N observations
into one:

| Degraded | Loop lag | Verdict | Meaning |
|---|---|---|---|
| none | any | `none` | – |
| many | elevated, starved | **`host`** | the machine stopped scheduling work |
| many | elevated, our own CPU | `observer` | our bug. §11 recurring |
| many | flat | `shared` | one common cause, not N faults |
| one | elevated | `observer` | the reading may be an artifact |
| one | flat | `server` | isolated, and trustworthy |

"Many" is at least two **and** at least half of the servers actually probed.

A Minecraft server's fault cannot explain an unrelated Node process being
descheduled, so simultaneous degradation plus observer starvation is **one host
event with N symptoms**, not N server faults. On 2026-07-28 this host produced
177 stalls across four servers in one day, and three days went into per-server
hypotheses. Four red badges is that mistake, rendered.

A server whose RCON is not configured is excluded from the correlation. It is
`UNKNOWN` in every scan for ever, and a constant cannot correlate with anything.

**Rule, part three: a persistent `UNKNOWN` must explain itself.** `UNKNOWN` has
three causes that render identically and have nothing else in common:

- **identity doubt** (checked first, added 2026-08-02): the directory is
  occupied but no process could be matched to it, so **no probe ever ran**.
  There is no discarded reading, loop lag is not evidence about it, and the
  RCON remedy is advice about a server we cannot even see. The attribution used
  to fall through to the self-lag branch here and blame our own scan-path CPU,
  citing §11 -- a second, false explanation rendered beside the true one, on a
  server the Create page had just started.
- **no RCON configured**, permanent until someone edits `server.properties`.
  Saying "retrying on the next scan" is a promise that will never be kept.
- **no usable reading**. The host was too loaded to measure through. This one
  needs to say how long it has held, that the host is the reason, and that the
  server has not been accused of anything.

Proof: `scripts/prove-host-lag.ts`. A busy-wait and an `Atomics.wait` block the
loop for the same wall-clock time; the first must read as ours and the second as
the host's. The verdict table above is asserted over synthetic fleets, because
the real event is not reproducible on demand and waiting for it is not a test
strategy. `scripts/preview-states.tsx` renders those states as HTML so the UI
claim. One banner, not four red badges, can be checked without the machine
being ill.


## 13. A ten-second scan cannot see a one-second freeze

Added 2026-07-29.

Paired SLP and RCON probes fired at the same instant showed both stopping and
resuming together. 28.3/28.5 ms, 210.7/210.6 ms, and one at **1,649/1,641 ms**.
SLP is answered by a netty thread and RCON by the main thread, so both halting
and recovering within milliseconds is a **whole-process stop-the-world pause**,
not a main-thread stall. Observer blockage was 0 ms on every one of them, so the
measurement is not ours (§11).

The problem this creates for the dashboard: it scans every ten seconds, so it
sees a pause only if a probe lands inside one. A server freezing for 1.6 s
several times a minute reads `HEALTHY` in between, with `TPS 20.0`, because the
TPS figure is itself an average that a freeze barely moves.

**Rule.** Where the JVM already records something the scan can only sample, read
its record instead of sampling harder. Servers started with

```
-Xlog:gc*,safepoint:file=logs/gc.log:time,uptime,level,tags:filecount=5,filesize=10M
```

get every stop-the-world pause read out of `logs/gc.log` and surfaced. A pause
past 200 ms (the servers' own `MaxGCPauseMillis` target, and four ticks) is
`noticeable`; past 1,000 ms, twenty ticks, a freeze a player sees, is `severe`
and the card stops reading green.

Two details that are not optional:

1. **`safepoint` is logged as well as `gc*`, and the safepoint stream is the one
   used.** Every GC stops the world at a safepoint, and so does every
   stop-the-world that is *not* a GC. A pause that appears in the safepoint log
   under a non-collector operation is the evidence that would refute "the pauses
   are GC", so it is counted and reported separately rather than folded in.
2. **`At safepoint` is the pause; `Reaching safepoint` is not.** They sit on the
   same line, three orders of magnitude apart.

A first implementation merged the `gc` and `safepoint` streams and de-duplicated
on a 10 ms timestamp bucket. Under allocation churn two collections land 2 ms
apart, and it silently reported 9 of 11. Preferring one whole stream needs no
heuristic and cannot under-count.

`gc` is `null` for a server started without the flag. That is a normal state,
not a fault, and must not render as one.

Proof: `scripts/prove-gclog.ts`, against `fixtures/gc-sample.log`, real output
from a real JDK 21 HotSpot run with the exact flag above, not a hand-written
approximation of the format, because a hand-written format proves only that the
author and the parser agree.

## 14. A boot-started process has no command line

Found on the first real reboot after the boot-triggered scheduled tasks were
created, which is to say, the first time the servers started the way they are
supposed to.

A task with `LogonType = S4U` and a boot trigger runs its action in **session 0**.
An unelevated WMI query returns an **empty `CommandLine`** for such a process.
§1's rule: `java.exe → parent cmd.exe → directory`, therefore produced `null`
for all four servers simultaneously, and a completely healthy machine rendered as
four `DOWN` cards. Every server had been correctly attributed the day before,
when they happened to have been started from an interactive session.

This is the worst shape a bug can take here: not a wrong reading, but the same
reading a genuinely dead fleet would produce, arriving the moment the intended
configuration was finally in use.

**Rule.** Three independent signals, in order of strength.

1. **The scheduled task that launched it.** The Task Scheduler COM API
   (`Schedule.Service.GetRunningTasks`) lists running tasks with the PID each one
   launched, and the task definition carries the server directory in its action's
   `WorkingDirectory`. Task → engine PID → java descendant → directory.
   Unelevated, authoritative, and it covers exactly the case that broke.
2. **Parent command line** (§1). Exact when readable; blank in session 0.
3. **`logs/latest.log` held open, cross-referenced with the declared port.**

Signal 1 is primary because it reads identity from the thing that did the
launching rather than inferring it from side effects. Signal 3 remains for servers
nobody scheduled: started by hand, by a wrapper, or by another tool.

**A task in the ancestry is not always the launcher** (found 2026-08-02). The
dashboard itself runs from a boot-triggered scheduled task, so a server it
starts -- the Create page, or a `script` launcher -- is a *descendant* of the
dashboard's task engine without being that task's payload. Signal 1 walked the
ancestry, found the dashboard's task, and attributed the new JVM to the
dashboard's own directory; the wrongly claimed pid then blocked signals 2 and 3,
and a healthy server the dashboard had just started read `UNKNOWN` with its log
held open. The rule: when the JVM's own parent command line names a launcher
script in a **different** directory than the ancestor task's, the nearer
evidence wins and the row is left to signal 2. Production servers are
unaffected, their parent command lines are either unreadable (session 0) or name
the same directory as their task. `JvmProcess.taskLaunched` records the strong
fact (the ancestor task names the attributed directory) separately from
`startedBy: 'scheduled-task'`, which only records descent.

**Not the event log.** `Microsoft-Windows-TaskScheduler/Operational` records the
same task-to-PID mapping and is the obvious place to look, but it is **disabled by
default** on Windows 10, measured on this host: `IsEnabled False`, zero records.
Depending on it would mean asking the user to enable a log channel, which needs
elevation, to work around a bug caused by needing elevation. The live COM API
needs neither, and is current rather than historical.

**Why `logs/latest.log` and not `world/session.lock`.** §2 already records that
1.7.10 does not hold `session.lock` with a deny-share handle, and that was
confirmed again here: of five directories, the four running servers all held
`logs/latest.log`, and GTNH held no `session.lock`. A signal that silently fails
on the oldest pack in the fleet is worse than no signal.

**Both conditions are required, and this is not port-as-identity.** The held log
says *a server is serving this directory* but not which PID; the declared port
supplies the PID. Of two directories sharing a port, only the one whose log is
held is credited, which is precisely the case port alone gets wrong (§1). A port
with no held log is the dormant-duplicate case.

**The probe must deny sharing.** As with §2: Node's `fs.open` on Windows always
requests `FILE_SHARE_READ|WRITE|DELETE` and so succeeds while the JVM holds the
file. The test has to be a share-denying `CreateFile`, which is why it runs
inside the PowerShell call the provider was making anyway rather than in Node.

`JvmProcess.attributedBy` records which signal was used, because "attributed"
and "attributed by the route we thought" are different facts. That count is what
revealed the extent of the damage: with only signals 2 and 3 in place, all four
servers reported `open-log-and-port` and **none** reported `command-line`. A
primary signal carrying zero load in production, which is not a degraded state but
a dead one. With signal 1 added, all four report `scheduled-task`.

`JvmProcess.startedBy` records how the process came to exist, independently of how
it was attributed. It exists so a proof can state which world it is testing: the
entire suite was green while only ever exercising interactively started servers.
See `docs/proof-coverage.md`.

**Doubt is not absence.** `hasProcess: false` has two causes that produce the same
value. Nothing is running, or we could not tell. The second must render `UNKNOWN`,
never `DOWN`, and the same rule governs M3.3's start guard, where treating doubt as
absence would launch a second JVM against a live world. The scan therefore reports
what it could **not** resolve (`ok: false`, `unattributed`, `occupiedDirs`) rather
than returning a bare list, because an empty list is indistinguishable from a
stopped fleet.

**Cost.** The probe is one PowerShell invocation per scan, on a loop that runs
every ten seconds, which is §11's shape with a subprocess instead of a `statSync`.
Measured on this host: 667 ms p50, of which **0 ms** blocks our event loop, and the
identity scan completes before any server probe begins so its cost cannot land
inside a server's measurement window. `prove-identity` asserts all three and
includes a negative control. A deliberate 300 ms block, so that "0 ms" is a
measurement rather than a broken instrument. Reducing it from 1,520 ms meant
dropping a per-JVM `Get-Process` whose fields `Win32_Process` already carries, and
skipping the listening-socket enumeration (590 ms via `Get-NetTCPConnection`, 70 ms
via `netstat`) whenever a stronger signal has already answered.

Proof: `scripts/prove-identity.ts` (36 checks) for the signals, the doubt rule,
the cost, and the ancestry-vs-launcher distinction (its group D replays the
dashboard-task topology through the real interpretation path via a substituted
process table); `scripts/crossvalidate.ts` §6 for agreement with an independent Python
implementation using a different mechanism entirely. Both fail if the servers under
test were not started by the scheduler, because a proof that passes against the
wrong configuration is what allowed this in the first place.

## 15. Starting is delegated, so the guard cannot be atomic

Stopping is universal: RCON `stop` works on any server that has RCON, regardless
of how the server came to exist. **Starting is not.** It has to reproduce whatever
mechanism the operator already uses, which means the app hands the job to
something it does not own, Task Scheduler, or a batch file.

That has a consequence worth stating plainly rather than designing around:

> Between the pre-check and the launcher taking effect there is a window in which
> an external actor, Task Scheduler at boot, someone double-clicking
> `start.bat`, the nightly backup script, can create a second JVM. The dashboard
> can **detect** two JVMs on one world. It cannot **prevent** them.

Detection-and-alarm is the honest ceiling. Anything that describes this as
"prevents double starts" is wrong and should be corrected.

**Rule.** Four layers, in this order:

1. **A per-server async mutex.** Node being single-threaded is not a defence:
   every `await` is a yield point, and "check, then await, then act" is a race.
   Different servers must still run concurrently. A slow GTNH restart cannot
   block a Paper stop.
2. **A fresh authoritative pre-check inside the lock**, immediately before
   delegating, using process-tree identity and never a port probe (§1). Not the
   cached snapshot: ten seconds is long enough for someone else to have started it.
3. **Doubt counts as running.** If identity is unresolved, refuse. §14 , 
   an unattributable JVM is indistinguishable from an absent one, and the
   consequences are wildly asymmetric: refusing costs a click, starting a second
   JVM costs a world.
4. **Post-start verification**: poll until exactly one JVM owns the directory.
   Two ⇒ a first-class alert in the UI, not a log line.

**A restart holds ONE lock across both halves.** Two separately-locked calls leave
a window in which another request starts a server whose predecessor is still
shutting down, which is the two-JVM case arriving by the front door. If the old
process is not *confirmed* gone, the new one is not started. A server left down
is recoverable, a corrupted world is not.

**Never escalate a stop to a kill.** A killed server loses whatever the chunk
writer had in flight. A slow shutdown is normal for a large modpack; the right
response is to say so and leave it alone. `server/control.ts` contains no kill of
any kind, and `prove-concurrent-start.ts` asserts that against the source so
nobody adds one as a convenience.

**Start must be absent, not broken, when the launcher is unknown.** A server with
no scheduled task and no start script gets no start button and a sentence saying
why. Guessing a command line is how a second JVM lands on a live world.

Proof: `scripts/prove-concurrent-start.ts` (30 checks. The lock and the decision
table, written before the guard was trusted, per the standing instruction),
`scripts/prove-control.ts` (38 checks. The HTTP surface, refusals and audit),
`scripts/prove-live-start.ts` (21 checks. A real JVM launched, attributed, and a
second start refused, against a throwaway directory rather than a world). The
`windows-task` path was exercised once against a real server via
`scripts/live-restart.ts`, which refuses to run if anyone is online.

## 16. A start window has to be measured, because a constant accuses the wrong server

Added 2026-07-30 (M3.5).

`START_GRACE_SECONDS` was a constant keyed by platform. 420 s for 1.7.10, 180 s
for everything else. It decides one thing: whether a process that is up but
silent on its port is `STARTING` or `HUNG`. And `HUNG` renders as

> It is not going to come back on its own.

which is either true or a false accusation about a server that is booting
perfectly normally. Measured cold boots on this host span **13 s (Paper) to
100 s (GTNH)**, nearly an order of magnitude, and `docs/portability-audit.md`
named the case the constant actually breaks: a larger pack on a slower disk
exceeds even 420 s and gets called hung while it is starting.

**Rule.** The window is measured per server: the uptime of the java process at
the moment it first answers a status ping with a real version rather than the
still-starting placeholder (§4). Uptime, not a stopwatch. The process carries
how long it has been alive, so the scan does not have to have witnessed the
moment it appeared.

### The failure this is built around

If a sample is taken from a process that was **already ready the first time we
looked at it**, the number is not a boot time. It is however long that server
had been up. Start the dashboard against a server running since breakfast and the
naive version records a 14,400 s "boot", derives an eight-hour window, writes it
to disk, and a genuinely hung server is never reported `HUNG` again. One bad
sample disables the mechanism permanently and nothing ever prompts anyone to look
at it.

**So a sample is recorded only for a process whose first sighting showed it not
yet ready.** That one rule also disposes of the mid-life blip. A healthy server
that misses one SLP reply and answers the next, which happens for a dropped
packet or a stop-the-world pause (§13), because that process's first sighting
was ready, so it is never a candidate. A 900 s plausibility bound backstops both.

This is the same shape as §14's "doubt is not absence": a reading that *could* be
a boot time and a reading that *is* one are different facts, and only the second
may be stored.

### Every tie-break leans the same way, and here is why

Too wide a window delays a `HUNG` verdict: a wedged server reads `STARTING`
longer than it should, and the cost is a slower diagnosis. Too narrow a window
produces a **false** `HUNG` on a server that is booting fine. An untrue sentence
in the UI, and an invitation to intervene in a boot. Those costs are not
comparable, so:

| | Rule |
|---|---|
| widening | adopted from a single observation |
| shortening below the platform default | not until 5 boots have been measured |
| floor | 60 s, whatever the measurements say |
| ceiling | 1800 s |
| corrupt, missing, implausible or future-version input | "nothing measured" ⇒ the platform default |

The last row is decision 0003's "absent means yes" applied to a different
irreversible asymmetry. The ceiling, worth noting, can never actually clamp
anything: the 900 s plausibility bound already caps the input at half of it. The
bound is the defence; the ceiling is a backstop that only matters if someone
loosens the bound without reading this. `prove-boottime` asserts that
relationship rather than pretending the ceiling does the work.

### Two things deliberately NOT done

**The placeholder phase is not bounded.** A server answering pings with "Server
is still starting!" stays `STARTING` for ever, however long it has been. No
server on this host has ever been observed stuck there, so a `HUNG` verdict for
it would be an accusation invented for a failure nobody has seen, and the packs
most likely to sit in that phase for a long time are exactly the ones doing
legitimate first-run work. The card reports how the elapsed time compares to the
measured window and lets the reader draw the conclusion.

**A start does not wait for readiness.** `startServer` verifies a *process*, and
M3.3 recorded that as an open gap for this milestone to close. It is closed by
the sentence, not by a wait: polling until ready would hold an HTTP request for
the length of a GTNH boot and hold the per-server lock across it, so an operator
trying to stop a server wedged mid-boot would be refused by the call that is
waiting for it. A server left starting is recoverable; a control surface that
will not answer during the minute you need it is not. The measurement makes the
wait unnecessary. The reader is told what to expect instead of sitting through
it. `prove-concurrent-start` §6 asserts the shape so it stays a decision.

### The honest limit, on the record

A boot genuinely longer than everything measured before it. A pack update, a
world converting after a version change, a first run rebuilding registries, will
be reported `HUNG` before it finishes. That boot is still being watched, so it is
recorded when it completes and the window widens to fit it: **the mechanism gets
one such call wrong per server and then never again.** It is not designed away,
because the only way to do that is never to shorten any window. The `HUNG` text
names what the window was derived from so the reader can weigh it.

Proof: `scripts/prove-boottime.ts` (91 checks), written before `server/boottime.ts`
per the standing instruction. Sections 1–9 drive the state machine with synthetic
readings and touch no process, deliberately: a real boot cannot be requested, and
waiting for one is not a test strategy. What the proof **cannot** do is
manufacture a real measurement. The numbers come from real servers booting, and
the first arrive on the next reboot or the next nightly backup restart, which
produces one per server for free.

## 17. The common way to start a server defeats command-line attribution

Measured 2026-08-01, as an A/B against one real Forge 1.20.1 server, stopped
and restarted between the two runs with nothing else changed.

The canonical start command, the one the Minecraft wiki and effectively every
tutorial gives, is:

```
java -Xmx1024M -Xms1024M -jar server.jar nogui
```

Run from inside the server directory, that command line contains **no
directory at all**: a bare relative jar name and no wrapper script. Neither
does its parent shell. `dirFromCommandLine` looks for exactly two things, an
absolute path to a `.bat`/`.cmd`/`.ps1`/`.sh` in the parent, or
`-Duser.dir=` in the JVM's own line, and finds neither.

| The same server, started two ways | Attributed today? |
| --- | --- |
| `cmd /c "D:\...\Attach Test Server\start.bat"` | **yes**, via `command-line` |
| `java -Xms512M -Xmx2G @libraries/... nogui` | **no**, reported as 1 unattributed JVM |

So the failure is not an edge case. **It is the most common way people start
Minecraft servers**, and for those servers the dashboard could see a running
JVM and say nothing about which server it was.

**What fixes it, and what does not.** The fix is not a new signal. Signal 3
already does the right thing: probe the exclusive hold on
`logs/latest.log`, then use the listening port only to name the pid. Its sole
limitation was that it is only ever *asked* about directories under the
configured servers root. Given the directory as a candidate, the same
unmodified mechanism attributed the canonically-started server immediately:

| Same canonical server, same scan | Result |
| --- | --- |
| hints from the servers root only | not attributed |
| the directory supplied as one more hint | **attributed via `open-log-and-port`** |

**Consequence.** Widen the candidate list, do not add a signal. Discovery
searches for directories holding a `server.properties` (bounded: the user
profile, Documents and Desktop always; drive roots at depth 2; anything
deeper is a location the operator adds). Measured cost of that search on this
machine: **769 ms** across 723 directories with no permission errors, which is
why it runs on demand and at first run and never inside the ten-second loop.

**Found is not adopted.** A directory that holds a `server.properties` is a
*candidate*, and candidates are shown to the operator to choose from. They are
never adopted automatically, for the reason §1 now spells out: three of the
ten found on this machine are a backup tree, and adopting them would put a
copy of a live world under a start button.

**An attached folder that is no longer there says so.** An attachment is a
path the operator gave us, and paths go stale: a folder gets deleted, renamed,
or lives on a drive that is not plugged in. Left in the candidate list such a
folder becomes a server row that no process can own and no world can be read
for, so it reports `UNKNOWN` for ever, which is the dashboard withholding the
one thing it actually knows. The rule: an attachment carries a **state**
(`ok`, `missing`, `no-world`) alongside its path, a `missing` one never becomes
a server row, and the reported reason names the folder being gone rather than a
missing `level.dat`. `no-world` is kept separate from `missing` because they are
different facts and only one of them is a loss: a server that has never been
started once has a folder and no world.

The entry itself survives. Discovery does not tidy up on the operator's behalf,
because an unplugged drive must not silently cost someone their attachment, and
because detaching is the operator's decision either way. Detaching a missing
folder is allowed and works on a path that does not exist; as everywhere else,
it sets the entry aside and deletes nothing.
