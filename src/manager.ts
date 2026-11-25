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
  saveHistory: boolean;
  // False when secret storage gave no key: history isn't saved, and existing files are kept.
  keyAvailable?: boolean;
  // False when the user turned encryption off: a key isn't needed to save.
  encrypt?: boolean;
}

export class ThreadManager {
  private readonly deps: ManagerDeps;
  // This window's threads only; the index on disk may also list other windows' (shared storage).
  private metas: ThreadMeta[] = [];
  private readonly threads = new Map<string, Thread>();
  private readonly changeListeners: (() => void)[] = [];
  private readonly waitingListeners: ((id: string) => void)[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  // Every store write goes through this chain, so saves, closes and renames never interleave.
  private queue: Promise<unknown> = Promise.resolve();
  private disposed: Promise<void> | null = null;
  private setting: boolean;
  private saving: boolean;
  // Threads whose saved history this window couldn't read (no key): never overwrite their files.
  private readonly unread = new Set<string>();
  private encrypt: boolean;

  constructor(deps: ManagerDeps) {
    this.deps = deps;
    this.setting = deps.saveHistory;
    this.encrypt = deps.encrypt !== false;
    this.saving = this.canSave(deps.saveHistory);
  }

  private canSave(on: boolean): boolean {
    return on && (!this.encrypt || this.deps.keyAvailable !== false);
  }

  async restore(): Promise<void> {
    const { store, defaultDir } = this.deps;
    // "Off" means gone, even if it was switched off while this window wasn't running.
    if (!this.setting) await this.enqueue(() => store.deleteAllHistory());
    for (const meta of await this.enqueue(() => store.claimFree())) {
      const dir = [meta.lastDir, meta.startDir, defaultDir].find((d) => existsSync(d)) ?? defaultDir;
      // One unreadable file must not lose the other threads; this one restores without history.
      const history = !this.saving ? null : await store.loadHistory(meta.id).catch((e) => {
        console.warn(`terminal-threads: could not read history for ${meta.id}`, e);
        return null;
      });
      if (!history && this.setting && (await store.hasHistory(meta.id))) this.unread.add(meta.id);
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

  // `startupCommand` is typed into the new shell once; restored threads never get it.
  async create(startupCommand = ''): Promise<string> {
    const id = randomUUID();
    const dir = this.deps.defaultDir;
    this.metas.push({ id, customName: null, startDir: dir, lastDir: dir });
    this.open(id, dir, '');
    if (startupCommand.trim()) this.threads.get(id)!.write(startupCommand + '\r');
    this.changed();
    const meta = { ...this.metas.at(-1)! };
    await this.enqueue(async () => {
      await this.claimOpen();
      await this.deps.store.updateIndex((all) => [...all.filter((m) => m.id !== id), meta]);
    });
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
      await this.deps.store.updateIndex((all) => all.filter((m) => m.id !== id));
      await this.claimOpen();
    });
  }

  async rename(id: string, name: string): Promise<void> {
    const meta = this.metas.find((m) => m.id === id);
    if (!meta) return;
    const customName = name.trim() || null;
    meta.customName = customName;
    this.changed();
    await this.enqueue(() => this.deps.store.updateIndex((all) => all.map((m) => (m.id === id ? { ...m, customName } : m))));
  }

  // Clears a thread's scrollback and rewrites its saved file now, so the old text leaves the disk.
  async clearHistory(id: string): Promise<boolean> {
    const t = this.threads.get(id);
    if (!t || !(await t.clearHistory())) return false;
    await this.enqueue(() => this.save((x) => x === t));
    return true;
  }

  // Off deletes every saved history file; threads still restore (names, order, folders).
  // Only the user's setting deletes; a missing key just pauses saving.
  async setSaveHistory(on: boolean): Promise<void> {
    this.setting = on;
    this.saving = this.canSave(on);
    if (this.saving) this.threads.forEach((t) => { t.dirty = true; });
    if (!on) await this.enqueue(() => this.deps.store.deleteAllHistory());
  }

  // Encryption switched by the user: every file is rewritten in the new form on the next save.
  setEncryption(on: boolean): void {
    this.encrypt = on;
    this.deps.store.setEncrypt(on);
    this.saving = this.canSave(this.setting);
    this.threads.forEach((t) => { t.dirty = true; });
  }

  // A key arrived (saving was switched on, or another window stored a different key first):
  // use it from now on and re-seal everything.
  rekey(key: Buffer): void {
    this.deps.store.setKey(key);
    this.deps.keyAvailable = true;
    this.saving = this.canSave(this.setting);
    this.threads.forEach((t) => { t.dirty = true; });
  }

  // New position for a thread (clamped to the list); the order is saved with the index.
  async move(id: string, toIndex: number): Promise<void> {
    const from = this.metas.findIndex((m) => m.id === id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(this.metas.length - 1, toIndex));
    if (to === from) return;
    const [meta] = this.metas.splice(from, 1);
    this.metas.splice(to, 0, meta!);
    this.changed();
    // On disk, other windows' threads sit between ours: place it next to its new neighbour.
    const before = this.metas[to - 1]?.id;
    const after = this.metas[to + 1]?.id;
    await this.enqueue(() => this.deps.store.updateIndex((all) => {
      const i = all.findIndex((m) => m.id === id);
      if (i < 0) return all;
      const [moved] = all.splice(i, 1);
      const b = all.findIndex((m) => m.id === before);
      const a = all.findIndex((m) => m.id === after);
      all.splice(b >= 0 ? b + 1 : a >= 0 ? a : before === undefined ? 0 : all.length, 0, moved!);
      return all;
    }));
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
      setInterval(() => {
        void this.saveDirty().catch((e) => console.error('terminal-threads: save failed', e));
        void this.enqueue(() => this.deps.store.heartbeat()).catch((e) => console.warn('terminal-threads: could not refresh lease', e));
      }, SAVE_INTERVAL_MS),
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
        // Saved: the threads are free for the next window that opens.
        await this.enqueue(() => this.deps.store.release()).catch((e) => console.warn('terminal-threads: could not release lease', e));
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
    const moved = new Map<string, string>();
    for (const meta of this.metas) {
      const t = this.threads.get(meta.id);
      if (!t || !which(t) || this.unread.has(meta.id)) continue;
      t.dirty = false;
      try {
        if (this.saving) await this.deps.store.saveHistory(meta.id, await t.capture());
      } catch (e) {
        // Keep saving the others; this one is retried on the next save.
        t.dirty = true;
        console.warn(`terminal-threads: could not save history for ${meta.id}`, e);
      }
      if (t.lastDir && t.lastDir !== meta.lastDir) {
        meta.lastDir = t.lastDir;
        moved.set(meta.id, t.lastDir);
      }
    }
    if (moved.size > 0) {
      await this.deps.store.updateIndex((all) => all.map((m) => (moved.has(m.id) ? { ...m, lastDir: moved.get(m.id)! } : m)));
    }
  }

  private tick(): void {
    const now = Date.now();
    for (const [id, t] of this.threads) {
      if (!t.waiting.tick(now)) continue;
      this.waitingListeners.forEach((l) => l(id));
      this.changed();
    }
  }

  private claimOpen(): Promise<void> {
    return this.deps.store.claim(this.metas.map((m) => m.id));
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
