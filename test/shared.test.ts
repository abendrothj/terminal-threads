import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadManager } from '../src/manager.ts';
import { ThreadStore } from '../src/store.ts';
import { newKey } from '../src/crypt.ts';

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
function manager(storeDir: string, defaultDir: string): ThreadManager {
  const m = new ThreadManager({ store: new ThreadStore(storeDir, KEY), defaultDir, shell: '/bin/sh', args: [], env: process.env, cols: 80, rows: 24, saveHistory: true, keyAvailable: true });
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
