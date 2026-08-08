/**
 * Smoke spec: mounts the host plugin against a minimal fake context and
 * exercises the real integrations — route registration, git against the
 * actual repository, and a real directory listing. Runs with `pnpm test`.
 */
import { describe, expect, it } from 'vitest'
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
  sessions: { get: (id: string) => undefined }
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

  it('lists the repository root level', async () => {
    const listing = await listDirectory(process.cwd(), 1000)
    expect(listing.entries.some(entry => entry.name === 'src' && entry.isDir)).toBe(true)
    expect(listing.entries.some(entry => entry.name === 'package.json' && !entry.isDir)).toBe(true)
    expect(listing.truncated).toBe(false)
  })
})
