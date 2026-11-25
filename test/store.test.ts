import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadStore, type ThreadMeta } from '../src/store.ts';

const dirs: string[] = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
async function freshDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'tt-store-'));
  dirs.push(d);
  return d;
}
const meta = (id: string, customName: string | null = null): ThreadMeta => ({ id, customName, startDir: '/a', lastDir: '/b' });
const quiet = <T>(fn: () => Promise<T>): Promise<T> => {
  const warn = console.warn;
  console.warn = () => {};
  return fn().finally(() => { console.warn = warn; });
};

test('index and history round trip', async () => {
  const store = new ThreadStore(await freshDir());
  const threads = [meta('b-2', 'build'), meta('a-1')];
  await store.saveIndex(threads);
  await store.saveHistory('a-1', { history: 'hello', frame: ['x'] });
  assert.deepEqual(await store.loadIndex(), threads);
  assert.deepEqual(await store.loadHistory('a-1'), { history: 'hello', frame: ['x'] });
});

test('missing directory loads empty', async () => {
  const store = new ThreadStore(join(await freshDir(), 'nope'));
  assert.deepEqual(await store.loadIndex(), []);
  assert.equal(await store.loadHistory('a'), null);
});

test('no temp files remain after saves', async () => {
  const dir = await freshDir();
  const store = new ThreadStore(dir);
  await Promise.all([store.saveIndex([meta('a')]), store.saveIndex([meta('b')]), store.saveHistory('a', { history: 'h', frame: null })]);
  const all = [...(await readdir(dir)), ...(await readdir(join(dir, 'threads')))];
  assert.deepEqual(all.filter((f) => f.endsWith('.tmp')), []);
});

test('corrupt index is moved aside, not overwritten', async () => {
  const dir = await freshDir();
  await writeFile(join(dir, 'index.json'), '{not json');
  assert.deepEqual(await quiet(() => new ThreadStore(dir).loadIndex()), []);
  const aside = (await readdir(dir)).filter((f) => f.startsWith('index.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(await readFile(join(dir, aside[0]!), 'utf8'), '{not json');
});

test('corrupt history is moved aside and the other threads still load', async () => {
  const dir = await freshDir();
  const store = new ThreadStore(dir);
  await store.saveIndex([meta('a'), meta('b')]);
  await store.saveHistory('b', { history: 'ok', frame: null });
  await mkdir(join(dir, 'threads'), { recursive: true });
  await writeFile(join(dir, 'threads', 'a.json'), '{"history": 5}');
  assert.equal(await quiet(() => store.loadHistory('a')), null);
  assert.deepEqual(await store.loadHistory('b'), { history: 'ok', frame: null });
  assert.equal((await readdir(join(dir, 'threads'))).filter((f) => f.startsWith('a.json.corrupt-')).length, 1);
});

test('deleteHistory is idempotent', async () => {
  const store = new ThreadStore(await freshDir());
  await store.saveHistory('a', { history: 'h', frame: null });
  await store.deleteHistory('a');
  await store.deleteHistory('a');
  assert.equal(await store.loadHistory('a'), null);
});

test('rejects unsafe ids', async () => {
  const dir = await freshDir();
  const store = new ThreadStore(dir);
  await assert.rejects(store.saveHistory('../x', { history: 'h', frame: null }));
  await writeFile(join(dir, 'index.json'), JSON.stringify({ version: 1, threads: [meta('../x'), meta('ok')] }));
  assert.deepEqual(await quiet(() => store.loadIndex()), [meta('ok')]);
});
