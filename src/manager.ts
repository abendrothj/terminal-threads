import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { restoredPrefix } from './history.ts';
import type { ThreadMeta, ThreadStore } from './store.ts';
import { Thread } from './thread.ts';

export const SAVE_INTERVAL_MS = 3_000;
export const TICK_MS = 1_000;

export interface ThreadInfo {
  id: string;
  title: string;
  waiting: boolean;
}

export interface ManagerDeps {
  store: ThreadStore;
  defaultDir: string;
  shell: string;
  args: string[];
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
}

export class ThreadManager {
  private readonly deps: ManagerDeps;
  private metas: ThreadMeta[] = [];
  private readonly threads = new Map<string, Thread>();
  private readonly changeListeners: (() => void)[] = [];
  private readonly waitingListeners: ((id: string) => void)[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  // Every store write goes through this chain, so saves, closes and renames never interleave.
  private queue: Promise<unknown> = Promise.resolve();
  private disposed: Promise<void> | null = null;

  constructor(deps: ManagerDeps) {
    this.deps = deps;
  }

  async restore(): Promise<void> {
    const { store, defaultDir } = this.deps;
    for (const meta of await store.loadIndex()) {
      const dir = [meta.lastDir, meta.startDir, defaultDir].find((d) => existsSync(d)) ?? defaultDir;
      // One unreadable file must not lose the other threads; this one restores without history.
      const history = await store.loadHistory(meta.id).catch((e) => {
        console.warn(`terminal-threads: could not read history for ${meta.id}`, e);
        return null;
      });
      this.metas.push(meta);
      this.open(meta.id, dir, restoredPrefix(history));
    }
    this.changed();
  }

  list(): ThreadInfo[] {
    return this.metas.map((m) => {
      const t = this.threads.get(m.id)!;
      return { id: m.id, title: m.customName ?? (t.title || basename(m.lastDir)), waiting: t.waiting.waiting };
    });
  }

  get(id: string): Thread | undefined {
    return this.threads.get(id);
  }

  async create(): Promise<string> {
    const id = randomUUID();
    const dir = this.deps.defaultDir;
    this.metas.push({ id, customName: null, startDir: dir, lastDir: dir });
    this.open(id, dir, '');
    this.changed();
    await this.enqueue(() => this.deps.store.saveIndex(this.metas));
    return id;
  }

  async close(id: string): Promise<void> {
    if (!this.threads.has(id)) return;
    await this.enqueue(async () => {
      this.threads.get(id)?.dispose();
      this.threads.delete(id);
      this.metas = this.metas.filter((m) => m.id !== id);
      this.changed();
      await this.deps.store.deleteHistory(id);
      await this.deps.store.saveIndex(this.metas);
    });
  }

  async rename(id: string, name: string): Promise<void> {
    const meta = this.metas.find((m) => m.id === id);
    if (!meta) return;
    meta.customName = name.trim() || null;
    this.changed();
    await this.enqueue(() => this.deps.store.saveIndex(this.metas));
  }

  setWatched(id: string | null): void {
    for (const [tid, t] of this.threads) t.waiting.setWatched(tid === id);
    this.changed();
  }

  saveDirty(): Promise<void> {
    return this.enqueue(() => this.save((t) => t.dirty));
  }

  saveAll(): Promise<void> {
    return this.enqueue(() => this.save(() => true));
  }

  onChange(l: () => void): void {
    this.changeListeners.push(l);
  }

  onWaiting(l: (id: string) => void): void {
    this.waitingListeners.push(l);
  }

  start(): void {
    this.timers.push(
      setInterval(() => void this.saveDirty().catch((e) => console.error('terminal-threads: save failed', e)), SAVE_INTERVAL_MS),
      setInterval(() => this.tick(), TICK_MS),
    );
  }

  dispose(): Promise<void> {
    this.disposed ??= (async () => {
      this.timers.forEach(clearInterval);
      this.timers = [];
      try {
        await this.saveAll();
      } finally {
        this.threads.forEach((t) => t.dispose());
        this.threads.clear();
      }
    })();
    return this.disposed;
  }

  private open(id: string, cwd: string, prefix: string): void {
    const { shell, args, env, cols, rows } = this.deps;
    const t = new Thread({ id, cwd, shell, args, env, cols, rows, prefix });
    t.onTitle(() => this.changed());
    this.threads.set(id, t);
  }

  private async save(which: (t: Thread) => boolean): Promise<void> {
    let indexChanged = false;
    for (const meta of this.metas) {
      const t = this.threads.get(meta.id);
      if (!t || !which(t)) continue;
      t.dirty = false;
      try {
        await this.deps.store.saveHistory(meta.id, await t.capture());
      } catch (e) {
        // Keep saving the others; this one is retried on the next save.
        t.dirty = true;
        console.warn(`terminal-threads: could not save history for ${meta.id}`, e);
      }
      if (t.lastDir && t.lastDir !== meta.lastDir) {
        meta.lastDir = t.lastDir;
        indexChanged = true;
      }
    }
    if (indexChanged) await this.deps.store.saveIndex(this.metas);
  }

  private tick(): void {
    const now = Date.now();
    for (const [id, t] of this.threads) {
      if (!t.waiting.tick(now)) continue;
      this.waitingListeners.forEach((l) => l(id));
      this.changed();
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private changed(): void {
    this.changeListeners.forEach((l) => l());
  }
}
