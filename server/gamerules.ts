import { GAME_RULE_NAMES, type GameRuleName, type GameRulesReading, type GameRuleReading } from '@shared/api'
import { rconConfig } from './properties'
import { occupancyOf } from './control'
import { Rcon } from './rcon'

/**
 * Game rules: the first RUNTIME surface. Everything else the dashboard edits
 * lives in files; a game rule lives inside the running server (persisted in
 * the world's level.dat), is read by asking the server, and takes effect the
 * moment it is set.
 *
 * Three consequences, all load-bearing:
 *
 * 1. **No process, no reading.** The dashboard does not parse or write
 *    level.dat: NBT is a binary format the server rewrites on its own
 *    schedule, and a wrong write corrupts a world. So a stopped server's
 *    rules are honestly unreadable here, and the panel says that instead of
 *    guessing. Doubt about whether it is running refuses the same way the
 *    start guard does.
 *
 * 2. **Reply shapes are measured, not assumed** (2026-08-03, all five live
 *    servers):
 *      - modern (Paper 1.21.4, Forge 1.20.1, vanilla 1.21.x):
 *          "Gamerule keepInventory is currently set to: false"
 *      - 1.7.10 (GTNH): "keepInventory = false", and an absent rule answers
 *          "No game rule called 'x' is available"
 *      - Paper 1.21.11 REJECTS the query form outright ("Incorrect argument
 *          for command"), so on that server values cannot be read at all;
 *          the reading says so as its own state rather than reporting
 *          sixteen absent rules.
 *      - vanilla's RCON can GLUE a stale reply fragment onto an answer
 *          (measured: a `list` reply prefixed a gamerule answer). Every
 *          parse is therefore anchored on the rule name that was asked for,
 *          never on the whole string.
 *
 * 3. **Only the catalog is constructible.** The command sent is built from a
 *    catalog constant and a validated boolean/bounded integer, never from
 *    request text, so this route cannot become a raw RCON pipe. The wire
 *    enum in shared/api.ts and the catalog here are asserted identical by
 *    prove-gamerules.
 */

export type RuleSpec = {
  name: GameRuleName
  type: 'boolean' | 'integer'
  /** Shown in the UI. Plain consequences, not lore. */
  description: string
  /** Integer rules only: refused outside these bounds. */
  min?: number
  max?: number
}

export const CATALOG: readonly RuleSpec[] = [
  { name: 'keepInventory', type: 'boolean', description: 'Players keep their inventory and XP when they die.' },
  { name: 'mobGriefing', type: 'boolean', description: 'Mobs can change blocks: creepers crater the ground, endermen pick blocks up, villagers work their farms.' },
  { name: 'doFireTick', type: 'boolean', description: 'Fire spreads and burns out on its own.' },
  { name: 'doDaylightCycle', type: 'boolean', description: 'Time advances, so day and night alternate.' },
  { name: 'doWeatherCycle', type: 'boolean', description: 'Weather changes on its own.' },
  { name: 'doMobSpawning', type: 'boolean', description: 'Mobs spawn naturally. Spawners and breeding are separate and unaffected.' },
  { name: 'doMobLoot', type: 'boolean', description: 'Mobs drop loot when they die.' },
  { name: 'doTileDrops', type: 'boolean', description: 'Broken blocks drop their items.' },
  { name: 'naturalRegeneration', type: 'boolean', description: 'Players regenerate health when their hunger bar is high enough.' },
  { name: 'commandBlockOutput', type: 'boolean', description: 'Command blocks announce their output to online operators.' },
  { name: 'announceAdvancements', type: 'boolean', description: 'Advancements are announced in chat.' },
  { name: 'showDeathMessages', type: 'boolean', description: 'Death messages appear in chat.' },
  { name: 'doImmediateRespawn', type: 'boolean', description: 'Players respawn immediately instead of seeing the death screen.' },
  {
    name: 'randomTickSpeed',
    type: 'integer',
    min: 0,
    max: 1000,
    description: 'Random block ticks per chunk section per game tick: crop growth, fire spread, leaf decay. The vanilla default is 3; high values cost real tick time.',
  },
  {
    name: 'playersSleepingPercentage',
    type: 'integer',
    min: 0,
    max: 100,
    description: 'The share of online players that must sleep to skip the night.',
  },
  {
    name: 'spawnRadius',
    type: 'integer',
    min: 0,
    max: 128,
    description: 'The radius around the world spawn point in which new and respawning players appear.',
  },
] as const

const specOf = (name: string): RuleSpec | undefined => CATALOG.find((r) => r.name === name)

/** One parsed query reply. See the measured shapes in the module header. */
export type ParsedQuery =
  | { kind: 'value'; value: string }
  | { kind: 'absent' }
  | { kind: 'query-rejected' }
  | { kind: 'unparsed' }

export function parseQueryReply(name: string, raw: string): ParsedQuery {
  // Anchored on the rule name: a reply may carry glued fragments of an
  // earlier answer (measured on vanilla RCON), so the whole string is never
  // trusted, only the sentence about the rule that was asked for.
  const modern = new RegExp(`Gamerule ${name} is currently set to: (\\S+)`).exec(raw)
  if (modern) return { kind: 'value', value: modern[1]! }
  const legacy = new RegExp(`(?:^|[\\s:])${name} = (\\S+)`).exec(raw)
  if (legacy) return { kind: 'value', value: legacy[1]!.trim() }
  if (raw.includes(`No game rule called '${name}'`)) return { kind: 'absent' }
  if (/Incorrect argument for command/.test(raw)) return { kind: 'query-rejected' }
  return { kind: 'unparsed' }
}

function toReading(spec: RuleSpec, parsed: ParsedQuery, raw: string): GameRuleReading {
  const base = {
    name: spec.name,
    type: spec.type,
    description: spec.description,
    min: spec.min ?? null,
    max: spec.max ?? null,
    boolValue: null as boolean | null,
    intValue: null as number | null,
    raw,
  }
  if (parsed.kind === 'value') {
    const v = parsed.value
    if (v === 'true' || v === 'false') return { ...base, status: 'value', boolValue: v === 'true' }
    if (/^-?\d+$/.test(v)) return { ...base, status: 'value', intValue: Number(v) }
    // A value in a shape we have not measured. Reported raw rather than
    // coerced: a wrong reading here is exactly the misreporting category.
    return { ...base, status: 'unparsed' }
  }
  if (parsed.kind === 'absent' || parsed.kind === 'query-rejected') {
    // On a server whose queries work, a rejected query for ONE rule is the
    // modern shape for "this version does not have that rule".
    return { ...base, status: 'absent' }
  }
  return { ...base, status: 'unparsed' }
}

const RCON_TIMEOUT_MS = 5000

/** What this module needs from a connection; the real Rcon satisfies it. */
type RconLike = { run(cmd: string, t?: number): Promise<{ raw: string }>; close(): void }

type Deps = {
  occupancy?: typeof occupancyOf
  connect?: (port: number, password: string) => Promise<RconLike>
}

async function gate(dir: string, deps: Deps): Promise<GameRulesReading | null> {
  const occ = await (deps.occupancy ?? occupancyOf)(dir)
  if (!occ.certain) {
    return {
      state: 'uncertain',
      detail: `Whether this server is running could not be established (${occ.doubt ?? 'no reason reported'}). Game rules are read through the running server, and doubt is not a reading.`,
      rules: [],
      queriedAt: null,
    }
  }
  if (occ.pids.length === 0) {
    return {
      state: 'not-running',
      detail:
        'This server is not running, so its game rules cannot be read or changed here. They live inside the world (level.dat) and are reached through the running server; the dashboard does not parse or write level.dat, because a wrong write to it corrupts a world.',
      rules: [],
      queriedAt: null,
    }
  }
  return null
}

function noRcon(): GameRulesReading {
  return {
    state: 'no-rcon',
    detail:
      'RCON is not enabled in this server\'s server.properties, so there is no way to ask it anything, game rules included.',
    rules: [],
    queriedAt: null,
  }
}

async function defaultConnect(port: number, password: string) {
  const conn = await Rcon.connect(port, password, '127.0.0.1', RCON_TIMEOUT_MS)
  return {
    run: (cmd: string, t = RCON_TIMEOUT_MS) => conn.run(cmd, t),
    close: () => conn.close(),
  }
}

export async function readGameRules(dir: string, deps: Deps = {}): Promise<GameRulesReading> {
  const refused = await gate(dir, deps)
  if (refused) return refused
  const rc = rconConfig(dir)
  if (!rc) return noRcon()

  let conn: RconLike
  try {
    conn = await (deps.connect ?? defaultConnect)(rc.port, rc.password)
  } catch (e) {
    return {
      state: 'rcon-failed',
      detail: `The server is running but RCON did not answer (${e instanceof Error ? e.message : 'connect failed'}), so no rule was read. Nothing is being guessed.`,
      rules: [],
      queriedAt: null,
    }
  }

  try {
    const rules: GameRuleReading[] = []
    for (const spec of CATALOG) {
      let raw: string
      try {
        raw = (await conn.run(`gamerule ${spec.name}`)).raw
      } catch (e) {
        return {
          state: 'rcon-failed',
          detail: `RCON stopped answering mid-read (${e instanceof Error ? e.message : 'command failed'}). ${rules.length} of ${CATALOG.length} rules were read before that; none are shown, because a partial list renders like a complete one.`,
          rules: [],
          queriedAt: null,
        }
      }
      const parsed = parseQueryReply(spec.name, raw)
      // The probe rule decides whether this server answers queries at all:
      // keepInventory has existed since 1.4.2, so a rejected query for IT is
      // the server refusing the query FORM (measured on Paper 1.21.11), not
      // a missing rule.
      if (spec.name === 'keepInventory' && parsed.kind === 'query-rejected') {
        return {
          state: 'queries-unsupported',
          detail:
            'This server rejects the gamerule query form over RCON ("Incorrect argument for command", measured on Paper 1.21.11), so current values cannot be read here. Rules can still be changed from its own console.',
          rules: [],
          queriedAt: null,
        }
      }
      rules.push(toReading(spec, parsed, raw))
    }
    const readable = rules.filter((r) => r.status === 'value').length
    return {
      state: 'read',
      detail:
        readable === CATALOG.length
          ? `All ${CATALOG.length} catalogued rules answered with a value.`
          : `${readable} of ${CATALOG.length} catalogued rules answered with a value; the rest do not exist on this server's version and are not shown as defaults.`,
      rules,
      queriedAt: new Date().toISOString(),
    }
  } finally {
    conn.close()
  }
}

export type SetGameRuleResult = {
  ok: boolean
  detail: string
  /** The value the server reports AFTER the set, when it answers queries. */
  readBack: string | null
}

export async function setGameRule(
  dir: string,
  name: string,
  value: boolean | number,
  deps: Deps = {},
): Promise<SetGameRuleResult> {
  const spec = specOf(name)
  if (!spec) {
    return { ok: false, detail: `${name} is not in the game rule catalog, and only catalogued rules can be set here.`, readBack: null }
  }
  if (spec.type === 'boolean' && typeof value !== 'boolean') {
    return { ok: false, detail: `${spec.name} takes true or false.`, readBack: null }
  }
  if (spec.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return { ok: false, detail: `${spec.name} takes a whole number.`, readBack: null }
    }
    if (value < (spec.min ?? 0) || value > (spec.max ?? 0)) {
      return {
        ok: false,
        detail: `${spec.name} is accepted between ${spec.min} and ${spec.max} here; ${value} is outside that.`,
        readBack: null,
      }
    }
  }

  const refused = await gate(dir, deps)
  if (refused) return { ok: false, detail: refused.detail, readBack: null }
  const rc = rconConfig(dir)
  if (!rc) return { ok: false, detail: noRcon().detail, readBack: null }

  let conn: RconLike
  try {
    conn = await (deps.connect ?? defaultConnect)(rc.port, rc.password)
  } catch (e) {
    return {
      ok: false,
      detail: `RCON did not answer (${e instanceof Error ? e.message : 'connect failed'}); nothing was changed.`,
      readBack: null,
    }
  }

  try {
    // Constructible only from the catalog constant and a validated value.
    await conn.run(`gamerule ${spec.name} ${String(value)}`)
    // The claim comes from a read-back, not from the set reply: the query
    // parse is the measured, proven surface.
    let readBack: string | null = null
    try {
      const q = parseQueryReply(spec.name, (await conn.run(`gamerule ${spec.name}`)).raw)
      if (q.kind === 'value') readBack = q.value
    } catch {
      /* the sentence below says so */
    }
    if (readBack !== null) {
      const matches = readBack === String(value)
      return {
        ok: matches,
        detail: matches
          ? `${spec.name} is now ${readBack}, read back from the server. It took effect immediately and is saved with the world.`
          : `The server answered the set, but reads back ${spec.name} = ${readBack} rather than ${String(value)}. Nothing further was done; check the server's own console.`,
        readBack,
      }
    }
    return {
      ok: true,
      detail: `The set was sent, but this server does not answer gamerule queries over RCON, so the new value could not be read back here. Verify in its own console if it matters.`,
      readBack: null,
    }
  } catch (e) {
    return {
      ok: false,
      detail: `RCON failed while setting (${e instanceof Error ? e.message : 'command failed'}). Whether the rule changed is unknown; check the server console.`,
      readBack: null,
    }
  } finally {
    conn.close()
  }
}

/** prove-gamerules asserts the wire enum and this catalog cannot drift. */
export function catalogNames(): string[] {
  return CATALOG.map((r) => r.name)
}
export const WIRE_NAMES: readonly string[] = GAME_RULE_NAMES
