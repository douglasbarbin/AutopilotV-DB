import { log } from '../log'

/**
 * Shared HTTP helpers for REST-based forge adapters (Azure DevOps, future
 * GitLab, etc.). GitHub uses the `gh` CLI so it doesn't go through here, but
 * anything that hits a REST endpoint should share the timeout/cancel semantics
 * and the error-message shape.
 *
 *   apiFetch     — JSON body, returns parsed body or throws on non-2xx
 *   apiFetchRaw  — same but returns the Response, for streaming/binary/diff
 *   base64Pat    — common helper for PAT-based Basic auth
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 200)}`)
    this.name = 'HttpError'
  }
}

export interface ApiFetchOptions {
  method: HttpMethod
  url: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 20_000

/**
 * JSON fetch with AbortController-driven timeout. Resolves with the parsed
 * body (or `null` for 204). Throws HttpError on non-2xx, NetworkError on
 * connection/abort failure.
 */
export async function apiFetch<T = unknown>(opts: ApiFetchOptions): Promise<T | null> {
  const { method, url, headers, body, timeoutMs = DEFAULT_TIMEOUT_MS } = opts
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(['POST', 'PUT', 'PATCH'].includes(method) ? { 'Content-Type': 'application/json' } : {}),
        ...(headers ?? {})
      },
      signal: ac.signal,
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new HttpError(resp.status, url, text)
    }
    if (resp.status === 204) return null
    return (await resp.json()) as T
  } catch (err) {
    if (err instanceof HttpError) throw err
    // AbortError from timeout, or network failure — surface as a plain Error
    // with a recognizable shape; the adapter can choose to log/swallow.
    const msg = err instanceof Error ? err.message : String(err)
    log.warn('apiFetch failed', { method, url, err: msg })
    throw new Error(`${method} ${url} failed: ${msg}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Lower-level: returns the raw Response so callers can read text/stream/etc.
 * Still uses the same timeout and error model as apiFetch. Throws on non-2xx.
 */
export async function apiFetchRaw(opts: ApiFetchOptions): Promise<Response> {
  const { method, url, headers, body, timeoutMs = DEFAULT_TIMEOUT_MS } = opts
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        ...(['POST', 'PUT', 'PATCH'].includes(method) ? { 'Content-Type': 'application/json' } : {}),
        ...(headers ?? {})
      },
      signal: ac.signal,
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new HttpError(resp.status, url, text)
    }
    return resp
  } finally {
    clearTimeout(timer)
  }
}

/** HTTP Basic with an empty username and a PAT as the password (Azure DevOps). */
export function basicAuthHeader(pat: string): string {
  return 'Basic ' + Buffer.from(':' + pat).toString('base64')
}
