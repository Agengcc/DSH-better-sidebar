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
import { SIDEBAR_PREFS_DEFAULTS, type SidebarPrefs } from '../prefs-shared.ts'

export type TabType = 'explorer' | 'git' | 'editor' | 'terminal' | 'subagent'

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

/**
 * The largest numeric suffix across a raw persisted state's counter ids
 * (`pane:N` / `tab:N` / `split:N`). The uid counter is module-global and
 * resets on every reload, so a split minted AFTER a reload would collide
 * with the persisted ids (a fresh "pane:1" beside the persisted "pane:1");
 * mapLeaf would then visit BOTH leaves and every open would land in both
 * panes of the split. Seeding the counter past the persisted ids keeps
 * fresh ids disjoint.
 */
function maxCounterId(parsed: unknown): number {
  let max = 0
  const consider = (id: unknown): void => {
    if (typeof id !== 'string') return
    const match = /^(?:pane|tab|split):(\d+)$/.exec(id)
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    consider(record.id)
    if (Array.isArray(record.tabs)) {
      for (const tab of record.tabs) {
        if (tab !== null && typeof tab === 'object') consider((tab as Record<string, unknown>).id)
      }
    }
    if (Array.isArray(record.children)) {
      for (const child of record.children) walk(child)
    }
  }
  walk((parsed as Record<string, unknown> | null)?.splits)
  return max
}

/** A fresh default state: one explorer tab in one pane, open per the caller's
 * preference. `width` is the caller's preferred panel width (default
 * PANEL_DEFAULT) and `panelOpen` whether the panel starts expanded (default
 * true); the store seeds new sessions from the user's side card prefs. */
export function makeDefaultState(width = PANEL_DEFAULT, panelOpen = true): SidebarState {
  const leaf: SidebarLeaf = { kind: 'leaf', id: uid('pane'), tabs: [], active: null }
  leaf.tabs = [{ id: uid('tab'), type: 'explorer', title: 'Explorer' }]
  leaf.active = leaf.tabs[0]!.id
  return {
    panelOpen,
    width,
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

/** Whether a tab exists anywhere in a state tree (any pane). */
export function tabOpenIn(state: SidebarState, tabId: string): boolean {
  return allLeaves(state.splits).some(leaf => leaf.tabs.some(tab => tab.id === tabId))
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
 * Split a leaf by inserting a fresh leaf holding `tab` beside it — the
 * VSCode drag-to-edge gesture. `dir` is the split direction ('row' for
 * left/right, 'col' for up/down); `front` places the new leaf first (left/
 * up) or second (right/down).
 * @returns the new tree plus the fresh leaf's id (the drop's active pane).
 */
export function insertLeafAt(
  node: SplitNode,
  paneId: string,
  dir: 'row' | 'col',
  tab: SidebarTab,
  front: boolean,
): { node: SplitNode; leafId: string } {
  const fresh: SidebarLeaf = { kind: 'leaf', id: uid('pane'), tabs: [tab], active: tab.id }
  const leafId = fresh.id
  const next = mapLeaf(node, paneId, (leaf) => {
    const target: SidebarLeaf = { ...leaf }
    const split: SidebarSplit = {
      kind: 'split',
      id: uid('split'),
      dir,
      sizes: [0.5, 0.5],
      children: front ? [fresh, target] : [target, fresh],
    }
    Object.assign(leaf, split)
  })
  return { node: next, leafId }
}

/** Where a tab drop lands on a pane: an edge creates a split, center merges. */
export type DropZone = 'left' | 'right' | 'up' | 'down' | 'center'

/**
 * The VSCode drag gesture: move a tab out of its pane and either merge it
 * into the target pane (center) or split the target pane with the tab in a
 * fresh leaf (edge). The source pane collapses when it empties.
 */
export function moveTabToEdge(
  state: SidebarState,
  fromPane: string,
  tabId: string,
  toPane: string,
  zone: DropZone,
): SidebarState {
  if (fromPane === toPane && zone === 'center') {
    // Dropped back onto its own pane's center: reorder to the end.
    return moveTab(state, fromPane, tabId, toPane, -1)
  }
  const source = leafWithTab(state.splits, tabId)
  if (source === undefined) return state
  const tab = source.tabs.find(candidate => candidate.id === tabId)!
  let emptied = false
  let splits = mapLeaf(state.splits, source.id, (leaf) => {
    leaf.tabs = leaf.tabs.filter(candidate => candidate.id !== tabId)
    if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null
    if (leaf.tabs.length === 0) emptied = true
  })
  if (emptied) splits = removeLeafAt(splits, source.id)
  if (zone === 'center') {
    splits = mapLeaf(splits, toPane, (leaf) => {
      leaf.tabs = [...leaf.tabs, tab]
      leaf.active = tab.id
    })
    return { ...state, splits, activePane: toPane }
  }
  const dir = zone === 'left' || zone === 'right' ? 'row' : 'col'
  const result = insertLeafAt(splits, toPane, dir, tab, zone === 'left' || zone === 'up')
  return { ...state, splits: result.node, activePane: result.leafId }
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

/** Whether a tab type is single-instance per session (explorer/git/subagent). */
function isSingle(type: TabType): boolean {
  return type === 'explorer' || type === 'git' || type === 'subagent'
}

/**
 * Open a tab (or focus its existing instance). Single-instance types focus
 * the existing tab wherever it lives; editors dedupe by path. The tab lands
 * in the active pane (or the first pane when the active one is gone).
 */
export function openTab(state: SidebarState, tab: SidebarTab): SidebarState {
  let targetId = state.activePane ?? firstLeaf(state.splits).id
  // A stale activePane (its pane was closed since) must not swallow the
  // open: fall back to the first pane instead of dropping the tab.
  if (!allLeaves(state.splits).some(leaf => leaf.id === targetId)) {
    targetId = firstLeaf(state.splits).id
  }
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

/** Set the panel width (clamped to the contract range; the upper bound is
 * the viewport so the fullscreen expansion can fill the window). */
export function setWidth(state: SidebarState, width: number): SidebarState {
  const max = typeof window !== 'undefined' ? Math.max(PANEL_MIN, window.innerWidth) : PANEL_MAX
  return { ...state, width: Math.min(max, Math.max(PANEL_MIN, Math.round(width))) }
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

/** Prefix marking a tab id as an agent-owned terminal (suffix is the uuid). */
export const AGENT_TAB_PREFIX = 'agent:'

/**
 * Reconcile the sidebar's agent-terminal tabs with the host's live list.
 * The host pushes the current list of agent terminals (created by the model
 * through the `terminal_create` tool) over a dedicated WebSocket; this
 * reducer mirrors that list into tabs: new uuids get a tab, vanished uuids
 * lose theirs. The agent owns the lifetime — the user closing a tab sends a
 * WS close frame that kills the pty, which fires a change, which converges
 * the view. Idempotent: a no-op when the lists already match.
 * @param state - the current per-session sidebar state.
 * @param agentTerminals - the live agent terminal snapshots from the host.
 * @returns the next state (or the same reference if no change was needed).
 */
export function reconcileAgentTerminals(
  state: SidebarState,
  agentTerminals: ReadonlyArray<{ uuid: string; title: string }>,
): SidebarState {
  const existingTabs = allLeaves(state.splits).flatMap(leaf => leaf.tabs)
  const existingAgentTabs = existingTabs.filter(tab => tab.id.startsWith(AGENT_TAB_PREFIX))
  const existingUuids = new Set(existingAgentTabs.map(tab => tab.id.slice(AGENT_TAB_PREFIX.length)))
  const serverUuids = new Set(agentTerminals.map(t => t.uuid))
  const toAdd = agentTerminals.filter(t => !existingUuids.has(t.uuid))
  const toRemove = existingAgentTabs.filter(tab => !serverUuids.has(tab.id.slice(AGENT_TAB_PREFIX.length)))
  if (toAdd.length === 0 && toRemove.length === 0) return state
  // Remove tabs whose uuids vanished from the server list (the agent closed
  // them, or the pty exited and was reaped). Reuse closeTab's leaf cleanup.
  let splits = state.splits
  for (const tab of toRemove) {
    const leaf = leafWithTab(splits, tab.id)
    if (leaf !== undefined) {
      splits = closeTab({ ...state, splits }, leaf.id, tab.id).splits
    }
  }
  // Add tabs for new uuids (the agent created a terminal). They land in the
  // active pane via openTab; the next reconcile is a no-op for them.
  let next: SidebarState = { ...state, splits }
  for (const terminal of toAdd) {
    const tab: SidebarTab = {
      id: `${AGENT_TAB_PREFIX}${terminal.uuid}`,
      type: 'terminal',
      title: terminal.title,
    }
    next = openTab(next, tab)
  }
  return next
}

// ── The per-session store ──────────────────────────────────────────────────

const STORAGE_PREFIX = 'dsh-sidebar:v1'

/** Immutable snapshot handed to React (replaced only on real changes). */
export interface SidebarSnapshot {
  sessionId: string | undefined
  state: SidebarState | undefined
}

/** Default panel width for one viewport: the prefs percent of the window,
 * clamped to the panel floor (a tiny percent must stay usable) and to the
 * viewport (a large one must never cover the whole window). */
export function defaultWidthFor(viewport: number, percent: number): number {
  return Math.min(viewport, Math.max(PANEL_MIN, Math.round(viewport * percent / 100)))
}

function loadState(sessionId: string, prefs: SidebarPrefs): SidebarState {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}:${sessionId}`)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as unknown
      // Seed the uid counter past the persisted ids (it resets on reload);
      // sanitize re-ids any duplicates the pre-seeding counter left behind.
      nextIdCounter = maxCounterId(parsed)
      const sanitized = sanitizeState(parsed)
      if (sanitized !== undefined) return sanitized
    }
  } catch {
    // Corrupt or unavailable storage: fall through to the default.
  }
  // New sessions seed from the user's side card prefs: the width is the
  // chosen percent of the window (clamped to the panel floor and the
  // viewport so a huge percent can never crush the app shell), and the
  // panel starts open only when the preference says so.
  const viewport = typeof window !== 'undefined' ? window.innerWidth : undefined
  const width = viewport === undefined
    ? PANEL_DEFAULT
    : defaultWidthFor(viewport, prefs.defaultWidthPercent)
  return makeDefaultState(width, prefs.openByDefault)
}

/**
 * Structural validation of one persisted state. A malformed or stale shape
 * (older layouts, hand-edited storage) must fall back to the default instead
 * of crashing the panel on every reload; the restored width is also clamped
 * to the current viewport so a stale fullscreen width can never crush the
 * app shell (margin-right larger than the window) or cover the whole screen.
 * @returns a clean state, or undefined to fall back to the default.
 */
export function sanitizeState(parsed: unknown): SidebarState | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.panelOpen !== 'boolean') return undefined
  if (typeof record.width !== 'number' || !Number.isFinite(record.width)) return undefined
  if (typeof record.nextTerminal !== 'number' || !Number.isInteger(record.nextTerminal) || record.nextTerminal < 1) {
    return undefined
  }
  if (typeof record.activePane !== 'string' && record.activePane !== null) return undefined
  if (!Array.isArray(record.expanded) || record.expanded.some(item => typeof item !== 'string')) return undefined
  const reid = new Map<string, string>()
  const splits = sanitizeNode(record.splits, new Set(), reid)
  if (splits === undefined) return undefined
  const maxWidth = typeof window !== 'undefined' ? window.innerWidth : Infinity
  return {
    panelOpen: record.panelOpen,
    width: Math.max(PANEL_MIN, Math.min(record.width, maxWidth)),
    // A stale duplicate pane id may have been re-ided; follow the rename so
    // new tabs still land in the pane the user was using.
    activePane: typeof record.activePane === 'string' ? (reid.get(record.activePane) ?? record.activePane) : null,
    nextTerminal: record.nextTerminal,
    expanded: record.expanded as string[],
    splits,
  }
}

/**
 * One tree node id, deduplicated against the ids already seen in this
 * state. Duplicates are exactly the pre-seeding counter-reset corruption
 * (a "pane:1"/"split:1" minted after a reload beside the persisted ones):
 * keeping both would make mapLeaf visit two leaves at once and every open
 * would land in both panes, so the repeat gets a fresh id.
 * @returns the id to use (the original, or a fresh uid for repeats).
 */
function uniqueNodeId(id: string, seen: Set<string>, reid: Map<string, string>): string {
  if (!seen.has(id)) {
    seen.add(id)
    return id
  }
  const prefix = /^split:\d+$/.test(id) ? 'split' : 'pane'
  const fresh = uid(prefix)
  seen.add(fresh)
  reid.set(id, fresh)
  return fresh
}

/** Validate one split-tree node (leaf or split) and rebuild it cleanly. */
function sanitizeNode(node: unknown, seen: Set<string>, reid: Map<string, string>): SplitNode | undefined {
  if (node === null || typeof node !== 'object') return undefined
  const record = node as Record<string, unknown>
  if (record.kind === 'leaf') {
    if (typeof record.id !== 'string' || !Array.isArray(record.tabs)) return undefined
    const tabs: SidebarTab[] = []
    for (const tab of record.tabs) {
      if (tab === null || typeof tab !== 'object') return undefined
      const candidate = tab as Record<string, unknown>
      if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string') return undefined
      if (
        candidate.type !== 'explorer' && candidate.type !== 'git'
        && candidate.type !== 'editor' && candidate.type !== 'terminal'
        && candidate.type !== 'subagent'
      ) {
        return undefined
      }
      tabs.push({
        id: candidate.id,
        type: candidate.type,
        title: candidate.title,
        ...(typeof candidate.path === 'string' ? { path: candidate.path } : {}),
      })
    }
    const active = typeof record.active === 'string' ? record.active : null
    if (active !== null && !tabs.some(tab => tab.id === active)) return undefined
    return { kind: 'leaf', id: uniqueNodeId(record.id, seen, reid), tabs, active }
  }
  if (record.kind === 'split') {
    if (typeof record.id !== 'string' || (record.dir !== 'row' && record.dir !== 'col')) return undefined
    if (!Array.isArray(record.children) || !Array.isArray(record.sizes)) return undefined
    const children: SplitNode[] = []
    for (const child of record.children) {
      const clean = sanitizeNode(child, seen, reid)
      if (clean === undefined) return undefined
      children.push(clean)
    }
    if (children.length < 2) return undefined
    if (
      record.sizes.length !== children.length
      || record.sizes.some(size => typeof size !== 'number' || !Number.isFinite(size) || size <= 0)
    ) {
      return undefined
    }
    return { kind: 'split', id: uniqueNodeId(record.id, seen, reid), dir: record.dir, sizes: record.sizes as number[], children }
  }
  return undefined
}

/** The session-scoped store: one state per conversation, localStorage-backed. */
export class SidebarStore {
  private readonly bySession = new Map<string, SidebarState>()
  private snapshot: SidebarSnapshot = { sessionId: undefined, state: undefined }
  private readonly listeners = new Set<() => void>()
  private persistTimer: number | undefined
  /** User-facing side card prefs seeding brand-new session states (defaults until the settings RPC resolves). */
  private prefs: SidebarPrefs = { ...SIDEBAR_PREFS_DEFAULTS }

  /** Replace the side card prefs (the settings RPC result / settings page write). */
  setPrefs(prefs: SidebarPrefs): void {
    this.prefs = { ...prefs }
  }

  /** The current side card prefs (seeds new sessions; persisted states win). */
  getPrefs(): SidebarPrefs {
    return { ...this.prefs }
  }

  /** Select a session (or none); loads its persisted state. */
  setSession(sessionId: string | undefined): void {
    if (this.snapshot.sessionId === sessionId) return
    if (sessionId === undefined) {
      this.snapshot = { sessionId: undefined, state: undefined }
    } else {
      let state = this.bySession.get(sessionId)
      if (state === undefined) {
        state = loadState(sessionId, this.prefs)
        this.bySession.set(sessionId, state)
      } else {
        // Cache hit: another session's load/ops may have left the uid
        // counter below THIS session's persisted ids — re-seed so fresh
        // pane/split ids can never collide with its tree.
        nextIdCounter = maxCounterId(state)
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

  /**
   * Whether a tab still exists in its session's state. Views use this on
   * unmount to tell "the tab was closed" (release the terminal now) from
   * "the tree re-rendered / the conversation switched" (the tab is still
   * open — keep the terminal alive through the host's reconnect grace).
   * Checks the session's own map entry (the current snapshot may already
   * point at another session when a conversation switch unmounts the old
   * one's tabs).
   */
  tabOpen(sessionId: string, tabId: string): boolean {
    const state = this.bySession.get(sessionId)
      ?? (this.snapshot.sessionId === sessionId ? this.snapshot.state : undefined)
    return state !== undefined && tabOpenIn(state, tabId)
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

/**
 * Create one sidebar store instance. Production code calls this only from
 * the client plugin's `apply` (the instance is handed to components as a
 * prop); tests call it directly. No module-level singleton: the store's
 * lifetime belongs to the plugin activation, exactly like the official
 * `createXXXStore()` factory rule.
 */
export function createSidebarStore(): SidebarStore {
  return new SidebarStore()
}
