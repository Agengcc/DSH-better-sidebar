/**
 * The interactive terminal: xterm.js over a WebSocket to the host pty.
 * The host replays the session's transcript on connect, then streams live
 * output; input frames are raw text, resize frames are JSON with
 * type:"resize". Disconnects (page refresh, host restart) reconnect with a
 * delay — the pty process survives the socket.
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import 'xterm/css/xterm.css'
import { t } from './locales.ts'
import css from './sidebar.module.css'

export function TerminalView(props: { sessionId: string; tabId: string }) {
  const { sessionId, tabId } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      allowTransparency: true,
      convertEol: false,
      scrollback: 4000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    let socket: WebSocket | null = null
    let closed = false
    let retry: number | undefined

    const wsUrl = (): string => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const params = new URLSearchParams({ sessionId, tab: tabId })
      return `${proto}//${location.host}/sidebar/ws/terminal?${params.toString()}`
    }

    const sendResize = (): void => {
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    const connect = (): void => {
      if (closed) return
      socket = new WebSocket(wsUrl())
      socket.onopen = () => {
        setConnected(true)
        sendResize()
      }
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') term.write(event.data)
      }
      socket.onclose = () => {
        setConnected(false)
        if (!closed) retry = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => {
        socket?.close()
      }
    }

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
      inputSub.dispose()
      socket?.close()
      term.dispose()
    }
  }, [sessionId, tabId])

  return (
    <div className={css.terminalWrap}>
      {!connected && <div className={css.terminalBanner}>{t('disconnected')}</div>}
      <div ref={hostRef} className={css.terminal} />
    </div>
  )
}
