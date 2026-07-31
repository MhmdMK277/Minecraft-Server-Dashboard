/**
 * TEMPORARY layout-law harness (not committed): renders the per-server
 * Overview and Console pages for a worst-case modded server, so law 6
 * (content never dictates column width) can be verified by screenshot
 * without a live session. Long lines here are longer than anything GTNH
 * has actually logged.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { LogLine, ServerStatus } from '@shared/api'
import ServerPages from '../web/ServerDetail'

const ROOT = join(import.meta.dirname, '..')
const assets = join(ROOT, 'dist', 'assets')
const cssFile = readdirSync(assets).find((f) => f.endsWith('.css'))
if (!cssFile) throw new Error('build first: no css in dist/assets')
const css = readFileSync(join(assets, cssFile), 'utf8')

const LONG =
  '[31Jul2026 03:44:01.123] [Server thread/INFO] [gregtech.api.metatileentity.MetaTileEntityHolder/]: ' +
  'Recipe conflict detected in gregtech:large_chemical_reactor for input [fluid:sulfuric_acid x4000, item:gregtech:circuit.advanced@4] '.repeat(3)

const gtnh: ServerStatus = {
  id: 'MC GTNH',
  name: 'MC GTNH',
  dir: 'C:/servers/MC GTNH GregTech New Horizons 2.8.4 Long Directory Name',
  kind: 'forge-1710',
  classification: 'live',
  gamePort: 25567,
  levelName: 'World Of Extremely Long Names For Testing',
  worldDirs: ['World Of Extremely Long Names For Testing'],
  rconConfigured: true,
  settings: { onlineMode: false, whitelist: true, fileModifiedAt: null, changedSinceStart: false },
  health: 'HEALTHY',
  healthDetail: 'Port answering and the main game thread acknowledged RCON in 24 ms.',
  healthSince: new Date('2026-07-31T05:02:00Z').toISOString(),
  healthScans: 900,
  attribution: null,
  attributionDetail: null,
  proc: { pid: 18076, workingSetMb: 1004, privateMb: 6906, uptimeSeconds: 51000 },
  slp: {
    versionName: 'GT New Horizons 2.8.4 (1.7.10 Forge)',
    protocol: 5,
    playersOnline: 2,
    playersMax: 20,
    motd: 'GTNH',
    ready: true,
    latencyMs: 9,
  },
  rcon: { ok: true, latencyMs: 24, note: '' },
  gc: {
    maxMs: 253,
    p99Ms: 240,
    count: 84,
    totalMs: 2900,
    nonGcCount: 2,
    nonGcMaxMs: 40,
    stoppedPercent: 1,
    coveredMinutes: 60,
    windowMinutes: 60,
    truncated: false,
    worstKind: 'G1PauseRemark',
    worstAt: new Date('2026-07-31T04:39:05Z').toISOString(),
    detail: 'Worst stop-the-world pause 253 ms (G1PauseRemark). 84 pauses in the window, 1% of wall clock stopped.',
    severity: 'ok',
  },
  boot: {
    graceSeconds: 420,
    source: 'default',
    samples: 1,
    maxSeconds: 79,
    lastSeconds: 79,
    lastPortSeconds: 12,
    detail: 'One boot measured at 79s. The window narrows after 5 boots; until then the 420s platform default applies.',
  },
  backupEnabled: true,
  launchStrategy: 'windows-task',
  launchDetail: 'Started by a scheduled task.',
  controlBusy: false,
  players: ['Deserter_freezer', 'StockMenu8'],
  tps: { command: 'cofh tps', overall: 19.8, windows: [19.8], dimensions: null, raw: '' },
  portConflictWith: [],
  dynmap: null,
  checkedAt: new Date().toISOString(),
}

const CODED =
  '[31Jul2026 03:20:00] [Server thread/INFO]: §6There are §c2§6 out of maximum §c20§6 players online. §aGreen§r plain §l§bBoldAqua§r §nunder§r §mstruck§r §kobfuscated§r end'

const lines: LogLine[] = Array.from({ length: 40 }, (_, i) => ({
  seq: i,
  at: new Date().toISOString(),
  level: i % 9 === 0 ? 'warn' : 'info',
  origin: 'server',
  text:
    i % 5 === 0
      ? CODED
      : i % 3 === 0
        ? LONG
        : `[31Jul2026 03:${String(10 + i)}:00] [Server thread/INFO] [minecraft/DedicatedServer]: shorter line ${i}`,
})) as LogLine[]

const page = (p: 'overview' | 'console') =>
  renderToStaticMarkup(
    <div className="p-6">
      <h2 className="mb-3 font-mono text-[11px] uppercase tracking-widest text-warn">{p} page, worst case</h2>
      <ServerPages s={gtnh} page={p} canEdit lines={lines} ensureBacklog={() => {}} />
    </div>,
  )

writeFileSync(
  join(ROOT, 'dist', 'preview-pages.html'),
  `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>Layout law harness</title><style>${css}</style></head><body>${page('overview')}<hr>${page('console')}</body></html>`,
  'utf8',
)
console.log('wrote dist/preview-pages.html')
