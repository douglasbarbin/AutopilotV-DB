import { log } from './log'

const SERVICE = 'com.justinwoodring.autopilotv'

// keytar is a native module; import lazily so unit tests / non-keychain envs
// don't hard-require it.
async function keytar(): Promise<typeof import('keytar') | null> {
  try {
    return await import('keytar')
  } catch (err) {
    log.warn('keytar unavailable; secrets will not persist', { err: String(err) })
    return null
  }
}

const memoryFallback = new Map<string, string>()

export async function setSecret(key: string, value: string): Promise<void> {
  const kt = await keytar()
  if (kt) await kt.setPassword(SERVICE, key, value)
  else memoryFallback.set(key, value)
}

export async function getSecret(key: string): Promise<string | null> {
  const kt = await keytar()
  if (kt) return kt.getPassword(SERVICE, key)
  return memoryFallback.get(key) ?? null
}
