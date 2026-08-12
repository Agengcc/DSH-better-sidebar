/**
 * Host route tests for the background-task API ('tasks.output' / 'tasks.kill').
 * 'tasks.output' REPLAYS the output the model has read so far from the owner
 * session's event log (tool/call + tool/result pairs of task_output calls) —
 * the model's cursor is never touched, so nothing is stolen and unread tasks
 * report `read: false`. 'tasks.kill' uses the registry's stock kill, fenced
 * by the owning session, with a 503 when the registry is absent.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildTasksApi } from '../src/tasks-routes.ts'
import { SidebarError } from '../src/wire.ts'
import type { Context, SidebarSessionEvent } from '../src/context-types.ts'

/** A context whose `get` serves only the tasks/agents faces, with a session store. */
function ctxWith(sessions: unknown, tasks: unknown, agents: unknown): Context {
  return {
    sessions,
    get: (key: string) => (key === 'tasks' ? tasks : key === 'agents' ? agents : undefined),
  } as unknown as Context
}

/** A stub live agent (the fence compares `id` only). */
const agent = (id: string) => ({ id, session: { header: { cwd: '/p' } } })

/** One task_output tool/call event. */
function taskOutputCall(seq: number, callId: string, taskId: string): SidebarSessionEvent {
  return { type: 'tool/call', seq, time: seq, data: { name: 'task_output', callId, arguments: JSON.stringify({ task_id: taskId }) } }
}

/** One tool/result event carrying the finalized text the model received. */
function taskOutputResult(seq: number, callId: string, text: string, over: { isError?: boolean } = {}): SidebarSessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: {
      message: {
        source: { kind: 'tool', callId },
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          isError: over.isError === true,
          content: [{ type: 'text', text }],
        }],
      },
    },
  }
}

/** The owner session with the given event log. */
function session(events: SidebarSessionEvent[]): unknown {
  return { header: { cwd: '/p' }, events }
}

describe('tasks.output route (event replay)', () => {
  it('concatenates the task_output results the model read for the task, oldest first', () => {
    const events = [
      taskOutputCall(0, 'c1', 'bash-1'),
      taskOutputResult(1, 'c1', 'line1\nline2\n[status: running]'),
      taskOutputCall(2, 'c2', 'bash-1'),
      taskOutputResult(3, 'c2', 'line3\n[status: completed, exit code: 0]'),
      // Another task's reads are ignored.
      taskOutputCall(4, 'c3', 'bash-2'),
      taskOutputResult(5, 'c3', 'other task output'),
    ]
    const api = buildTasksApi(ctxWith({ get: () => session(events) }, undefined, undefined), 512 * 1024)
    expect(api.output({ sessionId: 's1', id: 'bash-1' })).toEqual({
      text: 'line1\nline2\n[status: running]\nline3\n[status: completed, exit code: 0]',
      truncated: false,
      read: true,
    })
  })

  it('skips the controller\'s "(no new output)" deltas and error results', () => {
    const events = [
      taskOutputCall(0, 'c1', 'bash-1'),
      taskOutputResult(1, 'c1', 'real output\n[status: running]'),
      taskOutputCall(2, 'c2', 'bash-1'),
      taskOutputResult(3, 'c2', '(no new output)\n[status: running]'),
      taskOutputCall(4, 'c3', 'bash-1'),
      taskOutputResult(5, 'c3', 'boom', { isError: true }),
    ]
    const api = buildTasksApi(ctxWith({ get: () => session(events) }, undefined, undefined), 512 * 1024)
    expect(api.output({ sessionId: 's1', id: 'bash-1' })).toEqual({
      text: 'real output\n[status: running]',
      truncated: false,
      read: true,
    })
  })

  it('reports read:false until the model reads the task (no registry call at all)', () => {
    const events = [taskOutputCall(0, 'c1', 'bash-2')]
    const tasks = { kill: vi.fn() }
    const api = buildTasksApi(ctxWith({ get: () => session(events) }, tasks, undefined), 100)
    expect(api.output({ sessionId: 's1', id: 'bash-1' })).toEqual({ text: '', truncated: false, read: false })
    // The replay never touches the registry — the model's cursor is safe by construction.
    expect(tasks.kill).not.toHaveBeenCalled()
  })

  it('caps oversized replays with the truncated flag', () => {
    const events = [taskOutputCall(0, 'c1', 'bash-1'), taskOutputResult(1, 'c1', 'x'.repeat(10_000))]
    const api = buildTasksApi(ctxWith({ get: () => session(events) }, undefined, undefined), 100)
    const value = api.output({ sessionId: 's1', id: 'bash-1' })
    expect(value.text).toBe('x'.repeat(100))
    expect(value.truncated).toBe(true)
    expect(value.read).toBe(true)
  })

  it('rejects a missing sessionId or id as bad-request', () => {
    const api = buildTasksApi(ctxWith({ get: () => undefined }, undefined, undefined), 100)
    expect(() => api.output({ id: 'bash-1' })).toThrowError(expect.objectContaining<Partial<SidebarError>>({ code: 'bad-request' }))
    expect(() => api.output({ sessionId: 's1' })).toThrowError(expect.objectContaining<Partial<SidebarError>>({ code: 'bad-request' }))
  })
})

describe('tasks.kill route', () => {
  it('kills with the forwarded reason and the live caller', () => {
    const tasks = { kill: vi.fn(() => 'requested' as const) }
    const agents = { get: vi.fn((id: string) => agent(id)) }
    const api = buildTasksApi(ctxWith({ get: () => undefined }, tasks, agents), 100)
    expect(api.kill({ sessionId: 's1', id: 'bash-1', reason: 'user pressed stop' }))
      .toEqual({ ok: true, outcome: 'requested' })
    expect(tasks.kill).toHaveBeenCalledWith('bash-1', agent('s1'), 'user pressed stop')
  })

  it('defaults the reason when none is supplied', () => {
    const tasks = { kill: vi.fn(() => 'already-finished' as const) }
    const api = buildTasksApi(ctxWith({ get: () => undefined }, tasks, undefined), 100)
    expect(api.kill({ sessionId: 's1', id: 'bash-1' })).toEqual({ ok: true, outcome: 'already-finished' })
    expect(tasks.kill).toHaveBeenCalledWith('bash-1', undefined, 'user requested via sidebar')
  })

  it('maps registry refusals to a 404 task-error', () => {
    const tasks = { kill: vi.fn(() => { throw new Error('unknown task bash-9') }) }
    const api = buildTasksApi(ctxWith({ get: () => undefined }, tasks, undefined), 100)
    expect(() => api.kill({ sessionId: 's1', id: 'bash-9' })).toThrowError(
      expect.objectContaining<Partial<SidebarError>>({ code: 'task-error', status: 404 }),
    )
  })

  it('degrades to a 503 when the tasks registry is absent (output keeps working)', () => {
    const api = buildTasksApi(ctxWith({ get: () => session([]) }, undefined, undefined), 100)
    expect(() => api.kill({ sessionId: 's1', id: 'bash-1' })).toThrowError(
      expect.objectContaining<Partial<SidebarError>>({ code: 'task-error', status: 503 }),
    )
    expect(api.output({ sessionId: 's1', id: 'bash-1' })).toEqual({ text: '', truncated: false, read: false })
  })
})
