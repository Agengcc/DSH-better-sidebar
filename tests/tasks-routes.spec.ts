/**
 * Host route tests for the background-task API ('tasks.output' / 'tasks.kill'):
 * caller resolution from the requested session, the non-consuming peek
 * contract (capped, never reported), kill semantics, and the optional-service
 * downgrade when the deployment lacks the tasks registry.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildTasksApi } from '../src/tasks-routes.ts'
import { SidebarError } from '../src/wire.ts'
import type { Context } from '../src/context-types.ts'

/** A context whose `get` serves only the tasks/agents faces. */
function ctxWith(tasks: unknown, agents: unknown): Context {
  return {
    get: (key: string) => (key === 'tasks' ? tasks : key === 'agents' ? agents : undefined),
  } as unknown as Context
}

/** A stub live agent (the fence compares `id` only). */
const agent = (id: string) => ({ id, session: { header: { cwd: '/p' } } })

describe('tasks.output route', () => {
  it('peeks the full output with the live caller of the requested session', () => {
    const tasks = {
      peek: vi.fn(() => ({ text: 'line1\nline2\n', snapshot: { status: 'running' } })),
    }
    const agents = { get: vi.fn((id: string) => agent(id)) }
    const api = buildTasksApi(ctxWith(tasks, agents), 512 * 1024)!
    const value = api.output({ sessionId: 's1', id: 'bash-1' })

    expect(value).toEqual({ text: 'line1\nline2\n', truncated: false, status: 'running' })
    // The caller is the live agent of the OWNING session, and the registry
    // call is a peek (non-consuming by construction of the seam contract).
    expect(agents.get).toHaveBeenCalledWith('s1')
    expect(tasks.peek).toHaveBeenCalledWith('bash-1', agent('s1'))
  })

  it('carries the terminal detail and caps oversized output with the truncated flag', () => {
    const tasks = {
      peek: vi.fn(() => ({
        text: 'x'.repeat(10_000),
        snapshot: { status: 'completed', detail: 'exit code: 0' },
      })),
    }
    const api = buildTasksApi(ctxWith(tasks, undefined), 100)!
    const value = api.output({ sessionId: 's1', id: 'bash-1' })

    expect(value.text).toBe('x'.repeat(100))
    expect(value.truncated).toBe(true)
    expect(value.status).toBe('completed')
    expect(value.detail).toBe('exit code: 0')
  })

  it('maps registry refusals to a 404 task-error (unknown/foreign ids stay indistinguishable)', () => {
    const tasks = { peek: vi.fn(() => { throw new Error('task bash-9 belongs to another session') }) }
    const api = buildTasksApi(ctxWith(tasks, {}), 100)!
    expect(() => api.output({ sessionId: 's1', id: 'bash-9' })).toThrowError(
      expect.objectContaining<Partial<SidebarError>>({ code: 'task-error', status: 404 }),
    )
  })

  it('rejects a missing sessionId or id as bad-request', () => {
    const tasks = { peek: vi.fn() }
    const api = buildTasksApi(ctxWith(tasks, {}), 100)!
    expect(() => api.output({ id: 'bash-1' })).toThrowError(expect.objectContaining<Partial<SidebarError>>({ code: 'bad-request' }))
    expect(() => api.output({ sessionId: 's1' })).toThrowError(expect.objectContaining<Partial<SidebarError>>({ code: 'bad-request' }))
  })
})

describe('tasks.kill route', () => {
  it('kills with the forwarded reason and the live caller', () => {
    const tasks = { kill: vi.fn(() => 'requested' as const) }
    const agents = { get: vi.fn((id: string) => agent(id)) }
    const api = buildTasksApi(ctxWith(tasks, agents), 100)!
    expect(api.kill({ sessionId: 's1', id: 'bash-1', reason: 'user pressed stop' }))
      .toEqual({ ok: true, outcome: 'requested' })
    expect(tasks.kill).toHaveBeenCalledWith('bash-1', agent('s1'), 'user pressed stop')
  })

  it('defaults the reason when none is supplied', () => {
    const tasks = { kill: vi.fn(() => 'already-finished' as const) }
    const api = buildTasksApi(ctxWith(tasks, undefined), 100)!
    expect(api.kill({ sessionId: 's1', id: 'bash-1' })).toEqual({ ok: true, outcome: 'already-finished' })
    expect(tasks.kill).toHaveBeenCalledWith('bash-1', undefined, 'user requested via sidebar')
  })

  it('maps registry refusals to a 404 task-error', () => {
    const tasks = { kill: vi.fn(() => { throw new Error('unknown task bash-9') }) }
    const api = buildTasksApi(ctxWith(tasks, {}), 100)!
    expect(() => api.kill({ sessionId: 's1', id: 'bash-9' })).toThrowError(
      expect.objectContaining<Partial<SidebarError>>({ code: 'task-error', status: 404 }),
    )
  })
})

describe('optional-service downgrade', () => {
  it('returns undefined (the caller maps to a 503) when ctx.tasks is absent', () => {
    expect(buildTasksApi(ctxWith(undefined, {}), 100)).toBeUndefined()
  })

  it('resolves the caller as undefined when the agents registry is absent', () => {
    const tasks = { peek: vi.fn(() => ({ text: '', snapshot: { status: 'running' } })), kill: vi.fn(() => 'requested' as const) }
    const api = buildTasksApi(ctxWith(tasks, undefined), 100)!
    api.output({ sessionId: 's1', id: 'bash-1' })
    expect(tasks.peek).toHaveBeenCalledWith('bash-1', undefined)
  })
})
