import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ThreadManager } from '../src/manager.ts';
import { ThreadStore } from '../src/store.ts';
import { newKey } from '../src/crypt.ts';

const KEY = newKey();

const cleanup: (() => Promise<unknown>)[] = [];
after(async () => { for (const c of cleanup.reverse()) await c().catch(() => {}); });

async function tempDir(prefix: string): Promise<string> {
  const d = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
  cleanup.push(() => rm(d, { recursive: true, force: true }));
  return d;
}
function manager(storeDir: string, defaultDir: string, saveHistory = true, key: Buffer | null = KEY): ThreadManager {
  const m = new ThreadManager({ store: new ThreadStore(storeDir, key), defaultDir, shell: '/bin/sh', args: [], env: process.env, cols: 80, rows: 24, saveHistory, keyAvailable: key !== null });
  cleanup.push(() => m.dispose());
  return m;
}
async function waitFor(pred: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(25);
  }
}
const snap = async (m: ThreadManager, id: string) => (await m.get(id)!.snapshot()).data;
const readIndex = async (dir: string) => JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')).threads;

test('restart restores order, renames, history and separator', async () => {
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const m1 = manager(store, home);
  const a = await m1.create();
  const b = await m1.create();
  await m1.rename(b, 'build');
  m1.get(a)!.write('echo alpha-$((1))\r');
  await waitFor(async () => (await snap(m1, a)).includes('alpha-1'));
  await m1.saveAll();
  await m1.dispose();

  const m2 = manager(store, home);
  await m2.restore();
  const [ia, ib] = m2.list();
  assert.equal(ia!.id, a);
  assert.equal(ib!.id, b);
  assert.equal(ib!.title, 'build');
  await waitFor(() => m2.list()[0]!.title.startsWith(`${basename(home)} — `));
  const text = await snap(m2, a);
  assert.ok(text.indexOf('alpha-1') >= 0 && text.indexOf('alpha-1') < text.indexOf('── session ended ──'), text);
});

test('rename to empty clears it', async () => {
  const store = await tempDir('tt-store-');
  const m = manager(store, await tempDir('tt-home-'));
  const a = await m.create();
  await waitFor(() => m.get(a)!.title !== '');
  await m.rename(a, 'x');
  assert.equal(m.list()[0]!.title, 'x');
  await m.rename(a, '  ');
  assert.equal(m.list()[0]!.title, m.get(a)!.title);
  assert.equal((await readIndex(store))[0].customName, null);
});

test('restored thread starts in its last directory', async () => {
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const m1 = manager(store, home);
  const a = await m1.create();
  m1.get(a)!.write('cd /tmp\r');
  await waitFor(() => m1.get(a)!.title.startsWith('tmp — '));
  await m1.saveAll();
  await m1.dispose();

  const m2 = manager(store, home);
  await m2.restore();
  await waitFor(() => m2.get(a)!.lastDir === realpathSync('/tmp'));
});

test('missing directories fall back', async () => {
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const start1 = await tempDir('tt-start-');
  const gone = join(home, 'deleted');
  await mkdir(store, { recursive: true });
  await writeFile(join(store, 'index.json'), JSON.stringify({ version: 1, threads: [
    { id: 'one', customName: null, startDir: start1, lastDir: gone },
    { id: 'two', customName: null, startDir: join(home, 'also-gone'), lastDir: gone },
  ] }));
  const m = manager(store, home);
  await m.restore();
  await waitFor(() => m.get('one')!.lastDir === start1 && m.get('two')!.lastDir === home);
});

test('close removes history and index entry', async () => {
  const store = await tempDir('tt-store-');
  const m = manager(store, await tempDir('tt-home-'));
  const a = await m.create();
  const b = await m.create();
  await m.saveAll();
  assert.ok((await readdir(join(store, 'threads'))).includes(`${a}.json`));
  await m.close(a);
  assert.equal(m.get(a), undefined);
  assert.deepEqual(m.list().map((t) => t.id), [b]);
  assert.deepEqual((await readIndex(store)).map((t: { id: string }) => t.id), [b]);
  assert.ok(!(await readdir(join(store, 'threads'))).includes(`${a}.json`));
});

test('an unreadable history file does not stop the other threads restoring', async () => {
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const gone = join(home, 'deleted');
  await mkdir(join(store, 'threads', 'bad.json'), { recursive: true });
  await writeFile(join(store, 'index.json'), JSON.stringify({ version: 1, threads: [
    { id: 'bad', customName: null, startDir: home, lastDir: home },
    { id: 'good', customName: 'kept', startDir: home, lastDir: gone },
  ] }));
  const m = manager(store, home);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await m.restore();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(m.list().map((t) => t.id), ['bad', 'good']);
  assert.ok((await snap(m, 'bad')).includes('── session ended ──'));
  console.warn = () => {};
  try {
    await m.saveAll();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual((await readIndex(store)).map((t: { id: string }) => t.id), ['bad', 'good']);
  assert.ok(!(await readdir(join(store, 'threads'))).some((f) => f.endsWith('.tmp')));
  assert.ok((await readdir(join(store, 'threads'))).includes('good.json'));
});

test('clearing rewrites the saved file now', async () => {
  const store = await tempDir('tt-store-');
  const m = manager(store, await tempDir('tt-home-'));
  const a = await m.create();
  m.get(a)!.write('echo SECRET-$((4))\r');
  await waitFor(async () => (await snap(m, a)).includes('SECRET-4'));
  await m.saveAll();
  const saved = () => new ThreadStore(store, KEY).loadHistory(a).then((h) => h?.history ?? '');
  assert.ok((await saved()).includes('SECRET-4'));
  assert.equal(await m.clearHistory(a), true);
  assert.ok(!(await saved()).includes('SECRET-4'));
});

test('turning saving off deletes history and stops writing', async () => {
  const store = await tempDir('tt-store-');
  const m = manager(store, await tempDir('tt-home-'));
  const a = await m.create();
  m.get(a)!.write('echo kept-$((5))\r');
  await waitFor(async () => (await snap(m, a)).includes('kept-5'));
  await m.saveAll();
  await m.setSaveHistory(false);
  assert.deepEqual(await readdir(join(store, 'threads')), []);
  m.get(a)!.write('echo more\r');
  await waitFor(async () => (await snap(m, a)).includes('more'));
  await m.saveAll();
  assert.deepEqual(await readdir(join(store, 'threads')), []);
  assert.deepEqual((await readIndex(store)).map((t: { id: string }) => t.id), [a]);
  await m.setSaveHistory(true);
  await m.saveAll();
  assert.ok((await readdir(join(store, 'threads'))).includes(`${a}.json`));
});

test('restore with saving off shows only the separator', async () => {
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const m1 = manager(store, home);
  const a = await m1.create();
  m1.get(a)!.write('echo old-$((6))\r');
  await waitFor(async () => (await snap(m1, a)).includes('old-6'));
  await m1.saveAll();
  await m1.dispose();
  const m2 = manager(store, home, false);
  await m2.restore();
  const text = await snap(m2, a);
  assert.ok(!text.includes('old-6'));
  assert.ok(text.includes('── session ended ──'));
});

test('restore with saving off deletes leftover history', async () => {
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const m1 = manager(store, home);
  await m1.create();
  await m1.saveAll();
  await m1.dispose();
  assert.equal((await readdir(join(store, 'threads'))).length, 1);
  const m2 = manager(store, home, false);
  await m2.restore();
  assert.deepEqual(await readdir(join(store, 'threads')), []);
});

test('without a key, encrypted history is kept and nothing is written', async () => {
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const m1 = manager(store, home);
  const a = await m1.create();
  m1.get(a)!.write('echo keep-$((8))\r');
  await waitFor(async () => (await snap(m1, a)).includes('keep-8'));
  await m1.saveAll();
  await m1.dispose();
  const file = join(store, 'threads', `${a}.json`);
  const before = await readFile(file);
  const m2 = manager(store, home, true, null);
  await m2.restore();
  await m2.setSaveHistory(true);
  m2.get(a)!.write('echo new\r');
  await waitFor(async () => (await snap(m2, a)).includes('new'));
  await m2.saveAll();
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readdir(join(store, 'threads')), [`${a}.json`]);
});

test('rekey re-seals every thread with the stored key', async () => {
  const store = await tempDir('tt-store-');
  const m = manager(store, await tempDir('tt-home-'));
  const a = await m.create();
  m.get(a)!.write('echo rekeyed-$((9))\r');
  await waitFor(async () => (await snap(m, a)).includes('rekeyed-9'));
  await m.saveAll();
  const winner = newKey();
  m.rekey(winner);
  await m.saveDirty();
  const h = await new ThreadStore(store, winner).loadHistory(a);
  assert.ok(h?.history.includes('rekeyed-9'));
});

test('with encryption off, history is saved without a key', async () => {
  const store = await tempDir('tt-store-');
  const m = new ThreadManager({ store: new ThreadStore(store, null, false), defaultDir: await tempDir('tt-home-'), shell: '/bin/sh', args: [], env: process.env, cols: 80, rows: 24, saveHistory: true, keyAvailable: false, encrypt: false });
  cleanup.push(() => m.dispose());
  const a = await m.create();
  m.get(a)!.write('echo plain-$((3))\r');
  await waitFor(async () => (await snap(m, a)).includes('plain-3'));
  await m.saveAll();
  assert.ok((await readFile(join(store, 'threads', `${a}.json`), 'utf8')).includes('plain-3'));
});

test('turning encryption back on re-seals every thread', async () => {
  const store = await tempDir('tt-store-');
  const s = new ThreadStore(store, KEY, false);
  const m = new ThreadManager({ store: s, defaultDir: await tempDir('tt-home-'), shell: '/bin/sh', args: [], env: process.env, cols: 80, rows: 24, saveHistory: true, encrypt: false });
  cleanup.push(() => m.dispose());
  const a = await m.create();
  m.get(a)!.write('echo reseal-$((4))\r');
  await waitFor(async () => (await snap(m, a)).includes('reseal-4'));
  await m.saveAll();
  assert.ok((await readFile(join(store, 'threads', `${a}.json`), 'utf8')).includes('reseal-4'));
  m.setEncryption(true);
  await m.saveDirty();
  assert.ok(!(await readFile(join(store, 'threads', `${a}.json`), 'utf8')).includes('reseal-4'));
});

test('a key that arrives later enables saving', async () => {
  const store = await tempDir('tt-store-');
  const m = manager(store, await tempDir('tt-home-'), true, null);
  const a = await m.create();
  m.get(a)!.write('echo later-$((5))\r');
  await waitFor(async () => (await snap(m, a)).includes('later-5'));
  await m.saveAll();
  assert.deepEqual(await readdir(join(store, 'threads')).catch(() => []), []);
  m.rekey(KEY);
  await m.saveDirty();
  assert.ok((await new ThreadStore(store, KEY).loadHistory(a))?.history.includes('later-5'));
});

test('move reorders threads and the order persists', async () => {
  const store = await tempDir('tt-store-');
  const home = await tempDir('tt-home-');
  const m1 = manager(store, home);
  const a = await m1.create();
  const b = await m1.create();
  const c = await m1.create();
  await m1.move(c, 0);
  assert.deepEqual(m1.list().map((t) => t.id), [c, a, b]);
  await m1.move(c, 99);
  assert.deepEqual(m1.list().map((t) => t.id), [a, b, c]);
  await m1.move(a, -5);
  assert.deepEqual(m1.list().map((t) => t.id), [a, b, c]);
  await m1.move(a, 1);
  await m1.dispose();
  const m2 = manager(store, home);
  await m2.restore();
  assert.deepEqual(m2.list().map((t) => t.id), [b, a, c]);
});
