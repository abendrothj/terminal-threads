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
  private readonly takenOverListeners: (() => void)[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  // Every store write goes through this chain, so saves, closes and renames never interleave.
  private queue: Promise<unknown> = Promise.resolve();
  private disposed: Promise<void> | null = null;
  private setting: boolean;
  private saving: boolean;
  // Threads whose saved history this window couldn't read (no key): never overwrite their files.
  private readonly unread = new Set<string>();
  // Threads another window took over (it thought this one was gone): they keep running here, unsaved.
  private readonly takenOver = new Set<string>();
  // Closed here but maybe still in the index (the write failed); the lease keeps them until it's done.
  private readonly closing = new Set<string>();
  // An index write failed; the next save writes this window's threads again.
  private indexStale = false;
  private ticking = false;
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
    // A thread list that stays locked or unreadable must not keep the window from opening; the threads
    // stay in the index for the next window.
    const free = await this.enqueue(() => store.claimFree()).catch((e) => {
      console.warn('terminal-threads: could not claim saved threads; opening without them', e);
      return [] as ThreadMeta[];
    });
    for (const meta of free) {
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
    await this.enqueue(() => this.syncIndex());
    return id;
  }

  async close(id: string): Promise<void> {
    if (!this.threads.has(id)) return;
    await this.enqueue(async () => {
      this.threads.get(id)?.dispose();
      this.threads.delete(id);
      this.metas = this.metas.filter((m) => m.id !== id);
      this.changed();
      // Another window has it now: its history and index entry are that window's.
      if (this.takenOver.delete(id)) return;
      this.closing.add(id);
      await this.syncIndex();
    });
  }

  async rename(id: string, name: string): Promise<void> {
    const meta = this.metas.find((m) => m.id === id);
    if (!meta) return;
    meta.customName = name.trim() || null;
    this.changed();
    await this.enqueue(() => this.syncIndex());
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
    // A thread another window took over has its place in that window's order.
    if (this.takenOver.has(id)) return;
    await this.enqueue(() => this.syncIndex((all) => {
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

  onTakenOver(l: () => void): void {
    this.takenOverListeners.push(l);
  }

  heartbeat(): Promise<void> {
    return this.enqueue(async () => this.lost(await this.deps.store.heartbeat()));
  }

  start(): void {
    this.timers.push(
      setInterval(() => {
        // The last tick is still waiting (a busy lock): don't pile more up behind it.
        if (this.ticking) return;
        this.ticking = true;
        // Lease first: after a sleep, another window may have taken threads this one would save.
        void Promise.all([
          this.heartbeat().catch((e) => console.warn('terminal-threads: could not refresh lease', e)),
          this.saveDirty().catch((e) => console.error('terminal-threads: save failed', e)),
        ]).finally(() => { this.ticking = false; });
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
    let moved = false;
    for (const meta of this.metas) {
      const t = this.threads.get(meta.id);
      if (!t || !which(t) || this.unread.has(meta.id) || this.takenOver.has(meta.id)) continue;
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
        moved = true;
      }
    }
    if (moved || this.indexStale) await this.syncIndex();
  }

  // Writes this window's threads into the index as they are now (new ones added, closed ones
  // dropped, `reorder` applied first), so the next write repairs one that failed. The lease covers
  // a thread before it enters the index and until it has left it, so no other window restores it
  // in between.
  private async syncIndex(reorder?: (all: ThreadMeta[]) => ThreadMeta[]): Promise<void> {
    try {
      // Only threads the claim below covers: one created while it waits is left to its own sync.
      const claimed = new Set(this.metas.map((m) => m.id));
      const mine = () => this.metas.filter((m) => claimed.has(m.id) && !this.takenOver.has(m.id));
      const taken = await this.deps.store.claim([...mine().map((m) => m.id), ...this.closing]);
      this.lost(taken);
      // A closed thread another window took over is that window's to keep.
      taken.forEach((id) => this.closing.delete(id));
      const closing = [...this.closing];
      for (const id of closing) await this.deps.store.deleteHistory(id);
      const own = new Map(mine().map((m) => [m.id, { ...m }]));
      await this.deps.store.updateIndex((all) => {
        const next = (reorder ? reorder(all) : all).filter((m) => !closing.includes(m.id)).map((m) => own.get(m.id) ?? m);
        for (const m of own.values()) if (!next.some((n) => n.id === m.id)) next.push(m);
        return next;
      });
      this.indexStale = false;
      if (closing.length > 0) {
        closing.forEach((id) => this.closing.delete(id));
        this.lost(await this.deps.store.claim([...own.keys(), ...this.closing]));
      }
    } catch (e) {
      this.indexStale = true;
      console.warn('terminal-threads: could not update the thread list; retrying on the next save', e);
    }
  }

  // Threads another window now holds: stop saving the open ones here, and say so once.
  private lost(ids: string[]): void {
    // A thread closed here meanwhile needs no warning: that window keeps it.
    const fresh = ids.filter((id) => this.threads.has(id) && !this.takenOver.has(id));
    if (fresh.length === 0) return;
    fresh.forEach((id) => this.takenOver.add(id));
    this.takenOverListeners.forEach((l) => l());
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
