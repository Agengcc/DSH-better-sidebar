import { describe, expect, it } from 'vitest'
import Loader from '@cordisjs/plugin-loader'
import * as sidebar from '../src/index.ts'

/**
 * Run the real namespace export through `Loader.unwrapExports`; a stray
 * default would discard `name`, `inject`, `Config`, and `apply`. Same guard
 * the official plugin repos ship (dsh-external/turtle-ui,
 * packages/ui/jsonrpc).
 */
describe('dsh-better-sidebar plugin export shape', () => {
  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/Config/apply', () => {
    expect('default' in sidebar).toBe(false)
    expect(typeof sidebar.apply).toBe('function')

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(sidebar) as Record<string, unknown>
    expect(unwrapped).toBe(sidebar)
    expect(unwrapped.name).toBe('dsh-better-sidebar')
    expect(unwrapped.inject).toEqual(['httpServer', 'sessions', 'loader'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('exports the schemastery Config with the documented tunable fields', () => {
    const schema = sidebar.Config
    expect(schema).toBeDefined()
    // The resolved defaults mirror the pre-config constants.
    const resolved = (schema as unknown as {
      (input: Record<string, unknown> | undefined): Record<string, unknown>
    })(undefined)
    expect(resolved.readLimit).toBe(512 * 1024)
    expect(resolved.mediaLimit).toBe(20 * 1024 * 1024)
    expect(resolved.listLimit).toBe(1000)
    expect(resolved.terminalsPerSession).toBe(3)
    expect(resolved.reconnectGraceMs).toBe(30_000)
  })
})
