import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import type { Frame, Page } from 'playwright-core';
import { historyFiles, launchVSCode, openThreads, screenText, sleep, typeIn, waitFor } from './vscode.ts';

async function rightClick(page: Page, frame: Frame, item: string): Promise<void> {
  await frame.click('#list li.selected .row', { button: 'right' });
  await page.waitForSelector('.context-view .monaco-menu .action-label', { timeout: 10_000 });
  // Pick by keyboard: on Linux, VS Code's custom menu ignores a synthetic click on the item.
  const labels = await page.$$eval('.context-view .monaco-menu .action-label', (e) => e.map((x) => x.textContent?.trim()));
  const index = labels.indexOf(item);
  if (index < 0) throw new Error(`menu has no "${item}": ${JSON.stringify(labels)}`);
  for (let i = 0; i <= index; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
}

test('Clear History removes earlier output from the screen and the disk at once', async () => {
  const vs = await launchVSCode({ settings: { 'terminalThreads.historyEncryption': 'off' } });
  try {
    const frame = await openThreads(vs.page);
    await typeIn(vs.page, frame, 'echo SECRET-$((40+2))\r');
    await waitFor(() => historyFiles(vs.profile).some((f) => readFileSync(f, 'utf8').includes('SECRET-42')), 15_000, 'secret saved');
    await rightClick(vs.page, frame, 'Clear History');
    await waitFor(async () => !(await screenText(frame)).includes('SECRET-42'), 10_000, 'screen cleared');
    assert.ok(!historyFiles(vs.profile).some((f) => readFileSync(f, 'utf8').includes('SECRET-42')), 'secret still on disk');
  } finally {
    await vs.dispose();
  }
});

test('history is encrypted on disk even when the workspace says off', async () => {
  const vs = await launchVSCode({ workspaceSettings: { 'terminalThreads.historyEncryption': 'off' } });
  try {
    const frame = await openThreads(vs.page);
    await typeIn(vs.page, frame, 'echo ENC-$((1+1))\r');
    await waitFor(() => historyFiles(vs.profile).length > 0, 15_000, 'autosave');
    await sleep(4000);
    const [file] = historyFiles(vs.profile);
    const raw = readFileSync(file!, 'utf8');
    assert.equal(JSON.parse(raw).v, 2);
    assert.ok(!raw.includes('ENC-2'));
    if (process.platform !== 'win32') assert.equal(statSync(file!).mode & 0o777, 0o600);
  } finally {
    await vs.dispose();
  }
});

test("a full-screen program's last screen comes back compacted and labelled", async () => {
  const vs = await launchVSCode();
  try {
    let frame = await openThreads(vs.page);
    await typeIn(vs.page, frame, String.raw`perl -e '$|=1; print qq(\e[?1049h\e[2J\e[14;6HLOGO-ROW\e[20;3HInput box\e[21;3HStatus line\e[40;3HMCP line); sleep 60'` + '\r');
    await waitFor(async () => (await screenText(frame)).includes('MCP line'), 15_000, 'full-screen layout');
    await sleep(4000);
    await vs.restart();
    frame = await openThreads(vs.page);
    await waitFor(async () => (await screenText(frame)).includes('last screen'), 30_000, 'restored picture');
    const text = await screenText(frame);
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.includes('perl, last screen'));
    const end = lines.findIndex((l) => l.includes('session ended'));
    assert.ok(start >= 0 && end > start, text);
    const picture = lines.slice(start + 1, end).map((l) => l.trim());
    assert.deepEqual(picture, ['LOGO-ROW', '', 'Input box', 'Status line', '', 'MCP line']);
  } finally {
    await vs.dispose();
  }
});

test("the view's leftover edges take a full-screen program's background", async () => {
  const vs = await launchVSCode();
  try {
    const frame = await openThreads(vs.page);
    await typeIn(vs.page, frame, String.raw`printf '\033[?1049h\033[48;2;10;20;30m\033[2J'; sleep 30` + '\r');
    const edges = () => frame.evaluate(() => [document.querySelector('#term'), document.querySelector('#term .xterm-scrollable-element')]
      .map((el) => (el ? getComputedStyle(el).backgroundColor : 'missing')));
    await waitFor(async () => (await edges()).every((c) => c === 'rgb(10, 20, 30)'), 10_000, 'edges coloured');
    await vs.page.keyboard.press('Control+C');
    await typeIn(vs.page, frame, String.raw`printf '\033[0m\033[?1049l'` + '\r');
    await waitFor(async () => (await edges()).every((c) => c !== 'rgb(10, 20, 30)'), 10_000, 'edges back to normal');
  } finally {
    await vs.dispose();
  }
});
