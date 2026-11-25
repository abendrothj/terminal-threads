import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ThreadManager } from '../src/manager.ts';
import { ThreadStore } from '../src/store.ts';

const cleanup: (() => Promise<unknown>)[] = [];
after(async () => { for (const c of cleanup.reverse()) await c().catch(() => {}); });

async function tempDir(prefix: string): Promise<string> {
  const d = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
  cleanup.push(() => rm(d, { recursive: true, force: true }));
  return d;
}
function manager(storeDir: string, defaultDir: string): ThreadManager {
  const m = new ThreadManager({ store: new ThreadStore(storeDir), defaultDir, shell: '/bin/sh', args: [], env: process.env, cols: 80, rows: 24 });
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
