import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '../api'
import { getTerminalTheme } from '../terminalThemes'

/**
 * Live xterm.js view bound to a session's PTY stream.
 *
 * The terminal is configured for full 24-bit truecolor and 256-color output.
 * The PTY is spawned with TERM=xterm-256color and COLORTERM=truecolor so tools
 * like bat, delta, lazygit, rich, and any tool that queries COLORTERM will
 * render full color output without extra configuration.
 *
 * The color palette tracks the active app theme: switching themes in Settings
 * re-skins the terminal in real time without disrupting the session.
 */
export function TerminalView({ sessionId, theme }: { sessionId: number; theme: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  // Create/destroy the terminal instance when the session changes.
  useEffect(() => {
    if (!ref.current) return
    const term = new Terminal({
      fontFamily: 'Menlo, monospace',
      fontSize: 12,
      theme: getTerminalTheme(theme),
      cursorBlink: true,
      scrollback: 5000
      // Full 24-bit truecolor is rendered natively by xterm.js — no extra
      // option needed. The PTY is spawned with TERM=xterm-256color and
      // COLORTERM=truecolor so shell tools report accurate capabilities.
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current)
    try {
      fit.fit()
    } catch {
      /* not yet laid out */
    }

    // forward keystrokes to the PTY
    const dataDisp = term.onData((d) => void api.sendInput(sessionId, d))

    // Replay the captured buffer so the terminal shows the CURRENT state, then
    // apply only newer live chunks. Chunks arriving before replay completes are
    // queued so ordering is preserved and nothing is written twice.
    let disposed = false
    let ready = false
    let lastSeq = -1
    const pending: { seq: number; data: string }[] = []

    void api.getSessionBuffer(sessionId).then(({ data, seq }) => {
      if (disposed) return
      if (data) term.write(data)
      lastSeq = seq
      ready = true
      for (const c of pending) {
        if (c.seq > lastSeq) {
          term.write(c.data)
          lastSeq = c.seq
        }
      }
      pending.length = 0
    })

    // receive PTY output (only chunks for this session)
    const offOutput = api.onSessionOutput((chunk) => {
      if (chunk.sessionId !== sessionId) return
      if (!ready) {
        pending.push(chunk)
        return
      }
      if (chunk.seq > lastSeq) {
        term.write(chunk.data)
        lastSeq = chunk.seq
      }
    })

    const onResize = () => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('resize', onResize)

    return () => {
      disposed = true
      window.removeEventListener('resize', onResize)
      dataDisp.dispose()
      offOutput()
      termRef.current = null
      term.dispose()
    }
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-skin the live terminal whenever the app theme changes — no remount needed.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = getTerminalTheme(theme)
    }
  }, [theme])

  return <div className="terminal" ref={ref} />
}
