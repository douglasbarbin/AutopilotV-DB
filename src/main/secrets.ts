import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { log } from './log'

/**
 * Persistent secrets store, encrypted at rest with Electron safeStorage
 * (OS-keychain-backed: Keychain on macOS, DPAPI on Windows, libsecret on
 * Linux). The whole map is encrypted as one blob and written to the app data
 * dir; values never touch disk in plaintext.
 *
 * When the OS provides no encryption backend (e.g. a Linux session without a
 * keyring), the store degrades to in-memory only — secrets work for the
 * session but don't persist, and a warning is logged once. That beats writing
 * plaintext to disk.
 *
 * Used for operator-entered tokens and for the runbook secrets cache (e.g.
 * 1Password-materialized config files), which can hold real credentials.
 */

let cache: Map<string, string> | null = null
let persistable: boolean | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'secrets.bin')
}

function canPersist(): boolean {
  if (persistable !== null) return persistable
  try {
    persistable = safeStorage.isEncryptionAvailable()
  } catch {
    persistable = false
  }
  if (!persistable) {
    log.warn('OS encryption unavailable — secrets will not persist across restarts')
  }
  return persistable
}

function load(): Map<string, string> {
  if (cache) return cache
  cache = new Map()
  if (canPersist() && existsSync(storePath())) {
    try {
      const decrypted = safeStorage.decryptString(readFileSync(storePath()))
      for (const [k, v] of Object.entries(JSON.parse(decrypted) as Record<string, string>)) {
        cache.set(k, v)
      }
    } catch (err) {
      // Corrupt or written by a different OS user/keychain — start fresh
      // rather than failing every secrets call forever.
      log.warn('secrets store unreadable; starting empty', { err: String(err) })
    }
  }
  return cache
}

function persist(): void {
  if (!canPersist()) return
  const obj: Record<string, string> = {}
  for (const [k, v] of load()) obj[k] = v
  const blob = safeStorage.encryptString(JSON.stringify(obj))
  mkdirSync(dirname(storePath()), { recursive: true })
  writeFileSync(storePath(), blob)
}

export async function setSecret(key: string, value: string): Promise<void> {
  load().set(key, value)
  persist()
}

export async function getSecret(key: string): Promise<string | null> {
  return load().get(key) ?? null
}

export async function deleteSecret(key: string): Promise<void> {
  if (load().delete(key)) persist()
}

/** Keys starting with the prefix — used to invalidate a repo's cached secrets. */
export async function listSecretKeys(prefix: string): Promise<string[]> {
  return [...load().keys()].filter((k) => k.startsWith(prefix))
}

/** Test hook: reset module state. */
export function __resetSecretsForTesting(): void {
  cache = null
  persistable = null
}
