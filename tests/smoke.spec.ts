/**
 * Smoke spec: mounts the host plugin against a minimal fake context and
 * exercises the real integrations — route registration, git against the
 * actual repository, and a real directory listing. Runs with `pnpm test`.
 */
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { apply } from '../src/index.ts'
import * as git from '../src/git.ts'
import { listDirectory } from '../src/fs-tree.ts'
import { defaultShell, PtyManager } from '../src/pty-manager.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

interface FakeContext {
  loader: { entries: () => never[] }
  httpServer: {
    register: (route: SidebarWebRoute) => () => void
    registerUpgrade: (route: SidebarWebUpgradeRoute) => () => void
  }
  sessions: { get: (id: string) => { header: { cwd?: string } } | undefined }
  effect: (fn: () => void | (() => void), label?: string) => void
}

describe('host plugin smoke', () => {
  it('mounts the fenced routes', () => {
    const routes: SidebarWebRoute[] = []
    const upgrades: SidebarWebUpgradeRoute[] = []
    const effects: Array<() => void | (() => void)> = []
    const ctx: FakeContext = {
      loader: { entries: () => [] },
      httpServer: {
        register: (route) => { routes.push(route); return () => {} },
        registerUpgrade: (route) => { upgrades.push(route); return () => {} },
      },
      sessions: { get: () => undefined },
      // The DSH-vendored cordis runs the registration effect immediately and
      // keeps its cleanup for disposal.
      effect: (fn) => {
        const cleanup = fn()
        if (typeof cleanup === 'function') effects.push(cleanup)
      },
    }
    apply(ctx as never)
    expect(routes.map(route => route.path)).toEqual(['/sidebar/api', '/sidebar/file'])
    expect(upgrades.map(route => route.path)).toEqual(['/sidebar/ws/terminal'])
    // Teardown runs without throwing (pty manager has nothing open).
    for (const cleanup of effects) cleanup()
  })

  it('runs git status/log/branches against this repository', async () => {
    const cwd = process.cwd()
    const status = await git.status(cwd)
    expect(status.isRepo).toBe(true)
    expect(typeof status.branch).toBe('string')
    expect(Array.isArray(status.entries)).toBe(true)
    const log = await git.log(cwd)
    expect(log.length).toBeGreaterThan(0)
    expect(log[0]!.hash).toMatch(/^[0-9a-f]{7,}$/)
    const branches = await git.branches(cwd)
    expect(branches.names).toContain(branches.current)
  })

  it('pty manager releases the quota on close and respawns after exit', async () => {
    const manager = new PtyManager(defaultShell(), 3)
    try {
      const first = manager.open('s1', 't1', process.cwd(), 80, 24)
      expect(manager.keysOf('s1')).toHaveLength(1)
      // Tab-close semantics (close frame): quota released immediately.
      manager.scheduleClose(first.key, 0)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(manager.keysOf('s1')).toHaveLength(0)
      // Reopen spawns a fresh process.
      const second = manager.open('s1', 't1', process.cwd(), 80, 24)
      expect(second).not.toBe(first)
      expect(manager.keysOf('s1')).toHaveLength(1)
      // After the shell exits, a reconnect respawns instead of reusing the dead handle.
      second.pty.write('exit\r')
      const deadline = Date.now() + 5000
      while (!second.exited && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(second.exited).toBe(true)
      const third = manager.open('s1', 't1', process.cwd(), 80, 24)
      expect(third.exited).toBe(false)
      expect(third).not.toBe(second)
    } finally {
      manager.disposeAll()
    }
  })

  it('pty manager: exited zombie handles do not consume the quota', async () => {
    const manager = new PtyManager(defaultShell(), 1)
    try {
      const first = manager.open('s3', 't1', process.cwd(), 80, 24)
      first.pty.write('exit\r')
      const deadline = Date.now() + 5000
      while (!first.exited && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(first.exited).toBe(true)
      // Quota is 1; the exited handle is swept, so a NEW tab can still spawn.
      const second = manager.open('s3', 't2', process.cwd(), 80, 24)
      expect(second.exited).toBe(false)
      expect(manager.keysOf('s3')).toHaveLength(1)
    } finally {
      manager.disposeAll()
    }
  })

  it('pty manager: a reconnect within the grace period cancels the pending close', async () => {
    const manager = new PtyManager(defaultShell(), 3)
    try {
      const handle = manager.open('s2', 't1', process.cwd(), 80, 24)
      manager.scheduleClose(handle.key, 200)
      manager.open('s2', 't1', process.cwd(), 80, 24)
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(manager.get(handle.key)).toBeDefined()
    } finally {
      manager.disposeAll()
    }
  })

  it('pty manager: reopening with a different cwd respawns in the new directory', async () => {
    const manager = new PtyManager(defaultShell(), 3)
    // A real second directory: os.tmpdir() exists on every platform ('/tmp'
    // does not exist on Windows).
    const other = tmpdir()
    try {
      const first = manager.open('s4', 't1', process.cwd(), 80, 24)
      // The hydrate race: the first connect fell back to the process cwd,
      // the reconnect carries the session's real cwd — the shell must move.
      const second = manager.open('s4', 't1', other, 80, 24)
      expect(second).not.toBe(first)
      expect(second.cwd).toBe(other)
      expect(manager.keysOf('s4')).toHaveLength(1)
      // A same-cwd reconnect reattaches without respawning.
      const third = manager.open('s4', 't1', other, 80, 24)
      expect(third).toBe(second)
      expect(manager.keysOf('s4')).toHaveLength(1)
    } finally {
      manager.disposeAll()
    }
  })

  it('lists the repository root level', async () => {
    const listing = await listDirectory(process.cwd(), 1000)
    expect(listing.entries.some(entry => entry.name === 'src' && entry.isDir)).toBe(true)
    expect(listing.entries.some(entry => entry.name === 'package.json' && !entry.isDir)).toBe(true)
    expect(listing.truncated).toBe(false)
  })
})

describe('session cwd resolution over the API route', () => {
  interface CtxOverrides {
    sessions?: { get: (id: string) => { header: { cwd?: string } } | undefined }
  }

  const mount = (overrides: CtxOverrides = {}): SidebarWebRoute => {
    const routes: SidebarWebRoute[] = []
    const ctx = {
      loader: { entries: () => [] },
      httpServer: {
        register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
        registerUpgrade: (route: SidebarWebUpgradeRoute) => { void route; return () => {} },
      },
      sessions: overrides.sessions ?? { get: () => undefined },
      // The vendored cordis runs registration effects immediately.
      effect: (fn: () => void | (() => void)) => { fn() },
    }
    apply(ctx as never)
    return routes.find(route => route.path === '/sidebar/api')!
  }

  const invoke = async (
    route: SidebarWebRoute,
    method: string,
    payload: unknown,
  ): Promise<{ ok: boolean; value?: { cwd: string }; error?: { message: string } }> => {
    const body = Buffer.from(JSON.stringify(payload))
    const req = {
      method: 'POST',
      url: `/sidebar/api/${method}`,
      headers: { host: '127.0.0.1:3080' },
      [Symbol.asyncIterator]: async function* () { yield body },
    } as never
    const out: { status: number; body: string } = { status: 200, body: '' }
    const res = {
      writeHead: (status: number) => { out.status = status },
      end: (chunk: unknown) => { out.body += String(chunk ?? '') },
    } as never
    await route.handler(req, res)
    return JSON.parse(out.body) as { ok: boolean; value?: { cwd: string }; error?: { message: string } }
  }

  it('uses the client summary cwd while the session is detached', async () => {
    const route = mount()
    const result = await invoke(route, 'session.cwd', { sessionId: 's-detached', cwd: '/tmp/summary-cwd' })
    expect(result.ok).toBe(true)
    // The summary cwd passes through requireAbsolute (platform resolve), so
    // the expectation follows the platform's own normalization.
    expect(result.value?.cwd).toBe(resolvePath('/tmp/summary-cwd'))
  })

  it('falls back to the process cwd with no summary cwd', async () => {
    const route = mount()
    const result = await invoke(route, 'session.cwd', { sessionId: 's-unknown' })
    expect(result.ok).toBe(true)
    expect(result.value?.cwd).toBe(process.cwd())
  })

  it('prefers the attached session header over the client summary', async () => {
    const route = mount({
      sessions: {
        get: (id) => id === 's-attached' ? { header: { cwd: '/attached-cwd' } } : undefined,
      },
    })
    const result = await invoke(route, 'session.cwd', { sessionId: 's-attached', cwd: '/tmp/summary-cwd' })
    expect(result.ok).toBe(true)
    expect(result.value?.cwd).toBe('/attached-cwd')
  })

  it('rejects a non-absolute client cwd', async () => {
    const route = mount()
    const result = await invoke(route, 'session.cwd', { sessionId: 's-detached', cwd: 'relative/path' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/invalid working directory/)
  })

  it('pty.close releases a terminal key (and rejects a missing tab)', async () => {
    const route = mount()
    const result = await invoke(route, 'pty.close', { sessionId: 's-pty', tab: 't1' })
    expect(result.ok).toBe(true)
    const missing = await invoke(route, 'pty.close', { sessionId: 's-pty' })
    expect(missing.ok).toBe(false)
  })
})
