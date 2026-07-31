import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { DimensionInfo, WorldInfo } from '@shared/api'

/**
 * Read-only world enumeration. Phase B item 1.
 *
 * STRICTLY read-only: this module opens directories and stats files, and
 * nothing else. There is no write, no delete, and no route that ever grows
 * one, because a wrong write into a world directory is the failure class
 * this whole project is built to avoid.
 *
 * The walk is on-demand (when the Worlds page is opened), never part of the
 * ten-second scan: a modpack world holds tens of thousands of region files,
 * and statting them every scan would be the observer becoming the load.
 * The walk duration is reported so the cost stays visible.
 *
 * Path safety: the only inputs are world directory names the dashboard's own
 * discovery produced. Nothing user-supplied is joined into a path.
 */

type WalkResult = {
  sizeBytes: number
  files: number
  newestMtimeMs: number
}

async function walk(dir: string): Promise<WalkResult> {
  const out: WalkResult = { sizeBytes: 0, files: 0, newestMtimeMs: 0 }
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const sub = await walk(p)
      out.sizeBytes += sub.sizeBytes
      out.files += sub.files
      if (sub.newestMtimeMs > out.newestMtimeMs) out.newestMtimeMs = sub.newestMtimeMs
    } else if (e.isFile()) {
      try {
        const st = await fs.stat(p)
        out.sizeBytes += st.size
        out.files += 1
        if (st.mtimeMs > out.newestMtimeMs) out.newestMtimeMs = st.mtimeMs
      } catch {
        // A file vanishing mid-walk (the server rotates and writes constantly)
        // is normal, not an error.
      }
    }
  }
  return out
}

async function countRegionFiles(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(join(dir, 'region'))
    return entries.filter((f) => f.endsWith('.mca') || f.endsWith('.mcr')).length
  } catch {
    return 0
  }
}

function dimKind(name: string): DimensionInfo['kind'] {
  if (name === 'DIM-1') return 'nether'
  if (name === 'DIM1') return 'end'
  return 'custom'
}

/** The world directory itself names its kind on split-world servers (Paper). */
function worldKind(dirName: string): DimensionInfo['kind'] {
  if (/_nether$/i.test(dirName)) return 'nether'
  if (/_the_end$/i.test(dirName)) return 'end'
  return 'overworld'
}

async function dimensionsOf(worldPath: string): Promise<DimensionInfo[]> {
  const dims: DimensionInfo[] = []
  let entries
  try {
    entries = await fs.readdir(worldPath, { withFileTypes: true })
  } catch {
    return dims
  }

  // Forge-style in-world dimensions: DIM-1, DIM1, DIM7, DIM_MYST3...
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (/^DIM-?\w+$/.test(e.name)) {
      const p = join(worldPath, e.name)
      const w = await walk(p)
      dims.push({
        path: e.name,
        kind: dimKind(e.name),
        sizeBytes: w.sizeBytes,
        regionFiles: await countRegionFiles(p),
      })
    }
  }

  // Modern datapack/mod dimensions: dimensions/<namespace>/<name>
  try {
    const nsDir = join(worldPath, 'dimensions')
    for (const ns of await fs.readdir(nsDir, { withFileTypes: true })) {
      if (!ns.isDirectory()) continue
      for (const d of await fs.readdir(join(nsDir, ns.name), { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const p = join(nsDir, ns.name, d.name)
        const w = await walk(p)
        dims.push({
          path: `dimensions/${ns.name}/${d.name}`,
          kind: 'custom',
          sizeBytes: w.sizeBytes,
          regionFiles: await countRegionFiles(p),
        })
      }
    }
  } catch {
    // No dimensions directory: fine, most worlds have none.
  }

  return dims
}

/**
 * Enumerate the worlds of one server. `worldDirs` comes from discovery
 * (directories under the server root holding a level.dat), never from a
 * request.
 */
export async function listWorlds(serverDir: string, worldDirs: string[]): Promise<WorldInfo[]> {
  const out: WorldInfo[] = []
  for (const name of worldDirs) {
    const path = join(serverDir, name)
    const started = Date.now()
    const total = await walk(path)
    const dims = await dimensionsOf(path)
    let hasIcon = false
    try {
      await fs.access(join(path, 'icon.png'))
      hasIcon = true
    } catch {
      /* no icon */
    }
    out.push({
      dir: name,
      kind: worldKind(name),
      sizeBytes: total.sizeBytes,
      files: total.files,
      regionFiles: await countRegionFiles(path),
      lastWrittenAt: total.newestMtimeMs > 0 ? new Date(total.newestMtimeMs).toISOString() : null,
      hasIcon,
      dimensions: dims,
      walkMs: Date.now() - started,
    })
  }
  return out
}
