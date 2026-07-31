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
