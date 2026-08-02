# Instructions for Claude

**Before doing anything else, read `HANDOFF.md` at the repo root.** It is
gitignored, so it will not appear in searches or diffs, but it is the
project's working state: what is true right now, what is open, and the traps
that have already cost real debugging time. Nothing below replaces it.

## Standing rules

- **Proofs are reserved for real harm**: data loss, a false healthy reading,
  or a credential leak. Design tweaks get made, not proven.
- **Never delete anything.** Not files, not folders, not archives. Retire,
  exclude, disable, back up next to the original. Explicit per-item approval
  is the only exception.
- **No em dashes anywhere**: code, docs, UI copy, prose.
- **UI copy names the code that makes it true.** A claim of detection,
  measurement, verification, protection, scheduling or application with no
  code behind it does not ship.
- **End every reply naming anything asked for that was not done, and why.**
  Silent partial delivery is the failure, not the omission itself.

## Milestone-finish checklist

1. Run the proof suites.
2. Sweep every new or changed UI sentence against the code behind it.
3. Update `HANDOFF.md`.
4. Push.
