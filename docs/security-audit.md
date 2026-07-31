# Security audit

Performed 2026-07-31 against commit `ed3adf6` (the state before the fixes
below). Every check here is a command a stranger can rerun; where a claim
could not be tested, it says so instead of asserting it.

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
