import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { formatTitle, parseLsofCwd, parseOsc7, processName, programName, shellCwd } from '../src/cwd.ts';

test('parseOsc7 decodes local file URLs and rejects others', () => {
  assert.equal(parseOsc7(`file://${hostname()}/home/me/My%20Dir`), '/home/me/My Dir');
  assert.equal(parseOsc7(`file://${hostname().toUpperCase()}/x`), '/x');
  assert.equal(parseOsc7(`file://${hostname().split('.')[0]}/x`), '/x');
  assert.equal(parseOsc7('file:///x'), '/x');
  assert.equal(parseOsc7('file://localhost/x'), '/x');
  assert.equal(parseOsc7('http://x'), null);
});

test('parseOsc7 ignores folders on other hosts (a shell ssh-ed elsewhere)', () => {
  assert.equal(parseOsc7('file://some-remote-box/home/me'), null);
});

test('parseLsofCwd reads the name field', () => {
  assert.equal(parseLsofCwd('p123\nfcwd\nn/private/tmp\n'), '/private/tmp');
});

test('shellCwd finds a live process folder', async () => {
  const cwd = await shellCwd(process.pid);
  assert.equal(cwd && realpathSync(cwd), realpathSync(process.cwd()));
});

test('formatTitle joins folder and program, cutting long parts', () => {
  assert.equal(formatTitle('/home/me/dev/terminal-threads', 'vim'), 'terminal-threads — vim');
  assert.equal(formatTitle(null, 'zsh'), 'zsh');
  const long = 'x'.repeat(40);
  assert.equal(formatTitle(`/tmp/${long}`, 'zsh'), `${'x'.repeat(24)}… — zsh`);
});

test('shellCwd reads /proc on Linux', { skip: process.platform !== 'linux' }, async () => {
  // The build containers have no lsof at all, so this passing means /proc was used.
  const child = spawn('sleep', ['5'], { cwd: '/tmp' });
  try {
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await shellCwd(child.pid!), realpathSync('/tmp'));
  } finally {
    child.kill();
  }
});

test('programName reduces paths to a name and drops empty values', () => {
  assert.equal(programName('/bin/sh'), 'sh');
  assert.equal(programName('sleep'), 'sleep');
  assert.equal(programName('/usr/local/bin/node'), 'node');
  assert.equal(programName(undefined), null);
  assert.equal(programName(''), null);
});

test('processName names a live process the way node-pty does', async () => {
  assert.equal(await processName(process.pid), 'node');
  assert.equal(await processName(2 ** 22 + 12345), null);
});

test('shellCwd on Linux starts no process', { skip: process.platform !== 'linux' }, async () => {
  // 200 /proc reads take a few ms; 200 process spawns would take seconds.
  const start = performance.now();
  for (let i = 0; i < 200; i++) await shellCwd(process.pid);
  assert.ok(performance.now() - start < 100, `${(performance.now() - start).toFixed(1)} ms`);
});
