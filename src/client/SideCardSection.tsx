/**
 * "Side card" settings section: the user-facing preferences for the sidebar
 * panel, rendered natively in the DSH Settings shell (nav label "Side card").
 * Three rows:
 *  - new conversations open the panel by default (native checkbox),
 *  - the default panel width as a percent of the window (number input + %),
 *  - auto-open the Subagent page when a new subagent appears (native checkbox,
 *    on by default).
 *
 * Writes ride the plugin's own fenced settings route (the host calls the
 * settings seam in-process — the DSH settings RPC domain does not serve
 * third-party namespaces to configuration clients); the shared SidebarStore
 * is refreshed on success so the very next brand-new session seeds from the
 * new values. Any failure reverts the optimistic UI and shows the wire error
 * inline — a broken settings surface never crashes the shell.
 */
import { useEffect, useRef, useState } from 'react'
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
import css from './SideCardSection.module.css'

/** Injected business face: the shared store (prefs cache). */
export interface SideCardSectionInjected {
  store: SidebarStore
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

/**
 * Render the Side card preferences section.
 * @param props - composed slot props (runtime share + injected store).
 * @returns the section element tree.
 */
export function SideCardSection({ store }: SideCardSectionProps) {
  const [prefs, setPrefs] = useState<SidebarPrefs>(() => store.getPrefs())
  const [widthDraft, setWidthDraft] = useState<string>(String(store.getPrefs().defaultWidthPercent))
  const [error, setError] = useState<string | null>(null)

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
  const commit = (patch: Partial<SidebarPrefs>): Promise<{ ok: boolean; prefs: SidebarPrefs }> => {
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

  const onToggle = (next: boolean): void => {
    const previous = prefs
    setPrefs({ ...previous, openByDefault: next })
    setError(null)
    void commit({ openByDefault: next }).then(outcome => applyOutcome(previous, outcome))
  }

  const onToggleSubagent = (next: boolean): void => {
    const previous = prefs
    setPrefs({ ...previous, autoOpenSubagent: next })
    setError(null)
    void commit({ autoOpenSubagent: next }).then(outcome => applyOutcome(previous, outcome))
  }

  const onToggleTools = (next: boolean): void => {
    const previous = prefs
    setPrefs({ ...previous, agentTerminalTools: next })
    setError(null)
    void commit({ agentTerminalTools: next }).then(outcome => applyOutcome(previous, outcome))
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
      <label className={css.row}>
        <span className={css.rowText}>
          <span className={css.title}>{t('settingsSubagentTitle')}</span>
          <span className={css.desc}>{t('settingsSubagentDesc')}</span>
        </span>
        <input
          type="checkbox"
          className={css.toggle}
          checked={prefs.autoOpenSubagent}
          aria-label={t('settingsSubagentTitle')}
          onChange={event => { onToggleSubagent(event.currentTarget.checked) }}
        />
      </label>
      <label className={css.row}>
        <span className={css.rowText}>
          <span className={css.title}>{t('settingsToolsTitle')}</span>
          <span className={css.desc}>{t('settingsToolsDesc')}</span>
        </span>
        <input
          type="checkbox"
          className={css.toggle}
          checked={prefs.agentTerminalTools}
          aria-label={t('settingsToolsTitle')}
          onChange={event => { onToggleTools(event.currentTarget.checked) }}
        />
      </label>
      {error !== null && (
        <div className={css.error} role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
