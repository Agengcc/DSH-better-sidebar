/**
 * The file editor tab: a CodeMirror 6 editor with line wrapping and syntax
 * highlighting (extension-keyed language), a dirty dot and Ctrl/Cmd+S save,
 * image viewing through the media route, and a plain notice for binary
 * files. Markdown files open in rendered preview with a preview/edit toggle:
 * edit mode shows the source in the editor, preview renders the live draft,
 * and unsaved edits survive the toggle. Reads cap at the host's 512KB bound
 * (a banner marks truncation).
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { EditorState } from '@codemirror/state'
import { EditorView as CodeMirrorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { oneDark } from '@codemirror/theme-one-dark'
import { IconCheckOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, mediaUrl, type SessionScope } from './api.ts'
import { languageForPath } from './lang.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']
const MD_EXT = ['.md', '.markdown']

type EditorLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; kind: 'text' | 'image' | 'md'; content: string; truncated: boolean }
  | { status: 'binary' }

/** Previewable files (rendered output vs source editing). */
type ViewMode = 'preview' | 'edit'

export function EditorView(props: { scope: SessionScope; path: string; title: string }) {
  const { scope, path, title } = props
  const [load, setLoad] = useState<EditorLoad>({ status: 'loading' })
  const [mode, setMode] = useState<ViewMode>('preview')
  /** The editor's current text (null while clean); preview renders this. */
  const [draft, setDraft] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<CodeMirrorView | null>(null)
  const savingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoad({ status: 'loading' })
    setMode('preview')
    setDraft(null)
    setDirty(false)
    setSaveState('idle')
    api.fsRead(scope, path).then((result) => {
      if (cancelled) return
      const ext = extOfPath(path)
      if (result.kind === 'binary') {
        setLoad({ status: 'binary' })
        return
      }
      if (IMAGE_EXT.includes(ext)) {
        setLoad({ status: 'ready', kind: 'image', content: '', truncated: false })
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
  }, [scope.sessionId, scope.cwd, path])

  // Create the CodeMirror editor once the file is loaded. The view owns the
  // document; React only tracks dirty/draft state through the update
  // listener. For markdown the view stays mounted while previewing (hidden),
  // so unsaved edits survive the preview/edit toggle.
  useEffect(() => {
    if (load.status !== 'ready' || (load.kind !== 'text' && load.kind !== 'md')) return
    const host = hostRef.current
    if (host === null) return
    const language = languageForPath(path)
    const state = EditorState.create({
      doc: load.content,
      extensions: [
        CodeMirrorView.lineWrapping,
        history(),
        EditorState.tabSize.of(2),
        CodeMirrorView.contentAttributes.of({ spellcheck: 'false' }),
        CodeMirrorView.theme({
          '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent' },
          '.cm-scroller': { overflow: 'auto', fontFamily: '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace' },
          '.cm-content': { caretColor: 'var(--dsw-alias-label-primary)' },
        }),
        ...(language !== null ? [language] : []),
        oneDark,
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
    }
  }, [load])

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
      {load.status === 'binary' && <div className={css.editorPlaceholder}>{t('binary')}</div>}
      {editable && (
        <>
          {load.truncated && mode === 'edit' && <div className={css.editorBanner}>{t('truncation')}</div>}
          <div
            className={clsx(css.editorCm, previewable && mode === 'preview' && css.editorCmHidden)}
            ref={hostRef}
          />
        </>
      )}
      {load.status === 'ready' && load.kind === 'image' && (
        <div className={css.editorImageWrap}>
          <img className={css.editorImage} src={mediaUrl(scope, path)} alt={title} />
        </div>
      )}
      {previewable && mode === 'preview' && (
        <div className={css.editorMd}>
          <MarkdownText text={draft ?? load.content} />
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
