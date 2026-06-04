// Simple in-memory fallback implementation for secrets storage.
// This avoids type errors and provides basic functionality.

const memoryFallback = new Map<string, string>()

export async function setSecret(key: string, value: string): Promise<void> {
  memoryFallback.set(key, value)
}

export async function getSecret(key: string): Promise<string | null> {
  return memoryFallback.get(key) ?? null
}