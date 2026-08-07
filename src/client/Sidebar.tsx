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
import { IconCloseOutline16, IconPanelLeftOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import {
  allLeaves, closeTab, leafWithTab, mapLeaf, moveTab, openTab, resizeSplit,
  sidebarStore, splitPane, setWidth, toggleExpanded, togglePanel,
  TERMINAL_LIMIT, type SidebarState, type SidebarTab, type SplitNode,
} from './state.ts'
import { Workbench, type WorkbenchActions } from './split-pane.tsx'
import type { NewTabOption } from './TabBar.tsx'
import type { TabDragPayload } from './TabBar.tsx'
import { ExplorerView } from './ExplorerView.tsx'
import { EditorView } from './EditorView.tsx'
import { TerminalView } from './TerminalView.tsx'
import { GitView } from './GitView.tsx'
import { t } from './locales.ts'
import { openSidebarFile } from './intercept.tsx'
import css from './sidebar.module.css'

/** Render the content of one tab (dispatched by type). */
function TabContent(props: {
  tab: SidebarTab
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  onToggleDir: (path: string) => void
  ctx: Context
}) {
  const { tab, sessionId, cwd, expanded, onToggleDir, ctx } = props
  switch (tab.type) {
    case 'explorer':
      return (
        <ExplorerView
          sessionId={sessionId}
          cwd={cwd}
          expanded={expanded}
          onToggle={onToggleDir}
          onOpenFile={(path) => { openSidebarFile(ctx, sessionId, path) }}
        />
      )
    case 'git':
      return <GitView sessionId={sessionId} />
    case 'terminal':
      return <TerminalView sessionId={sessionId} tabId={tab.id} />
    case 'editor':
      return <EditorView sessionId={sessionId} path={tab.path ?? ''} title={tab.title} />
  }
}

/** The + menu options for the current state (terminal cap applied). */
function buildNewTabOptions(state: SidebarState): NewTabOption[] {
  const terminalCount = allLeaves(state.splits)
    .flatMap(leaf => leaf.tabs)
    .filter(tab => tab.type === 'terminal').length
  return [
    { id: 'explorer', label: t('openExplorer') },
    { id: 'git', label: t('openGit') },
    {
      id: 'terminal',
      label: terminalCount >= TERMINAL_LIMIT ? `${t('newTerminal')} (${t('terminalLimit')})` : t('newTerminal'),
      disabled: terminalCount >= TERMINAL_LIMIT,
    },
  ]
}

export function Sidebar(props: { ctx: Context }) {
  const { ctx } = props

  // Current conversation (the sessions list feed).
  const sessionList = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.sessions.list.subscribe(callback), [ctx]),
    useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]),
  )
  const current = sessionList.current

  // Per-session sidebar state.
  const snapshot = useSyncExternalStore(
    useCallback((callback: () => void) => sidebarStore.subscribe(callback), []),
    useCallback(() => sidebarStore.getSnapshot(), []),
  )
  useEffect(() => { sidebarStore.setSession(current) }, [current])

  const state = snapshot.state
  const sessionId = snapshot.sessionId
  const cwd = sessionId === undefined ? undefined : sessionList.byId[sessionId]?.cwd

  // Panel width drag (left edge strip).
  const widthDrag = useRef({ startX: 0, startWidth: 0 })
  const [draggingWidth, setDraggingWidth] = useState(false)

  const actions: WorkbenchActions = useMemo(() => ({
    closeTab: (paneId, tabId) => { sidebarStore.reduce(s => closeTab(s, paneId, tabId)) },
    activateTab: (paneId, tabId) => {
      sidebarStore.reduce(s => ({
        ...s,
        activePane: paneId,
        splits: mapLeaf(s.splits, paneId, (leaf) => {
          if (leaf.tabs.some(tab => tab.id === tabId)) leaf.active = tabId
        }),
      }))
    },
    focusPane: (paneId) => { sidebarStore.reduce(s => ({ ...s, activePane: paneId })) },
    splitPane: (dir) => { sidebarStore.reduce(s => splitPane(s, dir)) },
    moveTab: (payload: TabDragPayload, toPane: string, before: string | null) => {
      sidebarStore.reduce((s) => {
        let index = -1
        if (before !== null) {
          const source = leafWithTab(s.splits, before)
          if (source !== undefined && source.id === toPane) {
            index = source.tabs.findIndex(tab => tab.id === before)
          }
        }
        return moveTab(s, payload.paneId, payload.tabId, toPane, index)
      })
    },
    resizeSplit: (splitId, index, deltaFrac) => {
      sidebarStore.reduce(s => ({ ...s, splits: resizeSplit(s.splits, splitId, index, deltaFrac) }))
    },
  }), [])

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
    sidebarStore.reduce((s) => {
      if (optionId === 'explorer') {
        return openTab(s, { id: 'explorer', type: 'explorer', title: t('explorer') })
      }
      if (optionId === 'git') {
        return openTab(s, { id: 'git', type: 'git', title: t('git') })
      }
      if (optionId === 'terminal') {
        const count = allLeaves(s.splits).flatMap(leaf => leaf.tabs).filter(tab => tab.type === 'terminal').length
        if (count >= TERMINAL_LIMIT) return s
        const tab: SidebarTab = {
          id: `terminal:${s.nextTerminal}`,
          type: 'terminal',
          title: `${t('terminal')} ${s.nextTerminal}`,
        }
        return { ...openTab(s, tab), nextTerminal: s.nextTerminal + 1 }
      }
      return s
    })
  }

  const renderTab = (tab: SidebarTab) => (
    <TabContent
      key={tab.id}
      tab={tab}
      sessionId={sessionId}
      cwd={cwd}
      expanded={state.expanded}
      onToggleDir={(path) => { sidebarStore.reduce(s => toggleExpanded(s, path)) }}
      ctx={ctx}
    />
  )

  return (
    <>
      {!state.panelOpen && (
        <div className={css.toggleRail}>
          <Tooltip label={t('openExplorer')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.toggleButton}
              aria-label={t('openExplorer')}
              onClick={() => { sidebarStore.reduce(togglePanel) }}
            >
              <IconPanelLeftOutline16 size={16} />
            </button>
          </Tooltip>
        </div>
      )}
      {state.panelOpen && (
        <div className={css.panel} style={{ width: state.width }} data-dragging={draggingWidth || undefined}>
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
              sidebarStore.reduce(s => setWidth(s, startWidth + (startX - event.clientX)))
            }}
            onPointerUp={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
              event.currentTarget.releasePointerCapture(event.pointerId)
              setDraggingWidth(false)
            }}
          />
          <div className={css.panelHeader}>
            <span className={css.panelTitle}>
              {t('explorer')}
              {cwd !== undefined ? ` · ${cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd}` : ''}
            </span>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('close')}
              title={t('close')}
              onClick={() => { sidebarStore.reduce(togglePanel) }}
            >
              <IconCloseOutline16 />
            </button>
          </div>
          <div className={css.panelBody}>
            <Workbench
              state={state}
              newTabOptions={buildNewTabOptions(state)}
              actions={actions}
              onNewTab={onNewTab}
              renderTab={renderTab}
            />
          </div>
        </div>
      )}
    </>
  )
}
