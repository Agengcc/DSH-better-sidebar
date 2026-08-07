/**
 * Client half of dsh-better-sidebar: mounts the right sidebar portal and
 * registers the turn-tail interception. Requires the runtime's slots and
 * sessions services; the bundle itself is a module-table consumer only
 * (react + ui-primitives + xterm, all provided or inlined).
 */
import { createRoot } from 'react-dom/client'
import type { Context } from '../context-types.ts'
import { Sidebar } from './Sidebar.tsx'
import { registerTurnTailInterception } from './intercept.tsx'

/** Services required before mounting (provided by the client runtime). */
export const inject = ['slots', 'sessions']

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
    root.render(<Sidebar ctx={ctx} />)
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
