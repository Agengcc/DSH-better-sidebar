/**
 * Shared "Side card" preference vocabulary (types + constants), consumed by
 * BOTH halves: the host registers the schemastery schema over these values
 * (config.ts) and the client reads/writes them through the settings RPC
 * (client/prefs.ts, client/SideCardSection.tsx). Kept free of schemastery so
 * the browser bundle never pulls the schema runtime in.
 */

/** The user-settings namespace holding the side card preferences. */
export const SIDEBAR_PREFS_NS = 'dsh-better-sidebar'

/** User-facing side card preferences (new-conversation defaults). */
export interface SidebarPrefs {
  /** Whether a brand-new conversation opens the side card by default. */
  openByDefault: boolean
  /** Default panel width as a percent of the window width (20–60). */
  defaultWidthPercent: number
  /**
   * Whether the sidebar auto-activates (opens the panel) and expands the
   * Subagent page when the current conversation spawns a new subagent.
   */
  autoOpenSubagent: boolean
  /**
   * Whether the model-facing agent terminal tools (terminal_create / list /
   * send / read / wait_for / resize / signal / close) are injected into the
   * model's toolset. Off by default: the feature stays dormant until the
   * user explicitly enables it in the side card settings.
   */
  agentTerminalTools: boolean
}

/** Range contract of {@link SidebarPrefs.defaultWidthPercent}. */
export const WIDTH_PERCENT_MIN = 20
export const WIDTH_PERCENT_MAX = 60
export const WIDTH_PERCENT_DEFAULT = 30

/** Fallback prefs used whenever the settings document is unreachable or malformed. */
export const SIDEBAR_PREFS_DEFAULTS: SidebarPrefs = {
  openByDefault: true,
  defaultWidthPercent: WIDTH_PERCENT_DEFAULT,
  autoOpenSubagent: true,
  agentTerminalTools: false,
}

/** Clamp one width percent into the contract range (shared by schema and client reads). */
export function clampWidthPercent(value: number): number {
  return Math.min(WIDTH_PERCENT_MAX, Math.max(WIDTH_PERCENT_MIN, Math.round(value)))
}
