/**
 * The interactive terminal: xterm.js over a WebSocket to the host pty.
 * The host replays the session's transcript on connect, then streams live
 * output; input frames are raw text, resize frames are JSON with
 * type:"resize". Transient disconnects (page refresh, host restart) reconnect
 * automatically; a server-side refusal (close code 1011 with a reason, e.g.
 * a failed pty spawn) stops the loop and shows the reason with a manual
 * retry, and repeated unreasoned failures surface the close code after three
 * attempts, so the banner never spins forever.
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import 'xterm/css/xterm.css'
import { t } from './locales.ts'
import type { SessionScope } from './api.ts'
import { sidebarStore } from './state.ts'
import { isDarkScheme, subscribeColorScheme, tokenValue } from './theme.ts'
import css from './sidebar.module.css'

/** How many consecutive unreasoned failures before showing the error banner. */
const FAILURE_LIMIT = 3

/**
 * Curated ANSI palettes for the terminal. The surface colors (background,
 * foreground, cursor, selection) ride the theme tokens so the terminal
 * blends with the panel in both schemes; the 16 ANSI colors are the same
 * designed palettes the app's code surfaces use (one-dark family for dark,
 * one-light family for light), read live so a scheme flip re-themes in
 * place.
 */
const ANSI_DARK: Record<string, string> = {
  black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
  blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
  brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
  brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd',
  brightCyan: '#56b6c2', brightWhite: '#ffffff',
}

const ANSI_LIGHT: Record<string, string> = {
  black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401',
  blue: '#0184bc', magenta: '#a626a4', cyan: '#0997b3', white: '#a0a1a7',
  brightBlack: '#4f525e', brightRed: '#e45649', brightGreen: '#50a14f',
  brightYellow: '#c18401', brightBlue: '#0184bc', brightMagenta: '#a626a4',
  brightCyan: '#0997b3', brightWhite: '#fafafa',
}

/** The xterm theme for the current scheme (surface from tokens, ANSI curated). */
function xtermTheme(): ITheme {
  const dark = isDarkScheme()
  const background = tokenValue('--dsw-alias-bg-base') || (dark ? '#111114' : '#ffffff')
  const foreground = tokenValue('--dsw-alias-label-primary') || (dark ? '#e6e6e6' : '#1a1a1a')
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.12)',
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  }
}

export function TerminalView(props: { scope: SessionScope; tabId: string }) {
  const { scope, tabId } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const [connected, setConnected] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)
  const [lastUrl, setLastUrl] = useState<string | null>(null)
  const connectRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: tokenValue('--ds-font-family-code') || '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      allowTransparency: true,
      convertEol: false,
      scrollback: 4000,
      theme: xtermTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    // Re-theme in place when the app's scheme flips (tokens + palette).
    const applyTheme = (): void => {
      term.options.theme = xtermTheme()
      term.refresh(0, term.rows - 1)
    }
    const schemeSub = subscribeColorScheme(applyTheme)

    let socket: WebSocket | null = null
    let closed = false
    let retry: number | undefined
    let failures = 0

    const wsUrl = (): string => {
      const params = new URLSearchParams({ sessionId: scope.sessionId, tab: tabId })
      if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
      // Same construction the app's own downlink WebSockets use (new URL
      // over location.origin + protocol swap): whatever the environment
      // does to the app's websockets applies identically here.
      const url = new URL('/sidebar/ws/terminal', location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.search = params.toString()
      return url.toString()
    }

    const sendResize = (): void => {
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    const connect = (): void => {
      if (closed) return
      const url = wsUrl()
      setLastUrl(url)
      socket = new WebSocket(url)
      socket.onopen = () => {
        failures = 0
        setConnected(true)
        setFatal(null)
        sendResize()
      }
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') term.write(event.data)
      }
      socket.onclose = (event) => {
        setConnected(false)
        // A server-side refusal carries a close code + reason; retrying it
        // forever would only spin the banner, so surface it with a retry.
        if (event.code === 1011 && event.reason !== '') {
          setFatal(event.reason)
          return
        }
        // Unreasoned drops (upgrade rejected, host down, mid-handshake
        // refusal) normally recover on the next attempt; after a few
        // consecutive failures stop spinning and show the close code.
        failures += 1
        if (failures >= FAILURE_LIMIT) {
          const detail = event.reason !== '' ? ` (${event.code}: ${event.reason})` : ` (${event.code})`
          console.error('[dsh-better-sidebar] terminal connection failed:', event.code, event.reason, url)
          setFatal(`${t('terminalConnectFailed')}${detail}`)
          return
        }
        if (!closed) retry = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => {
        socket?.close()
      }
    }
    connectRef.current = connect

    const inputSub = term.onData((data) => {
      if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(data)
    })
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
        sendResize()
      } catch {
        // The terminal may be mid-dispose; ignore.
      }
    })
    observer.observe(host)

    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      observer.disconnect()
      schemeSub()
      inputSub.dispose()
      // The close frame tells the host the owning tab is GONE (immediate
      // quota release). A bare unmount — conversation switch, re-render,
      // page unload — leaves the tab open, so the socket drop alone hands
      // the process to the host's reconnect grace: switching back or
      // refreshing reattaches the SAME shell instead of respawning one.
      // (The host respawns on its own when the authoritative cwd changed.)
      if (!sidebarStore.tabOpen(scope.sessionId, tabId)
        && socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'close' }))
      }
      socket?.close()
      term.dispose()
      connectRef.current = null
    }
  }, [scope.sessionId, scope.cwd, tabId])

  return (
    <div className={css.terminalWrap}>
      {fatal !== null && (
        <div className={css.terminalBanner}>
          {t('terminalError')}: {fatal}
          {lastUrl !== null && <div className={css.terminalBannerUrl}>{lastUrl}</div>}
          <button
            type="button"
            className={css.terminalRetry}
            onClick={() => { setFatal(null); connectRef.current?.() }}
          >
            {t('terminalRetry')}
          </button>
        </div>
      )}
      {fatal === null && !connected && <div className={css.terminalBanner}>{t('disconnected')}</div>}
      <div ref={hostRef} className={css.terminal} />
    </div>
  )
}
