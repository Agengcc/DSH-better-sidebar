/**
 * Built-in tab types and file viewers: the plugin registers its own
 * built-in pages (explorer / git / terminal / subagent / editor / diff)
 * and file previewers (image / pdf / docx / xlsx / pptx / markdown / code /
 * binary-download) through the same {@link BetterSidebarService} external
 * plugins use — eating its own dogfood. Code/markdown are registered
 * viewers like any other (fsRead strategy, {@link TextEditor}); the
 * `binary-download` viewer sniffs NUL bytes via `detect` for unknown
 * binaries and serves doc/xls/ppt by extension.
 */
import {
  IconBranchOutline16, IconCodeOutline16, IconFolderOpen16, IconThinkOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { allLeaves, isAgentTabId, type SidebarState } from './state.ts'
import { mediaUrl } from './api.ts'
import { t } from './locales.ts'
import { openSidebarFile } from './intercept.tsx'
import { ExplorerView } from './ExplorerView.tsx'
import { EditorHost } from './EditorHost.tsx'
import { TextEditor } from './TextEditor.tsx'
import { TerminalView } from './TerminalView.tsx'
import { GitView } from './GitView.tsx'
import { DiffTab } from './DiffTab.tsx'
import { SubagentView } from './SubagentView.tsx'
import { DocxView, XlsxView } from './office-view.tsx'
import { PdfView } from './PdfView.tsx'
import { PptxView } from './PptxView.tsx'
import { BinaryDownload } from './binary-download.tsx'
import { IconTerminalOutline16, IconDiffOutline16 } from './icons.tsx'
import type { BetterSidebarService, FileViewerDescriptor, TabDescriptor } from './service.ts'
import css from './sidebar.module.css'

/** How many UI-owned terminals may be open at once (agent-owned ones are uncapped). */
const TERMINAL_LIMIT = 3

/** Count UI-owned terminals (agent:` tabs excluded — they are the model's). */
function uiTerminalCount(state: SidebarState): number {
  return allLeaves(state.splits)
    .flatMap(leaf => leaf.tabs)
    .filter(tab => tab.type === 'terminal' && !isAgentTabId(tab.id)).length
}

/** The 6 built-in tab descriptors. */
function builtinTabs(ctx: Context): readonly TabDescriptor[] {
  return [
    {
      id: 'editor',
      title: () => t('editor'),
      icon: (size: number) => <IconCodeOutline16 size={size} />,
      order: -1,
      hidden: true,
      dedupeKey: (tab) => tab.path,
      component: ({ ctx, store, scope, tab }) => (
        <EditorHost ctx={ctx} store={store} scope={scope} path={tab.path ?? ''} title={tab.title} />
      ),
    },
    {
      id: 'explorer',
      title: () => t('explorer'),
      icon: (size: number) => <IconFolderOpen16 size={size} />,
      order: 10,
      single: true,
      component: ({ ctx, store, scope, expanded, onToggleDir, onReferenceFile }) => (
        <ExplorerView
          sessionId={scope.sessionId}
          cwd={scope.cwd}
          expanded={expanded ?? []}
          onToggle={onToggleDir ?? (() => { /* no-op */ })}
          onOpenFile={(path) => { openSidebarFile(ctx, store, scope.sessionId, path) }}
          onReferenceFile={onReferenceFile ?? (() => { /* no-op */ })}
        />
      ),
    },
    {
      id: 'git',
      title: () => t('git'),
      icon: (size: number) => <IconBranchOutline16 size={size} />,
      order: 20,
      single: true,
      component: ({ ctx, store, scope, onOpenDiff }) => (
        <GitView
          scope={scope}
          onOpenFile={(path) => { openSidebarFile(ctx, store, scope.sessionId, path) }}
          onOpenDiff={onOpenDiff ?? (() => { /* no-op */ })}
        />
      ),
    },
    {
      id: 'subagent',
      title: () => t('subagent'),
      icon: (size: number) => <IconThinkOutline16 size={size} />,
      order: 30,
      single: true,
      component: ({ ctx, scope, visible, onSubagentJump }) => (
        <SubagentView
          sessionId={scope.sessionId}
          ctx={ctx}
          active={visible}
          onOpenChild={(address) => { onSubagentJump?.(address.childSessionId) }}
        />
      ),
    },
    {
      id: 'terminal',
      title: () => t('terminal'),
      icon: (size: number) => <IconTerminalOutline16 size={size} />,
      order: 40,
      available: (_ctx, _scope, state) => uiTerminalCount(state) < TERMINAL_LIMIT,
      createTab: (state) => {
        const count = uiTerminalCount(state)
        if (count >= TERMINAL_LIMIT) return null
        return {
          tab: {
            id: `terminal:${state.nextTerminal}`,
            type: 'terminal',
            title: `${t('terminal')} ${state.nextTerminal}`,
          },
          patch: { nextTerminal: state.nextTerminal + 1 },
        }
      },
      component: ({ scope, tab, store }) => (
        <TerminalView scope={scope} tabId={tab.id} store={store} />
      ),
    },
    {
      id: 'diff',
      title: () => t('git'),
      icon: (size: number) => <IconDiffOutline16 size={size} />,
      order: -1,
      hidden: true,
      dedupeKey: (tab) => tab.id,
      component: ({ scope, tab }) => (
        tab.diff === undefined ? null
          : <DiffTab sessionId={scope.sessionId} cwd={scope.cwd} diff={tab.diff} />
      ),
    },
  ]
}

/** The 8 built-in file viewer descriptors — every preview surface is a registered viewer. */
const builtinViewers: readonly FileViewerDescriptor[] = [
  {
    id: 'image',
    exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
    fetchStrategy: 'mediaUrl',
    component: ({ mediaUrl: url, title }) => (
      <div className={css.editorImageWrap}>
        <img className={css.editorImage} src={url} alt={title} />
      </div>
    ),
  },
  {
    id: 'pdf',
    exts: ['pdf'],
    fetchStrategy: 'mediaUrl',
    component: ({ scope, path, title }) => (
      <PdfView scope={scope} path={path} title={title} />
    ),
  },
  {
    id: 'docx',
    exts: ['docx'],
    fetchStrategy: 'mediaUrl',
    component: ({ scope, path, title }) => (
      <DocxView scope={scope} path={path} title={title} />
    ),
  },
  {
    id: 'xlsx',
    exts: ['xlsx'],
    fetchStrategy: 'mediaUrl',
    component: ({ scope, path, title }) => (
      <XlsxView scope={scope} path={path} title={title} />
    ),
  },
  {
    id: 'pptx',
    exts: ['pptx'],
    fetchStrategy: 'mediaUrl',
    component: ({ scope, path, title }) => (
      <PptxView scope={scope} path={path} title={title} />
    ),
  },
  {
    id: 'markdown',
    exts: ['md', 'markdown'],
    fetchStrategy: 'fsRead',
    component: (props) => <TextEditor {...props} />,
  },
  {
    id: 'code',
    exts: [],
    priority: -100,
    fetchStrategy: 'fsRead',
    component: (props) => <TextEditor {...props} />,
  },
  {
    id: 'binary-download',
    exts: ['doc', 'xls', 'ppt'],
    priority: -50,
    fetchStrategy: 'binary-download',
    // NUL probe: a file whose head bytes contain a NUL is binary — claimed
    // before the catch-all code viewer on the head re-match.
    detect: (_path, head) => head.includes(0),
    component: ({ scope, path }) => <BinaryDownload scope={scope} path={path} />,
  },
]

/**
 * Register all built-in tabs and viewers with the service. Returns a
 * disposer that unregisters everything (cordis auto-invokes it on fiber
 * disposal). The `ctx` is threaded into tab descriptors that need it
 * (EditorHost reads `ctx.betterSidebar` for file-viewer matching).
 */
export function registerBuiltins(ctx: Context, service: BetterSidebarService): () => void {
  const disposers: (() => void)[] = []
  for (const tab of builtinTabs(ctx)) {
    disposers.push(service.registerTab(tab))
  }
  for (const viewer of builtinViewers) {
    disposers.push(service.registerFileViewer(viewer))
  }
  return () => {
    for (const d of disposers) {
      try { d() } catch { /* already disposed */ }
    }
  }
}
