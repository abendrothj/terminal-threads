import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadStore, type ThreadMeta } from '../src/store.ts';
import { newKey } from '../src/crypt.ts';

const KEY = newKey();

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
  const store = new ThreadStore(await freshDir(), KEY);
  const threads = [meta('b-2', 'build'), meta('a-1')];
  await store.saveIndex(threads);
  await store.saveHistory('a-1', { history: 'hello', frame: ['x'] });
  assert.deepEqual(await store.loadIndex(), threads);
  assert.deepEqual(await store.loadHistory('a-1'), { history: 'hello', frame: ['x'] });
});

test('missing directory loads empty', async () => {
  const store = new ThreadStore(join(await freshDir(), 'nope'), KEY);
  assert.deepEqual(await store.loadIndex(), []);
  assert.equal(await store.loadHistory('a'), null);
});

test('no temp files remain after saves', async () => {
  const dir = await freshDir();
  const store = new ThreadStore(dir, KEY);
  await Promise.all([store.saveIndex([meta('a')]), store.saveIndex([meta('b')]), store.saveHistory('a', { history: 'h', frame: null })]);
  const all = [...(await readdir(dir)), ...(await readdir(join(dir, 'threads')))];
  assert.deepEqual(all.filter((f) => f.endsWith('.tmp')), []);
});

test('corrupt index is moved aside, not overwritten', async () => {
  const dir = await freshDir();
  await writeFile(join(dir, 'index.json'), '{not json');
  assert.deepEqual(await quiet(() => new ThreadStore(dir, KEY).loadIndex()), []);
  const aside = (await readdir(dir)).filter((f) => f.startsWith('index.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(await readFile(join(dir, aside[0]!), 'utf8'), '{not json');
});

test('corrupt history is moved aside and the other threads still load', async () => {
  const dir = await freshDir();
  const store = new ThreadStore(dir, KEY);
  await store.saveIndex([meta('a'), meta('b')]);
  await store.saveHistory('b', { history: 'ok', frame: null });
  await mkdir(join(dir, 'threads'), { recursive: true });
  await writeFile(join(dir, 'threads', 'a.json'), '{"history": 5}');
  assert.equal(await quiet(() => store.loadHistory('a')), null);
  assert.deepEqual(await store.loadHistory('b'), { history: 'ok', frame: null });
  assert.equal((await readdir(join(dir, 'threads'))).filter((f) => f.startsWith('a.json.corrupt-')).length, 1);
});

test('deleteHistory is idempotent', async () => {
  const store = new ThreadStore(await freshDir(), KEY);
  await store.saveHistory('a', { history: 'h', frame: null });
  await store.deleteHistory('a');
  await store.deleteHistory('a');
  assert.equal(await store.loadHistory('a'), null);
});

test('rejects unsafe ids', async () => {
  const dir = await freshDir();
  const store = new ThreadStore(dir, KEY);
  await assert.rejects(store.saveHistory('../x', { history: 'h', frame: null }));
  await writeFile(join(dir, 'index.json'), JSON.stringify({ version: 1, threads: [meta('../x'), meta('ok')] }));
  assert.deepEqual(await quiet(() => store.loadIndex()), [meta('ok')]);
});

test('files and folders are private', async () => {
  const dir = await freshDir();
  const store = new ThreadStore(join(dir, 's'), KEY);
  await store.saveIndex([meta('a')]);
  await store.saveHistory('a', { history: 'h', frame: null });
  const mode = async (p: string) => (await stat(p)).mode & 0o777;
  assert.equal(await mode(join(dir, 's')), 0o700);
  assert.equal(await mode(join(dir, 's', 'threads')), 0o700);
  assert.equal(await mode(join(dir, 's', 'index.json')), 0o600);
  assert.equal(await mode(join(dir, 's', 'threads', 'a.json')), 0o600);
});

test('secure fixes round-1 permissions', async () => {
  const dir = await freshDir();
  await mkdir(join(dir, 'threads'), { recursive: true, mode: 0o755 });
  await chmod(dir, 0o755);
  await chmod(join(dir, 'threads'), 0o755);
  await writeFile(join(dir, 'index.json'), '{}', { mode: 0o644 });
  await writeFile(join(dir, 'threads', 'a.json'), '{}', { mode: 0o644 });
  await new ThreadStore(dir, KEY).secure();
  const mode = async (p: string) => (await stat(p)).mode & 0o777;
  assert.equal(await mode(dir), 0o700);
  assert.equal(await mode(join(dir, 'threads')), 0o700);
  assert.equal(await mode(join(dir, 'index.json')), 0o600);
  assert.equal(await mode(join(dir, 'threads', 'a.json')), 0o600);
  await new ThreadStore(join(dir, 'missing'), KEY).secure();
});

test('saved history is not plain text on disk', async () => {
  const dir = await freshDir();
  const store = new ThreadStore(dir, KEY);
  await store.saveHistory('a', { history: 'SECRET-123', frame: ['FRAME-456'] });
  const raw = await readFile(join(dir, 'threads', 'a.json'), 'utf8');
  assert.ok(!raw.includes('SECRET-123') && !raw.includes('FRAME-456'));
  assert.equal(JSON.parse(raw).v, 2);
});

test("another key's file is moved aside", async () => {
  const dir = await freshDir();
  await new ThreadStore(dir, newKey()).saveHistory('a', { history: 'h', frame: null });
  assert.equal(await quiet(() => new ThreadStore(dir, KEY).loadHistory('a')), null);
  assert.equal((await readdir(join(dir, 'threads'))).filter((f) => f.startsWith('a.json.corrupt-')).length, 1);
});

test('no key keeps encrypted files untouched', async () => {
  const dir = await freshDir();
  await new ThreadStore(dir, KEY).saveHistory('a', { history: 'h', frame: null });
  const before = await readFile(join(dir, 'threads', 'a.json'));
  assert.equal(await new ThreadStore(dir, null).loadHistory('a'), null);
  assert.deepEqual(await readFile(join(dir, 'threads', 'a.json')), before);
  await assert.rejects(new ThreadStore(dir, null).saveHistory('a', { history: 'h', frame: null }));
});

test('round-1 plain-text history loads and is rewritten encrypted', async () => {
  const dir = await freshDir();
  await mkdir(join(dir, 'threads'), { recursive: true });
  await writeFile(join(dir, 'threads', 'a.json'), JSON.stringify({ history: 'OLD-PLAIN', frame: null }));
  const store = new ThreadStore(dir, KEY);
  const h = await store.loadHistory('a');
  assert.deepEqual(h, { history: 'OLD-PLAIN', frame: null });
  await store.saveHistory('a', h!);
  assert.ok(!(await readFile(join(dir, 'threads', 'a.json'), 'utf8')).includes('OLD-PLAIN'));
  assert.deepEqual(await store.loadHistory('a'), h);
});

test('a new key takes effect for later saves', async () => {
  const dir = await freshDir();
  const store = new ThreadStore(dir, KEY);
  const other = newKey();
  store.setKey(other);
  await store.saveHistory('a', { history: 'h2', frame: null });
  assert.deepEqual(await new ThreadStore(dir, other).loadHistory('a'), { history: 'h2', frame: null });
});

test('hasEncryptedHistory reports only encrypted thread files', async () => {
  const dir = await freshDir();
  const store = new ThreadStore(dir, KEY);
  assert.equal(await store.hasEncryptedHistory(), false);
  await mkdir(join(dir, 'threads'), { recursive: true });
  await writeFile(join(dir, 'threads', 'old.json'), JSON.stringify({ history: 'plain', frame: null }));
  assert.equal(await store.hasEncryptedHistory(), false);
  await store.saveHistory('a', { history: 'h', frame: null });
  assert.equal(await store.hasEncryptedHistory(), true);
});

test('with encryption off, history is readable owner-only JSON, even without a key', async () => {
  const dir = await freshDir();
  const store = new ThreadStore(dir, null, false);
  await store.saveHistory('a', { history: 'PLAIN-OK', frame: null });
  const file = join(dir, 'threads', 'a.json');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { history: 'PLAIN-OK', frame: null });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('switching encryption off and on rewrites files on the next save', async () => {
  const dir = await freshDir();
  const file = join(dir, 'threads', 'a.json');
  const store = new ThreadStore(dir, KEY);
  await store.saveHistory('a', { history: 'SECRET-9', frame: null });
  store.setEncrypt(false);
  const h = await store.loadHistory('a');
  assert.deepEqual(h, { history: 'SECRET-9', frame: null });
  await store.saveHistory('a', h!);
  assert.ok((await readFile(file, 'utf8')).includes('SECRET-9'));
  store.setEncrypt(true);
  await store.saveHistory('a', (await store.loadHistory('a'))!);
  assert.ok(!(await readFile(file, 'utf8')).includes('SECRET-9'));
  assert.deepEqual(await store.loadHistory('a'), h);
});

test('cleanup removes stale temp files and old quarantine, keeps recent quarantine and history', async () => {
  const dir = await freshDir();
  const now = Date.UTC(2026, 10, 25);
  const day = 86_400_000;
  await mkdir(join(dir, 'threads'), { recursive: true });
  const files = {
    keep: ['threads/a.json', 'index.json', `threads/c.json.corrupt-${now - day}`],
    drop: ['threads/a.json.123.4.tmp', 'index.json.9.9.tmp', `threads/b.json.corrupt-${now - 40 * day}`, `index.json.corrupt-${now - 31 * day}`],
  };
  for (const f of [...files.keep, ...files.drop]) await writeFile(join(dir, f), '{}');
  await new ThreadStore(dir, KEY).cleanup(now);
  const left = [...(await readdir(dir)).filter((f) => f !== 'threads'), ...(await readdir(join(dir, 'threads'))).map((f) => `threads/${f}`)].sort();
  assert.deepEqual(left, [...files.keep].sort());
  await new ThreadStore(join(dir, 'missing'), KEY).cleanup(now);
});
