/**
 * Pure-helper tests for the Subagent page's background-task section:
 * tree-membership collection, ordering, and status presentation mapping.
 */
import { describe, expect, it } from 'vitest'
import {
  collectTreeTasks,
  formatTaskDuration,
  isTaskLive,
  orderTasks,
  taskDotState,
  taskStatusLabel,
  treeSessionIds,
} from '../src/client/subagent-tasks.ts'
import type { SidebarSessionSummary, SidebarTaskStatus, SidebarTaskView } from '../src/context-types.ts'

/** The translator stub: renders duration templates like the real locale copy. */
const templates: Record<string, string> = {
  taskDurationSeconds: '{seconds}秒',
  taskDurationMinutes: '{minutes}分{seconds}秒',
  taskDurationHours: '{hours}小时{minutes}分',
}
const t = (key: string, params?: Record<string, string | number>): string => {
  let text = templates[key] ?? key
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

function summary(id: string, over: Partial<SidebarSessionSummary> = {}): SidebarSessionSummary {
  return { id, displayTitle: `title-${id}`, ...over }
}

function task(id: string, over: Partial<SidebarTaskView> = {}): SidebarTaskView {
  return { id, kind: 'bash', label: `cmd ${id}`, status: 'running', startedAt: 1_000, ...over }
}

describe('treeSessionIds', () => {
  it('includes the root and every subagent-origin session whose chain reaches it', () => {
    const byId = {
      root: summary('root'),
      child: summary('child', { origin: 'subagent', parentId: 'root' }),
      grand: summary('grand', { origin: 'subagent', parentId: 'child' }),
      orphan: summary('orphan', { origin: 'subagent', parentId: 'gone' }),
      other: summary('other', { origin: 'subagent', parentId: 'other-root' }),
    }
    const ids = treeSessionIds(byId, 'root')
    expect([...ids].sort()).toEqual(['child', 'grand', 'root'])
  })

  it('fails soft on parent cycles and yields nothing without a root', () => {
    const byId = {
      root: summary('root'),
      a: summary('a', { origin: 'subagent', parentId: 'b' }),
      b: summary('b', { origin: 'subagent', parentId: 'a' }),
    }
    expect(treeSessionIds(byId, 'root').size).toBe(1)
    expect(treeSessionIds(byId, undefined).size).toBe(0)
  })
})

describe('collectTreeTasks', () => {
  it('collects tasks of the whole tree with owner titles, ignoring outside sessions', () => {
    const byId = {
      root: summary('root'),
      child: summary('child', { origin: 'subagent', parentId: 'root' }),
    }
    const tasksBySession = {
      root: [task('bash-1')],
      child: [task('bash-2', { status: 'completed', finishedAt: 2_000 })],
      stranger: [task('bash-9')],
    }
    const rows = collectTreeTasks(byId, tasksBySession, 'root')
    expect(rows.map(row => [row.ownerSessionId, row.ownerTitle, row.task.id]))
      .toEqual([['root', 'title-root', 'bash-1'], ['child', 'title-child', 'bash-2']])
  })

  it('returns an empty list for an absent mirror or empty sets', () => {
    const byId = { root: summary('root') }
    expect(collectTreeTasks(byId, undefined, 'root')).toEqual([])
    expect(collectTreeTasks(byId, {}, 'root')).toEqual([])
  })
})

describe('orderTasks', () => {
  it('puts live rows first in start order, then settled rows newest-first', () => {
    const row = (id: string, status: SidebarTaskStatus, startedAt: number, finishedAt?: number) => ({
      ownerSessionId: 'root',
      ownerTitle: 'root',
      task: task(id, { status, startedAt, ...(finishedAt !== undefined ? { finishedAt } : {}) }),
    })
    const rows = [
      row('old-settled', 'completed', 1_000, 2_000),
      row('live-2', 'running', 4_000),
      row('new-settled', 'killed', 1_500, 1_800),
      row('live-1', 'stopping', 3_000),
    ]
    expect(orderTasks(rows).map(r => r.task.id)).toEqual(['live-1', 'live-2', 'old-settled', 'new-settled'])
  })
})

describe('status presentation helpers', () => {
  it('treats running and stopping as live', () => {
    expect(isTaskLive(task('a', { status: 'running' }))).toBe(true)
    expect(isTaskLive(task('b', { status: 'stopping' }))).toBe(true)
    expect(isTaskLive(task('c', { status: 'completed' }))).toBe(false)
    expect(isTaskLive(task('d', { status: 'killed' }))).toBe(false)
    expect(isTaskLive(task('e', { status: 'failed' }))).toBe(false)
  })

  it('maps the five wire statuses to dot states and localized labels', () => {
    expect(taskDotState('running')).toBe('ongoing')
    expect(taskDotState('stopping')).toBe('warning')
    expect(taskDotState('completed')).toBe('done')
    expect(taskDotState('killed')).toBe('warning')
    expect(taskDotState('failed')).toBe('error')
    expect(taskStatusLabel('running', t)).toBe('taskStatusRunning')
    expect(taskStatusLabel('stopping', t)).toBe('taskStatusStopping')
    expect(taskStatusLabel('completed', t)).toBe('taskStatusCompleted')
    expect(taskStatusLabel('killed', t)).toBe('taskStatusKilled')
    expect(taskStatusLabel('failed', t)).toBe('taskStatusFailed')
  })

  it('formats durations in at most two adjacent units', () => {
    expect(formatTaskDuration(0, t)).toBe('0秒')
    expect(formatTaskDuration(45_000, t)).toBe('45秒')
    expect(formatTaskDuration(90_000, t)).toBe('1分30秒')
    expect(formatTaskDuration(3_661_000, t)).toBe('1小时1分')
    // Negative or fractional input clamps to zero seconds.
    expect(formatTaskDuration(-5, t)).toBe('0秒')
  })
})
