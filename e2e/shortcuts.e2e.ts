import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
    await waitFor(async () => (await frame.$eval('#list li.selected .name', (e) => e.textContent ?? '')).endsWith('— cat'), 10_000, 'cat running');
    await vs.page.keyboard.press(`${M}+Shift+BracketRight`);
    await waitFor(async () => (await selectedId(frame)) === b, 10_000, 'next thread');
    await vs.page.keyboard.press(`${M}+Shift+BracketLeft`);
    await waitFor(async () => (await selectedId(frame)) === a, 10_000, 'previous thread');
    await sleep(800);
    const text = await screenText(frame);
    const afterCat = text.slice(text.lastIndexOf('cat -v') + 'cat -v'.length);
    assert.ok(!/\^\]|\^\[|\^T/.test(afterCat), `stray keys reached the program: ${JSON.stringify(afterCat)}`);
    await vs.page.keyboard.press(`${M}+Shift+KeyT`);
    await waitFor(async () => (await ids(frame)).length === 4, 10_000, 'new thread from the shortcut');
    await frame.click(`#list li[data-id="${a}"] .row`);
    await waitFor(async () => (await selectedId(frame)) === a, 10_000, 'first selected again');
    writeFileSync(join(vs.folder, 'notes.txt'), 'hello\n');
    // Through the palette: Ctrl+P inside the terminal goes to the shell on Linux, as in any terminal.
    await palette(vs.page, 'Go to File');
    await vs.page.keyboard.type('notes.txt');
    await waitFor(async () => (await vs.page.$('.quick-input-list .monaco-list-row.focused')) !== null, 10_000, 'quick open');
    await vs.page.keyboard.press('Enter');
    await vs.page.waitForSelector('.monaco-editor.focused', { timeout: 10_000 });
    await vs.page.keyboard.press(`${M}+Shift+BracketRight`);
    await sleep(1000);
    assert.equal(await selectedId(frame), a, 'shortcut fired with the editor focused');
  } finally {
    await vs.dispose();
  }
});

test('after the view is hidden, its shortcuts no longer fire', async () => {
  const vs = await launchVSCode();
  try {
    const frame = await openThreads(vs.page);
    await palette(vs.page, 'New Thread');
    await waitFor(async () => (await ids(frame)).length === 2, 15_000, 'two threads');
    const [a] = await ids(frame);
    await frame.click(`#list li[data-id="${a}"] .row`);
    await waitFor(async () => (await selectedId(frame)) === a, 10_000, 'first selected');
    await palette(vs.page, 'View: Hide Secondary Side Bar');
    await sleep(800);
    await vs.page.keyboard.press(`${M}+Shift+BracketRight`);
    await sleep(1000);
    await palette(vs.page, 'Terminal Threads: Focus on Threads View');
    await sleep(800);
    assert.equal(await selectedId(frame), a, 'a hidden view still took the shortcut');
  } finally {
    await vs.dispose();
  }
});
