/**
 * The split-pane workbench: renders the recursive split tree. A split lays
 * children out row- or column-wise with draggable dividers (fractional
 * sizes); a leaf renders its tab strip plus the active tab's content and
 * accepts tab drops. The tree and all operations live in state.ts — this
 * file is pure presentation over them.
 */
import { Fragment, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { SidebarState, SidebarTab, SplitNode } from './state.ts'
import { t } from './locales.ts'
import { TabBar, type NewTabOption, parseDrag, type TabDragPayload } from './TabBar.tsx'
import css from './sidebar.module.css'

/** Actions the workbench needs (bound to the store by the sidebar shell). */
export interface WorkbenchActions {
  closeTab: (paneId: string, tabId: string) => void
  activateTab: (paneId: string, tabId: string) => void
  /** Make a pane the target of newly opened tabs (click focus). */
  focusPane: (paneId: string) => void
  splitPane: (dir: 'row' | 'col') => void
  moveTab: (payload: TabDragPayload, toPane: string, before: string | null) => void
  resizeSplit: (splitId: string, index: number, deltaFrac: number) => void
}

/** One divider: pointer-capture drag translating px deltas into fractions. */
function Divider(props: { dir: 'row' | 'col'; onResize: (deltaFrac: number) => void }) {
  const { dir, onResize } = props
  const start = useRef({ x: 0, y: 0, size: 0 })
  const [dragging, setDragging] = useState(false)

  return (
    <div
      className={clsx(css.divider, dir === 'row' ? css.dividerRow : css.dividerCol, dragging && css.dividerActive)}
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        const box = event.currentTarget.parentElement?.getBoundingClientRect()
        start.current = {
          x: event.clientX,
          y: event.clientY,
          size: box === undefined ? 1 : (dir === 'row' ? box.width : box.height),
        }
        setDragging(true)
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        const delta = dir === 'row' ? event.clientX - start.current.x : event.clientY - start.current.y
        const size = Math.max(1, start.current.size)
        onResize(delta / size)
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        event.currentTarget.releasePointerCapture(event.pointerId)
        setDragging(false)
      }}
    />
  )
}

/** A leaf: tab strip + active content + drop target for tabs. */
function LeafView(props: {
  leaf: { id: string; tabs: SidebarTab[]; active: string | null }
  newTabOptions: NewTabOption[]
  actions: WorkbenchActions
  onNewTab: (optionId: string) => void
  renderTab: (tab: SidebarTab) => ReactNode
}) {
  const { leaf, newTabOptions, actions, onNewTab, renderTab } = props
  const [dropTarget, setDropTarget] = useState(false)
  const activeTab = leaf.tabs.find(tab => tab.id === leaf.active) ?? leaf.tabs[leaf.tabs.length - 1]
  return (
    <div
      className={clsx(css.pane, dropTarget && css.paneDrop)}
      onPointerDown={() => { actions.focusPane(leaf.id) }}
      onDragOver={(event) => {
        event.preventDefault()
        setDropTarget(true)
      }}
      onDragLeave={() => { setDropTarget(false) }}
      onDrop={(event) => {
        event.preventDefault()
        setDropTarget(false)
        const payload = parseDrag(event.dataTransfer.getData('application/x-dsh-tab'))
        if (payload !== null) actions.moveTab(payload, leaf.id, null)
      }}
    >
      {leaf.tabs.length > 0 ? (
        <>
          <TabBar
            paneId={leaf.id}
            tabs={leaf.tabs}
            active={leaf.active}
            onActivate={(tabId) => { actions.activateTab(leaf.id, tabId) }}
            onClose={(tabId) => { actions.closeTab(leaf.id, tabId) }}
            onSplit={(dir) => { actions.splitPane(dir) }}
            onNewTab={onNewTab}
            newTabOptions={newTabOptions}
            onDropTab={(payload, before) => { actions.moveTab(payload, leaf.id, before) }}
          />
          <div className={css.paneContent}>{activeTab !== undefined ? renderTab(activeTab) : null}</div>
        </>
      ) : (
        <div className={css.paneEmpty}>{t('emptyPane')}</div>
      )}
    </div>
  )
}

/** Recursive node renderer. */
function NodeView(props: {
  node: SplitNode
  state: SidebarState
  newTabOptions: NewTabOption[]
  actions: WorkbenchActions
  onNewTab: (optionId: string) => void
  renderTab: (tab: SidebarTab) => ReactNode
}) {
  const { node, state, newTabOptions, actions, onNewTab, renderTab } = props
  if (node.kind === 'leaf') {
    return (
      <LeafView
        leaf={node}
        newTabOptions={newTabOptions}
        actions={actions}
        onNewTab={onNewTab}
        renderTab={renderTab}
      />
    )
  }
  const isRow = node.dir === 'row'
  return (
    <div className={clsx(css.split, isRow ? css.splitRow : css.splitCol)}>
      {node.children.map((child, index) => (
        <Fragment key={child.id}>
          {index > 0 && (
            <Divider
              dir={node.dir}
              onResize={(deltaFrac) => { actions.resizeSplit(node.id, index - 1, deltaFrac) }}
            />
          )}
          <div
            className={css.splitChild}
            style={{ flexGrow: node.sizes[index], flexBasis: 0, minWidth: 0, minHeight: 0 }}
          >
            <NodeView
              node={child}
              state={state}
              newTabOptions={newTabOptions}
              actions={actions}
              onNewTab={onNewTab}
              renderTab={renderTab}
            />
          </div>
        </Fragment>
      ))}
    </div>
  )
}

/** The workbench: the split tree filling the sidebar body. */
export function Workbench(props: {
  state: SidebarState
  newTabOptions: NewTabOption[]
  actions: WorkbenchActions
  onNewTab: (optionId: string) => void
  renderTab: (tab: SidebarTab) => ReactNode
}) {
  const { state, newTabOptions, actions, onNewTab, renderTab } = props
  return (
    <div className={css.workbench}>
      <NodeView
        node={state.splits}
        state={state}
        newTabOptions={newTabOptions}
        actions={actions}
        onNewTab={onNewTab}
        renderTab={renderTab}
      />
    </div>
  )
}
