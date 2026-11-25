import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Terminal } from '@xterm/headless';
import { captureHistory, createHeadless, restoredPrefix, SEPARATOR } from '../src/history.ts';

const write = (term: Terminal, data: string) => new Promise<void>((resolve) => term.write(data, resolve));

function visibleText(term: Terminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)!.translateToString(true));
  return lines.join('\n');
}

async function restoreInto(prefix: string): Promise<Terminal> {
  const { term } = createHeadless(80, 24);
  await write(term, prefix);
  return term;
}

test('round trip keeps text, colours and wide chars', async () => {
  const { term, serializer } = createHeadless(80, 24);
  await write(term, '\x1b[31mred\x1b[0m 漢字 🙂\r\n');
  const restored = await restoreInto(restoredPrefix(captureHistory(term, serializer)));
  const text = visibleText(restored);
  assert.ok(text.includes('red 漢字 🙂'), text);
  assert.ok(text.includes('── session ended ──'), text);
  const cell = restored.buffer.active.getLine(0)!.getCell(0)!;
  assert.equal(cell.isFgPalette() ? cell.getFgColor() : -1, 1);
});

test('full-screen program saves its last frame, not its live screen', async () => {
  const { term, serializer } = createHeadless(80, 24);
  await write(term, 'before\r\n\x1b[?1049h\x1b[HTUI FRAME');
  const saved = captureHistory(term, serializer);
  assert.deepEqual(saved.frame, ['TUI FRAME']);
  assert.ok(!saved.history.includes('TUI FRAME'));
  const restored = await restoreInto(restoredPrefix(saved));
  assert.equal(restored.buffer.active.type, 'normal');
  const text = visibleText(restored);
  const a = text.indexOf('before');
  const b = text.indexOf('TUI FRAME');
  const c = text.indexOf('── session ended ──');
  assert.ok(a >= 0 && a < b && b < c, text);
});

test('history is capped', async () => {
  const { term, serializer } = createHeadless(80, 24);
  let data = '';
  for (let i = 0; i < 6000; i++) data += `line ${i}\r\n`;
  await write(term, data);
  const text = visibleText(await restoreInto(restoredPrefix(captureHistory(term, serializer))));
  assert.ok(!text.includes('line 0\n'));
  assert.ok(text.includes('line 5999'));
});

test('null restores to only the separator', () => {
  assert.equal(restoredPrefix(null), '\r\n' + SEPARATOR + '\r\n');
});

const frameLines = (text: string) => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.includes('last screen ──'));
  const end = lines.findIndex((l) => l.includes('── session ended ──'));
  return lines.slice(start + 1, end);
};

test('restored frame drops edge blank rows and collapses blank runs', async () => {
  const saved = { history: '', frame: ['', '', 'LOGO', '', '', '', 'INPUT', 'STATUS', '', ''], program: 'opencode' };
  const text = visibleText(await restoreInto(restoredPrefix(saved)));
  assert.deepEqual(frameLines(text).map((l) => l.trim()), ['LOGO', '', 'INPUT', 'STATUS']);
});

test('restored frame is labelled with the program and drawn dim', async () => {
  const term = await restoreInto(restoredPrefix({ history: '', frame: ['LOGO'], program: 'opencode' }));
  const text = visibleText(term);
  assert.ok(text.includes('── opencode, last screen ──'), text);
  const buf = term.buffer.active;
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)!;
    if (line.translateToString(true) === 'LOGO') assert.ok(line.getCell(0)!.isDim(), 'frame text is dim');
  }
});

test('frame without a known program gets a plain label', async () => {
  const text = visibleText(await restoreInto(restoredPrefix({ history: '', frame: ['X'] })));
  assert.ok(text.includes('── last screen ──'), text);
});

test('capture records the program that was full screen', async () => {
  const { term, serializer } = createHeadless(80, 24);
  await write(term, '\x1b[?1049h\x1b[HTUI');
  assert.equal(captureHistory(term, serializer, 'opencode').program, 'opencode');
  const { term: t2, serializer: s2 } = createHeadless(80, 24);
  await write(t2, 'plain');
  assert.equal(captureHistory(t2, s2, 'zsh').program, undefined);
});
