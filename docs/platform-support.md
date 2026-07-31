# Platform support

**Windows is the only implemented platform today.** Linux and macOS are
registered in the provider registry and refuse to start with an error naming
what is missing and where to raise it.

## Why there is a registry rather than an `if (process.platform === 'win32')`

Everything in this codebase above one interface is platform-agnostic. Discovery,
health, classification, the console tailer and the double-spawn guard all depend
on a single question:

> which JVM, if any, owns this server directory?

That is `ProcessProvider.enumerateJvms()` in `server/platform/types.ts`, and it
is the whole platform surface.

macOS is a **third path, not a Linux variant**. It has no `/proc`; process
ancestry comes from `sysctl KERN_PROC` and the working directory from
`proc_pidinfo(PROC_PIDVNODEPATHINFO)` via libproc. A two-branch `if/else` would
have made the third implementation an awkward special case, and Kubek, which
supports all three, shows this comes up in practice.

Adding a platform is one file plus one entry in `REGISTRY`. No existing code
changes.

## Implemented: Windows

`java.exe` → parent `cmd.exe`, whose command line is the launcher invocation and
therefore contains the server directory. One `Get-CimInstance` round trip for all
JVMs, not one per server.

Neither of the obvious alternatives works, and both were tried:

- **Port** is not identity (spec §1). `MC 1.21.4 - Copy` declares
  `server-port=25565`, the same as the live server.
- **The java command line** is not identity either. Both Paper servers show
  `-jar paper.jar`; both 1.20.1 Forge servers show an identical `win_args.txt`.

A JVM whose directory cannot be resolved is **omitted**, never guessed at.

### The command line is not always readable (2026-07-30)

A scheduled task with `LogonType = S4U` and a boot trigger runs in **session 0**,
and an unelevated WMI query returns an **empty `CommandLine`** for such a
process. On the first real reboot after the boot tasks were created, all four
servers became unattributable at once and a healthy machine rendered as four
`DOWN` cards.

So the provider now has a second, independent signal: **`logs/latest.log` held
open**, cross-referenced with the declared port to identify which PID it is. Both
conditions are required, so this is still not port-as-identity, of two
directories sharing a port, only the one holding its log is credited.

`logs/latest.log` rather than `world/session.lock` because 1.7.10 does not hold
`session.lock` with a deny-share handle (spec §2), confirmed again here. And the
probe runs in PowerShell rather than Node because `fs.open` on Windows always
requests shared access and therefore succeeds against a file a live JVM holds.

`JvmProcess.attributedBy` reports which signal was used. Full reasoning in spec
§14.

A Linux or macOS provider inherits the same requirement: the primary signal there
is `/proc/<pid>/cwd` or `libproc`, neither of which has this blind spot, so the
fallback is expected to be Windows-specific. It is optional in the interface for
that reason.

## Not implemented: Linux

Intended approach:

| Need | Source |
| --- | --- |
| JVM processes | `/proc/*/comm` or `/proc/*/cmdline` |
| Parent pid | field 4 of `/proc/<pid>/stat` |
| Server directory | `/proc/<pid>/cwd` symlink |

`cwd` is likely a *better* signal than the Windows one, because systemd sets
`WorkingDirectory` explicitly rather than leaving it implied by a launcher
script.

### This is testable here. It is not blocked on hardware

**WSL2 on the Windows development machine exposes a real `/proc` with genuine
Linux process semantics.** So does a Docker container. An earlier draft of the
M3 plan called the Linux path untestable on this machine; that was wrong, and it
is recorded here so future work does not inherit the mistake.

The reason it is not written yet is narrower: it would be unverified *at the time
of writing*, and process-tree identity is precisely where untested platform
assumptions have caused the worst bugs in this project. A plausible-looking
implementation nobody has run is worse than a clear "not implemented", because
an empty JVM list is indistinguishable from "no servers are running".

To do it properly: run the service under WSL2 against a Minecraft server started
by systemd inside the same distro, and regenerate `fixtures/` there.

## Not implemented: macOS

| Need | Source |
| --- | --- |
| Process list and ancestry | `sysctl KERN_PROC_ALL` |
| Working directory | `proc_pidinfo(PROC_PIDVNODEPATHINFO)`, or `lsof -p <pid> -a -d cwd` without a native module |

Untested: there is no Mac here, and unlike Linux there is no way to fake one on
this machine. It stays unimplemented until someone with the hardware can verify
it.

## Why not Docker

MinePanelProject is Docker-native, and it is a poor fit here. This tool is an
*external observer of host processes*: it enumerates JVMs, walks the process tree
for identity, reads host log files and talks to RCON. Containerising it requires
host PID namespace, host networking and a bind mount for every server directory , 
at which point the container isolates nothing while adding a layer of confusion
about which filesystem a path refers to.

Ship a plain Node service, a systemd unit and a Windows service recipe instead.
