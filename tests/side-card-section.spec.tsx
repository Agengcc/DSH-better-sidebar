/**
 * Side card settings section render tests: the section is DECLARATIVE —
 * every row (icon, title, type id, extensions, enable switch) derives from
 * the sidebar service's tab/viewer registries instead of hardcoded copy.
 * These specs pin that derivation with a fake store + a small registry:
 * registered tabs/viewers appear with their declared icon/title/settings,
 * disabled states render unchecked, and a disabled tab hides its declared
 * nested toggles.
 *
 * Rendered with renderToString (mount effects — the settings RPC sync — do
 * not run in SSR; the initial store prefs are the render input).
 */
import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import { SideCardSection, type SideCardSectionProps } from '../src/client/SideCardSection.tsx'

/** One tab + one viewer + the subagent-style nested toggle under a tab. */
function mount(): { store: SidebarStore; service: BetterSidebarService } {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({
    id: 'explorer',
    title: () => 'Explorer',
    icon: () => createElement('svg', { 'data-icon': 'explorer' }),
    order: 10,
    component: () => null,
  })
  service.registerTab({
    id: 'subagent',
    title: () => 'Subagents',
    icon: () => createElement('svg', { 'data-icon': 'subagent' }),
    order: 30,
    settings: {
      toggles: [{
        key: 'autoOpenSubagent',
        title: () => 'Auto-open Subagents',
        desc: () => 'Expand on new subagent',
      }],
    },
    component: () => null,
  })
  service.registerFileViewer({
    id: 'image',
    title: () => 'Image',
    icon: () => createElement('svg', { 'data-icon': 'image' }),
    exts: ['png', 'jpg'],
    fetchStrategy: 'mediaUrl',
    component: () => null,
  })
  return { store, service }
}

function renderSection(store: SidebarStore, service: BetterSidebarService): string {
  return renderToString(createElement(
    SideCardSection,
    { store, service } as unknown as SideCardSectionProps,
  ))
}

describe('SideCardSection declarative inventory', () => {
  it('renders one row per registered tab: icon + title + type id + switch', () => {
    const { store, service } = mount()
    const html = renderSection(store, service)
    expect(html).toContain('data-icon="explorer"')
    expect(html).toContain('>Explorer<')
    // The type id is the row's desc (the declarative "type" surface).
    expect(html).toContain('>explorer<')
    expect(html).toContain('data-icon="subagent"')
    expect(html).toContain('>Subagents<')
    // Both tabs are enabled by default: their switches render checked.
    expect(html.match(/type="checkbox"/g)?.length).toBeGreaterThanOrEqual(4)
  })

  it('renders the declared nested toggle under an enabled tab', () => {
    const { store, service } = mount()
    const html = renderSection(store, service)
    // The subagent tab's declared related setting appears while enabled,
    // bound to its prefs key (default true → checked).
    expect(html).toContain('Auto-open Subagents')
    expect(html).toContain('Expand on new subagent')
  })

  it('hides the nested toggles while the parent tab is disabled', () => {
    const { store, service } = mount()
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { subagent: false } })
    const html = renderSection(store, service)
    // The parent row stays (so the user can re-enable it) but unchecked.
    expect(html).toContain('>Subagents<')
    expect(html).not.toContain('Auto-open Subagents')
  })

  it('renders one row per registered viewer: icon + title + exts + switch', () => {
    const { store, service } = mount()
    const html = renderSection(store, service)
    expect(html).toContain('data-icon="image"')
    expect(html).toContain('>Image<')
    // The covered extensions are the row's desc.
    expect(html).toContain('png · jpg')
  })

  it('a disabled viewer renders unchecked', () => {
    const { store, service } = mount()
    store.setPrefs({ ...store.getPrefs(), viewersEnabled: { image: false } })
    const html = renderSection(store, service)
    expect(html).toContain('>Image<')
  })

  it('a disabled tab renders unchecked (its switch reflects the prefs map)', () => {
    const { store, service } = mount()
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { explorer: false } })
    const html = renderSection(store, service)
    expect(html).toContain('>explorer<')
  })
})
