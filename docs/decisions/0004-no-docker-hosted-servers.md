# 0004. Docker-hosted servers are out of scope

**Status:** accepted
**Date:** 2026-08-01

## Decision

The dashboard does not support Minecraft servers running inside Docker
containers. It does not detect them, does not manage them, and does not grow
heuristics to guess at them. This is a boundary, not a backlog item.

## Why

Two independent reasons, either one sufficient on its own.

**1. On Windows, Docker means a VM.** Docker Desktop requires WSL2 or
Hyper-V; the containers run inside a Linux virtual machine, not on the host.
This project targets plain Windows hosts where servers start at boot from
Task Scheduler, which is the fleet it was built against and the fleet it is
proven against.

**2. The identification model cannot reach inside a container, and
identification is the whole product.** Every signal this dashboard uses to
say "this JVM is that server" is a host signal:

- the process tree, walked to find scheduled-task lineage;
- the working directory and open file handles of a host JVM;
- the server's own files read in place: `server.properties`, `level.dat`,
  a held `logs/latest.log`;
- what is listening on which host port.

A containerized server offers none of these. Its JVM is a pid inside a
namespace inside a VM; the host process list shows only Docker's own
backend. Its files live in a container filesystem or a volume, not at a path
the dashboard can stat. Its log is inside the container. What the host does
see, at most, is a proxied port, and port is deliberately never identity
here (liveness spec section 1). The one channel that would survive is RCON,
and an RCON-only view is a different product: a remote console, not an
attach-model observer that can tell you which directory, which world and
which process it is talking about.

## What this means

- A containerized server may still answer SLP on a published port. The
  dashboard will not attribute it, and must not pretend to: an unattributable
  listener stays exactly that, reported honestly if at all.
- No container-detection heuristics, no Docker socket integration, no special
  casing. Anyone running servers in containers is better served by the panels
  built for that model (Pterodactyl, PufferPanel, Crafty in its container
  mode), which own the container lifecycle and therefore can see inside it.
- Recommendation threads that suggest "just add Docker support" are answered
  by this document rather than re-litigated.
