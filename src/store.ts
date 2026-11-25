import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SavedHistory } from './history.ts';
import { open, seal, type EncryptedFile } from './crypt.ts';

export interface ThreadMeta {
  id: string;
  customName: string | null;
  startDir: string;
  lastDir: string;
}

const SAFE_ID = /^[A-Za-z0-9-]+$/;
const ignoreMissing = (e: NodeJS.ErrnoException) => {
  if (e.code !== 'ENOENT') throw e;
};
let tmpCounter = 0;

const isString = (v: unknown): v is string => typeof v === 'string';
const isMeta = (v: unknown): v is ThreadMeta => {
  const m = v as ThreadMeta;
  return typeof v === 'object' && v !== null && isString(m.id) && (m.customName === null || isString(m.customName)) && isString(m.startDir) && isString(m.lastDir);
};
const isHistory = (v: unknown): v is SavedHistory => {
  const h = v as SavedHistory;
  return typeof v === 'object' && v !== null && isString(h.history) && (h.frame === null || (Array.isArray(h.frame) && h.frame.every(isString)))
    && (h.program === undefined || h.program === null || isString(h.program));
};

const isEncrypted = (v: unknown): v is EncryptedFile => {
  const f = v as EncryptedFile;
  return typeof v === 'object' && v !== null && f.v === 2 && isString(f.iv) && isString(f.tag) && isString(f.data);
};

export class ThreadStore {
  private readonly dir: string;
  // Null when secret storage is unavailable: nothing is saved and encrypted files are left alone.
  private key: Buffer | null;
  // Off (the user's choice): history is written as plain, owner-only JSON. Encrypted files are still
  // read while the key exists, and rewritten plain on their next save.
  private encrypt: boolean;

  constructor(dir: string, key: Buffer | null, encrypt = true) {
    this.dir = dir;
    this.key = key;
    this.encrypt = encrypt;
  }

  setEncrypt(on: boolean): void {
    this.encrypt = on;
  }

  // Another window may create the key first; later saves use the key that is actually stored.
  setKey(key: Buffer): void {
    this.key = key;
  }

  async loadIndex(): Promise<ThreadMeta[]> {
    const raw = await this.read(join(this.dir, 'index.json'), (v): v is { threads: unknown[] } =>
      typeof v === 'object' && v !== null && Array.isArray((v as { threads: unknown }).threads));
    if (!raw) return [];
    return raw.threads.filter((t): t is ThreadMeta => {
      if (isMeta(t) && SAFE_ID.test(t.id)) return true;
      console.warn('terminal-threads: skipping invalid thread entry', t);
      return false;
    });
  }

  saveIndex(threads: ThreadMeta[]): Promise<void> {
    return this.writeAtomic(join(this.dir, 'index.json'), JSON.stringify({ version: 1, threads }));
  }

  async loadHistory(id: string): Promise<SavedHistory | null> {
    const file = this.historyPath(id);
    const raw = await this.read(file, (v): v is EncryptedFile | SavedHistory => isEncrypted(v) || isHistory(v));
    if (!raw || !isEncrypted(raw)) return raw; // round-1 plain text: rewritten encrypted on the next save
    if (!this.key) return null;
    try {
      const h: unknown = JSON.parse(open(this.key, id, raw));
      if (isHistory(h)) return h;
    } catch {
      // another machine's key, or altered: quarantine below
    }
    await this.quarantine(file);
    return null;
  }

  async saveHistory(id: string, h: SavedHistory): Promise<void> {
    const file = this.historyPath(id);
    if (!this.encrypt) return this.writeAtomic(file, JSON.stringify(h));
    if (!this.key) throw new Error('terminal-threads: no history key, not saving');
    return this.writeAtomic(file, JSON.stringify(seal(this.key, id, JSON.stringify(h))));
  }

  // Round 1 wrote with the default umask; make existing folders and files owner-only.
  async secure(): Promise<void> {
    const threads = join(this.dir, 'threads');
    for (const [path, mode] of [[this.dir, 0o700], [threads, 0o700], [join(this.dir, 'index.json'), 0o600]] as const) {
      await chmod(path, mode).catch(ignoreMissing);
    }
    const files = await readdir(threads).catch((e) => (ignoreMissing(e), [] as string[]));
    for (const f of files) await chmod(join(threads, f), 0o600).catch(ignoreMissing);
  }

  // True if any thread file is encrypted; used to tell a lost key from a first run.
  async hasEncryptedHistory(): Promise<boolean> {
    const threads = join(this.dir, 'threads');
    const files = await readdir(threads).catch((e) => (ignoreMissing(e), [] as string[]));
    for (const f of files.filter((n) => n.endsWith('.json'))) {
      const text = await readFile(join(threads, f), 'utf8').catch(() => '');
      try {
        if (isEncrypted(JSON.parse(text))) return true;
      } catch {
        // unreadable files don't count
      }
    }
    return false;
  }

  async deleteAllHistory(): Promise<void> {
    const threads = join(this.dir, 'threads');
    const files = await readdir(threads).catch((e) => (ignoreMissing(e), [] as string[]));
    await Promise.all(files.map((f) => rm(join(threads, f), { force: true })));
  }

  async deleteHistory(id: string): Promise<void> {
    return rm(this.historyPath(id), { force: true });
  }

  private historyPath(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`terminal-threads: unsafe thread id ${JSON.stringify(id)}`);
    return join(this.dir, 'threads', `${id}.json`);
  }

  // Missing → null. Unparsable or wrong shape → moved aside (never overwritten) → null.
  private async read<T>(file: string, valid: (v: unknown) => v is T): Promise<T | null> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    try {
      const value: unknown = JSON.parse(text);
      if (valid(value)) return value;
    } catch {
      // fall through to quarantine
    }
    await this.quarantine(file);
    return null;
  }

  private async quarantine(file: string): Promise<void> {
    const aside = `${file}.corrupt-${Date.now()}`;
    await rename(file, aside);
    console.warn(`terminal-threads: moved unreadable ${file} to ${aside}`);
  }

  private async writeAtomic(file: string, data: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
    try {
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
}
