import { useEffect, useState } from 'react'
import { api } from '../api'

interface DiffViewProps {
  worktreeId?: number
  prNumber?: number
  repoId?: number
}

interface DiffFile {
  filename: string
  lines: { type: 'normal' | 'add' | 'del' | 'meta'; text: string }[]
}

export function DiffView({ worktreeId, prNumber, repoId }: DiffViewProps) {
  const [diffText, setDiffText] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  const loadDiff = () => {
    setLoading(true)
    setError(null)
    api.getDiff({ worktreeId, prNumber, repoId })
      .then((txt) => {
        setDiffText(txt || 'No changes.')
        setLoading(false)
      })
      .catch((err) => {
        setError(String(err))
        setLoading(false)
      })
  }

  useEffect(() => {
    loadDiff()
  }, [worktreeId, prNumber, repoId])

  if (loading) {
    return <div className="diff-loading">Loading diff...</div>
  }

  if (error) {
    return <div className="diff-error">Error loading diff: {error}</div>
  }

  // Parse diff text into files
  const files: DiffFile[] = []
  let currentFile: DiffFile | null = null

  const lines = diffText.split('\n')
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (currentFile) files.push(currentFile)
      // Extract filename
      // Format: diff --git a/filename b/filename
      const match = line.match(/b\/(.+)$/)
      const filename = match ? match[1] : 'Unknown File'
      currentFile = { filename, lines: [] }
    } else if (currentFile) {
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')) {
        continue // skip metadata lines to keep it clean
      }
      let type: 'normal' | 'add' | 'del' | 'meta' = 'normal'
      if (line.startsWith('+')) type = 'add'
      else if (line.startsWith('-')) type = 'del'
      else if (line.startsWith('@@')) type = 'meta'

      currentFile.lines.push({ type, text: line })
    }
  }
  if (currentFile) files.push(currentFile)

  if (
    files.length === 0 ||
    (files.length === 1 && files[0].lines.length === 0 && (diffText.includes('No changes') || diffText.trim() === ''))
  ) {
    return (
      <div className="diff-empty">
        <p>No changes detected.</p>
        <button className="btn-soft" onClick={loadDiff}>Refresh</button>
      </div>
    )
  }

  return (
    <div className="diff-container">
      <div className="diff-header">
        <h4>Modified Files ({files.length})</h4>
        <button className="btn-soft" onClick={loadDiff}>Refresh</button>
      </div>
      <div className="diff-files">
        {files.map((file, idx) => (
          <div key={idx} className="diff-file-card">
            <div className="diff-file-name">📁 {file.filename}</div>
            <div className="diff-file-lines">
              {file.lines.map((ln, lIdx) => (
                <div key={lIdx} className={`diff-line ${ln.type}`}>
                  <span className="diff-line-content">{ln.text}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
