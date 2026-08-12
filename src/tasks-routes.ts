/**
 * Background-task routes of the /sidebar JSON API ('tasks.output' /
 * 'tasks.kill'). The task LIST needs no route: it arrives through the
 * harness's `session/tasks` push mirror (`tasksBySession` in the sessions
 * list feed). The routes:
 *
 * - 'tasks.output' — REPLAYS the output the MODEL has read so far from the
 *   owner session's OWN event log: `tool/call` rows of `task_output` name
 *   the task via `arguments.task_id`, and the paired `tool/result` rows
 *   carry the finalized content the model actually received. This touches
 *   NO DSH source (no peek seam, no consuming read): the model's
 *   `task_output` cursor is untouched by construction, and the pane stays
 *   empty until the agent reads the task.
 * - 'tasks.kill' — the registry's stock `kill` (a pristine DSH API),
 *   fenced by the owning session via the live agent caller. Absent registry
 *   → 503, mirroring the settings routes' optional-service downgrade.
 */
import type { Context } from './context-types.ts'
import { requireString, SidebarError } from './wire.ts'

/** The two background-task routes of the sidebar API. */
export interface SidebarTasksRoutes {
  /** The output the model has read so far for one task (event replay, capped). */
  output(payload: unknown): { text: string; truncated: boolean; read: boolean }
  /** Request cancellation of one task (live tasks flip to stopping). */
  kill(payload: unknown): { ok: true; outcome: 'requested' | 'already-finished' }
}

/** The 'tool/result' message envelope inside a session event's data. */
interface ToolResultMessageLike {
  source?: { kind?: unknown; callId?: unknown }
  content?: unknown
}

/** One 'tool-result' content block (the inner blocks carry the text). */
interface ToolResultBlockLike {
  type?: unknown
  content?: unknown
  isError?: unknown
}

/**
 * Extract the plain text of a finalized tool result: the text blocks inside
 * the 'tool-result' block, joined with newlines. Error results and
 * non-text blocks contribute nothing.
 */
function resultText(message: ToolResultMessageLike): string | undefined {
  if (!Array.isArray(message.content)) return undefined
  const parts: string[] = []
  for (const block of message.content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as ToolResultBlockLike
    if (candidate.type !== 'tool-result' || candidate.isError === true) continue
    const inner = candidate.content
    if (!Array.isArray(inner)) continue
    for (const item of inner) {
      if (item === null || typeof item !== 'object') continue
      const textItem = item as { type?: unknown; text?: unknown }
      if (textItem.type === 'text' && typeof textItem.text === 'string') {
        parts.push(textItem.text)
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** Whether a task_output result carries no new output — the controller's
 *  model-facing "(no new output)" body, noise for the human pane. */
function isNoNewOutput(text: string): boolean {
  return text.startsWith('(no new output)')
}

/**
 * Build the tasks routes bound to the plugin context. `output` reads only
 * the session store; `kill` reads the tasks/agents services lazily and
 * degrades to a 503 when the deployment lacks the registry.
 * @param ctx - host plugin context.
 * @param outputLimit - response cap for one output replay in bytes; longer
 *   texts are sliced and flagged `truncated` (mirrors the fs.read cap).
 */
export function buildTasksApi(ctx: Context, outputLimit: number): SidebarTasksRoutes {
  const tasks = ctx.get('tasks')
  const agents = ctx.get('agents')
  /** The live caller whose session id the registry fence compares against. */
  const callerOf = (sessionId: string) => agents?.get(sessionId)
  /** Registry refusals become a 404 task-error; unknown and foreign ids are indistinguishable. */
  const registryError = (error: unknown): SidebarError =>
    new SidebarError('task-error', error instanceof Error ? error.message : String(error), 404)
  return {
    output(payload) {
      const sessionId = requireString(payload, 'sessionId')
      const id = requireString(payload, 'id')
      // One pass over the owner session's event log: tool/call rows first
      // map callId → task_id (a call always precedes its result), then each
      // matching tool/result contributes the finalized text the model saw.
      const session = ctx.sessions.get(sessionId)
      const taskOf = new Map<string, string>()
      const parts: string[] = []
      let read = false
      for (const event of session?.events ?? []) {
        if (event.type === 'tool/call') {
          const data = event.data as { name?: unknown; callId?: unknown; arguments?: unknown }
          if (data.name !== 'task_output' || typeof data.callId !== 'string') continue
          try {
            const args = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '') as { task_id?: unknown }
            if (typeof args.task_id === 'string') taskOf.set(data.callId, args.task_id)
          } catch {
            // Malformed model arguments: not a task_output pair.
          }
        } else if (event.type === 'tool/result') {
          const message = (event.data as { message?: unknown }).message as ToolResultMessageLike | undefined
          if (message === undefined) continue
          const callId = message.source?.callId
          if (typeof callId !== 'string') continue
          if (taskOf.get(callId) !== id) continue
          read = true
          const text = resultText(message)
          if (text !== undefined && !isNoNewOutput(text)) parts.push(text)
        }
      }
      const text = parts.join('\n')
      return {
        text: text.length > outputLimit ? text.slice(0, outputLimit) : text,
        truncated: text.length > outputLimit,
        read,
      }
    },
    kill(payload) {
      if (tasks === undefined) {
        throw new SidebarError('task-error', 'the background-task registry is not mounted in this deployment', 503)
      }
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
