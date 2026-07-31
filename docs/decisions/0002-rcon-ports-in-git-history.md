# 0002, RCON ports in git history are left alone, deliberately

**Date:** 2026-07-29
**Status:** decided by the operator

## What happened

A credential scan run with `rcon.port` included, rather than only
`rcon.password`, found that `fixtures/servers.json` had carried the real RCON
port of all four live servers since `2a47a33` (M1). That commit is on
`origin/main`, and the repository is publicly readable, so the ports were
already public before the M3 branch was pushed.

The same fixture also carried absolute paths containing the developer's Windows
username.

**No password ever leaked.** That scan has returned zero on every run, including
this one, and `ServerStatus` has no field capable of carrying one.

## Decision

**The history is not being rewritten.** Reasons, on the record:

1. The exposed values are the RCON *default and the obvious sequence from it*
   (25575–25578). Publishing them conveys close to nothing an attacker could not
   guess in four tries.
2. **RCON is not port-forwarded at the router.** The ports are reachable from
   the LAN only, so the exposure has no remote attack surface.
3. No password was ever exposed, so nothing needs rotating.
4. Rewriting published history is a destructive operation with real cost , 
   every clone breaks, and the fixture would still be recoverable from forks and
   caches. Paying that to hide four guessable numbers is not a good trade.

## What was changed instead

Going forward only:

- `rconPort` removed from the fixture and from `fixtures/generate.py`. Nothing
  ever read it; the generator wrote it and no consumer used it.
- `dir` removed from the fixture. It stores **names**, and `crossvalidate`
  rebuilds absolute paths from the configured servers root at runtime. The
  fixture's job is to say what should be true of a directory called `MC GTNH`,
  not where that directory lives.
- The hardcoded `C:\Users\<user>\mcbackup` in `fixtures/generate.py` and
  `fixtures/expected-python.py` replaced by `$MCBACKUP_DIR`, defaulting to
  `~/mcbackup`.

Net effect: regenerating the fixtures on any machine no longer writes a
username, a home path or an RCON port into a tracked file.

## Do not "fix" this later

If you find those values in the history, **that is known, and leaving them is a
decision, not an oversight.** Do not rewrite history to remove them without a
new reason. A password leak, the ports becoming remotely reachable, or the
router's forwarding rules changing. Re-read this file first, and check whether
its premises still hold before acting on them.

Related: `docs/liveness-spec.md` §10 (secrets), and the credential scan that
should be run before every push.
