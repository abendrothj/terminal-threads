import { execFile } from 'node:child_process';
import { chmod, link, mkdir, readdir, readFile, readlink, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
// - every index change is a read-modify-write under a lock file (created exclusively, holding its
//   owner's token), so one window never writes back another's stale list;
// - each window keeps a lease (owners/<random>.json) naming the threads it has open, and only
//   restores threads no live window holds, so two windows never write the same history file.
// A lock whose token hasn't changed while a window waited this long was left by a crash or a frozen
// window (holders take milliseconds). Measured on the waiter's own clock, so clock changes don't matter.
export const LOCK_STALE_MS = 10_000;
// Waiting longer than this for the lock fails the update: this window's next save retries it, and a
// window starting up opens without its saved threads (they stay for the next window).
export const LOCK_WAIT_MS = 30_000;
// A lease from another machine (a storage folder shared over the network) is refreshed on every
// save tick; one this old belongs to a window that is gone. Remote-SSH windows from several
// computers all run on the remote, so they count as this machine.
export const LEASE_STALE_MS = 60_000;

class LostLock extends Error {}

// Where a lease's pid can be checked: this boot (pids are reused after a reboot), and on Linux also
// the pid namespace (a container shares the host's kernel but not its pids). Not the hostname, which
// on a Mac can come from the network and change. Elsewhere (Windows, until round 4), the hostname.
let machine: Promise<string> | undefined;
function machineId(): Promise<string> {
  machine ??= (async () => {
    if (process.platform === 'linux') {
      const boot = await readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => null);
      const pids = await readlink('/proc/self/ns/pid').catch(() => null);
      if (boot && pids) return `${boot.trim()} ${pids}`;
    } else if (process.platform === 'darwin') {
      const boot = await new Promise<string>((resolve) => {
        execFile('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { timeout: 5000 }, (err, stdout) => resolve(err ? '' : stdout.trim()));
      });
      if (boot) return boot;
    }
    return hostname();
  })();
  return machine;
}

// When a process started (Linux; null elsewhere). A restarted container runs the same pids in the
// same order, so a crashed window's pid can be alive again as another process.
async function startTime(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
  // Field 22; counted after the name, which is in parentheses and may contain spaces.
  return stat?.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
}

interface Lease {
  machine: string;
  pid: number;
  start?: string | null;
  ids: string[];
}
const isLease = (v: unknown): v is Lease => {
  const l = v as Lease;
  return typeof v === 'object' && v !== null && isString(l.machine) && Number.isInteger(l.pid) && (l.start === undefined || l.start === null || isString(l.start)) && Array.isArray(l.ids) && l.ids.every(isString);
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
    return this.withLock(async (ensure) => {
      const next = change(await this.loadIndex());
      await ensure();
      await this.saveIndex(next);
    });
  }

  // Startup: the threads no live window holds, now held by this one.
  claimFree(): Promise<ThreadMeta[]> {
    return this.withLock(async (ensure) => {
      const held = await this.heldElsewhere(true);
      const free = (await this.loadIndex()).filter((t) => !held.has(t.id));
      await ensure();
      await this.writeLease(free.map((t) => t.id));
      return free;
    });
  }

  // The threads this window has open; claimed before a new thread enters the index, so no other
  // window can restore it in between. Returns the ones another live window holds (not claimed).
  // A lease that can't be read is passed over: it can't hold a thread created since, and the rest
  // this window claimed earlier, under the lock.
  claim(ids: string[]): Promise<string[]> {
    return this.withLock(async (ensure) => {
      const held = await this.heldElsewhere(false);
      await ensure();
      await this.writeLease(ids.filter((id) => !held.has(id)));
      return ids.filter((id) => held.has(id));
    });
  }

  // Keeps the lease fresh. If another window took it for a dead one (another machine's window that
  // stopped refreshing), claims again what nobody took; returns the threads now held elsewhere.
  async heartbeat(): Promise<string[]> {
    const now = new Date();
    try {
      await utimes(this.lease, now, now);
      return [];
    } catch (e) {
      ignoreMissing(e as NodeJS.ErrnoException);
    }
    return this.claim(this.leaseIds);
  }

  release(): Promise<void> {
    return rm(this.lease, { force: true });
  }

  // Threads held by other live windows. Dead windows' leases are removed on the way.
  // `strict`: a lease that can't be read fails the call (whose threads it holds is unknown).
  private async heldElsewhere(strict: boolean, now = Date.now()): Promise<Set<string>> {
    const owners = join(this.dir, 'owners');
    const held = new Set<string>();
    const here = await machineId();
    const files = await readdir(owners).catch((e) => (ignoreMissing(e), [] as string[]));
    for (const f of files.filter((n) => n.endsWith('.json'))) {
      const file = join(owners, f);
      if (file === this.lease) continue;
      // Gone meanwhile: that window released it. Any other read error: see `strict`.
      let text: string | null;
      let mtime: number;
      try {
        [text, mtime] = await Promise.all([
          readFile(file, 'utf8').catch((e) => (ignoreMissing(e), null)),
          stat(file).then((st) => st.mtimeMs, (e) => (ignoreMissing(e), 0)),
        ]);
      } catch (e) {
        if (strict) throw e;
        continue;
      }
      if (text === null) continue;
      let lease: unknown = null;
      try {
        lease = JSON.parse(text);
      } catch {
        // unreadable: treated as gone
      }
      // On this machine a lease lives as long as its window's process, however long that window went
      // without refreshing (paused, frozen, asleep). Where start times can't be read (macOS), a
      // crashed window's pid reused within the same boot keeps its threads held until that process
      // ends. Another machine's pid can't be checked, so its lease lives as long as it's refreshed.
      if (isLease(lease) && (lease.machine === here
        ? pidAlive(lease.pid) && (!lease.start || (await startTime(lease.pid)) === lease.start)
        : now - mtime < LEASE_STALE_MS)) {
        lease.ids.forEach((id) => held.add(id));
        continue;
      }
      await rm(file, { force: true });
    }
    return held;
  }

  // `fn` must call `ensure` right before each write: a holder frozen past LOCK_STALE_MS has lost the
  // lock, and runs `fn` again under a new lock, reading afresh. (Freezing in the milliseconds between
  // `ensure` and the write itself can still overwrite; plain files offer nothing tighter.)
  private async withLock<T>(fn: (ensure: () => Promise<void>) => Promise<T>): Promise<T> {
    const start = performance.now();
    for (;;) {
      try {
        return await this.lockOnce(fn, start);
      } catch (e) {
        if (!(e instanceof LostLock)) throw e;
      }
    }
  }

  private async lockOnce<T>(fn: (ensure: () => Promise<void>) => Promise<T>, start: number): Promise<T> {
    const lock = join(this.dir, 'index.lock');
    const token = randomUUID();
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let seen: string | null = null;
    let seenAt = performance.now();
    for (;;) {
      try {
        await writeFile(lock, token, { flag: 'wx', mode: 0o600 });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      // Null: released just now. An empty file is a holder between creating and writing it.
      const holder = await readFile(lock, 'utf8').catch((e) => (ignoreMissing(e), null));
      const now = performance.now();
      if (holder !== seen) {
        seen = holder;
        seenAt = now;
      } else if (holder !== null && now - seenAt > LOCK_STALE_MS) {
        await this.breakLock(lock, holder, now - seenAt > 2 * LOCK_STALE_MS);
      }
      if (now - start > LOCK_WAIT_MS) throw new Error('terminal-threads: the thread list is locked by another window');
      await sleep(5 + Math.random() * 20);
    }
    const ensure = async () => {
      if ((await readFile(lock, 'utf8').catch(() => null)) !== token) throw new LostLock();
    };
    try {
      return await fn(ensure);
    } finally {
      await this.removeLock(lock, token);
    }
  }

  // Windows that found the same lock stale break it one at a time, each checking it is still that
  // lock, so none removes the lock another has just taken. A window that crashed while breaking
  // (microseconds) leaves the guard behind; it is cleared once the lock has looked stale twice as long.
  private async breakLock(lock: string, stale: string, clearGuard: boolean): Promise<void> {
    const guard = `${lock}.break`;
    if (clearGuard) await rm(guard, { force: true });
    try {
      await writeFile(guard, '', { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw e;
    }
    try {
      if ((await readFile(lock, 'utf8').catch(() => null)) !== stale) return;
      console.warn('terminal-threads: removing a stale index lock');
      await this.removeLock(lock, stale);
    } finally {
      await rm(guard, { force: true });
    }
  }

  // Removes the lock only if it still holds `token`. It is moved aside first, so a lock another
  // window took in the meantime is put back rather than deleted.
  private async removeLock(lock: string, token: string): Promise<void> {
    // Usually it is another's lock by now (this holder lost it): leave it alone, don't even move it.
    if ((await readFile(lock, 'utf8').catch(() => null)) !== token) return;
    const aside = `${lock}.${randomUUID()}.tmp`;
    try {
      await rename(lock, aside);
    } catch (e) {
      return ignoreMissing(e as NodeJS.ErrnoException);
    }
    // If yet another window locked meanwhile (EEXIST), the one put aside has lost; its holder's
    // `ensure` fails and its update is retried.
    if ((await readFile(aside, 'utf8').catch(() => null)) !== token) await link(aside, lock).catch(() => {});
    await rm(aside, { force: true });
  }

  private async writeLease(ids: string[]): Promise<void> {
    const lease: Lease = { machine: await machineId(), pid: process.pid, start: await startTime(process.pid), ids: [...ids] };
    await this.writeAtomic(this.lease, JSON.stringify(lease));
    this.leaseIds = lease.ids;
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
        // A recent .tmp (or lock-breaking guard) may be another window's work in progress (shared
        // storage); leave it.
        const staleTmp = (f.endsWith('.tmp') || f === 'index.lock.break') && now - (await stat(join(dir, f)).then((st) => st.mtimeMs, () => now)) > 10 * 60_000;
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
