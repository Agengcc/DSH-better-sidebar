/**
 * The BetterSidebar client service: a registry that external plugins use
 * to contribute sidebar tab types and file previewers. The service is
 * published to the cordis context as `ctx.betterSidebar` (see
 * {@link ../types.ts}); consumers declare it in `inject` and call
 * `registerTab` / `registerFileViewer`, both returning a disposer that
 * cordis auto-invokes on fiber disposal (HMR-safe).
 *
 * Design notes:
 * - The registry is synchronous-snapshot (Map + listener set) so React
 *   can read it through `useSyncExternalStore` without tearing.
 * - `dedupeKey` unifies the three open-tab strategies the builtins used to
 *   hardcode: single-instance (`() => type`), per-path (`tab => tab.path`),
 *   and per-id (`tab => tab.id` for diff tabs whose id is change-derived).
 * - `createTab` lets a descriptor own tab instantiation (the terminal
 *   builtin uses it to mint `terminal:<n>` ids and bump `nextTerminal`).
 * - `matchFileViewer` resolves viewers by priority (desc), then `detect`
 *   (content sniff), then `exts` (lowercase, no dot).
 */
import type { ReactNode } from 'react'
import type { Context } from '../context-types.ts'
import {
  activateTab, allLeaves, closeTab as closeTabReducer, firstLeaf, mapLeaf,
  type SidebarState, type SidebarStore, type SidebarTab,
} from './state.ts'
import type { SessionScope } from './api.ts'

/** Props every tab component receives (builtins and external alike). */
export interface TabComponentProps {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  tab: SidebarTab
  /** Whether this tab is the active one AND the panel is open (live views pause otherwise). */
  visible: boolean
  /** The explorer's expanded directory set (ExplorerView). */
  expanded?: string[]
  onToggleDir?: (path: string) => void
  onReferenceFile?: (path: string) => void
  onOpenFile?: (path: string) => void
  onOpenDiff?: (tab: SidebarTab) => void
  onSubagentJump?: (childSessionId: string) => void
}

/** Describes one kind of sidebar tab (builtins register themselves too). */
export interface TabDescriptor {
  /** Unique id; also the `SidebarTab.type` value (`'explorer'`, `'my-plugin:db'`). */
  id: string
  title: string | (() => string)
  icon?: ReactNode | ((size: number) => ReactNode)
  /** + menu sort order (ascending); default 100. */
  order?: number
  /** Hide from the + menu (the editor tab is opened by file-open, not by the menu). */
  hidden?: boolean
  /** + menu disabled predicate (e.g. terminal at capacity). */
  available?: (state: SidebarState) => boolean
  /**
   * If provided, opening a tab whose `dedupeKey(tab)` matches an existing
   * tab's key focuses the existing one instead of creating a new one.
   * Returning `undefined` means "no dedup — always open a new tab".
   * Builtins: explorer/git/subagent use `() => id`; editor uses `tab => tab.path`;
   * diff uses `tab => tab.id` (openDiffTab mints change-derived ids).
   */
  dedupeKey?: (tab: SidebarTab) => string | undefined
  /**
   * Custom tab creation (minting the `SidebarTab` and any state patches).
   * Return `null` to refuse creation. The terminal builtin uses this to
   * mint `terminal:<n>` ids and bump `nextTerminal`.
   * When omitted, a default `{ id, type, title }` tab is created.
   */
  createTab?: (state: SidebarState) => { tab: SidebarTab; patch?: Partial<SidebarState> } | null
  component: (props: TabComponentProps) => ReactNode
}

/** How the host loads a file's bytes for one viewer. */
export type FileFetchStrategy =
  | 'none'               // no bytes needed (image/pdf/office fetch through mediaUrl themselves)
  | 'fsRead'             // text read through /sidebar/api fs.read
  | 'mediaUrl'           // the viewer gets a media URL string
  | 'custom'             // the viewer's load() fetches its own bytes
  | 'binary-download'    // show a download button (no client-side renderer)

/** Props every file viewer component receives. */
export interface FileViewerProps {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  path: string
  title: string
  /** fsRead text content (fetchStrategy='fsRead'). */
  content?: string
  truncated?: boolean
  /** mediaUrl for the path (fetchStrategy='mediaUrl'). */
  mediaUrl?: string
  /** custom load() return value (fetchStrategy='custom'). */
  customData?: unknown
}

/** Describes one file previewer (builtins register themselves too). */
export interface FileViewerDescriptor {
  /** Unique id (`'image'`, `'pdf'`, `'my-plugin:csv'`). */
  id: string
  /** Lowercase extensions without leading dot (`['png','jpg']`). `[]` = match any (catch-all). */
  exts: readonly string[]
  /** Higher wins; default 0. Builtins use 0; the catch-all `code` viewer uses -100. */
  priority?: number
  fetchStrategy: FileFetchStrategy
  /**
   * Content sniff (overrides exts when `head` bytes are available).
   * The first descriptor (priority desc) whose `detect` returns true wins.
   */
  detect?: (path: string, head: Uint8Array) => boolean
  /** fetchStrategy='custom' loader. */
  load?: (path: string, scope: SessionScope) => Promise<unknown>
  component: (props: FileViewerProps) => ReactNode
}

/** The registry service published as `ctx.betterSidebar`. */
export interface BetterSidebarService {
  registerTab(descriptor: TabDescriptor): () => void
  registerFileViewer(descriptor: FileViewerDescriptor): () => void
  getTabs(): readonly TabDescriptor[]
  getFileViewers(): readonly FileViewerDescriptor[]
  /** Find a tab descriptor by id (undefined if not registered). */
  getTab(id: string): TabDescriptor | undefined
  /** Find a file viewer for a path (priority desc → detect → exts). */
  matchFileViewer(path: string, head?: Uint8Array): FileViewerDescriptor | undefined
  /** Open a tab (used by external tabs and the + menu). */
  openTab(seed: { type: string; title: string; path?: string; diff?: SidebarTab['diff'] }): void
  /** Close a tab by id. */
  closeTab(tabId: string): void
  /** Subscribe to registry changes (register/dispose). */
  subscribe(listener: () => void): () => void
}

/** Extract the lowercase extension without leading dot from a path. */
function extOfPath(path: string): string {
  const at = path.lastIndexOf('.')
  if (at === -1) return ''
  const base = path.slice(at + 1).toLowerCase()
  return base.includes('/') || base.includes('\\') ? '' : base
}

/**
 * Create one BetterSidebar service bound to a store. The service owns the
 * tab/viewer registries (Map + listener set) and proxies openTab/closeTab
 * to the store's reducer. One instance per client plugin activation.
 */
export function createBetterSidebarService(store: SidebarStore): BetterSidebarService {
  const tabs = new Map<string, TabDescriptor>()
  const viewers = new Map<string, FileViewerDescriptor>()
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const fn of [...listeners]) fn()
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  const registerTab = (descriptor: TabDescriptor): (() => void) => {
    if (tabs.has(descriptor.id)) {
      throw new Error(`[dsh-better-sidebar] tab type "${descriptor.id}" already registered`)
    }
    tabs.set(descriptor.id, descriptor)
    notify()
    return () => {
      if (tabs.get(descriptor.id) === descriptor) {
        tabs.delete(descriptor.id)
        notify()
      }
    }
  }

  const registerFileViewer = (descriptor: FileViewerDescriptor): (() => void) => {
    if (viewers.has(descriptor.id)) {
      throw new Error(`[dsh-better-sidebar] file viewer "${descriptor.id}" already registered`)
    }
    viewers.set(descriptor.id, descriptor)
    notify()
    return () => {
      if (viewers.get(descriptor.id) === descriptor) {
        viewers.delete(descriptor.id)
        notify()
      }
    }
  }

  const getTabs = (): readonly TabDescriptor[] => Array.from(tabs.values())
  const getFileViewers = (): readonly FileViewerDescriptor[] => Array.from(viewers.values())
  const getTab = (id: string): TabDescriptor | undefined => tabs.get(id)

  const matchFileViewer = (path: string, head?: Uint8Array): FileViewerDescriptor | undefined => {
    const ext = extOfPath(path)
    // Priority descending; stable order for equal priorities (insertion order).
    const sorted = Array.from(viewers.values()).sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    )
    // Pass 1: content sniff (detect overrides exts when head bytes are available).
    if (head !== undefined) {
      for (const v of sorted) {
        if (v.detect !== undefined && v.detect(path, head)) return v
      }
    }
    // Pass 2: extension match ([] is catch-all, skipped here).
    for (const v of sorted) {
      if (v.exts.length === 0) continue
      if (v.exts.includes(ext)) return v
    }
    // Pass 3: catch-all (exts === []).
    for (const v of sorted) {
      if (v.exts.length === 0) return v
    }
    return undefined
  }

  const openTab = (seed: { type: string; title: string; path?: string; diff?: SidebarTab['diff'] }): void => {
    store.reduce((state) => {
      const descriptor = tabs.get(seed.type)
      if (descriptor === undefined) return state
      // Let the descriptor mint the tab (terminal's nextTerminal bump, etc.).
      if (descriptor.createTab !== undefined) {
        const result = descriptor.createTab(state)
        if (result === null) return state
        const next = applyDedupe(state, result.tab, descriptor)
        return result.patch !== undefined ? { ...next, ...result.patch } : next
      }
      const tab: SidebarTab = {
        id: seed.type,
        type: seed.type,
        title: typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title,
        ...(seed.path !== undefined ? { path: seed.path } : {}),
        ...(seed.diff !== undefined ? { diff: seed.diff } : {}),
      }
      return applyDedupe(state, tab, descriptor)
    })
  }

  const closeTab = (tabId: string): void => {
    store.reduce((state) => {
      const paneId = findPaneIdOf(state, tabId)
      if (paneId === '') return state
      return closeTabReducer(state, paneId, tabId)
    })
  }

  return {
    registerTab,
    registerFileViewer,
    getTabs,
    getFileViewers,
    getTab,
    matchFileViewer,
    openTab,
    closeTab,
    subscribe,
  }
}

/**
 * Apply dedup: if a tab with the same dedupeKey exists, focus it instead.
 * Mirrors the three branches the old `openTab` hardcoded (single/editor/diff).
 */
function applyDedupe(state: SidebarState, tab: SidebarTab, descriptor: TabDescriptor): SidebarState {
  const key = descriptor.dedupeKey?.(tab)
  if (key !== undefined) {
    for (const leaf of allLeaves(state.splits)) {
      const existing = leaf.tabs.find(t => t.type === tab.type && descriptor.dedupeKey!(t) === key)
      if (existing !== undefined) return activateTab(state, leaf.id, existing.id)
    }
  }
  let targetId = state.activePane ?? firstLeaf(state.splits).id
  if (!allLeaves(state.splits).some(leaf => leaf.id === targetId)) {
    targetId = firstLeaf(state.splits).id
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

/** Find which pane hosts a tab id ('' if none). */
function findPaneIdOf(state: SidebarState, tabId: string): string {
  for (const leaf of allLeaves(state.splits)) {
    if (leaf.tabs.some(t => t.id === tabId)) return leaf.id
  }
  return state.activePane ?? ''
}
