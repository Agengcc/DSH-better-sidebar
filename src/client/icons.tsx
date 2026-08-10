/**
 * Icons the sidebar needs beyond the primitives set: a terminal glyph (the
 * icon library has none) and the per-tab-type icon mapping shared by the
 * tab strip, the + menu, and the empty-pane cards.
 */
import type { ReactNode } from 'react'
import {
  IconBranchOutline16, IconCodeOutline16, IconFolderOpen16, IconThinkOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TabType } from './state.ts'

/**
 * Terminal glyph in the app's outline style (1.5px stroke, currentColor):
 * a rounded frame with a prompt chevron and underscore cursor.
 */
export const IconTerminalOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4.5 6.25 6.75 8 4.5 9.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8.5 10.4h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

/** Diff glyph in the app's outline style: a file frame with a plus and a minus row. */
export const IconDiffOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4 5h3M5.5 3.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M9.5 12.5h2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

/** The one icon per tab type (shared by tabs, the + menu, and pane cards). */
export function tabTypeIcon(type: TabType, size = 16): ReactNode {
  switch (type) {
    case 'explorer': return <IconFolderOpen16 size={size} />
    case 'git': return <IconBranchOutline16 size={size} />
    case 'terminal': return <IconTerminalOutline16 size={size} />
    case 'subagent': return <IconThinkOutline16 size={size} />
    case 'editor': return <IconCodeOutline16 size={size} />
    case 'diff': return <IconDiffOutline16 size={size} />
  }
}
