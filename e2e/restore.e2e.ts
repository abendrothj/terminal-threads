import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchVSCode, openThreads, screenText, typeIn, waitFor } from './vscode.ts';

test('restart restores history, the separator and exactly one fresh prompt', async () => {
  const vs = await launchVSCode();
  try {
    let frame = await openThreads(vs.page);
    await typeIn(vs.page, frame, 'echo RESTORE-$((6*7))\r');
    await waitFor(async () => (await screenText(frame)).includes('RESTORE-42'), 15_000, 'marker on screen');
    await vs.restart();
    frame = await openThreads(vs.page);
    await waitFor(async () => (await screenText(frame)).includes('session ended'), 30_000, 'restored separator');
    const text = await screenText(frame);
    assert.ok(text.indexOf('RESTORE-42') < text.indexOf('session ended'), text);
    await new Promise((r) => setTimeout(r, 2000));
    const after = (await screenText(frame)).split('── session ended ──').at(-1)!;
    const lines = after.split('\n').map((l) => l.trim()).filter(Boolean);
    assert.equal(new Set(lines).size, lines.length, `a line repeats after the separator:\n${after}`);
  } finally {
    await vs.dispose();
  }
});
