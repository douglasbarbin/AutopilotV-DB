import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '../api'

/** Live xterm.js view bound to a session's PTY stream. */
export function TerminalView({ sessionId }: { sessionId: number }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current) return
    const term = new Terminal({
      fontFamily: 'Menlo, monospace',
      fontSize: 12,
      theme: { background: '#0d1117', foreground: '#c9d1d9' },
      cursorBlink: true,
      scrollback: 5000
    })
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
      term.dispose()
    }
  }, [sessionId])

  return <div className="terminal" ref={ref} />
}
