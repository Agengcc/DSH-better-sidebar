import { describe, expect, it } from 'vitest'
import { compareEntries, isWithin, parentOf, requireAbsolute, rootLabel } from '../src/fs-tree.ts'

describe('fs-tree', () => {
  it('sorts directories first, then names case-insensitively', () => {
    const rows = [
      { name: 'b.txt', path: '/x/b.txt', isDir: false, hidden: false },
      { name: 'A', path: '/x/A', isDir: true, hidden: false },
      { name: 'a.txt', path: '/x/a.txt', isDir: false, hidden: false },
      { name: '.hidden', path: '/x/.hidden', isDir: false, hidden: true },
    ]
    expect(rows.sort(compareEntries).map(row => row.name)).toEqual(['A', '.hidden', 'a.txt', 'b.txt'])
  })

  it('derives root labels and parents', () => {
    // POSIX-style inputs behave identically on both platforms (win32 parses '/'
    // as a separator), so these assertions are platform-independent.
    expect(rootLabel('/Users/me/code')).toBe('code')
    expect(rootLabel('/')).toBe('/')
    expect(parentOf('/Users/me/code')).toBe('/Users/me')
    expect(parentOf('/')).toBeUndefined()
    // Windows-drive roots and segments, asserted only where win32 semantics apply.
    if (process.platform === 'win32') {
      expect(rootLabel('C:\\')).toBe('C:\\')
      expect(parentOf('C:\\')).toBeUndefined()
      expect(rootLabel('C:\\Users\\me')).toBe('me')
      expect(parentOf('C:\\Users\\me')).toBe('C:\\Users')
    }
  })

  it('accepts absolute paths and rejects relative ones', () => {
    // resolve() is platform-native: '/a/b' roots to the current drive on win32.
    expect(requireAbsolute('/a/b')).toBe(process.platform === 'win32' ? '\\a\\b' : '/a/b')
    if (process.platform === 'win32') {
      expect(requireAbsolute('C:/proj')).toBe('C:\\proj')
    }
    expect(() => requireAbsolute('a/b')).toThrow(/not an absolute path/)
    expect(() => requireAbsolute('../a')).toThrow(/not an absolute path/)
  })

  it('isWithin tolerates separators and (on win32) letter case', () => {
    expect(isWithin('/work/proj', '/work/proj/src/a.ts')).toBe(true)
    expect(isWithin('/work/proj', '/work/proj')).toBe(true)
    expect(isWithin('/work/proj', '/work/proj2/a.ts')).toBe(false)
    expect(isWithin('/work/proj', '/other/a.ts')).toBe(false)
    // Mixed separators normalize on every platform.
    expect(isWithin('C:\\Users\\me', 'C:/Users/me/src/a.ts')).toBe(true)
    // Case sensitivity follows the platform's filesystem semantics (the
    // platform parameter makes both branches assertable on any host).
    expect(isWithin('C:\\Users\\Me', 'c:/users/me/file.png', 'win32')).toBe(true)
    expect(isWithin('/Users/Me', '/users/me/file.png', 'win32')).toBe(true)
    expect(isWithin('/Users/Me', '/users/me/file.png', 'linux')).toBe(false)
    expect(isWithin('/Users/Me', '/users/me/file.png', 'darwin')).toBe(false)
    // Windows drive-root containment.
    expect(isWithin('C:\\', 'C:\\Users\\me\\a.png', 'win32')).toBe(true)
    expect(isWithin('c:\\users', 'C:/USERS/me/b.png', 'win32')).toBe(true)
  })
})
