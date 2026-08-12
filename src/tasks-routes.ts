/**
 * Background-task routes of the /sidebar JSON API ('tasks.output' /
 * 'tasks.kill'). The task LIST itself needs no route: it arrives through the
 * harness's `session/tasks` push mirror (`tasksBySession` in the sessions
 * list feed). These routes only:
 *
 * - READ OUTPUT — a NON-CONSUMING peek (`ctx.tasks.peek`) that never advances
 *   the model's `task_output` cursor nor claims the completion report, so a
 *   human watching a stream cannot steal the agent's bytes;
 * - KILL tasks (`ctx.tasks.kill`) with a forwarded reason.
 *
 * Both are fenced by the owning session: the caller Agent is resolved live
 * from the requested sessionId (`ctx.agents.get`) and the tasks registry
 * refuses anything that session does not own. Registry errors map to a 404
 * `task-error` (unknown/foreign ids), so the client cannot distinguish
 * existence — matching the api-proxy's task-view secrecy.
 */
import type { Context, SidebarTaskStatus } from './context-types.ts'
import { requireString, SidebarError } from './wire.ts'

/** The two background-task routes of the sidebar API. */
export interface SidebarTasksRoutes {
  /** Full accumulated output of one task (non-consuming peek, capped). */
  output(payload: unknown): {
    text: string
    truncated: boolean
    status: SidebarTaskStatus
    detail?: string
  }
  /** Request cancellation of one task (live tasks flip to stopping). */
  kill(payload: unknown): { ok: true; outcome: 'requested' | 'already-finished' }
}

/**
 * Build the tasks routes bound to the plugin context. Returns undefined when
 * the deployment lacks the background-task registry (`ctx.tasks`) — the
 * calling route then reports a 503, mirroring the settings routes' optional
 * service downgrade.
 * @param ctx - host plugin context (tasks/agents read lazily at call time).
 * @param outputLimit - response cap for one output read in bytes; longer
 *   texts are sliced and flagged `truncated` (mirrors the fs.read cap).
 */
export function buildTasksApi(ctx: Context, outputLimit: number): SidebarTasksRoutes | undefined {
  const tasks = ctx.get('tasks')
  if (tasks === undefined) return undefined
  const agents = ctx.get('agents')
  /** The live caller whose session id the fence compares against (absent → unowned only). */
  const callerOf = (sessionId: string) => agents?.get(sessionId)
  /** Registry refusals become a 404 task-error; unknown and foreign ids are indistinguishable. */
  const registryError = (error: unknown): SidebarError =>
    new SidebarError('task-error', error instanceof Error ? error.message : String(error), 404)
  return {
    output(payload) {
      const sessionId = requireString(payload, 'sessionId')
      const id = requireString(payload, 'id')
      try {
        const read = tasks.peek(id, callerOf(sessionId))
        const text = read.text
        return {
          text: text.length > outputLimit ? text.slice(0, outputLimit) : text,
          truncated: text.length > outputLimit,
          status: read.snapshot.status,
          ...read.snapshot.detail !== undefined ? { detail: read.snapshot.detail } : {},
        }
      } catch (error) {
        throw registryError(error)
      }
    },
    kill(payload) {
      const sessionId = requireString(payload, 'sessionId')
      const id = requireString(payload, 'id')
      const record = payload as { reason?: unknown } | null
      const reason = typeof record?.reason === 'string' && record.reason !== ''
        ? record.reason
        : 'user requested via sidebar'
      try {
        return { ok: true, outcome: tasks.kill(id, callerOf(sessionId), reason) }
      } catch (error) {
        throw registryError(error)
      }
    },
  }
}
