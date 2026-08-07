/**
 * Smoke spec: mounts the host plugin against a minimal fake context and
 * exercises the real integrations — route registration, git against the
 * actual repository, and a real directory listing. Runs with `pnpm test`.
 */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import * as git from '../src/git.ts'
import { listDirectory } from '../src/fs-tree.ts'
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

  it('lists the repository root level', async () => {
    const listing = await listDirectory(process.cwd(), 1000)
    expect(listing.entries.some(entry => entry.name === 'src' && entry.isDir)).toBe(true)
    expect(listing.entries.some(entry => entry.name === 'package.json' && !entry.isDir)).toBe(true)
    expect(listing.truncated).toBe(false)
  })
})
