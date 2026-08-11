/**
 * The file editor tab: a CodeMirror 6 editor with line wrapping and syntax
 * highlighting (extension-keyed language), a dirty dot and Ctrl/Cmd+S save,
 * image viewing through the media route, and a plain notice for binary
 * files. Markdown files open in rendered preview with a preview/edit toggle:
 * edit mode shows the source in the editor, preview renders the live draft,
 * and unsaved edits survive the toggle. Reads cap at the host's 512KB bound
 * (a banner marks truncation).
 */
import { createElement, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { EditorState } from '@codemirror/state'
import { EditorView as CodeMirrorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { IconCheckOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { api, downloadUrl, mediaUrl, type SessionScope } from './api.ts'
import { languageForPath } from './lang.ts'
import { cmSurfaceTheme, CmThemeCompartment } from './cm-themes.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import { t } from './locales.ts'
import type { FileViewerDescriptor } from './service.ts'
import type { SidebarStore } from './state.ts'
import css from './sidebar.module.css'

const MD_EXT = ['.md', '.markdown']

type EditorLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; viewer?: FileViewerDescriptor; kind?: 'text' | 'md'; content?: string; truncated?: boolean; mediaUrl?: string; customData?: unknown }
  | { status: 'binary' }  // unknown binary / OLE legacy formats → download button

/** Previewable files (rendered output vs source editing). */
type ViewMode = 'preview' | 'edit'

export function EditorView(props: { ctx: Context; store: SidebarStore; scope: SessionScope; path: string; title: string }) {
  const { ctx, store, scope, path, title } = props
  const [load, setLoad] = useState<EditorLoad>({ status: 'loading' })
  const [mode, setMode] = useState<ViewMode>('preview')
  /** The editor's current text (null while clean); preview renders this. */
  const [draft, setDraft] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<CodeMirrorView | null>(null)
  const savingRef = useRef(false)
  /** The theme compartment of the current view (reconfigured on scheme flip). */
  const themeCompRef = useRef<CmThemeCompartment | null>(null)
  /** The app's resolved color scheme; the editor re-themes in place on flips. */
  const [dark, setDark] = useState(() => isDarkScheme())

  useEffect(() => subscribeColorScheme(() => { setDark(isDarkScheme()) }), [])

  useEffect(() => {
    let cancelled = false
    setLoad({ status: 'loading' })
    setMode('preview')
    setDraft(null)
    setDirty(false)
    setSaveState('idle')
    const ext = extOfPath(path)
    // Registry-driven viewer match: image/pdf/office/binary-download etc.
    // are registered through ctx.betterSidebar; code/markdown have no
    // registered viewer and fall through to the fsRead + CodeMirror path.
    const viewer = ctx.betterSidebar?.matchFileViewer(path)
    if (viewer !== undefined) {
      switch (viewer.fetchStrategy) {
        case 'mediaUrl':
        case 'none':
          setLoad({ status: 'ready', viewer, mediaUrl: mediaUrl(scope, path) })
          return
        case 'binary-download':
          setLoad({ status: 'binary' })
          return
        case 'custom':
          void viewer.load?.(path, scope).then((data) => {
            if (cancelled) return
            setLoad({ status: 'ready', viewer, customData: data })
          }).catch((error: unknown) => {
            if (cancelled) return
            setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          })
          return
        case 'fsRead':
          // An fsRead viewer (e.g. external CSV viewer) gets its content
          // through the host's fs.read and renders through viewer.component.
          api.fsRead(scope, path).then((result) => {
            if (cancelled) return
            if (result.kind === 'binary') { setLoad({ status: 'binary' }); return }
            setLoad({ status: 'ready', viewer, content: result.content, truncated: result.truncated })
          }).catch((error: unknown) => {
            if (cancelled) return
            setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          })
          return
      }
    }
    // Fallback: code/markdown (no registered viewer) — fsRead + CodeMirror.
    api.fsRead(scope, path).then((result) => {
      if (cancelled) return
      if (result.kind === 'binary') {
        setLoad({ status: 'binary' })
        return
      }
      setLoad({
        status: 'ready',
        kind: MD_EXT.includes(ext) ? 'md' : 'text',
        content: result.content,
        truncated: result.truncated,
      })
    }).catch((error: unknown) => {
      if (cancelled) return
      setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    })
    return () => { cancelled = true }
  }, [scope.sessionId, scope.cwd, path, ctx])

  // Create the CodeMirror editor once the file is loaded. The view owns the
  // document; React only tracks dirty/draft state through the update
  // listener. For markdown the view stays mounted while previewing (hidden),
  // so unsaved edits survive the preview/edit toggle. The theme + syntax
  // colors live in a compartment so a scheme flip reconfigures only that
  // part — the document, undo history and scroll position survive.
  useEffect(() => {
    if (load.status !== 'ready' || load.viewer !== undefined || (load.kind !== 'text' && load.kind !== 'md')) return
    const host = hostRef.current
    if (host === null) return
    const language = languageForPath(path)
    const themeComp = new CmThemeCompartment()
    themeCompRef.current = themeComp
    const state = EditorState.create({
      doc: load.content,
      extensions: [
        CodeMirrorView.lineWrapping,
        lineNumbers(),
        history(),
        EditorState.tabSize.of(2),
        CodeMirrorView.contentAttributes.of({ spellcheck: 'false' }),
        cmSurfaceTheme,
        themeComp.of(dark),
        ...(language !== null ? [language] : []),
        CodeMirrorView.updateListener.of((update) => {
          if (update.docChanged) {
            setDraft(update.state.doc.toString())
            setDirty(true)
          }
        }),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => { save(); return true },
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
      ],
    })
    const view = new CodeMirrorView({ state, parent: host })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
      themeCompRef.current = null
    }
    // The keymap's save() reads live refs; scope/path are stable for a
    // tab's lifetime, and the dark flip is handled by the reconfigure
    // effect below (recreating the view here would drop the draft).
  }, [load])

  // Scheme flip: re-theme in place (the compartment holds only the
  // scheme-dependent extensions; everything else is untouched).
  useEffect(() => {
    const view = viewRef.current
    const themeComp = themeCompRef.current
    if (view === null || themeComp === null) return
    view.dispatch({ effects: themeComp.reconfigure(dark) })
  }, [dark])

  // The editor may have been display:none while previewing; re-measure when
  // it becomes visible again (CodeMirror sizes itself on reveal).
  useEffect(() => {
    if (mode === 'edit') viewRef.current?.requestMeasure()
  }, [mode])

  const save = (): void => {
    const view = viewRef.current
    if (view === null || savingRef.current) return
    savingRef.current = true
    setSaveState('saving')
    api.fsWrite(scope, path, view.state.doc.toString()).then(() => {
      savingRef.current = false
      setDraft(null)
      setDirty(false)
      setSaveState('saved')
    }).catch(() => {
      savingRef.current = false
      setSaveState('failed')
    })
  }

  const previewable = load.status === 'ready' && load.kind === 'md'
  const editable = load.status === 'ready' && (load.kind === 'text' || load.kind === 'md')
  const saveLabel = saveState === 'saving' ? t('loading') : saveState === 'saved' ? t('saved') : saveState === 'failed' ? t('saveFailed') : ''

  return (
    <div className={css.editor}>
      <div className={css.editorHeader}>
        <span className={css.editorTitle} title={path}>{title}</span>
        {previewable && (
          <div className={css.editorModeToggle}>
            <button
              type="button"
              className={clsx(css.editorModeButton, mode === 'preview' && css.editorModeActive)}
              onClick={() => { setMode('preview') }}
            >
              {t('preview')}
            </button>
            <button
              type="button"
              className={clsx(css.editorModeButton, mode === 'edit' && css.editorModeActive)}
              onClick={() => { setMode('edit') }}
            >
              {t('edit')}
            </button>
          </div>
        )}
        {dirty && <span className={css.dirtyDot} title={t('unsaved')} />}
        {editable && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('save')}
            title={`${t('save')} (Ctrl/Cmd+S)`}
            onClick={save}
          >
            <IconCheckOutline16 />
          </button>
        )}
        {saveLabel !== '' && <span className={clsx(css.editorStatus, saveState === 'failed' && css.editorStatusError)}>{saveLabel}</span>}
      </div>
      {load.status === 'loading' && <div className={css.editorPlaceholder}>{t('loading')}</div>}
      {load.status === 'error' && <div className={css.editorError}>{load.message}</div>}
      {load.status === 'binary' && (
        <div className={css.editorBinary}>
          <span className={css.editorBinaryNotice}>{t('binaryNoPreview')}</span>
          <a className={css.editorDownloadLink} href={downloadUrl(scope, path)} download>
            {t('downloadToView')}
          </a>
        </div>
      )}
      {editable && (
        <>
          {load.truncated && mode === 'edit' && <div className={css.editorBanner}>{t('truncation')}</div>}
          <div
            className={clsx(css.editorCm, previewable && mode === 'preview' && css.editorCmHidden)}
            ref={hostRef}
          />
        </>
      )}
      {load.status === 'ready' && load.viewer !== undefined && createElement(load.viewer.component, {
        ctx, store, scope, path, title,
        content: load.content,
        truncated: load.truncated,
        mediaUrl: load.mediaUrl,
        customData: load.customData,
      })}
      {previewable && mode === 'preview' && (
        <div className={css.editorMd}>
          <MarkdownText text={draft ?? load.content ?? ''} />
        </div>
      )}
    </div>
  )
}

/** The lowercased file extension of a path ('' when none). */
function extOfPath(path: string): string {
  const at = path.lastIndexOf('.')
  if (at === -1) return ''
  const base = path.slice(at).toLowerCase()
  return base.includes('/') || base.includes('\\') ? '' : base
}
