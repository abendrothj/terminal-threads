import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { formatTitle, parseLsofCwd, parseOsc7, shellCwd } from '../src/cwd.ts';

test('parseOsc7 decodes file URLs and rejects others', () => {
  assert.equal(parseOsc7('file://mac/Users/ja/My%20Dir'), '/Users/ja/My Dir');
  assert.equal(parseOsc7('http://x'), null);
});

test('parseLsofCwd reads the name field', () => {
  assert.equal(parseLsofCwd('p123\nfcwd\nn/private/tmp\n'), '/private/tmp');
});

test('shellCwd finds a live process folder', async () => {
  const cwd = await shellCwd(process.pid);
  assert.equal(cwd && realpathSync(cwd), realpathSync(process.cwd()));
});

test('formatTitle joins folder and program, cutting long parts', () => {
  assert.equal(formatTitle('/Users/ja/dev/terminal-threads', 'vim'), 'terminal-threads — vim');
  assert.equal(formatTitle(null, 'zsh'), 'zsh');
  const long = 'x'.repeat(40);
  assert.equal(formatTitle(`/tmp/${long}`, 'zsh'), `${'x'.repeat(24)}… — zsh`);
});
