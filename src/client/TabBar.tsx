/**
 * The tab strip of one pane: tabs capped at TAB_MAX_WIDTH (ellipsized),
 * overflow scrolls horizontally, a close button per tab, a four-way split
 * button cluster, and the + menu that opens new tabs (explorer / git /
 * terminal). Tabs are draggable; dropping onto another tab inserts before it,
 * dropping on the strip background appends to this pane.
 */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutline14, IconChevronLeftOutline14, IconChevronRightOutline14,
  IconChevronUpOutline14, IconCloseFill14, IconPlusOutline16, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarTab } from './state.ts'
import { t, type CopyKey } from './locales.ts'
import css from './sidebar.module.css'

/** One + menu option. */
export interface NewTabOption {
  id: string
  label: string
  disabled?: boolean
}

/** Drag payload for tab moves (HTML5 DnD dataTransfer). */
export const TAB_DRAG_TYPE = 'application/x-dsh-tab'

export interface TabDragPayload {
  tabId: string
  paneId: string
}

export function serializeDrag(payload: TabDragPayload): string {
  return JSON.stringify(payload)
}

export function parseDrag(raw: string): TabDragPayload | null {
  try {
    const parsed = JSON.parse(raw) as TabDragPayload
    if (typeof parsed.tabId === 'string' && typeof parsed.paneId === 'string') return parsed
    return null
  } catch {
    return null
  }
}

const SPLIT_DIRS: Array<{ dir: 'left' | 'right' | 'up' | 'down'; label: CopyKey; icon: (p: { size?: number }) => ReactNode }> = [
  { dir: 'left', label: 'splitLeft', icon: IconChevronLeftOutline14 },
  { dir: 'right', label: 'splitRight', icon: IconChevronRightOutline14 },
  { dir: 'up', label: 'splitUp', icon: IconChevronUpOutline14 },
  { dir: 'down', label: 'splitDown', icon: IconChevronDownOutline14 },
]

export function TabBar(props: {
  paneId: string
  tabs: SidebarTab[]
  active: string | null
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onSplit: (dir: 'row' | 'col') => void
  onNewTab: (optionId: string) => void
  newTabOptions: NewTabOption[]
  /** Drop of a tab from any pane: (payload, insertBeforeTabId | null). */
  onDropTab: (payload: TabDragPayload, before: string | null) => void
}) {
  const {
    paneId, tabs, active, onActivate, onClose, onSplit, onNewTab, newTabOptions, onDropTab,
  } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  return (
    <div
      className={clsx(css.tabBar, dragOver && css.tabBarDrop)}
      onDragOver={(event) => {
        event.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => { setDragOver(false) }}
      onDrop={(event) => {
        event.preventDefault()
        setDragOver(false)
        const raw = event.dataTransfer.getData(TAB_DRAG_TYPE)
        const payload = parseDrag(raw)
        if (payload !== null) onDropTab(payload, null)
      }}
    >
      <div className={css.tabList}>
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={clsx(css.tab, active === tab.id && css.tabActive)}
            title={tab.title}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(TAB_DRAG_TYPE, serializeDrag({ tabId: tab.id, paneId }))
              event.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(event) => { event.preventDefault(); event.stopPropagation() }}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              const raw = event.dataTransfer.getData(TAB_DRAG_TYPE)
              const payload = parseDrag(raw)
              if (payload !== null) onDropTab(payload, tab.id)
            }}
            onClick={() => { onActivate(tab.id) }}
          >
            <span className={css.tabTitle}>{tab.title}</span>
            <button
              type="button"
              className={css.tabClose}
              aria-label={t('close')}
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.id)
              }}
            >
              <IconCloseFill14 />
            </button>
          </div>
        ))}
      </div>
      <div className={css.tabBarActions}>
        {SPLIT_DIRS.map(({ dir, label, icon: Icon }) => (
          <button
            key={dir}
            type="button"
            className={css.tabBarButton}
            aria-label={t(label)}
            title={t(label)}
            onClick={() => { onSplit(dir === 'left' || dir === 'right' ? 'row' : 'col') }}
          >
            <Icon />
          </button>
        ))}
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          items={newTabOptions.map(option => ({
            id: option.id,
            label: option.label,
            ...(option.disabled === true ? { disabled: true } : {}),
          }))}
          onSelect={(id) => {
            onNewTab(id)
            setMenuOpen(false)
          }}
          portal
          align="end"
          anchor={(
            <button
              type="button"
              className={css.tabBarButton}
              aria-label={t('newTab')}
              title={t('newTab')}
              onClick={() => { setMenuOpen(v => !v) }}
            >
              <IconPlusOutline16 />
            </button>
          )}
        />
      </div>
    </div>
  )
}
