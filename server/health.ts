import type { Health, SlpInfo, RconProbe } from '@shared/api'

/**
 * Health as a STATE, derived from two independent probes of two different
 * threads. See docs/liveness-spec.md §8.
 *
 *   SLP  -> answered by the NETWORK thread from a cached status object.
 *           Proves the process lives and the port is open. Says NOTHING about
 *           whether the server is doing any work.
 *   RCON -> queued onto the MAIN server thread. A prompt reply is direct
 *           evidence that the main thread is ticking.
 *
 * On 2026-07-28 all four servers answered pings normally while single ticks
 * took 128 seconds. Anything checking only SLP called them healthy. That is the
 * exact failure this state machine exists to catch.
 */

/**
 * Healthy RCON round-trips measured across all four servers on 2026-07-28:
 * 0.3 ms to 220 ms, with MC 1.21.11 consistently the slowest. 2000 ms is an
 * order of magnitude above the worst healthy sample and two orders below the
 * observed stall, so it separates them cleanly without flapping.
 */
export const RCON_SLOW_MS = 2000
export const RCON_TIMEOUT_MS = 5000

/**
 * How long after process start we are still willing to call a silent server
 * "starting" rather than "hung". GTNH's measured cold boot is 100 s; the others
 * are 16-25 s.
 *
 * These are now the FALLBACK, used until this particular server has been watched
 * booting. A constant cannot serve a 13 s Paper server and a 100 s modpack, and a
 * much larger pack on a slower disk exceeds even the 420 s here and gets called
 * HUNG while it is starting normally. `server/boottime.ts` measures the real
 * figure per server and passes it in as `graceSeconds`; these values are what it
 * derives from when there is nothing measured yet.
 */
export const START_GRACE_SECONDS: Record<string, number> = {
  'forge-1710': 420,
}
export const START_GRACE_DEFAULT = 180

export type HealthInput = {
  kind: string
  hasProcess: boolean
  uptimeSeconds: number | null
  /**
   * The start window for THIS server, measured where possible.
   *
   * Passed in rather than looked up, so this module stays a pure function of its
   * inputs -- it is cross-validated against an independent Python implementation
   * and has no business reading a file. Omitted, it falls back to the platform
   * constant, which is what every caller did before M3.5.
   */
  graceSeconds?: number
  /**
   * Where that window came from, in words, so a HUNG verdict can say what it is
   * based on. A verdict derived from five measured boots and one derived from a
   * platform guess deserve different confidence from the reader.
   */
  graceMeasured?: boolean
  slp: SlpInfo | null
  rcon: RconProbe | null
  rconConfigured: boolean
  /**
   * How long OUR event loop was blocked while the RCON probe was in flight.
   *
   * Both ends of the latency measurement are timestamps in our own process, so
   * a blocked observer bills its own delay to the server's main thread. Time we
   * were provably not listening is not evidence about the server, and must not
   * be counted as such. See server/loopguard.ts.
   */
  observerBlockedMs?: number
  /**
   * Why "no process here" might be wrong, or null when it is trustworthy.
   *
   * `hasProcess: false` has two very different causes that produce the same
   * value: nothing is running, or we could not tell. On 2026-07-29 the second
   * happened to all four servers at once -- boot-started processes have no
   * readable command line (spec §14) -- and the dashboard reported four DOWN
   * cards for a completely healthy machine.
   *
   * "I cannot tell" is not "it is not running". When identity is in doubt the
   * verdict is UNKNOWN, which is the state that exists to say the reading is
   * unusable. The same rule already governs M3.3's start guard, where treating
   * doubt as absence would start a second JVM against a live world.
   */
  identityDoubt?: string | null
}

export type HealthVerdict = { health: Health; detail: string }

export function assessHealth(i: HealthInput): HealthVerdict {
  if (!i.hasProcess) {
    if (i.identityDoubt) {
      return {
        health: 'UNKNOWN',
        detail: `Cannot tell whether this server is running. ${i.identityDoubt} Reporting DOWN here would be a guess, and this exact failure once presented as four simultaneous outages on a healthy machine.`,
      }
    }
    return {
      health: 'DOWN',
      detail: 'No java process owns this directory.',
    }
  }

  const grace = i.graceSeconds ?? START_GRACE_SECONDS[i.kind] ?? START_GRACE_DEFAULT
  const young = i.uptimeSeconds !== null && i.uptimeSeconds < grace
  // A window derived from this server's own boots is a much stronger basis for
  // an accusation than one derived from its platform, and the sentence should
  // not present them as the same thing.
  const basis = i.graceMeasured
    ? `${grace}s start window measured from this server's own boots`
    : `${grace}s start window for this platform`

  // Process exists but the port says nothing.
  if (!i.slp) {
    return young
      ? {
          health: 'STARTING',
          detail: `Process is up (${fmtAge(i.uptimeSeconds)}) but not yet answering on its port. Still within the ${basis}.`,
        }
      : {
          health: 'HUNG',
          detail:
            `Process has been up ${fmtAge(i.uptimeSeconds)} but is not answering on its port at all, past the ${basis}. ` +
            (i.graceMeasured
              ? 'It is not going to come back on its own, unless this start is doing work no previous start did. A pack update or a world conversion after a version change can legitimately take longer than anything measured here.'
              : 'It is not going to come back on its own.'),
        }
  }

  // Answering, but with the "still starting" placeholder rather than a version.
  //
  // Deliberately NOT bounded by the grace window, unlike the branch above. No
  // server on this host has ever been observed stuck in the placeholder phase, so
  // a HUNG verdict here would be an accusation invented for a failure nobody has
  // seen -- and the packs most likely to sit here for a long time are exactly the
  // ones doing legitimate first-run work. It reports the comparison and lets the
  // reader draw the conclusion instead.
  if (!i.slp.ready) {
    const over = i.uptimeSeconds !== null && i.uptimeSeconds > grace
    return {
      health: 'STARTING',
      detail:
        'Answering pings, but with a still-loading placeholder rather than a version. It is not accepting players yet.' +
        (i.uptimeSeconds === null ? '' : ` It has been starting for ${fmtAge(i.uptimeSeconds)}`) +
        (over
          ? `, which is longer than the ${basis}, still starting rather than hung, but worth looking at its log.`
          : i.uptimeSeconds === null
            ? ''
            : '.'),
    }
  }

  // Port is healthy. Now the only question that matters: is the MAIN thread alive?
  if (!i.rconConfigured) {
    return {
      health: 'UNKNOWN',
      detail:
        'Answering pings, but RCON is not configured, so the main game thread cannot be probed. A stalled server looks identical to a healthy one from the port alone.',
    }
  }

  // Time we were provably not listening is not evidence about the server.
  const blocked = i.observerBlockedMs ?? 0
  const attributable =
    i.rcon?.latencyMs != null ? Math.max(0, i.rcon.latencyMs - blocked) : null

  if (!i.rcon || !i.rcon.ok) {
    // A timeout while we were blocked for most of the window is our fault, not
    // the server's. Reporting UNKNOWN is weaker than STALLED and that is the
    // point: it says "this reading is not usable", not "your server is broken".
    if (blocked > RCON_TIMEOUT_MS / 2) {
      return {
        health: 'UNKNOWN',
        detail: `RCON did not reply in time, but this dashboard's own event loop was blocked for ${blocked} ms of that window, so the reading says nothing about the server. Retrying on the next scan.`,
      }
    }
    return {
      health: 'STALLED',
      detail: `Answering pings normally, but RCON did not reply within ${RCON_TIMEOUT_MS / 1000}s. Pings come from the network thread; RCON has to reach the main game thread. The main thread is not processing commands${i.rcon?.note ? ` (${i.rcon.note})` : ''}.`,
    }
  }

  if (attributable !== null && attributable > RCON_SLOW_MS) {
    return {
      health: 'STALLED',
      detail: `Answering pings, but the main game thread took ${attributable} ms to acknowledge an RCON command (healthy is under ${RCON_SLOW_MS} ms). The server is up but not keeping up.`,
    }
  }

  return {
    health: 'HEALTHY',
    detail:
      blocked > RCON_SLOW_MS
        ? `Port answering and the main game thread acknowledged RCON in ${attributable} ms, after discounting ${blocked} ms in which this dashboard was busy and not reading the reply.`
        : `Port answering and the main game thread acknowledged RCON in ${i.rcon.latencyMs} ms.`,
  }
}

function fmtAge(sec: number | null): string {
  if (sec === null) return 'unknown time'
  if (sec < 90) return `${sec}s`
  if (sec < 5400) return `${Math.round(sec / 60)}m`
  return `${(sec / 3600).toFixed(1)}h`
}
