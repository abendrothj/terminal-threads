import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { historyFiles, launchVSCode, savedAfter, threadMenu, openThreads, screenText, sleep, typeIn, waitFor, writeUserSettings } from './vscode.ts';

test('Clear History removes earlier output from the screen and the disk at once', async () => {
  const vs = await launchVSCode({ settings: { 'terminalThreads.historyEncryption': 'off' } });
  try {
    const frame = await openThreads(vs.page);
    await typeIn(vs.page, frame, 'echo SECRET-$((40+2))\r');
    await waitFor(() => historyFiles(vs.profile).some((f) => readFileSync(f, 'utf8').includes('SECRET-42')), 15_000, 'secret saved');
    await threadMenu(vs.page, frame, '#list li.selected .row', 'Clear History');
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
    await waitFor(async () => (await screenText(frame)).includes('ENC-2'), 15_000, 'marker on screen');
    const since = Date.now();
    await typeIn(vs.page, frame, 'echo tick\r'); // a save after this output contains the marker too
    await savedAfter(vs.profile, since);
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

test('with saving off nothing touches secret storage', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const secretNames = (profile: string) => {
    const db = new DatabaseSync(join(profile, 'user', 'User', 'globalStorage', 'state.vscdb'), { readOnly: true });
    try {
      return (db.prepare("select key from ItemTable where key like 'secret://%terminal-threads%'").all() as { key: string }[]).map((r) => r.key);
    } finally {
      db.close();
    }
  };
  const vs = await launchVSCode({ settings: { 'terminalThreads.saveHistory': false } });
  try {
    const frame = await openThreads(vs.page);
    await typeIn(vs.page, frame, 'echo OFF-$((2+2))\r');
    await sleep(4500);
    assert.deepEqual(historyFiles(vs.profile), []);
    await vs.close();
    assert.deepEqual(secretNames(vs.profile), []);
  } finally {
    await vs.dispose();
  }
});

test('turning saving on mid-session fetches the key and saves encrypted history', async () => {
  const vs = await launchVSCode({ settings: { 'terminalThreads.saveHistory': false } });
  try {
    const frame = await openThreads(vs.page);
    await typeIn(vs.page, frame, 'echo ON-$((3+3))\r');
    writeUserSettings(vs.profile, { 'terminalThreads.saveHistory': true });
    await waitFor(() => historyFiles(vs.profile).length > 0, 20_000, 'history saved after switching on');
    const raw = readFileSync(historyFiles(vs.profile)[0]!, 'utf8');
    assert.equal(JSON.parse(raw).v, 2);
  } finally {
    await vs.dispose();
  }
});

test('switching saving on without a keyring warns, and retries next time', { skip: process.env.TT_E2E_NO_KEYRING !== '1' }, async () => {
  // Linux without a keyring: VS Code's default store never answers, so no key can be had.
  // (--password-store=gnome-libsecret is different: VS Code falls back to an in-memory store.)
  const prev = process.env.TT_E2E_DEFAULT_STORE;
  process.env.TT_E2E_DEFAULT_STORE = '1';
  const vs = await launchVSCode({ settings: { 'terminalThreads.saveHistory': false } });
  try {
    await openThreads(vs.page);
    const warned = () => vs.page.$$eval('.notification-list-item-message', (e) => e.filter((x) => x.textContent?.includes('secret storage')).length);
    writeUserSettings(vs.profile, { 'terminalThreads.saveHistory': true });
    await waitFor(async () => (await warned()) >= 1, 30_000, 'warning after switching saving on').catch(async (e) => {
      const all = await vs.page.$$eval('.notification-list-item-message', (m) => m.map((x) => x.textContent));
      throw new Error(`${(e as Error).message}; notifications: ${JSON.stringify(all)}; history files: ${historyFiles(vs.profile).length}`);
    });
    await vs.page.$$eval('.notification-toast .codicon-notifications-clear, .notification-list-item .codicon-notifications-clear', (b) => b.forEach((x) => (x as HTMLElement).click()));
    writeUserSettings(vs.profile, { 'terminalThreads.saveHistory': false });
    await sleep(1000);
    writeUserSettings(vs.profile, { 'terminalThreads.saveHistory': true });
    await waitFor(async () => (await warned()) >= 1, 30_000, 'warning again on the retry');
  } finally {
    if (prev === undefined) delete process.env.TT_E2E_DEFAULT_STORE;
    else process.env.TT_E2E_DEFAULT_STORE = prev;
    await vs.dispose();
  }
});
