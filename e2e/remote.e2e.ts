// Opt-in Remote-SSH scenario (not in CI). TT_REMOTE_HOST=<ssh host> TT_REMOTE_VSIX=<linux package>
// [TT_REMOTE_SSH_CONFIG=<ssh config file>] npm run e2e. Installs VS Code's server and the package
// under ~/tt-e2e on the host and removes them afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchVSCode, openThreads, palette, screenText, sleep, threads, typeIn, viewFrame, waitFor } from './vscode.ts';

const host = process.env.TT_REMOTE_HOST;
const vsix = process.env.TT_REMOTE_VSIX;
const sshConfig = process.env.TT_REMOTE_SSH_CONFIG;

test('Remote-SSH: threads run remotely, restore, and the key never leaves this machine', { skip: !host || !vsix }, async () => {
  const ssh = (cmd: string, input?: Buffer) => execFileSync('ssh', ['-a', '-o', 'BatchMode=yes', ...(sshConfig ? ['-F', sshConfig] : []), host!, cmd], { input, encoding: input ? undefined : 'utf8' }) as unknown as string;
  const home = ssh('echo $HOME').trim();
  ssh('rm -rf ~/tt-e2e && mkdir -p ~/tt-e2e/ws/sub');
  const vs = await launchVSCode({
    extensions: ['ms-vscode-remote.remote-ssh'],
    folderUri: `vscode-remote://ssh-remote+${host}${home}/tt-e2e/ws`,
    settings: {
      'remote.SSH.serverInstallPath': { [host!]: `${home}/tt-e2e/server` },
      'remote.SSH.enableAgentForwarding': false,
      ...(sshConfig ? { 'remote.SSH.configFile': sshConfig } : {}),
    },
  });
  try {
    await vs.page.waitForSelector(`.statusbar-item:has-text("SSH: ${host}")`, { timeout: 300_000 });
    await sleep(3000);
    await vs.close();
    ssh(`cat > ~/tt-e2e/tt.vsix`, readFileSync(vsix!));
    ssh('export VSCODE_AGENT_FOLDER=~/tt-e2e/server/.vscode-server; "$(find ~/tt-e2e/server -name code-server -type f | head -1)" --install-extension ~/tt-e2e/tt.vsix >/dev/null');
    await vs.restart();
    await vs.page.waitForSelector(`.statusbar-item:has-text("SSH: ${host}")`, { timeout: 180_000 });
    let frame = await openThreads(vs.page);
    await waitFor(async () => (await threads(frame))[0]?.title.startsWith('ws — ') ?? false, 30_000, 'remote title');
    await typeIn(vs.page, frame, 'cd sub && echo REMOTE-$((6*7)) $(uname -m)\r');
    await waitFor(async () => (await threads(frame))[0]?.title.startsWith('sub — ') ?? false, 15_000, 'title after cd');
    await waitFor(async () => (await screenText(frame)).includes('REMOTE-42'), 15_000, 'remote output');
    await sleep(4000);
    await palette(vs.page, 'Developer: Reload Window');
    await vs.page.waitForSelector(`.statusbar-item:has-text("SSH: ${host}")`, { timeout: 120_000 });
    frame = await viewFrame(vs.page);
    await waitFor(async () => (await screenText(frame)).includes('session ended'), 30_000, 'restored');
    const text = await screenText(frame);
    assert.ok(text.indexOf('REMOTE-42') < text.indexOf('session ended'), text);
    await vs.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(vs.profile, 'user', 'User', 'globalStorage', 'state.vscdb'), { readOnly: true });
    const local = db.prepare("select key from ItemTable where key like 'secret://%terminal-threads%'").all();
    db.close();
    assert.equal(local.length, 1, 'key stored locally');
    const remote = ssh(String.raw`B=~/tt-e2e/server/.vscode-server; f=$(find $B/data -path '*local.terminal-threads/threads/*.json' | head -1); printf '%s %s %s %s' "$(find $B -name '*.vscdb' | wc -l)" "$(stat -c %a "$f")" "$(grep -c REMOTE-42 "$f")" "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("v"))' "$f")"`).trim();
    assert.equal(remote, '0 600 0 2', 'remote: no secret store, history 0600, no plain text, v2');
  } finally {
    await vs.dispose();
    try { ssh('pkill -u "$(id -u)" -f "[t]t-e2e/server" ; sleep 1; rm -rf ~/tt-e2e'); } catch { /* host gone */ }
  }
});
