# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One operator: a technically capable self-hoster who runs several Minecraft
servers for friends on a single Windows machine that sits headless in another
room. They check the dashboard in two modes: a glance (often from another PC,
sometimes mid-task) to answer "is anything wrong, and can my friends
connect?", and a focused session to diagnose one server or change a setting.
Secondary audience: the friends themselves as read-only viewers, allowed to
see whether a server is up without being able to touch anything.

## Product Purpose

A self-hosted dashboard that observes and controls Minecraft servers it did
not start. It exists because in-process panels report health from the thread
they are measuring, so a frozen server keeps showing 20 TPS and a green
light. Success means the operator finds out about a problem from the
dashboard before a player does, and the dashboard never claims more than it
measured.

## Positioning

The attach model is the mechanism no wrapper panel can copy: it tails logs,
probes SLP and RCON from outside, and resolves which JVM owns which directory
from the process tree, so it works with servers started at boot by Task
Scheduler. Two probes make a frozen-but-pinging server (`STALLED`) visible,
and reading the whole fleet at once lets it say "the problem is the machine,
not the servers" in one sentence. Its second differentiator is honesty as a
feature: doubt renders as doubt (`UNKNOWN` explains itself), never as an
accusation or a reassurance.

## Operating Context

Four live servers today (two Paper, one Forge 1.20.1, one heavily modded
1.7.10 pack), started at boot, backed up nightly at 05:00 by an external
script the dashboard deliberately does not own. The UI is reached over the
LAN from a second PC. Sessions are long-lived; the screen is glanced at more
often than it is read. The fleet view doubles as a wall monitor.

## Capabilities and Constraints

- Six-state health (`HEALTHY` / `STALLED` / `STARTING` / `HUNG` / `DOWN` /
  `UNKNOWN`), host-vs-server fault attribution, GC pause reading, measured
  per-server boot windows, live consoles, connection addresses, start / stop
  / restart, RCON command input, a two-key `server.properties` write path,
  per-server backup opt-in. Admin and viewer roles, audited actions.
- Credentials never cross the wire; the API contract has no field for them.
- The app detects backup systems and schedules; it does not implement them.
- Nothing is ever deleted on the operator's behalf.
- Any write into a server directory is proof-guarded: the failure class is a
  corrupted world.
- Windows-only today, by honest limitation rather than assumption.

## Brand Commitments

- Name: Minecraft Server Dashboard. Mark: the existing block logo
  (`docs/images/logo.png`).
- The honest-status language IS the identity and survives any redesign:
  healthy renders colourless; form (solid / ring / dashed) carries
  measurement confidence; size carries attention; motion is spent only on
  genuine state change; ratios only where an honest denominator exists.
- Plain-English explanations are product surface, not chrome: the host
  sentence, attribution notes, and consequence warnings stay prose, and stay
  readable.
- No em dashes in any copy.

## Evidence on Hand

A real four-server fleet with measured numbers (16 s vs 79 s boot windows,
GC pause tables, a proven STALLED demonstration), a proof suite that runs
against the live machine, and redacted screenshots in `docs/images/`. No
testimonials, no customers, no benchmarks beyond these measurements; none
may be invented.

## Product Principles

1. Never claim more than was measured; say who a fault belongs to, or say
   that no one can tell yet.
2. Colour means attention. A calm fleet is a colourless fleet.
3. The dashboard adapts to the servers (measured windows, detected
   launchers, discovered worlds), never the reverse.
4. Destructive actions name their consequence before the click, in plain
   language, inline.
5. It attaches; it never wraps, guesses a command line, or invents a
   denominator.
