# Project history: settled milestones and findings

## 2026-08-02 late evening: the controlled eviction stress test

Rather than waiting for the 05:00 backup, the trigger was reproduced
deliberately, twice, read-only (buffered sequential 1 MB reads through
share-everything handles; nothing written). Round 1 streamed the backup
archives: 53,920 pages input/s peak, roughly 5,300/s sustained for two
minutes. Round 2 streamed 64.6 GB of files 4 MB and larger at ~198 MB/s for
5.6 minutes: ten consecutive 30-second samples between 43,000 and 160,000
pages input/s. The worst naturally occurring spike on record was 41,425/s;
the storms were run against all four servers at base priority 8, roughly
two hours after the priority fix landed, with zero players online and the
cost and risk stated before the run.

**What held: the harm.** Fleet-wide worst pause across 2.6 hours spanning
both storms was 237.85 ms; zero pauses over 100 ms landed inside either
storm window; and every pause over 100 ms that evening attributed as "work
at safepoint" with time-to-safepoint at or below 0.03 ms, which is the JVM
doing GC work, not the OS withholding threads. The same class of trigger at
a quarter the intensity had produced 542/780/946 ms pauses under base
priority 6 that very morning (04:24-04:57, after a 41,425 pages/s burst).

**What did not hold: residency.** Under sustained pressure the base-8 heaps
were trimmed from 9-20% resident down to 5-10% within five minutes, back
inside the 4-15% band measured under base 6. Raising base priority does
not keep heaps resident.

**The accidental control group.** A freshly created server running at base
priority 6 (it had inherited the dashboard's BelowNormal class through the
spawn chain; see decision 0009) idled down to 9 MB resident of a 2.3 GB
private set within thirty minutes of boot, while the base-8 JVMs held
hundreds of MB through the storms.

**The revised mechanism story, superseding the original.** Base priority
does not prevent eviction; it changes the depth and order of eviction, and,
on this evidence, whether the refaults hurt: at normal priority the trimmed
pages appear to come back cheaply instead of stalling a garbage collection
for seconds. The original chain ("low priority -> residency 4-15% -> GC
hard-faults for seconds") survives only in its last link; the middle link
is now known to be shared by both priorities.

**Untested by this run**: GTNH, the deepest heap in the fleet, executed
zero garbage collections during either storm window, so its vulnerability
was not exercised. The overnight window and the 05:00 rotation remain the
confirming observation for the fleet as a whole.

## 2026-08-02: the stall mechanism, established and instrumented

Multi-second stop-the-world pauses on an idle machine with free RAM had
been an open investigation since 2026-07-28. The mechanism, pinned by
correlating GC logs against host hard-fault rates across three separate
storm windows: the servers' scheduled tasks carried Task Scheduler's
default `Priority=7`, which runs a process at low MEMORY priority, so
Windows trimmed their working sets first whenever anything did bulk file
reads (a background scan, a repository clone, a build). Heaps idled at
4-15% resident, and the next garbage collection that walked old regions
hard-faulted through the missing pages for seconds; the two worst pauses
(8.9 s and 2.6 s) matched hard-fault spikes to within one 30-second
metrics sample.

**The nightly cold-backup rotation was suspected and is exonerated on its
own evidence**: three consecutive runs produced the largest fault spikes of
each day and zero multi-second pauses after any of them. A freshly
restarted JVM has nothing paged out, so the backup resets the vulnerable
state rather than creating it. One storm window's trigger (a 90-minute
overnight cluster with only mildly elevated fault samples) remains
unidentified, and is recorded as such rather than guessed at.

What shipped from it, all read-only: GC pause summaries split at the
process boundary so a replaced JVM's stall can never read as the live
server's crisis (finding F9 in `security-audit.md`); a per-server "memory
eviction exposure" reading pairing the launching task's priority with live
residency (`server/residency.ts`); and the host's hard-fault rate sampled
beside the dashboard's own loop lag (`server/hostpaging.ts`), so the
correlation this investigation performed by hand is a standing reading.
The mitigation itself, raising the tasks' priority, is a Task Scheduler
change and stays the operator's act; the dashboard reports the condition.

This is the settled narrative moved out of the working handoff, newest first.
Everything here is finished work or a measured fact; open items live in the
handoff, constraints live in `liveness-spec.md` and `../DESIGN.md`, decisions
live in `decisions/`. Nothing in this file needs re-deriving; that is the
point of it.

## 2026-08-02: v0.1.0 published, and the tag flushed out three defects

The release went live and was verified live, not just linked: the zip was
re-downloaded and its sha256 recomputed, matching `SHA256SUMS` and the Scoop
manifest; release page, zip, checksums, README link and manifest all answered
200. Three real defects surfaced in the process, all fixed:

1. **`pushSnapshot()` dropped a write's rescan** when it raced the 10 s poll:
   a write was told it was reflected while `latest` still described the world
   before it. The request is now remembered and served (9889824).
2. **`prove-control` and `prove-backup-route` declare a production world** and
   cannot run on CI; they now SKIP with the reason instead of failing (same
   commit).
3. **The Scoop manifest carried a hash from a local build** and would have
   failed `scoop install`: the workflow's own correct manifest commit was
   rejected as non-fast-forward when another push landed during the run.
   Fixed by regenerating from the published `SHA256SUMS` via a new
   `--published` flag (b2c371a); the workflow now rebases and retries
   (6329ed6).

The tunnel UI shipped the same day (1df791c, admin-only `#/public`): three
separate unticked consents, exposure armed by typing the server name, address
shown only while the agent reports connected. The claim-rule re-sweep of that
new copy caught one unbacked sentence, "the agent stops when the dashboard
exits", which Windows does not promise; it is code now, a shutdown hook, and
`prove-tunnel` grew 47 to 49.

## 2026-08-01/02: public access, end to end

Provider: playit.gg, wire shapes read from its agent source at pinned commit
9e7b9a1 (v1.0.10) and confirmed live. The boundaries, all in the contract:
the claim flow is provider-minted (code generated locally, approval happens
in the operator's browser, the secret goes straight to disk and is shown
nowhere); running the downloaded binary is its own consent every time;
enabling exposure requires the server name typed; the address is null unless
the agent reports connected; every failure path states the server stays
LAN-only.

The live acceptance ended green (13 checks, 80a6bc2) after a first run that
failed honestly on two external blockers: a VPN owning all egress, and an
unverified provider account. Durable facts it produced: a `minecraft-java`
tunnel address carries no port suffix and rides 25565; the provider's Windows
release exe is `playitd` and accepts `--secret-path`, idling inert with no
secret; a real Server List Ping handshake through the public address proved a
player could join; withdrawal deleted the agent at the provider.

**F7 came out of that VPN finding** (b61ed04): the Addresses page had
presented the VPN's exit as the home address. The default route (structural
Virtual flag) is now read with every public-IP fetch as
`PublicIpState.route`, and the outside column is withheld with the reason
when a virtual adapter owns the route. An address without its route is not
information.

The claim rule itself was recorded in `../DESIGN.md` as permanent finish
discipline (b922780): any new or changed UI sentence must name the code that
makes it true.

## 2026-08-01: publish hygiene, and the copy sweep

The unpushed range was rewritten with the operator's approval before the
first public push (private addresses replaced with RFC 5737 documentation
addresses, private-file citations inlined), the tree byte-identical to the
pre-rewrite tip, and the result verified from a fresh clone: every commit in
the history free of every private pattern. A full UI-copy sweep followed
(every sentence traced to the code behind it): two defects found and fixed
in 0230fac, a stale first-run discovery sentence and a Worst-pause tooltip
blaming GC logging for a server that was simply not running.

## 2026-08-01: server creation, backend to acceptance

Backend (b24b6b9..381c2c8): `fetchverify` (no unverified download is
constructible), `mcsources` (Vanilla sha1 / Paper sha256 / Forge+NeoForge
`.sha512` sidecars; Fabric refused with the reason in the catalog), the
creation orchestrator (EULA gate audited, fleet-wide port check, generated
RCON password, journaled folder, scoped removal), Adoptium provisioning on
demand, admin routes with both consents in the wire contract.

UI and acceptance (82db550, ad0af45): the Create page carries the three
consents separately (EULA unticked with the real link, installer-run worded
as executing a downloaded program, Adoptium consequence printed beside the
option); ports arrive pre-filled with the why; the RCON password appears
nowhere on the page. `accept-creation` creates a real Vanilla 26.2 server
end to end: test-side sha1 recompute against piston-meta, started exactly
once via the real start path, second start refused, stopped over RCON with
the generated password never printed.

Version-scheme finding (8f0395b): Mojang's 26.x releases declare Java 25,
not the static table's 21 fallback. Provisioning installs the major Mojang
declares per version (`requiredJavaMajorLive`); the static table is an
offline fallback only. NeoForge follows Mojang versions verbatim in the 26.x
era (26.1.2 -> 26.1.2.x, stable = no dash suffix).

**Paper's v2 API is dead** (HTTP 410, measured); the code uses the v3 Fill
API (`fill.papermc.io` / `fill-data.papermc.io`).

A discovery-honesty fix rode along, later promoted to a classification
(e078430): a folder with `server.properties` and no `level.dat` is a
**never-started server**, a board row with the normal Start path, not
"not a Minecraft server".

## 2026-08-01: backups surface told the truth (F6)

"Detected" and "nightly" were removed from the Backups page (6b6dc9b): the
switch now says what it does, record intent in the opt-in file an external
script reads. Recorded as audit finding F6 (a212632): words implying a
mechanism nobody built. The backup-detection feature (decision 0001's
signals) is what makes "detected" sayable again.

## 2026-08-01: attach surface, distribution, graphs

**Attach became a permanent surface** (admin-only route `#/attach`): attached
folders with per-entry Detach, unwatched running servers, machine search,
add-by-path. The bug that milestone closed: an attachment whose folder is
gone used to sit on the board reporting UNKNOWN forever; attachments now
carry `ok` / `missing` / `no-world` state, a missing one never becomes a
server row, and the entry survives until the operator detaches it, because
an unplugged drive must not silently cost an attachment.

**Distribution shipped**: `scripts/package-release.ts` builds a ~32 MB zip
with the official `node.exe` (signature intact), the service esbuild-bundled
to `app/server.mjs`, `dist/`, and two `.bat` launchers. The layout is
load-bearing: the bundle sits in `app/` so `import.meta.dirname/..` resolves
`dist` and `package.json` the same as in dev. ESM output with a `require`
shim, because the source uses `import.meta.dirname` while Fastify plugins
`require()` at load. `scripts/accept-release.ts` extracts the zip elsewhere,
cuts PATH to the two Windows system directories, asserts node, npm, npx and
git are unreachable, then double-clicks the launcher. Two bugs it found in
itself: an orphaned instance from a previous run answered every HTTP
assertion (a free port is now a hard abort), and teardown throwing EBUSY
swallowed all results.

Measured once so nobody re-derives it:

- Explorer propagates mark-of-the-web to every extracted file including the
  `.bat` and `node.exe`; unblocking the zip first clears all of them; the
  bundled runtime keeps a Valid OpenJS Authenticode signature through the
  zip round trip. (This is also why the release stays a zip; decision 0007.)
- Forge and NeoForge publish `.sha1/.sha256/.sha512/.md5` sidecars next to
  their installers, same host over HTTPS, verified against real downloads.
  **Fabric's server jar has none**: `meta.fabricmc.net/.../server/jar` is
  generated per request, sidecars 404, and the meta JSON hashes only
  libraries. Byte-stable across fetches, which is trust-on-first-use, not
  verification. The way in, if revisited: `fabric-installer-*.jar` on
  `maven.fabricmc.net` does carry sidecars.
- Adoptium JRE win-x64 zips: 8 -> 38.2 MB, 11 -> 41.6, 17 -> 41.7,
  21 -> 46.7, 25 -> 55.8, each with a publisher checksum.
- The playit agent's claim flow needs no intermediary: in the agent source
  the claim code is 5 random bytes generated locally, `claim_url()` is pure
  string formatting, and `claim generate` / `claim url` /
  `claim exchange --wait` are first-class subcommands.
- Mojang's avatar host answers **404 for a name with no account**, so the
  dashboard's placeholder is its own. Player avatars are off by default and
  the switch withdraws a permission: while off, the avatar host is not named
  in `img-src` at all.

**Overview graphs** (`server/history.ts`): CPU, RAM, TPS over a 60-minute
in-memory ring, fetched by its own route so the snapshot stays lean. CPU is
differenced from cumulative kernel+user time and expressed as percent of one
core with the core count stated. A pid change voids the sample, elapsed time
is measured not assumed, a missing reading is null and drawn as a gap, a
down server still gets a sample so an outage cannot compress the time axis,
and the ring dies with the process, which the panel says out loud.

## 2026-07-30/31: the web pivot matured

- **Sessions persist to disk** at the operator's request, reversing a
  memory-only decision: atomic write, expiry enforced on load as well as
  lookup, corrupt file fails closed, touch persistence throttled.
  `prove-auth` covers resurrection of revoked and expired sessions.
- **The console hides the dashboard's own RCON polling.** On an idle server
  up to 100% of visible console lines were the dashboard's own 10 s poll
  (measured per server: 100%, 100%, 90.6%, 48.9%). No server logs the
  client's source port, so text alone cannot attribute; instead a ledger of
  the dashboard's own connections decides. Live lines fail open, only
  polling is registered (an operator's RCON command never goes silent),
  nothing is destroyed, and the filtered-empty pane says why it is empty.
  The deeper fix, a persistent RCON connection, was deliberately rejected:
  connect-then-run is part of how STALLED is detected.
- **The settings write path** (`server/serversettings.ts`) is the first
  thing the dashboard writes into a directory the server owns: an allowlist
  of two keys enforced by a zod enum on the wire (a general property editor
  is a path from a browser to `rcon.password`), text edited line by line
  with every other byte preserved, the previous file kept dated beside the
  original, atomic write, and "restart needed" measured from file mtime
  against process uptime rather than remembered. `online-mode` is
  arm/confirm with the consequence stated before the change.

## Older

The M0 through M3.7 story (attach model, six-state health, the pivot from
Electron to a self-hosted web service, auth, control, adaptive boot windows)
is summarized in the handoff's milestone table and its limits are recorded
there; the constraint-grade lessons from that era are rules 1 through 13 in
`liveness-spec.md`, the observer-lag and host-attribution story included.
The proof-world lesson (green proofs against an environment production does
not run in) is written up in full in `proof-coverage.md`.
