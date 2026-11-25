import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, Page } from 'playwright-core';
import { launchVSCode, openThreads, palette, screenText, sleep, threadMenu, typeIn, viewFrame, waitFor } from './vscode.ts';

const order = (frame: Frame) => frame.$$eval('#list li', (lis) => lis.map((li) => (li as HTMLElement).dataset.id ?? ''));

async function threeThreads(page: Page, frame: Frame): Promise<string[]> {
  await palette(page, 'New Thread');
  await palette(page, 'New Thread');
  await waitFor(async () => (await order(frame)).length === 3, 15_000, 'three threads');
  return order(frame);
}

test('drag a streaming thread to the top: order persists and its scrollback stays intact', async () => {
  const vs = await launchVSCode();
  try {
    let frame = await openThreads(vs.page);
    const [a, b, c] = await threeThreads(vs.page, frame);
    await typeIn(vs.page, frame, 'for i in $(seq 1 400); do echo stream-$i; sleep 0.02; done\r');
    await waitFor(async () => (await screenText(frame)).includes('stream-20'), 15_000, 'streaming');
    await frame.locator(`#list li[data-id="${c}"]`).dragTo(frame.locator(`#list li[data-id="${a}"]`));
    await waitFor(async () => (await order(frame))[0] === c, 10_000, 'moved to top');
    assert.deepEqual(await order(frame), [c, a, b]);
    assert.ok(await frame.$eval(`#list li[data-id="${c}"]`, (li) => li.classList.contains('selected')), 'still selected');
    await waitFor(async () => (await screenText(frame)).includes('stream-400'), 30_000, 'stream finished');
    // The screen-reader rows cover the visible screen: its stream lines must be consecutive and end at 400.
    const nums = [...(await screenText(frame)).matchAll(/stream-(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(nums.length > 10 && nums.at(-1) === 400, JSON.stringify(nums));
    assert.ok(nums.every((n, i) => i === 0 || n === nums[i - 1]! + 1), `gap or repeat: ${JSON.stringify(nums)}`);
    await sleep(4000);
    await vs.restart();
    frame = await openThreads(vs.page);
    await waitFor(async () => (await order(frame)).length === 3, 30_000, 'restored threads');
    assert.deepEqual(await order(frame), [c, a, b]);
  } finally {
    await vs.dispose();
  }
});

test('Move Up from the right-click menu', async () => {
  const vs = await launchVSCode();
  try {
    const frame = await viewFrame(vs.page, 5_000).catch(() => null) ?? (await openThreads(vs.page));
    const [a, b, c] = await threeThreads(vs.page, frame);
    await threadMenu(vs.page, frame, `#list li[data-id="${c}"] .row`, 'Move Up');
    await waitFor(async () => (await order(frame))[1] === c, 10_000, 'moved up');
    assert.deepEqual(await order(frame), [a, c, b]);
  } finally {
    await vs.dispose();
  }
});
