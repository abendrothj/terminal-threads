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
    await typeIn(vs.page, frame, 'for i in $(seq 1 150); do echo stream-$i; sleep 0.02; done\r');
    await waitFor(async () => (await screenText(frame)).includes('stream-20'), 15_000, 'streaming');
    await frame.locator(`#list li[data-id="${c}"]`).dragTo(frame.locator(`#list li[data-id="${a}"]`));
    await waitFor(async () => (await order(frame))[0] === c, 10_000, 'moved to top');
    assert.deepEqual(await order(frame), [c, a, b]);
    assert.ok(await frame.$eval(`#list li[data-id="${c}"]`, (li) => li.classList.contains('selected')), 'still selected');
    // A per-line sleep keeps the title flipping (the list churn this test is about); slow runners
    // spawn it slowly, so allow plenty of time and say what was on screen if it never finishes.
    await waitFor(async () => (await screenText(frame)).includes('stream-150'), 90_000, 'stream finished')
      .catch(async (e) => { console.log(`stream state: order=${JSON.stringify(await order(frame))} screen=${JSON.stringify((await screenText(frame)).slice(-300))}`); throw e; });
    // The screen-reader rows cover the visible screen: its stream lines must be consecutive and end at 150.
    const nums = [...(await screenText(frame)).matchAll(/stream-(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(nums.length > 10 && nums.at(-1) === 150, JSON.stringify(nums));
    assert.ok(nums.every((n, i) => i === 0 || n === nums[i - 1]! + 1), `gap or repeat: ${JSON.stringify(nums)}`);
    await vs.restart(); // closing VS Code normally saves every thread on the way out
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
    await threadMenu(vs.page, frame, `#list li[data-id="${c}"] .row`, 'Move Thread Up');
    await waitFor(async () => (await order(frame))[1] === c, 10_000, 'moved up');
    assert.deepEqual(await order(frame), [a, c, b]);
  } finally {
    await vs.dispose();
  }
});

test('keyboard Move Up keeps focus on the moved row, and works from the palette on the selected thread', async () => {
  const vs = await launchVSCode();
  try {
    const frame = await openThreads(vs.page);
    const [a, b, c] = await threeThreads(vs.page, frame);
    await frame.focus(`#list li[data-id="${c}"] .row`);
    await vs.page.keyboard.press('ContextMenu');
    await vs.page.waitForSelector('.context-view .monaco-menu .action-label', { timeout: 10_000 });
    const labels = await vs.page.$$eval('.context-view .monaco-menu .action-item:not(.disabled) .action-label:not(.separator)', (e) => e.map((x) => x.textContent?.trim()));
    for (let i = 0; i <= labels.indexOf('Move Thread Up'); i++) await vs.page.keyboard.press('ArrowDown');
    await vs.page.keyboard.press('Enter');
    await waitFor(async () => (await order(frame))[1] === c, 10_000, 'moved up');
    await sleep(500);
    const focused = await frame.evaluate(() => (document.activeElement?.closest('li') as HTMLElement | null)?.dataset.id ?? null);
    assert.equal(focused, c, 'keyboard focus left the moved row');
    await frame.click(`#list li[data-id="${c}"] .row`);
    await palette(vs.page, 'Terminal Threads: Move Thread Up');
    await waitFor(async () => (await order(frame))[0] === c, 10_000, 'moved up from the palette');
    assert.deepEqual(await order(frame), [c, a, b]);
  } finally {
    await vs.dispose();
  }
});
