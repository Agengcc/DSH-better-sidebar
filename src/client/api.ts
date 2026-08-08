/**
 * Typed fetch wrapper over the /sidebar JSON API. Every call posts to
 * `/sidebar/api/<method>` with the sessionId and — when known — the session's
 * cwd from the client's own list summary. The host prefers its attached
 * session header and uses the summary cwd only while the session is still
 * hydrating at page load (a detached session would otherwise fail the
 * request). Failures surface as {@link SidebarApiError} with the wire code.
 */

/** One wire failure. */
export class SidebarApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Explorer row (host fs-tree shape). */
export interface FsEntry {
  name: string
  path: string
  isDir: boolean
  hidden: boolean
}

/** Git status entry (host git shape). */
export interface GitStatusEntry {
  path: string
  xy: string
}

/** Git status snapshot. */
export interface GitStatusResult {
  isRepo: boolean
  branch?: string
  entries: GitStatusEntry[]
}

/** One git log row. */
export interface GitLogEntry {
  hash: string
  subject: string
  author: string
  date: string
}

/** Text read result. */
export interface FsTextResult { kind: 'text'; content: string; truncated: boolean }
/** Binary read result (no content; images load through the media route). */
export interface FsBinaryResult { kind: 'binary'; size: number; truncated: boolean }

async function call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/sidebar/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    throw new SidebarApiError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | null
    = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new SidebarApiError(
      parsed?.error?.code ?? 'http',
      parsed?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value as T
}

/** One request's session scope: the conversation id plus its cwd when known. */
export interface SessionScope {
  sessionId: string
  /** The session's working directory from the client list summary (optional). */
  cwd?: string
}

/** Fold a scope into a JSON payload ({cwd} only when present). */
function scopePayload(scope: SessionScope, extra: Record<string, unknown>): Record<string, unknown> {
  return { sessionId: scope.sessionId, ...(scope.cwd !== undefined && scope.cwd !== '' ? { cwd: scope.cwd } : {}), ...extra }
}

/** The sidebar API surface (session scope threaded through every call). */
export const api = {
  sessionCwd: (scope: SessionScope, signal?: AbortSignal) =>
    call<{ sessionId: string; cwd: string; root: string; parent: string | null }>('session.cwd', scopePayload(scope, {}), signal),
  fsTree: (scope: SessionScope, path: string, signal?: AbortSignal) =>
    call<{ path: string; entries: FsEntry[]; truncated: boolean }>('fs.tree', scopePayload(scope, { path }), signal),
  fsRead: (scope: SessionScope, path: string, signal?: AbortSignal) =>
    call<FsTextResult | FsBinaryResult>('fs.read', scopePayload(scope, { path }), signal),
  fsWrite: (scope: SessionScope, path: string, content: string) =>
    call<{ ok: true }>('fs.write', scopePayload(scope, { path, content })),
  gitStatus: (scope: SessionScope, signal?: AbortSignal) =>
    call<GitStatusResult>('git.status', scopePayload(scope, {}), signal),
  gitDiff: (scope: SessionScope, path: string | undefined, staged: boolean, signal?: AbortSignal) =>
    call<{ diff: string }>('git.diff', scopePayload(scope, { ...(path !== undefined ? { path } : {}), staged }), signal),
  gitShow: (scope: SessionScope, rev: string, path: string, signal?: AbortSignal) =>
    call<{ content: string | null }>('git.show', scopePayload(scope, { rev, path }), signal),
  gitStage: (scope: SessionScope, path?: string) =>
    call<{ ok: true }>('git.stage', scopePayload(scope, { ...(path !== undefined ? { path } : {}) })),
  gitUnstage: (scope: SessionScope, path?: string) =>
    call<{ ok: true }>('git.unstage', scopePayload(scope, { ...(path !== undefined ? { path } : {}) })),
  gitCommit: (scope: SessionScope, message: string) =>
    call<{ ok: true }>('git.commit', scopePayload(scope, { message })),
  gitBranch: (scope: SessionScope, signal?: AbortSignal) =>
    call<{ current: string; names: string[] }>('git.branch', scopePayload(scope, {}), signal),
  gitCheckout: (scope: SessionScope, branch: string) =>
    call<{ ok: true }>('git.checkout', scopePayload(scope, { branch })),
  gitLog: (scope: SessionScope, signal?: AbortSignal) =>
    call<GitLogEntry[]>('git.log', scopePayload(scope, {}), signal),
}

/** Absolute URL of the media route for one path (images only). */
export function mediaUrl(scope: SessionScope, path: string): string {
  const params = new URLSearchParams({ sessionId: scope.sessionId, path })
  if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
  return `/sidebar/file?${params.toString()}`
}
