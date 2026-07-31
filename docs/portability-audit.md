# Portability audit. 2026-07-28

This tool is for other people, whose setups will not look like the machine it
was developed on. This is an audit of what had leaked in, what was fixed, and
what is deliberately allowed to remain.

## Fixed: real defects

### 1. Hardcoded classification of specific directory names

`server/discovery.ts` shipped with:

```ts
const OVERRIDES: Record<string, Classification> = {
  'MC Tech': 'retired',
  'MC 1.21.4 - Copy': 'stale',
}
```

The worst of the three. For anyone else this is not merely useless, it is
wrong: their directories would never be classified, and a user who happened to
name a directory `MC Tech` would find it silently marked retired and dropped out
of the live list.

**Fixed** by splitting the three cases by whether they are actually inferable:

| Class | How it is now decided |
| --- | --- |
| `not-a-server` | No `level.dat`. Structural, always inferable. |
| `stale` | Declares a game port that a *sibling directory with a live process* also declares, while having no process itself. Inferable, that is exactly how a "- Copy" presents. |
| `retired` | Operator config only. Not inferable: it is a statement about intent, and a directory archived an hour ago is byte-for-byte indistinguishable from one in daily use. |
| `live` | The default, so an unfamiliar install is treated as a working server rather than quietly hidden. |

Verified on the development machine: `MC 1.21.4 - Copy` is now detected as
`stale` with no name matching at all, and `MC Tech` is `retired` only because
this operator's own config says so.

### 2. Hardcoded servers root

`const SERVERS_ROOT = join(homedir(), 'Documents', 'MC Servers')`

**Fixed**: `server/config.ts` resolves, first hit wins:

1. `MCDASH_SERVERS_ROOT` environment variable
2. `serversRoot` in `<userData>/config.json`
3. `Documents/MC Servers` as a starting guess

The third is a default, not an assumption. `serversRootExists` is carried in the
config so the UI can say "that path does not exist" instead of showing an empty
list as though the user had no servers.

### 3. ISP-specific branding in user-facing copy

`src/Addresses.tsx` told every user that "The Livebox does not reliably loop
connections back", which is a French ISP's router brand.

**Fixed**, now explains NAT hairpinning generically and notes that support
varies by model.

## Deliberately kept: provenance in comments

Comments citing specific servers are kept, and should be:

```ts
// MC 1.21.11 returns "§6There are §c0§6 out of maximum §c30§6 players online."
// PORT IS NOT IDENTITY. "MC 1.21.4 - Copy" declares server-port=25565 ...
```

These record *why a rule exists* and name the observation that produced it.
Deleting them would leave a pile of defensive code with no explanation, and the
next person to read it would "simplify" it straight back into the bug. They
describe evidence, not configuration. No behaviour depends on them.

## Deliberately kept: test tooling that targets this machine

`fixtures/` and `scripts/prove-*.ts` reference real paths, `mcbackup.py` and a
specific JDK. That is correct: they are proofs run against one real machine, and
a fixture that pointed at nothing would prove nothing. They are not shipped code
and are not on any path the app executes.

`fixtures/generate.py` regenerates them for a different machine. What is *not*
portable is the assertion set inside them, which is the point, someone else
should regenerate against their own servers.

## Still outstanding

- **No UI to edit the config.** `config.json` has to be written by hand, and a
  missing servers root is reported but not fixable in-app. Needs a settings
  screen in a later milestone.

## Resolved 2026-07-30: the start window is measured, not keyed by platform

Previously outstanding: *"`START_GRACE_SECONDS` is keyed by platform, not
measured. 420s for 1.7.10 came from GTNH's 100s cold boot with headroom. A much
larger pack on slower disks could exceed it and be called `HUNG` while still
starting."*

`server/boottime.ts` measures each server's own boot, process start to a status
ping answering with a real version, keeps a rolling window of ten, and persists
them to `<dataDir>/boot-times.json`. The window is `max(observed) × 2`, floored
at 60 s and ceilinged at 1800 s. The platform constants remain as the fallback
for a server that has never been watched booting, so a fresh install behaves
exactly as it did before: `prove-boottime` asserts that against the real fleet.

Two portability consequences worth naming:

- **The failure mode this was raised for is gone in the right direction.** A pack
  slower than its platform constant widens its own window off a single observed
  boot; only *shortening* below the constant requires five, because widening can
  only delay a verdict while shortening can invent a false one.
- **The measurement is per directory name**, the same key as the backup policy
  and `classificationOverrides`, so nothing about it is specific to this machine's
  servers. A different install measures its own.

See `docs/liveness-spec.md` §16, which also records what was deliberately *not*
done and the one case the mechanism still gets wrong.

## Resolved 2026-07-29: Windows-only is now explicit, not implicit

Previously listed as outstanding: *"`enumerateJvms` shells out to PowerShell …
needs a POSIX path before this runs anywhere else."*

The code is still Windows-only, but the *shape* of the problem changed. Process
inspection now sits behind a provider registry (`server/platform/`), with Linux
and macOS registered and reporting `available: false`. Three consequences:

1. Starting on an unsupported platform prints what is not implemented and where
   to raise it, then exits 2, rather than starting up and reporting zero
   servers, which is indistinguishable from "you have no servers".
2. `AppInfo` carries `platform` and `platformSupported`, so the UI can say so.
3. Adding a platform is one new file and one registry entry.

See [platform-support.md](platform-support.md), which also records that the
Linux path **is** testable on this machine via WSL2. An earlier claim that it
was not was wrong.

## Deliberately kept: `dataDir()` matches Electron's old location

`server/config.ts` resolves the data directory to `%APPDATA%/…`,
`~/Library/Application Support/…` or `$XDG_CONFIG_HOME/…`. On Windows that is
the exact path `app.getPath('userData')` returned, so an existing `config.json`
keeps working across the web pivot instead of being silently ignored, which
would have presented as "no servers found", i.e. as a discovery bug.
