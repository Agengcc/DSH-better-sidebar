/**
 * Typed fetch wrapper over the /sidebar JSON API. Every call posts to
 * `/sidebar/api/<method>` with the sessionId; failures surface as
 * {@link SidebarApiError} with the wire error code.
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

/** The sidebar API surface (sessionId is threaded through every call). */
export const api = {
  sessionCwd: (sessionId: string, signal?: AbortSignal) =>
    call<{ sessionId: string; cwd: string; root: string; parent: string | null }>('session.cwd', { sessionId }, signal),
  fsTree: (sessionId: string, path: string, signal?: AbortSignal) =>
    call<{ path: string; entries: FsEntry[]; truncated: boolean }>('fs.tree', { sessionId, path }, signal),
  fsRead: (sessionId: string, path: string, signal?: AbortSignal) =>
    call<FsTextResult | FsBinaryResult>('fs.read', { sessionId, path }, signal),
  fsWrite: (sessionId: string, path: string, content: string) =>
    call<{ ok: true }>('fs.write', { sessionId, path, content }),
  gitStatus: (sessionId: string, signal?: AbortSignal) =>
    call<GitStatusResult>('git.status', { sessionId }, signal),
  gitDiff: (sessionId: string, path: string | undefined, staged: boolean, signal?: AbortSignal) =>
    call<{ diff: string }>('git.diff', { sessionId, ...(path !== undefined ? { path } : {}), staged }, signal),
  gitShow: (sessionId: string, rev: string, path: string, signal?: AbortSignal) =>
    call<{ content: string | null }>('git.show', { sessionId, rev, path }, signal),
  gitStage: (sessionId: string, path?: string) =>
    call<{ ok: true }>('git.stage', { sessionId, ...(path !== undefined ? { path } : {}) }),
  gitUnstage: (sessionId: string, path?: string) =>
    call<{ ok: true }>('git.unstage', { sessionId, ...(path !== undefined ? { path } : {}) }),
  gitCommit: (sessionId: string, message: string) =>
    call<{ ok: true }>('git.commit', { sessionId, message }),
  gitBranch: (sessionId: string, signal?: AbortSignal) =>
    call<{ current: string; names: string[] }>('git.branch', { sessionId }, signal),
  gitCheckout: (sessionId: string, branch: string) =>
    call<{ ok: true }>('git.checkout', { sessionId, branch }),
  gitLog: (sessionId: string, signal?: AbortSignal) =>
    call<GitLogEntry[]>('git.log', { sessionId }, signal),
}

/** Absolute URL of the media route for one path (images only). */
export function mediaUrl(sessionId: string, path: string): string {
  return `/sidebar/file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
}
