import type { MemoryReading } from '@shared/api'
import type { JvmProcess } from './platform/types'

/**
 * The memory-eviction reading (stall investigation, 2026-08-02).
 *
 * The mechanism this makes visible, established by correlating GC logs
 * against host hard-fault rates: a process at low memory priority has its
 * pages trimmed first whenever anything does bulk file I/O, regardless of
 * free RAM. Its heap ages out of residency, and the next garbage collection
 * that walks old regions reads them back from disk, which is how a "50 ms"
 * collector produces a multi-second stop-the-world on an otherwise idle
 * machine. Both inputs here are READ, not inferred: the working set and
 * private bytes come from the process table, the priority from the
 * scheduled task that launches the server.
 *
 * The dashboard reports the condition and stops there. Changing a task's
 * priority changes how the operator's servers are scheduled, so it is the
 * operator's act, done in Task Scheduler, never a button here.
 */

/**
 * Task Scheduler priorities 7 through 10 run the action BelowNormal or
 * lower, and, the part that matters here, at LOW memory/page priority.
 * 7 is the silent default for a task created without touching the setting.
 */
export const LOW_TASK_PRIORITY_MIN = 7

/** Win32_Process.Priority at or below this is BelowNormal. Normal is 8. */
export const LOW_BASE_PRIORITY_MAX = 6

/**
 * Below this share resident, a full-heap walk is mostly disk reads. The
 * fleet this was measured on idled at 4-15% residency under low priority;
 * 50 is deliberately generous so the flag reads "exposed", not "on fire".
 */
export const RESIDENCY_VULNERABLE_PCT = 50

export function residencyReading(
  jvm: JvmProcess | null,
  taskPriority: number | null,
): MemoryReading | null {
  if (!jvm || jvm.workingSetMb === null || jvm.privateMb === null || jvm.privateMb <= 0) {
    return null
  }
  const residencyPercent = Math.round((jvm.workingSetMb / jvm.privateMb) * 100)
  // The LIVE process is the authority: a task edited after the process
  // started changes nothing until the next launch, and the reading must not
  // say the fix is in before it is. The task's setting is the fallback only
  // when the process's own priority could not be read.
  const lowPriority =
    jvm.basePriority !== null
      ? jvm.basePriority <= LOW_BASE_PRIORITY_MAX
      : taskPriority !== null && taskPriority >= LOW_TASK_PRIORITY_MIN
  const vulnerable = lowPriority && residencyPercent < RESIDENCY_VULNERABLE_PCT
  const taskFixed =
    lowPriority && taskPriority !== null && taskPriority < LOW_TASK_PRIORITY_MIN

  let detail: string
  if (vulnerable) {
    detail =
      `${residencyPercent}% of this process's ${Math.round(jvm.privateMb)} MB is in RAM, and it runs at ` +
      `${jvm.basePriority !== null ? `base priority ${jvm.basePriority} (BelowNormal)` : `low priority (its task's Settings.Priority=${taskPriority})`}, ` +
      `so Windows trims its pages first whenever anything does bulk file I/O, however much RAM is free. ` +
      `A garbage collection that walks the non-resident part reads it back from disk, which is how ` +
      `multi-second pauses happen on an idle machine. ` +
      (taskFixed
        ? `The scheduled task already says Priority=${taskPriority}; this process was started before that ` +
          `change, which applies at the task's next launch.`
        : `Raising the task's priority to 4-6 (normal) removes the preferential eviction; that is a Task ` +
          `Scheduler change, applied at the task's next launch, and it is yours to make, not this dashboard's.`)
  } else if (lowPriority) {
    detail =
      `Runs at low memory priority${jvm.basePriority !== null ? ` (base ${jvm.basePriority})` : ''}, ` +
      `${residencyPercent}% of ${Math.round(jvm.privateMb)} MB resident. Exposure to eviction rises as ` +
      `residency falls.` +
      (taskFixed
        ? ` The task already says Priority=${taskPriority}; the change applies at the next launch.`
        : '')
  } else {
    detail =
      `${residencyPercent}% of ${Math.round(jvm.privateMb)} MB resident, normal memory priority` +
      `${jvm.basePriority !== null ? ` (base ${jvm.basePriority})` : ''}` +
      `${taskPriority !== null ? `, scheduled-task Priority=${taskPriority}` : ''}.`
  }

  return {
    workingSetMb: Math.round(jvm.workingSetMb),
    privateMb: Math.round(jvm.privateMb),
    residencyPercent,
    taskPriority,
    processPriority: jvm.basePriority,
    lowPriority,
    vulnerable,
    detail,
  }
}
