import { newKey } from './crypt.ts';

export const KEY_NAME = 'terminalThreads.historyKey';

export interface Secrets {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
}

// One 256-bit key per user in VS Code's secret storage (the OS keychain). Null if it can't be read
// or created; history then isn't saved this session. `created` tells the caller a new key was made.
// On Linux without an OS keyring VS Code's secret storage never answers; give up after a while so
// the view still starts (history just isn't saved that session).
const TIMEOUT_MS = 10_000;

export async function historyKey(secrets: Secrets, timeoutMs = TIMEOUT_MS): Promise<{ key: Buffer; created: boolean } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    return await Promise.race([lookup(secrets), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function lookup(secrets: Secrets): Promise<{ key: Buffer; created: boolean } | null> {
  try {
    let stored = await secrets.get(KEY_NAME);
    let created = false;
    if (!stored) {
      stored = newKey().toString('base64');
      await secrets.store(KEY_NAME, stored);
      if ((await secrets.get(KEY_NAME)) !== stored) return null;
      created = true;
    }
    const key = Buffer.from(stored, 'base64');
    return key.length === 32 ? { key, created } : null;
  } catch (e) {
    console.warn('terminal-threads: secret storage unavailable', e);
    return null;
  }
}
