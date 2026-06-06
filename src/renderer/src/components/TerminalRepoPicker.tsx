import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppState } from '@shared/types/domain'
import { api } from '../api'
import { Icon } from './Icon'

export function TerminalRepoPicker({
  state,
  onClose
}: {
  state: AppState
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const repos = useMemo(
    () => state.repos.filter((r) => r.path).sort((a, b) => a.name.localeCompare(b.name)),
    [state.repos]
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return repos
    return repos.filter(
      (r) => r.name.toLowerCase().includes(q) || (r.path ?? '').toLowerCase().includes(q)
    )
  }, [repos, query])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setActiveIdx(0)
  }, [query])

  useEffect(() => {
    const row = listRef.current?.children[activeIdx] as HTMLElement | undefined
    row?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  const open = (path: string) => {
    void api.openTerminalAtPath(path)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const pick = filtered[activeIdx]
      if (pick?.path) open(pick.path)
    }
  }

  return (
    <div className="onboard-overlay" onClick={onClose}>
      <div className="picker-card" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="picker-head">
          <div className="picker-title">
            <Icon name="terminal" size={16} />
            <span>Open terminal in repo</span>
          </div>
          <button className="picker-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="picker-search-wrap">
          <input
            ref={inputRef}
            className="picker-search"
            type="text"
            placeholder="Search repos…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {filtered.length === 0 ? (
          <div className="picker-empty">
            {repos.length === 0
              ? 'No repos tracked yet. Add one in Settings → Repos.'
              : 'No repos match your search.'}
          </div>
        ) : (
          <div className="picker-list" ref={listRef} role="listbox">
            {filtered.map((r, i) => (
              <button
                key={r.id}
                role="option"
                aria-selected={i === activeIdx}
                className={`picker-row ${i === activeIdx ? 'active' : ''}`}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => r.path && open(r.path)}
                disabled={!r.path}
              >
                <span className="picker-row-name">{r.name}</span>
                <span className="picker-row-path">{r.path}</span>
              </button>
            ))}
          </div>
        )}

        <div className="picker-foot">
          <span className="picker-hint">
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate · <kbd>↵</kbd> open · <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
