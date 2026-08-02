import type {
  Attribution,
  FleetInference,
  HostState,
  HostStatus,
  LoopLag,
  ServerStatus,
} from '@shared/api'
import { RCON_SLOW_MS } from './health'
import { MIN_FLOOR_SAMPLES } from './loopguard'

/**
 * Host health, and the inference that falls out of reading the whole fleet at
 * once. See docs/liveness-spec.md §12.
 *
 * §11 taught the observer to subtract its own delay from a server's reading, so
 * it would stop accusing healthy servers. That correction throws the
 * measurement away, and the measurement is worth keeping: this process spends
 * its life asleep, so when ITS event loop is late, something outside it is the
 * reason.
 *
 * That makes the observer a fifth witness which is not a Minecraft server, and
 * a witness outside the population is what turns N observations into one:
 *
 *   one server degraded, observer loop flat        -> that server
 *   every server degraded, observer loop climbing  -> the machine
 *
 * The second line is the whole point. A Minecraft server's fault cannot explain
 * an unrelated Node process being descheduled, so simultaneous degradation plus
 * observer starvation is ONE host event, not four server events. On 2026-07-28
 * this host produced 177 stalls across four servers in a day and three days went
 * into per-server hypotheses. Four red badges is that mistake, rendered.
 */

/**
 * A quarter second. Above ordinary GC and timer jitter (the sampler's noise
 * floor is 15 ms), and already enough to distort a reading: the slowest healthy
 * RCON round trip measured across these four servers is 220 ms, so a block this
 * size can double the worst legitimate number on the page.
 */
export const LAG_BUSY_MS = 250

/**
 * Deliberately equal to RCON_SLOW_MS. A block this long can manufacture a
 * STALLED verdict on its own, with no help from the server -- which is exactly
 * what happened on 2026-07-29 (spec §11). Above this line, readings taken in
 * the window are not evidence about anything.
 */
export const LAG_STALLING_MS = RCON_SLOW_MS

/**
 * Above this share of blocked time unexplained by our own CPU, the lag is the
 * machine's rather than ours. Half is the honest midpoint, and the underlying
 * split is already biased towards blaming ourselves -- process.cpuUsage() counts
 * every thread, so our CPU is over-counted. See server/loopguard.ts.
 */
const STARVED_SHARE = 0.5

/** Scans a verdict must hold before the UI stops calling it provisional. */
const SETTLED_SCANS = 3

export type HostAssessment = {
  state: HostState
  detail: string
  /** 0-1. How much of the lag we could NOT account for with our own CPU. */
  starvedShare: number
  /** True when the lag is mostly the machine's rather than ours. */
  starved: boolean
}

/**
 * Pure. Host state from loop lag alone, before any server is considered.
 *
 * `maxMs` decides the state rather than a percentile: percentiles describe a
 * typical moment, and the question here is whether ANY moment in the window was
 * bad enough to have corrupted a reading taken in it. p95 is reported alongside
 * because "one 3 s block" and "constantly 3 s late" are different illnesses.
 */
export function assessHost(lag: LoopLag): HostAssessment {
  const starvedShare = lag.blockedMs > 0 ? lag.starvedMs / lag.blockedMs : 0
  const starved = starvedShare >= STARVED_SHARE

  // Refuse to report a calm machine on the strength of no evidence. The sampler
  // not running looks identical to the sampler running and finding nothing, and
  // only one of those is a reason to believe anything.
  //
  // "Not enough samples yet" belongs in the same bucket, and that is not
  // pedantry: until the granularity floor is calibrated the figures still carry
  // the platform's timer, so the very first snapshot after startup reported p50
  // 12 ms and 12 ms of "starvation" on an idle machine. The first snapshot is
  // also the one this project has already been burned by once (spec §11).
  if (lag.samples < MIN_FLOOR_SAMPLES) {
    return {
      state: 'UNMEASURED',
      detail:
        lag.samples === 0
          ? 'Event-loop lag is not being sampled in this process, so nothing is known about the host. This is not the same as the host being healthy.'
          : `Still calibrating: ${lag.samples} of ${MIN_FLOOR_SAMPLES} samples. Until the platform's timer granularity has been measured it is still inside these figures, so nothing is claimed about the host for another second or two.`,
      starvedShare: 0,
      starved: false,
    }
  }
  const whose = starved
    ? `${dur(lag.starvedMs)} of that was wall clock in which this process consumed no CPU at all. It was not being scheduled, so the delay came from outside it`
    : `our own CPU accounts for most of it (only ${dur(lag.starvedMs)} unexplained), so this is this dashboard's own work, not the machine`

  // Say what was actually covered, not what the window is nominally worth. A
  // sampler thirty seconds old must not describe itself as a minute of evidence.
  const span = `${Math.min(lag.windowSeconds, Math.round((lag.samples * lag.sampleMs) / 1000))}s`

  if (lag.maxMs >= LAG_STALLING_MS) {
    return {
      state: 'STALLING',
      detail: `The event loop was blocked for up to ${dur(lag.maxMs)} in the last ${span} (p95 ${lag.p95Ms} ms). ${cap(whose)}. A block this long can produce a STALLED verdict by itself, so readings taken in this window are not evidence about any server.`,
      starvedShare,
      starved,
    }
  }
  if (lag.maxMs >= LAG_BUSY_MS) {
    return {
      state: 'BUSY',
      detail: `The event loop was late by up to ${dur(lag.maxMs)} in the last ${span} (p95 ${lag.p95Ms} ms). ${cap(whose)}. Enough to inflate a latency reading, not enough to invent a stall.`,
      starvedShare,
      starved,
    }
  }
  return {
    state: 'OK',
    detail: `The event loop is being scheduled promptly, p50 ${lag.p50Ms} ms, p95 ${lag.p95Ms} ms, worst ${dur(lag.maxMs)} over the last ${span}. The machine is keeping up, so a degraded server here is the server.`,
    starvedShare,
    starved,
  }
}

/**
 * Degradation, for the purpose of correlation.
 *
 * UNKNOWN counts: "we could not get a reading" during a host stall is the same
 * event as "the reading was bad", and excluding it would hide precisely the
 * case §11 introduced. UNKNOWN because RCON is not configured does NOT count --
 * that server is invisible in every scan forever, and a permanent constant
 * cannot correlate with anything.
 *
 * DOWN is excluded too: no process means no measurement, and a server stopped on
 * purpose is not a symptom.
 */
function isProbed(s: ServerStatus): boolean {
  return s.classification === 'live' && s.proc !== null && s.rconConfigured
}

function isDegraded(s: ServerStatus): boolean {
  return isProbed(s) && (s.health === 'STALLED' || s.health === 'HUNG' || s.health === 'UNKNOWN')
}

/**
 * Pure. The 2x2 that answers "is this the machine or the server?".
 *
 *   degraded  loop lag              verdict
 *   --------  --------------------  -------------------------------------------
 *   none      any                   none
 *   many      elevated, starved     host      the machine stopped scheduling
 *   many      elevated, our own CPU observer  our bug -- spec §11, again
 *   many      flat                  shared    one common cause, not N faults
 *   one       elevated              observer  the reading may be an artifact
 *   one       flat                  server    isolated, and trustworthy
 *
 * "many" is at least two AND at least half of what we could probe, so one bad
 * server out of four never reads as fleet-wide, and two out of two does.
 */
export function inferFault(
  servers: ServerStatus[],
  host: HostAssessment,
  lag: LoopLag,
): Omit<FleetInference, 'since' | 'scans'> {
  const probedList = servers.filter(isProbed)
  const degradedList = probedList.filter(isDegraded)
  const probed = probedList.length
  const degraded = degradedList.map((s) => s.id)
  const n = degraded.length

  const names = degradedList.map((s) => s.name).join(', ')
  const many = n >= 2 && n * 2 >= probed
  const measured = host.state !== 'UNMEASURED'
  const elevated = host.state === 'BUSY' || host.state === 'STALLING'
  const lagPhrase = `loop lag p95 ${lag.p95Ms} ms, worst ${dur(lag.maxMs)} in the last ${lag.windowSeconds}s`

  // Zero probed servers is not a healthy fleet: nothing was measured, so
  // nothing may be reassured about. "All 0 probed servers are answering
  // normally" was the product lying by its own standard.
  if (probed === 0) {
    const discovered = servers.filter((s) => s.classification !== 'not-a-server').length
    return {
      fault: 'none',
      headline: discovered === 0 ? 'No servers discovered' : 'No server can be measured',
      detail:
        discovered === 0
          ? 'Nothing under the servers root looks like a Minecraft server yet, so no reading has been taken and none is being claimed. Discovery scans the configured servers root for directories containing a level.dat, and matches running Java processes to them through the process tree and their launch tasks.'
          : `${discovered} server director${discovered === 1 ? 'y was' : 'ies were'} discovered, but none can be probed for health right now: a server must be running and have enable-rcon=true in its server.properties before its main thread can be measured. Nothing is being claimed about what cannot be measured.`,
      degraded,
      probed,
    }
  }

  if (n === 0) {
    return {
      fault: 'none',
      headline: elevated
        ? 'No server is degraded, but this host is not keeping up'
        : 'Nothing is wrong',
      detail: !measured
        ? `All ${probed} probed servers are answering normally. Host lag is not being sampled in this process, so nothing is claimed about the machine itself.`
        : elevated
          ? `All ${probed} probed servers are answering normally, so nothing here needs attention yet. The host itself is lagging (${lagPhrase}), worth watching, because that is the leading edge of the pattern this dashboard is built to catch.`
          : `All ${probed} probed servers are answering normally and this dashboard's own event loop is not being delayed (${lagPhrase}), so the readings above can be taken at face value.`,
      degraded,
      probed,
    }
  }

  // Without a lag measurement the host/server split cannot be made -- the whole
  // inference rests on having a witness that is not a Minecraft server. Fall
  // back to what correlation between servers alone supports, and say so.
  if (!measured) {
    return many
      ? {
          fault: 'shared',
          headline: `${n} of ${probed} servers degraded in the same scan`,
          detail: `${names} degraded together, which is one cause with ${n} symptoms rather than ${n} independent faults. Host lag is not being sampled in this process, so this cannot be narrowed to "the machine" or ruled out as a measurement artifact, run this through the dashboard service, which samples it.`,
          degraded,
          probed,
        }
      : {
          fault: 'server',
          headline: `${names} is degraded`,
          detail: `${names} is degraded and the other ${probed - n} probed server${probed - n === 1 ? '' : 's'} answered normally. Host lag is not being sampled in this process, so a delayed observer has not been ruled out as the cause of this reading.`,
          degraded,
          probed,
        }
  }

  if (many && elevated && host.starved) {
    return {
      fault: 'host',
      headline: `The problem is the machine, not the servers. ${n} of ${probed} degraded at once`,
      detail:
        `${names} all degraded in the same scan, and at the same time this dashboard's own event loop was starved: ${dur(lag.starvedMs)} of the last ${lag.windowSeconds}s passed with this process consuming no CPU (${lagPhrase}). ` +
        `This dashboard is not a Minecraft server. No fault inside any of these servers can explain an unrelated Node process failing to get scheduled, so the simplest reading is one host event with ${n} symptoms, not ${n} faults. ` +
        `Look at the host, CPU contention, disk stalls, memory pressure, whatever else runs on this machine, before restarting anything. Restarting a server here fixes nothing and costs you the evidence.`,
      degraded,
      probed,
    }
  }

  if (many && elevated && !host.starved) {
    return {
      fault: 'observer',
      headline: `${n} of ${probed} servers look degraded, but this dashboard was the thing that was late`,
      detail:
        `${names} all degraded in the same scan while this dashboard's own event loop was blocked for up to ${dur(lag.maxMs)}, and our own CPU time accounts for it, so we were busy rather than starved. ` +
        `That is the failure mode of liveness-spec §11: a blocked observer bills its own delay to whichever server's reply was in flight. Suspect this dashboard first, not the servers, and check the scan for synchronous work that has crept back in after an await.`,
      degraded,
      probed,
    }
  }

  if (many) {
    return {
      fault: 'shared',
      headline: `${n} of ${probed} servers degraded together, and this dashboard is running normally`,
      detail:
        `${names} degraded in the same scan, but this dashboard's own event loop stayed flat (${lagPhrase}), so the machine is still scheduling work, and this is not CPU starvation. ` +
        `It is still one cause with ${n} symptoms rather than ${n} independent faults: look at what these servers share. The disk they all write worlds to, total heap against physical RAM, a scheduled job, the network, before investigating any one of them.`,
      degraded,
      probed,
    }
  }

  if (elevated) {
    return {
      fault: 'observer',
      headline: `${names} looks degraded, but this reading is not trustworthy yet`,
      detail:
        `Only ${names} is degraded, which on its own would point at that server. But this dashboard's event loop was late by up to ${dur(lag.maxMs)} in the same window (${host.starved ? 'time this process was not scheduled at all' : 'accounted for by our own CPU'}), which is enough to produce this verdict without the server doing anything wrong. ` +
        `Treat it as unconfirmed. If it survives a scan taken while the host is quiet, it is real.`,
      degraded,
      probed,
    }
  }

  return {
    fault: 'server',
    headline: `${names} is the problem. The host is fine`,
    detail:
      `${names} is degraded while the other ${probed - n} probed server${probed - n === 1 ? '' : 's'} answered normally in the same scan, and this dashboard's own event loop was not delayed (${lagPhrase}). ` +
      `The host is scheduling work, the measurement is clean, and nothing else on this machine is affected, so this is isolated to that server.`,
    degraded,
    probed,
  }
}

// --------------------------------------------------------------- memory

type Streak = { health: string; since: number; scans: number }

let serverStreaks = new Map<string, Streak>()
let fleetStreak: { fault: string; since: number; scans: number } | null = null

/** Proof scripts run several synthetic fleets in one process. */
export function resetFleetMemory(): void {
  serverStreaks = new Map()
  fleetStreak = null
}

/**
 * The stateful entry point: assess the host, infer where the fault is, and
 * write an attribution back onto every server.
 *
 * Mutates the ServerStatus objects rather than returning copies, because the
 * attribution is a property of the reading and must not be able to travel
 * separately from it.
 */
export function observeFleet(
  servers: ServerStatus[],
  lag: LoopLag,
  now: number = Date.now(),
  // The paging reading is sampled on its own timer (server/hostpaging.ts)
  // and attached by discovery, so this module stays about attribution and
  // never spawns anything.
): Omit<HostStatus, 'paging'> {
  const host = assessHost(lag)
  const inferred = inferFault(servers, host, lag)

  if (!fleetStreak || fleetStreak.fault !== inferred.fault) {
    fleetStreak = { fault: inferred.fault, since: now, scans: 1 }
  } else {
    fleetStreak.scans++
  }

  const seen = new Set<string>()
  for (const s of servers) {
    seen.add(s.id)
    const prev = serverStreaks.get(s.id)
    const streak =
      prev && prev.health === s.health
        ? { ...prev, scans: prev.scans + 1 }
        : { health: s.health, since: now, scans: 1 }
    serverStreaks.set(s.id, streak)

    s.healthSince = new Date(streak.since).toISOString()
    s.healthScans = streak.scans
    const a = attribute(s, inferred.fault, host, lag, streak, now)
    s.attribution = a?.attribution ?? null
    s.attributionDetail = a?.detail ?? null
  }
  for (const id of [...serverStreaks.keys()]) if (!seen.has(id)) serverStreaks.delete(id)

  return {
    state: host.state,
    detail: host.detail,
    lag,
    fleet: {
      ...inferred,
      since: new Date(fleetStreak.since).toISOString(),
      scans: fleetStreak.scans,
    },
  }
}

/**
 * Per-server attribution, including the answer to "why has this been UNKNOWN
 * for twenty minutes?".
 *
 * A grey badge that says nothing is the failure being fixed here. UNKNOWN has
 * two completely different causes with two completely different remedies -- one
 * is a five-minute config change, the other is a sick machine -- and until now
 * they rendered identically.
 */
function attribute(
  s: ServerStatus,
  fault: string,
  host: HostAssessment,
  lag: LoopLag,
  streak: Streak,
  now: number,
): { attribution: Attribution; detail: string } | null {
  const held = `${describe(now - streak.since)} and ${streak.scans} consecutive scan${streak.scans === 1 ? '' : 's'}`

  if (s.health === 'UNKNOWN') {
    // Blind because no process could be matched to the directory. This
    // UNKNOWN was decided before any probe ran (health.ts sets it from
    // identityDoubt when hasProcess is false), so there is NO discarded
    // reading and loop lag is not evidence about it. First, before the RCON
    // branch: with no process matched, "enable RCON" would be advice about a
    // server we cannot even see. The branch further down used to swallow
    // this case and blame our own scan-path CPU, §11 -- a second, false
    // explanation rendered beside the true one (observed 2026-08-02 on a
    // server the Create page had just started, while the real cause was an
    // identity misattribution in the Windows provider). The health sentence
    // names the identity evidence; this note carries only whose problem it
    // is and how long it has held.
    if (s.proc === null) {
      return {
        attribution: 'observer',
        detail:
          `An identity failure in this dashboard, not a measurement failure and not a fault in ${s.name}: no probe was taken, because no running process could be matched to this directory, so there is no reading to attribute and loop lag says nothing about it. ` +
          `Unknown for ${held}. If a server is running here, its launcher did not leave a trail the process scan can read; a start through this dashboard or through a scheduled task resolves on the next scan.`,
      }
    }

    // Blind by configuration. Permanent until someone edits a file, so saying
    // "retrying on the next scan" -- which is what it used to say -- is a
    // promise that will never be kept.
    if (!s.rconConfigured) {
      return {
        attribution: 'configuration',
        detail:
          `This will not resolve on its own, and it is not a fault: RCON is not enabled in this server's server.properties, so there is no way to reach its main game thread. ` +
          `Everything shown above comes from the port, and a stalled server answers the port exactly as well as a healthy one, so this server's health genuinely cannot be established until RCON is turned on. Unknown for ${held}.`,
      }
    }

    // Blind because we could not take a usable reading.
    if (host.state === 'UNMEASURED') {
      return {
        attribution: 'observer',
        detail: `The reading was discarded as unusable, and host lag is not being sampled in this process, so why it was unusable cannot be established here. Unknown for ${held}.`,
      }
    }
    const whose: Attribution = host.starved ? 'host' : 'observer'
    const settled = streak.scans >= SETTLED_SCANS
    if (!settled) {
      return {
        attribution: whose,
        detail: `The reading was discarded rather than reported: this dashboard's own event loop was blocked during the probe, so the measurement says nothing about ${s.name}. Retrying on the next scan.`,
      }
    }
    return {
      attribution: whose,
      detail:
        whose === 'host'
          ? `No usable reading for ${held}. This is not a grey badge for its own sake: every probe in that time overlapped a period in which this process was not being scheduled. ${dur(lag.starvedMs)} of the last ${lag.windowSeconds}s, worst single block ${dur(lag.maxMs)}. The host is too loaded to let this dashboard take a measurement it can stand behind, so ${s.name} has not been accused of anything; we simply have not been able to look at it. It will clear on its own when the host quietens down.`
          : `No usable reading for ${held}, and the cause is inside this dashboard rather than the host: our own CPU time accounts for the blocking (worst ${dur(lag.maxMs)}). That is liveness-spec §11 recurring, synchronous work in the scan path delaying replies that are already on the wire. This is a bug to fix here, not a problem with ${s.name}.`,
    }
  }

  if (s.health === 'STALLED' || s.health === 'HUNG') {
    if (fault === 'host') {
      return {
        attribution: 'host',
        detail: `Part of a host-wide event, not a fault in ${s.name}: every degraded server went at once while this dashboard was itself starved of CPU. Restarting this server will not fix it. Held ${held}.`,
      }
    }
    if (fault === 'observer') {
      return {
        attribution: 'observer',
        detail: `Unconfirmed. This dashboard's own event loop was late by up to ${dur(lag.maxMs)} in the same window, which is enough to produce this verdict on its own. Held ${held}.`,
      }
    }
    if (fault === 'shared') {
      return {
        attribution: 'host',
        detail:
          `${s.name} is not degraded alone, other servers went in the same scan${host.state === 'UNMEASURED' ? '' : ', while this dashboard itself ran normally'}. ` +
          `Look for what they share before looking at this one. Held ${held}.`,
      }
    }
    return {
      attribution: 'server',
      detail:
        host.state === 'UNMEASURED'
          ? `Nothing else on this host is degraded, so this looks isolated to ${s.name}, but host lag is not being sampled in this process, so a delayed observer has not been ruled out. Held ${held}.`
          : `Isolated to ${s.name}: nothing else on this host is degraded and this dashboard's own loop was flat over the same window, so the measurement is clean and the fault is here. Held ${held}.`,
    }
  }

  return null
}

/** "34000 ms" is a number you have to decode. Past a second, say seconds. */
function dur(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)} ms`
}

function describe(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 90) return `${sec}s`
  if (sec < 5400) return `${Math.round(sec / 60)}m`
  return `${(sec / 3600).toFixed(1)}h`
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
