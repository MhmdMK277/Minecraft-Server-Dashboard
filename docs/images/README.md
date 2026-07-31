# Screenshots

Recaptured 2026-07-31, after the M3.7 redesign. Each `alt` attribute in the root
README describes what the shot contains; this file records where each one came
from, because "real" and "rendered" are different claims and a reader should not
have to guess which.

| File | Source | Notes |
| --- | --- | --- |
| `logo.png` | drawn | A server rack as a Minecraft block. `scratchpad/logo.html` in the session that made it; regenerate with headless Chrome `--screenshot`. Also the mark in the app header. |
| `servers-healthy.png` | **live** | Four real servers, all healthy. Two had just been restarted through the app's own start route, which is why their boot samples are fresh. |
| `console.png` | **live** | MC 1.21.11's real log with the search filter active, so the pane shows something other than the dashboard's own RCON polling. RCON listener port replaced with `[redacted]`. |
| `addresses.png` | **live** | Real address table. Public IP replaced with `203.0.113.47` (RFC 5737 documentation range). |
| `server-detail.png` | **live** | The per-server view. Directory path masked to `C:\Users\<user>\`. |
| `servers-stalled.png` | rendered | `npm run preview-states`, "One server, healthy host". |
| `host-wide-event.png` | rendered | `npm run preview-states`, "A host-wide event". |
| `unknown-explained.png` | rendered | `npm run preview-states`, "A persistent UNKNOWN". |

## Why three of them are rendered

A stall, a host-wide event and a twelve-minute `UNKNOWN` cannot be produced on
demand. The honest options were to wait for the host to misbehave, to break a
real server in order to photograph it, or to render the states from the real
components with synthetic data and say so. The third is what `preview-states`
exists for, and its output carries a banner across the top saying nothing on the
page is a reading about a real server.

**Leave that banner in the shot.** Two of the three rendered captures in the
previous set were cropped above it. It is pinned during capture now so it cannot
scroll out of frame.

## Redaction

Applied before the capture and **re-verified after it**, because a snapshot
arrives over the WebSocket every ten seconds and a check that only ran
beforehand proves nothing about what ended up in the image.

Redact:

- **Public IP**, to `203.0.113.47`.
- **RCON listener ports**, wherever a log line announces one.
- **Other players' names.** See the warning below.
- **The Windows username in any absolute path.** Added 2026-07-31: the detail
  view's Identity panel prints the server's directory, which contains it.

Deliberately not redacted: `192.168.x` LAN addresses and game ports. They are
RFC 1918 and standard, they are what a reader's own install looks like, and
blanking them makes the address table meaningless, which is the one view whose
whole point is showing the independent ways a connection can fail.

### Player names live in the log HISTORY, not just the player list

The obvious mask is "whoever is online now", and it is not enough. A console
buffer holds thousands of lines, and `X joined the game` from two hours ago is
still sitting in it when nobody is online at all. On this host that was three
names in one server's buffer while the current player list was empty.

Harvest names from the buffers themselves (`logged in`, `joined the game`,
`left the game`, `UUID of player`) rather than from `players[]`.

The server already masks player **IPs** before a line leaves the process, so
those arrive as `51.39.x.x`. Names are deliberately not masked there, because an
operator needs to read them. That makes them a capture-time concern.

## Recapturing

The browser does **not** have to run on the dashboard host. These were taken from
a second PC over the LAN with the service started as
`MCDASH_HOST=0.0.0.0 npm start`. If you capture from a different machine, be
aware that `localhost` in that browser is *that* machine. See the troubleshooting
table in the root README, which exists because of exactly this mistake.

Two things that will bite you:

- **A redaction observer has to be throttled.** Re-applying the mask on every DOM
  mutation froze the renderer on the console view, which is virtualised and
  mutates on every scroll frame. Debounce it, or apply the mask immediately
  before each capture and verify immediately after.
- **The console follows its own tail.** Setting `scrollTop` does not survive the
  next batch of lines. Use the search filter to decide what is on screen.

## Which server to photograph

`MC GTNH` runs `online-mode=false` deliberately, so its console prints four
`SERVER IS RUNNING IN OFFLINE/INSECURE MODE` warnings at every boot, and its
buffer is the one holding player names. It is a poor choice for a published
console shot on both counts. The Paper servers boot clean.
