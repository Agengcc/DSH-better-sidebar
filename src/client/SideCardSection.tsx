/**
 * "Side card" settings section: the user-facing preferences for the sidebar
 * panel, rendered natively in the DSH Settings shell (nav label "Side card").
 *
 * The section is DECLARATIVE — it renders the enable/disable inventory from
 * the sidebar service's registries instead of hardcoding rows:
 *  - 常规: new conversations open the panel by default (native checkbox),
 *    and the default panel width as a percent of the window (number input).
 *  - 侧边栏内容: one row per REGISTERED tab type (built-ins and external
 *    plugins alike) — icon + title + type id + an on/off switch persisted in
 *    `prefs.tabsEnabled[id]`. A tab's `settings.toggles` declaration renders
 *    as nested switches under its row while the tab is enabled (e.g. the
 *    Subagent page's "auto-open when a subagent appears").
 *  - 文件预览: one row per REGISTERED file viewer — icon + title + the
 *    extensions it covers + an on/off switch persisted in
 *    `prefs.viewersEnabled[id]`.
 *
 * Writes ride the plugin's own fenced settings route (the host calls the
 * settings seam in-process — the DSH settings RPC domain does not serve
 * third-party namespaces to configuration clients); the shared SidebarStore
 * is refreshed on success so the very next brand-new session seeds from the
 * new values and the sidebar's consumption points (the + menu, derived
 * flows) re-render immediately. Any failure reverts the optimistic UI and
 * shows the wire error inline — a broken settings surface never crashes the
 * shell.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the settings shell's SlotMap merges ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  clampWidthPercent,
  WIDTH_PERCENT_MAX,
  WIDTH_PERCENT_MIN,
  type SidebarPrefs,
} from '../prefs-shared.ts'
import { api } from './api.ts'
import { parsePrefs } from './prefs.ts'
import { t } from './locales.ts'
import type { SidebarStore } from './state.ts'
import type {
  BetterSidebarService,
  FileViewerDescriptor,
  SidebarSettingToggle,
  TabDescriptor,
} from './service.ts'
import css from './SideCardSection.module.css'

/** Injected business face: the shared store (prefs cache) + the sidebar service (registries). */
export interface SideCardSectionInjected {
  store: SidebarStore
  service: BetterSidebarService
}

/** Full section props: the runtime share plus the injected face. */
export type SideCardSectionProps = PropsRuntime<'settings.section'> & SideCardSectionInjected

/** Map one wire failure to the inline message (the conflict gets friendly copy). */
function messageOf(error: unknown): string {
  if (error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'settings-conflict') {
    return `${t('settingsSaveFailed')} ${t('settingsConflict')}`
  }
  return `${t('settingsSaveFailed')} ${error instanceof Error ? error.message : String(error)}`
}

/** Resolve an i18n-friendly string-or-function value. */
function textOf(value: string | (() => string) | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'function' ? value() : value
}

/** Resolve a descriptor icon (ReactNode or size function). */
function iconOf(icon: ReactNode | ((size: number) => ReactNode) | undefined, size: number): ReactNode {
  if (icon === undefined) return null
  return typeof icon === 'function' ? icon(size) : icon
}

/** Tab inventory order: hidden types (editor/diff) last, then + menu order. */
function tabOrder(a: TabDescriptor, b: TabDescriptor): number {
  if (a.hidden !== b.hidden) return a.hidden === true ? 1 : -1
  return (a.order ?? 100) - (b.order ?? 100)
}

/** Viewer inventory order: priority desc (the catch-all `code` comes last). */
function viewerOrder(a: FileViewerDescriptor, b: FileViewerDescriptor): number {
  return (b.priority ?? 0) - (a.priority ?? 0)
}

/** Read one boolean pref by declarative key (missing = false). */
function prefBool(prefs: SidebarPrefs, key: string): boolean {
  return (prefs as unknown as Record<string, boolean>)[key] === true
}

/**
 * Render the Side card preferences section.
 * @param props - composed slot props (runtime share + injected store/service).
 * @returns the section element tree.
 */
export function SideCardSection({ store, service }: SideCardSectionProps) {
  const [prefs, setPrefs] = useState<SidebarPrefs>(() => store.getPrefs())
  const [widthDraft, setWidthDraft] = useState<string>(String(store.getPrefs().defaultWidthPercent))
  const [error, setError] = useState<string | null>(null)

  // The declarative inventory: the registered tab types and file viewers.
  // Local state + service.subscribe (registry changes are rare — plugin
  // load/unload — so a plain effect is enough; no external-store ceremony).
  const [tabs, setTabs] = useState<TabDescriptor[]>(() => [...service.getTabs()].sort(tabOrder))
  const [viewers, setViewers] = useState<FileViewerDescriptor[]>(() => [...service.getFileViewers()].sort(viewerOrder))
  useEffect(() => service.subscribe(() => {
    setTabs([...service.getTabs()].sort(tabOrder))
    setViewers([...service.getFileViewers()].sort(viewerOrder))
  }), [service])

  // The settings document revision (guards concurrent writes). A ref: commits
  // read the freshest value at execution time, no re-render needed.
  const revisionRef = useRef<number | undefined>(undefined)
  // Whether the user already wrote since mount: the mount read must not
  // clobber a newer optimistic edit (the window is milliseconds, but a slow
  // route must never silently revert a just-made change).
  const dirtyRef = useRef(false)
  // Serialize commits: a queued write must observe the previous write's
  // revision; a failed write must not poison the queue for later ones.
  const inFlightRef = useRef<Promise<unknown>>(Promise.resolve())

  // Sync the persisted document once on mount: the revision and the current
  // values (another tab may have changed them since the store hydrated).
  useEffect(() => {
    let cancelled = false
    void api.settingsGet().then((view) => {
      if (cancelled) return
      revisionRef.current = view.revision
      if (dirtyRef.current) return
      const next = parsePrefs(view.value)
      setPrefs(next)
      setWidthDraft(String(next.defaultWidthPercent))
    }).catch(() => { /* the store's defaults stay authoritative */ })
    return () => { cancelled = true }
  }, [])

  /** Persist one patch through the settings route (serialized, revision-guarded). */
  const commit = (patch: Record<string, unknown>): Promise<{ ok: boolean; prefs: SidebarPrefs }> => {
    dirtyRef.current = true
    const run = inFlightRef.current.then(async () => {
      const view = await api.settingsUpdate(
        { ...patch },
        revisionRef.current,
      )
      const next = parsePrefs(view.value)
      revisionRef.current = view.revision
      store.setPrefs(next)
      return next
    })
    // A failed commit must not poison the queue: later writes still run.
    inFlightRef.current = run.then(() => undefined, () => undefined)
    return run.then(
      (next) => ({ ok: true, prefs: next }),
      (caught) => {
        setError(messageOf(caught))
        return { ok: false, prefs }
      },
    )
  }

  /** Settle one commit: success adopts the server values, failure reverts. */
  const applyOutcome = (previous: SidebarPrefs, outcome: { ok: boolean; prefs: SidebarPrefs }): void => {
    const settled = outcome.ok ? outcome.prefs : previous
    setPrefs(settled)
    setWidthDraft(String(settled.defaultWidthPercent))
  }

  /** Optimistically flip one boolean pref, then commit (revert on failure). */
  const togglePref = (patch: Record<string, unknown>): void => {
    const previous = prefs
    setPrefs({ ...previous, ...patch } as SidebarPrefs)
    setError(null)
    void commit(patch).then(outcome => applyOutcome(previous, outcome))
  }

  const onToggle = (next: boolean): void => {
    togglePref({ openByDefault: next })
  }

  /** Flip one per-tab enable switch (merge into the tabsEnabled map). */
  const onToggleTab = (id: string, next: boolean): void => {
    togglePref({ tabsEnabled: { ...prefs.tabsEnabled, [id]: next } })
  }

  /** Flip one per-viewer enable switch (merge into the viewersEnabled map). */
  const onToggleViewer = (id: string, next: boolean): void => {
    togglePref({ viewersEnabled: { ...prefs.viewersEnabled, [id]: next } })
  }

  /** Flip one declaratively-declared toggle (a SidebarPrefs boolean field). */
  const onToggleSetting = (toggle: SidebarSettingToggle, next: boolean): void => {
    togglePref({ [toggle.key]: next })
  }

  const commitWidth = (): void => {
    const parsed = Number(widthDraft)
    if (!Number.isFinite(parsed)) {
      setWidthDraft(String(prefs.defaultWidthPercent))
      return
    }
    const clamped = clampWidthPercent(parsed)
    const previous = prefs
    setPrefs({ ...previous, defaultWidthPercent: clamped })
    setWidthDraft(String(clamped))
    setError(null)
    void commit({ defaultWidthPercent: clamped }).then(outcome => applyOutcome(previous, outcome))
  }

  /** One enable/disable row: icon + title + desc + checkbox. */
  const renderRow = (props: {
    title: string
    desc: string
    icon?: ReactNode
    checked: boolean
    label: string
    onToggle: (next: boolean) => void
    sub?: boolean
  }) => (
    <label className={props.sub === true ? css.subRow : css.row}>
      <span className={css.rowText}>
        <span className={css.titleLine}>
          {props.icon !== null && props.icon !== undefined && <span className={css.rowIcon}>{props.icon}</span>}
          <span className={css.title}>{props.title}</span>
        </span>
        <span className={css.desc}>{props.desc}</span>
      </span>
      <input
        type="checkbox"
        className={css.toggle}
        checked={props.checked}
        aria-label={props.label}
        onChange={event => { props.onToggle(event.currentTarget.checked) }}
      />
    </label>
  )

  return (
    <div className={css.section}>
      <label className={css.row}>
        <span className={css.rowText}>
          <span className={css.title}>{t('settingsOpenTitle')}</span>
          <span className={css.desc}>{t('settingsOpenDesc')}</span>
        </span>
        <input
          type="checkbox"
          className={css.toggle}
          checked={prefs.openByDefault}
          aria-label={t('settingsOpenTitle')}
          onChange={event => { onToggle(event.currentTarget.checked) }}
        />
      </label>
      <div className={css.row}>
        <span className={css.rowText}>
          <span className={css.title}>{t('settingsWidthTitle')}</span>
          <span className={css.desc}>{t('settingsWidthDesc')}</span>
        </span>
        <span className={css.control}>
          <Input
            type="number"
            className={css.percentInput}
            value={widthDraft}
            min={WIDTH_PERCENT_MIN}
            max={WIDTH_PERCENT_MAX}
            step={1}
            aria-label={t('settingsWidthTitle')}
            onChange={event => { setWidthDraft(event.currentTarget.value) }}
            onBlur={commitWidth}
            onKeyDown={event => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
          <span className={css.suffix}>{t('settingsWidthSuffix')}</span>
        </span>
      </div>

      {/* 侧边栏内容: one row per registered tab type, icon + type id + switch,
          plus each tab's declaratively-declared nested toggles (shown only
          while the tab itself is enabled). */}
      <div className={css.sectionHeading}>{t('settingsTabsTitle')}</div>
      {tabs.map(tab => (
        <Fragment key={tab.id}>
          {renderRow({
            title: textOf(tab.title),
            desc: tab.id,
            icon: iconOf(tab.icon, 16),
            checked: prefs.tabsEnabled[tab.id] !== false,
            label: textOf(tab.title),
            onToggle: (next) => { onToggleTab(tab.id, next) },
          })}
          {prefs.tabsEnabled[tab.id] !== false && (tab.settings?.toggles ?? []).map(toggle => (
            <Fragment key={`${tab.id}:${toggle.key}`}>
              {renderRow({
                title: textOf(toggle.title),
                desc: textOf(toggle.desc),
                checked: prefBool(prefs, toggle.key),
                label: textOf(toggle.title),
                onToggle: (next) => { onToggleSetting(toggle, next) },
                sub: true,
              })}
            </Fragment>
          ))}
        </Fragment>
      ))}

      {/* 文件预览: one row per registered file viewer, icon + title + exts + switch. */}
      <div className={css.sectionHeading}>{t('settingsViewersTitle')}</div>
      {viewers.map(viewer => (
        <Fragment key={viewer.id}>
          {renderRow({
            title: textOf(viewer.title) || viewer.id,
            desc: viewer.exts.length === 0 ? t('settingsViewerCatchAll') : viewer.exts.join(' · '),
            icon: iconOf(viewer.icon, 16),
            checked: prefs.viewersEnabled[viewer.id] !== false,
            label: textOf(viewer.title) || viewer.id,
            onToggle: (next) => { onToggleViewer(viewer.id, next) },
          })}
        </Fragment>
      ))}
      {error !== null && (
        <div className={css.error} role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
