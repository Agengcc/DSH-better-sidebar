import { describe, expect, it } from 'vitest'
import { compareEntries, parentOf, rootLabel, requireAbsolute } from '../src/fs-tree.ts'
import { parseLogLines, parsePorcelainZ } from '../src/git.ts'
import {
  activateTab, closeTab, makeDefaultState, moveTab, openTab, resizeSplit,
  splitPane, toggleExpanded, type SidebarState, type SplitNode,
} from '../src/client/state.ts'
import { producedForClosing, resolveSidebarPath, selectProducedFiles } from '../src/client/produced-files.ts'

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
