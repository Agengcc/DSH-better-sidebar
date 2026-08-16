import { describe, expect, it } from 'vitest'
import { relativeTo } from '../src/client/paths.ts'
import { resolveSidebarPath } from '../src/client/produced-files.ts'

describe('path helpers', () => {
  it('derives relative paths under the cwd (and "." for the cwd itself)', () => {
    expect(relativeTo('/Users/me/code', '/Users/me/code/src/main.ts')).toBe('src/main.ts')
    expect(relativeTo('/Users/me/code', '/Users/me/code')).toBe('.')
    expect(relativeTo('/Users/me/code/', '/Users/me/code/src/a/b.ts')).toBe('src/a/b.ts')
  })

  it('falls back to the path unchanged when it lies outside the cwd', () => {
    expect(relativeTo('/Users/me/code', '/Users/other/x.ts')).toBe('/Users/other/x.ts')
    expect(relativeTo('/Users/me/code', '/Users/me/codex/y.ts')).toBe('/Users/me/codex/y.ts')
  })

  it('handles windows roots and mixed separators', () => {
    expect(relativeTo('C:\\Users\\me', 'C:\\Users\\me\\src\\a.ts')).toBe('src/a.ts')
    expect(relativeTo('C:\\Users\\me', 'C:/Users/me/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('C:\\Users\\me\\', 'C:\\Users\\me')).toBe('.')
  })

  it('containment is case-insensitive (windows/macOS case-insensitive volumes)', () => {
    expect(relativeTo('C:\\Users\\Me', 'c:/users/me/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/Users/Me/code', '/users/me/code/src/main.ts')).toBe('src/main.ts')
    // The returned relative text keeps the caller's own casing.
    expect(relativeTo('C:\\Users\\me', 'C:\\Users\\Me\\SRC\\a.ts')).toBe('SRC/a.ts')
  })

  it('resolves produced paths against windows cwds', () => {
    expect(resolveSidebarPath('C:\\work\\proj', 'src/a.ts')).toBe('C:\\work\\proj\\src/a.ts')
    expect(resolveSidebarPath('C:\\work\\proj', 'C:\\abs\\x.ts')).toBe('C:\\abs\\x.ts')
    expect(resolveSidebarPath('C:\\work\\proj\\', 'C:\\abs\\x.ts')).toBe('C:\\abs\\x.ts')
  })
})
