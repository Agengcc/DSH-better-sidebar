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
  // A failure anywhere in the client lifecycle must never take the app down
  // silently: log with the plugin prefix and pin a visible diagnostic strip
  // to the page so a blank panel is never the only symptom.
  const fail = (phase: string, error: unknown): void => {
    console.error(`[dsh-better-sidebar] ${phase} error:`, error)
    try {
      const bar = document.createElement('div')
      bar.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:70vw;padding:8px 12px;'
        + 'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f2a1a1;background:#1b1b22;'
        + 'border:1px solid #f2a1a1;border-radius:8px;white-space:pre-wrap'
      bar.textContent = `[dsh-better-sidebar] ${phase} error: ${error instanceof Error ? error.message : String(error)}`
      document.body.appendChild(bar)
    } catch {
      // Nothing left to report with.
    }
  }
  try {
    ctx.effect(() => {
      try {
        const host = document.createElement('div')
        host.setAttribute('data-dsh-better-sidebar', '')
        document.body.appendChild(host)
        const root = createRoot(host)
        root.render(createElement(SidebarBoundary, null, createElement(Sidebar, { ctx })))
        return () => {
          root.unmount()
          host.remove()
        }
      } catch (error) {
        fail('mount', error)
        return undefined
      }
    }, 'dsh-better-sidebar: sidebar mount')

    ctx.effect(
      () => {
        try {
          return registerTurnTailInterception(ctx)
        } catch (error) {
          fail('interception', error)
          return undefined
        }
      },
      'dsh-better-sidebar: turn-tail interception',
    )
  } catch (error) {
    fail('load', error)
  }
}
