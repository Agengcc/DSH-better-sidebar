/**
 * The sidebar shell: a fixed-position right panel portalled onto
 * document.body (the core AppFrame owns the left sidebar / center / details
 * columns and has no right-side hole for plugins), plus the edge toggle
 * button. The panel width drags from its left edge; the whole layout lives
 * in the per-session store, so switching conversations swaps the sidebar.
 *
 * The shell binds the workbench actions to the store and dispatches tab
 * content to the four views. New tabs come from the + menu (explorer / git /
 * terminal; editors open from the explorer).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { IconChevronRightOutline14, IconFullscreenOutline16, IconPanelLeftOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context, SidebarConversation, SidebarSessionList } from '../context-types.ts'
import {
  agentUuidOf, closeTab, isAgentTabId, leafWithTab, mapLeaf, moveTab, moveTabToEdge, openDiffTab,
  reconcileAgentTerminals,
  resizeSplit, setWidth, toggleExpanded, togglePanel,
  type DropZone, type SidebarState, type SidebarStore, type SidebarTab, type SplitNode,
} from './state.ts'
import { Workbench, type WorkbenchActions } from './split-pane.tsx'
import type { NewTabOption } from './TabBar.tsx'
import type { TabDragPayload } from './TabBar.tsx'
import { relativeTo } from './paths.ts'
import { OrphanedTab } from './OrphanedTab.tsx'
import { detectNewDirectSubagent } from './subagent-detect.ts'
import { t } from './locales.ts'
import { api, type SessionScope } from './api.ts'
import css from './sidebar.module.css'

/** How many consecutive reconnect failures stop the agent-terminals push loop
 * (mirror of the terminal view's own cap; the loop restarts on session switch). */
const FAILURE_LIMIT = 3

/** Render the content of one tab (dispatched by type). */
function TabContent(props: {
  tab: SidebarTab
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  onToggleDir: (path: string) => void
  onReferenceFile: (path: string) => void
  ctx: Context
  store: SidebarStore
  /** Whether this tab is the active one AND the panel is open (live views pause otherwise). */
  visible: boolean
  /** Fired before a topology node jumps to its child session (see Sidebar). */
  onSubagentJump: (childSessionId: string) => void
  /** Open a diff tab from the git panel (placement handled by the store). */
  onOpenDiff: (tab: SidebarTab) => void
}) {
  const { tab, sessionId, cwd, expanded, onToggleDir, onReferenceFile, ctx, store, visible, onSubagentJump, onOpenDiff } = props
  const scope = { sessionId, cwd }
  const descriptor = ctx.betterSidebar?.getTab(tab.type)
  if (descriptor === undefined) {
    return <OrphanedTab ctx={ctx} store={store} scope={scope} tab={tab} visible={visible} />
  }
  return descriptor.component({
    ctx, store, scope, tab, visible, expanded,
    onToggleDir, onReferenceFile, onOpenDiff, onSubagentJump,
  })
}

/** The + menu options for the current state, driven by the tab registry.
 * Hidden tabs (editor/diff) never show; `available` returning false shows
 * a disabled row (e.g. terminal at capacity) instead of hiding the option.
 * Tabs the user disabled in the side card settings are filtered out
 * entirely — re-enabling them is the settings page's job. */
function buildNewTabOptions(state: SidebarState, ctx: Context, scope: SessionScope): NewTabOption[] {
  const service = ctx.betterSidebar
  if (service === undefined) return []
  return service.getTabs()
    .filter(d => !d.hidden && service.isTabEnabled(d.id))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    .map(d => ({
      id: d.id,
      label: typeof d.title === 'function' ? d.title() : d.title,
      disabled: !(d.available?.(ctx, scope, state) ?? true),
      icon: typeof d.icon === 'function' ? d.icon(16) : d.icon,
    }))
}

export function Sidebar(props: { ctx: Context; store: SidebarStore }) {
  const { ctx, store } = props

  // Current conversation (the sessions list feed).
  const sessionList = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.sessions.list.subscribe(callback), [ctx]),
    useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]),
  )
  const current = sessionList.current

  // Per-session sidebar state.
  const snapshot = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  )
  useEffect(() => { store.setSession(current) }, [current, store])

  const state = snapshot.state
  const sessionId = snapshot.sessionId
  const summaryCwd = sessionId === undefined ? undefined : sessionList.byId[sessionId]?.cwd

  // While the session's header is still hydrating (or the session is blank),
  // the list summary may carry no cwd; ask the host once (it falls back to
  // the process cwd) so the explorer root and terminal cwd are real from
  // first paint instead of showing "no session".
  const [fetchedCwd, setFetchedCwd] = useState<string | undefined>(undefined)
  useEffect(() => {
    setFetchedCwd(undefined)
    if (sessionId === undefined || summaryCwd !== undefined) return
    let cancelled = false
    api.sessionCwd({ sessionId })
      .then(result => { if (!cancelled) setFetchedCwd(result.cwd) })
      .catch(() => { /* the explorer/git rows surface their own errors */ })
    return () => { cancelled = true }
  }, [sessionId, summaryCwd])
  const cwd = summaryCwd ?? fetchedCwd

  /**
   * Agent terminals push: subscribe to the host's live list of agent-owned
   * terminals for this session (created by the model through the
   * `terminal_create` tool). The host pushes a JSON array on every
   * create / close / exit; the sidebar reconciles the list into tabs
   * (id `agent:<uuid>`, title from the agent). A disconnected socket
   * retries with a short backoff so a refresh or transient drop reattaches
   * the same shell without losing the agent's work — capped like the
   * terminal view's own reconnect loop, so a refused endpoint never spins
   * forever (the next session switch restarts the loop).
   * While the terminal tab type is disabled in settings, pushes are
   * ignored (no auto-added tabs); re-enabling makes the next push converge.
   */
  useEffect(() => {
    if (sessionId === undefined) return
    let socket: WebSocket | null = null
    let retry: number | undefined
    let closed = false
    let failures = 0
    const connect = (): void => {
      if (closed) return
      const url = new URL('/sidebar/ws/agent-terminals', location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.search = new URLSearchParams({ sessionId }).toString()
      socket = new WebSocket(url.toString())
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        try {
          const list = JSON.parse(event.data) as Array<{ uuid: string; title: string; command: string; exited: boolean }>
          if (!Array.isArray(list)) return
          store.reduce(s => ctx.betterSidebar?.isTabEnabled('terminal') === false
            ? s
            : reconcileAgentTerminals(s, list))
        } catch {
          // Malformed push: ignore (the next push will reconcile).
        }
      }
      socket.onclose = () => {
        if (closed) return
        failures += 1
        if (failures >= FAILURE_LIMIT) {
          console.error('[dsh-better-sidebar] agent-terminals connection failed; stopping reconnect loop', sessionId)
          return
        }
        retry = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => { socket?.close() }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      socket?.close()
    }
  }, [sessionId, store])

  /**
   * Subagent auto-activation: the moment the current conversation spawns its
   * FIRST direct subagent (a 0 → N transition on the list feed), the "auto
   * open" pref is on, and the Subagent tab type is enabled in settings,
   * open the panel (if collapsed) and focus the Subagent page
   * (single-instance: an existing tab is focused, never duplicated).
   * Switching to a session that already has subagents never triggers — its
   * baseline starts at the current count — so a deliberate layout is never
   * fought.
   */
  const listBaselineRef = useRef<SidebarSessionList | undefined>(undefined)
  useEffect(() => {
    const prev = listBaselineRef.current
    listBaselineRef.current = sessionList
    if (sessionId === undefined || prev === undefined) return
    if (!detectNewDirectSubagent(prev, sessionList, sessionId)) return
    if (!store.getPrefs().autoOpenSubagent) return
    if (ctx.betterSidebar?.isTabEnabled('subagent') === false) return
    store.reduce(s => s.panelOpen ? s : togglePanel(s))
    ctx.betterSidebar?.openTab({ type: 'subagent', title: t('subagent') })
  }, [sessionList, sessionId, store, ctx])

  /**
   * Topology jump-back: clicking a subagent node on the Subagent page calls
   * the official `openSubagent`, which switches the sidebar to that child
   * session's OWN layout (a fresh child session defaults to the explorer).
   * The README contract says the Subagent page must stay open with the jumped
   * node highlighted — so once the current session becomes the recorded jump
   * target, re-open the Subagent page on top of the child's layout (expanding
   * the panel first if it is collapsed). Only this explicit node click arms
   * the flag, so switching to a subagent session by any other means keeps
   * that session's own layout untouched.
   */
  const subagentJumpRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const pending = subagentJumpRef.current
    if (pending === undefined || sessionId !== pending) return
    subagentJumpRef.current = undefined
    store.reduce(s => s.panelOpen ? s : togglePanel(s))
    ctx.betterSidebar?.openTab({ type: 'subagent', title: t('subagent') })
  }, [sessionId, store, ctx])

  // Panel width drag (left edge strip).
  const widthDrag = useRef({ startX: 0, startWidth: 0 })
  const [draggingWidth, setDraggingWidth] = useState(false)

  // Layout push: the app shell gives up the panel's width while it is open
  // (0 while collapsed), so the conversation and input bar are squeezed
  // instead of covered. The margin is capped at the viewport so a stale
  // persisted width (e.g. fullscreen on a bigger window) can never crush
  // the app shell to zero. Dragging disables the layout transition.
  useEffect(() => {
    const width = snapshot.state?.panelOpen === true
      ? Math.min(snapshot.state.width, window.innerWidth)
      : 0
    document.documentElement.style.setProperty('--dsh-sidebar-width', `${width}px`)
  }, [snapshot.state?.panelOpen, snapshot.state?.width])
  useEffect(() => {
    if (draggingWidth) document.body.setAttribute('data-dsh-sidebar-dragging', '')
    else document.body.removeAttribute('data-dsh-sidebar-dragging')
  }, [draggingWidth])


  // Whether the panel currently fills the viewport (fullscreen expansion).
  const fullscreen = state !== undefined && window.innerWidth - state.width < 8

  const actions: WorkbenchActions = useMemo(() => ({
    closeTab: (paneId, tabId) => {
      // A closed terminal releases its pty immediately — including when its
      // socket is mid-reconnect, where the unmount close frame never reaches
      // the host and the process would hold the quota until the grace ends.
      // Agent terminals (tabId `agent:<uuid>`) close through a different
      // host route: the WS close frame is the primary path (sent by
      // TerminalView on unmount), and the agent-pty.close HTTP route is the
      // fallback when the WS is down.
      const current = store.getSnapshot().state
      const leaf = current === undefined ? undefined : leafWithTab(current.splits, tabId)
      const tab = leaf?.tabs.find(candidate => candidate.id === tabId)
      store.reduce(s => closeTab(s, paneId, tabId))
      if (tab?.type === 'terminal') {
        if (isAgentTabId(tabId)) {
          const uuid = agentUuidOf(tabId)
          void api.agentPtyClose(uuid).catch(() => { /* the host may already have released it */ })
        } else if (sessionId !== undefined) {
          void api.ptyClose({ sessionId, cwd }, tabId).catch(() => { /* the host may already have released it */ })
        }
      }
    },
    activateTab: (paneId, tabId) => {
      store.reduce(s => ({
        ...s,
        activePane: paneId,
        splits: mapLeaf(s.splits, paneId, (leaf) => {
          if (leaf.tabs.some(tab => tab.id === tabId)) leaf.active = tabId
        }),
      }))
    },
    focusPane: (paneId) => { store.reduce(s => ({ ...s, activePane: paneId })) },
    moveTabToEdge: (payload: TabDragPayload, toPane: string, zone: DropZone) => {
      store.reduce(s => moveTabToEdge(s, payload.paneId, payload.tabId, toPane, zone))
    },
    moveTabBefore: (payload: TabDragPayload, toPane: string, beforeTabId: string) => {
      store.reduce((s) => {
        let index = -1
        const source = leafWithTab(s.splits, beforeTabId)
        if (source !== undefined && source.id === toPane) {
          index = source.tabs.findIndex(tab => tab.id === beforeTabId)
        }
        return moveTab(s, payload.paneId, payload.tabId, toPane, index)
      })
    },
    resizeSplit: (splitId, index, deltaFrac) => {
      store.reduce(s => ({ ...s, splits: resizeSplit(s.splits, splitId, index, deltaFrac) }))
    },
  }), [store, sessionId, cwd])

  /**
   * The explorer's @-reference button: append `@<relative path>` to the
   * session's composer draft (space-separated). The conversation service is
   * resolved lazily through `ctx.get` (the inject-free read — the app's own
   * plugins read 'conversation' the same way); a missing service or scope
   * degrades to a logged no-op, never a crash. Defined above the no-session
   * early return — a hook must never sit behind a conditional return
   * (React counts hooks per render).
   */
  const referenceInChat = useCallback((path: string): void => {
    if (sessionId === undefined) return
    try {
      const actx = ctx.sessions.scope(sessionId)
      if (actx === undefined) return
      const conversation = ctx.get('conversation') as SidebarConversation | undefined
      if (conversation === undefined) return
      const input = conversation.input.for(actx)
      const mention = `@${relativeTo(cwd ?? '', path)}`
      const draft = input.state.getSnapshot().draft
      input.setDraft(draft.trim() === '' ? mention : `${draft} ${mention}`)
    } catch (error) {
      console.warn('[dsh-better-sidebar] reference insert failed:', error)
    }
  }, [ctx, sessionId, cwd])

  if (state === undefined || sessionId === undefined) {
    return (
      <div className={css.toggleRail}>
        <Tooltip label={t('noSession')} side="bottom" delayMs={500}>
          <button type="button" className={css.toggleButton} disabled aria-label={t('noSession')}>
            <IconPanelLeftOutline16 size={16} />
          </button>
        </Tooltip>
      </div>
    )
  }

  const onNewTab = (optionId: string): void => {
    const service = ctx.betterSidebar
    const descriptor = service?.getTab(optionId)
    if (descriptor === undefined) return
    const title = typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title
    service.openTab({ type: optionId, title })
  }

  /**
   * The explorer's @-reference button: append `@<relative path>` to the
   * session's composer draft (space-separated). Resolves the session-scope
   * ctx and the conversation input service at click time; a missing service
   * or scope degrades to a logged no-op, never a crash.
   */
  /**
   * Render one tab's content. `active` (from the workbench) tells whether
   * this tab is the active one in its pane; combined with the panel's
   * open/closed state it gates live views (the Subagent topology pauses its
   * polling while the page is not actually visible). The pane id travels
   * with the tab so diff tabs can split below their source pane.
   */
  const renderTab = (tab: SidebarTab, active: boolean, paneId: string) => (
    <TabContent
      tab={tab}
      sessionId={sessionId}
      cwd={cwd}
      expanded={state.expanded}
      onToggleDir={(path) => { store.reduce(s => toggleExpanded(s, path)) }}
      onReferenceFile={referenceInChat}
      ctx={ctx}
      store={store}
      visible={state.panelOpen && active}
      onSubagentJump={(childSessionId) => { subagentJumpRef.current = childSessionId }}
      onOpenDiff={(diffTab) => { store.reduce(s => openDiffTab(s, paneId, diffTab)) }}
    />
  )

  return (
    <>
      {!state.panelOpen && (
        <div className={css.toggleRail}>
          <Tooltip label={t('expand')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.toggleButton}
              aria-label={t('expand')}
              onClick={() => { store.reduce(togglePanel) }}
            >
              <IconPanelLeftOutline16 size={16} />
            </button>
          </Tooltip>
        </div>
      )}
      {/*
        The panel stays mounted while collapsed (hidden off-screen) so the
        slide in/out can animate; visibility hides it after the slide settles.
      */}
      <div
        className={clsx(css.panel, !state.panelOpen && css.panelHidden)}
        style={{ width: Math.min(state.width, window.innerWidth) }}
        data-dragging={draggingWidth || undefined}
      >
          <div
            className={clsx(css.panelResize, draggingWidth && css.panelResizeActive)}
            onPointerDown={(event) => {
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              widthDrag.current = { startX: event.clientX, startWidth: state.width }
              setDraggingWidth(true)
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
              const { startX, startWidth } = widthDrag.current
              store.reduce(s => setWidth(s, startWidth + (startX - event.clientX)))
            }}
            onPointerUp={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
              event.currentTarget.releasePointerCapture(event.pointerId)
              setDraggingWidth(false)
            }}
          />
          <div className={css.panelHeader}>
            <button
              type="button"
              className={css.iconButton}
              aria-label={fullscreen ? t('restoreFullscreen') : t('expandFullscreen')}
              title={fullscreen ? t('restoreFullscreen') : t('expandFullscreen')}
              onClick={() => {
                const viewport = window.innerWidth
                store.reduce(s => setWidth(s, fullscreen
                  ? Math.max(280, Math.round((viewport - 320) / 2))
                  : viewport))
              }}
            >
              <IconFullscreenOutline16 />
            </button>
            <span className={css.panelTitle}>
              {t('explorer')}
              {cwd !== undefined ? ` · ${cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd}` : ''}
            </span>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('collapse')}
              title={t('collapse')}
              onClick={() => { store.reduce(togglePanel) }}
            >
              <IconChevronRightOutline14 />
            </button>
          </div>
        <div className={css.panelBody}>
          <Workbench
            state={state}
            newTabOptions={buildNewTabOptions(state, ctx, { sessionId, cwd })}
            actions={actions}
            onNewTab={onNewTab}
            renderTab={renderTab}
            getTabIcon={(tab) => {
              const descriptor = ctx.betterSidebar?.getTab(tab.type)
              if (descriptor === undefined) return null
              return typeof descriptor.icon === 'function' ? descriptor.icon(14) : descriptor.icon
            }}
          />
        </div>
      </div>
    </>
  )
}
