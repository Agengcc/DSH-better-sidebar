/**
 * The source-control panel: status list (staged vs unstaged), per-file diff
 * through the shared DiffBlock (old = HEAD/index content, new = worktree or
 * index content), stage/unstage, commit with a message box, branch list with
 * switch, and recent history. Refresh is manual + on mount/focus (no file
 * watcher — KISS).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  DiffBlock, IconBranchOutline16, IconRefreshOutline16, IconTrashOutline16,
  Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitLogEntry, GitStatusEntry, GitStatusResult, SessionScope } from './api.ts'
import { api } from './api.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** The XY status letters a row badge shows (X = index, Y = worktree). */
function badgeOf(entry: GitStatusEntry): string {
  const index = entry.xy[0]
  const worktree = entry.xy[1]
  if (index !== undefined && index !== ' ' && index !== '?') return index
  if (worktree !== undefined && worktree !== ' ' && worktree !== '?') return worktree
  return '?'
}

export function GitView(props: { scope: SessionScope }) {
  const { scope } = props
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [branchNames, setBranchNames] = useState<string[]>([])
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([])
  const [commitMsg, setCommitMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)

  // Selected diff: path + side (staged) + the two text sides for DiffBlock.
  const [diffPath, setDiffPath] = useState<string | null>(null)
  const [diffStaged, setDiffStaged] = useState(false)
  const [diffOld, setDiffOld] = useState<string | null>(null)
  const [diffNew, setDiffNew] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const [statusResult, branchResult, logResult] = await Promise.all([
        api.gitStatus(scope),
        api.gitBranch(scope).catch(() => ({ current: '', names: [] as string[] })),
        api.gitLog(scope).catch(() => [] as GitLogEntry[]),
      ])
      setStatus(statusResult)
      setBranchNames(branchResult.names)
      setLogEntries(logResult)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [scope.sessionId, scope.cwd])

  useEffect(() => { void refresh() }, [refresh])

  /** Load the diff sides for one entry: HEAD content vs worktree/index content. */
  const selectDiff = async (entry: GitStatusEntry, staged: boolean): Promise<void> => {
    setDiffPath(entry.path)
    setDiffStaged(staged)
    setDiffOld(null)
    setDiffNew('')
    const oldPromise = api.gitShow(scope, 'HEAD', entry.path)
      .then(result => result.content)
      .catch(() => null)
    const newPromise = staged
      ? api.gitShow(scope, ':', entry.path).then(result => result.content ?? '').catch(() => '')
      : api.fsRead(scope, entry.path)
        .then(result => (result.kind === 'text' ? result.content : ''))
        .catch(() => '')
    const [oldText, newText] = await Promise.all([oldPromise, newPromise])
    setDiffOld(oldText)
    setDiffNew(newText)
  }

  const stageEntry = async (entry: GitStatusEntry, staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (staged) await api.gitUnstage(scope, entry.path)
      else await api.gitStage(scope, entry.path)
      setDiffPath(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const stageAll = async (staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (staged) await api.gitUnstage(scope)
      else await api.gitStage(scope)
      setDiffPath(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const commit = async (): Promise<void> => {
    const message = commitMsg.trim()
    if (message === '' || busy) return
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitCommit(scope, message)
      setCommitMsg('')
      setDiffPath(null)
      await refresh()
    } catch (reason) {
      setCommitError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const checkout = async (branch: string): Promise<void> => {
    if (branch === status?.branch || busy) return
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitCheckout(scope, branch)
      setDiffPath(null)
      await refresh()
    } catch (reason) {
      setCommitError(`${t('checkoutError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  const stagedEntries = (status?.entries ?? []).filter(entry => badgeOf(entry) !== '?')
  const unstagedEntries = (status?.entries ?? []).filter(entry => badgeOf(entry) === '?')

  const renderEntry = (entry: GitStatusEntry, staged: boolean): ReactNode => {
    const selected = diffPath === entry.path && diffStaged === staged
    return (
      <div key={`${staged ? 's' : 'u'}:${entry.path}`} className={clsx(css.gitRow, selected && css.gitRowSelected)}>
        <button
          type="button"
          className={css.gitRowMain}
          title={entry.path}
          onClick={() => { void selectDiff(entry, staged) }}
        >
          <span className={css.gitBadge}>{badgeOf(entry)}</span>
          <span className={css.gitName}>{entry.path}</span>
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={staged ? t('unstage') : t('stage')}
          title={staged ? t('unstage') : t('stage')}
          disabled={busy}
          onClick={() => { void stageEntry(entry, staged) }}
        >
          {staged ? <IconTrashOutline16 /> : <IconBranchOutline16 />}
        </button>
      </div>
    )
  }

  return (
    <div className={css.git}>
      <div className={css.gitHeader}>
        <select
          className={css.gitBranchSelect}
          value={status?.branch ?? ''}
          onChange={(event) => { void checkout(event.target.value) }}
          disabled={busy || (status !== null && !status.isRepo)}
        >
          {(status?.branch ?? '') !== '' && <option value={status!.branch}>{status!.branch}</option>}
          {branchNames.filter(name => name !== status?.branch).map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={() => { void refresh() }}
        >
          <IconRefreshOutline16 />
        </button>
      </div>

      {loading && <div className={css.gitPlaceholder}>{t('loading')}</div>}
      {!loading && error !== null && <div className={css.gitError}>{error}</div>}
      {!loading && status !== null && !status.isRepo && (
        <div className={css.gitPlaceholder}>{t('notRepo')}</div>
      )}

      {status !== null && status.isRepo && (
        <>
          <div className={css.gitSection}>
            <div className={css.gitSectionHeader}>
              <span>{t('staged')} ({stagedEntries.length})</span>
              {stagedEntries.length > 0 && (
                <button type="button" className={css.gitLink} disabled={busy} onClick={() => { void stageAll(true) }}>
                  {t('unstageAll')}
                </button>
              )}
            </div>
            {stagedEntries.length === 0 && <div className={css.gitEmpty}>{t('noChanges')}</div>}
            {stagedEntries.map(entry => renderEntry(entry, true))}
          </div>
          <div className={css.gitSection}>
            <div className={css.gitSectionHeader}>
              <span>{t('unstaged')} ({unstagedEntries.length})</span>
              {unstagedEntries.length > 0 && (
                <button type="button" className={css.gitLink} disabled={busy} onClick={() => { void stageAll(false) }}>
                  {t('stageAll')}
                </button>
              )}
            </div>
            {unstagedEntries.length === 0 && <div className={css.gitEmpty}>{t('noChanges')}</div>}
            {unstagedEntries.map(entry => renderEntry(entry, false))}
          </div>

          {diffPath !== null && (
            <div className={css.gitDiff}>
              <DiffBlock
                diffs={[{ path: diffPath, oldText: diffOld, newText: diffNew }]}
                maxLines={300}
              />
            </div>
          )}

          <div className={css.gitCommit}>
            <Input
              className={css.gitCommitInput}
              placeholder={t('commitPlaceholder')}
              value={commitMsg}
              disabled={busy}
              onChange={(event) => { setCommitMsg(event.target.value); setCommitError(null) }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void commit()
              }}
            />
            <button
              type="button"
              className={css.gitCommitButton}
              disabled={busy || commitMsg.trim() === '' || stagedEntries.length === 0}
              onClick={() => { void commit() }}
            >
              {t('commit')}
            </button>
          </div>
          {commitError !== null && <div className={css.gitError}>{commitError}</div>}

          <div className={css.gitSection}>
            <div className={css.gitSectionHeader}><span>{t('history')}</span></div>
            {logEntries.map(entry => (
              <div key={entry.hash} className={css.gitLogRow} title={`${entry.author} · ${entry.date}`}>
                <span className={css.gitLogHash}>{entry.hash}</span>
                <span className={css.gitLogSubject}>{entry.subject}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
