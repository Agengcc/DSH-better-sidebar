/**
 * The file editor tab: text editing with a dirty dot and Ctrl/Cmd+S save,
 * image viewing through the media route, Markdown preview through the shared
 * MarkdownText component, and a plain notice for binary files. Reads cap at
 * the host's 512KB bound (a banner marks truncation).
 */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { IconCheckOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, mediaUrl } from './api.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']
const MD_EXT = ['.md', '.markdown']

function extOf(path: string): string {
  const at = path.lastIndexOf('.')
  if (at === -1) return ''
  const base = path.slice(at).toLowerCase()
  return base.includes('/') || base.includes('\\') ? '' : base
}

type EditorLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; kind: 'text' | 'image' | 'md'; content: string; truncated: boolean }
  | { status: 'binary' }

export function EditorView(props: { sessionId: string; path: string; title: string }) {
  const { sessionId, path, title } = props
  const [load, setLoad] = useState<EditorLoad>({ status: 'loading' })
  const [draft, setDraft] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')

  useEffect(() => {
    let cancelled = false
    setLoad({ status: 'loading' })
    setDraft(null)
    setSaveState('idle')
    api.fsRead(sessionId, path).then((result) => {
      if (cancelled) return
      const ext = extOf(path)
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
  }, [sessionId, path])

  const save = (): void => {
    if (load.status !== 'ready' || load.kind !== 'text' || draft === null || saveState === 'saving') return
    setSaveState('saving')
    api.fsWrite(sessionId, path, draft).then(() => {
      setSaveState('saved')
      setDraft(null)
    }).catch(() => {
      setSaveState('failed')
    })
  }

  const dirty = load.status === 'ready' && load.kind === 'text' && draft !== null
  const saveLabel = saveState === 'saving' ? t('loading') : saveState === 'saved' ? t('saved') : saveState === 'failed' ? t('saveFailed') : ''

  return (
    <div className={css.editor}>
      <div className={css.editorHeader}>
        <span className={css.editorTitle} title={path}>{title}</span>
        {dirty && <span className={css.dirtyDot} title={t('unsaved')} />}
        {load.status === 'ready' && load.kind === 'text' && (
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
      {load.status === 'ready' && load.kind === 'text' && (
        <>
          {load.truncated && <div className={css.editorBanner}>{t('truncation')}</div>}
          <textarea
            className={css.editorTextarea}
            spellCheck={false}
            value={draft ?? load.content}
            onChange={(event) => {
              setDraft(event.target.value)
              setSaveState('idle')
            }}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 's') {
                event.preventDefault()
                save()
              }
            }}
          />
        </>
      )}
      {load.status === 'ready' && load.kind === 'image' && (
        <div className={css.editorImageWrap}>
          <img className={css.editorImage} src={mediaUrl(sessionId, path)} alt={title} />
        </div>
      )}
      {load.status === 'ready' && load.kind === 'md' && (
        <div className={css.editorMd}>
          <MarkdownText text={load.content} />
        </div>
      )}
    </div>
  )
}
