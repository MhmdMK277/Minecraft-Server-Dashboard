import { join } from 'node:path'
import type { Classification, ServerStatus, Snapshot, IgnoredDirectory, TpsInfo } from '@shared/api'
import {
  listDirectories,
  levelDatPath,
  detectKind,
  gamePortOf,
  worldDirs,
  serverProps,
  rconConfig,
} from './properties'
import { readSettings } from './serversettings'
import { beginProbe } from './rconledger'
import { scanJvms, jvmForDir, type DirHint, type JvmProcess } from './platform'
import { slpPing } from './slp'
import { Rcon } from './rcon'
import { assessHealth, RCON_TIMEOUT_MS } from './health'
import { parsePlayerNames, parsePlayerCount, parseTps, tpsCommandFor } from './parse'
import { lanAddress, publicIp, dynmapPort, portResponds } from './network'
import { observerBlockedMs, loopLag } from './loopguard'
import { gcSummary } from './gclog'
import { observeFleet } from './hostwatch'
import { loadPolicy, isBackupEnabled, type BackupPolicy } from './backuppolicy'
import { primeHistory, timingFor, observe as observeBoot, flush as flushBootTimes } from './boottime'
import { dataDir } from './config'
import { detectLauncher, indexTasks, type TaskIndex } from './launcher'
import { isBusy, doubleSpawnAlerts } from './control'

/**
 * Classification.
 *
 *   not-a-server  no level.dat. Structural, always inferable.
 *   stale         a duplicate: it declares a game port that another directory
 *                 also declares, that other directory has a live process, and
 *                 this one does not. Inferable, and it is exactly how a
 *                 "- Copy" directory presents itself.
 *   retired       "a real server never meant to start again". NOT inferable:
 *                 it is a human decision about intent, and a directory backed
 *                 up an hour ago looks identical to one in daily use. Comes
 *                 from the operator's config only.
 *   live          everything else. The default, so an unknown install is
 *                 treated as a working server rather than quietly hidden.
 *
 * There is deliberately no hardcoded list of directory names here. See
 * server/config.ts.
 */
export async function scan(
  root: string,
  overrides: Record<string, Classification> = {},
): Promise<Snapshot> {
  const t0 = Date.now()
  const names = listDirectories(root)
  // Read once per scan, not once per server: it is the same file for all of them
  // and this is synchronous I/O on the event loop.
  const policy = loadPolicy(dataDir())
  // Measured boot times. Loaded once for the life of the process -- we are the
  // only writer -- and up here with the rest of the synchronous I/O regardless,
  // because the first await is below and spec §11 is about ordering, not volume.
  primeHistory(dataDir())

  const ignored: IgnoredDirectory[] = []
  const candidates: Array<{ name: string; dir: string }> = []

  for (const name of names) {
    const dir = join(root, name)
    if (!levelDatPath(dir)) {
      ignored.push({
        name,
        dir,
        reason: 'No level.dat found. This is not a Minecraft server directory.',
      })
      continue
    }
    candidates.push({ name, dir })
  }

  // Port conflicts. Spec §1: two directories can legitimately declare the same
  // port, which is exactly why port must never be used as identity.
  const byPort = new Map<number, string[]>()
  const hints: DirHint[] = []
  for (const c of candidates) {
    const p = gamePortOf(c.dir)
    hints.push({ dir: c.dir, gamePort: p })
    if (p === null) continue
    byPort.set(p, [...(byPort.get(p) ?? []), c.name])
  }

  // Candidates are built BEFORE enumeration, because the provider needs them:
  // on Windows a server started by a boot task has an unreadable command line,
  // and one of the remaining signals is which of these directories is holding
  // its log file open. See server/platform/windows.ts.
  // Launcher detection and identity are independent, so they run concurrently:
  // both spawn PowerShell, and doing them in series would double the fixed cost
  // of process startup on a loop that runs every ten seconds.
  const [scan, tasks] = await Promise.all([scanJvms(hints), indexTasks()])
  const jvms = scan.jvms

  /**
   * Why "no JVM owns this directory" might be wrong. Null when it is reliable.
   *
   * Computed once for the whole fleet, because the reasons are fleet-wide facts.
   * The per-directory case (its log is held but no PID could be named) is added
   * on top inside inspect().
   */
  const fleetDoubt: string | null = !scan.ok
    ? `Process enumeration itself failed${scan.failure ? `: ${scan.failure}` : ''}.`
    : scan.unattributed.length > 0
      ? `${scan.unattributed.length} java process${scan.unattributed.length === 1 ? '' : 'es'} ${scan.unattributed.length === 1 ? 'is' : 'are'} running that could not be matched to any server directory, so one of them may well be this one.`
      : null

  const servers = await Promise.all(
    candidates.map((c) =>
      inspect(c.name, c.dir, jvms, byPort, overrides, policy, tasks, {
        fleetDoubt,
        occupied: scan.occupiedDirs,
      }),
    ),
  )

  // Live first, then retired/stale, each alphabetical. Retired and stale stay
  // visible -- hiding them means forgetting they need cleaning up.
  const order: Record<Classification, number> = {
    live: 0,
    retired: 1,
    stale: 2,
    'not-a-server': 3,
  }
  servers.sort(
    (a, b) => order[a.classification] - order[b.classification] || a.name.localeCompare(b.name),
  )

  // Boot timing, fed by the readings the probes above just took.
  //
  // Here rather than inside inspect() for two reasons. It needs the SLP result,
  // so it cannot run before the probe; and recording a boot writes a file, which
  // must not happen while another server's RCON reply is in flight (spec §11) --
  // so the observation is memory-only and the write is the last thing this scan
  // does. Re-reading the window afterwards keeps the snapshot from reporting a
  // sample count one scan out of date on the scan where a boot completes.
  for (const s of servers) {
    observeBoot(s.name, {
      pid: s.proc?.pid ?? null,
      uptimeSeconds: s.proc?.uptimeSeconds ?? null,
      responding: s.slp !== null,
      ready: s.slp?.ready === true,
    })
    s.boot = timingFor(s.kind, s.name)
  }

  // Host health and the fault attribution are computed AFTER every server has
  // been assessed, because the question they answer -- "is this the machine or
  // is it that server?" -- cannot be answered from one server's reading. It
  // needs all of them plus a witness that is not a Minecraft server, which is
  // what our own event-loop lag is. See server/hostwatch.ts.
  //
  // Read the lag before anything else touches the loop, so the figure describes
  // the window the probes above actually ran in.
  const host = observeFleet(servers, loopLag())

  // Below the lag reading deliberately: this is a disk write, and a disk write
  // above it would appear in the very measurement it precedes. It runs only when
  // a boot was actually observed, which is a handful of times a week.
  flushBootTimes(dataDir())

  const lan = lanAddress()
  return {
    servers,
    ignored,
    host,
    network: {
      lanAddress: lan?.address ?? null,
      lanInterface: lan?.iface ?? null,
      publicIp: publicIp(),
    },
    serversRoot: root,
    scannedAt: new Date().toISOString(),
    scanMs: Date.now() - t0,
    doubleSpawn: doubleSpawnAlerts(),
    identity: {
      ok: scan.ok,
      failure: scan.failure,
      unattributed: scan.unattributed.length,
      tookMs: scan.tookMs,
      loopBlockedMs: scan.loopBlockedMs,
      // Which signal answered, counted. All four on this host resolving via the
      // fallback is the fact that revealed the primary was dead in production.
      bySignal: {
        'scheduled-task': jvms.filter((j) => j.attributedBy === 'scheduled-task').length,
        'command-line': jvms.filter((j) => j.attributedBy === 'command-line').length,
        'open-log-and-port': jvms.filter((j) => j.attributedBy === 'open-log-and-port').length,
      },
      startedBy: {
        'scheduled-task': jvms.filter((j) => j.startedBy === 'scheduled-task').length,
        interactive: jvms.filter((j) => j.startedBy === 'interactive').length,
        unknown: jvms.filter((j) => j.startedBy === 'unknown').length,
      },
    },
  }
}

async function inspect(
  name: string,
  dir: string,
  jvms: JvmProcess[],
  byPort: Map<number, string[]>,
  overrides: Record<string, Classification>,
  policy: BackupPolicy,
  tasks: TaskIndex,
  identity: { fleetDoubt: string | null; occupied: string[] },
): Promise<ServerStatus> {
  // ALL synchronous filesystem work happens here, before the first await.
  //
  // These calls block the event loop, and every candidate is inspected
  // concurrently via Promise.all -- so sync work placed after an await runs
  // while a *different* server's RCON reply is in flight, and that server gets
  // billed for our delay. worldDirs() used to be called down in the return
  // object, which is exactly how a healthy MC 1.21.4 was reported as STALLED at
  // 3,120 ms on the first cold-cache scan. Doing it all up front means it
  // completes before any probe is outstanding.
  //
  // The loop guard below is the belt to this braces: ordering fixes the case we
  // know about, measurement catches the ones we do not.
  const kind = detectKind(dir)
  const gamePort = gamePortOf(dir)
  const props = serverProps(dir)
  const rc = rconConfig(dir) // credentials stay in this scope
  const worlds = worldDirs(dir)
  const dport = dynmapPort(dir)
  // Reading the tail of gc.log is synchronous file I/O, so it belongs up here
  // with everything else that blocks -- above the first await. Spec §11.
  const gc = gcSummary(dir)
  const launcher = detectLauncher(dir, tasks)
  const jvm = jvmForDir(jvms, dir)
  // Synchronous stat + read, so it belongs above the first await with the rest
  // of the blocking filesystem work. Spec §11 -- see the note at the top of
  // inspect(): anything sync that runs after an await bills its cost to whichever
  // server's probe happens to be outstanding.
  const settings = readSettings(dir, jvm?.uptimeSeconds ?? null)

  const conflicts = gamePort !== null ? (byPort.get(gamePort) ?? []).filter((n) => n !== name) : []

  const hasProcessEarly = jvmForDir(jvms, dir) !== null
  // A duplicate announces itself: same declared port as a sibling, that sibling
  // running, this one not. No name matching, no hardcoded list.
  const shadowedByRunningTwin =
    !hasProcessEarly &&
    conflicts.some((other) => {
      const otherDir = join(dir, '..', other)
      return jvmForDir(jvms, otherDir) !== null
    })
  let classification: Classification =
    overrides[name] ?? (shadowedByRunningTwin ? 'stale' : 'live')

  // Only probe the network if a process actually owns THIS directory. Probing
  // by port would read the neighbour that shares it -- when the fixtures were
  // first generated, MC Tech's "status" was really GTNH's and the Copy's was
  // really the live 1.21.4's.
  const hasProcess = jvm !== null

  let slp = null
  let rconProbe = null
  let players: string[] | null = null
  let tps: TpsInfo | null = null

  if (hasProcess && gamePort !== null) {
    slp = await slpPing(gamePort)
  }

  let blockedDuringProbe = 0
  if (hasProcess && rc && slp?.ready) {
    const t0 = Date.now()
    // Register the window BEFORE connecting, so the server's "client started"
    // line cannot be written before we are ready to own it. This is the only
    // place that registers one: an operator's command in control.ts goes through
    // the same client deliberately unregistered, so it is never hidden from the
    // console. See server/rconledger.ts.
    const probe = beginProbe(name)
    try {
      const conn = await Rcon.connect(rc.port, rc.password, '127.0.0.1', RCON_TIMEOUT_MS)
      try {
        probe.command('list')
        const listRes = await conn.run('list', RCON_TIMEOUT_MS)
        rconProbe = { ok: true, latencyMs: listRes.latencyMs, note: '' }
        players = parsePlayerNames(listRes.raw)
        if (parsePlayerCount(listRes.raw).online === 0) players = []

        const cmd = tpsCommandFor(kind)
        if (cmd) {
          probe.command(cmd)
          const tpsRes = await conn.run(cmd, RCON_TIMEOUT_MS)
          const p = parseTps(kind, tpsRes.raw)
          tps = p
            ? {
                command: cmd,
                overall: p.overall,
                windows: p.windows,
                dimensions: p.dimensions,
                raw: tpsRes.raw.slice(0, 400),
              }
            : null
        }
      } finally {
        conn.close()
        // Closed here rather than in the outer catch: the window must stay open
        // across a TIMEOUT too, because a wedged server still logged our connect.
        probe.end()
      }
    } catch (e) {
      rconProbe = {
        ok: false,
        latencyMs: Date.now() - t0,
        note: e instanceof Error ? e.message : 'rcon failed',
      }
    }
    // How much of that window was us, not the server.
    blockedDuringProbe = observerBlockedMs(t0, Date.now())
  }

  // Dynmap: configured and alive are different things. MC 1.21.11 has 8124 in
  // its config but the plugin never loads, so the port is dead -- the UI must
  // not present that as a working link.
  const dynmap =
    dport === null ? null : { port: dport, responding: hasProcess ? await portResponds(dport) : false }

  // Doubt about "nothing is running here", assembled per directory. The
  // directory-specific case is the strongest of the three: its log file is held
  // open, so something IS serving it, and we simply could not name the process.
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  const occupiedButUnnamed =
    !hasProcess && identity.occupied.some((o) => norm(o) === norm(dir))
      ? 'Its log file is held open by some process, so a server IS running out of this directory, but no process could be matched to it.'
      : null
  const identityDoubt = hasProcess ? null : (occupiedButUnnamed ?? identity.fleetDoubt)

  // This server's own measured start window, or its platform's constant if it
  // has never been watched booting. In memory, so it costs nothing to read here.
  const boot = timingFor(kind, name)

  const verdict = assessHealth({
    kind,
    hasProcess,
    uptimeSeconds: jvm?.uptimeSeconds ?? null,
    slp,
    rcon: rconProbe,
    rconConfigured: rc !== null,
    observerBlockedMs: blockedDuringProbe,
    identityDoubt,
    graceSeconds: boot.graceSeconds,
    graceMeasured: boot.source === 'measured',
  })

  // A directory that is not meant to run should not be reported as DOWN like a
  // crashed server -- that is noise, not signal.
  if (classification !== 'live' && verdict.health === 'DOWN') {
    verdict.detail =
      classification === 'retired'
        ? 'Retired: archived and not expected to start. Safe to delete once you are happy with the archive.'
        : 'Stale duplicate: never started. Shares its port with a live server, which is why port cannot be used to decide what is running.'
  }

  return {
    id: name,
    name,
    dir,
    kind,
    classification,
    gamePort,
    levelName: props['level-name'] ?? null,
    worldDirs: worlds,
    rconConfigured: rc !== null, // boolean only; never the password
    // Read here rather than in the route, so the value the UI shows and the
    // value a write is checked against come from the same scan.
    settings: settings,
    health: verdict.health,
    healthDetail: verdict.detail,
    // Filled in by observeFleet() once every server has been read: how long
    // this state has held, and whose fault it is. Not knowable from here.
    healthSince: new Date().toISOString(),
    healthScans: 1,
    attribution: null,
    attributionDetail: null,
    proc: jvm
      ? {
          pid: jvm.pid,
          workingSetMb: jvm.workingSetMb,
          privateMb: jvm.privateMb,
          uptimeSeconds: jvm.uptimeSeconds,
        }
      : null,
    slp,
    rcon: rconProbe,
    gc: hasProcess ? gc : null,
    boot,
    backupEnabled: isBackupEnabled(policy, name),
    launchStrategy: launcher.strategy,
    launchDetail: launcher.detail,
    controlBusy: isBusy(name),
    players,
    tps,
    portConflictWith: conflicts,
    dynmap,
    checkedAt: new Date().toISOString(),
  }
}
