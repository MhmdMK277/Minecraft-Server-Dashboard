import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { LaunchStrategy } from '@shared/api'

const exec = promisify(execFile)

/**
 * How a server gets started, discovered rather than configured.
 *
 * The asymmetry that shapes this whole file: **stopping is universal, starting is
 * not.** RCON `stop` works on any server that has RCON, regardless of how it came
 * to exist. Starting has to reproduce whatever mechanism the operator already
 * uses, and if we cannot identify that mechanism the honest answer is to say so
 * and offer no button -- not to guess at a command line and spawn something.
 *
 * Detection order is deliberate. A server that has a scheduled task must be
 * started THROUGH that task, not by spawning its `start.bat` ourselves: the task
 * carries a working directory, a user context and a session, and a server started
 * the other way is a different beast from the one that boots at 05:00. Getting
 * this wrong is not hypothetical here -- the whole of spec §14 exists because
 * task-started and hand-started processes behave differently.
 *
 *   windows-task  a scheduled task whose action names this directory
 *   script        start.bat / start.sh in the directory, spawned detached
 *   none          nothing found; the UI says so and does not offer a start
 *
 * `systemd` and `command` are named in the design and are not implemented,
 * because they cannot be tested on this host and an untested launcher is how you
 * get two JVMs on one world. They are absent rather than stubbed.
 */

export type Launcher =
  | { strategy: 'windows-task'; taskName: string; detail: string }
  | { strategy: 'script'; script: string; detail: string }
  | { strategy: 'none'; detail: string }

const SCRIPTS = ['start.bat', 'start.cmd', 'start.sh']

/**
 * Scheduled tasks whose action mentions a directory, keyed by normalised path.
 *
 * One enumeration for the whole fleet rather than one query per server: this is
 * the same N+1 mistake the identity provider already made once, and control
 * routes are allowed to be slower than the scan but not gratuitously so.
 */
export type TaskIndex = Map<string, string>

const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()

const TASK_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @()
foreach ($t in Get-ScheduledTask) {
  foreach ($a in $t.Actions) {
    $wd = $a.WorkingDirectory
    $args = $a.Arguments
    if ($wd -or $args) {
      $out += [pscustomobject]@{
        name = $t.TaskName
        path = $t.TaskPath
        wd   = [string]$wd
        args = [string]$args
        exec = [string]$a.Execute
      }
    }
  }
}
$out | ConvertTo-Json -Compress -Depth 3
`

/** Extract a server directory from a task action, the same shapes spec §1 lists. */
function dirFromAction(wd: string, args: string): string | null {
  if (wd) return wd
  const m = args.match(/"?([A-Za-z]:\\(?:[^"<>|?*\r\n]+?))\\[^\\"]+\.(?:bat|cmd|ps1|sh)"?/i)
  return m?.[1] ?? null
}

/**
 * How long a task index may be reused.
 *
 * `Get-ScheduledTask` over every task on the machine costs ~870 ms here, measured,
 * and it was the slowest thing in a scan that runs every ten seconds -- slower than
 * the identity probe it runs alongside. It answers "has a scheduled task been
 * created, renamed or repointed", which changes about once a month.
 *
 * So it is cached. A control action passes `maxAgeMs = 0` to force a fresh read,
 * because that is the moment correctness matters and the moment someone may have
 * just created the task they are trying to use -- and one extra second on a button
 * press nobody notices.
 */
export const TASK_CACHE_MS = 60_000

let cached: { at: number; index: TaskIndex } | null = null

/** Test seam, and used after anything that could create a task. */
export function invalidateTaskIndex(): void {
  cached = null
}

export async function indexTasks(maxAgeMs = TASK_CACHE_MS): Promise<TaskIndex> {
  // `maxAgeMs > 0` is not redundant. Without it, `indexTasks(0)` -- which means
  // "do not use the cache" -- still hits it whenever the cache was written in the
  // same millisecond, because `0 <= 0`. A control action firing right after a scan
  // would then act on the stale index it was explicitly asking to bypass.
  if (cached && maxAgeMs > 0 && Date.now() - cached.at <= maxAgeMs) return cached.index

  const index: TaskIndex = new Map()
  if (process.platform !== 'win32') {
    cached = { at: Date.now(), index }
    return index
  }
  let raw = ''
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TASK_SCRIPT], {
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
    raw = stdout.trim()
  } catch {
    // Cached even on failure: retrying an 870 ms enumeration every ten seconds
    // because it failed once is how a transient problem becomes a permanent cost.
    cached = { at: Date.now(), index }
    return index
  }
  if (!raw) {
    cached = { at: Date.now(), index }
    return index
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    cached = { at: Date.now(), index }
    return index
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  for (const r of rows as Array<Record<string, unknown>>) {
    const dir = dirFromAction(String(r.wd ?? ''), String(r.args ?? ''))
    if (!dir) continue
    const path = String(r.path ?? '\\')
    const name = String(r.name ?? '')
    if (!name) continue
    const full = path.endsWith('\\') ? `${path}${name}` : `${path}\\${name}`
    // First match wins, so a duplicate task cannot silently replace the one the
    // operator has been using.
    if (!index.has(norm(dir))) index.set(norm(dir), full)
  }
  cached = { at: Date.now(), index }
  return index
}

export function detectLauncher(dir: string, tasks: TaskIndex): Launcher {
  const task = tasks.get(norm(dir))
  if (task) {
    return {
      strategy: 'windows-task',
      taskName: task,
      detail: `Started by the scheduled task "${task}". The dashboard will run that task rather than launching the jar itself, so the server comes up in the same session and context it does at boot.`,
    }
  }
  for (const s of SCRIPTS) {
    if (existsSync(join(dir, s))) {
      return {
        strategy: 'script',
        script: s,
        detail: `No scheduled task names this directory, so ${s} would be run directly. Note that a server started this way runs in a different session from one started by a task.`,
      }
    }
  }
  return {
    strategy: 'none',
    detail:
      'No scheduled task and no start script were found for this directory, so the dashboard does not know how this server starts and will not guess. Stopping still works over RCON. Add a scheduled task or a start script, or start it the way you normally do.',
  }
}

export function launchStrategyOf(l: Launcher): LaunchStrategy {
  return l.strategy
}

/**
 * Actually start it. Returns nothing useful on success: the caller must verify by
 * watching for a JVM to appear, because every mechanism here is fire-and-forget
 * and an exit code of 0 from `Start-ScheduledTask` means "the task was launched",
 * not "the server is running".
 */
export async function invokeLauncher(dir: string, l: Launcher): Promise<void> {
  if (l.strategy === 'none') throw new Error('no launcher is known for this server')

  if (l.strategy === 'windows-task') {
    const path = l.taskName.slice(0, l.taskName.lastIndexOf('\\') + 1) || '\\'
    const leaf = l.taskName.slice(l.taskName.lastIndexOf('\\') + 1)
    // Passed as parameters rather than interpolated into the command string, so a
    // task name containing a quote cannot become part of the script.
    await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Start-ScheduledTask -TaskPath $env:MCDASH_TASK_PATH -TaskName $env:MCDASH_TASK_NAME',
      ],
      {
        timeout: 60_000,
        windowsHide: true,
        env: { ...process.env, MCDASH_TASK_PATH: path, MCDASH_TASK_NAME: leaf },
      },
    )
    return
  }

  const script = join(dir, l.script)

  if (process.platform !== 'win32') {
    const child = spawn(script, [], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      shell: false,
    })
    child.unref()
    return
  }

  /**
   * Launching a .bat on Windows, and why it looks like this.
   *
   * Since the fix for CVE-2024-27980, Node refuses to spawn a .bat directly
   * (EINVAL) unless a shell is involved -- cmd.exe's argument parsing WAS the
   * vulnerability. So cmd.exe is named explicitly.
   *
   * The path must be ABSOLUTE, not a bare filename with `cwd` doing the work. The
   * parent cmd.exe's command line is identity signal 2 (spec §1), and a relative
   * `start.bat` leaves the launched JVM with a parent command line containing no
   * directory at all -- so nothing can attribute it, and the post-start
   * verification loop waits out its full timeout staring at the very process it is
   * waiting for. That was measured, not imagined.
   *
   * The quoting is the doubled form under `/s`, which is the only one of four
   * variants that works. Verified against a directory named `MC Fake & Co`:
   *
   *   /d /s /c <path>       node-escaped  -> cmd splits at the space, fails
   *   /d /c    <path>       node-escaped  -> same
   *   /d /c    "<path>"     verbatim      -> same
   *   /d /s /c ""<path>""   verbatim      -> works
   *
   * `/s` strips exactly one outer quote pair and takes the remainder verbatim, so
   * the inner pair is what survives to protect the spaces. `/d` skips AutoRun.
   *
   * `windowsVerbatimArguments` makes the quoting ours to get right, so: a Windows
   * path cannot contain `"` -- it is reserved, along with `<>:|?*` -- which is what
   * makes wrapping in quotes safe rather than hopeful. The check below states that
   * reasoning where it can fail loudly instead of silently becoming an injection.
   */
  if (script.includes('"')) {
    throw new Error('refusing to launch: the script path contains a quote character')
  }

  // Detached and unref'd, so the dashboard restarting does not take the server
  // with it -- the whole attach model is that these servers outlive us.
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `""${script}""`], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: true,
  })
  child.unref()
}
