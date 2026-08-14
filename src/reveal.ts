/**
 * Reveal a file or directory in the OS file manager ("在访达中显示").
 *
 * The sidebar client cannot open the system file manager on its own — a web
 * page has no such capability — so the host half owns this action: it builds
 * the platform-appropriate command and runs it locally on the machine that
 * serves dsh web. The command is picked by a pure function so every platform
 * branch is unit-testable, and executed with `execFile` (no shell) so the
 * caller-supplied path can never reach a shell interpreter.
 *
 * Semantics: revealing a FILE selects it inside its containing folder (so the
 * user can immediately drag it out to send to someone); revealing a
 * DIRECTORY selects the folder itself in its parent.
 */
import { execFile } from 'node:child_process'
import { dirname, isAbsolute } from 'node:path'
import { SidebarError } from './wire.ts'

/** The OS command that reveals `path` (file or directory) in the file manager. */
export interface RevealCommand {
  cmd: string
  args: string[]
}

/**
 * The reveal command for one platform, or null when the platform has no
 * supported file manager. Pure: injectable platform for unit tests.
 *
 * - darwin: `open -R <path>` — reveals the item in Finder (files and
 *   directories alike).
 * - win32: `explorer /select,<path>` — selects the item in Explorer.
 * - linux: `xdg-open <dir>` — opens the containing folder in the default
 *   file manager (`xdg-open` on a file would open the file's application,
 *   not the folder, so directories open themselves and files open their
 *   parent).
 */
export function revealCommandFor(
  platform: NodeJS.Platform,
  path: string,
  isDir: boolean,
): RevealCommand | null {
  switch (platform) {
    case 'darwin':
      return { cmd: 'open', args: ['-R', path] }
    case 'win32':
      return { cmd: 'explorer', args: [`/select,${path}`] }
    case 'linux':
      return { cmd: 'xdg-open', args: [isDir ? path : dirname(path)] }
    default:
      return null
  }
}

/** How long the reveal command may take before it is killed. */
const REVEAL_TIMEOUT_MS = 15_000

/**
 * Reveal `path` in the OS file manager. Throws {@link SidebarError} when the
 * platform has no file manager or the command fails. The caller is
 * responsible for confining the path to the session workspace first.
 */
export async function revealInFileManager(path: string, isDir: boolean): Promise<void> {
  if (!isAbsolute(path)) {
    throw new SidebarError('reveal-error', `"${path}" is not an absolute path`, 400)
  }
  const command = revealCommandFor(process.platform, path, isDir)
  if (command === null) {
    throw new SidebarError('reveal-error', `no file manager for platform "${process.platform}"`, 501)
  }
  await new Promise<void>((resolve, reject) => {
    execFile(
      command.cmd,
      command.args,
      { timeout: REVEAL_TIMEOUT_MS },
      (error) => {
        if (error === null) {
          resolve()
          return
        }
        const detail = 'message' in error && typeof error.message === 'string'
          ? error.message
          : String(error)
        reject(new SidebarError('reveal-error', `cannot open file manager: ${detail}`, 500))
      },
    )
  })
}
