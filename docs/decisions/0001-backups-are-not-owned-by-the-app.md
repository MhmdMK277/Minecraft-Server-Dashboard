# 0001. The dashboard does not own backups

**Status:** accepted
**Date:** 2026-07-28

## Decision

The dashboard **detects and surfaces** whatever backup system a server already
has. It does not implement its own.

## Why

There are three backup models already in the wild, and every server this tool
will ever see is using one of them:

1. **External script, server-agnostic**. A scheduled task, a cron job, a shell
   or Python script that stops, copies and restarts. Runs outside the server
   entirely and knows nothing about Minecraft beyond file layout.
2. **Panel-integrated, in-process**. The panel performs the backup itself.
   Crafty Controller and VoxelDash both work this way.
3. **A mod or plugin inside the server**, ServerUtilities and AromaBackup on
   1.7.10 packs, various Paper plugins. GTNH ships one of these enabled by
   default.

Building a fourth would be actively harmful, for three reasons:

- **It would be the least informed one.** An external script can stop the server
  and copy a quiescent world. A plugin can hook the save cycle. A dashboard that
  is deliberately an outside observer, which is the whole premise of this
  project, has neither advantage. It would be doing the hardest version of the
  job with the least context.
- **It would silently duplicate work.** A user who already has a working backup
  and switches this on now has two systems copying the same world on
  overlapping schedules. That is doubled disk, doubled I/O, and on a box that
  already stalls under I/O pressure it is a real risk, not a theoretical one.
- **It would put write authority in a read-only tool.** The value of this
  dashboard is that it cannot damage a server. A backup feature means stopping
  servers, deleting old archives and writing to disk on a timer. That is a
  different trust level, and bolting it on would undermine the thing that makes
  the rest of the tool safe.

Detection is also the more useful feature. "You have two backup systems running
against the same world" is information the user cannot easily get anywhere else.
"Here is a fourth backup system" is something they already have.

## What this means for later milestones

- No scheduler, no archive writer, no retention logic in this codebase.
- No assumption that a backup exists at all, plenty of servers have none, and
  the correct response to that is to say so, not to offer to fix it.
- Anything written to disk is the app's own config in `userData`, never a
  server directory and never a backup destination.

## Detection signals to implement

All read-only. None require configuration to work, though configuration
improves them.

### 1. A `backups/` directory inside the server directory

The most common signal, and what most in-server mods use.

- Look for `backups/` (also seen: `backup/`, `world_backups/`) in the server root.
- Read entry names and mtimes. Archives are usually `.zip`, `.tar.gz` or
  timestamped directories.
- Derive: newest backup age, count, total size, and an approximate cadence from
  the gaps between the newest few.
- **Do not walk the whole tree.** A backups directory can be tens of gigabytes;
  stat the top level only.

### 2. ServerUtilities configuration

Present on GTNH and many 1.7.10/modern Forge packs.

- File: `serverutilities/serverutilities.cfg` (older layout: `config/serverutilities.cfg`).
- Keys: `enable_backups` (boolean) and `backup_timer` (hours, often a float).
- If `enable_backups` is true this server is backing itself up on a timer,
  regardless of anything else the user has set up.
- Note that the configured timer is intent, not evidence; pair it with the
  `backups/` directory contents to see whether it is actually running.

### 3. Known backup plugins and mods

- Scan `plugins/` and `mods/` filenames against a list of known backup
  providers, matched case-insensitively on a substring so version suffixes do
  not matter.
- Starting list: AromaBackup, ServerUtilities/FTBUtilities, Dynmap has none,
  and on Paper: EssentialsX has none, but look for `*backup*` in the filename as
  a catch-all with lower confidence.
- Report the match with its confidence: an exact known name is high, a
  filename containing "backup" is a guess and should be labelled as one.

### 4. A user-configured external path

- `externalBackupPaths` in the app config points at where an external script
  writes.
- Look for per-server subdirectories, read mtimes, and if a plain-text log sits
  alongside, surface its last line for that server.
- This is the only signal that can see model 1, because an external script
  leaves no trace inside the server directory at all. Without configuration the
  dashboard genuinely cannot know it exists, and should say "no backup system
  detected, if you use an external script, tell me where it writes" rather
  than "no backups".

## The feature that falls out of this

**Warn when more than one backup system is active for the same server.**

Two systems copying the same world means duplicated disk and duplicated I/O
load, and it is easy to end up in by accident: GTNH ships ServerUtilities
backups enabled, so anyone who adds an external script on top now has two
without ever making a decision about it.

Reporting rules:

- Count a system as *active* only with evidence of it running. A config flag
  alone is intent. `enable_backups: true` **plus** recent files in `backups/`
  is active; the flag with an empty directory is "configured but not observed".
- Say which two systems, where each writes, and roughly what each is costing in
  disk.
- Do not offer to disable either. Recommending which one to keep requires
  knowing which the user trusts, and this tool does not get to make that call.
- One system is the normal case and gets no warning. Zero systems is worth a
  quiet note, not an alarm. Some people genuinely accept the risk, and nagging
  about it trains people to ignore the panel.
