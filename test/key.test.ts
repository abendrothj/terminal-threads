import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyKey, KEY_NAME } from '../src/key.ts';

function fakeSecrets(initial?: string, opts: { failStore?: boolean; dropStore?: boolean; throwGet?: boolean } = {}) {
  const map = new Map<string, string>(initial ? [[KEY_NAME, initial]] : []);
  return {
    map,
    async get(k: string) { if (opts.throwGet) throw new Error('keychain'); return map.get(k); },
    async store(k: string, v: string) { if (opts.failStore) throw new Error('denied'); if (!opts.dropStore) map.set(k, v); },
  };
}

test('existing key is returned as 32 bytes', async () => {
  const k = Buffer.alloc(32, 7).toString('base64');
  assert.deepEqual(await historyKey(fakeSecrets(k)), { key: Buffer.alloc(32, 7), created: false });
});

test('missing key is created and stored', async () => {
  const s = fakeSecrets();
  const r = await historyKey(s);
  assert.equal(r?.created, true);
  assert.equal(r?.key.length, 32);
  assert.equal(s.map.get(KEY_NAME), r?.key.toString('base64'));
});

test('a key that does not read back is not used', async () => {
  assert.equal(await historyKey(fakeSecrets(undefined, { dropStore: true })), null);
});

test('storage errors and wrong-length keys give no key', async () => {
  assert.equal(await historyKey(fakeSecrets(undefined, { failStore: true })), null);
  assert.equal(await historyKey(fakeSecrets(undefined, { throwGet: true })), null);
  assert.equal(await historyKey(fakeSecrets(Buffer.alloc(16).toString('base64'))), null);
});
