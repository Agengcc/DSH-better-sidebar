/**
 * "Side card" settings section: the user-facing preferences for the sidebar
 * panel, rendered natively in the DSH Settings shell (nav label "Side card").
 *
 * The section is DECLARATIVE — it renders the enable/disable inventory from
 * the sidebar service's registries instead of hardcoding rows:
 *  - 常规: new conversations open the panel by default (a toggle card), and
 *    the default panel width as a percent of the window (number input row).
 *  - 侧边栏内容: one CARD per REGISTERED tab type (built-ins and external
 *    plugins alike) — icon + title + type id, clicked to toggle the switch
 *    persisted in `prefs.tabsEnabled[id]`. A card's `settings.toggles`
 *    declaration renders as nested smaller cards under it while the tab is
 *    enabled (e.g. the Subagent page's "auto-open when a subagent appears").
 *  - 文件预览: one CARD per REGISTERED file viewer — icon + title + the
 *    extensions it covers, clicked to toggle `prefs.viewersEnabled[id]`.
 *
 * A card's on/off state is its VISUAL STATE: enabled = highlighted (brand
 * border + tinted fill + check badge), disabled = neutral and dimmed.
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
import { IconCheckOutline16, IconPanelLeftOutline16, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
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

  /**
   * One toggle CARD: the whole card is the switch — clicking it flips the
   * feature, and the visual state IS the state (highlighted = enabled, with
   * a check badge; neutral + dimmed = disabled). Nested related settings
   * render as smaller indented cards (`sub`).
   */
  const renderCard = (props: {
    title: string
    desc: string
    icon?: ReactNode
    enabled: boolean
    onToggle: (next: boolean) => void
    sub?: boolean
  }) => (
    <button
      type="button"
      className={clsx(css.card, props.sub === true && css.cardSub, props.enabled && css.cardOn)}
      aria-pressed={props.enabled}
      onClick={() => { props.onToggle(!props.enabled) }}
    >
      {props.icon !== null && props.icon !== undefined && (
        <span className={css.cardIcon}>{props.icon}</span>
      )}
      <span className={css.cardText}>
        <span className={css.cardTitle}>{props.title}</span>
        <span className={css.cardDesc}>{props.desc}</span>
      </span>
      {props.enabled && (
        <span className={css.cardCheck}>
          <IconCheckOutline16 size={14} />
        </span>
      )}
    </button>
  )

  return (
    <div className={css.section}>
      <div className={css.sectionHeading}>{t('settingsGeneralTitle')}</div>
      {renderCard({
        title: t('settingsOpenTitle'),
        desc: t('settingsOpenDesc'),
        icon: <IconPanelLeftOutline16 size={16} />,
        enabled: prefs.openByDefault,
        onToggle,
      })}
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

      {/* 侧边栏内容: one card per registered tab type, icon + type id; the
          card's `settings.toggles` render as nested smaller cards while the
          tab itself is enabled. */}
      <div className={css.sectionHeading}>{t('settingsTabsTitle')}</div>
      {tabs.map(tab => (
        <Fragment key={tab.id}>
          {renderCard({
            title: textOf(tab.title),
            desc: tab.id,
            icon: iconOf(tab.icon, 16),
            enabled: prefs.tabsEnabled[tab.id] !== false,
            onToggle: (next) => { onToggleTab(tab.id, next) },
          })}
          {prefs.tabsEnabled[tab.id] !== false && (tab.settings?.toggles ?? []).map(toggle => (
            <Fragment key={`${tab.id}:${toggle.key}`}>
              {renderCard({
                title: textOf(toggle.title),
                desc: textOf(toggle.desc),
                enabled: prefBool(prefs, toggle.key),
                onToggle: (next) => { onToggleSetting(toggle, next) },
                sub: true,
              })}
            </Fragment>
          ))}
        </Fragment>
      ))}

      {/* 文件预览: one card per registered file viewer, icon + title + exts. */}
      <div className={css.sectionHeading}>{t('settingsViewersTitle')}</div>
      {viewers.map(viewer => (
        <Fragment key={viewer.id}>
          {renderCard({
            title: textOf(viewer.title) || viewer.id,
            desc: viewer.exts.length === 0 ? t('settingsViewerCatchAll') : viewer.exts.join(' · '),
            icon: iconOf(viewer.icon, 16),
            enabled: prefs.viewersEnabled[viewer.id] !== false,
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
