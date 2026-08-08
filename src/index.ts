/**
 * dsh-better-sidebar host half: the /sidebar JSON API (explorer listing, file
 * read/write, git), the /sidebar/file media route (images), and the terminal
 * WebSocket upgrade. Every route passes the same browser-trust fence as the
 * /api gateway — Host-header loopback or the connection row's `trustedHosts`
 * (the `dsh web` launcher derives LAN IP literals per boot) — with the
 * trustedHosts read live from the connection loader row so the fence never
 * drifts from the deployment's.
 *
 * All operations are conversation-scoped: requests carry a sessionId, the
 * session's authoritative cwd comes from the session store, and terminal
 * processes are keyed by session.
 */
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import type { Context } from './context-types.ts'
import { parentOf, requireAbsolute, listDirectory, rootLabel } from './fs-tree.ts'
import { isTrustedApiRequest } from './trust-fence.ts'
import * as git from './git.ts'
import { defaultShell, ensureSpawnHelper, PtyManager } from './pty-manager.ts'
import { readJsonBody, requireString, SidebarError, writeError, writeJson, writeOk } from './wire.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-better-sidebar'

/** Services required before mounting: the webserver routes and the session store. */
export const inject = ['httpServer', 'sessions']

/** Read cap of one text file (bytes); larger files return truncated. */
const READ_LIMIT = 512 * 1024
/** Media route cap (bytes); larger binaries are refused. */
const MEDIA_LIMIT = 20 * 1024 * 1024
/** Explorer row bound of one level. */
const LIST_LIMIT = 1000
/** Terminals per session. */
const TERMINALS_PER_SESSION = 3
/** How long a disconnected terminal process survives awaiting a reconnect. */
const TERMINAL_RECONNECT_GRACE_MS = 30_000

/** Content types for the media route, by extension. */
const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
}

/** The connection row's resolved trustedHosts (live read; the /api fence's own list). */
function trustedHostsOf(ctx: Context): string[] {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.name === 'connection') {
      const config = entry.options.config as { trustedHosts?: string[] } | undefined
      return config?.trustedHosts ?? []
    }
  }
  return []
}

/** Resolve a session's authoritative working directory or throw not-found. */
function sessionCwdOf(ctx: Context, sessionId: string): string {
  const session = ctx.sessions.get(sessionId)
  const cwd = session?.header.cwd
  if (cwd === undefined) {
    throw new SidebarError('not-found', `session "${sessionId}" has no working directory`, 404)
  }
  return cwd
}

/** Text read of a file with the size cap; binary detection via NUL probe. */
async function readText(path: string): Promise<{ content: string; truncated: boolean; binary: boolean; size: number }> {
  const info = await stat(path).catch((error: unknown) => {
    throw new SidebarError('fs-error', `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
  })
  if (info.isDirectory()) {
    throw new SidebarError('fs-error', `"${path}" is a directory`, 400)
  }
  const size = info.size
  const truncated = size > READ_LIMIT
  const handle = await open(path, 'r').catch((error: unknown) => {
    throw new SidebarError('fs-error', `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
  })
  try {
    const buffer = Buffer.alloc(Math.min(size, READ_LIMIT))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const slice = buffer.subarray(0, bytesRead)
    const binary = slice.includes(0)
    return { content: binary ? '' : slice.toString('utf8'), truncated, binary, size }
  } finally {
    await handle.close()
  }
}

/** One API method dispatch table entry. */
type ApiMethod = (payload: unknown) => Promise<unknown> | unknown

/** Build the API method table bound to the plugin context and pty manager. */
function buildApi(ctx: Context, ptyManager: PtyManager): Record<string, ApiMethod> {
  const cwdOf = (payload: unknown): { sessionId: string; cwd: string } => {
    const sessionId = requireString(payload, 'sessionId')
    return { sessionId, cwd: sessionCwdOf(ctx, sessionId) }
  }
  return {
    'session.cwd': (payload) => {
      const { sessionId, cwd } = cwdOf(payload)
      return { sessionId, cwd, root: rootLabel(cwd), parent: parentOf(cwd) ?? null }
    },
    'fs.tree': async (payload) => {
      const { cwd } = cwdOf(payload)
      const record = payload as { path?: unknown }
      const target = record.path === undefined ? cwd : requireAbsolute(requireString(payload, 'path'))
      return listDirectory(target, LIST_LIMIT)
    },
    'fs.read': async (payload) => {
      const { cwd } = cwdOf(payload)
      const path = requireAbsolute(requireString(payload, 'path'))
      const { content, truncated, binary, size } = await readText(path)
      if (binary) return { kind: 'binary', size, truncated }
      return { kind: 'text', content, truncated }
    },
    'fs.write': async (payload) => {
      const { cwd } = cwdOf(payload)
      const path = requireAbsolute(requireString(payload, 'path'))
      const content = requireString(payload, 'content')
      const tmp = `${path}.dsh-sidebar-tmp-${process.pid}`
      try {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(tmp, content, 'utf8')
        await rename(tmp, path)
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {})
        throw new SidebarError('fs-error', `cannot write "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      return { ok: true }
    },
    'git.status': async (payload) => {
      const { cwd } = cwdOf(payload)
      return git.status(cwd)
    },
    'git.diff': async (payload) => {
      const { cwd } = cwdOf(payload)
      const record = payload as { path?: unknown; staged?: unknown }
      const path = record.path === undefined ? undefined : requireAbsolute(requireString(payload, 'path'))
      return { diff: await git.diff(cwd, path, record.staged === true) }
    },
    'git.stage': async (payload) => {
      const { cwd } = cwdOf(payload)
      const record = payload as { path?: unknown }
      const path = record.path === undefined ? undefined : requireString(payload, 'path')
      await git.stage(cwd, path)
      return { ok: true }
    },
    'git.unstage': async (payload) => {
      const { cwd } = cwdOf(payload)
      const record = payload as { path?: unknown }
      const path = record.path === undefined ? undefined : requireString(payload, 'path')
      await git.unstage(cwd, path)
      return { ok: true }
    },
    'git.commit': async (payload) => {
      const { cwd } = cwdOf(payload)
      const message = requireString(payload, 'message')
      await git.commit(cwd, message)
      return { ok: true }
    },
    'git.branch': async (payload) => {
      const { cwd } = cwdOf(payload)
      return git.branches(cwd)
    },
    'git.checkout': async (payload) => {
      const { cwd } = cwdOf(payload)
      await git.checkout(cwd, requireString(payload, 'branch'))
      return { ok: true }
    },
    'git.log': async (payload) => {
      const { cwd } = cwdOf(payload)
      return git.log(cwd)
    },
    'git.show': async (payload) => {
      const { cwd } = cwdOf(payload)
      const path = requireAbsolute(requireString(payload, 'path'))
      const rev = requireString(payload, 'rev')
      return { content: await git.show(cwd, rev, path) }
    },
  }
}

/**
 * Plugin body: mount the fenced routes and the pty lifecycle.
 * @param ctx - host plugin context (httpServer, sessions, loader).
 */
export function apply(ctx: Context): void {
  // pnpm strips the executable bit from node-pty's prebuilt spawn-helper;
  // restore it before any terminal can spawn (idempotent).
  ensureSpawnHelper()
  const trustedHosts = trustedHostsOf(ctx)
  const fence = (req: IncomingMessage): boolean => isTrustedApiRequest(req, trustedHosts)
  const ptyManager = new PtyManager(defaultShell(), TERMINALS_PER_SESSION)

  // ── JSON API ────────────────────────────────────────────────────────────
  const api = buildApi(ctx, ptyManager)
  ctx.effect(() => ctx.httpServer.register({
    kind: 'prefix',
    path: '/sidebar/api',
    handler: async (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/sidebar/api/') ? pathname.slice('/sidebar/api/'.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeError(res, new SidebarError('not-found', 'unknown sidebar API method', 404))
        return
      }
      try {
        const payload = await readJsonBody(req)
        const handler = api[method]
        if (handler === undefined) {
          throw new SidebarError('not-found', `unknown sidebar API method "${method}"`, 404)
        }
        writeOk(res, await handler(payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-better-sidebar: /sidebar/api routes')

  // ── Media route (images for the editor) ─────────────────────────────────
  ctx.effect(() => ctx.httpServer.register({
    kind: 'prefix',
    path: '/sidebar/file',
    handler: async (req, res) => {
      if (!fence(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId')
        const raw = url.searchParams.get('path')
        if (sessionId === null || raw === null) throw new SidebarError('bad-request', 'sessionId and path are required')
        const cwd = sessionCwdOf(ctx, sessionId)
        const path = requireAbsolute(raw)
        if (!path.startsWith(cwd)) {
          // Only files under the session cwd are served as media (the editor
          // opens images from the explorer; produced files go through read).
          throw new SidebarError('fs-error', 'media path outside the session working directory', 403)
        }
        const info = await stat(path)
        if (!info.isFile() || info.size > MEDIA_LIMIT) {
          throw new SidebarError('fs-error', 'not a file or too large', 400)
        }
        const type = MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
        const body = await readFile(path)
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
        res.end(body)
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-better-sidebar: /sidebar/file media route')

  // ── Terminal WebSocket ──────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true })
  ctx.effect(() => ctx.httpServer.registerUpgrade({
    path: '/sidebar/ws/terminal',
    handler: (req, socket, head) => {
      if (!fence(req)) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => { void attachTerminal(ctx, ptyManager, ws, req) })
    },
  }), 'dsh-better-sidebar: terminal WebSocket')

  ctx.effect(() => () => {
    ptyManager.disposeAll()
    wss.close()
  }, 'dsh-better-sidebar: teardown')
}

/** Wire one terminal socket to its pty: replay transcript, pump both ways. */
async function attachTerminal(
  ctx: Context,
  ptyManager: PtyManager,
  ws: WebSocket,
  req: IncomingMessage,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId')
    const tabId = url.searchParams.get('tab')
    if (sessionId === null || tabId === null) {
      ws.close(1008, 'sessionId and tab are required')
      return
    }
    const cwd = sessionCwdOf(ctx, sessionId)
    const handle = ptyManager.open(sessionId, tabId, cwd, 80, 24)
    // Replay the transcript, then follow live output.
    if (handle.transcript !== '') ws.send(handle.transcript)
    const onData = (data: string): void => {
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4 * 1024 * 1024) {
        ws.send(data)
      }
    }
    const onExit = ({ exitCode }: { exitCode: number; signal?: number }): void => {
      onData(`\r\n[process exited with code ${String(exitCode)}]\r\n`)
    }
    const dataSub = handle.pty.onData(onData)
    const exitSub = handle.pty.onExit(onExit)
    ws.on('message', (data) => {
      const text = data.toString('utf8')
      // Control frames are JSON with a known shape; anything else (including
      // JSON that is not a recognized control) is terminal input, verbatim.
      let control: { type?: unknown; cols?: unknown; rows?: unknown } | null = null
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object') {
          control = parsed as { type?: unknown; cols?: unknown; rows?: unknown }
        }
      } catch {
        // Not JSON: terminal input.
      }
      if (control !== null && control.type === 'close') {
        // The owning tab was closed: release the quota immediately.
        ptyManager.scheduleClose(handle.key, 0)
        return
      }
      if (handle.exited) return
      if (
        control !== null
        && control.type === 'resize'
        && typeof control.cols === 'number' && typeof control.rows === 'number'
      ) {
        handle.pty.resize(Math.max(2, Math.floor(control.cols)), Math.max(2, Math.floor(control.rows)))
      } else {
        handle.pty.write(text)
      }
    })
    ws.on('close', () => {
      dataSub.dispose()
      exitSub.dispose()
      // A bare socket drop (refresh, tab switch) leaves the process alive
      // for a grace period so a quick reconnect keeps it; the reconnect's
      // open() cancels the pending close.
      ptyManager.scheduleClose(handle.key, TERMINAL_RECONNECT_GRACE_MS)
    })
  } catch (error) {
    ws.close(1011, error instanceof Error ? error.message : String(error))
  }
}
