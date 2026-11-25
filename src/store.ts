import { chmod, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
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

// Several windows can share one storage folder: empty windows all use globalStorage, and Remote-SSH
// windows from different computers on the same remote folder share its workspace storage. So:
// - every index change is a read-modify-write under a lock folder (mkdir is atomic), so one
//   window never writes back another's stale list;
// - each window keeps a lease (owners/<random>.json) naming the threads it has open, and only
//   restores threads no live window holds, so two windows never write the same history file.
// A lock older than this was left by a crash mid-update (holders take milliseconds).
export const LOCK_STALE_MS = 10_000;
// Leases are refreshed on every save tick; one this old belongs to a window that is gone.
export const LEASE_STALE_MS = 60_000;

interface Lease {
  host: string;
  pid: number;
  ids: string[];
}
const isLease = (v: unknown): v is Lease => {
  const l = v as Lease;
  return typeof v === 'object' && v !== null && isString(l.host) && Number.isInteger(l.pid) && Array.isArray(l.ids) && l.ids.every(isString);
};
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

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
  // This window's lease file; random, so two windows in one process (tests) stay apart.
  private readonly lease: string;
  private leaseIds: string[] = [];

  constructor(dir: string, key: Buffer | null, encrypt = true) {
    this.dir = dir;
    this.lease = join(dir, 'owners', `${randomUUID()}.json`);
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

  // Applies `change` to the index as it is on disk now, not to this window's copy.
  updateIndex(change: (threads: ThreadMeta[]) => ThreadMeta[]): Promise<void> {
    return this.withLock(async () => this.saveIndex(change(await this.loadIndex())));
  }

  // Startup: the threads no live window holds, now held by this one.
  claimFree(): Promise<ThreadMeta[]> {
    return this.withLock(async () => {
      const held = await this.heldElsewhere();
      const free = (await this.loadIndex()).filter((t) => !held.has(t.id));
      await this.claim(free.map((t) => t.id));
      return free;
    });
  }

  // The threads this window has open. Written before a new thread enters the index, so no other
  // window can restore it in between.
  async claim(ids: string[]): Promise<void> {
    this.leaseIds = [...ids];
    const lease: Lease = { host: hostname(), pid: process.pid, ids: this.leaseIds };
    await this.writeAtomic(this.lease, JSON.stringify(lease));
  }

  // Keeps the lease fresh; rewrites it if another window took it for a dead one (after a sleep).
  async heartbeat(): Promise<void> {
    const now = new Date();
    await utimes(this.lease, now, now).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
      return this.claim(this.leaseIds);
    });
  }

  release(): Promise<void> {
    return rm(this.lease, { force: true });
  }

  // Threads held by other live windows. Dead windows' leases are removed on the way.
  private async heldElsewhere(now = Date.now()): Promise<Set<string>> {
    const owners = join(this.dir, 'owners');
    const held = new Set<string>();
    const files = await readdir(owners).catch((e) => (ignoreMissing(e), [] as string[]));
    for (const f of files.filter((n) => n.endsWith('.json'))) {
      const file = join(owners, f);
      if (file === this.lease) continue;
      const [text, mtime] = await Promise.all([
        readFile(file, 'utf8').catch(() => null),
        stat(file).then((st) => st.mtimeMs, () => 0),
      ]);
      let lease: unknown = null;
      try {
        lease = text === null ? null : JSON.parse(text);
      } catch {
        // unreadable: treated as gone
      }
      // Another computer's pid can't be checked here; its lease lives as long as it's refreshed.
      if (isLease(lease) && now - mtime < LEASE_STALE_MS && (lease.host !== hostname() || pidAlive(lease.pid))) {
        lease.ids.forEach((id) => held.add(id));
        continue;
      }
      await rm(file, { force: true });
    }
    return held;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = join(this.dir, 'index.lock');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (;;) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const age = await stat(lock).then((st) => Date.now() - st.mtimeMs, () => 0);
        if (age > LOCK_STALE_MS) {
          console.warn('terminal-threads: removing a stale index lock');
          await rm(lock, { recursive: true, force: true });
        } else {
          await sleep(5 + Math.random() * 20);
        }
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
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
    for (const [path, mode] of [[this.dir, 0o700], [threads, 0o700], [join(this.dir, 'owners'), 0o700], [join(this.dir, 'index.json'), 0o600]] as const) {
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

  // Startup only, before any save: temp files are leftovers from a crash mid-write (round 1 wrote
  // them in plain text), and quarantined files older than a month are no longer worth keeping.
  async cleanup(now = Date.now()): Promise<void> {
    const MONTH = 30 * 86_400_000;
    for (const dir of [this.dir, join(this.dir, 'threads'), join(this.dir, 'owners')]) {
      const files = await readdir(dir).catch((e) => (ignoreMissing(e), [] as string[]));
      for (const f of files) {
        const corrupt = /\.corrupt-(\d+)$/.exec(f);
        // A recent .tmp may be another window's save in progress (shared storage); leave it.
        const staleTmp = f.endsWith('.tmp') && now - (await stat(join(dir, f)).then((st) => st.mtimeMs, () => now)) > 10 * 60_000;
        if (staleTmp || (corrupt && now - Number(corrupt[1]) > MONTH)) await rm(join(dir, f), { force: true });
      }
    }
  }

  async hasHistory(id: string): Promise<boolean> {
    return stat(this.historyPath(id)).then(() => true, () => false);
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
