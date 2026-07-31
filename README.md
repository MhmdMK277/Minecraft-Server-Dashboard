<div align="center">

<img src="docs/images/logo.png" alt="Project logo: a server-rack glyph fused with a Minecraft grass block" width="110">

# Minecraft Server Dashboard

**A self-hosted dashboard for Minecraft servers it did not start.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)](docs/platform-support.md)

</div>

---

Every in-game panel reports health from a scheduled task on the server's **main
thread**. When that thread wedges, the task stops too, and the panel keeps
showing the last numbers it collected: a server frozen for two minutes still
reads 20.0 TPS and a green light. The component that would notice is the
component that stopped.

This dashboard watches from **outside the process**, so it cannot be frozen by
the thing it is measuring. It compares two independent probes:

| Probe | Answered by | Proves |
| --- | --- | --- |
| Server List Ping | the network thread, from a cached status | the port is open. Nothing more |
| RCON round trip | the main game thread, which must execute it | the game loop is actually running |

A server answering pings in 8 ms while RCON times out is neither healthy nor
down. It is **`STALLED`**, a state no in-process panel can report about itself.
And because it reads the whole fleet at once, it can say the other thing no
per-server tool can: **four servers degrading at the same moment is one machine
problem, not four server faults**, in one sentence at the top of the page.

It also **attaches instead of wrapping**. Crafty, MCSManager, PufferPanel and
Pterodactyl all spawn the server as a child and own its stdin. This one tails
`logs/latest.log`, sends RCON, and resolves which JVM owns which directory from
the process tree, so it works with servers that started at boot from Task
Scheduler, long before any UI existed.

## Screenshots

<table>
<tr>
<td width="50%">
<img src="docs/images/servers-healthy.png" alt="Fleet view, four healthy servers, host panel reading Keeping up">

**A healthy fleet is deliberately colourless.** Green survives only as a small
dot, so any colour on this page means something wants attention. Boot times are
measured per server: 16 s for Paper, 79 s for the 1.7.10 modpack.
</td>
<td width="50%">
<img src="docs/images/servers-stalled.png" alt="One card marked STALLED, tagged this server, others healthy">

**A stalled server.** Answering pings, not answering RCON. The card names which
thread is silent and tags the fault **this server**, because the host panel
says the machine is fine. *Rendered state, see note.*
</td>
</tr>
<tr>
<td width="50%">
<img src="docs/images/host-wide-event.png" alt="Host panel: the problem is the machine, not the servers; cards stepped down to amber">

**A host-wide event.** All four degraded at once while the observer itself was
starved: one sentence about the machine, and the cards step *down* from red,
tagged **the host, not this server**. *Rendered state, see note.*
</td>
<td width="50%">
<img src="docs/images/unknown-explained.png" alt="A card with a dashed rail and dot, explaining a persistent UNKNOWN">

**`UNKNOWN`, explained.** Dashed dot, dashed rail: a claim about the
measurement, not the server. The card says how long it has held and that the
server has not been accused of anything. *Rendered state, see note.*
</td>
</tr>
<tr>
<td width="50%">
<img src="docs/images/server-detail.png" alt="Per-server detail view: controls, RCON box, GC pauses, identity, live tail">

**One server, in full.** Controls, the JVM's own stop-the-world pauses, the
measured start window, identity, a live tail. The RCON box lives here and
names its target twice, so `stop` cannot be aimed at the wrong server.
</td>
<td width="50%">
<img src="docs/images/console.png" alt="Console view: tabs per server, search, virtualised log pane">

**Live console.** One tab per server, tailed from disk, rotation-aware,
searchable, and filtered of the dashboard's own RCON polling by default, so an
idle server's console is not the tool talking to itself.
</td>
</tr>
</table>

> The healthy fleet, console and detail shots are real, captured over the LAN
> from a second PC; the public IP is a placeholder. The three marked *rendered
> state* cannot be requested from a live fleet on demand, so they come from
> `npm run preview-states`, which renders the real components from synthetic
> snapshots and says so in a banner that is left in frame.

## Features

- **Six-state health**: `HEALTHY` / `STALLED` / `STARTING` / `HUNG` / `DOWN` /
  `UNKNOWN`. Up and working are different questions, and no usable reading is
  reported as doubt, never as an accusation.
- **Fault attribution**: the dashboard measures its own event-loop lag as a
  host metric, splits it into "our fault" and "the machine's", and reads the
  fleet together to say whose problem a bad minute actually is.
- **Pauses the scan cannot see**: stop-the-world pauses parsed from each JVM's
  `-Xlog:gc*,safepoint` log, so a server that freezes for 1.6 s between two
  healthy probes stops reading green.
- **Discovery, not configuration**: point it at a directory; servers are found
  and classified as live, retired, stale or not-a-server on every scan.
  Identity comes from the process tree, never from a port.
- **Control through the mechanism the server already has**: start uses the
  server's own scheduled task or script; stop is RCON `stop` with a world
  flush, never a kill. No identifiable launcher, no start button, with the
  reason on the card. Double-spawns are detected and alarmed, and honestly
  documented as not preventable by an attached observer.
- **Measured start windows**: how long a server may be silent before `HUNG` is
  learned from its own boots. 16 s Paper and 79 s modpack are not one constant.
- **Live console** that survives rotation and restart, with the dashboard's
  own RCON polling filtered out by default and a toggle to bring it back.
- **Connection addresses**: LAN, public IP with change detection, and Dynmap
  links that distinguish configured from actually responding.
- **Auth that ends**: scrypt, admin and viewer roles, sessions with absolute
  and idle expiry, an append-only audit log, and a wire contract with no
  credential field in it, asserted by proof.
- **Proofs, not claims**: every hard-won rule ships with a script that
  reproduces the failure it prevents, run against real servers.

## Quick start

Requirements: **Windows 10/11**, **Node 22+**, Minecraft servers already
installed, and `enable-rcon=true` on each server you want full health for
(without RCON the main thread cannot be probed, and health honestly reads
`UNKNOWN`).

```bash
git clone https://github.com/MhmdMK277/Minecraft-Server-Dashboard.git
cd Minecraft-Server-Dashboard
npm install
npm run build
npm start
```

Open <http://127.0.0.1:8422>. On first start an `admin` password is printed to
the terminal once (only its hash reaches disk); you change it before the
dashboard loads.

To reach it from other machines on your network, the normal setup for a
headless host:

```bash
set MCDASH_HOST=0.0.0.0
npm start
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCDASH_SERVERS_ROOT` | `Documents\MC Servers` | Directory containing your servers |
| `MCDASH_HOST` | `127.0.0.1` | Bind address; anything wider warns at startup |
| `MCDASH_PORT` | `8422` | HTTP and WebSocket, one port |
| `MCDASH_DATA_DIR` | OS app-data directory | Config, sessions, audit log |
| `MCDASH_TRUST_PROXY` | off | Set to `1` behind a reverse proxy or tunnel |

> **Do not port-forward this panel.** It is plain HTTP holding RCON
> credentials server-side. For remote access use a tunnel (Tailscale,
> Cloudflare Tunnel) and `MCDASH_TRUST_PROXY=1`.

## Verifying it

Every rule that cost real debugging has a script that reproduces the failure
it prevents, from `prove-stall` (suspend a live server's main thread, assert
`STALLED` is reported while pings keep answering) to `prove-concurrent-start`
(the double-spawn guard, written before the guard was trusted). Run
`npm run crossvalidate` first; the full list and the evidence behind each rule
are in [docs/liveness-spec.md](docs/liveness-spec.md) and
[docs/proof-coverage.md](docs/proof-coverage.md).

## Troubleshooting

| Symptom | What it means |
| --- | --- |
| `EADDRINUSE` on start | An earlier instance still holds the port, and it will answer probes while the new one refuses to start. Kill the old `node` by command line, by PID. |
| "That servers directory does not exist" | `MCDASH_SERVERS_ROOT` is unset and the default is not where your servers are. Reported instead of shown as an empty list, because no servers and wrong path look identical otherwise. |
| A server shows `UNKNOWN` forever | The card says which cause: RCON not configured (permanent until you edit `server.properties`), or the host too loaded to measure through (named, with how long it has held). |
| A running server shows `DOWN` | Identity failed. Run `npm run probe` and read the attribution counts; zero across the board means processes could not be enumerated at all, which is not the same as nothing running. |
| Cannot reach it from another machine | It binds `127.0.0.1` unless told otherwise, and `localhost` is whichever computer is asking. Bind `0.0.0.0` and use the host's LAN address. |

## Stack

Node 22 + TypeScript strict, Fastify 5 with one listener for REST, WebSocket
and the built UI, React 19 + Vite + Tailwind 4 with shadcn/ui, zod as the one
contract shared by server and browser. No database: state is a scan, and the
servers are the source of truth. Sessions and passwords are scrypt-hashed and
stored in the per-user data directory; credentials from server directories
never cross the wire, asserted by `npm run prove-websocket`.

## Contributing

Read [docs/liveness-spec.md](docs/liveness-spec.md) before touching discovery,
parsing or health: nearly every odd-looking guard exists because something
real broke, and the comments name the observation. Behaviour changes that can
destroy data or misreport state need a proof script. Nothing may hardcode a
machine, path, router or server name. Never log, render or commit a
credential.

## License

[MIT](LICENSE)
