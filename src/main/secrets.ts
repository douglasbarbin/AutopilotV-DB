import { safeStorage } from 'electron'
import { log } from './log'

// Electron safeStorage uses the OS keychain natively:
//   macOS → Keychain, Windows → Credential Locker, Linux → libsecret.
// No native rebuild required — it ships with Electron.
// We wrap it so environments without a secure backend (some Linux CI runners)
// degrade gracefully to an in-memory map.

const memoryFallback = new Map<string, string>()
let secureAvailable: boolean | null = null

async function isSecureAvailable(): Promise<boolean> {
  if (secureAvailable !== null) return secureAvailable
  try {
    secureAvailable = await safeStorage.isSecureStorageAvailable()
  } catch {
    secureAvailable = false
  }
  if (!secureAvailable) {
    log.warn('secure storage unavailable; secrets will use in-memory fallback')
  }
  return secureAvailable
}

export async function setSecret(key: string, value: string): Promise<void> {
  if (await isSecureAvailable()) {
    await safeStorage.writeString(key, value)
  } else {
    memoryFallback.set(key, value)
  }
}

export async function getSecret(key: string): Promise<string | null> {
  if (await isSecureAvailable()) {
    try {
      return await safeStorage.readString(key)
    } catch {
      // Key doesn't exist or was cleared by the OS
      return null
    }
  }
  return memoryFallback.get(key) ?? null
}
