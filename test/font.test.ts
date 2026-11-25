import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFont } from '../src/font.ts';

const from = (settings: Record<string, unknown>) => resolveFont((key) => settings[key]);

test('view size wins over terminal and editor', () => {
  assert.equal(from({ 'terminalThreads.fontSize': 18, 'terminal.integrated.fontSize': 14, 'editor.fontSize': 12 }).size, 18);
});

test('terminal settings win over editor', () => {
  const f = from({ 'terminal.integrated.fontSize': 14, 'editor.fontSize': 12, 'terminal.integrated.fontFamily': 'Hack Nerd Font Mono', 'editor.fontFamily': 'Menlo', 'terminal.integrated.lineHeight': 1.2 });
  assert.deepEqual(f, { family: 'Hack Nerd Font Mono', size: 14, lineHeight: 1.2 });
});

test('editor settings are the fallback', () => {
  assert.deepEqual(from({ 'editor.fontSize': 12, 'editor.fontFamily': "'JetBrainsMono Nerd Font Mono', Menlo" }), { family: "'JetBrainsMono Nerd Font Mono', Menlo", size: 12, lineHeight: 1 });
});

test('defaults with nothing set', () => {
  assert.deepEqual(from({}), { family: 'monospace', size: 13, lineHeight: 1 });
});

test('non-positive or wrong-typed values are skipped', () => {
  const f = from({ 'terminalThreads.fontSize': 0, 'terminal.integrated.fontSize': '14', 'editor.fontSize': 11, 'terminal.integrated.fontFamily': '', 'terminal.integrated.lineHeight': -1 });
  assert.deepEqual(f, { family: 'monospace', size: 11, lineHeight: 1 });
});
