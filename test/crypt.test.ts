import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newKey, open, seal } from '../src/crypt.ts';

test('round trip', () => {
  const key = newKey();
  assert.equal(open(key, 'a', seal(key, 'a', 'hello 漢字')), 'hello 漢字');
});

test('fresh IV every time', () => {
  const key = newKey();
  const a = seal(key, 'a', 'same');
  const b = seal(key, 'a', 'same');
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.data, b.data);
});

test('wrong key fails', () => {
  assert.throws(() => open(newKey(), 'a', seal(newKey(), 'a', 'x')));
});

test('tampered data fails', () => {
  const key = newKey();
  const f = seal(key, 'a', 'secret');
  const bytes = Buffer.from(f.data, 'base64');
  bytes[0] ^= 1;
  assert.throws(() => open(key, 'a', { ...f, data: bytes.toString('base64') }));
});

test("a file sealed for one thread doesn't open as another", () => {
  const key = newKey();
  assert.throws(() => open(key, 'b', seal(key, 'a', 'x')));
});
