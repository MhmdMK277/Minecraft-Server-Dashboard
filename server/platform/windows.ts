import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { observerBlockedMs } from '../loopguard'
import { parseXmx } from '../parse'
import type {
  DirHint,
  JvmProcess,
  JvmScan,
  ProcessProvider,
  StartedBy,
  UnattributedJvm,
} from './types'

const exec = promisify(execFile)

/**
 * Windows process provider.
 *
 * PORT IS NOT IDENTITY. A dormant duplicate directory can declare the same
 * server-port as a live one, so asking "who is listening on 25565?" reports the
 * wrong directory as running. The java command line is no better: two Paper
 * servers both show `-jar paper.jar`, and two Forge servers show an identical
 * win_args.txt argument. See docs/liveness-spec.md §1.
 *
 * THREE SIGNALS, in order of strength.
 *
 * 1. **The scheduled task that launched it.** The Task Scheduler COM API lists
 *    running tasks with the PID of the process each one launched, and the task
 *    definition carries the server directory in its action's WorkingDirectory.
 *    So: task -> engine PID -> java descendant -> directory. Nothing privileged,
 *    no subprocess per server, and it is authoritative because it comes from the
 *    thing that actually did the launching.
 *
 * 2. **Parent launcher command line.** Exact when readable.
 *
 * 3. **`logs/latest.log` held open, cross-referenced with the declared port.**
 *
 * Why three. Signal 2 was the only one, and it has a blind spot that took a
 * reboot to find: a task with `LogonType = S4U` and a boot trigger runs its
 * action in session 0, and an unelevated WMI query returns an EMPTY
 * `CommandLine` for such a process. On the first machine where the boot tasks
 * actually fired, all four servers became unattributable at once and a
 * completely healthy box rendered as four DOWN cards.
 *
 * Signal 3 was added first and rescued the situation, but it is a poor primary:
 * it infers identity from side effects rather than reading it from the launcher,
 * and it costs a listening-socket enumeration. Signal 1 covers the case that
 * broke -- scheduler-started servers, which is the production case -- from the
 * authoritative source, so it goes first. Signal 3 remains for servers nobody
 * scheduled: started by hand, by a wrapper, or by another tool.
 *
 * The Task Scheduler *event log* would give the same mapping, and is the obvious
 * place to look for it, but `Microsoft-Windows-TaskScheduler/Operational` is
 * DISABLED by default on Windows 10 -- confirmed on this host, `IsEnabled False`
 * with zero records. Depending on it would mean asking the user to enable a log
 * channel, which needs elevation, to fix a bug caused by needing elevation. The
 * live COM API needs neither and is current rather than historical.
 *
 * Why `logs/latest.log` and not `world/session.lock` for signal 3: measured on
 * this host, Paper 1.21.x, Forge 1.20.1 and Forge 1.7.10 all hold
 * `logs/latest.log`, but GTNH (1.7.10) does NOT hold `session.lock` (spec §2).
 * A signal that silently fails on the oldest pack is worse than no signal.
 *
 * Node cannot perform the lock test itself -- `fs.open` on Windows always
 * requests FILE_SHARE_READ|WRITE|DELETE and so succeeds while the JVM holds the
 * file. It has to be a share-denying CreateFile, which is one reason the whole
 * scan happens in a single PowerShell call.
 */

/**
 * One PowerShell invocation per scan, and one WMI enumeration inside it.
 *
 * Cost is a first-class concern here, not an afterthought: this runs every ten
 * seconds, and spec §11 is the rule that the observer must not bill its own
 * delay to a server. An earlier version issued one `Get-CimInstance` per JVM to
 * fetch each parent, which is N+1 WMI round trips. Now the process table is
 * fetched once and indexed.
 *
 * Candidate directories arrive through the environment rather than interpolated
 * into the script. Directory names here contain spaces, quotes and `$`, and
 * building a PowerShell literal out of filesystem paths is how a scan becomes an
 * injection.
 */
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$t = [System.Diagnostics.Stopwatch]::StartNew()
$phases = @{}
function Phase($n) { $phases[$n] = $t.ElapsedMilliseconds; $t.Restart() }

# One pass over the process table, and every field taken from it.
# Get-Process was used here for WorkingSet64/PrivateMemorySize64/StartTime and
# cost ~20 ms per JVM for data Win32_Process already carries.
$all = @{}
foreach ($p in Get-CimInstance Win32_Process) { $all[[int]$p.ProcessId] = $p }
Phase 'processes'

$parents = @()
$jvms = @()
foreach ($k in $all.Keys) {
  $p = $all[$k]
  $parents += ,@($k, [int]$p.ParentProcessId)
  if ($p.Name -ne 'java.exe' -and $p.Name -ne 'javaw.exe') { continue }
  $par = $all[[int]$p.ParentProcessId]
  $jvms += [pscustomobject]@{
    pid       = [int]$p.ProcessId
    ppid      = [int]$p.ParentProcessId
    sessionId = [int]$p.SessionId
    parentCmd = if ($par) { $par.CommandLine } else { '' }
    ownCmd    = $p.CommandLine
    ws        = $p.WorkingSetSize
    priv      = $p.PrivatePageCount
    # Base scheduling priority of the LIVE process (6 = BelowNormal, 8 =
    # Normal). Read so a task whose Priority was fixed cannot make a process
    # started before the fix read as already-fixed.
    basePri   = [int]$p.Priority
    # Cumulative CPU since process start, in 100-nanosecond units, kernel plus
    # user. A COUNTER, not a rate: the rate is differenced across scans in
    # server/history.ts, where a pid change can be seen and the sample dropped.
    cpu100ns  = [double]$p.KernelModeTime + [double]$p.UserModeTime
    start     = if ($p.CreationDate) { $p.CreationDate.ToString('o') } else { $null }
  }
}
Phase 'index'

# Signal 1. Running scheduled tasks, the PID each launched, and the directory
# its action names. Unelevated; the operational event log is DISABLED by default
# on Windows 10 and turning it on needs elevation.
$tasks = @()
try {
  $svc = New-Object -ComObject Schedule.Service
  $svc.Connect()
  foreach ($r in $svc.GetRunningTasks(0)) {
    $leaf = Split-Path $r.Path -Leaf
    $folder = Split-Path $r.Path -Parent
    if (-not $folder) { $folder = '\\' }
    $def = $null
    try { $def = $svc.GetFolder($folder).GetTask($leaf).Definition } catch {}
    $wd = ''
    $argline = ''
    if ($def) {
      foreach ($a in $def.Actions) {
        if ($a.WorkingDirectory) { $wd = $a.WorkingDirectory }
        if ($a.Arguments) { $argline = $a.Arguments }
      }
    }
    $tasks += [pscustomobject]@{ name = $leaf; enginePid = [int]$r.EnginePid; dir = $wd; args = $argline }
  }
} catch {}
Phase 'tasks'

# Signal 3, for the directories we were asked about. The handle probe is cheap
# (~2 ms each) and always runs, because a held log is also the evidence that a
# directory is occupied even when no PID can be named.
$dirs = @()
$needPorts = $false
$raw = $env:MCDASH_DIR_HINTS
if ($raw) {
  # Directories already named by a stronger signal. Deliberately a conservative
  # superset: getting this wrong only changes whether we bother enumerating
  # listeners, never who gets attributed -- that decision is made in TypeScript.
  # Separators are normalised before comparing. A servers root configured with
  # forward slashes produces hints with mixed separators, which would never match
  # a task's backslash path -- so this test silently failed and the expensive
  # port enumeration ran on every scan regardless.
  function NKey($p) { return ([string]$p).Replace('/', '\\').TrimEnd('\\').ToLower() }
  $named = @{}
  foreach ($k in $tasks) { if ($k.dir) { $named[(NKey $k.dir)] = $true } }
  foreach ($j in $jvms) {
    $m = [regex]::Match([string]$j.parentCmd, '(?i)([A-Za-z]:\\\\[^"<>|?*\\r\\n]+?)\\\\[^\\\\"]+\\.(bat|cmd|ps1|sh)')
    if ($m.Success) { $named[(NKey $m.Groups[1].Value)] = $true }
  }

  # Iterated straight off the pipeline, NOT via @($raw | ConvertFrom-Json).
  # PowerShell 5.1 emits a JSON array as ONE object and the @() wrapper nested it,
  # so this loop ran a single time with $h bound to all six hints at once, $h.dir
  # member-enumerated into an array of six paths, and signal 3 was silently inert.
  # The scheduled-task signal masked it completely. foreach enumerates correctly.
  foreach ($h in ($raw | ConvertFrom-Json)) {
    $log = Join-Path $h.dir 'logs\\latest.log'
    $held = $false
    if (Test-Path -LiteralPath $log) {
      try {
        # dwShareMode = 0. Succeeds only if nothing else holds the file.
        $fs = [System.IO.File]::Open($log, 'Open', 'Read', 'None')
        $fs.Close()
      } catch { $held = $true }
    }
    $dirs += [pscustomobject]@{ dir = $h.dir; logHeld = $held; port = $h.gamePort; listenerPid = $null }
    if ($held -and -not $named.ContainsKey((NKey $h.dir))) { $needPorts = $true }
  }
}
Phase 'handles'

# Listening sockets, ONLY when signal 3 might actually be needed.
# Get-NetTCPConnection costs ~590 ms on this host; netstat costs ~70 ms for the
# same answer, and in the common case where every server was resolved by its
# scheduled task neither is called at all.
#
# BOTH address families, deliberately (found 2026-08-06). "-p TCP" lists the
# IPv4 table only, and a modern vanilla server can sit on ONE dual-stack
# socket that netstat reports as [::]:25570 in the TCPv6 table with no IPv4
# row at all -- Paper and Forge bind both tables, which is why this filter
# looked correct against the fleet and blinded signal 3 for exactly the
# canonically-started vanilla case it exists to catch. A server ran 10 hours
# reading UNKNOWN with its log held open because of this line. Plain
# "netstat -ano" carries both tables; the LISTENING guard in the regex
# already excludes UDP and non-listening rows, and it matches [::]:port.
if ($needPorts) {
  $listeners = @{}
  foreach ($line in (netstat -ano)) {
    $m = [regex]::Match($line, '^\\s+TCP\\s+\\S+:(\\d+)\\s+\\S+\\s+LISTENING\\s+(\\d+)')
    if ($m.Success -and -not $listeners.ContainsKey($m.Groups[1].Value)) {
      $listeners[$m.Groups[1].Value] = [int]$m.Groups[2].Value
    }
  }
  foreach ($d in $dirs) {
    if ($null -ne $d.port) {
      $k = [string][int]$d.port
      if ($listeners.ContainsKey($k)) { $d.listenerPid = $listeners[$k] }
    }
  }
}
Phase 'ports'

[pscustomobject]@{ jvms = $jvms; tasks = $tasks; parents = $parents; dirs = $dirs; phases = $phases; portsEnumerated = $needPorts } |
  ConvertTo-Json -Compress -Depth 4
`

/**
 * Match the server directory out of a launcher command line or task action.
 *
 * Handles the shapes seen in the wild:
 *   cmd.exe /c "C:\...\MC GTNH\start.bat"        -> Task Scheduler / batch
 *   cmd.exe /c ""C:\...\MC Tech\start.bat""      -> doubled quotes
 *   powershell -File C:\...\srv\run.ps1
 * Falls back to a -Duser.dir= property if the launcher set one.
 */
function dirFromCommandLine(parentCmd: string, ownCmd: string): string | null {
  const script = parentCmd.match(/"?([A-Za-z]:\\(?:[^"<>|?*\r\n]+?))\\[^\\"]+\.(?:bat|cmd|ps1|sh)"?/i)
  if (script?.[1]) return script[1]
  const userDir = ownCmd.match(/-Duser\.dir=(?:"([^"]+)"|(\S+))/i)
  if (userDir) return userDir[1] ?? userDir[2] ?? null
  return null
}

const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()

type JvmRow = {
  pid: number
  ppid: number
  sessionId: number | null
  parentCmd: string
  ownCmd: string
  ws: number | null
  priv: number | null
  /** Base scheduling priority of the live process. 6 = BelowNormal, 8 = Normal. */
  basePriority: number | null
  start: number
  /** Cumulative CPU since process start, milliseconds. A counter. */
  cpuMs: number | null
}

async function ps(script: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<string> {
  const { stdout } = await exec(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...env } },
  )
  return stdout.trim()
}

const asArray = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? (v as Array<Record<string, unknown>>) : v ? [v as Record<string, unknown>] : []

/**
 * Proof seam. prove-identity substitutes the PowerShell invocation with a
 * canned process table so the attribution rules run against topologies that
 * cannot be staged safely live -- above all a JVM whose ancestry passes
 * through the dashboard's OWN scheduled task, the shape that misattributed a
 * created server on 2026-08-02. Everything after the substitution is the real
 * code path. Never set outside a proof; pass null to restore.
 */
let psOverride: typeof ps | null = null
export function setPsForProof(fn: typeof ps | null): void {
  psOverride = fn
}

export const windowsProvider: ProcessProvider = {
  platform: 'win32',
  name: 'Windows (scheduled task, then launcher command line, then open log)',
  available: true,

  async scanJvms(hints?: DirHint[]): Promise<JvmScan> {
    const env: NodeJS.ProcessEnv = {}
    if (hints?.length) env.MCDASH_DIR_HINTS = JSON.stringify(hints)

    const t0 = Date.now()
    let raw: string
    try {
      raw = await (psOverride ?? ps)(SCRIPT, env)
    } catch (e) {
      // A failure here must be loud. Reported as ok:false so callers cannot
      // mistake it for "nothing is running", which is what it looks like.
      return {
        jvms: [],
        unattributed: [],
        ok: false,
        failure: e instanceof Error ? e.message : 'process enumeration failed',
        occupiedDirs: [],
        tookMs: Date.now() - t0,
        loopBlockedMs: observerBlockedMs(t0, Date.now()),
        phases: {},
        portsEnumerated: false,
        signal3: [],
      }
    }

    const fail = (why: string): JvmScan => ({
      jvms: [],
      unattributed: [],
      ok: false,
      failure: why,
      occupiedDirs: [],
      tookMs: Date.now() - t0,
      loopBlockedMs: observerBlockedMs(t0, Date.now()),
      phases: {},
      portsEnumerated: false,
      signal3: [],
    })

    if (!raw) return fail('process enumeration returned nothing')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return fail('process enumeration returned unparseable output')
    }
    if (!parsed || typeof parsed !== 'object') return fail('process enumeration returned no object')

    const top = parsed as {
      jvms?: unknown
      tasks?: unknown
      parents?: unknown
      dirs?: unknown
      phases?: unknown
      portsEnumerated?: unknown
    }
    const now = Date.now()

    // ---------------------------------------------------------------- index
    const rows = new Map<number, JvmRow>()
    for (const r of asArray(top.jvms)) {
      const pid = Number(r.pid)
      if (!Number.isFinite(pid)) continue
      rows.set(pid, {
        pid,
        ppid: Number(r.ppid),
        sessionId: Number.isFinite(Number(r.sessionId)) ? Number(r.sessionId) : null,
        parentCmd: String(r.parentCmd ?? ''),
        ownCmd: String(r.ownCmd ?? ''),
        ws: typeof r.ws === 'number' ? Math.round(r.ws / 1048576) : null,
        priv: typeof r.priv === 'number' ? Math.round(r.priv / 1048576) : null,
        basePriority: typeof r.basePri === 'number' ? r.basePri : null,
        start: r.start ? Date.parse(String(r.start)) : NaN,
        // 100-nanosecond units to milliseconds. Still cumulative.
        cpuMs: typeof r.cpu100ns === 'number' ? Math.round(r.cpu100ns / 10_000) : null,
      })
    }

    const parentOf = new Map<number, number>()
    for (const pair of Array.isArray(top.parents) ? top.parents : []) {
      if (Array.isArray(pair) && pair.length === 2) parentOf.set(Number(pair[0]), Number(pair[1]))
    }

    const tasks = asArray(top.tasks)
      .map((t) => ({
        name: String(t.name ?? ''),
        enginePid: Number(t.enginePid),
        // WorkingDirectory when the task sets one; otherwise dig the launcher
        // path out of the action arguments, which are readable even when the
        // resulting process's command line is not.
        dir: String(t.dir ?? '') || dirFromCommandLine(String(t.args ?? ''), '') || '',
      }))
      .filter((t) => Number.isFinite(t.enginePid) && t.dir)

    const engineOf = new Map<number, { name: string; dir: string }>()
    for (const t of tasks) engineOf.set(t.enginePid, { name: t.name, dir: t.dir })

    /** Walk up to a running task engine, bounded against a cyclic pid table. */
    function taskAncestor(pid: number): { name: string; dir: string } | null {
      let cur = pid
      for (let hop = 0; hop < 12; hop++) {
        const parent = parentOf.get(cur)
        if (parent === undefined || parent === 0 || parent === cur) return null
        const hit = engineOf.get(parent)
        if (hit) return hit
        cur = parent
      }
      return null
    }

    function startedBy(row: JvmRow, viaTask: boolean): StartedBy {
      if (viaTask) return 'scheduled-task'
      if (row.sessionId !== null && row.sessionId !== 0) return 'interactive'
      return 'unknown'
    }

    const out: JvmProcess[] = []
    const claimed = new Set<number>()
    const takenDirs = new Set<string>()

    // `task` is the scheduled task found in the row's ancestry, or null.
    // startedBy only needs its existence; taskLaunched additionally requires
    // that it names the directory being attributed, because a task in the
    // ancestry that points elsewhere did not launch this server -- the
    // dashboard's own boot task is the case that made the difference matter.
    const push = (
      row: JvmRow,
      dir: string,
      by: JvmProcess['attributedBy'],
      task: { name: string; dir: string } | null,
    ) => {
      claimed.add(row.pid)
      takenDirs.add(norm(dir))
      out.push({
        pid: row.pid,
        dir,
        workingSetMb: row.ws,
        privateMb: row.priv,
        basePriority: row.basePriority,
        heapMaxMb: parseXmx(row.ownCmd || ''),
        uptimeSeconds: Number.isFinite(row.start) ? Math.round((now - row.start) / 1000) : null,
        cpuMs: row.cpuMs,
        attributedBy: by,
        sessionId: row.sessionId,
        startedBy: startedBy(row, task !== null),
        taskLaunched: task !== null && norm(task.dir) === norm(dir),
      })
    }

    // ------------------------------------------- signal 1: scheduled task
    // Grouped first so a task with two java descendants is recognised as
    // ambiguous rather than resolved arbitrarily.
    const byEngine = new Map<string, JvmRow[]>()
    for (const row of rows.values()) {
      const t = taskAncestor(row.pid)
      if (!t) continue
      // A running task in the ancestry is NOT always the thing that did the
      // launching. This dashboard itself runs from a boot-triggered scheduled
      // task, so a server it starts (the Create page, or a 'script' launcher)
      // is a descendant of the DASHBOARD's task engine -- and this loop
      // attributed the new JVM to the dashboard's own directory. The wrongly
      // claimed pid then blocked signals 2 and 3, and the directory the JVM
      // was actually serving read UNKNOWN with its log held open (observed
      // 2026-08-02, minutes after the Create page started a server). When the
      // JVM's own parent command line names a launcher script in a DIFFERENT
      // directory than the task's, the nearer evidence wins: the row is left
      // for signal 2, which reads that command line. Production servers are
      // unaffected: their parent command lines are either unreadable (S4U
      // session 0, spec §14) or name the same directory as their task.
      const near = dirFromCommandLine(row.parentCmd, row.ownCmd)
      if (near && norm(near) !== norm(t.dir)) continue
      const key = `${t.dir}\u0000${t.name}`
      byEngine.set(key, [...(byEngine.get(key) ?? []), row])
    }
    for (const [key, group] of byEngine) {
      const dir = key.split('\u0000')[0]!
      if (group.length !== 1) continue // ambiguous: never guessed at
      push(group[0]!, dir, 'scheduled-task', taskAncestor(group[0]!.pid))
    }

    // ------------------------------------------ signal 2: the command line
    for (const row of rows.values()) {
      if (claimed.has(row.pid)) continue
      const dir = dirFromCommandLine(row.parentCmd, row.ownCmd)
      if (!dir || takenDirs.has(norm(dir))) continue
      push(row, dir, 'command-line', taskAncestor(row.pid))
    }

    // -------------------------------------- signal 3: open log + the port
    const occupiedDirs: string[] = []
    for (const d of asArray(top.dirs)) {
      const dir = String(d.dir ?? '')
      if (!dir) continue
      if (d.logHeld === true) occupiedDirs.push(dir)
      if (takenDirs.has(norm(dir))) continue
      // Both conditions, always. The held log says a server is serving THIS
      // directory; the listening PID says which process it is. Either alone
      // would be a guess -- a port with no held log is the dormant-duplicate
      // case this whole file exists to get right.
      if (d.logHeld !== true) continue
      const pid = Number(d.listenerPid)
      if (!Number.isFinite(pid) || claimed.has(pid)) continue
      const row = rows.get(pid)
      if (!row) continue // listening, but not a java process we enumerated
      push(row, dir, 'open-log-and-port', taskAncestor(row.pid))
    }

    const unattributed: UnattributedJvm[] = []
    for (const row of rows.values()) {
      if (claimed.has(row.pid)) continue
      unattributed.push({
        pid: row.pid,
        sessionId: row.sessionId,
        startedBy: startedBy(row, taskAncestor(row.pid) !== null),
      })
    }

    return {
      jvms: out,
      unattributed,
      ok: true,
      failure: null,
      occupiedDirs,
      tookMs: Date.now() - t0,
      loopBlockedMs: observerBlockedMs(t0, Date.now()),
      phases: Object.fromEntries(
        Object.entries((top.phases ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 0]),
      ),
      portsEnumerated: top.portsEnumerated === true,
      signal3: asArray(top.dirs).map((d) => ({
        dir: String(d.dir ?? ''),
        logHeld: d.logHeld === true,
        listenerPid: Number.isFinite(Number(d.listenerPid)) && d.listenerPid !== null ? Number(d.listenerPid) : null,
      })),
    }
  },
}
