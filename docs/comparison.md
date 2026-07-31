# How other panels handle an existing server

Researched 2026-08-01. This exists so the README can make a short claim and a
reader can check it. Where something could not be verified from primary
documentation, it says so rather than guessing.

The claim being supported: **no comparable panel manages a Minecraft server
directory in place. They copy it, or they create their own and make you move
into it.**

| Panel | Adopts a directory you already have? | What actually happens |
| --- | --- | --- |
| **Pterodactyl** | **No** | Wings owns `/var/lib/pterodactyl/volumes`; every server is a UUID-named volume it creates and bind-mounts into a fresh container. No panel feature, CLI command or config option registers an existing directory. |
| **AMP** | **No**, natively | Documented path: zip your server, create a *new* instance, upload the zip into it, extract, set the startup jar. "Import Configuration" only ingests `server.properties` values into AMP's UI. |
| **Crafty Controller** | **Partly** | Imports a **zip**, then **copies** the files into its own managed directory. You hand-write the start command from your own `.bat`. |
| **PocketMC** | **Claims yes**, undocumented | v1.9.6 changelog lists "Import Existing Server Folders". Whether it manages in place or copies is not documented anywhere. |

## Detail and sources

**Pterodactyl.** The daemon's data root is documented as "the location on the
physical server where the daemon is to store the files the servers generate",
and servers are created by an *egg* whose install script downloads the server
software fresh into a new container. A feature request to import an existing
data directory ([panel#4943], opened 2023-12-06) was closed without being
implemented. The only third-party "importers" pull files over FTP/SFTP into a
newly created server, which is still copying. Pterodactyl is in maintenance
mode as of 2026; new development moved to Pelican, whose own comparison page
does not claim import-existing-server either.

- <https://pterodactyl.io/wings/1.0/installing.html>
- <https://github.com/pterodactyl/panel/issues/4943>
- <https://pelican.dev/docs/comparison/>

**AMP.** The official knowledge-base article "How to import an existing
Minecraft server into AMP" (2022-09-02) prescribes: zip the server, create a
new Minecraft instance, upload the zip into that instance's `Minecraft`
directory, extract it in place, then right-click the jar and "Set as startup
jar". Two in-place workarounds are mentioned (editing `MinecraftModule.kvp`
to repoint `ServerPath`, or symlinking) and both are manual and effectively
unsupported. AMP is also paid, with no free tier.

- <https://discourse.cubecoders.com/t/how-to-import-an-existing-minecraft-server-into-amp/1822>

**Crafty Controller.** Documents two import flows, both zip-based: upload a
zip through the panel, or drop a zip in an import folder. The configuration
docs state that "when you create or import a server, Crafty automatically
stores the server data in an internal managed directory". GitLab issue #519
records a user who ran out of disk importing roughly a 60 GB server, because
the extracted copy and the final copy existed at the same time; the proposed
fix is to move instead of copy. The import form also requires you to supply
the server execution command yourself.

- <https://docs.craftycontrol.com/pages/getting-started/config/>
- <https://gitlab.com/crafty-controller/crafty-4/-/issues/519>

**PocketMC.** A young, active Windows desktop manager (MIT, ~22 stars as of
2026-08-01). Its v1.9.6 release notes (2026-07-17) list "Import Existing
Server Folders" as a feature, and a v1.9.5.2 beta note mentions "importing
modpacks or existing server directories". The README documents only its own
export/import archive format and custom world import. **Could not verify**
whether it manages the folder in place or copies it, nor whether it detects
running servers.

- <https://github.com/PocketMC/pocket-mc-windows/releases>

## Two things worth stealing rather than criticising

- **Crafty's first-run credentials.** It moved from a static `admin`/`crafty`
  default to a per-install random password written to a file, after real
  takeovers of exposed panels. This project generates a password on first
  start and prints it once, which is the same lesson learned without the
  incident.
- **The portable-zip install.** Crafty's *recommended* Windows path is
  "extract and run", with no installer at all, and PocketMC ships a 37 MB
  portable zip alongside its installer. A zip with a bundled Node runtime is
  the norm for this category rather than a compromise.

## What this project does not claim

It does not create servers, download jars, or manage versions: those are the
things the panels above are built for, and three of them do it well. It also
watches only the machine it runs on. The trade is deliberate, and the
[README](../README.md) states it.

[panel#4943]: https://github.com/pterodactyl/panel/issues/4943
