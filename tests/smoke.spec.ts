/**
 * Smoke spec: mounts the host plugin against a minimal fake context and
 * exercises the real integrations — route registration, git against the
 * actual repository, and a real directory listing. Runs with `pnpm test`.
 */
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { SettingsConflictError, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply, mediaTypeForPath } from '../src/index.ts'
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
  tools: { register: (tool: unknown) => () => void }
  effect: (fn: () => void | (() => void), label?: string) => void
  /** The settings service never appears in the smoke context: the inject
   *  callback must never run (mirror of cordis' service-less inject). */
  inject: (deps: readonly string[], callback: (sctx: never) => void) => () => void
}

describe('host plugin smoke', () => {
  it('serves PDF with the browser-native content type', () => {
    expect(mediaTypeForPath('/work/report.PDF')).toBe('application/pdf')
    expect(mediaTypeForPath('/work/archive.bin')).toBe('application/octet-stream')
  })

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
      tools: { register: () => () => {} },
      // The DSH-vendored cordis runs the registration effect immediately and
      // keeps its cleanup for disposal.
      effect: (fn) => {
        const cleanup = fn()
        if (typeof cleanup === 'function') effects.push(cleanup)
      },
      // No settings service in the smoke context: the registration callback
      // never runs (cordis' service-less inject behaves the same).
      inject: () => () => {},
    }
    apply(ctx as never)
    expect(routes.map(route => route.path)).toEqual(['/sidebar/api', '/sidebar/file'])
    expect(upgrades.map(route => route.path)).toEqual(['/sidebar/ws/terminal', '/sidebar/ws/agent-terminals'])
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
      tools: { register: () => () => {} },
      // The vendored cordis runs registration effects immediately.
      effect: (fn: () => void | (() => void)) => { fn() },
      // No settings service: the namespace registration never runs.
      inject: () => () => {},
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

describe('side card settings routes', () => {
  /** A minimal settings seam: register/describe/update with the revision guard. */
  const createFakeSettings = () => {    const namespaces = new Map<string, {
      schema: unknown
      value: Record<string, unknown> | undefined
      revision: number
    }>()
    const resolve = (entry: { schema: unknown; value: Record<string, unknown> | undefined }): unknown => {
      const schema = entry.schema as (input: unknown) => unknown
      return entry.value === undefined ? schema(undefined) : schema(entry.value)
    }
    return {
      register(ns: string, schema: unknown) {
        namespaces.set(ns, { schema, value: undefined, revision: 0 })
        return { get: () => ({}), watch: () => () => {}, update: async () => {}, replace: async () => {} }
      },
      describe() {
        return [...namespaces.entries()].map(([ns, entry]) => ({
          ns,
          value: resolve(entry),
          applies: 'live' as const,
          revision: entry.revision,
        }))
      },
      async update(ns: string, patch: Record<string, unknown>, expectedRevision?: number) {
        const entry = namespaces.get(ns)
        if (entry === undefined) throw new Error(`settings namespace "${ns}" is not registered`)
        if (expectedRevision !== undefined && expectedRevision !== entry.revision) {
          throw new SettingsConflictError(settingsNamespace(ns), expectedRevision, entry.revision)
        }
        entry.value = { ...entry.value, ...patch }
        entry.revision += 1
      },
    }
  }

  const mountWithSettings = (settings?: unknown): SidebarWebRoute => {
    const routes: SidebarWebRoute[] = []
    const ctx = {
      loader: { entries: () => [] },
      httpServer: {
        register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
        registerUpgrade: (route: SidebarWebUpgradeRoute) => { void route; return () => {} },
      },
      sessions: { get: () => undefined },
      tools: { register: () => () => {} },
      effect: (fn: () => void | (() => void)) => { fn() },
      inject: (deps: string[], callback: (sctx: { settings: unknown }) => void) => {
        if (deps.includes('settings') && settings !== undefined) callback({ settings })
        return () => {}
      },
    }
    apply(ctx as never)
    return routes.find(route => route.path === '/sidebar/api')!
  }

  const invoke = async (route: SidebarWebRoute, method: string, payload: unknown): Promise<{
    ok: boolean
    value?: unknown
    error?: { code?: string; message: string }
  }> => {
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
    return JSON.parse(out.body) as { ok: boolean; value?: unknown; error?: { code?: string; message: string } }
  }

  it('serves the schema defaults when the settings service is absent', async () => {
    const route = mountWithSettings(undefined)
    const result = await invoke(route, 'settings.get', {})
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ value: undefined, revision: undefined })
  })

  it('reads the resolved prefs and writes a patch through the seam', async () => {
    const route = mountWithSettings(createFakeSettings())
    const read = await invoke(route, 'settings.get', {})
    expect(read.ok).toBe(true)
    expect(read.value).toEqual({
      value: { openByDefault: true, defaultWidthPercent: 30, autoOpenSubagent: true, agentTerminalTools: false },
      revision: 0,
    })

    const written = await invoke(route, 'settings.update', { patch: { openByDefault: false } })
    expect(written.ok).toBe(true)
    const view = written.value as { value: { openByDefault: boolean; defaultWidthPercent: number }; revision: number }
    expect(view.value.openByDefault).toBe(false)
    expect(view.value.defaultWidthPercent).toBe(30)
    expect(view.revision).toBe(1)
  })

  it('refuses a stale write with settings-conflict (409)', async () => {
    const route = mountWithSettings(createFakeSettings())
    await invoke(route, 'settings.update', { patch: { openByDefault: false } })
    // The second write carries the pre-write revision: the seam refuses it.
    const stale = await invoke(route, 'settings.update', {
      patch: { defaultWidthPercent: 40 },
      expectedRevision: 0,
    })
    expect(stale.ok).toBe(false)
    expect(stale.error?.code).toBe('settings-conflict')
    expect(stale.error?.message).toMatch(/changed since it was read/)
  })

  it('rejects a non-object patch as bad-request', async () => {
    const route = mountWithSettings(createFakeSettings())
    const result = await invoke(route, 'settings.update', { patch: 'nope' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/plain object/)
  })
})

describe('agent terminal tool gating', () => {
  it('injects the eight tools only when the side-card setting is enabled (default off)', () => {
    let registered = 0
    let disposed = 0
    // The tools currently registered (registered minus disposed).
    const live = (): number => registered - disposed
    // A ref container: the watch callback is only assigned inside a closure,
    // which TypeScript's control-flow analysis ignores (the bare variable
    // would narrow to null and refuse the optional call).
    const watcherRef: { current: (() => void) | null } = { current: null }
    let enabled = false
    const settings = {
      register() {
        return {
          get: () => ({ agentTerminalTools: enabled }),
          watch: (callback: () => void) => { watcherRef.current = callback; return () => {} },
          update: async () => {},
          replace: async () => {},
        }
      },
      describe: () => [],
      async update() {},
    }
    const ctx = {
      loader: { entries: () => [] },
      httpServer: {
        register: (route: SidebarWebRoute) => { void route; return () => {} },
        registerUpgrade: (route: SidebarWebUpgradeRoute) => { void route; return () => {} },
      },
      sessions: { get: () => undefined },
      tools: { register: () => { registered += 1; return () => { disposed += 1 } } },
      effect: (fn: () => void | (() => void)) => { fn() },
      inject: (deps: readonly string[], callback: (sctx: { settings: unknown }) => void) => {
        if (deps.includes('settings')) callback({ settings })
        return () => {}
      },
    }
    apply(ctx as never)
    // Default off: no tools are registered even though the settings service is mounted.
    expect(live()).toBe(0)
    // Flipping the setting on registers all eight tools.
    enabled = true
    watcherRef.current?.()
    expect(live()).toBe(8)
    expect(disposed).toBe(0)
    // Flipping it back off unregisters them (and releases any agent terminals).
    enabled = false
    watcherRef.current?.()
    expect(live()).toBe(0)
    expect(disposed).toBe(8)
    // And a redundant toggle registers them fresh (no double-registration per
    // flip: the guard only skips when the tools are already live).
    enabled = true
    watcherRef.current?.()
    expect(live()).toBe(8)
    expect(registered).toBe(16)
  })
})
