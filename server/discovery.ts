import { basename, join } from 'node:path'
import type {
  Classification,
  ServerStatus,
  Snapshot,
  IgnoredDirectory,
  TpsInfo,
  AttachmentStatus,
} from '@shared/api'
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
import { detectLauncher, indexTasks, type Launcher, type TaskIndex } from './launcher'
import { loadAttached, type AttachedServer } from './attach'
import { loadPrefs, AVATAR_ORIGIN } from './prefs'
import { observe as observeHistory, forgetAllExcept } from './history'
import { existsSync } from 'node:fs'
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
      // A server.properties with no world is what a never-started server looks
      // like: a fresh creation, or a folder someone set up by hand. Calling
      // that "not a Minecraft server" would be false, so the reason says what
      // is actually missing and what fixes it.
      ignored.push({
        name,
        dir,
        reason: existsSync(join(dir, 'server.properties'))
          ? 'No world yet: there is a server.properties but no level.dat. A server that has never been started looks like this; its first start generates the world, and it appears on the board after that.'
          : 'No level.dat found. This is not a Minecraft server directory.',
      })
      continue
    }
    candidates.push({ name, dir })
  }

  /**
   * Folders the operator attached (server/attach.ts) join the candidate list
   * here, before anything else runs.
   *
   * That position is the whole point. Everything downstream, the dir hints
   * the identity provider needs, the port-conflict map, launcher detection
   * and the control layer's pre-check, works off `candidates`. An attached
   * directory that arrived later, or through a side channel, would be a
   * server the double-spawn guard cannot see: the dashboard would not know a
   * JVM already owns that world, and Start would launch a second one.
   */
  const attached = loadAttached(dataDir())

  /**
   * The state of every attachment, including the ones that have gone.
   *
   * A folder that has been deleted, renamed, or is on a drive that is not
   * plugged in must SAY so. Left as a candidate it becomes a server that
   * reports UNKNOWN for ever, which is the dashboard withholding the one
   * thing it does know. `missing` is therefore a state, not an absence, and
   * the UI offers detach next to it.
   */
  const attachments: AttachmentStatus[] = []
  for (const a of attached) {
    const name = basename(a.dir)
    const exists = existsSync(a.dir)
    const hasWorld = exists && levelDatPath(a.dir) !== null

    attachments.push({
      dir: a.dir,
      name,
      attachedAt: a.attachedAt,
      state: !exists ? 'missing' : hasWorld ? 'ok' : 'no-world',
      detail: !exists
        ? 'This folder is not on disk any more. It may have been deleted or renamed, or it may be on a drive that is not connected. Nothing is being reported about it, because there is nothing to read.'
        : hasWorld
          ? 'Watched because you attached it.'
          : 'The folder is here, but it has no world with a level.dat in it, so there is nothing to watch yet. A server that has never been started once looks like this.',
      confirmedLaunch: a.confirmedLaunch,
    })

    if (candidates.some((c) => c.dir.toLowerCase() === a.dir.toLowerCase())) continue
    // Only a real, world-bearing folder joins the candidate list. A missing
    // one must not become a server row that can never resolve.
    if (!hasWorld) continue
    candidates.push({ name, dir: a.dir })
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

  /**
   * One history sample per server per scan, INCLUDING servers that are down.
   *
   * Skipping a down server would compress the time axis and draw an outage as
   * a seam rather than a gap. Every field here is null when nothing could be
   * read, and null means not measured; server/history.ts is where that
   * distinction is enforced and proved.
   *
   * The CPU counter is passed through cumulative. Turning it into a rate
   * requires the previous reading for the same pid, which only the ring has.
   */
  const scanAt = Date.now()
  // The cumulative counter is read from the identity layer rather than from
  // the wire contract: it is an input to a rate, not a fact about the server,
  // and putting a monotonically climbing number in the snapshot would invite
  // someone to render it.
  const cpuByPid = new Map(jvms.map((j) => [j.pid, j.cpuMs]))
  for (const s of servers) {
    observeHistory({
      dir: s.dir,
      pid: s.proc?.pid ?? null,
      cpuMs: s.proc ? (cpuByPid.get(s.proc.pid) ?? null) : null,
      ramMb: s.proc?.workingSetMb ?? null,
      tps: s.tps?.overall ?? null,
      at: scanAt,
    })
  }
  // A directory that has gone stops consuming memory. Bounded by the fleet,
  // not by how long the process has been up.
  forgetAllExcept(servers.map((s) => s.dir))

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
    attachments,
    // Read per scan like the backup policy, for the same reason: one file,
    // one authority, no in-memory copy here to drift from it.
    prefs: { playerAvatars: loadPrefs(dataDir()).playerAvatars, avatarOrigin: AVATAR_ORIGIN },
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
      // A JVM whose directory we know but whose directory we are not
      // watching. See the note on IdentityScan.unwatched: this used to fall
      // through both lists and be reported nowhere.
      unwatched: jvms
        .filter((j) => !candidates.some((c) => c.dir.toLowerCase() === j.dir.toLowerCase()))
        .map((j) => ({
          pid: j.pid,
          dir: j.dir,
          startedBy: j.startedBy,
          looksLikeServer: levelDatPath(j.dir) !== null,
        })),
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

/** The attachment record for a directory, if it is one. */
function attachedFor(dir: string): AttachedServer | null {
  const key = dir.replace(/[\\/]+$/, '').toLowerCase()
  return loadAttached(dataDir()).find((a) => a.dir.replace(/[\\/]+$/, '').toLowerCase() === key) ?? null
}

/** Only what the operator confirmed becomes a launcher. See inspect(). */
function launcherFromAttachment(a: AttachedServer, dir: string): Launcher {
  const c = a.confirmedLaunch
  if (c?.strategy === 'script') {
    return {
      strategy: 'script',
      script: c.script,
      detail: `Starts with ${c.script}, confirmed when this folder was attached on ${new Date(a.attachedAt).toLocaleDateString()}.`,
    }
  }
  if (c?.strategy === 'windows-task') {
    return {
      strategy: 'windows-task',
      taskName: c.task,
      detail: `Starts through the scheduled task ${c.task}, confirmed when this folder was attached.`,
    }
  }
  return {
    strategy: 'none',
    detail:
      'This folder was attached without confirming how the server starts, so the dashboard will not start it. Stopping still works over RCON. To enable starting, detach and attach it again, confirming the launch method.',
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
  /**
   * An ATTACHED folder gets the launch method the operator confirmed while
   * looking at it, and nothing else.
   *
   * A start.bat sitting in an attached folder is deliberately NOT promoted
   * into a launcher by detection. The dashboard has never run that script;
   * it does not know whether it starts one server or four, whether it
   * assumes a working directory, or whether the operator uses it at all.
   * Discovering it later and quietly arming the Start button is precisely
   * the silent inference that puts a second JVM on a live world. So an
   * attachment with no confirmed method reports `none`, with a reason that
   * says how to fix it.
   */
  const attachedRecord = attachedFor(dir)
  const launcher = attachedRecord
    ? launcherFromAttachment(attachedRecord, dir)
    : detectLauncher(dir, tasks)
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
          heapMaxMb: jvm.heapMaxMb,
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
