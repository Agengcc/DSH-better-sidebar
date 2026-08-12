/**
 * Narrow-viewport breakpoint tests: the boundary the mobile sidebar layout
 * keys off (paired with the CSS @media (max-width: 1023px) gates in
 * sidebar.module.css — 1023px ≡ widths strictly below NARROW_MAX_WIDTH).
 */
import { describe, expect, it } from 'vitest'
import { isNarrowWidth, NARROW_MAX_WIDTH } from '../src/client/breakpoints.ts'

describe('narrow-viewport breakpoint', () => {
  it('treats widths below NARROW_MAX_WIDTH as narrow (mobile)', () => {
    expect(NARROW_MAX_WIDTH).toBe(1024)
    expect(isNarrowWidth(320)).toBe(true)
    expect(isNarrowWidth(390)).toBe(true)
    expect(isNarrowWidth(768)).toBe(true)
    expect(isNarrowWidth(1023)).toBe(true)
  })

  it('treats NARROW_MAX_WIDTH and above as wide (desktop)', () => {
    expect(isNarrowWidth(1024)).toBe(false)
    expect(isNarrowWidth(1280)).toBe(false)
    expect(isNarrowWidth(1920)).toBe(false)
  })
})
