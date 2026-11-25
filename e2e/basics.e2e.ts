import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inSecondarySidebar, launchVSCode, openThreads, threads, waitFor } from './vscode.ts';

test('view opens in the secondary sidebar with a live thread', async () => {
  const vs = await launchVSCode();
  try {
    const frame = await openThreads(vs.page);
    await waitFor(async () => (await threads(frame))[0]?.title.includes(' — ') ?? false, 30_000, 'live title');
    assert.ok(await inSecondarySidebar(vs.page, frame));
  } finally {
    await vs.dispose();
  }
});
