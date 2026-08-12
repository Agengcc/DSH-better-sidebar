/**
 * MobileWorkbench tests: the narrow-viewport merged workbench — BOTH trees
 * (right + bottom) stacked in one panel with a draggable divider between
 * them, the bottom tree at the shared state.bottomHeight. Structure
 * assertions via renderToString (the repo's component-test pattern). The
 * divider drag itself is pointer-capture logic — exercised manually, like
 * the desktop panel drags; the store clamp it commits through
 * (setBottomHeight) is unit-tested in unit.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MobileWorkbench, type WorkbenchActions } from '../src/client/split-pane.tsx'
import { makeDefaultState } from '../src/client/state.ts'

const noopActions: WorkbenchActions = {
  closeTab: () => {},
  activateTab: () => {},
  focusPane: () => {},
  moveTabToEdge: () => {},
  moveTabBefore: () => {},
  resizeSplit: () => {},
}

describe('MobileWorkbench (narrow merged layout)', () => {
  it('renders BOTH trees stacked, with the divider and the shared bottom height', () => {
    const state = makeDefaultState()
    // A terminal tab in the bottom tree (a desktop bottom-panel session).
    const bottomPane = state.bottomSplits as { tabs: Array<{ id: string; type: string; title: string }> }
    bottomPane.tabs = [{ id: 'tab:b1', type: 'terminal', title: 'Terminal' }]
    const html = renderToString((
      <MobileWorkbench
        state={state}
        actions={noopActions}
        newTabOptions={[]}
        onNewTab={() => {}}
        renderTab={(tab) => <div data-testid={`tab-${tab.id}`}>{tab.title}</div>}
        onBottomHeightCommit={() => {}}
      />
    ))
    // The right tree's default explorer tab renders (tab strip).
    expect(html).toContain('Explorer')
    // The bottom tree's terminal tab renders — the merge shows both trees.
    expect(html).toContain('Terminal')
    // The divider sits between the two workbenches.
    expect(html).toContain('divider')
    // The bottom pane carries the shared bottomHeight (the desktop bottom
    // panel's height field drives the mobile bottom tree's height).
    expect(html).toContain(`height:${state.bottomHeight}px`)
  })

  it('renders an empty bottom tree with its welcome cards (both workbenches always visible)', () => {
    const state = makeDefaultState()
    const html = renderToString((
      <MobileWorkbench
        state={state}
        actions={noopActions}
        newTabOptions={[{ id: 'explorer', label: 'Explorer' }, { id: 'terminal', label: 'Terminal' }]}
        onNewTab={() => {}}
        renderTab={() => null}
        onBottomHeightCommit={() => {}}
      />
    ))
    // The top tree's explorer TAB and the empty bottom pane's welcome cards
    // both render (each option card carries its label).
    expect(html).toContain('Explorer')
    expect(html).toContain('Terminal')
  })
})
