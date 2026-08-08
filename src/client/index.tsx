/**
 * Client half of dsh-better-sidebar: mounts the right sidebar portal (inside
 * an error boundary so a rendering failure shows an error strip instead of a
 * blank panel) and registers the turn-tail interception. Requires the
 * runtime's slots and sessions services; the bundle itself is a module-table
 * consumer only (react + ui-primitives + xterm, all provided or inlined).
 */
import { Component, createElement, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Context } from '../context-types.ts'
import { Sidebar } from './Sidebar.tsx'
import { registerTurnTailInterception } from './intercept.tsx'
import { t } from './locales.ts'
import css from './sidebar.module.css'
import './layout.css'

/** Services required before mounting (provided by the client runtime). */
export const inject = ['slots', 'sessions']

/**
 * Error boundary over the sidebar tree: a render error must never blank the
 * whole panel silently — it shows a dismissible error strip and logs the
 * stack for diagnosis.
 */
class SidebarBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[dsh-better-sidebar] render error:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className={css.boundaryError}>
          <span>dsh-better-sidebar: {this.state.error}</span>
          <button
            type="button"
            className={css.terminalRetry}
            onClick={() => { this.setState({ error: null }) }}
          >
            {t('terminalRetry')}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * Client plugin body.
 * @param ctx - the client cordis context (slots, sessions).
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const host = document.createElement('div')
    host.setAttribute('data-dsh-better-sidebar', '')
    document.body.appendChild(host)
    const root = createRoot(host)
    root.render(createElement(SidebarBoundary, null, createElement(Sidebar, { ctx })))
    return () => {
      root.unmount()
      host.remove()
    }
  }, 'dsh-better-sidebar: sidebar mount')

  ctx.effect(
    () => registerTurnTailInterception(ctx),
    'dsh-better-sidebar: turn-tail interception',
  )
}
