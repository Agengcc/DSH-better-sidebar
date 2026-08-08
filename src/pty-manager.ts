/**
 * PTY session table for the sidebar terminals. One node-pty process per
 * `${sessionId}:${tabId}` key; processes survive WebSocket disconnects
 * (page refresh, tab switch) and reconnect to the same process by key.
 * Output is mirrored into a bounded transcript ring (capped bytes) so a new
 * connection replays history before live data. Sessions die only when the
 * tab is closed or the plugin tears down.
 */
import { chmodSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import * as nodePty from 'node-pty'
import { SidebarError } from './wire.ts'

/** Per-terminal transcript bound (bytes kept for replay). */
const TRANSCRIPT_LIMIT = 1 << 20

/**
 * Restore the executable bit pnpm strips from node-pty's prebuilt
 * spawn-helper (the macOS helper that forks and sets up the pty). Without it
 * every spawn fails with `posix_spawnp failed`. Idempotent; mirrors
 * @deepseek-ai/dsh-pty-local's ensure-spawn-helper postinstall, run at
 * plugin activation so link-installed deployments get the fix too.
 */
export function ensureSpawnHelper(): void {
  if (process.platform === 'win32') return
  try {
    const require = createRequire(import.meta.url)
    const entry = require.resolve('node-pty')
    const packageRoot = dirname(dirname(entry))
    const candidates = [
      join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      join(packageRoot, 'build', 'Release', 'spawn-helper'),
    ]
    for (const helper of candidates) {
      if (existsSync(helper)) chmodSync(helper, 0o755)
    }
  } catch {
    // Resolution or chmod failure: the terminal surfaces its own spawn error.
  }
}

/** One live terminal. */
export interface SidebarPty {
  /** `${sessionId}:${tabId}` registry key. */
  key: string
  sessionId: string
  tabId: string
  pty: nodePty.IPty
  /** Output accumulated since spawn (bounded; head dropped when over the limit). */
  transcript: string
  /** Whether the top-level process exited (transcript stays replayable). */
  exited: boolean
  exitCode?: number | null
}

/**
 * The terminal registry. `maxPerSession` bounds concurrent processes per
 * conversation (the client caps tabs at the same number).
 */
export class PtyManager {
  private readonly sessions = new Map<string, SidebarPty>()

  constructor(
    private readonly shell: string,
    private readonly maxPerSession: number,
  ) {}

  /** All live terminal keys of one session. */
  keysOf(sessionId: string): string[] {
    const keys: string[] = []
    for (const handle of this.sessions.values()) {
      if (handle.sessionId === sessionId) keys.push(handle.key)
    }
    return keys
  }

  /**
   * Open (or reuse) the terminal for a session/tab key.
   * @param sessionId - conversation id.
   * @param tabId - client tab id.
   * @param cwd - initial working directory (the session's cwd).
   * @param cols - initial terminal width.
   * @param rows - initial terminal height.
   * @returns the live handle.
   * @throws {SidebarError} pty-error when the per-session cap is reached.
   */
  open(sessionId: string, tabId: string, cwd: string, cols: number, rows: number): SidebarPty {
    const key = `${sessionId}:${tabId}`
    const existing = this.sessions.get(key)
    if (existing !== undefined) return existing
    if (this.keysOf(sessionId).length >= this.maxPerSession) {
      throw new SidebarError('pty-error', `terminal limit reached (${this.maxPerSession}) for this session`, 400)
    }
    const handle: SidebarPty = {
      key,
      sessionId,
      tabId,
      pty: nodePty.spawn(this.shell, [], {
        name: 'xterm-256color',
        cols: Math.max(2, Math.floor(cols)),
        rows: Math.max(2, Math.floor(rows)),
        cwd,
        env: { ...process.env },
      }),
      transcript: '',
      exited: false,
    }
    handle.pty.onData((data) => {
      handle.transcript += data
      if (handle.transcript.length > TRANSCRIPT_LIMIT) {
        handle.transcript = handle.transcript.slice(handle.transcript.length - TRANSCRIPT_LIMIT)
      }
    })
    handle.pty.onExit(({ exitCode }) => {
      handle.exited = true
      handle.exitCode = exitCode
    })
    this.sessions.set(key, handle)
    return handle
  }

  /** Resolve a live handle by key, or undefined. */
  get(key: string): SidebarPty | undefined {
    return this.sessions.get(key)
  }

  /** Close a terminal and drop its state (the owning tab was closed). */
  close(key: string): void {
    const handle = this.sessions.get(key)
    if (handle === undefined) return
    this.sessions.delete(key)
    try {
      handle.pty.kill()
    } catch {
      // Already exited or gone; nothing left to kill.
    }
  }

  /** Close every terminal (plugin teardown). */
  disposeAll(): void {
    for (const key of [...this.sessions.keys()]) this.close(key)
  }
}

/** The interactive shell for this platform (empty SHELL falls back). */
export function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  const shell = process.env.SHELL
  return shell !== undefined && shell.trim() !== '' ? shell : '/bin/bash'
}
