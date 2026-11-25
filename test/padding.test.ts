import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHeadless } from '../src/history.ts';
import { cellBackground, paletteColor } from '../src/padding.ts';

const ANSI = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
const colors = { ansi: ANSI, background: '#1e1e1e', foreground: '#cccccc' };

async function cellAfter(data: string) {
  const { term } = createHeadless(10, 3);
  await new Promise<void>((r) => term.write(data, r));
  return term.buffer.active.getLine(0)!.getCell(0)!;
}

test('truecolor background', async () => {
  assert.equal(cellBackground(await cellAfter('\x1b[48;2;10;20;30mX'), colors), 'rgb(10, 20, 30)');
});

test('palette backgrounds use the theme for 0-15 and the xterm cube above', async () => {
  assert.equal(cellBackground(await cellAfter('\x1b[44mX'), colors), '#2472c8');
  assert.equal(cellBackground(await cellAfter('\x1b[48;5;16mX'), colors), 'rgb(0, 0, 0)');
  assert.equal(cellBackground(await cellAfter('\x1b[48;5;231mX'), colors), 'rgb(255, 255, 255)');
  assert.equal(cellBackground(await cellAfter('\x1b[48;5;232mX'), colors), 'rgb(8, 8, 8)');
});

test('default background and inverse video', async () => {
  assert.equal(cellBackground(await cellAfter('X'), colors), '#1e1e1e');
  assert.equal(cellBackground(await cellAfter('\x1b[7mX'), colors), '#cccccc');
  assert.equal(cellBackground(await cellAfter('\x1b[7;31mX'), colors), '#cd3131');
});

test('paletteColor covers the 256-colour table', () => {
  assert.equal(paletteColor(196, ANSI), 'rgb(255, 0, 0)');
  assert.equal(paletteColor(255, ANSI), 'rgb(238, 238, 238)');
});
