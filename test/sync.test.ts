import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { ViewSync, HIGH_WATER } from '../src/sync.ts';
import type { HostMsg } from '../src/protocol.ts';

// A thread whose snapshots resolve only when the test says so, and a webview that applies
// messages the way media/webview.ts does (reset on snapshot, append data newer than it).
function harness() {
  const chunks: string[] = [];
  const pending: (() => void)[] = [];
  const calls: string[] = [];
  let screen = '';
  let snapSeq = Infinity;
  const sync = new ViewSync({
    post(msg: HostMsg) {
      if (msg.type === 'snapshot') { screen = msg.data; snapSeq = msg.seq; }
      if (msg.type === 'data' && msg.seq > snapSeq) screen += msg.data;
    },
    snapshot() {
      const seq = chunks.length;
      const data = chunks.join('');
      return new Promise((resolve) => pending.push(() => resolve({ seq, data })));
    },
    pause: (id) => calls.push(`pause ${id}`),
    resume: (id) => calls.push(`resume ${id}`),
  });
  const emit = (id: string, data: string) => { chunks.push(data); sync.data(id, chunks.length, data); };
  return { sync, emit, pending, calls, screen: () => screen, all: () => chunks.join('') };
}

test('snapshot then only newer output', async () => {
  const h = harness();
  h.emit('a', 'one ');
  const s = h.sync.select('a');
  h.emit('a', 'two ');
  h.pending.shift()!();
  await s;
  h.emit('a', 'three');
  await sleep(20);
  assert.equal(h.screen(), h.all());
});

test('overlapping selects of the same thread neither drop nor duplicate', async () => {
  const h = harness();
  h.emit('a', 'c1 ');
  const s1 = h.sync.select('a');
  h.emit('a', 'c2 ');
  const s2 = h.sync.select('a');
  h.emit('a', 'c3 ');
  h.pending.shift()!();
  await s1;
  await sleep(20);
  h.pending.shift()!();
  await s2;
  await sleep(20);
  assert.equal(h.screen(), h.all());
});

test('high water pauses and acks resume', async () => {
  const h = harness();
  const s = h.sync.select('a');
  h.pending.shift()!();
  await s;
  h.emit('a', 'x'.repeat(HIGH_WATER + 1));
  await sleep(20);
  assert.deepEqual(h.calls, ['pause a']);
  h.sync.ack('a', HIGH_WATER);
  assert.deepEqual(h.calls, ['pause a', 'resume a']);
});

test('a disposed view never leaves the thread paused', async () => {
  const h = harness();
  const s = h.sync.select('a');
  h.pending.shift()!();
  await s;
  h.emit('a', 'x'.repeat(HIGH_WATER + 1));
  await sleep(20);
  h.sync.detach();
  h.emit('a', 'y'.repeat(HIGH_WATER + 1));
  await sleep(20);
  assert.deepEqual(h.calls, ['pause a', 'resume a']);
});
