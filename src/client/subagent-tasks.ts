/**
 * Pure derivations for the Subagent page's background-task section. Kept
 * framework-free so the node test environment can unit-test them: the task
 * rows arrive through the harness `session/tasks` push mirror
 * (`tasksBySession` in the sessions list feed) — nothing here issues
 * requests, and the row ordering / status mapping mirror the official
 * ui-task header list.
 */
import type {
  SidebarSessionList,
  SidebarSessionSummary,
  SidebarTaskStatus,
  SidebarTaskView,
} from '../context-types.ts'
import type { CopyKey } from './locales.ts'

/** One row of the tasks section: the task plus its owning session's title. */
export interface TreeTask {
  ownerSessionId: string
  ownerTitle: string
  task: SidebarTaskView
}

/** Whether the registry still holds the task open (its duration ticks). */
export function isTaskLive(task: SidebarTaskView): boolean {
  return task.status === 'running' || task.status === 'stopping'
}

/**
 * Every session id of the topology tree rooted at `rootId` (the root plus
 * each session whose uninterrupted subagent-origin chain reaches it — same
 * lineage semantics as {@link countSubagentDescendants}; cycles fail soft).
 * Sessions outside the tree (orphans, other trees) are excluded, so the
 * tasks section never shows foreign work.
 */
export function treeSessionIds(
  byId: SidebarSessionList['byId'],
  rootId: string | undefined,
): Set<string> {
  const ids = new Set<string>()
  if (rootId === undefined) return ids
  for (const summary of Object.values(byId)) {
    const seen = new Set<string>()
    let current: SidebarSessionSummary | undefined = summary
    let reachesRoot = false
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id)
      if (current.id === rootId) {
        reachesRoot = true
        break
      }
      if (current.origin !== 'subagent' || current.parentId === undefined) break
      current = byId[current.parentId]
    }
    if (reachesRoot) ids.add(summary.id)
  }
  return ids
}

/**
 * Collect the background tasks of the whole current tree, owner-labeled.
 * Sessions without a mirror entry contribute nothing; an absent mirror
 * (runtime older than the tasks feed) yields an empty list.
 */
export function collectTreeTasks(
  byId: SidebarSessionList['byId'],
  tasksBySession: Readonly<Record<string, readonly SidebarTaskView[]>> | undefined,
  rootId: string | undefined,
): TreeTask[] {
  const rows: TreeTask[] = []
  if (tasksBySession === undefined) return rows
  for (const sessionId of treeSessionIds(byId, rootId)) {
    const tasks = tasksBySession[sessionId]
    if (tasks === undefined || tasks.length === 0) continue
    const ownerTitle = byId[sessionId]?.displayTitle ?? sessionId
    for (const task of tasks) rows.push({ ownerSessionId: sessionId, ownerTitle, task })
  }
  return rows
}

/**
 * Live rows first in start order, then settled rows newest-first (mirror of
 * the official ui-task ordering); a tie falls back to start order so the
 * sort never depends on the host's map iteration.
 */
export function orderTasks(rows: readonly TreeTask[]): TreeTask[] {
  return [...rows].sort((left, right) => {
    const liveLeft = isTaskLive(left.task)
    if (liveLeft !== isTaskLive(right.task)) return liveLeft ? -1 : 1
    if (liveLeft) return left.task.startedAt - right.task.startedAt
    const finished = (right.task.finishedAt ?? right.task.startedAt) - (left.task.finishedAt ?? left.task.startedAt)
    return finished !== 0 ? finished : left.task.startedAt - right.task.startedAt
  })
}

/** The sidebar's StateDot states for the five wire statuses. */
export type TaskDotState = 'ongoing' | 'warning' | 'done' | 'error'

/**
 * Status marker semantics. `stopping` and `killed` share the attention
 * color: both mean the work ended (or is ending) on request rather than on
 * its own.
 */
export function taskDotState(status: SidebarTaskStatus): TaskDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'stopping': return 'warning'
    case 'completed': return 'done'
    case 'killed': return 'warning'
    case 'failed': return 'error'
  }
}

/** Human status word of one wire status (localized through the passed translator). */
export function taskStatusLabel(
  status: SidebarTaskStatus,
  t: (key: CopyKey, params?: Record<string, string | number>) => string,
): string {
  switch (status) {
    case 'running': return t('taskStatusRunning')
    case 'stopping': return t('taskStatusStopping')
    case 'completed': return t('taskStatusCompleted')
    case 'killed': return t('taskStatusKilled')
    case 'failed': return t('taskStatusFailed')
  }
}

/**
 * Elapsed time in at most two adjacent units (mirror of the official
 * ui-task duration wording). A background task that outlives an hour is
 * already exceptional, so hours is the widest unit.
 */
export function formatTaskDuration(
  elapsedMs: number,
  t: (key: CopyKey, params?: Record<string, string | number>) => string,
): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1_000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3_600)
  if (hours > 0) return t('taskDurationHours', { hours, minutes })
  if (minutes > 0) return t('taskDurationMinutes', { minutes, seconds })
  return t('taskDurationSeconds', { seconds })
}
