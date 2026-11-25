import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchVSCode, openThreads, palette, screenText, sleep, waitFor } from './vscode.ts';

test('the startup command from user settings runs in new threads; a workspace one is ignored', async () => {
  const vs = await launchVSCode({
    settings: { 'terminalThreads.startupCommand': 'echo USER-$((2+3))' },
    workspaceSettings: { 'terminalThreads.startupCommand': 'echo WORKSPACE-$((4+4))' },
  });
  try {
    const frame = await openThreads(vs.page);
    await waitFor(async () => (await screenText(frame)).includes('USER-5'), 20_000, 'user startup command');
    await palette(vs.page, 'New Thread');
    await waitFor(async () => (await frame.$$('#list li')).length === 2, 15_000, 'second thread');
    await waitFor(async () => (await screenText(frame)).includes('USER-5'), 20_000, 'startup command in the new thread');
    await sleep(1000);
    assert.ok(!(await screenText(frame)).includes('WORKSPACE-8'), 'workspace startup command ran');
  } finally {
    await vs.dispose();
  }
});
