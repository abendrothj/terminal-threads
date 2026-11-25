import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { basename } from 'node:path';
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
    // macOS /bin/sh execs bash and Linux reports argv[0] (often a path), so compare basenames
    // against whatever the idle shell reports.
    const name = () => basename(pty.process);
    const shellName = name();
    pty.write(`perl -e 'sleep 2'\r`);
    await sleep(400);
    assert.equal(name(), 'perl');
    await sleep(2200);
    assert.equal(name(), shellName);
  } finally {
    pty.kill();
  }
});
