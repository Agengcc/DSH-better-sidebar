/**
 * Tests for the BetterSidebar service registry: register/dispose lifecycle,
 * matchFileViewer priority/exts/detect algorithm, and openTab dedupe.
 */
import { describe, it, expect } from 'vitest'

// Mock browser globals (SidebarStore.reduce → schedulePersist uses window.setTimeout)
const g = globalThis as Record<string, unknown>
if (g.window === undefined) {
  g.window = {
    clearTimeout: () => {},
    setTimeout: (_fn: () => void) => 0,
    innerWidth: 1024,
  }
}
if (g.localStorage === undefined) {
  g.localStorage = {
    getItem: () => null,
    setItem: () => {},
  }
}

import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore, allLeaves } from '../src/client/state.ts'

describe('BetterSidebar service', () => {
  it('registerTab adds to the registry and dispose removes it', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    expect(service.getTabs()).toHaveLength(0)
    const dispose = service.registerTab({
      id: 'test:tab',
      title: 'Test',
      component: () => null,
    })
    expect(service.getTabs()).toHaveLength(1)
    expect(service.getTab('test:tab')?.id).toBe('test:tab')
    dispose()
    expect(service.getTabs()).toHaveLength(0)
    expect(service.getTab('test:tab')).toBeUndefined()
  })

  it('registerTab throws on duplicate id', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'dup', title: 'A', component: () => null })
    expect(() => service.registerTab({ id: 'dup', title: 'B', component: () => null })).toThrow()
  })

  it('registerFileViewer adds and dispose removes', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    expect(service.getFileViewers()).toHaveLength(0)
    const dispose = service.registerFileViewer({
      id: 'csv',
      exts: ['csv'],
      fetchStrategy: 'custom',
      component: () => null,
    })
    expect(service.getFileViewers()).toHaveLength(1)
    dispose()
    expect(service.getFileViewers()).toHaveLength(0)
  })

  it('subscribe fires on register and dispose', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    let calls = 0
    const unsub = service.subscribe(() => { calls++ })
    const dispose = service.registerTab({ id: 'x', title: 'X', component: () => null })
    expect(calls).toBe(1)
    dispose()
    expect(calls).toBe(2)
    unsub()
    service.registerTab({ id: 'y', title: 'Y', component: () => null })
    expect(calls).toBe(2)
  })
})

describe('matchFileViewer', () => {
  it('matches by extension', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerFileViewer({ id: 'img', exts: ['png', 'jpg'], fetchStrategy: 'mediaUrl', component: () => null })
    expect(service.matchFileViewer('photo.png')?.id).toBe('img')
    expect(service.matchFileViewer('photo.JPG')?.id).toBe('img')
    expect(service.matchFileViewer('doc.txt')).toBeUndefined()
  })

  it('higher priority wins on extension conflict', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerFileViewer({ id: 'basic', exts: ['png'], priority: 0, fetchStrategy: 'mediaUrl', component: () => null })
    service.registerFileViewer({ id: 'advanced', exts: ['png'], priority: 10, fetchStrategy: 'custom', component: () => null })
    expect(service.matchFileViewer('x.png')?.id).toBe('advanced')
  })

  it('catch-all (exts: []) matches anything at lowest priority', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerFileViewer({ id: 'catchall', exts: [], priority: -100, fetchStrategy: 'fsRead', component: () => null })
    service.registerFileViewer({ id: 'img', exts: ['png'], priority: 0, fetchStrategy: 'mediaUrl', component: () => null })
    expect(service.matchFileViewer('x.png')?.id).toBe('img')
    expect(service.matchFileViewer('x.txt')?.id).toBe('catchall')
  })

  it('detect overrides exts when head bytes are available', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerFileViewer({ id: 'by-ext', exts: ['bin'], priority: 10, fetchStrategy: 'fsRead', component: () => null })
    service.registerFileViewer({
      id: 'by-magic',
      exts: [],
      priority: 5,
      fetchStrategy: 'fsRead',
      detect: (_path, head) => head[0] === 0x89,
      component: () => null,
    })
    // Without head bytes, by-ext wins (priority 10 > 5, and .bin matches).
    expect(service.matchFileViewer('file.bin')?.id).toBe('by-ext')
    // With magic bytes, by-magic wins (detect overrides).
    expect(service.matchFileViewer('file.bin', new Uint8Array([0x89, 0x50]))?.id).toBe('by-magic')
  })

  it('returns undefined when no viewer matches and no catch-all', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerFileViewer({ id: 'img', exts: ['png'], fetchStrategy: 'mediaUrl', component: () => null })
    expect(service.matchFileViewer('doc.txt')).toBeUndefined()
  })
})

describe('service.openTab dedupe', () => {
  it('dedupeKey focuses existing tab instead of duplicating', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'singleton',
      title: 'Singleton',
      dedupeKey: () => 'singleton',
      component: () => null,
    })
    store.setSession('s1')
    service.openTab({ type: 'singleton', title: 'Singleton' })
    service.openTab({ type: 'singleton', title: 'Singleton' })
    const state = store.getSnapshot().state!
    const tabs = allLeaves(state.splits).flatMap(l => l.tabs)
    expect(tabs.filter(t => t.type === 'singleton')).toHaveLength(1)
  })

  it('no dedupeKey opens a new tab each time', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'multi',
      title: 'Multi',
      component: () => null,
    })
    store.setSession('s1')
    service.openTab({ type: 'multi', title: 'Multi' })
    service.openTab({ type: 'multi', title: 'Multi' })
    const state = store.getSnapshot().state!
    const tabs = allLeaves(state.splits).flatMap(l => l.tabs)
    expect(tabs.filter(t => t.type === 'multi')).toHaveLength(2)
  })

  it('createTab mints custom ids and patches state', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'counter',
      title: 'Counter',
      createTab: (state) => ({
        tab: { id: `counter:${state.nextTerminal}`, type: 'counter', title: `C${state.nextTerminal}` },
        patch: { nextTerminal: state.nextTerminal + 1 },
      }),
      component: () => null,
    })
    store.setSession('s1')
    service.openTab({ type: 'counter', title: 'Counter' })
    service.openTab({ type: 'counter', title: 'Counter' })
    const state = store.getSnapshot().state!
    const tabs = allLeaves(state.splits).flatMap(l => l.tabs).filter(t => t.type === 'counter')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]!.id).toBe('counter:1')
    expect(tabs[1]!.id).toBe('counter:2')
    expect(state.nextTerminal).toBe(3)
  })
})
