import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SavedHistory } from './history.ts';

export interface ThreadMeta {
  id: string;
  customName: string | null;
  startDir: string;
  lastDir: string;
}

const SAFE_ID = /^[A-Za-z0-9-]+$/;
let tmpCounter = 0;

const isString = (v: unknown): v is string => typeof v === 'string';
const isMeta = (v: unknown): v is ThreadMeta => {
  const m = v as ThreadMeta;
  return typeof v === 'object' && v !== null && isString(m.id) && (m.customName === null || isString(m.customName)) && isString(m.startDir) && isString(m.lastDir);
};
const isHistory = (v: unknown): v is SavedHistory => {
  const h = v as SavedHistory;
  return typeof v === 'object' && v !== null && isString(h.history) && (h.frame === null || (Array.isArray(h.frame) && h.frame.every(isString)));
};

export class ThreadStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
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
    return this.read(this.historyPath(id), isHistory);
  }

  async saveHistory(id: string, h: SavedHistory): Promise<void> {
    return this.writeAtomic(this.historyPath(id), JSON.stringify(h));
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
    const aside = `${file}.corrupt-${Date.now()}`;
    await rename(file, aside);
    console.warn(`terminal-threads: moved unreadable ${file} to ${aside}`);
    return null;
  }

  private async writeAtomic(file: string, data: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
}
