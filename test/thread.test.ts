import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { Thread, type ThreadOptions } from '../src/thread.ts';

const threads: Thread[] = [];
after(() => threads.forEach((t) => t.dispose()));

function make(extra: Partial<ThreadOptions> = {}): Thread {
  const t = new Thread({ id: 't', cwd: homedir(), shell: '/bin/sh', args: [], env: process.env, cols: 80, rows: 24, prefix: '', ...extra });
  threads.push(t);
  return t;
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(25);
  }
}
const snapText = async (t: Thread) => (await t.snapshot()).data;
const shellName = (t: Thread) => t.title.split(' — ').at(-1)!;

test('output reaches listeners and snapshot', async () => {
  const t = make();
  const seqs: number[] = [];
  let out = '';
  t.onData((seq, data) => { seqs.push(seq); out += data; });
  t.write('echo hi-$((2+3))\r');
  await waitFor(() => out.includes('hi-5'));
  assert.ok((await snapText(t)).includes('hi-5'));
  assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!));
});

test('prefix appears before new output in the snapshot', async () => {
  const t = make({ prefix: 'OLD-HISTORY\r\n' });
  t.write('echo NEW-$((1))\r');
  await waitFor(async () => (await snapText(t)).includes('NEW-1'));
  const text = await snapText(t);
  assert.ok(text.indexOf('OLD-HISTORY') < text.indexOf('NEW-1'));
});

test('title follows cd and program', async () => {
  const t = make();
  const titles: string[] = [];
  t.onTitle((title) => titles.push(title));
  await waitFor(() => t.title.includes(' — '));
  const sh = shellName(t);
  t.write('cd /tmp\r');
  await waitFor(() => t.lastDir === realpathSync('/tmp') && t.title === `tmp — ${sh}`);
  t.write('sleep 1\r');
  await waitFor(() => titles.at(-1) === 'tmp — sleep');
  await waitFor(() => titles.at(-1) === `tmp — ${sh}`);
});

test('no folder lookups while another program runs', async () => {
  let lookups = 0;
  const t = make({ cwdLookup: async () => { lookups++; return tmpdir(); } });
  await waitFor(() => t.title.includes(' — '));
  t.write(`perl -e '$|=1; for (1..15) { print "x\\n"; select(undef,undef,undef,0.2) }'\r`);
  await waitFor(() => t.title.endsWith('— perl'));
  const during = lookups;
  await sleep(2000);
  assert.equal(lookups, during, 'lookups ran while perl was in the foreground');
  await waitFor(() => !t.title.endsWith('— perl'));
  await sleep(1200);
  assert.ok(lookups - during <= 1, `${lookups - during} lookups after the prompt returned`);
});

test('folder lookups are at most once a second', async () => {
  let lookups = 0;
  const t = make({ cwdLookup: async () => { lookups++; return tmpdir(); } });
  await waitFor(() => t.title.includes(' — '));
  await sleep(1200);
  const before = lookups;
  for (let i = 0; i < 10; i++) { t.write('echo a\r'); await sleep(50); }
  await sleep(1500);
  assert.ok(lookups - before <= 2, `${lookups - before} lookups`);
});

test('capture keeps the last frame of a full-screen program', async () => {
  const t = make();
  t.write('printf "\\033[?1049h\\033[HFRAMEX"\r');
  await waitFor(async () => (await t.capture()).frame?.some((row) => row.includes('FRAMEX')) ?? false);
});

test('exit keeps the thread and Enter restarts it', async () => {
  const t = make();
  t.write('echo EARLIER\r');
  await waitFor(async () => (await snapText(t)).includes('EARLIER'));
  t.write('exit\r');
  await waitFor(async () => (await snapText(t)).includes('shell exited, press Enter to restart'));
  t.write('\r');
  await sleep(300);
  t.write('echo back-$((7))\r');
  await waitFor(async () => (await snapText(t)).includes('back-7'));
  const text = await snapText(t);
  assert.ok(text.indexOf('EARLIER') < text.indexOf('shell exited') && text.indexOf('shell exited') < text.indexOf('back-7'));
});

test('huge burst stays bounded', async () => {
  const t = make();
  t.write('seq 1 200000\r');
  await waitFor(async () => (await snapText(t)).includes('\n200000'), 30_000);
  const start = performance.now();
  const saved = await t.capture();
  const ms = performance.now() - start;
  console.log(`huge burst: capture took ${ms.toFixed(1)} ms, ${saved.history.length} chars`);
  assert.ok(ms < 2000);
  assert.ok(saved.history.split('\n').length <= 5000 + 24);
  assert.ok(saved.history.includes('200000'));
});

test('a restarted shell starts in the last directory', async () => {
  const t = make();
  await waitFor(() => t.title.includes(' — '));
  t.write('cd /tmp\r');
  await waitFor(() => t.lastDir === realpathSync('/tmp'));
  t.write('exit\r');
  await waitFor(async () => (await snapText(t)).includes('shell exited'));
  t.write('\r');
  await sleep(300);
  t.write('echo "here=$(pwd -P)"\r');
  await waitFor(async () => (await snapText(t)).includes(`here=${realpathSync('/tmp')}`));
});

test('Ctrl-D ends the shell like exit', async () => {
  const t = make();
  await waitFor(() => t.title.includes(' — '));
  t.write('\x04');
  await waitFor(async () => (await snapText(t)).includes('shell exited, press Enter to restart'));
});

test('clear history drops earlier output and keeps the shell', async () => {
  const t = make();
  t.write('echo SECRET-$((1))\r');
  await waitFor(async () => (await snapText(t)).includes('SECRET-1'));
  assert.equal(t.clearHistory(), true);
  t.write('echo after-$((2))\r');
  await waitFor(async () => (await snapText(t)).includes('after-2'));
  const saved = await t.capture();
  assert.ok(!saved.history.includes('SECRET-1'), saved.history);
  assert.ok(saved.history.includes('after-2'));
});

test('clear history is refused in a full-screen program', async () => {
  const t = make();
  t.write('echo SECRET-$((3)); printf "\\033[?1049h\\033[HFULL"\r');
  await waitFor(() => t.fullScreen);
  const before = await t.capture();
  assert.equal(t.clearHistory(), false);
  assert.deepEqual(await t.capture(), before);
});
