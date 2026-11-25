import { newKey } from './crypt.ts';

export const KEY_NAME = 'terminalThreads.historyKey';

export interface Secrets {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
}

// One 256-bit key per user in VS Code's secret storage (the OS keychain). Null if it can't be read
// or created; history then isn't saved this session. `created` tells the caller a new key was made.
export async function historyKey(secrets: Secrets): Promise<{ key: Buffer; created: boolean } | null> {
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
