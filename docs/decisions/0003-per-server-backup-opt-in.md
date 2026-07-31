# 0003, Per-server backup opt-in lives in a file, not in the app

**Date:** 2026-07-30
**Status:** accepted

## Context

Decision 0001 established that the app **detects** backup systems and does not
implement one. That stands. But it left a real problem unsolved.

`mcbackup.py` backs up every directory under the servers root that has a
`level.dat`. There is no way to say "not that one". So a directory that will
never run again. A retired modpack, a `- Copy` left over from an upgrade , 
keeps consuming a slot in a seven-deep rotation and time in the nightly window,
indefinitely. On this install two of six directories were in that state, which
is a third of every nightly run spent on worlds nobody will load.

The only available remedy was to delete the directory. That is the wrong trade.
The files are the thing worth keeping; the *schedule* is the thing that should
change. Being forced to choose between "keep backing up something pointless" and
"delete a world" is a false choice created by the tool.

## Decision

The dashboard renders one tick per discovered server directory. The state is
written to `<dataDir>/backup-policy.json`, which `mcbackup.py` reads.

```json
{
  "version": 1,
  "backupByDefault": true,
  "servers": { "MC Tech": false, "MC 1.21.4 - Copy": false },
  "serversRoot": "C:/Users/<user>/Documents/MC Servers",
  "updatedAt": "2026-07-29T23:31:55.328Z",
  "updatedBy": "cli"
}
```

### Why a file

The two processes are never alive at the same time. The backup runs from Task
Scheduler at 05:00; the dashboard may well be stopped. Any channel that requires
both ends to be up. A socket, an HTTP call, a queue, cannot work here. A file
also satisfies the requirement that the setting survive a restart of either side
without either side doing anything special.

It sits next to `config.json` and `auth.json`, and `mcbackup.py` resolves the
same path by the same rule (`MCDASH_DATA_DIR`, else the platform default), so
there is one location and no synchronisation.

Keys are directory names, matching `classificationOverrides` in `config.json`.
That is the identifier the operator sees and the one the backup script already
uses for its per-server log lines and destination folders.

### Absent means yes

A missing file, an empty file, a corrupt file, a name nobody has an opinion
about, or a value that is not a literal `true`/`false` all mean **back it up**.

This is the only decision here with an irreversible consequence. Wrongly backing
something up costs disk and a few minutes. Wrongly *not* backing something up is
discovered when a world is already lost. So every ambiguous input lands on the
safe side, in both languages, and `"false"` as a string is specifically tested,
because Python's truthiness would otherwise read it as `True`, and JSON gives
you a `str` with no complaint.

### Opting out is a schedule change and nothing else

The filter runs in `main()` **before** the per-server loop. An excluded
directory is therefore never stopped, never archived, and. The part that
matters, never reaches `rotate()`, the only function in the backup script that
deletes anything. Its existing archives are not merely retained, they are never
even enumerated.

This ordering is a load-bearing property, not an implementation detail, so
`scripts/prove-backup-policy.ts` asserts it against the real source: that
`main()` never calls `rotate()` itself, and that the filter line precedes the
loop line. Move the filter after the loop and the proof fails.

Every skipped server is logged as `EXCLUDED` with a count of the archives left
in place. A silent exclusion would be indistinguishable, six months later, from
a backup that quietly broke.

### Admin-only and audited

This is the first route in the app that writes state an **external** program
acts on, unattended, hours later. A viewer who could flip these ticks could stop
every world on the box being backed up, and nobody would find out until they
needed a backup. So it goes through the same gate as `ack-ip-change`: admin
role, CSRF header, and an audit entry for every attempt including the refusals.
The audit records which way the tick went, in words.

## Consequences

- Retiring a directory no longer requires deleting it. This is the outcome that
  was actually wanted.
- The app now writes one file that an external tool reads. That is a widening of
  decision 0001's boundary, and it is deliberately as narrow as it can be: one
  boolean per directory. The dashboard still does not schedule, run, verify,
  rotate or delete a backup, and it cannot reach the backup script's own
  settings.
- `mcbackup.py` gains a dependency on a file it must tolerate the absence of.
  That is why "absent means yes" is a rule and not a default.
- Anyone running the backup script without the dashboard is unaffected: no
  policy file, everything backed up, exactly as before.
