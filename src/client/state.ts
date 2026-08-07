/**
 * Per-session sidebar state: the panel geometry, the split-pane workbench
 * tree, open tabs, and the explorer expansion set. One state instance per
 * conversation id, persisted to localStorage under `dsh-sidebar:v1:<id>` so
 * a reload restores the exact layout of the session it belongs to — switching
 * conversations swaps the whole state (memory + isolation).
 *
 * The split tree is a recursive structure: a leaf holds a tab group, a split
 * divides the space row- or column-wise with fractional sizes. All tree
 * operations are pure functions over the node, unit-tested in tests/state.spec.ts.
 */
export type TabType = 'explorer' | 'git' | 'editor' | 'terminal'

/** One open tab. `path` carries the file (editor) or is absent (explorer/git). */
export interface SidebarTab {
  id: string
  type: TabType
  title: string
  path?: string
}

/** A tab group. */
export interface SidebarLeaf {
  kind: 'leaf'
  id: string
  tabs: SidebarTab[]
  active: string | null
}

/** A recursive split between child panes (fractional sizes summing to 1). */
export interface SidebarSplit {
  kind: 'split'
  id: string
  dir: 'row' | 'col'
  sizes: number[]
  children: SplitNode[]
}

export type SplitNode = SidebarLeaf | SidebarSplit

/** The full per-session state. */
export interface SidebarState {
  panelOpen: boolean
  width: number
  /** The pane receiving newly opened tabs (last pane the user touched). */
  activePane: string | null
  /** Monotonic terminal tab counter (ids survive reloads). */
  nextTerminal: number
  /** Explorer expansion set (absolute directory paths). */
  expanded: string[]
  splits: SplitNode
}

export const PANEL_MIN = 280
export const PANEL_MAX = 640
export const PANEL_DEFAULT = 400
export const TAB_MAX_WIDTH = 160
export const TERMINAL_LIMIT = 3

let nextIdCounter = 0
/** Unique pane/tab id within one state instance. */
function uid(prefix: string): string {
  nextIdCounter += 1
  return `${prefix}:${nextIdCounter}`
}

/** A fresh default state: open, default width, one explorer tab in one pane. */
export function makeDefaultState(): SidebarState {
  const leaf: SidebarLeaf = { kind: 'leaf', id: uid('pane'), tabs: [], active: null }
  leaf.tabs = [{ id: uid('tab'), type: 'explorer', title: 'Explorer' }]
  leaf.active = leaf.tabs[0]!.id
  return {
    panelOpen: true,
    width: PANEL_DEFAULT,
    activePane: leaf.id,
    nextTerminal: 1,
    expanded: [],
    splits: leaf,
  }
}

/** Walk the tree and apply `visit` to the leaf with the given id. */
export function mapLeaf(node: SplitNode, paneId: string, visit: (leaf: SidebarLeaf) => void): SplitNode {
  if (node.kind === 'leaf') {
    if (node.id === paneId) {
      const copy: SidebarLeaf = { ...node, tabs: [...node.tabs] }
      visit(copy)
      return copy
    }
    return node
  }
  const split = node
  return {
    ...split,
    sizes: [...split.sizes],
    children: split.children.map(child => mapLeaf(child, paneId, visit)),
  }
}

/** The first leaf of the tree (fallback pane when activePane is gone). */
export function firstLeaf(node: SplitNode): SidebarLeaf {
  if (node.kind === 'leaf') return node
  return firstLeaf(node.children[0]!)
}

/** Find the leaf containing a tab id, if any. */
export function leafWithTab(node: SplitNode, tabId: string): SidebarLeaf | undefined {
  if (node.kind === 'leaf') {
    return node.tabs.some(tab => tab.id === tabId) ? node : undefined
  }
  for (const child of node.children) {
    const found = leafWithTab(child, tabId)
    if (found !== undefined) return found
  }
  return undefined
}

/** All leaves of the tree, depth-first. */
export function allLeaves(node: SplitNode): SidebarLeaf[] {
  if (node.kind === 'leaf') return [node]
  return node.children.flatMap(allLeaves)
}

/** Replace a leaf with a split of it plus a fresh empty leaf. */
export function splitLeafAt(node: SplitNode, paneId: string, dir: 'row' | 'col'): SplitNode {
  const fresh: SidebarLeaf = { kind: 'leaf', id: uid('pane'), tabs: [], active: null }
  return mapLeaf(node, paneId, (leaf) => {
    const target: SidebarLeaf = { ...leaf }
    const split: SidebarSplit = {
      kind: 'split',
      id: uid('split'),
      dir,
      sizes: [0.5, 0.5],
      children: [target, fresh],
    }
    Object.assign(leaf, split)
  })
}

/**
 * Remove a leaf from the tree. A split left with one child promotes that
 * child; removing the last leaf yields an empty leaf.
 */
export function removeLeafAt(node: SplitNode, paneId: string): SplitNode {
  if (node.kind === 'leaf') return node.id === paneId ? { ...node, tabs: [], active: null } : node
  const children = node.children.filter(child => !(child.kind === 'leaf' && child.id === paneId))
  if (children.length === node.children.length) {
    return {
      ...node,
      sizes: [...node.sizes],
      children: node.children.map(child => removeLeafAt(child, paneId)),
    }
  }
  if (children.length === 1) return children[0]!
  return { ...node, sizes: [...node.sizes], children }
}

/** Close a tab; an emptied leaf is removed (unless it is the only pane). */
export function closeTab(state: SidebarState, paneId: string, tabId: string): SidebarState {
  let emptied = false
  const splits = mapLeaf(state.splits, paneId, (leaf) => {
    leaf.tabs = leaf.tabs.filter(tab => tab.id !== tabId)
    if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null
    if (leaf.tabs.length === 0) emptied = true
  })
  return { ...state, splits: emptied ? removeLeafAt(splits, paneId) : splits }
}

/** Activate a tab in its pane. */
export function activateTab(state: SidebarState, paneId: string, tabId: string): SidebarState {
  return {
    ...state,
    activePane: paneId,
    splits: mapLeaf(state.splits, paneId, (leaf) => {
      if (leaf.tabs.some(tab => tab.id === tabId)) leaf.active = tabId
    }),
  }
}

/** Whether a tab type is single-instance per session (explorer/git). */
function isSingle(type: TabType): boolean {
  return type === 'explorer' || type === 'git'
}

/**
 * Open a tab (or focus its existing instance). Single-instance types focus
 * the existing tab wherever it lives; editors dedupe by path. The tab lands
 * in the active pane (or the first pane when the active one is gone).
 */
export function openTab(state: SidebarState, tab: SidebarTab): SidebarState {
  const targetId = state.activePane ?? firstLeaf(state.splits).id
  if (isSingle(tab.type)) {
    for (const leaf of allLeaves(state.splits)) {
      const existing = leaf.tabs.find(candidate => candidate.type === tab.type)
      if (existing !== undefined) return activateTab(state, leaf.id, existing.id)
    }
  }
  if (tab.type === 'editor' && tab.path !== undefined) {
    for (const leaf of allLeaves(state.splits)) {
      const existing = leaf.tabs.find(candidate => candidate.type === 'editor' && candidate.path === tab.path)
      if (existing !== undefined) return activateTab(state, leaf.id, existing.id)
    }
  }
  return {
    ...state,
    activePane: targetId,
    splits: mapLeaf(state.splits, targetId, (leaf) => {
      leaf.tabs = [...leaf.tabs, tab]
      leaf.active = tab.id
    }),
  }
}

/** Move a tab from one pane to another (insert at index; -1 appends). */
export function moveTab(state: SidebarState, fromPane: string, tabId: string, toPane: string, index = -1): SidebarState {
  let moved: SidebarTab | undefined
  let emptied = false
  let splits = mapLeaf(state.splits, fromPane, (leaf) => {
    const found = leaf.tabs.find(tab => tab.id === tabId)
    if (found === undefined) return
    moved = found
    leaf.tabs = leaf.tabs.filter(tab => tab.id !== tabId)
    if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null
    if (leaf.tabs.length === 0) emptied = true
  })
  if (moved === undefined) return state
  if (emptied) splits = removeLeafAt(splits, fromPane)
  splits = mapLeaf(splits, toPane, (leaf) => {
    const insertAt = index >= 0 && index <= leaf.tabs.length ? index : leaf.tabs.length
    leaf.tabs = [...leaf.tabs.slice(0, insertAt), moved!, ...leaf.tabs.slice(insertAt)]
    leaf.active = moved!.id
  })
  return { ...state, splits, activePane: toPane }
}

/** Split the active pane (or the pane containing the active tab). */
export function splitPane(state: SidebarState, dir: 'row' | 'col'): SidebarState {
  const paneId = state.activePane ?? firstLeaf(state.splits).id
  return { ...state, splits: splitLeafAt(state.splits, paneId, dir) }
}

/** Toggle the panel open/closed (opening restores the previous layout). */
export function togglePanel(state: SidebarState): SidebarState {
  return { ...state, panelOpen: !state.panelOpen }
}

/** Set the panel width (clamped to the contract range). */
export function setWidth(state: SidebarState, width: number): SidebarState {
  return { ...state, width: Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(width))) }
}

/** Toggle a directory in the explorer expansion set. */
export function toggleExpanded(state: SidebarState, path: string): SidebarState {
  const expanded = state.expanded.includes(path)
    ? state.expanded.filter(item => item !== path)
    : [...state.expanded, path]
  return { ...state, expanded }
}

/** Adjust one split divider: `i` is the left/top child index, delta in fractions. */
export function resizeSplit(node: SplitNode, splitId: string, index: number, delta: number): SplitNode {
  if (node.kind === 'leaf') return node
  if (node.id === splitId) {
    const sizes = [...node.sizes]
    const left = Math.min(0.92, Math.max(0.08, sizes[index]! + delta))
    const right = Math.min(0.92, Math.max(0.08, sizes[index + 1]! - delta))
    sizes[index] = left
    sizes[index + 1] = right
    return { ...node, sizes }
  }
  return {
    ...node,
    sizes: [...node.sizes],
    children: node.children.map(child => resizeSplit(child, splitId, index, delta)),
  }
}

// ── The per-session store ──────────────────────────────────────────────────

const STORAGE_PREFIX = 'dsh-sidebar:v1'

/** Immutable snapshot handed to React (replaced only on real changes). */
export interface SidebarSnapshot {
  sessionId: string | undefined
  state: SidebarState | undefined
}

function loadState(sessionId: string): SidebarState {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}:${sessionId}`)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as SidebarState
      if (parsed !== null && typeof parsed === 'object' && 'splits' in parsed && 'width' in parsed) {
        return parsed
      }
    }
  } catch {
    // Corrupt or unavailable storage: fall through to the default.
  }
  return makeDefaultState()
}

/** The session-scoped store: one state per conversation, localStorage-backed. */
export class SidebarStore {
  private readonly bySession = new Map<string, SidebarState>()
  private snapshot: SidebarSnapshot = { sessionId: undefined, state: undefined }
  private readonly listeners = new Set<() => void>()
  private persistTimer: number | undefined

  /** Select a session (or none); loads its persisted state. */
  setSession(sessionId: string | undefined): void {
    if (this.snapshot.sessionId === sessionId) return
    if (sessionId === undefined) {
      this.snapshot = { sessionId: undefined, state: undefined }
    } else {
      let state = this.bySession.get(sessionId)
      if (state === undefined) {
        state = loadState(sessionId)
        this.bySession.set(sessionId, state)
      }
      this.snapshot = { sessionId, state }
    }
    this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot(): SidebarSnapshot {
    return this.snapshot
  }

  /** Mutate the current session's state (no-op without a session). */
  update(mutator: (draft: SidebarState) => void): void {
    const sessionId = this.snapshot.sessionId
    const state = this.snapshot.state
    if (sessionId === undefined || state === undefined) return
    const draft = structuredClone(state)
    mutator(draft)
    this.bySession.set(sessionId, draft)
    this.snapshot = { sessionId, state: draft }
    this.schedulePersist(sessionId, draft)
    this.notify()
  }

  /** Apply a pure reducer (returns the next state). */
  reduce(reducer: (state: SidebarState) => SidebarState): void {
    const sessionId = this.snapshot.sessionId
    const state = this.snapshot.state
    if (sessionId === undefined || state === undefined) return
    const next = reducer(state)
    this.bySession.set(sessionId, next)
    this.snapshot = { sessionId, state: next }
    this.schedulePersist(sessionId, next)
    this.notify()
  }

  private schedulePersist(sessionId: string, state: SidebarState): void {
    window.clearTimeout(this.persistTimer)
    this.persistTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(`${STORAGE_PREFIX}:${sessionId}`, JSON.stringify(state))
      } catch {
        // Storage full or unavailable: layout memory is best-effort.
      }
    }, 200)
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** Module-level store instance (one per page; the plugin mounts once). */
export const sidebarStore = new SidebarStore()
