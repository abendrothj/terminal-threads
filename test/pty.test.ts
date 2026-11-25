import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import nodePty from 'node-pty';

const { spawn } = nodePty;

test('spawns a shell and reads output', async () => {
  const pty = spawn('/bin/sh', ['-c', 'printf ok-$((1+1))'], { cols: 80, rows: 24 });
  let out = '';
  pty.onData((d) => { out += d; });
  const code = await new Promise<number>((resolve) => pty.onExit((e) => resolve(e.exitCode)));
  assert.ok(out.includes('ok-2'), `output was ${JSON.stringify(out)}`);
  assert.equal(code, 0);
});

test('reports the foreground program', async () => {
  const pty = spawn('/bin/sh', [], { cols: 80, rows: 24 });
  try {
    await sleep(200);
    // macOS /bin/sh execs bash, so the shell's own name is whatever it reports while idle.
    const shellName = pty.process;
    pty.write('sleep 2\r');
    await sleep(300);
    assert.equal(pty.process, 'sleep');
    await sleep(2200);
    assert.equal(pty.process, shellName);
  } finally {
    pty.kill();
  }
});
