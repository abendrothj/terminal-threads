import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir, utimes, chmod, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadManager } from '../src/manager.ts';
import { ThreadStore, LEASE_STALE_MS, LOCK_STALE_MS, type ThreadMeta } from '../src/store.ts';
import { newKey } from '../src/crypt.ts';
import { setTimeout as sleep } from 'node:timers/promises';

// Two windows sharing one storage folder (empty windows use globalStorage; Remote-SSH windows from
// two computers share the remote's workspace storage), simulated as two managers on one folder.
const KEY = newKey();
const cleanup: (() => Promise<unknown>)[] = [];
after(async () => { for (const c of cleanup.reverse()) await c().catch(() => {}); });

async function tempDir(prefix: string): Promise<string> {
  const d = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
  cleanup.push(() => rm(d, { recursive: true, force: true }));
  return d;
}
function manager(storeDir: string, defaultDir: string, store = new ThreadStore(storeDir, KEY)): ThreadManager {
  const m = new ThreadManager({ store, defaultDir, shell: '/bin/sh', args: [], env: process.env, cols: 80, rows: 24, saveHistory: true, keyAvailable: true });
  cleanup.push(() => m.dispose());
  return m;
}
const ids = async (dir: string) => JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')).threads.map((t: { id: string }) => t.id) as string[];
const names = async (dir: string) => Object.fromEntries(JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')).threads.map((t: { id: string; customName: string | null }) => [t.id, t.customName]));

test("two windows' creates, renames and closes all survive, in any close order", async () => {
  for (const order of ['ab', 'ba']) {
    const store = await tempDir('tt-store-');
    const home = await tempDir('tt-home-');
    const a = manager(store, home);
    const b = manager(store, home);
    await a.restore();
    await b.restore();
    const a1 = await a.create();
    const b1 = await b.create();
    const a2 = await a.create();
    const b2 = await b.create();
    await a.rename(a1, 'from-a');
    await b.rename(b1, 'from-b');
    await a.close(a2);
    await b.close(b2);
    const [first, second] = order === 'ab' ? [a, b] : [b, a];
    await first.dispose();
    await second.dispose();
    assert.deepEqual((await ids(store)).sort(), [a1, b1].sort(), order);
    assert.deepEqual(await names(store), { [a1]: 'from-a', [b1]: 'from-b' }, order);
    const files = await readdir(join(store, 'threads'));
    assert.deepEqual(files.sort(), [`${a1}.json`, `${b1}.json`].sort(), order);
    const c = manager(store, home);
    await c.restore();
    assert.deepEqual(c.list().map((t) => t.id).sort(), [a1, b1].sort(), order);
    await c.dispose();
  }
});

test('a second window does not take over threads another live window has open', async () => {
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const a = manager(store, home);
  await a.restore();
  const a1 = await a.create();
  const b = manager(store, home);
  await b.restore();
  assert.deepEqual(b.list(), [], 'both windows would write the same history file');
  await b.dispose();
  await a.dispose();
  // Once that window is gone, its threads restore anywhere.
  const c = manager(store, home);
  await c.restore();
  assert.deepEqual(c.list().map((t) => t.id), [a1]);
});

test("a crashed window's threads are not held forever", async () => {
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const a = manager(store, home);
  await a.restore();
  const a1 = await a.create();
  // A lease left by a dead process (this test can't crash a window, so it writes one).
  await mkdir(join(store, 'owners'), { recursive: true });
  const lease = (await readdir(join(store, 'owners')))[0]!;
  const leaseFile = join(store, 'owners', lease);
  const dead = { ...JSON.parse(await readFile(leaseFile, 'utf8')), pid: 2 ** 22 + 12345 };
  await a.dispose();
  await writeFile(leaseFile, JSON.stringify(dead));
  const b = manager(store, home);
  await b.restore();
  assert.deepEqual(b.list().map((t) => t.id), [a1]);
});

test('moving among threads keeps the other window\'s threads in place', async () => {
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const a = manager(store, home);
  const b = manager(store, home);
  await a.restore();
  await b.restore();
  const a1 = await a.create();
  const b1 = await b.create();
  const a2 = await a.create();
  const b2 = await b.create();
  await a.move(a2, 0);
  assert.deepEqual(await ids(store), [a2, a1, b1, b2]);
  await b.move(b1, 1);
  assert.deepEqual(await ids(store), [a2, a1, b2, b1]);
  await a.move(a2, 1);
  assert.deepEqual(await ids(store), [a1, a2, b2, b1]);
});

test('concurrent index updates from two stores are never lost', async () => {
  const dir = await tempDir('tt-store-');
  const s1 = new ThreadStore(dir, KEY);
  const s2 = new ThreadStore(dir, KEY);
  const add = (s: ThreadStore, id: string) => s.updateIndex((t) => [...t, { id, customName: null, startDir: '/', lastDir: '/' }]);
  const want: string[] = [];
  const ops: Promise<unknown>[] = [];
  for (let i = 0; i < 40; i++) {
    want.push(`one-${i}`, `two-${i}`);
    ops.push(add(s1, `one-${i}`), add(s2, `two-${i}`));
  }
  await Promise.all(ops);
  assert.deepEqual((await s1.loadIndex()).map((t) => t.id).sort(), want.sort());
  assert.deepEqual(await readdir(dir).then((f) => f.filter((n) => n.includes('lock'))), []);
});

const leases = async (dir: string) => {
  const files = await readdir(join(dir, 'owners')).catch(() => [] as string[]);
  return Promise.all(files.filter((f) => f.endsWith('.json')).map(async (f) => ({ file: join(dir, 'owners', f), ...JSON.parse(await readFile(join(dir, 'owners', f), 'utf8')) })));
};
const ago = (ms: number) => new Date(Date.now() - ms);

test('a live window that missed its lease refreshes keeps its threads', async () => {
  // A breakpoint, a blocked extension host or a sleeping laptop stops the refreshes, not the window.
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const a = manager(store, home);
  await a.restore();
  await a.create();
  const [lease] = await leases(store);
  await utimes(lease.file, ago(LEASE_STALE_MS * 2), ago(LEASE_STALE_MS * 2));
  const b = manager(store, home);
  await b.restore();
  assert.deepEqual(b.list(), [], 'both windows would write the same history file');
});

test("a live window's threads stay its own after this computer's network name changes", async () => {
  // A Mac without a fixed HostName takes its name from the network it's on.
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const a = manager(store, home);
  await a.restore();
  await a.create();
  const [lease] = await leases(store);
  await writeFile(lease.file, JSON.stringify({ ...lease, file: undefined, host: 'Mac.old-network.example' }));
  await utimes(lease.file, ago(LEASE_STALE_MS * 2), ago(LEASE_STALE_MS * 2));
  const b = manager(store, home);
  await b.restore();
  assert.deepEqual(b.list(), [], 'both windows would write the same history file');
});

test('a window whose threads were taken over stops writing them', async () => {
  // Another host's window (a storage folder shared over the network) that stopped refreshing looks
  // gone, so a window here takes its threads.
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const a = manager(store, home);
  await a.restore();
  const a1 = await a.create();
  await a.saveAll();
  const [lease] = await leases(store);
  await writeFile(lease.file, JSON.stringify({ ...lease, file: undefined, machine: 'another-computer' }));
  await utimes(lease.file, ago(LEASE_STALE_MS * 2), ago(LEASE_STALE_MS * 2));
  const b = manager(store, home);
  await b.restore();
  assert.deepEqual(b.list().map((t) => t.id), [a1]);
  await b.rename(a1, 'from-b');
  await b.saveAll();
  const saved = await readFile(join(store, 'threads', `${a1}.json`), 'utf8');
  // The first window wakes up: it must not take the thread back or overwrite what the other saves.
  let warned = 0;
  a.onTakenOver(() => warned++);
  await a.heartbeat();
  a.get(a1)!.write('echo LATE\r');
  await a.rename(a1, 'from-a');
  await a.saveAll();
  assert.equal(warned, 1);
  const held = (await leases(store)).filter((l) => l.ids.includes(a1));
  assert.equal(held.length, 1, 'two windows hold the same thread');
  assert.equal(await readFile(join(store, 'threads', `${a1}.json`), 'utf8'), saved);
  assert.deepEqual(await names(store), { [a1]: 'from-b' });
  // Closing it here leaves the other window's thread alone.
  await a.close(a1);
  assert.deepEqual(await ids(store), [a1]);
  assert.ok((await readdir(join(store, 'threads'))).includes(`${a1}.json`));
});

test('closing a thread another window took over, before noticing, leaves that window its thread', async () => {
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const a = manager(store, home);
  await a.restore();
  const a1 = await a.create();
  await a.saveAll();
  const [lease] = await leases(store);
  await writeFile(lease.file, JSON.stringify({ ...lease, file: undefined, machine: 'another-computer' }));
  await utimes(lease.file, ago(LEASE_STALE_MS * 2), ago(LEASE_STALE_MS * 2));
  const b = manager(store, home);
  await b.restore();
  await b.saveAll();
  let warned = 0;
  a.onTakenOver(() => warned++);
  await a.close(a1);
  assert.equal(warned, 1);
  assert.deepEqual(await ids(store), [a1]);
  assert.ok((await readdir(join(store, 'threads'))).includes(`${a1}.json`));
  await b.dispose();
  const c = manager(store, home);
  await c.restore();
  assert.deepEqual(c.list().map((t) => t.id), [a1]);
});

test("a lease that can't be read right now is not taken for a dead window's", async () => {
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const a = manager(store, home);
  await a.restore();
  await a.create();
  const [lease] = await leases(store);
  await chmod(lease.file, 0o000);
  cleanup.push(() => chmod(lease.file, 0o600));
  const b = manager(store, home);
  await b.restore();
  assert.deepEqual(b.list(), [], 'both windows would write the same history file');
  assert.ok(await stat(lease.file).then(() => true, () => false), "the other window's lease was deleted");
  await chmod(lease.file, 0o600);
});

test('a window still opens when the thread list stays locked', async () => {
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const a = manager(store, home);
  await a.restore();
  const a1 = await a.create();
  await a.dispose();
  const s = new ThreadStore(store, KEY);
  s.claimFree = () => Promise.reject(new Error('terminal-threads: the thread list is locked by another window'));
  const b = manager(store, home, s);
  await b.restore();
  assert.deepEqual(b.list(), []);
  await b.create();
  // The threads it couldn't claim are still there for the next window.
  const c = manager(store, home);
  await c.restore();
  assert.ok(c.list().some((t) => t.id === a1));
});

// The index write fails once (disk full, permissions), then works again.
function failingOnce(dir: string): ThreadStore {
  const s = new ThreadStore(dir, KEY);
  const real = s.updateIndex.bind(s);
  let failed = false;
  s.updateIndex = (change) => {
    if (failed) return real(change);
    failed = true;
    return Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
  };
  return s;
}

test('a new thread whose index write failed is added by the next save', async () => {
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const a = manager(store, home, failingOnce(store));
  await a.restore();
  const a1 = await a.create();
  await a.saveDirty();
  assert.deepEqual(await ids(store), [a1]);
});

test('a closed thread whose index write failed is removed by the next save', async () => {
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const a = manager(store, home);
  await a.restore();
  const a1 = await a.create();
  const a2 = await a.create();
  await a.dispose();
  const b = manager(store, home, failingOnce(store));
  await b.restore();
  await b.close(a1);
  // Until it has left the index, the closing window still holds it: no other window restores it.
  const c = manager(store, home);
  await c.restore();
  assert.deepEqual(c.list(), []);
  await b.saveDirty();
  assert.deepEqual(await ids(store), [a2]);
});

// Each of these waits out a stale lock; they run side by side to keep the suite fast.
describe('the index lock', { concurrency: true }, () => {
  const add = (s: ThreadStore, id: string) => s.updateIndex((t) => [...t, { id, customName: null, startDir: '/', lastDir: '/' }]);
  // A holder that never finishes reading the index, like a window that crashed or froze holding the
  // lock (`until` lets it resume, with what it read back then).
  const stuck = (s: ThreadStore, id: string, until = new Promise<ThreadMeta[]>(() => {})) => {
    const real = s.loadIndex.bind(s);
    s.loadIndex = () => {
      s.loadIndex = real;
      return until;
    };
    return add(s, id);
  };
  const lockFile = (dir: string) => join(dir, 'index.lock');
  const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => { throw new Error(`still waiting after ${ms} ms`); })]);

  test('a lock left by a crash is broken even when its clock was ahead', async () => {
    const dir = await tempDir('tt-store-');
    void stuck(new ThreadStore(dir, KEY), 'crashed');
    await waitForLock(dir);
    const future = new Date(Date.now() + 3600_000);
    await utimes(lockFile(dir), future, future);
    await within(add(new ThreadStore(dir, KEY), 'after'), LOCK_STALE_MS * 2);
    assert.deepEqual((await new ThreadStore(dir, KEY).loadIndex()).map((t) => t.id), ['after']);
  });

  test("a holder that stalled past the lock's lifetime redoes its change on the current list", async () => {
    const dir = await tempDir('tt-store-');
    let resume!: (t: ThreadMeta[]) => void;
    const late = stuck(new ThreadStore(dir, KEY), 'late', new Promise((r) => { resume = r; }));
    await waitForLock(dir);
    await within(add(new ThreadStore(dir, KEY), 'newer'), LOCK_STALE_MS * 2);
    resume([]);
    await within(late, LOCK_STALE_MS);
    assert.deepEqual((await new ThreadStore(dir, KEY).loadIndex()).map((t) => t.id), ['newer', 'late']);
  });

  test("a holder that lost the lock leaves the new holder's lock alone", async () => {
    // Moving the other lock aside, even briefly, would let a third window in beside its holder.
    const dir = await tempDir('tt-store-');
    let resumeLate!: (t: ThreadMeta[]) => void;
    const late = stuck(new ThreadStore(dir, KEY), 'late', new Promise((r) => { resumeLate = r; }));
    await waitForLock(dir);
    let resumeNext!: (t: ThreadMeta[]) => void;
    const next = stuck(new ThreadStore(dir, KEY), 'next', new Promise((r) => { resumeNext = r; }));
    // `next` breaks the stale lock and holds it, still reading.
    await sleep(LOCK_STALE_MS + 1000);
    const events: string[] = [];
    const watcher = watch(dir, (_, f) => events.push(String(f)));
    await sleep(300);
    resumeLate([]);
    await sleep(500);
    watcher.close();
    assert.deepEqual(events.filter((f) => f.startsWith('index.lock')), [], "the new holder's lock was moved");
    resumeNext([]);
    await within(Promise.all([late, next]), LOCK_STALE_MS);
    assert.deepEqual((await new ThreadStore(dir, KEY).loadIndex()).map((t) => t.id).sort(), ['late', 'next']);
  });

  test('windows breaking the same stale lock together lose nothing', async () => {
    await Promise.all(Array.from({ length: 20 }, async () => {
      const dir = await tempDir('tt-store-');
      void stuck(new ThreadStore(dir, KEY), 'crashed');
      await waitForLock(dir);
      const want = Array.from({ length: 6 }, (_, i) => `w${i}`);
      await within(Promise.all(want.map((id) => add(new ThreadStore(dir, KEY), id))), LOCK_STALE_MS * 4);
      assert.deepEqual((await new ThreadStore(dir, KEY).loadIndex()).map((t) => t.id).sort(), want);
    }));
  });

  async function waitForLock(dir: string): Promise<void> {
    while (!(await readdir(dir).catch(() => [] as string[])).includes('index.lock')) await sleep(5);
  }
});
