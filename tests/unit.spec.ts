import { describe, expect, it } from 'vitest'
import { compareEntries, parentOf, rootLabel, requireAbsolute } from '../src/fs-tree.ts'
import { parseLogLines, parsePorcelainZ } from '../src/git.ts'
import {
  activateTab, allLeaves, closeTab, insertLeafAt, makeDefaultState, moveTab, moveTabToEdge,
  openTab, resizeSplit, sanitizeState, splitPane, tabOpenIn, toggleExpanded,
  type SidebarState, type SplitNode,
} from '../src/client/state.ts'
import { extOf, languageKeyForExt } from '../src/client/lang.ts'
import { relativeTo } from '../src/client/paths.ts'
import { producedForClosing, resolveSidebarPath, selectProducedFiles } from '../src/client/produced-files.ts'
import { defaultShell, ensureSpawnHelper } from '../src/pty-manager.ts'

describe('fs-tree', () => {
  it('sorts directories first, then names case-insensitively', () => {
    const rows = [
      { name: 'b.txt', path: '/x/b.txt', isDir: false, hidden: false },
      { name: 'A', path: '/x/A', isDir: true, hidden: false },
      { name: 'a.txt', path: '/x/a.txt', isDir: false, hidden: false },
      { name: '.hidden', path: '/x/.hidden', isDir: false, hidden: true },
    ]
    expect(rows.sort(compareEntries).map(row => row.name)).toEqual(['A', '.hidden', 'a.txt', 'b.txt'])
  })

  it('derives root labels and parents', () => {
    expect(rootLabel('/Users/me/code')).toBe('code')
    expect(rootLabel('/')).toBe('/')
    expect(parentOf('/Users/me/code')).toBe('/Users/me')
    expect(parentOf('/')).toBeUndefined()
  })

  it('accepts absolute paths and rejects relative ones', () => {
    expect(requireAbsolute('/a/b')).toBe('/a/b')
    expect(() => requireAbsolute('a/b')).toThrow(/not an absolute path/)
  })
})

describe('git parsing', () => {
  it('parses porcelain -z entries including renames', () => {
    const output = ['M  src/a.ts', ' M src/b.ts', '?? src/c.ts', 'R  src/new.ts', 'src/old.ts', ''].join('\0')
    const entries = parsePorcelainZ(output)
    expect(entries).toEqual([
      { path: 'src/a.ts', xy: 'M ' },
      { path: 'src/b.ts', xy: ' M' },
      { path: 'src/c.ts', xy: '??' },
      { path: 'src/new.ts', xy: 'R ' },
    ])
  })

  it('parses log rows with unit separators', () => {
    const rows = parseLogLines('abc1234\x1fFirst subject\x1fAlice\x1f2024-01-01 10:00:00 +0800\n')
    expect(rows).toEqual([
      { hash: 'abc1234', subject: 'First subject', author: 'Alice', date: '2024-01-01 10:00:00 +0800' },
    ])
  })
})

describe('sidebar state', () => {
  const state = (): SidebarState => makeDefaultState()

  it('opens tabs into the active pane and dedupes single-instance types', () => {
    let s = state()
    const gitTab = { id: 'git', type: 'git' as const, title: 'Git' }
    s = openTab(s, gitTab)
    expect(s.splits.kind).toBe('leaf')
    expect((s.splits as { tabs: unknown[] }).tabs).toHaveLength(2)
    // Reopening git focuses the existing tab instead of duplicating.
    const after = openTab(s, { id: 'git2', type: 'git' as const, title: 'Git' })
    expect((after.splits as { tabs: unknown[] }).tabs).toHaveLength(2)
  })

  it('dedupes editors by path', () => {
    let s = state()
    const firstId = (s.splits as { tabs: { id: string }[] }).tabs[0]!.id
    s = openTab(s, { id: 'e1', type: 'editor', title: 'a.ts', path: '/p/a.ts' })
    const after = openTab(s, { id: 'e2', type: 'editor', title: 'a.ts', path: '/p/a.ts' })
    expect((after.splits as { tabs: { id: string }[] }).tabs.map(t => t.id)).toEqual([firstId, 'e1'])
  })

  it('splits panes and moves tabs between them', () => {
    let s = state()
    s = splitPane(s, 'row')
    expect(s.splits.kind).toBe('split')
    const split = s.splits as Extract<SplitNode, { kind: 'split' }>
    expect(split.children).toHaveLength(2)
    const explorerId = (split.children[0] as { id: string }).id
    const otherId = (split.children[1] as { id: string }).id
    expect((split.children[1] as { tabs: unknown[] }).tabs).toHaveLength(0)
    const explorerTab = ((split.children[0] as { tabs: { id: string }[] }).tabs[0]!).id
    s = moveTab(s, explorerId, explorerTab, otherId)
    // The source pane emptied and was removed; the target leaf is promoted.
    expect(s.splits.kind).toBe('leaf')
    expect((s.splits as { id: string }).id).toBe(otherId)
    expect((s.splits as { tabs: { id: string }[] }).tabs.map(t => t.id)).toEqual([explorerTab])
  })

  it('dragging a tab to a pane edge splits the pane with the tab in a fresh leaf', () => {
    let s = state()
    s = splitPane(s, 'row')
    const split = s.splits as Extract<SplitNode, { kind: 'split' }>
    const paneA = split.children[0] as { id: string; tabs: { id: string }[] }
    const paneB = split.children[1] as { id: string; tabs: { id: string }[] }
    const tabId = paneA.tabs[0]!.id
    // 先给 paneB 一个 tab，然后拖 paneA 的 tab 到 paneB 的 right 边缘。
    s = openTab(s, { id: 't2', type: 'terminal', title: 'T2' })
    s = moveTabToEdge(s, paneA.id, tabId, paneB.id, 'right')
    const after = s.splits as Extract<SplitNode, { kind: 'split' }>
    // paneB 现在是 split(row) [旧leaf, 新leaf(tabId)]；其父 split 仍存在。
    const bSplit = after.children.find(child => child.kind === 'split') as Extract<SplitNode, { kind: 'split' }> | undefined
    expect(bSplit).toBeDefined()
    expect(bSplit!.dir).toBe('row')
    const newLeaf = bSplit!.children[1] as { tabs: { id: string }[] }
    expect(newLeaf.tabs.map(t => t.id)).toContain(tabId)
  })

  it('dragging a tab to a pane center merges it into the pane', () => {
    let s = state()
    s = splitPane(s, 'col')
    const split = s.splits as Extract<SplitNode, { kind: 'split' }>
    const paneA = split.children[0] as { id: string; tabs: { id: string }[] }
    const paneB = split.children[1] as { id: string; tabs: { id: string }[] }
    const tabId = paneA.tabs[0]!.id
    s = moveTabToEdge(s, paneA.id, tabId, paneB.id, 'center')
    // paneA 空了被移除，树退化为 paneB（含 tab）。
    expect(s.splits.kind).toBe('leaf')
    expect((s.splits as { tabs: { id: string }[] }).tabs.map(t => t.id)).toEqual([tabId])
  })

  it('dragging a tab back onto its own pane center reorders it', () => {
    let s = state()
    s = openTab(s, { id: 't2', type: 'terminal', title: 'T2' })
    const leaf = s.splits as { id: string; tabs: { id: string }[] }
    const first = leaf.tabs[0]!.id
    s = moveTabToEdge(s, leaf.id, first, leaf.id, 'center')
    const after = s.splits as { tabs: { id: string }[] }
    expect(after.tabs[after.tabs.length - 1]!.id).toBe(first)
    expect(after.tabs).toHaveLength(2)
  })

  it('closing the last tab removes the pane (promotes the sibling)', () => {
    let s = state()
    s = splitPane(s, 'col')
    const split = s.splits as Extract<SplitNode, { kind: 'split' }>
    const paneA = split.children[0] as { id: string; tabs: { id: string }[] }
    const paneB = split.children[1] as { id: string }
    const explorerId = paneA.tabs[0]!.id
    // paneA gets a terminal; the explorer moves to paneB; closing the
    // terminal empties paneA, which is removed, promoting paneB.
    s = openTab(s, { id: 't', type: 'terminal', title: 'Terminal 1' })
    s = moveTab(s, paneA.id, explorerId, paneB.id)
    s = activateTab(s, paneA.id, 't')
    s = closeTab(s, paneA.id, 't')
    expect(s.splits.kind).toBe('leaf')
    expect((s.splits as { id: string }).id).toBe(paneB.id)
  })

  it('resizes splits within the clamp range', () => {
    let s = state()
    s = splitPane(s, 'row')
    const split = s.splits as Extract<SplitNode, { kind: 'split' }>
    const id = split.id
    s = { ...s, splits: resizeSplit(s.splits, id, 0, 0.2) }
    const after = s.splits as Extract<SplitNode, { kind: 'split' }>
    expect(after.sizes[0]).toBeCloseTo(0.7)
    expect(after.sizes[1]).toBeCloseTo(0.3)
  })

  it('tracks explorer expansion and tab activation', () => {
    let s = state()
    s = toggleExpanded(s, '/p/a')
    s = toggleExpanded(s, '/p/b')
    expect(s.expanded).toEqual(['/p/a', '/p/b'])
    s = toggleExpanded(s, '/p/a')
    expect(s.expanded).toEqual(['/p/b'])
    const leaf = s.splits as { id: string; tabs: { id: string }[]; active: string | null }
    const tabId = leaf.tabs[0]!.id
    const after = activateTab(s, leaf.id, tabId)
    expect((after.splits as { active: string | null }).active).toBe(tabId)
  })

  it('tabOpenIn: a tab is open until it is truly closed, wherever it lives', () => {
    let s = state()
    const leaf = s.splits as { id: string; tabs: { id: string }[] }
    const explorerId = leaf.tabs[0]!.id
    expect(tabOpenIn(s, explorerId)).toBe(true)
    // Moving the tab to another pane keeps it open.
    s = splitPane(s, 'row')
    const split = s.splits as Extract<SplitNode, { kind: 'split' }>
    const paneA = split.children[0] as { id: string; tabs: { id: string }[] }
    const paneB = split.children[1] as { id: string }
    s = moveTab(s, paneA.id, explorerId, paneB.id)
    expect(tabOpenIn(s, explorerId)).toBe(true)
    // Closing it removes it from the whole tree.
    const target = s.splits as { id: string; tabs: { id: string }[] }
    s = closeTab(s, target.id, explorerId)
    expect(tabOpenIn(s, explorerId)).toBe(false)
    // A terminal tab added later is open too.
    s = openTab(s, { id: 'terminal:9', type: 'terminal', title: 'Terminal 9' })
    expect(tabOpenIn(s, 'terminal:9')).toBe(true)
  })
})

describe('pty helpers', () => {
  it('falls back from an empty SHELL to a usable shell', () => {
    const previous = process.env.SHELL
    try {
      process.env.SHELL = ''
      expect(defaultShell()).toBe('/bin/bash')
      delete process.env.SHELL
      expect(defaultShell()).toBe('/bin/bash')
    } finally {
      if (previous === undefined) delete process.env.SHELL
      else process.env.SHELL = previous
    }
  })

  it('restores the spawn-helper executable bit idempotently', () => {
    // On non-Windows the helper must exist and be executable after the fix.
    if (process.platform === 'win32') return
    ensureSpawnHelper()
    ensureSpawnHelper()
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    const { dirname, join } = require('node:path') as typeof import('node:path')
    const { createRequire } = require('node:module') as typeof import('node:module')
    const entry = createRequire(import.meta.url).resolve('node-pty')
    const root = dirname(dirname(entry))
    const helper = join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    expect(existsSync(helper)).toBe(true)
    const { statSync } = require('node:fs') as typeof import('node:fs')
    expect((statSync(helper).mode & 0o111) !== 0).toBe(true)
  })
})

describe('produced-files derivation', () => {
  const diffResult = (path: string) => ({
    kind: 'tool-result', isError: false, callView: { card: 'diff', locations: [{ path }] },
  })
  const editResult = (path: string) => ({
    kind: 'tool-result', isError: false, callView: { card: 'generic', kind: 'edit', locations: [{ path }] },
  })

  it('collects diff/edit locations of the closing turn, first-seen order', () => {
    const nodes = [
      { kind: 'assistant', seq: 1, turn: 1 },
      diffResult('a.ts'),
      editResult('b.ts'),
      diffResult('a.ts'),
      { kind: 'assistant', seq: 2, turn: 1 },
    ]
    expect(producedForClosing(nodes, 2)).toEqual(['a.ts', 'b.ts'])
  })

  it('resets on user messages and turn changes', () => {
    const nodes = [
      { kind: 'assistant', seq: 1, turn: 1 },
      diffResult('old.ts'),
      { kind: 'user' },
      { kind: 'assistant', seq: 2, turn: 2 },
      diffResult('new.ts'),
      { kind: 'assistant', seq: 3, turn: 2 },
    ]
    expect(producedForClosing(nodes, 3)).toEqual(['new.ts'])
  })

  it('ignores reads, deletes, errors, and unknown cards', () => {
    const nodes = [
      { kind: 'assistant', seq: 1, turn: 1 },
      { kind: 'tool-result', isError: true, callView: { card: 'diff', locations: [{ path: 'x.ts' }] } },
      { kind: 'tool-result', isError: false, callView: { card: 'read', locations: [{ path: 'r.ts' }] } },
      { kind: 'tool-result', isError: false, callView: { card: 'generic', kind: 'delete', locations: [{ path: 'd.ts' }] } },
    ]
    expect(producedForClosing(nodes, 1)).toEqual([])
  })

  it('selector claims only when files exist', () => {
    expect(selectProducedFiles({ nodes: [{ kind: 'assistant', seq: 1, turn: 1 }], seq: 1 })).toBeNull()
    expect(selectProducedFiles({ nodes: [diffResult('a.ts'), { kind: 'assistant', seq: 1, turn: 1 }], seq: 1 })).toEqual(['a.ts'])
    expect(selectProducedFiles(null)).toBeNull()
  })

  it('resolves relative paths against the session cwd', () => {
    expect(resolveSidebarPath('/work/proj', 'src/a.ts')).toBe('/work/proj/src/a.ts')
    expect(resolveSidebarPath('/work/proj', '/abs/x.ts')).toBe('/abs/x.ts')
    expect(resolveSidebarPath(undefined, 'a.ts')).toBe('a.ts')
  })
})

describe('persisted state sanitization', () => {
  it('accepts a well-formed state unchanged (node environment: no width clamp)', () => {
    const state = makeDefaultState(400)
    const clean = sanitizeState(JSON.parse(JSON.stringify(state)))
    expect(clean).toEqual(state)
  })

  it('clamps undersized widths to the panel minimum', () => {
    const state = { ...makeDefaultState(400), width: 10 }
    const clean = sanitizeState(JSON.parse(JSON.stringify(state)))
    expect(clean?.width).toBe(280)
  })

  it('rejects malformed shapes instead of crashing the panel', () => {
    expect(sanitizeState(null)).toBeUndefined()
    expect(sanitizeState('nope')).toBeUndefined()
    expect(sanitizeState({})).toBeUndefined()
    expect(sanitizeState({ ...makeDefaultState(400), width: 'wide' })).toBeUndefined()
    expect(sanitizeState({ ...makeDefaultState(400), panelOpen: 1 })).toBeUndefined()
    // A split whose sizes do not match its children is rejected.
    const withSplit = JSON.parse(JSON.stringify(makeDefaultState(400)))
    withSplit.splits = { kind: 'split', id: 's1', dir: 'row', sizes: [0.5], children: [] }
    expect(sanitizeState(withSplit)).toBeUndefined()
    // Unknown tab types (older layouts) are rejected.
    const withBadTab = JSON.parse(JSON.stringify(makeDefaultState(400)))
    withBadTab.splits.tabs[0].type = 'watcher'
    expect(sanitizeState(withBadTab)).toBeUndefined()
    // An active id that no tab carries is rejected.
    const withBadActive = JSON.parse(JSON.stringify(makeDefaultState(400)))
    withBadActive.splits.active = 'ghost-tab'
    expect(sanitizeState(withBadActive)).toBeUndefined()
  })

  it('re-ids stale duplicate pane/split ids and follows the activePane rename', () => {
    // The pre-seeding counter reset could mint a fresh "pane:1" beside the
    // persisted "pane:1": mapLeaf then hit BOTH leaves and every open landed
    // in both panes. Sanitize must give the repeat a fresh id.
    const corrupted = JSON.parse(JSON.stringify(makeDefaultState(400)))
    corrupted.activePane = 'pane:1'
    corrupted.splits = {
      kind: 'split',
      id: 'split:1',
      dir: 'col',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'pane:1', tabs: [], active: null },
        { kind: 'leaf', id: 'pane:1', tabs: [{ id: 'tab:1', type: 'explorer', title: 'Explorer' }], active: 'tab:1' },
      ],
    }
    const clean = sanitizeState(corrupted)
    expect(clean).toBeDefined()
    const leaves = allLeaves(clean!.splits)
    // The first occurrence keeps its id; the repeat gets a fresh unique one
    // (exact suffix depends on the module-level uid counter, so assert shape).
    expect(leaves[0]!.id).toBe('pane:1')
    expect(new Set(leaves.map(leaf => leaf.id)).size).toBe(2)
    expect(clean!.activePane).toBe(leaves[1]!.id)
    // And an open must land in exactly one pane of the healed tree.
    const opened = openTab(clean!, { id: 'editor:/a.ts', type: 'editor', title: 'a.ts', path: '/a.ts' })
    const owners = allLeaves(opened.splits).filter(leaf => leaf.tabs.some(tab => tab.path === '/a.ts'))
    expect(owners).toHaveLength(1)
  })

  it('falls back from a stale active pane instead of dropping the open', () => {
    let s = makeDefaultState()
    const paneA = allLeaves(s.splits)[0]!.id
    const explorerTab = allLeaves(s.splits)[0]!.tabs.find(tab => tab.type === 'explorer')!.id
    s = closeTab(s, paneA, explorerTab)
    s = openTab(s, { id: 'editor:/a.ts', type: 'editor', title: 'a.ts', path: '/a.ts' })
    const split = insertLeafAt(s.splits, paneA, 'col', { id: 'terminal:1', type: 'terminal', title: 'Terminal 1' }, false)
    s = { ...s, splits: split.node, activePane: paneA }
    // Closing the editor empties paneA; the pane is removed but activePane
    // still points at it. The next open must land in the surviving pane.
    s = closeTab(s, paneA, 'editor:/a.ts')
    s = openTab(s, { id: 'editor:/b.ts', type: 'editor', title: 'b.ts', path: '/b.ts' })
    const owners = allLeaves(s.splits).filter(leaf => leaf.tabs.some(tab => tab.path === '/b.ts'))
    expect(owners).toHaveLength(1)
    expect(owners[0]!.tabs.some(tab => tab.type === 'terminal')).toBe(true)
  })
})

describe('path helpers', () => {
  it('derives relative paths under the cwd (and "." for the cwd itself)', () => {
    expect(relativeTo('/Users/me/code', '/Users/me/code/src/main.ts')).toBe('src/main.ts')
    expect(relativeTo('/Users/me/code', '/Users/me/code')).toBe('.')
    expect(relativeTo('/Users/me/code/', '/Users/me/code/src/a/b.ts')).toBe('src/a/b.ts')
  })

  it('falls back to the path unchanged when it lies outside the cwd', () => {
    expect(relativeTo('/Users/me/code', '/Users/other/x.ts')).toBe('/Users/other/x.ts')
    expect(relativeTo('/Users/me/code', '/Users/me/codex/y.ts')).toBe('/Users/me/codex/y.ts')
  })

  it('handles windows roots and mixed separators', () => {
    expect(relativeTo('C:\\Users\\me', 'C:\\Users\\me\\src\\a.ts')).toBe('src/a.ts')
    expect(relativeTo('C:\\Users\\me', 'C:/Users/me/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('C:\\Users\\me\\', 'C:\\Users\\me')).toBe('.')
  })
})

describe('editor language mapping', () => {
  it('derives extensions from paths', () => {
    expect(extOf('/a/b/main.tsx')).toBe('tsx')
    expect(extOf('README.MD')).toBe('md')
    expect(extOf('/a/b/.gitignore')).toBe('gitignore')
    expect(extOf('noext')).toBe('')
  })

  it('maps common extensions to languages and falls back to plain text', () => {
    expect(languageKeyForExt('tsx')).toBe('tsx')
    expect(languageKeyForExt('js')).toBe('js')
    expect(languageKeyForExt('py')).toBe('python')
    expect(languageKeyForExt('yaml')).toBe('yaml')
    expect(languageKeyForExt('sh')).toBe('shell')
    expect(languageKeyForExt('md')).toBe('md')
    expect(languageKeyForExt('txt')).toBeNull()
    expect(languageKeyForExt('log')).toBeNull()
    expect(languageKeyForExt('')).toBeNull()
  })
})
