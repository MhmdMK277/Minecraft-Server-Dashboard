# 0010. Creation targets the folder the operator picks; the servers root stays a default

**Status:** proposed, awaiting operator approval. Nothing here is built.
**Date:** 2026-08-04

## The problem, from the second-machine trial

On the trial machine the servers root was never needed for what the root
supposedly exists for: the on-demand search plus attach found and watched
the operator's server with no configuration at all. The root mattered
exactly once, when creation insisted on `Documents\MC Servers`, a folder the
operator did not choose and which did not exist, on a machine that keeps its
servers on E:. Today `config.json` is the only way to change that, by hand.

So there are two candidate fixes, and they are different sizes:

- **Option A**: an in-app setting that changes the servers root itself.
- **Option B**: creation takes a parent folder from the operator, with the
  root as nothing more than the prefilled default. The root's other role,
  auto-watching its contents, is untouched.

## What was verified in the code before writing this

These are read from the source, not assumed:

1. **The ten-second watch loop's root is frozen at startup.** `buildServer`
   captures `cfg` once (`server/main.ts` loads it, `server/http.ts` closes
   over it; the poll's `doScan()` uses `cfg.serversRoot`). Editing
   config.json does NOT retarget the running watch until restart.
2. **Everything else re-reads per request.** The creation routes call
   `loadConfig(dataDir())` fresh (`/api/create/info`, `/api/create`,
   `/api/create/servers-root`), the on-demand search re-reads it
   (`server/scan.ts`), and attach re-reads the root for its duplicate-identity
   check (`server/attach.ts`, `currentServersRoot`).
3. **Attachments apply live.** `scan()` in `server/discovery.ts` calls
   `loadAttached(dataDir())` on every pass, so a new attachment appears on
   the next scan with no restart.
4. **Creation is already parameterized.** `startCreation` takes `parentDir`
   in its request and validates it exists and is a directory
   (`server/creation.ts`); only the HTTP route pins it to the configured
   root, deliberately: "it takes no path from the caller, so it cannot be
   aimed elsewhere."
5. **`loadConfig` already reports where the root came from**
   (`source: 'env' | 'config' | 'default'`), so UI copy about precedence has
   code behind it.

Consequence of (1): any copy saying a root change "applies immediately"
would be false today for the watch loop, the surface where it matters most.
Option A must either add reload plumbing to the poll or say "takes effect at
restart". Option B never changes the root, so the question dissolves.

## Option A: an in-app servers-root setting

The four issues, answered for A:

- **Write path.** Shaped like `serversettings.ts`: admin-only, a zod-pinned
  single key on the wire, previous config.json kept dated beside it, atomic
  write, audited with old and new values. This would be the first
  browser-reachable write to config.json, a file that also holds
  classification overrides and backup paths; the writer must edit the one
  key and preserve everything else byte for byte.
- **Consequence honesty.** Changing the root makes every server under the
  old root vanish from the watch. The arm/confirm step must list, by name,
  the servers that will disappear (computable from the current snapshot, so
  the claim has code behind it) and state when the change takes effect,
  which per the verification above is "at restart" unless reload plumbing is
  built into the poll loop.
- **Env precedence.** When `source === 'env'`, the setting renders disabled
  with "MCDASH_SERVERS_ROOT is set and wins over this setting"; writing a
  value that the resolver would ignore is a lie in file form.
- **Blast radius.** The root's semantics is auto-adoption: everything under
  it becomes eligible for start, stop and property writes. So before the
  confirm, the new root's contents are presented through the existing scan
  candidate presentation (the same walk and the same honesty: what was
  found, what looks like a server, what is running), and the confirm
  sentence states that all of it becomes watched. No silent trust of an
  unseen tree.

## Option B: creation takes the folder, the root stays a default

The Create page gains one field, "Create in", prefilled from the freshly
read config (`/api/create/info` already returns `parentDir` per request, so
even a hand-edit of config.json shows up there today without a restart).
The operator can type a different absolute path.

The four issues, answered for B:

- **Write path.** None. config.json is not written; the picked folder is a
  per-request argument to a flow that is already journaled and audited. A
  "remember this as the default" convenience is deliberately NOT part of
  this decision; if ever wanted, it is exactly Option A's writer and gets
  its own approval.
- **Consequence honesty.** Nothing vanishes; that hazard does not exist
  here. The new consequence to state instead: a server created outside the
  root is watched **because creation attaches it** (with the journaled
  start.bat as the confirmed launcher), and detaching it later removes it
  from watch like any attachment. Verified fact (3) makes "it appears on
  the next scan" true with no restart, and discovery already renders
  "Watched because you attached it."
- **Env precedence.** Unchanged in behavior: `MCDASH_SERVERS_ROOT` only
  determines the prefill. The field can annotate where its default came
  from, since `source` is already computed.
- **Blast radius.** This decision consciously revises the recorded route
  property "takes no path from the caller". What replaces it: admin-only as
  today, and the caller's path is refused unless it exists and is a
  directory, is not inside any existing server directory or the data
  directory, does not itself hold a `server.properties`, and the joined
  target resolves inside it (the resolve-and-jail check creation already
  does). The arm/confirm shows the absolute resulting path; the audit entry
  records it. There is no browsable directory picker: a typed absolute path
  validated server-side, because a browsing endpoint is a directory
  enumeration oracle from a browser. And the created folder enters the
  watch through the attach presentation rather than by being silently
  trusted.

## Multiple roots: no

Attach already covers the need multiple roots would serve for observation:
any folder, anywhere, per-entry state, confirmed launchers. What multiple
roots would actually add is multiple auto-adoption namespaces and multiple
creation defaults, and the costs are concrete: `classificationOverrides` is
keyed by directory NAME, which two roots can collide on; every
is-inside-the-root check (attach's duplicate-identity guard, the backup
policy's root field) becomes a list with ordering questions; and the root's
auto-adopt blast radius multiplies per root. Under Option B the residual
desire, "I usually create over there", is just the prefill. Not worth it.

## Recommendation: Option B

1. It fixes the thing that failed. The trial showed observation needs no
   root; the refusal was creation-side. A is a bigger lever than the
   problem.
2. It lands on verified-live plumbing. B rides entirely on paths that
   re-read per request and per scan (facts 2 to 4). A's central consequence
   lands exactly on the one thing frozen at startup (fact 1) and needs
   either new reload plumbing in the poll or restart-honesty copy.
3. Its worst consequence is smaller. A's biggest hazard, servers silently
   vanishing from watch, does not exist in B.
4. Smaller claim surface. B adds one validated input to an audited,
   journaled flow; A adds the first browser write to config.json.

Honestly out of scope for B: an operator who wants the WATCH root itself
moved still edits config.json by hand, restart required. That need has not
been observed in reality (the trial operator observed via attach without
friction); if it shows up, Option A stands here ready to be approved
separately.

## If accepted, the proof obligation

Aiming creation at an arbitrary folder is a start button pointed at an
operator-chosen tree, so this is harm-relevant and extends the existing
suites rather than shipping on review alone: prove-creation grows a refusal
matrix for hostile parents (inside a server, inside the data dir,
nonexistent, a file, join-escape), and accept-creation covers the
outside-root path ending attached and watched on the next scan.
