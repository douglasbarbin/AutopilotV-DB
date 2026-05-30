import { app } from 'electron'
import { createWriteStream, mkdirSync, type WriteStream } from 'fs'
import { join } from 'path'

type Level = 'debug' | 'info' | 'warn' | 'error'

const SECRET_PATTERNS = [
  /gh[ps]_[A-Za-z0-9]{20,}/g,
  /(?:token|secret|key|password)["'\s:=]+([A-Za-z0-9._-]{12,})/gi
]

function scrub(input: string): string {
  let out = input
  for (const re of SECRET_PATTERNS) out = out.replace(re, '«redacted»')
  return out
}

class Logger {
  private stream: WriteStream | null = null

  private ensure(): WriteStream {
    if (this.stream) return this.stream
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    this.stream = createWriteStream(join(dir, 'autopilotv.log'), { flags: 'a' })
    return this.stream
  }

  private write(level: Level, msg: string, meta?: unknown) {
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${scrub(msg)}${
      meta ? ' ' + scrub(safeJson(meta)) : ''
    }\n`
    try {
      this.ensure().write(line)
    } catch {
      /* logging must never throw */
    }
    if (level === 'error' || level === 'warn') process.stderr.write(line)
    else process.stdout.write(line)
  }

  debug(msg: string, meta?: unknown) {
    this.write('debug', msg, meta)
  }
  info(msg: string, meta?: unknown) {
    this.write('info', msg, meta)
  }
  warn(msg: string, meta?: unknown) {
    this.write('warn', msg, meta)
  }
  error(msg: string, meta?: unknown) {
    this.write('error', msg, meta)
  }
}

function safeJson(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const log = new Logger()
export { scrub }
