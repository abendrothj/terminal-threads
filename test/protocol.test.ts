import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseViewMsg } from '../src/protocol.ts';

test('accepts well-formed view messages', () => {
  assert.deepEqual(parseViewMsg({ type: 'ready', cols: 80, rows: 24 }), { type: 'ready', cols: 80, rows: 24 });
  assert.deepEqual(parseViewMsg({ type: 'create' }), { type: 'create' });
  assert.deepEqual(parseViewMsg({ type: 'select', id: 'a' }), { type: 'select', id: 'a' });
  assert.deepEqual(parseViewMsg({ type: 'input', id: 'a', data: 'ls\r' }), { type: 'input', id: 'a', data: 'ls\r' });
  assert.deepEqual(parseViewMsg({ type: 'resize', id: 'a', cols: 100, rows: 30 }), { type: 'resize', id: 'a', cols: 100, rows: 30 });
  assert.deepEqual(parseViewMsg({ type: 'ack', id: 'a', chars: 0 }), { type: 'ack', id: 'a', chars: 0 });
  assert.deepEqual(parseViewMsg({ type: 'move', id: 'a', index: 2 }), { type: 'move', id: 'a', index: 2 });
  assert.deepEqual(parseViewMsg({ type: 'focus', focused: true }), { type: 'focus', focused: true });
});

test('drops malformed view messages', () => {
  for (const bad of [
    null, 'x', {}, { type: 'nope' },
    { type: 'select' }, { type: 'select', id: 5 },
    { type: 'input', id: 'a' }, { type: 'input', id: 'a', data: 7 },
    { type: 'ready', cols: 0, rows: 24 }, { type: 'resize', id: 'a', cols: 1.5, rows: 2 },
    { type: 'ack', id: 'a', chars: -1 },
    { type: 'rename', id: 'a' },
    { type: 'focus' }, { type: 'focus', focused: 'yes' },
    { type: 'move', id: 'a' }, { type: 'move', id: 'a', index: -1 }, { type: 'move', id: 'a', index: 1.5 },
  ]) assert.equal(parseViewMsg(bad), null, JSON.stringify(bad));
});

test('keeps only known fields', () => {
  assert.deepEqual(parseViewMsg({ type: 'close', id: 'a', extra: 'x' }), { type: 'close', id: 'a' });
});
