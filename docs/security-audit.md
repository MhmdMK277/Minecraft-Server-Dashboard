# Security audit

Performed 2026-07-31 against commit `ed3adf6` (the state before the fixes
below). Every check here is a command a stranger can rerun; where a claim
could not be tested, it says so instead of asserting it.

**A second adversarial pass ran 2026-08-03 against `e846ce1`**, scoped to
everything added since M4 (cold backups, creation, the tunnel, the
MOTD/game-rule/settings writes, the instance lock, profiling, and every route
added since). It found nothing: five candidates were raised and all five were
dropped in independent triage. Workstream 3 records what was attacked, what
was demonstrated rather than argued, and the two conditions that would make
the one real primitive reachable.

**One critical vulnerability was found and fixed.** An unauthenticated caller
on the network could read the entire dashboard, including console lines, by
percent-encoding a letter of the URL. Details in F1.

## What is independent, and what is not

This matters more than the findings, because the whole document is only worth
what its weakest claim is worth.

**Independent of the author:**

- **CodeQL**, running on GitHub's infrastructure from
  `.github/workflows/codeql.yml`. Neither the analysis nor the results are
  produced by this machine, and the results are published to the
  repository's Security tab where anyone can read them.
- **Semgrep**, an external ruleset written by people who have never seen
  this project, run both locally and in CI.
- **`npm audit`**, against an advisory database this project does not
  control.
- **Human review by the operator.** The ranked reading list at the end of
  this document exists for that purpose.

**NOT independent, and should not be read as certification:**

- **The adversarial pass in workstream 2 was performed by an AI agent**,
  spawned without the build context but still the same kind of system that
  wrote the code. It found a critical bug the author's own review had
  missed, which is evidence it is useful, not evidence it is impartial. Its
  value is that it produced reproducible requests: the artifacts survive the
  reviewer, and you can rerun them without trusting either of us.
- **The proof scripts were written by the same author as the code.** They
  demonstrate specific failures being prevented; they cannot demonstrate the
  absence of failures nobody thought of.

The honest summary: this document raises the cost of an attack and records
what was checked. It is not a professional penetration test, and nothing in
it should be read as one.

## Disclosure record

The vulnerable code was public for part of its life, so this is recorded as
a disclosure rather than only as an internal note.

| | |
| --- | --- |
| Issue | Authentication bypass via URL percent-encoding (F1 below). An unauthenticated caller who could reach the port could read the full server snapshot, console backlog, worlds and app info |
| Severity | Critical for confidentiality; no unauthenticated write, control or RCON access was possible |
| Introduced | Present from the first public commit, `ee4ad74` (2026-07-31) |
| Public exposure window | `ee4ad74` through `34f87e5`, the same day |
| Found | 2026-07-31, by the M4 adversarial pass, before any external report |
| Fixed | 2026-07-31 in `5be2c48`, hardened to default-deny in the commit that followed |
| Fixed release | Any clone or pull of `main` at `5be2c48` or later contains the fix |
| Live instance | The operator's running service was restarted onto the fix the same day; the bypass was verified exploitable before the restart and closed after |

**If you cloned this repository during that window, pull `main`.** There is no
configuration change to make and no credential to rotate: the flaw allowed
reading, not authentication or writes, and no credential is reachable through
the API by design (see "What held"). If your instance was reachable by
someone you do not trust, treat anything your servers printed to their
console during that time as having been readable.

## Threat model

The system is a self-hosted monitoring dashboard that holds RCON credentials
for Minecraft servers, on a home LAN, with one operator and a small number of
read-only viewers who are friends of the operator.

Threats considered in scope:

| Actor | Capability assumed | What they must not achieve |
| --- | --- | --- |
| Unauthenticated caller on the LAN | Can reach the port | Any read of server data, any action |
| Viewer (a friend with an account) | Valid session, viewer role | Any state change: no control, no settings, no RCON, no backup toggle |
| Hostile web page the operator visits | Can make cross-origin requests | Any authenticated action (CSRF) |
| Malicious server content | Controls what a Minecraft server writes to its log | Script execution in the dashboard, credential disclosure |
| Someone with the operator's session cookie | Holds a stolen bearer token | Indefinite access (bounded by expiry and revocation) |

Explicitly **out of scope**, with reasons:

- **Plain HTTP on the LAN.** There is no TLS. A session cookie is liftable by
  anyone who can watch the traffic. This is a deliberate trade for a
  single-household tool; the mitigation offered is a tunnel
  (`MCDASH_TRUST_PROXY=1`) and the README says in bold not to port-forward
  the panel. `Secure` is therefore not set on the cookie: setting it would
  break the documented setup entirely.
- **No 2FA.** One operator, one account, on a LAN. A second factor protects
  against credential theft at a distance, which is not the shape of this
  deployment.
- **An attacker with filesystem access to the data directory.** They can
  rewrite `auth.json` and read every server's `server.properties` directly.
  Nothing the dashboard does can defend against that, and pretending
  otherwise would be theatre. (The session file is still validated on load;
  see F5 for why that is worth doing anyway.)
- **Denial of service by an authenticated user.** A viewer is someone the
  operator invited.

## Workstream 1: deterministic tooling

| Tool | Command | Result |
| --- | --- | --- |
| npm audit (runtime) | `npm audit --omit=dev` | **0 vulnerabilities** |
| npm audit (all) | `npm audit` | **0 vulnerabilities** |
| Semgrep | `semgrep --config=p/default --config=p/typescript --config=p/nodejs --config=p/owasp-top-ten --exclude=node_modules --exclude=dist server shared web scripts` | 5 findings, 0 runtime vulnerabilities, all triaged below |
| CodeQL | `.github/workflows/codeql.yml`, `security-extended` | Runs on push, PR and weekly; results in the repository Security tab |

### Semgrep findings, triaged

| Finding | Location | Disposition |
| --- | --- | --- |
| `subprocess-shell-true` | `scripts/prove-stall.py:66` | **Accepted.** Test tooling, not shipped code. The argument list is a hardcoded constant with no untrusted input; `shell=True` is what makes `npx` resolve on Windows. |
| `detect-child-process` (x2) | `server/launcher.ts:218` | **Accepted, with the reasoning recorded.** The inputs are a server directory and script name that come from the dashboard's own discovery, never from an HTTP request. The scheduled-task path deliberately passes the task name through environment variables rather than string interpolation. The `.bat` path must invoke `cmd.exe` because Node refuses to spawn `.bat` directly since CVE-2024-27980. An attacker who can create a directory under the servers root already has filesystem access. |
| `incomplete-sanitization` | `server/parse.ts:101` | **False positive for security.** `replace('*', '')` strips Paper's estimated-value marker before `Number()`; it is not escaping. A second `*` yields `NaN`, which is then filtered out, so the failure mode is dropping a reading rather than inventing one. |
| `detect-insecure-websocket` | `web/index.html:14` | **Accepted, documented above.** `ws://` follows from plain HTTP on a LAN, which is an explicit scope decision. |
| Parse error | `scripts/prove-rotation.ts` | Not a finding. The file contains a NUL byte as a deliberate test payload. |

### ESLint security plugins: attempted, removed

`eslint-plugin-security` and `eslint-plugin-no-unsanitized` require
`typescript-eslint`, which **cannot parse TypeScript 7 at all** and throws on
load (`typescript-eslint#10940`). Installing ESLint 9 also pulled in five
high-severity advisories of its own via `minimatch`; ESLint 10 resolved
clean, but the parser blocker stands regardless. The dependencies and config
were removed rather than left as dead weight. The coverage they would have
added (injection sinks, unsanitized DOM writes, `eval`) is covered by
Semgrep's `p/nodejs` and `p/owasp-top-ten` and by CodeQL's
`security-extended`, both of which parse TypeScript 7. Revisit when
typescript-eslint supports TS 7.1+.

## Workstream 2: adversarial pass

Run against an isolated instance with throwaway data, fake servers and canary
secrets, never the live service:

```bash
npm run audit-target      # prints base URL, test credentials, canary strings
```

The target uses a temp servers root, a temp data directory and port 8477, so
the control routes cannot reach a real JVM and no real world can be touched.

### Findings

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| F1 | **Critical** | Auth hook bypassed by percent-encoding the `/api` prefix | **Fixed**, `5be2c48` |
| F2 | Medium | Redaction missed secrets named in free text | **Fixed**, `5be2c48` |
| F3 | Low | `POST /api/servers/refresh` had no role gate | **Fixed**, `5be2c48` |
| F4 | Low | No security headers on API responses | **Fixed**, `5be2c48` |
| F5 | Low | Session file trusted `role`, `username` and future timestamps | **Fixed**, `5be2c48` |
| F6 | Medium | Backups page claimed a detection that never existed (found 2026-08-01, an honesty defect rather than a network one) | **Fixed**, `6b6dc9b` |
| F7 | Medium | Addresses page presented a VPN's exit address as the home public address (found 2026-08-02, honesty defect) | **Fixed** |
| F8 | Low | The pre-push guard's one-pattern-list design made per-file whole-exemption the only available fix, so a legitimate reference forced dropping every check for that file (found 2026-08-02, guard-design defect) | **Fix written**, applied by the operator's hand (the hook is local and untracked) |
| F9 | Medium | A GC pause window spanning a restart presented a replaced process's pause as the live server's: "304 pauses, worst 946 ms" combined a dead JVM's stall with a fresh JVM's harmless warmup churn and read as a current crisis (found 2026-08-02, honesty defect, same class as F6/F7) | **Fixed**, `server/gclog.ts` splits at the process boundary; prove-gclog pins it |

#### F9 (medium): two processes presented as one sick one

At 05:33 on 2026-08-02 the fleet showed a server with "304 stop-the-world
pauses in the last 60 minutes, worst 946 ms". Both numbers were true of the
window and the picture was wrong: the 946 ms pause happened at 04:57 in a
JVM that was stopped at 05:00 by the nightly backup rotation, and the pause
count was the replacement JVM's normal warmup churn (its real worst: 36 ms).
The reading walked rotated logs across the restart, which is correct
behaviour, and then attributed everything it found to "this server" as if a
server were one continuous process, which is not. The operator read it as a
healthy server dying, which is the F6/F7 failure class inverted: honest
numbers, dishonest aggregation.

Fixed in `server/gclog.ts`: when the current process's start time is known,
every headline figure (count, worst, severity, stopped-percent, whose
denominator is now the process's own age) describes the current process
only, and pauses older than it are reported in a separate
`previousProcess` block whose sentence names the moment of replacement.
With no known process start, the window is summarised whole, unchanged.

#### F8 (low): a guard whose only exception is total exemption

The local pre-push hook (untracked, on the development machine only) scanned
outgoing commits with one combined regex of six patterns: five genuinely
private values (public IP, username, hostname, LAN prefix, tailnet address)
plus the name of the gitignored handoff file, which tracked code must not
cite. Its only exception mechanism was a git pathspec exclusion, which
exempts a FILE from the whole scan, not from one pattern.

That shape failed the first time a legitimate single-pattern reference
appeared: CLAUDE.md must, by operator instruction, tell every session to
read the handoff file, and the only edit the hook's design offered was to
stop scanning CLAUDE.md for the five private values too. The pre-existing
`.gitignore` exemption had the same over-breadth from day one; it simply had
never mattered. A guard whose easiest correct-looking fix is a broad
weakening will eventually get that fix under deadline, so the design is the
defect, independent of whether anything leaked (nothing did: both scans were
re-run over the whole tree and every outgoing commit before the rewrite).

The fix splits the scan in two: the five private patterns apply to every
tracked file with no exceptions at all, tightening `.gitignore` back under
them, and the handoff-name pattern alone carries the two legitimate
exceptions, each with its reason in the hook's comment. Both scans were
verified clean over the tree and every outgoing commit before the rewrite
was proposed. The general rule worth keeping: **an allowlist must be scoped
to the rule that needs it, never to the file that triggered it.**

#### F1 (critical): the gate keyed on spelling, not on the route

Reproduce against the pre-fix commit:

```bash
curl -i http://127.0.0.1:8477/api/servers      # 401, as expected
curl -i http://127.0.0.1:8477/%61pi/servers    # 200 application/json, the whole snapshot
curl -i "http://127.0.0.1:8477/%61pi/servers/Audit%20Server%20One/log"   # every console line
curl -i -X POST http://127.0.0.1:8477/%61pi/servers/refresh              # forces a rescan
```

The global `onRequest` hook decided whether a request needed a session by
testing the raw request target with `req.url.startsWith('/api')`. Fastify
percent-decodes the path when it routes, and routing runs *before* hooks, so
`/%61pi/servers` failed the string test, skipped the hook (which performs
both the session check and the CSRF check), and was then dispatched to the
real `/api/servers` handler.

Everything without an in-handler role gate was exposed to anonymous callers:
`/api/info`, `/api/servers`, the console backlog, worlds, world icons, and
`refresh`. Console lines carry whatever a server prints. The mutating routes
held, because `require_()` reads a session the skipped hook never attached,
so there was no unauthenticated write or RCON access.

**Fix.** The hook now keys on `req.routeOptions.url`, the route pattern
Fastify matched, which no spelling of the request can change. Read routes
additionally call `require_()` themselves, so the hook is no longer the only
line of defence. Regression net:

```bash
npm run prove-authgate    # 56 checks; 8 of them failed against the old code
```

It asserts sixteen spellings of a protected route (`/%61pi/`, `/%61%70%69/`,
`/ap%69/`, `/API/`, `//api/`, `/api/../api/`, encoded traversal, trailing
slash and more) return no JSON to an unauthenticated caller, that no canary
string escapes, that mutating routes stay shut, and that a genuine session
still works.

#### F1a: the gate is now default-deny over every route, not just under `/api`

The first fix closed the bypass but left a second question, raised on
review: was the gate *default-deny*? It was not, quite. The hook still
returned early for anything whose route pattern did not begin with `/api`,
so a route registered elsewhere would have been born world-readable and
nobody would have had to decide that. A Prometheus `/metrics` endpoint is on
this project's own roadmap, and it would have shipped public.

The question is inverted now. Every registered route requires a session
unless its pattern appears in one of three **named** sets in `server/http.ts`:
`PUBLIC_ROUTES` (the two routes needed to obtain a session), `SELF_GUARDED`
(the WebSocket, which cannot answer 401 to an upgrade and closes 4401
instead), and `SHELL_ROUTES` (the SPA shell, which carries no data and must
be reachable for the login screen to load). Making a route public is now a
visible edit to a security-relevant file.

`prove-authgate` proves this against reality rather than against a list
someone maintained by hand:

- the server records its own route table as Fastify registers it
  (`app.registeredRoutes`), and the proof fires an unauthenticated request at
  **every route in it**, failing if any answers without being a named
  exception. All 21 current routes pass;
- every name in the exception lists must still resolve to a real route, so a
  stale entry cannot rot there unnoticed;
- and the proof registers three **new** routes at runtime, including
  `/metrics`, to demonstrate that a route added tomorrow is protected without
  anyone remembering to protect it. All three return 401.

#### F2 (medium): redaction missed free-text secrets

`[DiscordSRV] Using token <value>` passed through unredacted: the rule
required a `:` or `=` delimiter, and the value did not match the Discord
`id.ts.hmac` token shape. Fixed with a free-text rule that requires a
credential-shaped value (10+ characters containing a digit or separator), so
ordinary prose such as `Invalid token supplied` and `token expired` stays
readable. Asserted in `prove-authgate` section 7.

#### F3 (low): `refresh` had no gate

Any viewer could force a full rescan, which spawns processes. Now requires a
session. It stays open to viewers deliberately, because the Refresh button is
theirs too and the work is the same as the ten-second scan loop.

#### F4 (low): no security headers

API responses carried only `content-type`. Now every response carries
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer` and a `Permissions-Policy`. The CSP is scoped:
API responses get `default-src 'none'; frame-ancestors 'none'`, while the SPA
keeps the policy that permits its own bundle, because browsers intersect
every policy they receive and sending the API's policy to the page would
forbid its own scripts. `Strict-Transport-Security` is deliberately absent:
see the plain-HTTP scope decision.

#### F5 (low): what a tampered session file could resurrect

`sessions.json` holds live bearer tokens and roles in cleartext;
`chmodSync(0o600)` is effectively a no-op on Windows, where the file is
protected by the inherited ACL on `%APPDATA%`. The load path validated the
fields needed to compute expiry but trusted the rest, so a tampered file
could name any `role` (escalating a viewer session to admin), a username
belonging to no user, or a timestamp in the future, which makes
`now - createdAt` negative so the session never expires.

An attacker who can write this file can also rewrite `auth.json`, so this is
not the last line of defence. It is still worth refusing, because forging an
entry skips having to crack scrypt at all. All three cases are now dropped on
load, asserted in `npm run prove-auth` (74 checks).

### What held

Verified by attempted exploit, not by inspection:

| Area | Evidence |
| --- | --- |
| Role gate | Full route x role matrix: every mutating route returns 403 to a viewer, 401 unauthenticated |
| RCON credentials | The canary password appears in **zero** bytes of every GET response and every WebSocket frame. The wire contract exposes only `rconConfigured: boolean` |
| Path traversal | `..`, encoded traversal, absolute paths, UNC paths and null bytes against the world icon route: all 404. The `:dir` segment is matched by strict equality against discovered world directories |
| Settings allowlist | `rcon.password`, `level-name`, `__proto__`, `constructor`, type confusion and array keys: all 400. Verified against the file on disk, which was unchanged |
| Command route | Viewer 403; `stop`/`restart` refused by the forbidden-command check; the RCON body is length-capped and framed as a single length-prefixed packet, so newline and CRLF cannot split it into a second command |
| CSRF | Missing header 403; `X-HTTP-Method-Override` ignored; cookie is `SameSite=Strict` |
| Sessions | Fresh 256-bit id per login (no fixation); logout revokes server-side; password change revokes every other session; expiry enforced on both axes |
| WebSocket | No cookie and invalid cookie both close `4401` with zero frames; the server registers no inbound message handler |
| Login throttling | Locks out after 5 failures with `429` and `retry-after`, keyed on IP **and** username |
| XSS | Log text reaches the browser as React children with no `dangerouslySetInnerHTML`; colours come from a fixed hex map, so server-controlled text cannot inject markup or CSS |

#### F6 (medium): the Backups page claimed a detection that never ran

Found 2026-08-01, during a review of the Backups surface. Not a network
vulnerability: nothing leaked and nothing could be exploited. It is recorded
here because it is a **false-healthy claim about data protection**, which
this project treats as the same class of failure.

The page said backups are made by "the external backup system this dashboard
detected, on its own schedule", and the switch was labelled "In the nightly
backup". No detection code exists anywhere in the repository; decision
0001's detection signals were specified and never implemented. "Detected"
was therefore false on every machine, and "nightly" was an assumption
imported from the machine the copy was written on, whose backup script runs
from Task Scheduler at 05:00. An operator with a different backup tool, or
none, was shown a switch implying their worlds were in a rotation that may
not exist.

Fixed in `6b6dc9b`: the page now states only the verifiable mechanism (the
switch records intent in `backup-policy.json`; a script that reads that file
acts on it; if nothing reads it, the switch changes nothing) and explicitly
says that nothing on the page means the worlds are backed up.

The lesson, same as F1's spelling-versus-route: UI copy is a claim, and a
claim either has code behind it or it does not ship.

#### F7 (medium): the Addresses page presented a VPN exit as the home address

Found 2026-08-02, live, during the public-access acceptance: the tunnel
provider reported the claiming machine's address as an IPv6 geolocated to
New York, which did not match this network. Measurement showed a VPN
adapter (HotspotShield WinTun) owned the machine's entire default route,
and the Addresses page had been fetching the public IP through it and
presenting the VPN's exit as this house's address, confidently, in the
"Outside / abroad" column players are given to join by.

Not an information leak; the opposite failure: a **false-confident
reading about reachability**. Anyone handed that column while the VPN was
up got an address that would never work, and the sticky "public address
changed" banner fired on VPN toggles as though the ISP had moved. The
same incident showed the LAN column survived only by luck: the VPN's
local 10.x address scored as an ordinary candidate and lost to Wi-Fi
only because this network uses 192.168.

Fixed: the default route is now read in the same refresh as every public
address fetch (`queryEgressRoute` in server/network.ts, structural
`Get-NetAdapter` Virtual flag, no vendor list), the reading travels as
`PublicIpState.route`, and when a virtual adapter owns the route the
Addresses page withholds the outside column and says why, the change
banner names the VPN as the likely cause, and the footer states which
adapter owned the route at measurement time. The parse is proven in
scripts/prove-addresses.ts; the LAN scoring demotes known tunnel adapter
names as a heuristic on top of the structural check.

The lesson, F6's applied to numbers: a measurement without its
provenance is a claim, and the provenance here is who owned the route.

### Not tested, and why

- **Live RCON injection.** The isolated target has no listening RCON, so the
  command route returns 400 before a packet is framed. Framing safety was
  assessed from `server/rcon.ts` instead.
- **Session expiry in real time.** 2 hours idle, 12 hours absolute; enforcement
  verified in code and by direct `SessionStore` tests rather than by waiting.
- **A real browser executing injected content.** Assessed from the renderer
  and the API bytes; no live DOM was driven.
- **The launcher's `cmd.exe` quoting against a directory name containing a
  double quote.** Windows forbids `"` in filenames, so the case cannot be
  constructed on this platform. A directory named
  `Audit & Co %TEMP% $(whoami) ` + backtick + `id` + backtick flowed through
  discovery and the API without incident.

## Workstream 3: the second adversarial pass (2026-08-03)

Performed against commit `e846ce1`, clean tree, scoped to everything added
since M4: cold backups and their routes, server creation, the tunnel, the
MOTD/game-rules/settings write paths, the instance lock, profiling, and every
route registered since M4.

**Result: no finding survived triage.** Five candidates were raised by the
reviewers and all five were dropped by independent triage at 2-3 out of 10.
Saying that plainly is the point of this section: a pass that manufactures a
finding to look thorough is worth less than one that reports nothing.

Method, and its limits. Three reviewers were spawned without the build
context, one per surface group, and told not to trust the code comments,
which in this repository assert security properties confidently. Each
candidate then went to a separate triage agent that re-read the code itself.
Same caveat as workstream 2: **this is still an AI reviewing code an AI
wrote.** What survives the reviewers is the artifacts.

### The five candidates, and why each was dropped

| # | Candidate | Verdict |
| --- | --- | --- |
| 1 | Authenticode check gates on signature validity but never compares the signer subject, so any trusted-root code-signing certificate satisfies it (`server/tunnel.ts`) | **Dropped, 2/10.** The attack begins "compromise playit's release pipeline". Upstream supply chain, plus a per-run operator confirmation before the binary executes. Pinning the subject is a worthwhile comment-level hardening note, not a finding |
| 2 | The tunnel forwards to whatever `server-port` declares, including the dashboard's own port or the RCON port (`server/tunnel.ts`) | **Dropped, 2/10.** Requires write access to a server directory, which is the operator's own account. The port is rendered twice in the confirm UI before the typed consent, so the "believed it was a game port" premise fails |
| 3 | Restore extraction honors symlink members and writes through them (`server/coldbackup.ts:298`) | **Dropped, 3/10.** See below: the primitive is real and demonstrated, the reachability is not |
| 4 | Restore trusts the manifest's `archivePath`, `serverDir` and recorded `sha256` with no containment check, while the backup path does apply `within()` | **Dropped, 2/10.** Requires local same-user write to the data directory, which also holds `sessions.json` and `config.json`; that actor can forge an admin session or repoint the servers root, which is strictly more power |
| 5 | The archive is hashed and then re-opened for extraction, so the integrity check is not atomic with the use | **Dropped, 2/10.** A race strictly dominated by its own precondition: anyone who can win it can instead edit the manifest's recorded hash at leisure |

### What was demonstrated rather than argued

The primary target was zip-slip on restore, and it was attacked empirically:
real malicious archives built in a scratch directory, extracted with the exact
command `server/coldbackup.ts:298` runs (`System32 bsdtar`, `-x -f … -C … 
--strip-components 1`, no `-P`).

**Every traversal and absolute-path form was refused or neutralised.** `..`
at several depths, backslash and mixed separators, doubled separators,
traversal buried mid-path, percent-encoded `..`, trailing dots and spaces:
all refused with `Path contains '..'`, exit 1, nothing written. POSIX
absolute, drive-letter, drive-relative and UNC paths were stripped to land
inside the destination. A hardlink aimed at a sibling `start.bat` was
contained. A zip whose local header and central directory disagreed escaped
neither way. **`--strip-components` is applied before the `..` guard**, so the
strip-prefix trick does not bypass it.

The one primitive that did escape is **symlink members**: bsdtar creates the
link, then follows it to write the next member outside the destination. Four
variants escaped in the lab. It is not reachable through this application:
restore only extracts manifest-listed archives, the sole manifest writer is
the app's own backup, and `tar -a -c` records a symlink as an inert member
and never emits a write-through-the-link member. A full round trip confirmed
it: a symlink planted in a server directory came back as an inert reparse
point with the victim file outside untouched.

**Two conditions would make it live, and are recorded here so the re-test is
not forgotten:**

1. **A File Manager, or any route that writes into server directories**
   (deferred on the roadmap). A planted directory symlink plus a
   backup/restore round trip is the realistic route to a hostile member.
2. **Any route that accepts archive bytes.** There is no upload route today;
   `grep multipart server/` returns nothing.

If either lands, extraction needs its own guard rather than the archiver's:
walk `restoredDir` after extraction and fail loudly on any reparse point
whose target leaves the folder.

### What was checked and held

- **Property injection into `server.properties` is unconstructible.** Nine
  payloads were run end to end through the real `writeMotd`: LF, U+2028,
  U+2029, U+0085, a trailing backslash (`.properties` line continuation), and
  four escape-syntax tricks. All nine stayed inside the `motd` value; the
  credential line was byte-identical every time and the line count never
  changed. U+2028/U+2029/U+0085 do pass the wire's control-character filter,
  which does not matter: the encoder renders everything outside printable
  ASCII as `\uXXXX`, and a backslash is always doubled.
- **Game rules cannot smuggle an RCON command.** Eleven payloads through the
  real wire contract: newline and semicolon in the value, injection in the
  name, `1e10`, `NaN`, `Infinity`, `-0`, `3.5`, a `toString` object,
  `__proto__`. All rejected except legitimate values, and the command is
  always two tokens built from a catalog constant.
- **The gate covers the new routes without being told to.** `prove-authgate`
  is 121 checks; the three cold-backup, two game-rule and one profiling route
  each answer 401 unauthenticated. Every mutating route requires admin; no
  mutating route is viewer-reachable.
- **Creation cannot escape the servers root.** The name regex rejects every
  separator, drive-colon, UNC and ADS form; `..`, trailing dot/space and
  reserved device names are separately blocked; and `basename(dir) !== name`
  after `resolve(normalize(join(...)))` is the second gate. `parentDir` is
  hardcoded to the configured servers root and the request's field is never
  read. Every download is checksum-verified before use, redirects are
  re-checked per hop against hardcoded host lists, and the installer spawn is
  an args array gated on a server-side `confirmRunDownloadedProgram === true`.
- **The tunnel's typed confirmation is enforced in the module**, not the UI,
  and the secret is never returned by any route: status carries
  `secretPresent: boolean` only.
- **A crafted instance-lock file cannot redirect a write**: no path is ever
  read from the lock, and the pid is integer-validated twice before it
  reaches a command line, then used only for a liveness probe.

### Observations recorded, not findings

- `POST /api/servers/:id/coldbackup/restore` never resolves its `:id`
  parameter; any admin may restore any `archiveId` regardless of the server
  the URL names. Both sides are admin-only, so no boundary is crossed, but
  the path parameter is decorative and reads as scoping that is not there.
- The session cookie omits `Secure`, which is the documented plain-HTTP LAN
  deployment decision, and the login route is a public CSRF exception.

### Workstream 3a: the deterministic tools over the M4+ code

The parts of this pass a stranger can trust without trusting an AI. Run
2026-08-03 against `e846ce1`.

**`npm audit`: 0 vulnerabilities**, 595 dependencies.

**CodeQL** (`security-extended`, GitHub-hosted, published to the Security tab):
the workflow is green, which means it RAN, not that it is silent. It carries 37
open informational alerts. Eight are in M4+ shipped modules, and every one is
an excluded category or a pre-existing pattern:

| Alert | Location | Disposition |
| --- | --- | --- |
| `js/biased-cryptographic-random` | `creation.ts:235` | `b % 56` modulo bias on the generated RCON password. Real bias, negligible against ~139 bits from `randomBytes(24)`; the value is server-side only, written to `server.properties`, never on the wire. Secret-on-disk / hardening, excluded. |
| `js/insecure-temporary-file` (x3) | `creation.ts:156,469,570` | Staging files written INSIDE the job's own directory under the servers root, not a world-writable shared temp, so the shared-temp swap the rule warns about does not apply. |
| `js/file-system-race` | `profiling.ts:101` | A read-side race on a server's own `gc.log`. No integrity sink; a viewer reads a log. |
| `js/http-to-file-access` (x3) | `tunnel.ts:115`, `creation.ts:156,469` | The verified downloads (agent, server jars, Java). Each is checksum-verified before use; this is the intended data flow, flagged structurally. |

The `js/command-line-injection` (critical) alerts are in `launcher.ts`, pre-M4
and already dispositioned (the `cmd.exe` launcher takes a discovery-derived
directory, never request data; a directory name cannot contain a quote).

**Semgrep** (`p/nodejs`, `p/owasp-top-ten`, external ruleset): 7 blocking
findings, the same recurring set the CI has carried for months, none in new
exploitable code. Two touch M4+ modules and both are excluded categories:
`detect-non-literal-regexp` at `gamerules.ts:103,105` (the rule name in the
query regex is a catalog constant, not user input; ReDoS/regex-injection
excluded) and at `mcsources.ts:176` (the length in a hex-check regex is a
number). The rest (`prove-stall.py` subprocess, a FAKE hex secret in
`prove-tunnel.ts`, `parse.ts` marker-strip, `index.html` `ws://`) were
dispositioned in workstream 1.

### Workstream 3b: exploits fired, with their output

Every attack below was RUN against the real module functions, not argued from
the code. The scripts are the session's exploit corpus (kept out of the repo;
they hardcode throwaway paths). Summary of what was fired and what happened:

- **Zip-slip on restore, 12 crafted archives** through the real
  `restoreColdBackup` with a correct-hash manifest entry: every `..` form (tar
  and zip, deep, backslash, mixed, strip-then-dotdot) REFUSED by bsdtar (`Path
  contains '..'`); every absolute / drive-letter / drive-relative / UNC form
  stripped and CONTAINED inside the restore dir; percent-encoded `..` treated
  as a literal filename, contained. The one primitive that escaped is a
  **symlink member** (write-through-the-link, 1 of 2 variants), and only
  because the test shell was elevated.
- **The symlink escape is not reachable through the app.** A full round trip
  (plant a symlink in a server dir, run the real `runColdBackup`, restore it)
  stored the symlink as an INERT link member (`lrw-rw-rw- World/escape -> ...`)
  and left the outside victim file untouched. And the production token cannot
  create the link at all: `SeCreateSymbolicLinkPrivilege` is granted to
  `S-1-5-32-544` (Administrators) only, Developer Mode is off, and the
  dashboard task runs `RunLevel: Limited`. Measured this time, not inferred.
- **Manifest / archive disagreement, 5 cases**: a journaled hash that does not
  match the bytes, an archive tampered after journaling, a missing archive
  path, an unknown archive id, all REFUSED with the sha256 sentence; a ~1000x
  compression bomb extracted into its own restore dir (contained; DoS out of
  scope). The self-referential-hash weakness is real only for an attacker who
  can rewrite the manifest, i.e. same-user data-dir write.
- **Creation, 19 hostile names** through the real `validateName` +
  `startCreation`: `..`, `../escape`, `..\escape`, `../../Windows/Temp/evil`,
  `C:evil`, drive and UNC paths, `world:$DATA` ADS, `CON`/`PRN`/`LPT1`,
  trailing dot and space, embedded NUL, `a/b`, all REJECTED; only the control
  name `good-name` created, inside the root; the canary outside stayed empty.
- **Tunnel exposure, 4 wrong confirmations** (empty, wrong name, case
  mismatch, whitespace pad) all REFUSED server-side by the typed-name check;
  the correct name passed the gate as intended.
- **Tunnel secret readback**: a real hex secret loaded from `playit.toml`
  (`secretPresent: true` proves it was read), and the secret string appears
  NOWHERE in the `tunnelStatus` response, which carries only the boolean.
- **Installer without confirmation**: unconfirmed `runInstaller` calls never
  executed anything. The specific `confirm !== true` branch needs an
  `awaiting-installer` job (a real Forge download not stageable offline); it is
  read-verified at `creation.ts:521`, identical in shape to the tunnel
  `confirmRunDownloadedProgram !== true` gate at `tunnel.ts:446` which WAS
  fired. Stated as read-verified, not fired.
- **MOTD / game rules / settings**: 9 MOTD property-injection payloads (LF,
  U+2028, U+2029, U+0085, trailing backslash, escape tricks) all contained
  inside the value with the credential line byte-identical; 11 game-rule wire
  payloads (newline/semicolon in value, injection in name, `1e10`, `NaN`,
  `Infinity`, `-0`, `3.5`, `toString` object, `__proto__`) all rejected except
  legitimate values; `rcon.password`, `server-port` and `__proto__` keys
  rejected at the wire.
- **Instance lock, 9 crafted files**: a command-injection string in `pid`
  rejected as `corrupt` before reaching the command line (no process spawned);
  numeric pids stringify to injection-free characters; the `host` field is
  never used as a path; `released:true` and stale takeovers are announced and
  require same-user data-dir write.

## Reproducing the whole audit

```bash
npm ci
npm audit                       # expect 0 vulnerabilities
npm run typecheck

# static analysis (semgrep is Linux/macOS; on Windows use the CI workflow)
semgrep --config=p/default --config=p/typescript --config=p/nodejs \
        --config=p/owasp-top-ten --exclude=node_modules --exclude=dist \
        server shared web scripts

# the security proofs
npm run prove-authgate          # 56: the auth gate, headers, redaction
npm run prove-auth              # 74: roles, sessions, persistence, throttling
npm run prove-control           # 41: control routes, refusals, audit
npm run prove-settings          # 49: the server.properties write path
npm run prove-websocket         # no credential in any frame
npm run prove-console-noise     # 31: what stays visible

# stand up an isolated target and attack it yourself
npm run audit-target
```

CodeQL results are in the repository's Security tab on GitHub, produced by
GitHub rather than by this repository's author.

## Files worth a human's own eyes

Ranked by how much damage a flaw in them would do. This ranking was revised
after the audit: `http.ts` moved to the top because that is where the
critical bug actually was.

1. **`server/http.ts`, the `onRequest` hook and `require_`** (around lines
   125-215). Thirty lines that every other route's safety depends on. This is
   where F1 was. Read it asking "what representation of the input is this
   check looking at, and is it the same one the router used?"
2. **`server/auth.ts`.** scrypt parameters, session creation, both expiry
   axes, revocation, and the disk persistence load path (lines 233-260 in
   particular, which is where F5 was).
3. **`server/serversettings.ts`.** The only code that writes into a directory
   a Minecraft server owns. The two-key allowlist is the barrier between a
   browser and `rcon.password`.
4. **`server/control.ts`.** Start, stop, restart and the double-spawn guard.
   Not a confidentiality risk, but two JVMs on one world is the worst outcome
   in the project.
5. **`shared/api.ts`, the `ServerStatus` schema.** The structural guarantee
   that no credential can cross the wire. Worth reading precisely because it
   is boring: the safety is in what is absent.
6. **`server/redact.ts`.** What is masked before log lines leave the host,
   and where F2 was.
7. **`server/worlds.ts` and the world icon route.** The newest path-handling
   code, therefore the least battle-tested.
