import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame } from 'playwright-core';
import { launchVSCode, openThreads, palette, screenText, sleep, typeIn, waitFor } from './vscode.ts';

const M = process.platform === 'darwin' ? 'Meta' : 'Control';
const selectedId = (frame: Frame) => frame.$eval('#list li.selected', (li) => (li as HTMLElement).dataset.id ?? '');
const ids = (frame: Frame) => frame.$$eval('#list li', (lis) => lis.map((li) => (li as HTMLElement).dataset.id ?? ''));

test('shortcuts switch threads while a program runs, send nothing to it, and only work in the view', async () => {
  const vs = await launchVSCode();
  try {
    const frame = await openThreads(vs.page);
    await palette(vs.page, 'New Thread');
    await palette(vs.page, 'New Thread');
    await waitFor(async () => (await ids(frame)).length === 3, 15_000, 'three threads');
    const [a, b] = await ids(frame);
    await frame.click(`#list li[data-id="${a}"] .row`);
    await waitFor(async () => (await selectedId(frame)) === a, 10_000, 'first selected');
    await typeIn(vs.page, frame, 'cat -v\r');
    await sleep(800);
    await vs.page.keyboard.press(`${M}+Shift+BracketRight`);
    await waitFor(async () => (await selectedId(frame)) === b, 10_000, 'next thread');
    await vs.page.keyboard.press(`${M}+Shift+BracketLeft`);
    await waitFor(async () => (await selectedId(frame)) === a, 10_000, 'previous thread');
    await sleep(800);
    const text = await screenText(frame);
    const afterCat = text.slice(text.lastIndexOf('cat -v') + 'cat -v'.length);
    assert.ok(!/\^\]|\^\[|\^T/.test(afterCat), `stray keys reached the program: ${JSON.stringify(afterCat)}`);
    await palette(vs.page, 'View: Focus on Explorer');
    await sleep(500);
    await vs.page.keyboard.press(`${M}+Shift+BracketRight`);
    await sleep(1000);
    assert.equal(await selectedId(frame), a, 'shortcut fired outside the view');
  } finally {
    await vs.dispose();
  }
});
