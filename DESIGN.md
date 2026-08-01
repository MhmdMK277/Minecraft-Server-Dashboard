# Design

Approved by the operator 2026-07-31 (with the two-surface amendment below).
This is the binding direction contract for redesign v2; per the impeccable
flow it is refined against the built result at finish, never contradicted
by it.

## Form

The railway operations board: candidate 5 of the seven-candidate derivation
(control-room HMI, mission control, aviation caution panels, broadcast
master control, railway boards, Minecraft vernacular, rack-room faceplates),
assigned by the concept roll, seed key `0d83d6ea`, mode `operate`. The
dealt challengers (one-bit desktop, teletext, WPA poster) were weighed and
lost on product truth: each destroys or monopolizes the colour channel the
status semantics require.

## Thesis

A railway operations board for a server fleet. Departure boards solve this
product's exact problem: dozens of independent lines, read in half a second,
where calm is typographic and any colour is an event. The category default
this refuses: the dark "gamer admin" dashboard of floating rounded cards,
glowing accents and icon chips on a void.

## Own world

- **Board, not cards.** One near-black board surface (`#070a10` family kept)
  with content organized as full-width rows and sections separated by
  hairline rules and rule-weight changes, not by floating boxes with
  drop shadows. Panels exist only where a region genuinely is a separate
  instrument (the console pane, the command bar). Radii shrink; elevation
  almost disappears.
- **The signalling lamp system is the existing status language, unchanged**:
  solid / ring / dashed forms, colourless healthy, ok/warn/bad with the
  measured greyscale separation, size carries attention, rails at row scale.
  It stops being decoration on cards and becomes the leftmost column of the
  board.
- **Type does the work.** Geist Mono is promoted to the display voice for
  every figure, ID and label (tabular, uppercase 10px section labels with
  wide tracking, large tabular figures for lead metrics); Geist Sans remains
  the prose voice for the sentences that ARE the product (host verdict,
  attribution, consequences). Two voices, strict roles, no third.
- **Colour strategy: Restrained**, one interactive accent (the transit
  information blue, `#2563eb` family) for actions, active nav and focus
  only. Amber and red keep signalling discipline: they may appear only when
  a state earns them. Dark is forced by the physical scene: a glanceable
  monitor for a headless host, often read across a room.
- **Motion: news only**, as today. The one state-change flash renders as a
  board row updating; nothing else moves on a timer except the live tick.

## Two surface classes (operator amendment, 2026-07-31)

The board metaphor governs the **monitoring surfaces**: the fleet board, the
per-server Overview, both consoles, and status rendering everywhere. The
**management surfaces** (Players, Settings, and later Worlds, MOTD, File
Manager) are ordinary forms and tables executed inside the board's visual
language: same two type voices, same hairline rules, same accent monopoly,
same near-black board, but form controls are never forced into a board
metaphor. **Usability wins every conflict between the metaphor and a
management task.**

## Story

At a glance the operator reads one sentence about the machine and a column
of quiet lamps. Anything coloured is the thing to look at. Clicking a row
enters that server's own panel: same board grammar, per-server navigation
(Overview, Players, Console, Backups, Settings), actions named in plain
language before they fire.

## First viewport (fleet)

Sidebar: brand block (glyph tile, name, version), views, one row per live
server with its lamp; account at the bottom. Board: the host verdict as the
masthead row (sentence first, four figures right), then the fleet as
full-width server rows: lamp, name, verdict, lead figures (players, TPS,
RCON, pause, resident, uptime) in tabular columns, meta strip beneath.
Primary action on any row is entering the server; destructive controls
live inside, never on the board.

## Layout laws (acceptance criteria, testable)

1. No stat label ever truncates. Grids reduce column count before any label
   ellipsizes; the sidebar has a minimum width; verified at realistic
   viewport widths against all four real servers, including the modded one
   with long names.
2. No explanation paragraph collapses to a words-per-line column; prose
   keeps a readable measure at every breakpoint.
3. Minecraft `§` formatting codes render as their actual colours and styles
   in RCON replies and both consoles; unmappable codes are stripped, never
   shown raw.
4. The craft bans hold: no gradients (the dashed rail pattern is exempt as
   a functional pattern), no glow, no `transition: all`, no decorative icon
   chips beside headings.
5. Every interactive element keeps a visible focus state; keyboard paths
   survive the restyle.
6. **The RAM metric** (operator rule, 2026-07-31): label "RAM", value reads
   used / allocated in matching units chosen from the allocated side.
   Integer MB below 1000, one-decimal GB at or above ("0.6 / 8 GB", never
   "1100 MB"). Allocated is -Xmx parsed from the captured java command
   line; when unreadable (boot-started, session 0) committed memory stands
   in and the secondary line says so. The resident-vs-committed honesty
   lives on the secondary line and hover, unchanged in substance. Applies
   on fleet rows and Overview.
7. **Content never dictates column width** (operator amendment, 2026-07-31,
   root cause of every observed squeeze). Columns get their widths from the
   layout: every fr track is `minmax(0, fr)` or its children are `min-w-0`.
   Console and log panes get a capped width inside their column, and long
   log lines wrap or scroll horizontally within the pane, never resizing
   it. The left column of any two-column page has a guaranteed minimum
   width. Verified specifically on GTNH and Skyblock, whose log lines are
   the longest, on the per-server pages and the fleet console.

## What survives any refinement

Product truth and the honest-status semantics (PRODUCT.md, Brand
Commitments); the arm/confirm inline pattern; empty states that explain
themselves; tabular numerals on every figure; the accent's monopoly on
interactivity and the state colours' monopoly on meaning.

## Boundaries (operator decisions, 2026-08-01)

These sit next to the never-own rule because they are the same kind of rule:
things this product will not do, stated as a boundary rather than apologised
for as a missing feature.

- **The router is read-only. Always.** The dashboard reads the network and
  never configures it. **No UPnP**, not to open a port and not to close one
  we opened. UPnP exists to let any process on a LAN punch a hole in the
  firewall without anyone being asked, which is a security hole wearing a
  convenience label. A tunnel is the supported answer for reaching a server
  from outside, and a tunnel needs nothing from the router.
- **Public access is never a side effect.** Exposing a world to the internet
  is a security decision, so it is armed by its own confirmation naming the
  server and what becomes reachable, per server, admin only, audited, and
  revocable from the same place. It is never a consequence of pressing
  Start, and never a silent fallback when something else fails.
- **A credential is minted by the party who owns it.** For any tunnel
  provider, the operator authenticates to that provider directly and the
  credential is issued to them. If a provider only supports third-party
  provisioning through an intermediary, we do not integrate it, and the
  reason is stated publicly rather than left as a gap.
- **We refuse what we cannot verify, out loud.** Server creation offers only
  sources that publish a checksum with the download. The refusal is shown in
  the UI with its reason, as a standard being kept, not an apology.
- **A folder we created from nothing is ours until creation completes.**
  Server creation writes the folder, the jar, `eula.txt`, `server.properties`
  and `start.bat`. The moment creation completes the folder is the
  operator's and the ordinary never-write rules resume: nothing is written
  into it again except through an audited setting the operator changed.

## The claim rule (standing finish discipline, 2026-08-01)

Part of finishing every milestone, permanent, prompted by audit finding F6
(a Backups page that said "detected" when no detection code existed) and by
the sweep that followed it, which found two more sentences the code had
outgrown.

- **UI copy is a claim.** Any new or changed sentence the interface shows
  must name the code that makes it true, in the review that ships it.
- **Six words carry the burden of proof:** a claim that something is
  *detected, measured, verified, protected, scheduled* or *applied* with no
  code behind it does not ship. State the mechanism instead, or say
  nothing.
- **The failure mode this exists to catch:** a sentence written when a
  feature was planned, left standing after the feature changed shape. The
  sweep is re-run over touched surfaces at every milestone finish, not once.

## Deferred indefinitely, with the reason (2026-08-01)

- **Plugin and mod management.** It means downloading third-party code into
  a server folder, which is the opposite of what this tool is for. Every
  other write this product makes is a value in a file the operator asked to
  change; this would be executable code fetched from a marketplace, landing
  in a directory we promise not to touch. Deferred indefinitely, not
  forgotten, and it does not become acceptable because a competitor has it.
