/**
 * Tests for the reveal-in-file-manager command builder: each platform maps to
 * the right command, files and directories are handled differently where the
 * platform requires it, and unsupported platforms are refused.
 */
import { describe, expect, it } from 'vitest'
import { revealCommandFor } from '../src/reveal.ts'

describe('revealCommandFor', () => {
  it('darwin reveals files and directories with `open -R`', () => {
    expect(revealCommandFor('darwin', '/Users/me/work/报告.docx', false))
      .toEqual({ cmd: 'open', args: ['-R', '/Users/me/work/报告.docx'] })
    expect(revealCommandFor('darwin', '/Users/me/work/华能', true))
      .toEqual({ cmd: 'open', args: ['-R', '/Users/me/work/华能'] })
  })

  it('win32 selects files and directories with `explorer /select,`', () => {
    expect(revealCommandFor('win32', 'C:\\Users\\me\\report.xlsx', false))
      .toEqual({ cmd: 'explorer', args: ['/select,C:\\Users\\me\\report.xlsx'] })
    expect(revealCommandFor('win32', 'C:\\Users\\me\\folder', true))
      .toEqual({ cmd: 'explorer', args: ['/select,C:\\Users\\me\\folder'] })
  })

  it('linux opens the containing folder: directories themselves, files their parent', () => {
    expect(revealCommandFor('linux', '/home/me/work/folder', true))
      .toEqual({ cmd: 'xdg-open', args: ['/home/me/work/folder'] })
    expect(revealCommandFor('linux', '/home/me/work/notes.md', false))
      .toEqual({ cmd: 'xdg-open', args: ['/home/me/work'] })
  })

  it('refuses platforms without a file manager', () => {
    expect(revealCommandFor('freebsd' as NodeJS.Platform, '/x', false)).toBeNull()
    expect(revealCommandFor('aix' as NodeJS.Platform, '/x', true)).toBeNull()
  })
})
